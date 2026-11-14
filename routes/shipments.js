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
      `SELECT s.* FROM shipments s ${whereSql}
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

// PUT /api/shipments/:id/payment  修改回款信息（发货时不填，回款后在出货记录里标记）
// { payment_received?: boolean, actual_amount?: number|null }
// actual_amount = 实际回款金额（商品降价/核损后与回收价不同），null 表示清空
// 利润口径：有实际回款时 利润 = 实际回款 - 快递费 - 总成本；否则 利润 = 总回收 - 快递费 - 总成本
router.put('/:id/payment', async (req, res) => {
  try {
    const { payment_received, actual_amount } = req.body || {};
    if (payment_received === undefined && actual_amount === undefined) {
      return res.status(400).json({ code: 400, msg: '请提供要修改的回款信息' });
    }
    let amountSql = '';
    let profitSql = '';
    const params = [];
    if (payment_received !== undefined) {
      params.push(payment_received === true);
      amountSql += `payment_received = $${params.length}`;
    }
    if (actual_amount !== undefined) {
      if (actual_amount !== null) {
        const n = Number(actual_amount);
        if (isNaN(n) || n < 0) {
          return res.status(400).json({ code: 400, msg: '实际回款金额不正确' });
        }
        params.push(Math.round(n * 100) / 100);
      } else {
        params.push(null);
      }
      amountSql += (amountSql ? ', ' : '') + `actual_amount = $${params.length}`;
      // 实际回款变动时利润联动重算（COALESCE：有实际回款用实际回款，否则用总回收）
      profitSql = `, total_profit = ROUND(COALESCE($${params.length}::numeric, total_recovered) - total_cost - express_fee, 2)`;
    }
    params.push(req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000');
    const { rows } = await pool.query(
      `UPDATE shipments SET ${amountSql}${profitSql} WHERE id = $${params.length - 1} AND family_id = $${params.length}
       RETURNING id, payment_received, actual_amount, total_profit`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '出货记录不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改回款信息失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/shipments/:id/fee  修改快递费（总利润联动重算 = COALESCE(实际回款, 总回收) - 总成本 - 快递费）
router.put('/:id/fee', async (req, res) => {
  try {
    const fee = Number(req.body?.express_fee);
    if (isNaN(fee) || fee < 0) {
      return res.status(400).json({ code: 400, msg: '快递费金额不正确' });
    }
    const feeVal = Math.round(fee * 100) / 100;
    const { rows } = await pool.query(
      `UPDATE shipments
       SET express_fee = $1,
           total_profit = ROUND(COALESCE(actual_amount, total_recovered) - total_cost - $1, 2)
       WHERE id = $2 AND family_id = $3
       RETURNING id, express_fee, total_profit`,
      [feeVal, req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '出货记录不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改快递费失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/shipments/:id/info  修改出货信息（快递公司/快递单号/出货商家/备注/快递费/回款信息）
// 编辑弹窗统一入口：快递费或实际回款变动时总利润联动重算（COALESCE(实际回款, 总回收) - 总成本 - 快递费）
router.put('/:id/info', async (req, res) => {
  try {
    const fields = [];
    const params = [];
    let profitTouched = false;
    for (const key of ['express_company', 'express_no', 'shipper', 'remark']) {
      if (req.body?.[key] !== undefined) {
        params.push(String(req.body[key]).trim());
        fields.push(`${key} = $${params.length}`);
      }
    }
    // 快递费：数字校验
    if (req.body?.express_fee !== undefined) {
      const fee = Number(req.body.express_fee);
      if (isNaN(fee) || fee < 0) {
        return res.status(400).json({ code: 400, msg: '快递费金额不正确' });
      }
      params.push(Math.round(fee * 100) / 100);
      fields.push(`express_fee = $${params.length}`);
      profitTouched = true;
    }
    // 是否回款
    if (req.body?.payment_received !== undefined) {
      params.push(req.body.payment_received === true);
      fields.push(`payment_received = $${params.length}`);
    }
    // 实际回款金额（null 表示清空）
    if (req.body?.actual_amount !== undefined) {
      if (req.body.actual_amount === null || req.body.actual_amount === '') {
        params.push(null);
        fields.push(`actual_amount = $${params.length}`);
      } else {
        const n = Number(req.body.actual_amount);
        if (isNaN(n) || n < 0) {
          return res.status(400).json({ code: 400, msg: '实际回款金额不正确' });
        }
        params.push(Math.round(n * 100) / 100);
        fields.push(`actual_amount = $${params.length}`);
      }
      profitTouched = true;
    }
    if (fields.length === 0) {
      return res.status(400).json({ code: 400, msg: '请提供要修改的内容' });
    }
    params.push(req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000');
    // 主更新（SET 表达式取旧行值，实际回款联动利润需二次重算）
    await pool.query(
      `UPDATE shipments SET ${fields.join(', ')}
       WHERE id = $${params.length - 1} AND family_id = $${params.length}`,
      params
    );
    let rows;
    if (profitTouched) {
      // 利润重算：有实际回款用实际回款，否则用总回收
      ({ rows } = await pool.query(
        `UPDATE shipments
         SET total_profit = ROUND(COALESCE(actual_amount, total_recovered) - total_cost - express_fee, 2)
         WHERE id = $1 AND family_id = $2
         RETURNING *`,
        [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
      ));
    } else {
      ({ rows } = await pool.query(
        'SELECT * FROM shipments WHERE id = $1 AND family_id = $2',
        [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
      ));
    }
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '出货记录不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改出货信息失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
