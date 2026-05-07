const express = require('express');
const path = require('path');
const JSZip = require('jszip');

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 跨域
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 法院文书API地址
const COURT_API = 'https://zxfw.court.gov.cn/yzw/yzw-zxfw-sdfw/api/v1/sdfw/getWsListBySdbhNew';

// 从 URL hash 参数中提取 sdbh, qdbh, sdsin
function parseHashParams(url) {
  try {
    const hashIdx = url.indexOf('#');
    if (hashIdx === -1) throw new Error('URL 中没有 hash 参数');
    const hash = url.substring(hashIdx + 1); // #/pagesAjkj/...?qdbh=...
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

// 从 OSS URL 中提取签名过期时间（Unix 时间戳 → 格式化的本地时间）
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

// 解析法院短信
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 URL' });

  const params = parseHashParams(url);
  if (!params || !params.sdbh) {
    return res.status(400).json({ error: '无法从 URL 中提取 sdbh/qdbh/sdsin 参数，请确认是法院送达短信链接' });
  }

  try {
    const apiResp = await fetch(COURT_API, {
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
    });

    const data = await apiResp.json();

    // 送达链接已过期
    if (data.code === 401) {
      return res.json({ expired: true, files: [], total: 0 });
    }

    if (!data.data || data.data.length === 0) {
      return res.json({ expired: true, files: [], total: 0 });
    }

    // 格式化返回
    const files = data.data.map(item => ({
      name: parseFilename(item.wjlj),
      href: item.wjlj,
      ext: (item.c_wjgs || 'pdf').toLowerCase(),
      size: '未知',
      court: item.c_fymc || '',
      docName: item.c_wsmc || '',
      createTime: item.dt_cjsj || '',
    }));

    // 取第一个文件的 OSS 过期时间作为参考
    const expiresAt = parseOssExpiry(data.data[0].wjlj);

    res.json({ files, total: files.length, expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 下载文件并返回二进制数据（用于打包）
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: '缺少 url' });

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    res.json({
      buffer: bufferToBase64(buffer),
      filename: filename || url.split('/').pop().split('?')[0] || 'download',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 打包下载多个文件
app.post('/api/batch-download', async (req, res) => {
  const { files } = req.body; // [{ url, name }]
  if (!files || !files.length) return res.status(400).json({ error: '缺少文件列表' });

  try {
    const zip = new JSZip();
    const errors = [];

    for (const file of files) {
      try {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        zip.file(file.name || file.url.split('/').pop().split('?')[0], buffer);
      } catch (e) {
        errors.push({ file: file.name, error: e.message });
      }
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.json({
      zip: bufferToBase64(zipBuffer),
      errors,
      downloaded: files.length - errors.length,
      failed: errors.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

const PORT = 3847;
app.listen(PORT, () => {
  console.log(`法院文书下载工具已启动: http://localhost:${PORT}`);
});
