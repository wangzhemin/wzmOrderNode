// 订单管理路由（需登录）：动态字段增删改查 + 状态筛选 + 多选发货 + 标记收货
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// GET /api/orders?category_id=&shop=&account=&category_name=&date_from=&date_to=&status=&page=&pageSize=
// status: active(默认,未出库) / pending / received / shipped / all
router.get('/', async (req, res) => {
  try {
    const { category_id, shop, account, category_name, date_from, date_to } = req.query;
    if (!category_id) {
      return res.status(400).json({ code: 400, msg: '缺少 category_id 参数' });
    }
    const catRes = await pool.query(
      'SELECT id, name, fields FROM categories WHERE id = $1 AND family_id = $2',
      [category_id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (catRes.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '大类不存在' });
    }
    const category = catRes.rows[0];

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(10000, Math.max(1, parseInt(req.query.pageSize) || 20));

    const where = ['category_id = $1', 'family_id = $2'];
    const params = [category_id, req.familyScope || '00000000-0000-0000-0000-000000000000'];
    function likeCond(field, value) {
      if (!value) return;
      params.push(`%${String(value).trim()}%`);
      where.push(`data->>'${field}' ILIKE $${params.length}`);
    }
    likeCond('shop', shop);
    likeCond('account', account);
    likeCond('category_name', category_name);
    if (date_from) {
      params.push(String(date_from));
      where.push(`data->>'prebuy_date' >= $${params.length}`);
    }
    if (date_to) {
      params.push(String(date_to));
      where.push(`data->>'prebuy_date' <= $${params.length}`);
    }
    const status = String(req.query.status || 'active');
    if (status === 'active') {
      where.push(`status <> 'shipped'`);
    } else if (['pending', 'received', 'shipped'].includes(status)) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM orders ${whereSql}`, params);
    const total = Number(countRes.rows[0].total);

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT id, category_id, data, status, recharge_id, recharge_used, shipment_id, created_at, updated_at FROM orders ${whereSql}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // 合计：对所有匹配行按大类中 number 类型字段求和
    const numberFields = (category.fields || []).filter((f) => f.type === 'number');
    const sums = {};
    if (numberFields.length > 0 && total > 0) {
      const allRes = await pool.query(`SELECT data FROM orders ${whereSql}`, params.slice(0, -2));
      for (const f of numberFields) {
        sums[f.key] = allRes.rows.reduce((acc, r) => acc + (parseFloat(r.data[f.key]) || 0), 0);
        sums[f.key] = Math.round(sums[f.key] * 100) / 100;
      }
    }

    res.json({
      code: 0,
      data: {
        list: rows,
        total,
        page,
        pageSize,
        category: { id: category.id, name: category.name, fields: category.fields },
        sums,
      },
    });
  } catch (err) {
    console.error('查询订单失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/orders  新增订单 { category_id, data }
router.post('/', async (req, res) => {
  try {
    const { category_id, data } = req.body || {};
    if (!category_id) return res.status(400).json({ code: 400, msg: '缺少 category_id' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ code: 400, msg: '订单数据格式不正确' });
    }
    const catRes = await pool.query(
      'SELECT id, fields FROM categories WHERE id = $1 AND family_id = $2',
      [category_id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (catRes.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '大类不存在' });
    }
    const allowed = new Set((catRes.rows[0].fields || []).map((f) => f.key));
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (allowed.has(k) && v !== '' && v != null) clean[k] = v;
    }
    if (!req.familyScope) {
      return res.status(400).json({ code: 400, msg: '请先选择家庭' });
    }
    const { rows } = await pool.query(
      `INSERT INTO orders (category_id, data, created_by, family_id) VALUES ($1, $2, $3, $4)
       RETURNING id, category_id, data, status, created_at`,
      [category_id, JSON.stringify(clean), req.user.id, req.familyScope]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增订单失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/orders/:id  修改订单 { data }
router.put('/:id', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ code: 400, msg: '订单数据格式不正确' });
    }
    const orderRes = await pool.query(
      `SELECT o.id, c.fields FROM orders o
       JOIN categories c ON c.id = o.category_id
       WHERE o.id = $1 AND o.family_id = $2`,
      [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '订单不存在' });
    }
    const allowed = new Set((orderRes.rows[0].fields || []).map((f) => f.key));
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (allowed.has(k) && v !== '' && v != null) clean[k] = v;
    }
    const { rows } = await pool.query(
      `UPDATE orders SET data = $1, recharge_id = NULL, recharge_used = 0, updated_at = NOW() WHERE id = $2
       RETURNING id, category_id, data, status, created_at, updated_at`,
      [JSON.stringify(clean), req.params.id]
    );
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改订单失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/orders/:id  删除订单（已出库的不可删除）
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM orders WHERE id = $1 AND status <> 'shipped' AND family_id = $2`,
      [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (rowCount === 0) {
      return res.status(400).json({ code: 400, msg: '订单不存在或已出库，不能删除' });
    }
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除订单失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/orders/mark-received  批量标记收货 { order_ids }
router.post('/mark-received', async (req, res) => {
  try {
    const { order_ids } = req.body || {};
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ code: 400, msg: '请选择要标记收货的订单' });
    }
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'received', updated_at = NOW()
       WHERE id = ANY($1::uuid[]) AND status = 'pending' AND family_id = $2 RETURNING id`,
      [order_ids, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    res.json({ code: 0, msg: `已标记 ${rows.length} 笔订单为已收货`, data: { count: rows.length } });
  } catch (err) {
    console.error('标记收货失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/orders/ship  批量发货出库
// { order_ids, express_company, express_no, express_fee, shipper, payment_received, remark }
// 总回收 = Σ回收金额；总利润 = 总回收 - 总成本 - 快递费
router.post('/ship', async (req, res) => {
  const client = await pool.connect();
  try {
    const { order_ids, express_company, express_no, express_fee, shipper, payment_received, remark } =
      req.body || {};
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ code: 400, msg: '请选择要发货的订单' });
    }
    if (!express_company || !String(express_company).trim()) {
      return res.status(400).json({ code: 400, msg: '快递公司不能为空' });
    }
    const fee = parseFloat(express_fee);
    if (isNaN(fee) || fee < 0) {
      return res.status(400).json({ code: 400, msg: '快递金额不正确' });
    }

    await client.query('BEGIN');
    // 只有「已收货」的订单才能发货，防止误选未收货订单
    const { rows: statusRows } = await client.query(
      `SELECT id, status FROM orders WHERE id = ANY($1::uuid[]) AND family_id = $2 FOR UPDATE`,
      [order_ids, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    const pendingCount = statusRows.filter((r) => r.status !== 'received').length;
    if (pendingCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 400, msg: '只有已收货的订单才能发货，请先收货再选择发货' });
    }
    if (statusRows.length !== order_ids.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 400, msg: '选中的订单不存在或不属于当前家庭' });
    }
    const { rows: orders } = await client.query(
      `SELECT id, data FROM orders WHERE id = ANY($1::uuid[]) AND status = 'received' FOR UPDATE`,
      [order_ids]
    );
    if (orders.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 400, msg: '选中的订单不存在或已出库' });
    }

    let totalCost = 0;
    let totalRecovered = 0;
    for (const o of orders) {
      totalCost += parseFloat(o.data.order_cost) || 0;
      totalRecovered += parseFloat(o.data.recycle_amount) || 0;
    }
    totalCost = Math.round(totalCost * 100) / 100;
    totalRecovered = Math.round(totalRecovered * 100) / 100;
    const totalProfit = Math.round((totalRecovered - totalCost - fee) * 100) / 100;

    const { rows: shipments } = await client.query(
      `INSERT INTO shipments (express_company, express_no, express_fee, total_cost, total_recovered, total_profit, order_count, created_by, shipper, payment_received, remark, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        String(express_company).trim(),
        String(express_no || '').trim(),
        fee,
        totalCost,
        totalRecovered,
        totalProfit,
        orders.length,
        req.user.id,
        String(shipper || '').trim(),
        payment_received === true,
        String(remark || '').trim(),
        req.familyScope,
      ]
    );
    const shipment = shipments[0];

    for (const o of orders) {
      await client.query(
        'INSERT INTO shipment_orders (shipment_id, order_id, data) VALUES ($1, $2, $3)',
        [shipment.id, o.id, JSON.stringify(o.data)]
      );
    }
    await client.query(
      `UPDATE orders SET status = 'shipped', shipment_id = $1, shipped_at = NOW(), updated_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [shipment.id, orders.map((o) => o.id)]
    );
    await client.query('COMMIT');
    res.json({ code: 0, msg: `已出库 ${orders.length} 笔订单`, data: shipment });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('发货失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  } finally {
    client.release();
  }
});

module.exports = router;
