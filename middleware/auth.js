const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'court-tool-jwt-secret-change-in-production';
const EXPIRES_IN = '7d';

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

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  req.user = payload;
  next();
}

function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7));
    if (payload) req.user = payload;
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
  // isPaid 在 JWT 中以整数存储（0/1），由登录时根据 lifetime/paid_expires_at 计算写入
  if (!req.user.isPaid) {
    return res.status(403).json({ error: '请开通付费版以使用批量下载功能', requiresUpgrade: true });
  }
  next();
}

module.exports = { generateToken, verifyToken, authenticate, optionalAuth, requirePaid, isPaidUser, SECRET };
