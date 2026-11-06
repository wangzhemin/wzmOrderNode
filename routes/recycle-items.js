// 回收商品管理路由（需登录）：种类 + 回收单价 增删改查
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// GET /api/recycle-items
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price, created_at FROM recycle_items ORDER BY created_at DESC'
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/recycle-items  { name, price }
router.post('/', async (req, res) => {
  try {
    const { name, price } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '种类名称不能为空' });
    }
    const p = parseFloat(price);
    if (isNaN(p) || p < 0) {
      return res.status(400).json({ code: 400, msg: '回收金额不正确' });
    }
    const dup = await pool.query('SELECT id FROM recycle_items WHERE name = $1', [name.trim()]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该种类已存在' });
    }
    const { rows } = await pool.query(
      'INSERT INTO recycle_items (name, price) VALUES ($1, $2) RETURNING id, name, price, created_at',
      [name.trim(), p]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/recycle-items/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, price } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '种类名称不能为空' });
    }
    const p = parseFloat(price);
    if (isNaN(p) || p < 0) {
      return res.status(400).json({ code: 400, msg: '回收金额不正确' });
    }
    const dup = await pool.query('SELECT id FROM recycle_items WHERE name = $1 AND id <> $2', [
      name.trim(),
      req.params.id,
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该种类已存在' });
    }
    const { rows } = await pool.query(
      'UPDATE recycle_items SET name = $1, price = $2 WHERE id = $3 RETURNING id, name, price, created_at',
      [name.trim(), p, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '回收商品不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/recycle-items/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM recycle_items WHERE id = $1', [
      req.params.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '回收商品不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
