// 数据看板统计接口
// GET /api/stats?category_id=&from=&to=
// from/to 为 YYYY-MM-DD，按订单「购买日期」筛选；category_id 可选筛选大类
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const n = (v) => Number(v) || 0;
// 保留两位小数
const r2 = (v) => Math.round(n(v) * 100) / 100;

router.get('/', async (req, res) => {
  try {
    const { category_id, from, to } = req.query;
    // 基础条件：日期 + 家庭 + 筛选（正常订单与代收订单共用，params 一致）
    const base = [`o.data->>'prebuy_date' IS NOT NULL`, `o.data->>'prebuy_date' <> ''`];
    const params = [];
    params.push(req.familyScope || '00000000-0000-0000-0000-000000000000');
    base.push(`o.family_id = $${params.length}`);
    if (category_id) {
      params.push(String(category_id));
      base.push(`o.category_id = $${params.length}`);
    }
    if (from) {
      params.push(String(from));
      base.push(`o.data->>'prebuy_date' >= $${params.length}`);
    }
    if (to) {
      params.push(String(to));
      base.push(`o.data->>'prebuy_date' <= $${params.length}`);
    }
    // 代收订单不参与本家庭利润/成本统计；正常与代收各一份 WHERE
    const where = 'WHERE ' + base.concat([`COALESCE(o.data->>'is_proxy', '') <> '1'`]).join(' AND ');
    const whereProxy = 'WHERE ' + base.concat([`COALESCE(o.data->>'is_proxy', '') = '1'`]).join(' AND ');

    // 汇总：回收(总收入) / 最终成本 / 利润 / 订单数 等
    const sumRes = await pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM((o.data->>'recycle_amount')::numeric), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit,
              COALESCE(SUM(CASE WHEN o.data->>'order_amount' <> '' THEN (o.data->>'order_amount')::numeric ELSE 0 END), 0) AS order_amount,
              COALESCE(SUM(CASE WHEN o.data->>'rebate' <> '' THEN (o.data->>'rebate')::numeric ELSE 0 END), 0) AS rebate,
              COALESCE(SUM(CASE WHEN o.data->>'quantity' <> '' THEN (o.data->>'quantity')::numeric ELSE 0 END), 0) AS quantity
       FROM orders o ${where}`,
      params
    );
    const s = sumRes.rows[0];

    // 代收订单单独统计（金额/成本/利润，需要单独结算还给对方）
    const proxyRes = await pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(CASE WHEN o.data->>'recycle_amount' <> '' THEN (o.data->>'recycle_amount')::numeric ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit
       FROM orders o ${whereProxy}`,
      params
    );
    const ps = proxyRes.rows[0];

    // 每日趋势（回收 / 成本 / 利润 / 订单数）
    const dailyRes = await pool.query(
      `SELECT o.data->>'prebuy_date' AS date,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN o.data->>'recycle_amount' <> '' THEN (o.data->>'recycle_amount')::numeric ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit
       FROM orders o ${where}
       GROUP BY 1 ORDER BY 1`,
      params
    );

    // 按大类统计
    const catRes = await pool.query(
      `SELECT c.name AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN o.data->>'recycle_amount' <> '' THEN (o.data->>'recycle_amount')::numeric ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit
       FROM orders o JOIN categories c ON c.id = o.category_id ${where}
       GROUP BY c.name ORDER BY profit DESC`,
      params
    );

    // 按商品种类排行（Top 10）
    const itemRes = await pool.query(
      `SELECT o.data->>'category_name' AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN o.data->>'recycle_amount' <> '' THEN (o.data->>'recycle_amount')::numeric ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit
       FROM orders o ${where}
       GROUP BY 1 HAVING o.data->>'category_name' IS NOT NULL AND o.data->>'category_name' <> ''
       ORDER BY profit DESC LIMIT 10`,
      params
    );

    // 按店铺排行（Top 10）
    const shopRes = await pool.query(
      `SELECT o.data->>'shop' AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN o.data->>'recycle_amount' <> '' THEN (o.data->>'recycle_amount')::numeric ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN o.data->>'latest_cost' <> '' THEN (o.data->>'latest_cost')::numeric ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN o.data->>'est_profit' <> '' THEN (o.data->>'est_profit')::numeric ELSE 0 END), 0) AS profit
       FROM orders o ${where}
       GROUP BY 1 HAVING o.data->>'shop' IS NOT NULL AND o.data->>'shop' <> ''
       ORDER BY profit DESC LIMIT 10`,
      params
    );

    // 订单状态分布（同一筛选范围）
    const statusRes = await pool.query(
      `SELECT o.status, COUNT(*)::int AS count FROM orders o ${where} GROUP BY o.status`,
      params
    );

    // 出货统计（按出货时间筛同样区间，限本家庭）
    const shipConds = ['family_id = $1'];
    const shipParams = [req.familyScope || '00000000-0000-0000-0000-000000000000'];
    if (from) {
      shipParams.push(String(from));
      shipConds.push(`created_at::date >= $${shipParams.length}`);
    }
    if (to) {
      shipParams.push(String(to));
      shipConds.push(`created_at::date <= $${shipParams.length}`);
    }
    const shipRes = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(express_fee), 0) AS express_fee,
              COALESCE(SUM(total_profit), 0) AS total_profit
       FROM shipments WHERE ${shipConds.join(' AND ')}`,
      shipParams
    );

    res.json({
      code: 0,
      msg: 'ok',
      data: {
        summary: {
          order_count: n(s.order_count),
          quantity: r2(s.quantity),
          recovered: r2(s.recovered),
          cost: r2(s.cost),
          profit: r2(s.profit),
          order_amount: r2(s.order_amount),
          rebate: r2(s.rebate),
          proxy: {
            order_count: n(ps.order_count),
            recovered: r2(ps.recovered),
            cost: r2(ps.cost),
            profit: r2(ps.profit),
          },
        },
        daily: dailyRes.rows.map((d) => ({
          date: d.date,
          count: d.count,
          recovered: r2(d.recovered),
          cost: r2(d.cost),
          profit: r2(d.profit),
        })),
        byCategory: catRes.rows.map((d) => ({
          name: d.name,
          count: d.count,
          recovered: r2(d.recovered),
          cost: r2(d.cost),
          profit: r2(d.profit),
        })),
        byItem: itemRes.rows.map((d) => ({
          name: d.name,
          count: d.count,
          recovered: r2(d.recovered),
          cost: r2(d.cost),
          profit: r2(d.profit),
        })),
        byShop: shopRes.rows.map((d) => ({
          name: d.name,
          count: d.count,
          recovered: r2(d.recovered),
          cost: r2(d.cost),
          profit: r2(d.profit),
        })),
        statusCounts: statusRes.rows.map((d) => ({ status: d.status, count: d.count })),
        shipment: {
          count: n(shipRes.rows[0].count),
          express_fee: r2(shipRes.rows[0].express_fee),
          total_profit: r2(shipRes.rows[0].total_profit),
        },
      },
    });
  } catch (err) {
    console.error('统计查询失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
