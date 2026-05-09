const express = require('express');
const router = express.Router();
const { getAsync, runAsync, allAsync } = require('../db');

const ADMIN_KEY = process.env.ADMIN_KEY || 'mctmilk-admin-2026';

function checkAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: '管理员密钥错误' });
  }
  next();
}

// 获取用户列表
router.get('/users', checkAdmin, async (req, res) => {
  try {
    // 自动将已过期且余额为0的非终身用户转为免费用户
    await runAsync("UPDATE users SET is_paid = 0 WHERE (paid_expires_at IS NULL OR paid_expires_at < datetime('now'))");
    const users = await allAsync('SELECT id, username, phone, is_paid, paid_expires_at, lifetime, balance, created_at FROM users ORDER BY id DESC');
    const now = new Date();
    const stats = {
      total: users.length,
      paid: users.filter(u => u.is_paid === 1 && u.paid_expires_at && new Date(u.paid_expires_at) > now).length,
      free: users.length - users.filter(u => u.is_paid === 1 && u.paid_expires_at && new Date(u.paid_expires_at) > now).length,
    };
    res.json({ users, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除用户
router.post('/delete-user', checkAdmin, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: '缺少手机号' });
  try {
    const user = await getAsync('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
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

// 使用统计
router.get('/stats', checkAdmin, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(today.getHours() + 8);
    const todayStr = today.toISOString().slice(0, 10);
    const todayLogs = await allAsync("SELECT action, COUNT(*) as count FROM usage_log WHERE date(created_at) = ? GROUP BY action", [todayStr]);
    const totalLogs = await allAsync('SELECT action, COUNT(*) as count FROM usage_log GROUP BY action');
    const recentLogs = await allAsync('SELECT * FROM usage_log ORDER BY created_at DESC LIMIT 20');
    res.json({ today: todayLogs, total: totalLogs, recent: recentLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
