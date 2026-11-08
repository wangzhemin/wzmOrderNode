// 订单管理路由（需登录）：动态字段增删改查 + 状态筛选 + 多选发货 + 标记收货
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 订单出货成本：优先使用「最终成本」(latest_cost)；未填时按（订单成本，未填则用订单金额）− 返利 现算
function effectiveCost(d) {
  const lc = parseFloat(d.latest_cost);
  if (!isNaN(lc)) return lc;
  const base = parseFloat(d.order_cost) > 0 ? parseFloat(d.order_cost) : parseFloat(d.recharge_full) || 0;
  return base - (parseFloat(d.rebate) || 0);
}

// 商品种类数量明细 [{name, quantity}]（同一种类合并累加数量）
function sumCategoryCounts(orders) {
  const m = new Map();
  for (const o of orders) {
    const name = String(o.data.category_name || '未分类').trim() || '未分类';
    const qty = parseFloat(o.data.quantity) || 0;
    m.set(name, (m.get(name) || 0) + qty);
  }
  return [...m.entries()].map(([name, quantity]) => ({ name, quantity: Math.round(quantity * 100) / 100 }));
}

// 出货单号 = 种类 + 出货时间 + 随机数，格式：肽敏舒+爱他美-20261108174530-A3F9
function makeShipmentNo(names) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const label = names.slice(0, 2).join('+') + (names.length > 2 ? '等' : '');
  return `${label}-${ts}-${rand}`;
}

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

    const where = ['o.category_id = $1', 'o.family_id = $2'];
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
      where.push(`o.status <> 'shipped'`);
    } else if (['pending', 'received', 'shipped'].includes(status)) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    const whereSql = 'WHERE ' + where.join(' AND ');

    // 排序方向：asc=正序（旧在前），默认 desc=倒序（新在前）
    const sortDir = String(req.query.sort).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM orders o ${whereSql}`, params);
    const total = Number(countRes.rows[0].total);

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT o.id, o.category_id, o.data, o.status, o.recharge_id, o.recharge_used, o.shipment_id,
              o.created_by, u.name AS created_by_name, o.created_at, o.updated_at,
              sh.shipment_no AS shipment_no
       FROM orders o
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN shipments sh ON sh.id = o.shipment_id
       ${whereSql}
       ORDER BY o.created_at ${sortDir} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // 合计：对所有匹配行按大类中 number 类型字段求和
    // 代收订单单独一份合计（proxySums），不参与正常利润/成本合计
    const numberFields = (category.fields || []).filter((f) => f.type === 'number');
    const sums = {};
    const proxySums = {};
    if (numberFields.length > 0 && total > 0) {
      const allRes = await pool.query(`SELECT data FROM orders o ${whereSql}`, params.slice(0, -2));
      const isProxy = (d) => d.is_proxy === '1' || d.is_proxy === true;
      for (const f of numberFields) {
        sums[f.key] = allRes.rows.reduce(
          (acc, r) => (isProxy(r.data) ? acc : acc + (parseFloat(r.data[f.key]) || 0)), 0
        );
        sums[f.key] = Math.round(sums[f.key] * 100) / 100;
        proxySums[f.key] = allRes.rows.reduce(
          (acc, r) => (isProxy(r.data) ? acc + (parseFloat(r.data[f.key]) || 0) : acc), 0
        );
        proxySums[f.key] = Math.round(proxySums[f.key] * 100) / 100;
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
        proxySums,
      },
    });
  } catch (err) {
    console.error('查询订单失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/orders/field-values?category_id=&key=shop|account
// 订单动态字段去重值（筛选下拉 / 新增订单联想输入用）
router.get('/field-values', async (req, res) => {
  try {
    const { category_id, key } = req.query;
    // 白名单：只允许查询这两列，防止任意 key 拼进 SQL
    if (!['shop', 'account'].includes(String(key))) {
      return res.status(400).json({ code: 400, msg: '不支持的字段' });
    }
    if (!category_id) {
      return res.status(400).json({ code: 400, msg: '缺少 category_id 参数' });
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT data->>'${key}' AS v FROM orders
       WHERE category_id = $1 AND family_id = $2 AND COALESCE(data->>'${key}', '') <> ''
       ORDER BY v LIMIT 500`,
      [category_id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    res.json({ code: 0, data: { list: rows.map((r) => r.v) } });
  } catch (err) {
    console.error('查询字段去重值失败:', err.message);
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

// PUT /api/orders/:id  修改订单 { data?, status? }
// status 只允许 pending/received 互转；已出库订单不能在此改状态（需走出货流程管理）
router.put('/:id', async (req, res) => {
  try {
    const { data, status } = req.body || {};
    if (status !== undefined && !['pending', 'received'].includes(status)) {
      return res.status(400).json({ code: 400, msg: '状态值不正确（已出库需走发货流程）' });
    }
    if ((data === undefined || data === null) && status === undefined) {
      return res.status(400).json({ code: 400, msg: '没有需要修改的内容' });
    }
    const orderRes = await pool.query(
      `SELECT o.id, o.status AS cur_status, c.fields FROM orders o
       JOIN categories c ON c.id = o.category_id
       WHERE o.id = $1 AND o.family_id = $2`,
      [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '订单不存在' });
    }
    const order = orderRes.rows[0];
    if (order.cur_status === 'shipped' && status !== undefined && status !== order.cur_status) {
      return res.status(400).json({ code: 400, msg: '已出库订单不能修改状态' });
    }

    const sets = [];
    const updParams = [];
    if (data !== undefined && data !== null) {
      if (typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ code: 400, msg: '订单数据格式不正确' });
      }
      const allowed = new Set((order.fields || []).map((f) => f.key));
      const clean = {};
      for (const [k, v] of Object.entries(data)) {
        if (allowed.has(k) && v !== '' && v != null) clean[k] = v;
      }
      updParams.push(JSON.stringify(clean));
      sets.push(`data = $${updParams.length}`, 'recharge_id = NULL', 'recharge_used = 0');
    }
    if (status !== undefined) {
      updParams.push(status);
      sets.push(`status = $${updParams.length}`);
    }
    sets.push('updated_at = NOW()');
    updParams.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${updParams.length}
       RETURNING id, category_id, data, status, created_at, updated_at`,
      updParams
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

    // 正常订单与代收订单分开合计：代收不参与本家庭利润/成本，单独快照展示
    let totalCost = 0;
    let totalRecovered = 0;
    let proxyCost = 0;
    let proxyRecovered = 0;
    for (const o of orders) {
      const isProxy = o.data.is_proxy === '1' || o.data.is_proxy === true;
      const cost = effectiveCost(o.data);
      const rec = parseFloat(o.data.recycle_amount) || 0;
      if (isProxy) {
        proxyCost += cost;
        proxyRecovered += rec;
      } else {
        totalCost += cost;
        totalRecovered += rec;
      }
    }
    totalCost = Math.round(totalCost * 100) / 100;
    totalRecovered = Math.round(totalRecovered * 100) / 100;
    const totalProfit = Math.round((totalRecovered - totalCost - fee) * 100) / 100;
    proxyCost = Math.round(proxyCost * 100) / 100;
    proxyRecovered = Math.round(proxyRecovered * 100) / 100;
    const proxyProfit = Math.round((proxyRecovered - proxyCost) * 100) / 100;

    // 商品种类数量明细 + 出货单号（种类 + 出货时间 + 随机数，唯一索引兜底，冲突则重试）
    const counts = sumCategoryCounts(orders);
    let shipment = null;
    for (let attempt = 0; attempt < 5 && !shipment; attempt += 1) {
      const no = makeShipmentNo(counts.map((c) => c.name));
      try {
        const { rows: inserted } = await client.query(
          `INSERT INTO shipments (shipment_no, category_counts, express_company, express_no, express_fee, total_cost, total_recovered, total_profit, order_count, created_by, shipper, payment_received, remark, family_id, proxy_cost, proxy_recovered, proxy_profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
          [
            no,
            JSON.stringify(counts),
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
            proxyCost,
            proxyRecovered,
            proxyProfit,
          ]
        );
        shipment = inserted[0];
      } catch (e) {
        if (e.code !== '23505') throw e; // 出货单号重复则换一个随机数重试
      }
    }
    if (!shipment) throw new Error('出货单号生成失败');

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
