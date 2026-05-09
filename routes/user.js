const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, all, getAsync, runAsync, allAsync } = require('../db');
const { authenticate, isPaidUser } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_PASSWORD = 'SmartLaw0601';

// 计费工具函数
function calcRecharge(type, months) {
  if (type === 'monthly') return { price: 5 * months, months };
  const prices = { 1: 50, 2: 80, 3: 105 };
  return { price: prices[months] || 50, months: months * 12 };
}

function calcExpiresAt(currentExpires, addMonths) {
  if (currentExpires && currentExpires.includes('9999')) return currentExpires;
  const base = currentExpires ? new Date(currentExpires) : new Date();
  base.setMonth(base.getMonth() + addMonths);
  return base.toISOString().replace('T', ' ').slice(0, 19);
}

// 生成7位小写字母数字邀请码
function genInviteCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 7; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// 获取或生成用户邀请码
function getOrCreateInviteCode(userId) {
  let record = get('SELECT code FROM invite_codes WHERE user_id=?', [userId]);
  if (record) return record.code;
  let code;
  let attempts = 0;
  do {
    code = genInviteCode();
    const exists = get('SELECT id FROM invite_codes WHERE code=?', [code]);
    if (!exists) break;
    attempts++;
  } while (attempts < 10);
  run('INSERT INTO invite_codes (user_id, code) VALUES (?,?)', [userId, code]);
  return code;
}

