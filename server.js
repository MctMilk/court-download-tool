const express = require('express');
const path = require('path');
const JSZip = require('jszip');
const { getDb, get, run, all } = require('./db');
const { authenticate, optionalAuth, requirePaid } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const paymentRoutes = require('./routes/payment');
const smsRoutes = require('./routes/sms');
const historyRoutes = require('./routes/history');
const adminRoutes = require('./routes/admin');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200mb' }));

// 跨域
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// serve index.html for /wenshu and /wenshu/
app.get('/wenshu', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/wenshu/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/wenshu/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/wenshu/admin/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/wenshu/admin.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 挂载路由（支持 /api 和 /wenshu/api 两种路径）
app.use('/api/auth', authRoutes);
app.use('/wenshu/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/wenshu/api/user', userRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/wenshu/api/payment', paymentRoutes);
app.use('/api/sms', smsRoutes);
app.use('/wenshu/api/sms', smsRoutes);
app.use('/api/history', historyRoutes);
app.use('/wenshu/api/history', historyRoutes);

// 管理员接口（支持 /api/admin 和 /wenshu/api/admin）
app.use('/api/admin', adminRoutes);
app.use('/wenshu/api/admin', adminRoutes);

// 法院文书API地址
const COURT_API = 'https://zxfw.court.gov.cn/yzw/yzw-zxfw-sdfw/api/v1/sdfw/getWsListBySdbhNew';

// 从 URL hash 参数中提取 sdbh, qdbh, sdsin
function parseHashParams(url) {
  try {
    const hashIdx = url.indexOf('#');
    if (hashIdx === -1) throw new Error('URL 中没有 hash 参数');
    const hash = url.substring(hashIdx + 1);
    const queryPart = hash.includes('?') ? hash.split('?')[1] : '';
    const params = new URLSearchParams(queryPart);
    return {
      sdbh: params.get('sdbh'),
      qdbh: params.get('qdbh'),
      sdsin: params.get('sdsin'),
    };
  } catch (e) {
    return null;
  }
}

// 解析文件名从 OSS URL
function parseFilename(wjlj) {
  try {
    const url = new URL(wjlj);
    const parts = decodeURIComponent(url.pathname).split('/');
    return parts[parts.length - 1] || '未命名.pdf';
  } catch {
    return wjlj.split('/').pop().split('?')[0] || '未命名.pdf';
  }
}

// 从 OSS URL 中提取签名过期时间
function parseOssExpiry(wjlj) {
  try {
    const url = new URL(wjlj);
    const ts = url.searchParams.get('Expires');
    if (!ts) return null;
    const date = new Date(parseInt(ts) * 1000);
    return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  } catch {
    return null;
  }
}

// 记录使用日志
async function logUsage(userId, ip, action, fileCount = 0) {
  try {
    await run('INSERT INTO usage_log (user_id, ip, action, file_count) VALUES (?, ?, ?, ?)',
      [userId || null, ip, action, fileCount]);
  } catch {}
}

// 解析法院短信（支持 /api/scrape 和 /wenshu/api/scrape）
for (const path of ['/api/scrape', '/wenshu/api/scrape']) {
  app.post(path, optionalAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 URL' });

  const params = parseHashParams(url);
  if (!params || !params.sdbh) {
    return res.status(400).json({ error: '无法从 URL 中提取 sdbh/qdbh/sdsin 参数，请确认是法院送达短信链接' });
  }

  logUsage(req.user?.userId || null, req.ip, 'scrape');

  fetch(COURT_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://zxfw.court.gov.cn/zxfw/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      sdbh: params.sdbh,
      qdbh: params.qdbh,
      sdsin: params.sdsin,
    }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.code === 401 || !data.data || data.data.length === 0) {
        return res.json({ expired: true, files: [], total: 0 });
      }
      const files = data.data.map(item => ({
        name: parseFilename(item.wjlj),
        href: item.wjlj,
        ext: (item.c_wjgs || 'pdf').toLowerCase(),
        size: '未知',
        court: item.c_fymc || '',
        docName: item.c_wsmc || '',
        createTime: item.dt_cjsj || '',
      }));
      const expiresAt = parseOssExpiry(data.data[0].wjlj);

      // 保存历史记录（登录用户）
      if (req.user?.userId) {
        try {
          const caseNumMatch = (req.body.url || '').match(/\([0-9]+\)[^\s(]{2,10}[\u4e00-\u9fa5]{1,10}[\u4e00-\u9fa5民初民终号\d]+/);
          const case_number = caseNumMatch ? caseNumMatch[0] : '';
          const primaryCourt = files[0]?.court || '';
          run('INSERT INTO sms_history (user_id, content, params, court, case_number, doc_count) VALUES (?,?,?,?,?,?)', [req.user.userId,
            req.body.url || '',
            JSON.stringify({ sdbh: params.sdbh, qdbh: params.qdbh, sdsin: params.sdsin }),
            primaryCourt,
            case_number,
            files.length,
          ]);
        } catch (e) { /* 历史记录保存失败不影响主流程 */ }
      }

      res.json({ files, total: files.length, expiresAt });
    })
    .catch(err => res.status(500).json({ error: err.message }));
  });
}

