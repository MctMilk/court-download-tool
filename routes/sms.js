const express = require('express');
const crypto = require('crypto');
const { get, run } = require('../db');

const router = express.Router();

// 飞鸽短信配置
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

// 手机号频率限制：每60秒1条，每小时5条，每天10条（终身会员加倍）
function checkPhoneRateLimit(phone, purpose, isLifetime = false) {
  const windows = [
    { label: '每60秒',  limit: 1,  seconds: 60 },
    { label: '每小时内', limit: isLifetime ? 10 : 5,  hours: 1 },
    { label: '每天内',  limit: isLifetime ? 20 : 10, hours: 24 },
  ];
  for (const w of windows) {
    const secs = w.hours * 3600;
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

// IP频率限制：每小时最多20条，每天最多50条
function checkIpRateLimit(ip) {
  const windows = [
    { label: '每小时', limit: 20, hours: 1 },
    { label: '每天',   limit: 50, hours: 24 },
  ];
  for (const w of windows) {
    const secs = w.hours * 3600;
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

// 记录到 sms_log（审计日志）
function logSms(phone, ip, code) {
  try {
    run(
      `INSERT INTO sms_log (phone, ip, code, sent_at, expires_at) VALUES (?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours','+5 minutes'))`,
      [phone, ip || '', code]
    );
  } catch {}
}

// 发送短信验证码
router.post('/send-code', async (req, res) => {
  const { phone, purpose } = req.body;
  if (!phone) return res.status(400).json({ error: '手机号不能为空' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!['register', 'resetpwd', 'login'].includes(purpose)) {
    return res.status(400).json({ error: '无效的用途' });
  }

  // 频率限制
  let isLifetime = false;
  if (purpose === 'login') {
    const user = get('SELECT lifetime FROM users WHERE phone=?', [phone]);
    isLifetime = user?.lifetime === 1;
  }

  // 手机号频率限制
  const phoneCheck = checkPhoneRateLimit(phone, purpose, isLifetime);
  if (!phoneCheck.allowed) return res.status(429).json({ success: false, error: phoneCheck.message });

  // IP频率限制
  const ip = req.ip || req.headers['x-forwarded-for'] || '';
  const cleanIp = Array.isArray(ip) ? ip[0] : ip.split(',')[0].trim();
  const ipCheck = checkIpRateLimit(cleanIp);
  if (!ipCheck.allowed) return res.status(429).json({ success: false, error: ipCheck.message });

  const code = genCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await run('INSERT INTO sms_codes (phone, code, purpose, expires_at) VALUES (?,?,?,?)',
    [phone, code, purpose, expiresAt]);

  // 记录到审计日志
  logSms(phone, cleanIp, code);

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

// 验证短信验证码（已由 auth.js 内部调用，此接口保留备用）
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
