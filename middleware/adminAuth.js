/**
 * 管理员认证中间件
 * 从 X-Admin-Key header 验证，密钥只存在于环境变量，不在请求 body 中传输
 */
const ADMIN_KEY = process.env.ADMIN_KEY;

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY) {
    console.error('[adminAuth] ADMIN_KEY 环境变量未设置');
    return res.status(500).json({ error: '管理员认证未配置' });
  }
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: '管理员密钥错误' });
  }
  next();
}

module.exports = { adminAuth };
