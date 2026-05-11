const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, getAsync, runAsync } = require('../db');
const { generateToken, isPaidUser, touchLastActivity } = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────────
function respondSuccess(user, res) {
  touchLastActivity(user.id);
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
// 奖励级别定义（level 越大越高，防止低级别覆盖高级别）
const REWARD_LEVELS = [
  { type: 'monthly',  threshold_reg: 10, threshold_paid: 5,  level: 1, months: 1 },
  { type: 'monthly2', threshold_reg: 20, threshold_paid: 10, level: 2, months: 1 },
  { type: 'yearly',  threshold_reg: 999, threshold_paid: 30, level: 3, months: 10 },
  { type: 'lifetime',threshold_reg: 999, threshold_paid: 100, level: 4, months: 0 },
];

// 通用奖励检查逻辑（通过 getFn/runFn 解耦，sync/async 通用）
function _checkAndGrantInviteReward(inviterId, { getFn, runFn }) {
  const inviter = getFn('SELECT * FROM users WHERE id=?', [inviterId]);
  if (!inviter || inviter.lifetime === 1) return;

  const totalReg = getFn(
    'SELECT COUNT(*) as c FROM invite_relations WHERE inviter_id=?', [inviterId]
  )?.c || 0;
  const totalPaid = getFn(`
    SELECT COUNT(*) as c FROM invite_relations ir
    JOIN users u ON ir.invitee_id = u.id
    WHERE ir.inviter_id=? AND (u.lifetime=1 OR (u.is_paid=1 AND u.paid_expires_at>datetime('now')))
  `, [inviterId])?.c || 0;

  const highestReward = getFn(
    'SELECT level FROM invite_rewards WHERE user_id=? ORDER BY level DESC LIMIT 1', [inviterId]
  );
  const currentLevel = highestReward?.level || 0;

  for (const info of REWARD_LEVELS) {
    if (info.level <= currentLevel) continue;
    // 满足注册阈值 OR 满足付费阈值 → 触发
    if (totalReg < info.threshold_reg && totalPaid < info.threshold_paid) continue;
    const existing = getFn('SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?', [inviterId, info.type]);
    if (existing) continue;
    _applyInviteReward(inviter, info, { runFn });
    return; // 每次最多发一项
  }
}

function _applyInviteReward(inviter, info, { runFn }) {
  if (info.type === 'lifetime') {
    runFn("UPDATE users SET lifetime=1, is_paid=1, paid_expires_at='9999-12-31 23:59:59' WHERE id=?", [inviter.id]);
    runFn("INSERT INTO invite_rewards (user_id, reward_type, reward_desc, level, granted_at) VALUES (?,?,?,?,datetime('now','+8 hours'))",
      [inviter.id, 'lifetime', `邀请奖励：终身会员（${info.threshold_paid}名付费用户）`, info.level]);
    console.log(`邀请奖励发放: 邀请人${inviter.id}获得终身会员`);
  } else {
    const now = new Date();
    let expires = inviter.paid_expires_at ? new Date(inviter.paid_expires_at) : now;
    if (expires <= now) expires = now;
    expires.setMonth(expires.getMonth() + info.months);
    const newExpires = expires.toISOString().replace('T', ' ').slice(0, 19);
    const descMap = { monthly: '月度邀请奖励（1个月）', monthly2: '第2个月度邀请奖励（1个月）', yearly: '年度邀请奖励（10个月）' };
    runFn("UPDATE users SET lifetime=0, is_paid=1, paid_expires_at=? WHERE id=?", [newExpires, inviter.id]);
    runFn("INSERT INTO invite_rewards (user_id, reward_type, reward_desc, level, granted_at) VALUES (?,?,?,?,datetime('now','+8 hours'))",
      [inviter.id, info.type, descMap[info.type], info.level]);
    console.log(`邀请奖励发放: 邀请人${inviter.id}获得${descMap[info.type]}`);
  }
}

// sync版（注册时调用）
function checkAndGrantInviteReward(inviterId) {
  _checkAndGrantInviteReward(inviterId, { getFn: get, runFn: run });
}

// async版（payment.js 付费回调时使用）
async function checkAndGrantInviteRewardAsync(inviterId) {
  const { getAsync, runAsync } = require('../db');
  _checkAndGrantInviteReward(inviterId, { getFn: getAsync, runFn: runAsync });
}

function checkAbuseAndRecord(user, device_fp, ip) {
  const isLifetime = user.lifetime === 1;
  const limit24h = isLifetime ? 30 : 15;
  const limit7d = isLifetime ? 100 : 50;

  const recent24h = get("SELECT COUNT(DISTINCT device_fp) as c FROM login_attempts WHERE user_id=? AND success=1 AND created_at>datetime('now','-24 hours')", [user.id])?.c || 0;
  const recent7d = get("SELECT COUNT(DISTINCT device_fp) as c FROM login_attempts WHERE user_id=? AND success=1 AND created_at>datetime('now','-7 days')", [user.id])?.c || 0;

  run('INSERT INTO login_attempts (user_id, device_fp, ip, success) VALUES (?,?,?,1)', [user.id, device_fp || null, ip]);

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

  const smsRecord = await getAsync("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='register' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
  if (!smsRecord) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  await runAsync('UPDATE sms_codes SET used=1 WHERE id=?', [smsRecord.id]);

  const existing = await getAsync('SELECT id FROM users WHERE phone=?', [phone]);
  if (existing) return res.status(409).json({ error: '该手机号已注册，请直接登录' });

  const hash = await bcrypt.hash(password, 10);
  const result = await runAsync('INSERT INTO users (username, phone, password_hash) VALUES (?,?,?)', [username.trim(), phone, hash]);
  const user = { id: result.lastInsertRowid, username: username.trim(), phone, paid_expires_at: null, lifetime: 0 };

  const device_fp = req.body.device_fp;
  if (device_fp) {
    await runAsync('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
  }

  if (invite_code && invite_code.trim()) {
    const inviter = await getAsync('SELECT user_id FROM invite_codes WHERE code=?', [invite_code.trim().toLowerCase()]);
    if (inviter && inviter.user_id !== user.id) {
      await runAsync('INSERT INTO invite_relations (inviter_id, invitee_id) VALUES (?,?)', [inviter.user_id, user.id]);
      // 被邀请人B获得7天订阅
      const expires = new Date();
      expires.setDate(expires.getDate() + 7);
      await runAsync("UPDATE users SET is_paid=1, paid_expires_at=? WHERE id=?", [
        expires.toISOString().replace('T', ' ').slice(0, 19), user.id
      ]);
      await runAsync("INSERT INTO invite_rewards (user_id, reward_type, reward_desc, level, granted_at) VALUES (?,?,?,?,datetime('now','+8 hours'))",
        [user.id, 'invitee_7d', '使用邀请码注册：7天订阅', 0]);
      // 邀请人A的奖励（按注册/付费阈值触发）
      checkAndGrantInviteReward(inviter.user_id);
    }
  }

  respondSuccess(user, res);
});

// ─── 登录 ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { phone, password, code, device_fp } = req.body;

  if (!phone) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

  const user = await getAsync('SELECT * FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(401).json({ error: '手机号或密码错误' });

  if (user.is_active === 0) {
    return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });
  }

  if (code) {
    const sms = await getAsync("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='login' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
    if (!sms) return res.status(401).json({ error: '验证码错误或已过期' });
    await runAsync('UPDATE sms_codes SET used=1 WHERE id=?', [sms.id]);

    if (device_fp) {
      await runAsync('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
    }

    const abuse = checkAbuseAndRecord(user, device_fp, req.ip);
    if (abuse.banned) return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });

    return respondSuccess(user, res);
  }

  if (password) {
    if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '手机号或密码错误' });
    }

    if (device_fp && user.device_token && device_fp !== user.device_token) {
      return res.json({ needSmsCode: true, message: '检测到您使用了新设备，请输入短信验证码完成登录' });
    }

    const abuse = checkAbuseAndRecord(user, device_fp, req.ip);
    if (abuse.banned) return res.json({ banned: true, message: '账号异常，已临时封禁，请联系客服MCTMilk解封' });

    if (device_fp && !user.device_token) {
      await runAsync('UPDATE users SET device_token=? WHERE id=?', [device_fp, user.id]);
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
  // 始终返回相同响应，防止攻击者枚举手机号是否已注册
  res.json({ message: '如果该手机号已注册，验证码已发送。' });
});

// ─── 重置密码 ──────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { phone, code, password } = req.body;
  if (!phone || !code || !password) return res.status(400).json({ error: '缺少必要参数' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const smsRecord = await getAsync("SELECT * FROM sms_codes WHERE phone=? AND code=? AND purpose='resetpwd' AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1", [phone, code]);
  if (!smsRecord) return res.status(400).json({ error: '验证码错误或已过期' });
  await runAsync('UPDATE sms_codes SET used=1 WHERE id=?', [smsRecord.id]);

  const user = await getAsync('SELECT id FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const hash = await bcrypt.hash(password, 10);
  await runAsync('UPDATE users SET password_hash=?, device_token=NULL, must_change_password=0 WHERE id=?', [hash, user.id]);

  res.json({ message: '密码重置成功，请使用手机号+密码登录' });
});

module.exports = router;
module.exports.checkAndGrantInviteRewardAsync = checkAndGrantInviteRewardAsync;
