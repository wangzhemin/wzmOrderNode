// 操作日志查询路由（需登录）
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// GET /api/logs?user_name=&method=&path=&date_from=&date_to=&page=&pageSize=
router.get('/', async (req, res) => {
  try {
    const { user_name, method, path, date_from, date_to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

    const where = ['(family_id = $1 OR family_id IS NULL)'];
    const params = [req.familyScope || '00000000-0000-0000-0000-000000000000'];
    if (user_name) {
      params.push(`%${String(user_name).trim()}%`);
      where.push(`user_name ILIKE $${params.length}`);
    }
    if (method) {
      params.push(String(method).toUpperCase());
      where.push(`method = $${params.length}`);
    }
    if (path) {
      params.push(`%${String(path).trim()}%`);
      where.push(`path ILIKE $${params.length}`);
    }
    if (date_from) {
      params.push(`${date_from} 00:00:00`);
      where.push(`created_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(`${date_to} 23:59:59`);
      where.push(`created_at <= $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM op_logs ${whereSql}`, params);
    const total = Number(countRes.rows[0].total);

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT id, user_name, method, path, status, ip, cost_ms, created_at, action FROM op_logs ${whereSql}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ code: 0, data: { list: rows, total, page, pageSize } });
  } catch (err) {
    console.error('查询日志失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
