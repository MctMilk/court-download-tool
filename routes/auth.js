const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');
const { generateToken, isPaidUser } = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────────
function respondSuccess(user, res) {
  const userIsPaid = isPaidUser(user);
  const token = generateToken({
    userId: user.id, username: user.username, phone: user.phone,
    isPaid: userIsPaid ? 1 : 0,
  });
  res.json({
    token,
    user: {
      id: user.id, username: user.username, phone: user.phone,
      isPaid: userIsPaid, paidExpiresAt: user.paid_expires_at,
      lifetime: user.lifetime || 0, balance: user.balance || 0,
      mustChangePwd: user.must_change_password === 1,
    },
  });
}

// ─── 邀请奖励核心逻辑 ─────────────────────────────────────────────
function checkAndGrantInviteReward(userId) {
  const user = get('SELECT * FROM users WHERE id=?', [userId]);
  if (!user) return;
  if (user.lifetime === 1) return; // 终身会员不处理

  const total = get('SELECT COUNT(*) as c FROM invite_relations WHERE inviter_id=?', [userId])?.c || 0;

  const paid = get(`
    SELECT COUNT(*) as c FROM invite_relations ir
    JOIN users u ON ir.invitee_id = u.id
    WHERE ir.inviter_id=? AND (u.lifetime=1 OR (u.is_paid=1 AND u.paid_expires_at>datetime('now')))
  `, [userId])?.c || 0;

  // 已获最高奖励
  const existingReward = get("SELECT reward_type FROM invite_rewards WHERE user_id=? ORDER BY id DESC LIMIT 1", [userId]);

  const rewardLevels = [
    { type: 'monthly',  threshold_total: 10, threshold_paid: 5,  level: 1 },
    { type: 'yearly',   threshold_total: 999999, threshold_paid: 30, level: 2 },
    { type: 'lifetime', threshold_total: 999999, threshold_paid: 100, level: 3 },
  ];

  const existingLevel = existingReward ? (rewardLevels.find(r => r.type === existingReward.reward_type)?.level || 0) : 0;

  for (const info of rewardLevels) {
    if (info.level <= existingLevel) continue;
    if (total < info.threshold_total && paid < info.threshold_paid) continue;

    const hasSame = get("SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?", [userId, info.type]);
    if (hasSame) continue;

    applyInviteReward(user, info.type);
    return;
  }
}

function applyInviteReward(user, type) {
  const now = new Date();
  if (type === 'lifetime') {
    run("UPDATE users SET lifetime=1, is_paid=1, paid_expires_at='9999-12-31 23:59:59' WHERE id=?", [user.id]);
    run("INSERT INTO invite_rewards (user_id, reward_type, reward_desc) VALUES (?,?,?)", [user.id, 'lifetime', '邀请奖励：终身会员']);
  } else if (type === 'yearly') {
    let expires = user.paid_expires_at ? new Date(user.paid_expires_at) : now;
    if (expires <= now) expires = now;
    expires.setFullYear(expires.getFullYear() + 1);
    const newExpires = expires.toISOString().replace('T', ' ').slice(0, 19);
    run("UPDATE users SET lifetime=0, is_paid=1, paid_expires_at=? WHERE id=?", [newExpires, user.id]);
    run("INSERT INTO invite_rewards (user_id, reward_type, reward_desc) VALUES (?,?,?)", [user.id, 'yearly', '邀请奖励：1年订阅会员']);
  } else if (type === 'monthly') {
    let expires = user.paid_expires_at ? new Date(user.paid_expires_at) : now;
    if (expires <= now) expires = now;
    expires.setDate(expires.getDate() + 7);
    const newExpires = expires.toISOString().replace('T', ' ').slice(0, 19);
    run("UPDATE users SET lifetime=0, is_paid=1, paid_expires_at=? WHERE id=?", [newExpires, user.id]);
    run("INSERT INTO invite_rewards (user_id, reward_type, reward_desc) VALUES (?,?,?)", [user.id, 'monthly', '邀请奖励：7天订阅会员']);
  }
}

