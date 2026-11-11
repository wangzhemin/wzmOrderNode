// 商品订单录入系统 - 后端入口
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const logger = require('./middleware/logger');
const { authRequired, requirePerm } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const familyRoutes = require('./routes/families');
const dictRoutes = require('./routes/dicts');
const categoryRoutes = require('./routes/categories');
const orderRoutes = require('./routes/orders');
const shipmentRoutes = require('./routes/shipments');
const rechargeRoutes = require('./routes/recharges');
const recycleItemRoutes = require('./routes/recycle-items');
const statsRoutes = require('./routes/stats');
const logRoutes = require('./routes/logs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 健康检查（不记日志、不需要登录）
app.get('/api/health', (req, res) => res.json({ code: 0, msg: 'ok' }));

// 记录所有 /api 请求日志（放在最前以统计耗时）
app.use('/api', logger);

// 登录接口（无需 token）
app.use('/api/auth', authRoutes);

// 其余接口全部需要登录
app.use('/api', authRequired);

// 模块权限守卫：GET 走查看权限，写操作走管理权限
const modPerm = (view, manage) => (req, res, next) =>
  requirePerm(req.method === 'GET' ? view : manage)(req, res, next);

app.use('/api/users', modPerm('users.view', 'users.manage'), userRoutes);
app.use('/api/families', familyRoutes); // 路由内部控制（读：本人家庭；写：families.manage）
app.use('/api/dicts', modPerm('dicts.view', 'dicts.manage'), dictRoutes);
app.use('/api/categories', modPerm('categories.view', 'categories.manage'), categoryRoutes);
app.use('/api/orders', modPerm('orders.view', 'orders.manage'), orderRoutes);
app.use('/api/shipments', modPerm('shipments.view', 'shipments.manage'), shipmentRoutes);
app.use('/api/recharges', modPerm('recharges.view', 'recharges.manage'), rechargeRoutes);
app.use('/api/recycle-items', modPerm('recycle.view', 'recycle.manage'), recycleItemRoutes);
app.use('/api/stats', modPerm('dashboard.view', 'dashboard.view'), statsRoutes);
app.use('/api/logs', modPerm('logs.view', 'logs.view'), logRoutes);

// ===== 前端静态托管（打包后的 web/dist 复制到 node/dist）=====
const DIST_DIR = path.join(__dirname, 'dist');
app.use(express.static(DIST_DIR));

// SPA 兜底：非 /api 的 GET 请求全部返回 index.html（前端路由）
// 注意：Express 5 不支持 app.get('*') 写法，用中间件实现
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile('index.html', { root: DIST_DIR });
  }
  next();
});

// 404
app.use((req, res) => res.status(404).json({ code: 404, msg: '接口不存在' }));

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.message);
  res.status(500).json({ code: 500, msg: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`✅ 后端服务已启动: http://localhost:${PORT}`);
});

// 操作日志保留策略：仅保留最近 180 天，服务启动时 + 每天凌晨自动清理
const LOG_RETENTION_DAYS = 180;
async function cleanOldLogs() {
  try {
    const r = await pool.query(
      `DELETE FROM op_logs WHERE created_at < NOW() - INTERVAL '${LOG_RETENTION_DAYS} days'`
    );
    if (r.rowCount > 0) {
      console.log(`🧹 已清理 ${r.rowCount} 条超过 ${LOG_RETENTION_DAYS} 天的操作日志`);
    }
  } catch (e) {
    console.error('清理操作日志失败:', e.message);
  }
}
cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
