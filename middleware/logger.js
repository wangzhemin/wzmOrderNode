// 操作日志中间件：记录 登录 + 订单/大类/出货的增删改（查询 GET 不记录）
// action 字段为人话描述，如：登录 / 奶粉订单新增 / 猫粮订单删除 / 出货单编辑
const pool = require('../db');

// 需要记录的路径前缀（写操作）
const LOGGED_PREFIXES = ['/api/orders', '/api/categories', '/api/shipments'];

// 订单/大类删除时 body 无数据，查库补出大类名称
async function orderCategory(id) {
  try {
    const r = await pool.query("SELECT data->>'category_name' AS name FROM orders WHERE id = $1", [id]);
    return (r.rows[0] && r.rows[0].name) || '';
  } catch {
    return '';
  }
}

// 依据请求生成操作描述
async function buildAction(req, pathOnly) {
  const m = req.method;
  const id = req.params && req.params.id;

  if (pathOnly === '/api/auth/login' && m === 'POST') return '登录';

  if (pathOnly.startsWith('/api/orders')) {
    const cat = (req.body && req.body.data && req.body.data.category_name) || '';
    if (pathOnly === '/api/orders/ship') return `${cat || ''}订单发货`.trim() || '订单发货';
    if (pathOnly === '/api/orders/mark-received') return '订单收货';
    if (m === 'POST') return `${cat}订单新增`.trim() || '订单新增';
    if (m === 'PUT') return `${cat}订单编辑`.trim() || '订单编辑';
    if (m === 'DELETE') {
      const name = id ? await orderCategory(id) : '';
      return `${name}订单删除`.trim() || '订单删除';
    }
  }

  if (pathOnly.startsWith('/api/categories')) {
    if (m === 'POST') return '大类新增';
    if (m === 'PUT') return '大类编辑';
    if (m === 'DELETE') return '大类删除';
  }

  if (pathOnly.startsWith('/api/shipments')) {
    if (m === 'POST') return '出货单新增';
    if (m === 'DELETE') return '出货单删除';
    if (m === 'PUT') {
      if (pathOnly.endsWith('/payment')) return '出货单回款修改';
      if (pathOnly.endsWith('/fee')) return '出货单快递费修改';
      if (pathOnly.endsWith('/info')) return '出货单信息修改';
      return '出货单编辑';
    }
  }

  return '';
}

function logger(req, res, next) {
  const start = Date.now();
  res.on('finish', async () => {
    const pathOnly = req.originalUrl.split('?')[0];
    const isLogin = pathOnly === '/api/auth/login' && req.method === 'POST';
    const isBizWrite =
      req.method !== 'GET' && LOGGED_PREFIXES.some((p) => pathOnly.startsWith(p));
    if (!isLogin && !isBizWrite) return;

    const action = await buildAction(req, pathOnly);
    const user = req.user || null;
    pool
      .query(
        `INSERT INTO op_logs (user_id, user_name, method, path, status, ip, cost_ms, family_id, action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user ? user.id : null,
          user ? user.name : (req.body && req.body.phone) || '未登录',
          req.method,
          pathOnly,
          res.statusCode,
          req.ip,
          Date.now() - start,
          user ? user.family_id : null,
          action || null,
        ]
      )
      .catch((err) => console.error('日志写入失败:', err.message));
  });
  next();
}

module.exports = logger;
