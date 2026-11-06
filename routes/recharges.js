// 充值金管理路由（需登录）：账户增删改查 + 使用记录（关联订单）
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 余额子查询：得到的金额 - 关联订单已使用
const BALANCE_SQL = `
  SELECT r.*, COALESCE(u.used, 0) AS used, (r.total - COALESCE(u.used, 0)) AS balance
  FROM recharges r
  LEFT JOIN (
    SELECT recharge_id, SUM(recharge_used) AS used
    FROM orders WHERE recharge_id IS NOT NULL GROUP BY recharge_id
  ) u ON u.recharge_id = r.id
`;

// GET /api/recharges  列表（含已用、余额）
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`${BALANCE_SQL} ORDER BY r.created_at DESC`);
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询充值金失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/recharges  新增 { type, amount, bonus, remark }  得到的金额自动 = 金额 + 赠送
router.post('/', async (req, res) => {
  try {
    const { type, amount, bonus, remark } = req.body || {};
    if (!type || !String(type).trim()) {
      return res.status(400).json({ code: 400, msg: '类型不能为空' });
    }
    const amt = parseFloat(amount);
    const bon = parseFloat(bonus) || 0;
    if (isNaN(amt) || amt < 0) {
      return res.status(400).json({ code: 400, msg: '金额不正确' });
    }
    const { rows } = await pool.query(
      'INSERT INTO recharges (type, amount, bonus, total, remark) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [String(type).trim(), amt, bon, Math.round((amt + bon) * 100) / 100, String(remark || '').trim()]
    );
    const created = await pool.query(`${BALANCE_SQL} WHERE r.id = $1`, [rows[0].id]);
    res.json({ code: 0, msg: '新增成功', data: created.rows[0] });
  } catch (err) {
    console.error('新增充值金失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/recharges/:id  修改
router.put('/:id', async (req, res) => {
  try {
    const { type, amount, bonus, remark } = req.body || {};
    if (!type || !String(type).trim()) {
      return res.status(400).json({ code: 400, msg: '类型不能为空' });
    }
    const amt = parseFloat(amount);
    const bon = parseFloat(bonus) || 0;
    if (isNaN(amt) || amt < 0) {
      return res.status(400).json({ code: 400, msg: '金额不正确' });
    }
    const usedRes = await pool.query(
      'SELECT COALESCE(SUM(recharge_used),0) AS used FROM orders WHERE recharge_id = $1',
      [req.params.id]
    );
    const used = Number(usedRes.rows[0].used);
    const total = Math.round((amt + bon) * 100) / 100;
    if (total < used) {
      return res.status(400).json({ code: 400, msg: `得到的金额不能小于已使用金额（${used}）` });
    }
    const { rowCount } = await pool.query(
      'UPDATE recharges SET type = $1, amount = $2, bonus = $3, total = $4, remark = $5 WHERE id = $6',
      [String(type).trim(), amt, bon, total, String(remark || '').trim(), req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '充值金不存在' });
    const updated = await pool.query(`${BALANCE_SQL} WHERE r.id = $1`, [req.params.id]);
    res.json({ code: 0, msg: '修改成功', data: updated.rows[0] });
  } catch (err) {
    console.error('修改充值金失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/recharges/:id  删除（有关联订单时禁止）
router.delete('/:id', async (req, res) => {
  try {
    const used = await pool.query(
      'SELECT COUNT(*) AS n FROM orders WHERE recharge_id = $1',
      [req.params.id]
    );
    if (Number(used.rows[0].n) > 0) {
      return res.status(400).json({ code: 400, msg: '该充值金已被订单使用，不能删除' });
    }
    const { rowCount } = await pool.query('DELETE FROM recharges WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '充值金不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除充值金失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/recharges/:id/usage  使用记录（关联订单列表，含订单数据快照）
router.get('/:id/usage', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.data, o.status, o.recharge_used, o.created_at
       FROM orders o WHERE o.recharge_id = $1
       ORDER BY o.created_at DESC`,
      [req.params.id]
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询使用记录失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