// 下载文件（免费，单个下载，支持 /api/download 和 /wenshu/api/download）
for (const path of ['/api/download', '/wenshu/api/download']) {
  app.get(path, optionalAuth, async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: '缺少 url' });

  // Fix 5: URL 白名单 — 仅允许阿里云 OSS-CN 域名
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.oss-cn-aliyuncs.com')) {
      return res.status(403).json({ error: '不允许从该域名下载' });
    }
  } catch {
    return res.status(400).json({ error: '无效的 URL' });
  }

  logUsage(req.user?.userId || null, req.ip, 'single_download');

  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then(buffer => {
      res.json({
        buffer: Buffer.from(buffer).toString('base64'),
        filename: filename || url.split('/').pop().split('?')[0] || 'download',
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
  });
}

// 打包下载（需付费，支持 /api/batch-download 和 /wenshu/api/batch-download）
for (const path of ['/api/batch-download', '/wenshu/api/batch-download']) {
  app.post(path, authenticate, requirePaid, async (req, res) => {
  const { files } = req.body;
  if (!files || !files.length) return res.status(400).json({ error: '缺少文件列表' });

  // Fix 5: URL 白名单 — 仅允许阿里云 OSS-CN 域名
  for (const file of files) {
    if (!file.url) continue;
    try {
      const parsed = new URL(file.url);
      if (!parsed.hostname.endsWith('.oss-cn-aliyuncs.com')) {
        return res.status(403).json({ error: `不允许从该域名下载: ${parsed.hostname}` });
      }
    } catch {
      return res.status(400).json({ error: '包含无效的 URL' });
    }
  }

  logUsage(req.user.userId, req.ip, 'batch_download', files.length);

  const zip = new JSZip();
  const errors = [];

  Promise.all(
    files.map(file =>
      fetch(file.url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then(buffer => zip.file(file.name || file.url.split('/').pop().split('?')[0], buffer))
        .catch(e => errors.push({ file: file.name, error: e.message }))
    )
  )
    .then(() => zip.generateAsync({ type: 'nodebuffer' }))
    .then(zipBuffer => {
      res.json({
        zip: Buffer.from(zipBuffer).toString('base64'),
        errors,
        downloaded: files.length - errors.length,
        failed: errors.length,
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
  });
}

const PORT = process.env.PORT || 3000;

// ─── 启动时初始化数据库（必须在 listen 之前完成）──────────────
async function runMigrations() {
  const { getAsync, runAsync } = require('./db');
  try {
    // v3.2: 回填 subscription_started_at（取最早一笔已支付订单时间）
    await runAsync(`
      UPDATE users SET subscription_started_at = (
        SELECT MIN(paid_at) FROM payment_records
        WHERE payment_records.user_id = users.id
          AND payment_records.status = 'paid'
          AND payment_records.paid_at IS NOT NULL
      )
      WHERE subscription_started_at IS NULL
        AND id IN (SELECT DISTINCT user_id FROM payment_records WHERE status = 'paid' AND paid_at IS NOT NULL)
    `);
    // 冻结旧 balance（仅作展示用）
    await runAsync("UPDATE users SET balance_computed_at = datetime('now', '+8 hours') WHERE balance_computed_at IS NULL");
    // 标记旧表为废弃
    await runAsync("UPDATE consumption_log SET deprecated = 1 WHERE deprecated = 0 OR deprecated IS NULL");
    await runAsync("UPDATE paid_periods  SET deprecated = 1 WHERE deprecated = 0 OR deprecated IS NULL");
    console.log('v3.2 迁移完成');
  } catch (err) {
    console.error('v3.2 迁移失败:', err.message, err.stack);
  }
}

async function start() {
  try {
    await getDb();
    console.log('数据库初始化完成');
    await runMigrations();
  } catch (err) {
    console.error('数据库初始化失败:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`法院文书下载工具已启动: http://localhost:${PORT}`);
  });
}
start();
