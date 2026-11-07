// 商品订单录入系统 - 后端入口
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const logger = require('./middleware/logger');
const { authRequired } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
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
app.use('/api/users', userRoutes);
app.use('/api/dicts', dictRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/shipments', shipmentRoutes);
app.use('/api/recharges', rechargeRoutes);
app.use('/api/recycle-items', recycleItemRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/logs', logRoutes);

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
