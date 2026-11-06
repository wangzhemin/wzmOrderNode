// JWT 认证中间件：校验 Authorization: Bearer <token>
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const JWT_EXPIRES_H = process.env.JWT_EXPIRES_H || '12';

// 签发 token
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone },
    JWT_SECRET,
    { expiresIn: `${JWT_EXPIRES_H}h` }
  );
}

// 校验 token，通过后把用户信息挂到 req.user
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ code: 401, msg: '未登录，请先登录' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, msg: 'token 无效或已过期，请重新登录' });
  }
}

module.exports = { signToken, authRequired };