// 获取当前用户信息
router.get('/me', authenticate, async (req, res) => {
  try {
        const user = await getAsync('SELECT id, username, phone, is_paid, lifetime, balance, paid_expires_at, must_change_password, created_at FROM users WHERE id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const userIsPaid = isPaidUser(user);
    const inviteCode = getOrCreateInviteCode(db, user.id);
    res.json({
      id: user.id,
      username: user.username,
      phone: user.phone,
      isPaid: userIsPaid,
      paidExpiresAt: user.paid_expires_at,
      lifetime: user.lifetime || 0,
      balance: user.balance || 0,
      mustChangePwd: user.must_change_password === 1,
      createdAt: user.created_at,
      inviteCode,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 修改密码（用户主动修改）
router.post('/change-password', authenticate, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });

    const user = await getAsync('SELECT * FROM users WHERE id = ?', [req.user.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 自愿改密（must_change_password=0）必须验证旧密码；强制改密（must_change_password=1）跳过验证
  if (user.must_change_password === 0) {
    if (!oldPassword) return res.status(400).json({ error: '请输入原密码' });
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(401).json({ error: '原密码错误' });
    }
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await runAsync('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, user.id]);
  res.json({ message: '密码修改成功' });
});

// 客服确认充值（实际写入，保留以兼容旧渠道）
router.post('/recharge/confirm', authenticate, async (req, res) => {
  const { type, months, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });

  const { price, months: addMonths } = calcRecharge(type, months);
  const user = await getAsync('SELECT * FROM users WHERE id = ?', [req.user.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.lifetime === 1) return res.status(403).json({ error: '该用户为终身会员，无需充值' });

  const newExpires = calcExpiresAt(user.paid_expires_at, addMonths);
  await runAsync("UPDATE users SET balance = balance + ?, recharged_at = datetime('now', '+8 hours'), paid_expires_at = ? WHERE id = ?", [price, newExpires, user.id]);
  // 记录余额流水（必须）
  await runAsync(
    `INSERT INTO balance_log (user_id, amount, type, description, created_at) VALUES (?, ?, '充值', ?, datetime('now', '+8 hours'))`,
    [user.id, price, `客服手动充值-${type === 'monthly' ? '月付' : '年付'}套餐(${addMonths}个月)`]
  );

  res.json({ message: `充值成功，到期时间：${newExpires}` });
});

// 管理员手动开通/取消付费（保留兼容，新调用改用 /admin/set-lifetime）
router.post('/admin/set-paid', async (req, res) => {
  const { userId, phone, isPaid, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (isPaid) {
      await runAsync("UPDATE users SET lifetime = 1, paid_expires_at = '9999-12-31 23:59:59' WHERE id = ?", [user.id]);
      res.json({ message: `已为 ${user.username || phone} 开通终身会员` });
    } else {
      res.json({ needRefund: true, phone, username: user.username || phone });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员切换终身会员状态
router.post('/admin/set-lifetime', async (req, res) => {
  const { userId, phone, lifetime, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (lifetime) {
      await runAsync("UPDATE users SET lifetime = 1, paid_expires_at = '9999-12-31 23:59:59' WHERE id = ?", [user.id]);
      res.json({ message: `已为 ${user.username || phone} 开通终身会员` });
    } else {
      await runAsync('UPDATE users SET lifetime = 0, paid_expires_at = NULL WHERE id = ?', [user.id]);
      res.json({ message: `已取消 ${user.username || phone} 的终身会员资格` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员确认退款（取消付费）
router.post('/admin/confirm-refund', async (req, res) => {
  const { userId, phone, refund_amount, refund_time, refund_reason, refund_proof, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!refund_amount || !refund_time || !refund_reason) return res.status(400).json({ error: '退款金额、时间和理由不能为空' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const refundResult = await runAsync('INSERT INTO refunds (user_id, refund_amount, refund_time, refund_reason, refund_proof) VALUES (?, ?, ?, ?, ?)', [user.id, refund_amount, refund_time, refund_reason, refund_proof || null]);
    const refundId = refundResult.lastInsertRowid;
    await runAsync('UPDATE users SET balance = balance - ?, lifetime = 0 WHERE id = ?', [refund_amount, user.id]);
    await runAsync("INSERT INTO balance_log (user_id, amount, type, description, refund_id) VALUES (?, ?, '退款', ?, ?)", [user.id, -parseFloat(refund_amount), '退费扣除：' + refund_reason, refundId]);

    res.json({ message: `退款记录已保存，${user.username || phone} 的付费资格已取消` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员添加用户
router.post('/admin/add-user', async (req, res) => {
  const { username, phone, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!username || username.trim().length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (!phone) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

  try {
        const existing = await getAsync('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing) return res.status(409).json({ error: '该手机号已注册' });

    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    await runAsync('INSERT INTO users (username, phone, email, password_hash, must_change_password) VALUES (?, ?, NULL, ?, 1)', [username.trim(), phone, hash]);

    res.json({ message: `用户 ${username} 创建成功，初始密码：${DEFAULT_PASSWORD}，下次登录必须修改密码` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员重置用户密码（设为默认密码，强制改密）
router.post('/admin/reset-password', async (req, res) => {
  const { userId, phone, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    await runAsync('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hash, user.id]);
    res.json({ message: `密码已重置为 ${DEFAULT_PASSWORD}，用户下次登录必须修改密码` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员将用户设为免费会员
router.post('/admin/set-free', async (req, res) => {
  const { userId, phone, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    await runAsync("UPDATE users SET lifetime = 0, is_paid = 0, paid_expires_at = NULL WHERE id = ?", [user.id]);
    res.json({ message: `${user.username || phone} 已设为免费用户` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员调整会员到期时间
router.post('/admin/adjust-expiry', async (req, res) => {
  const { userId, phone, start_date, quantity, unit, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });
  if (!start_date) return res.status(400).json({ error: '请选择起始日期' });
  if (!quantity || quantity <= 0) return res.status(400).json({ error: '请输入正确的时长' });
  if (!['month', 'year'].includes(unit)) return res.status(400).json({ error: '单位只能是月或年' });

  try {
    const user = userId
      ? await getAsync('SELECT id, username, phone, lifetime FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, username, phone, lifetime FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.lifetime === 1) return res.status(403).json({ error: '该用户为终身会员，无法调整期限' });

    const addMonths = unit === 'year' ? parseInt(quantity) * 12 : parseInt(quantity);
    const baseDate = new Date(start_date);
    baseDate.setMonth(baseDate.getMonth() + addMonths);
    const newExpires = baseDate.toISOString().replace('T', ' ').slice(0, 19);

    await runAsync("UPDATE users SET lifetime = 0, is_paid = 1, paid_expires_at = ? WHERE id = ?", [newExpires, user.id]);

    res.json({ message: `到期时间已调整为 ${newExpires}（${user.username || phone}）` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员删除用户（带保护：终身用户或有订阅期禁止删除）
router.post('/admin/delete', async (req, res) => {
  const { userId, phone, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT * FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (user.lifetime === 1) return res.status(403).json({ error: '该用户为终身会员，禁止删除' });
    if ((user.balance || 0) > 0) {
      return res.json({ needRefund: true, phone, username: user.username || phone, balance: user.balance });
    }
    if (user.paid_expires_at && new Date(user.paid_expires_at) > new Date()) {
      return res.status(403).json({ error: `该用户尚未到期（${user.paid_expires_at}），禁止删除` });
    }

    await runAsync('DELETE FROM usage_log WHERE user_id = ?', [user.id]);
    await runAsync('DELETE FROM users WHERE id = ?', [user.id]);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员获取用户余额流水
router.get('/admin/balance-log', async (req, res) => {
  const { userId, phone, page = 1 } = req.query;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId && !phone) return res.status(400).json({ error: '缺少用户ID或手机号' });

  try {
    const user = userId
      ? await getAsync('SELECT id, balance, phone FROM users WHERE id = ?', [userId])
      : await getAsync('SELECT id, balance, phone FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const PAGE_SIZE = 20;
    const offset = (parseInt(page) - 1) * PAGE_SIZE;
    const total = (await getAsync("SELECT COUNT(*) as c FROM balance_log WHERE user_id = ?", [user.id]))?.c || 0;
    // 联查 refunds 表取凭证图片
    const logs = await allAsync(`
      SELECT bl.*, r.refund_proof
      FROM balance_log bl
      LEFT JOIN refunds r ON bl.refund_id = r.id
      WHERE bl.user_id = ?
      ORDER BY bl.created_at DESC
      LIMIT ? OFFSET ?
    `);

    res.json({ balance: user.balance, logs, total, page: parseInt(page), pageSize: PAGE_SIZE });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员修改用户手机号
router.post('/admin/update-phone', async (req, res) => {
  const { userId, phone, adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '管理员密钥错误' });
  if (!userId) return res.status(400).json({ error: '缺少用户ID' });
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

  try {
    const user = await getAsync('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const existing = await getAsync('SELECT id FROM users WHERE phone = ? AND id != ?', [phone, userId]);
    if (existing) return res.status(409).json({ error: '该手机号已被其他用户使用' });
    await runAsync('UPDATE users SET phone = ? WHERE id = ?', [phone, userId]);
    res.json({ message: '手机号已更新为 ' + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 邀请体系 ─────────────────────────────────────────────────────

const REWARD_POLICY = [
  {
    level: 1, type: 'monthly',
    condition: '已邀请满 10 人，或已邀请满 5 位付费用户',
    reward: '奖励 7 天订阅会员',
    remaining_total: 10, remaining_paid: 5,
  },
  {
    level: 2, type: 'yearly',
    condition: '已邀请满 30 位付费用户',
    reward: '奖励 1 年订阅会员（不与月度叠加，取最高级）',
    remaining_total: null, remaining_paid: 30,
  },
  {
    level: 3, type: 'lifetime',
    condition: '已邀请满 100 位付费用户',
    reward: '奖励终身会员（最高奖励，覆盖其他所有）',
    remaining_total: null, remaining_paid: 100,
  },
];

// GET /invite/status — 邀请面板数据
router.get('/invite/status', authenticate, async (req, res) => {
  try {
        const userId = req.user.userId;
    const inviteCode = getOrCreateInviteCode(userId);

    const total = (await getAsync("SELECT COUNT(*) as c FROM invite_relations WHERE inviter_id=?", [userId]))?.c || 0;

    const paid = (await getAsync(`
      SELECT COUNT(*) as c FROM invite_relations ir
      JOIN users u ON ir.invitee_id = u.id
      WHERE ir.inviter_id=? AND (u.lifetime=1 OR (u.is_paid=1 AND u.paid_expires_at>datetime('now')))
    `, [userId]))?.c || 0;

    const rewards = await allAsync('SELECT * FROM invite_rewards WHERE user_id=? ORDER BY id DESC', [userId]);

    res.json({
      inviteCode,
      total, paid,
      rewards: rewards.map(r => ({
        type: r.reward_type,
        desc: r.reward_desc,
        grantedAt: r.granted_at,
      })),
      policy: REWARD_POLICY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /invite/invitees — 已邀请用户列表（分页）
router.get('/invite/invitees', authenticate, async (req, res) => {
  const { page = 1 } = req.query;
  try {
        const userId = req.user.userId;
    const PAGE_SIZE = 20;
    const offset = (parseInt(page) - 1) * PAGE_SIZE;
    const total = (await getAsync("SELECT COUNT(*) as c FROM invite_relations WHERE inviter_id=?", [userId]))?.c || 0;
    const rows = await allAsync(`
      SELECT u.username, u.lifetime, u.is_paid, u.paid_expires_at, ir.created_at as invited_at
      FROM invite_relations ir
      JOIN users u ON ir.invitee_id = u.id
      WHERE ir.inviter_id=?
      ORDER BY ir.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, PAGE_SIZE, offset]);

    res.json({
      total,
      page: parseInt(page),
      pageSize: PAGE_SIZE,
      invitees: rows.map(u => ({
        username: u.username || u.phone,
        memberType: u.lifetime === 1 ? '终身会员' : (u.is_paid && u.paid_expires_at && new Date(u.paid_expires_at) > new Date() ? '订阅用户' : '免费用户'),
        invitedAt: u.invited_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
