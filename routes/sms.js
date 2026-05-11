const express = require('express');
const crypto = require('crypto');
const { get, run } = require('../db');

const router = express.Router();

// ─── 飞鸽短信配置 ─────────────────────────────────────────────
const FEIGE_APP_KEY = process.env.FEIGE_APP_KEY || 'N746855101';
const FEIGE_APP_SECRET = process.env.FEIGE_APP_SECRET || '746855212622b138';
const FEIGE_SIGN_ID = parseInt(process.env.FEIGE_SIGN_ID || '20178');
const FEIGE_TEMPLATE_ID = parseInt(process.env.FEIGE_TEMPLATE_ID || '2036262');
const FEIGE_API_URL = 'https://api.feige.cn/sendsms/template/send';

function feigeSign(timestamp, nonce) {
  const str = FEIGE_APP_KEY + FEIGE_APP_SECRET + timestamp + nonce;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── 数学验证码（防机器） ─────────────────────────────────────────
const { newCaptcha, verifyCaptcha } = require('../utils/captcha');

// 记录 IP + 设备指纹组合（用于检测同 IP 多设备）
const ipFingerprintLog = [];
const IPFP_WINDOW_MS = 60 * 60 * 1000; // 1小时内

function needCaptcha(ip, deviceFingerprint) {
  // 清理过期记录
  const now = Date.now();
  const before = now - IPFP_WINDOW_MS;
  while (ipFingerprintLog.length && ipFingerprintLog[0].ts < before) ipFingerprintLog.shift();

  // 当前 IP 在窗口内的不同指纹数量
  const fps = new Set(
    ipFingerprintLog
      .filter(e => e.ip === ip && e.ts >= before)
      .map(e => e.fp)
  );
  if (deviceFingerprint) fps.add(deviceFingerprint);

  // 同一 IP 出现 2+ 不同设备指纹 → 强制验证码
  return fps.size >= 2;
}

function logIpFingerprint(ip, fp) {
  ipFingerprintLog.push({ ip, fp, ts: Date.now() });
}

// GET /captcha — 获取图形验证码
router.get('/captcha', async (req, res) => {
  const { id, image } = newCaptcha();
  res.json({ captchaId: id, image });
});

// ─── 频率限制 ───────────────────────────────────────────────────

// 手机号：每60秒1条，每小时5条，每天10条（终身会员加倍）
function checkPhoneRateLimit(phone, purpose, isLifetime = false) {
  const windows = [
    { label: '每60秒',  limit: 1,  hours: 1 / 60 },
    { label: '每小时内', limit: isLifetime ? 10 : 5,  hours: 1 },
    { label: '每天内',  limit: isLifetime ? 20 : 10, hours: 24 },
  ];
  for (const w of windows) {
    const secs = Math.round(w.hours * 3600);
    const count = get(
      `SELECT COUNT(*) as c FROM sms_codes WHERE phone=? AND purpose=? AND created_at > datetime('now','-${secs} seconds')`,
      [phone, purpose]
    )?.c || 0;
    if (count >= w.limit) {
      return { allowed: false, message: `获取验证码过于频繁，请在${w.label}后再试。` };
    }
  }
  return { allowed: true };
}

// IP：每小时最多20条，每天最多50条
function checkIpRateLimit(ip) {
  const windows = [
    { label: '每小时', limit: 20, hours: 1 },
    { label: '每天',   limit: 50, hours: 24 },
  ];
  for (const w of windows) {
    const secs = Math.round(w.hours * 3600);
    const count = get(
      `SELECT COUNT(*) as c FROM sms_log WHERE ip=? AND created_at > datetime('now','-${secs} seconds')`,
      [ip]
    )?.c || 0;
    if (count >= w.limit) {
      return { allowed: false, message: `当前IP获取验证码过于频繁，请在${w.label}后再试。` };
    }
  }
  return { allowed: true };
}

function logSms(phone, ip, code) {
  try {
    run(
      `INSERT INTO sms_log (phone, ip, code, sent_at, expires_at) VALUES (?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours','+5 minutes'))`,
      [phone, ip || '', code]
    );
  } catch {}
}

// ─── POST /send-code ─────────────────────────────────────────────
router.post('/send-code', async (req, res) => {
  const { phone, purpose, captchaId, captchaAnswer, deviceFingerprint } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: '手机号不能为空' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, error: '手机号格式不正确' });
  if (!['register', 'resetpwd', 'login'].includes(purpose)) {
    return res.status(400).json({ success: false, error: '无效的用途' });
  }

  // IP + 设备指纹分析：同 IP 多设备指纹 → 注册/找回密码强制图形验证码（登录不受此限制）
  const ip = req.ip || req.headers['x-forwarded-for'] || '';
  const cleanIp = Array.isArray(ip) ? ip[0] : ip.split(',')[0].trim();

  if (['register', 'resetpwd'].includes(purpose) && needCaptcha(cleanIp, deviceFingerprint)) {
    if (!captchaId || !captchaAnswer) {
      return res.status(400).json({ success: false, error: '检测到异常访问，请先完成安全验证', needCaptcha: true });
    }
    const capResult = verifyCaptcha(captchaId, captchaAnswer);
    if (!capResult.valid) {
      return res.status(400).json({ success: false, error: capResult.reason, needCaptcha: true });
    }
  }

  // 终身会员标记
  let isLifetime = false;
  if (purpose === 'login') {
    const user = get('SELECT lifetime FROM users WHERE phone=?', [phone]);
    isLifetime = user?.lifetime === 1;
  }

  // 手机号频率限制
  const phoneCheck = checkPhoneRateLimit(phone, purpose, isLifetime);
  if (!phoneCheck.allowed) return res.status(429).json({ success: false, error: phoneCheck.message });

  // IP频率限制
  const ipCheck = checkIpRateLimit(cleanIp);
  if (!ipCheck.allowed) return res.status(429).json({ success: false, error: ipCheck.message });

  const code = genCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await run('INSERT INTO sms_codes (phone, code, purpose, expires_at) VALUES (?,?,?,?)',
    [phone, code, purpose, expiresAt]);
  logSms(phone, cleanIp, code);
  // 记录指纹，用于后续检测同IP多设备刷验证码
  if (deviceFingerprint) logIpFingerprint(cleanIp, deviceFingerprint);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign = feigeSign(timestamp, nonce);

  try {
    const response = await fetch(FEIGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': FEIGE_APP_KEY,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': sign,
      },
      body: JSON.stringify({
        template_id: FEIGE_TEMPLATE_ID,
        sms_sign_id: FEIGE_SIGN_ID,
        messages: [{ phone_number: phone, params: { 1: code } }],
      }),
    });
    const data = await response.json();
    if (data.code === 0 || data.code === '0') {
      res.json({ success: true, expiresIn: 60 });
    } else {
      res.status(500).json({ success: false, error: '短信发送失败：' + (data.msg || data.message || '未知错误') });
    }
  } catch {
    res.status(500).json({ success: false, error: '短信发送失败，请稍后重试' });
  }
});

// ─── 调试接口：预先灌入多个设备指纹，用于测试 captcha 触发 ──────────
router.post('/debug/seed-fingerprints', (req, res) => {
  // 仅开发/测试用，勿在生产暴露
  const { count = 2 } = req.body;
  const testIps = ['test.ip.1', 'test.ip.2', 'test.ip.3'];
  for (let i = 0; i < count; i++) {
    ipFingerprintLog.push({ ip: testIps[i % testIps.length], fp: 'debug_fp_' + i, ts: Date.now() - (count - i) * 1000 });
  }
  res.json({ ok: true, seeded: count, message: `已灌入 ${count} 个假指纹，下一次 register/resetpwd 请求将触发图形验证码` });
});

// ─── POST /verify-code（备用） ──────────────────────────────────
router.post('/verify-code', async (req, res) => {
  const { phone, code, purpose } = req.body;
  if (!phone || !code) return res.status(400).json({ error: '手机号和验证码不能为空' });
  const record = get(
    "SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose=? AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1",
    [phone, code, purpose]
  );
  if (!record) return res.status(400).json({ error: '验证码错误或已过期' });
  await run('UPDATE sms_codes SET used=1 WHERE id=?', [record.id]);
  res.json({ success: true });
});

module.exports = router;
