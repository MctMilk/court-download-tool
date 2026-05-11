const jwt = require('jsonwebtoken');
const { get: dbGet, run: dbRun } = require('../db');

const SECRET = process.env.JWT_SECRET || 'court-tool-jwt-secret-change-in-production';
const EXPIRES_IN = '7d';
const INACTIVITY_MS = 90 * 60 * 1000; // 90分钟无操作过期

function generateToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// 同步更新最后活跃时间
function touchLastActivity(userId) {
  try {
    if (typeof dbRun === 'function') {
      dbRun("UPDATE users SET last_activity = datetime('now', '+8 hours') WHERE id = ?", [userId]);
    }
  } catch {}
}

// 同步检查无操作过期
function isInactive(userId) {
  try {
    if (typeof dbGet !== 'function') return false;
    const user = dbGet('SELECT last_activity FROM users WHERE id = ?', [userId]);
    if (!user || !user.last_activity) return false;
    const last = new Date(user.last_activity).getTime();
    if (isNaN(last)) return false;
    return Date.now() - last > INACTIVITY_MS;
  } catch {
    return false;
  }
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  if (isInactive(payload.userId)) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  req.user = payload;
  touchLastActivity(payload.userId);
  next();
}

function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7));
    if (payload) {
      req.user = payload;
      touchLastActivity(payload.userId);
    }
  }
  next();
}

// 判断用户是否付费（lifetime=1 或 到期时间>now）
function isPaidUser(user) {
  if (!user) return false;
  if (user.lifetime === 1) return true;
  if (!user.paid_expires_at) return false;
  return new Date(user.paid_expires_at) > new Date();
}

function requirePaid(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (!req.user.isPaid) {
    return res.status(403).json({ error: '请开通付费版以使用批量下载功能', requiresUpgrade: true });
  }
  next();
}

module.exports = { generateToken, verifyToken, authenticate, optionalAuth, requirePaid, isPaidUser, SECRET, touchLastActivity };
