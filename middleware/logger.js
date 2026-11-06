// 操作日志中间件（精简版）：只记录 登录 + 订单/大类的增删改，查询(GET)不记录
const pool = require('../db');

// 需要记录的路径前缀（写操作）
const LOGGED_PREFIXES = ['/api/orders', '/api/categories'];

function logger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const pathOnly = req.originalUrl.split('?')[0];
    const isLogin = pathOnly === '/api/auth/login' && req.method === 'POST';
    const isBizWrite =
      req.method !== 'GET' && LOGGED_PREFIXES.some((p) => pathOnly.startsWith(p));
    if (!isLogin && !isBizWrite) return;

    const user = req.user || null;
    pool
      .query(
        `INSERT INTO op_logs (user_id, user_name, method, path, status, ip, cost_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user ? user.id : null,
          user ? user.name : (req.body && req.body.phone) || '未登录',
          req.method,
          pathOnly,
          res.statusCode,
          req.ip,
          Date.now() - start,
        ]
      )
      .catch((err) => console.error('日志写入失败:', err.message));
  });
  next();
}

module.exports = logger;