function checkAbuseAndRecord(user, device_fp, ip) {
  const isLifetime = user.lifetime === 1;
  const limit24h = isLifetime ? 30 : 15;
  const limit7d = isLifetime ? 100 : 50;

  const recent24h = get("SELECT COUNT(DISTINCT device_fp) as c FROM login_attempts WHERE user_id=? AND success=1 AND created_at>datetime('now','-24 hours')", [user.id])?.c || 0;
  const recent7d = get("SELECT COUNT(DISTINCT device_fp) as c FROM login_attempts WHERE user_id=? AND success=1 AND created_at>datetime('now','-7 days')", [user.id])?.c || 0;

  // 记录本次登录
  run('INSERT INTO login_attempts (user_id, device_fp, ip, success) VALUES (?,?,?,1)', [user.id, device_fp || null, ip]);

  // 封禁检查（已有记录后再判断，避免误封新账号）
  if (recent24h >= limit24h || recent7d >= limit7d) {
    run('UPDATE users SET is_active=0 WHERE id=?', [user.id]);
    return { banned: true };
  }
  return { banned: false };
}

// ─── 注册 ──────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, phone, code, password, invite_code } = req.body;

  if (!username || username.trim().length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (!phone) return res.status(400).json({ error: '手机号不能为空' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!code) return res.status(400).json({ error: '验证码不能为空' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const smsRecord = get("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='register' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
  if (!smsRecord) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  run('UPDATE sms_codes SET used=1 WHERE id=?', [smsRecord.id]);

  const existing = get('SELECT id FROM users WHERE phone=?', [phone]);
  if (existing) return res.status(409).json({ error: '该手机号已注册，请直接登录' });

  const hash = await bcrypt.hash(password, 10);
  const result = run('INSERT INTO users (username, phone, password_hash) VALUES (?,?,?)', [username.trim()], phone, hash);
  const user = { id: result.lastInsertRowid, username: username.trim(), phone, paid_expires_at: null, lifetime: 0 };

  // 注册时绑定设备
  const device_fp = req.body.device_fp;
  if (device_fp) {
    run('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
  }

  // 处理邀请码
  if (invite_code && invite_code.trim()) {
    const inviter = get('SELECT user_id FROM invite_codes WHERE code=?', [invite_code.trim().toLowerCase()]);
    if (inviter && inviter.user_id !== user.id) {
      run('INSERT INTO invite_relations (inviter_id, invitee_id) VALUES (?,?)', [inviter.user_id, user.id]);
      // 检查并发放邀请奖励
      checkAndGrantInviteReward(inviter.user_id, db);
    }
  }

  respondSuccess(user, res);
});

// ─── 登录 ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { phone, password, code, device_fp } = req.body;

  if (!phone) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

    const user = get('SELECT * FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(401).json({ error: '手机号或密码错误' });

  // 封禁检查
  if (user.is_active === 0) {
    return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });
  }

  // 情况1：带验证码（已在新设备，需短信确认）
  if (code) {
    const sms = get("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='login' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
    if (!sms) return res.status(401).json({ error: '验证码错误或已过期' });
    run('UPDATE sms_codes SET used=1 WHERE id=?', [sms.id]);

    // 更新设备绑定
    if (device_fp) {
      run('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
    }

    // 滥用检测
    const abuse = checkAbuseAndRecord(db, user, device_fp, req.ip);
    if (abuse.banned) return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });

    return respondSuccess(user, res);
  }

  // 情况2：纯密码登录
  if (password) {
    if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '手机号或密码错误' });
    }

    // 设备指纹不匹配（换设备了）
    if (device_fp && user.device_token && device_fp !== user.device_token) {
      return res.json({ needSmsCode: true, message: '检测到您使用了新设备，请输入短信验证码完成登录' });
    }

    // 滥用检测
    const abuse = checkAbuseAndRecord(db, user, device_fp, req.ip);
    if (abuse.banned) return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });

    // 更新 device_token（新设备第一次密码登录）
    if (device_fp && !user.device_token) {
      run('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
    }

    return respondSuccess(user, res);
  }

  return res.status(400).json({ error: '请输入密码' });
});

// ─── 忘记密码 ─────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

    const user = get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!user) return res.json({ message: '如果该手机号已注册，验证码已发送。' });
  res.json({ message: '验证码已发送，请查收短信。', needVerify: true });
});

// ─── 重置密码 ──────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { phone, code, password } = req.body;
  if (!phone || !code || !password) return res.status(400).json({ error: '缺少必要参数' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const smsRecord = get("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='resetpwd' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
  if (!smsRecord) return res.status(400).json({ error: '验证码错误或已过期' });
  run('UPDATE sms_codes SET used=1 WHERE id=?', [smsRecord.id]);

  const user = get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const hash = await bcrypt.hash(password, 10);
  // 重置密码后清除 device_token，下次登录任何设备都需验证码重新绑定
  run('UPDATE users SET password_hash=?, device_token=NULL, must_change_password=0 WHERE id=?', [hash, user.id]);

  res.json({ message: '密码重置成功，请使用手机号+密码登录' });
});

module.exports = router;
