// 字典管理路由（需登录）：字典种类 + 字典键值对
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// ---------- 字典种类 ----------

// GET /api/dicts  种类列表（含每个种类下的条目数）
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.created_at, COUNT(i.id) AS item_count
      FROM dict_types t LEFT JOIN dict_items i ON i.type_id = t.id
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/dicts  新增种类
router.post('/', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '字典名称不能为空' });
    }
    const dup = await pool.query('SELECT id FROM dict_types WHERE name = $1', [name.trim()]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该字典名称已存在' });
    }
    const { rows } = await pool.query(
      'INSERT INTO dict_types (name) VALUES ($1) RETURNING id, name, created_at',
      [name.trim()]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/dicts/:id  修改种类名
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '字典名称不能为空' });
    }
    const dup = await pool.query('SELECT id FROM dict_types WHERE name = $1 AND id <> $2', [
      name.trim(),
      req.params.id,
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该字典名称已存在' });
    }
    const { rows } = await pool.query(
      'UPDATE dict_types SET name = $1 WHERE id = $2 RETURNING id, name, created_at',
      [name.trim(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/dicts/:id  删除种类（级联删除键值对）
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM dict_types WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// ---------- 字典键值对 ----------

// GET /api/dicts/name/:name/items  按种类名称取键值对（订单表单下拉用）
router.get('/name/:name/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.type_id, i.k, i.v, i.sort
       FROM dict_items i JOIN dict_types t ON t.id = i.type_id
       WHERE t.name = $1 ORDER BY i.sort, i.created_at`,
      [req.params.name]
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('按名称查询字典键值对失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/dicts/:typeId/items  某种类下的键值对列表
router.get('/:typeId/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type_id, k, v, sort, created_at FROM dict_items WHERE type_id = $1 ORDER BY sort, created_at',
      [req.params.typeId]
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询字典键值对失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/dicts/:typeId/items  新增键值对
router.post('/:typeId/items', async (req, res) => {
  try {
    const { k, v, sort } = req.body || {};
    if (!k || !String(k).trim()) {
      return res.status(400).json({ code: 400, msg: '键(k)不能为空' });
    }
    const typeExist = await pool.query('SELECT id FROM dict_types WHERE id = $1', [
      req.params.typeId,
    ]);
    if (typeExist.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    }
    const { rows } = await pool.query(
      'INSERT INTO dict_items (type_id, k, v, sort) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.typeId, String(k).trim(), v == null ? '' : String(v), parseInt(sort) || 0]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增字典键值对失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/dicts/:typeId/items/:id  修改键值对
router.put('/:typeId/items/:id', async (req, res) => {
  try {
    const { k, v, sort } = req.body || {};
    if (!k || !String(k).trim()) {
      return res.status(400).json({ code: 400, msg: '键(k)不能为空' });
    }
    const { rows } = await pool.query(
      'UPDATE dict_items SET k = $1, v = $2, sort = $3 WHERE id = $4 AND type_id = $5 RETURNING *',
      [String(k).trim(), v == null ? '' : String(v), parseInt(sort) || 0, req.params.id, req.params.typeId]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '键值对不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改字典键值对失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/dicts/:typeId/items/:id  删除键值对
router.delete('/:typeId/items/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM dict_items WHERE id = $1 AND type_id = $2',
      [req.params.id, req.params.typeId]
    );
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '键值对不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除字典键值对失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
