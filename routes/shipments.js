// 出货记录路由（需登录）：出货列表 + 出货详情（关联订单快照）
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// GET /api/shipments?express_no=&date_from=&date_to=&page=&pageSize=
router.get('/', async (req, res) => {
  try {
    const { express_no, date_from, date_to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(10000, Math.max(1, parseInt(req.query.pageSize) || 20));

    const where = ['s.family_id = $1'];
    const params = [req.familyScope || '00000000-0000-0000-0000-000000000000'];
    if (express_no) {
      params.push(`%${String(express_no).trim()}%`);
      where.push(`s.express_no ILIKE $${params.length}`);
    }
    if (date_from) {
      params.push(`${date_from} 00:00:00`);
      where.push(`s.created_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(`${date_to} 23:59:59`);
      where.push(`s.created_at <= $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM shipments s ${whereSql}`, params);
    const total = Number(countRes.rows[0].total);

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT s.id, s.express_company, s.express_no, s.express_fee, s.total_cost,
              s.total_recovered, s.total_profit, s.order_count, s.created_at
       FROM shipments s ${whereSql}
       ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ code: 0, data: { list: rows, total, page, pageSize } });
  } catch (err) {
    console.error('查询出货记录失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/shipments/:id  出货详情（含关联订单快照）
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM shipments WHERE id = $1 AND family_id = $2', [
      req.params.id,
      req.familyScope || '00000000-0000-0000-0000-000000000000',
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '出货记录不存在' });
    }
    const shipment = rows[0];
    const { rows: orders } = await pool.query(
      'SELECT id, order_id, data FROM shipment_orders WHERE shipment_id = $1',
      [req.params.id]
    );
    res.json({ code: 0, data: { shipment, orders } });
  } catch (err) {
    console.error('查询出货详情失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
