// 字典管理路由（需登录）：字典种类 + 字典键值对
// 种类分两级：全局字典（family_id 为 NULL，仅超管可改，所有人可见）/ 家庭字典（仅本家庭可见可改）
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 家庭过滤参数（无家庭范围时用零值 uuid，查不到任何数据）
const fam = (req) => req.familyScope || '00000000-0000-0000-0000-000000000000';

// 加载字典种类并校验可见性：返回种类或 null（不存在/不可见）
async function getVisibleType(req, typeId) {
  const { rows } = await pool.query('SELECT id, name, family_id FROM dict_types WHERE id = $1', [
    typeId,
  ]);
  const t = rows[0];
  if (!t) return null;
  if (t.family_id === null) return t; // 全局字典所有人可见
  return t.family_id === req.familyScope ? t : null;
}

// ---------- 字典种类 ----------

// GET /api/dicts  种类列表（本家庭 + 全局，含每个种类下的条目数）
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT t.id, t.name, t.family_id, t.created_at, COUNT(i.id) AS item_count
      FROM dict_types t LEFT JOIN dict_items i ON i.type_id = t.id
      WHERE t.family_id = $1 OR t.family_id IS NULL
      GROUP BY t.id ORDER BY t.family_id NULLS LAST, t.created_at DESC
    `,
      [fam(req)]
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/dicts  新增种类（家庭字典）
router.post('/', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '字典名称不能为空' });
    }
    if (!req.familyScope) {
      return res.status(400).json({ code: 400, msg: '请先选择家庭' });
    }
    const dup = await pool.query('SELECT id FROM dict_types WHERE name = $1 AND family_id = $2', [
      name.trim(),
      req.familyScope,
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该字典名称已存在' });
    }
    const { rows } = await pool.query(
      'INSERT INTO dict_types (name, family_id) VALUES ($1, $2) RETURNING id, name, created_at',
      [name.trim(), req.familyScope]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/dicts/:id  修改种类名（全局字典仅超管可改）
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '字典名称不能为空' });
    }
    const type = await getVisibleType(req, req.params.id);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    if (type.family_id === null && !req.user.isSuper) {
      return res.status(403).json({ code: 403, msg: '全局字典仅超级管理员可修改' });
    }
    const dup = await pool.query(
      'SELECT id FROM dict_types WHERE name = $1 AND family_id IS NOT DISTINCT FROM $2 AND id <> $3',
      [name.trim(), type.family_id, req.params.id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该字典名称已存在' });
    }
    const { rows } = await pool.query(
      'UPDATE dict_types SET name = $1 WHERE id = $2 RETURNING id, name, created_at',
      [name.trim(), req.params.id]
    );
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/dicts/:id  删除种类（级联删除键值对，全局字典仅超管可删）
router.delete('/:id', async (req, res) => {
  try {
    const type = await getVisibleType(req, req.params.id);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    if (type.family_id === null && !req.user.isSuper) {
      return res.status(403).json({ code: 403, msg: '全局字典仅超级管理员可删除' });
    }
    const { rowCount } = await pool.query('DELETE FROM dict_types WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除字典种类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// ---------- 字典键值对 ----------

// GET /api/dicts/name/:name/items  按种类名称取键值对（订单表单下拉用，本家庭+全局）
router.get('/name/:name/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.type_id, i.k, i.v, i.sort
       FROM dict_items i JOIN dict_types t ON t.id = i.type_id
       WHERE t.name = $1 AND (t.family_id = $2 OR t.family_id IS NULL)
       ORDER BY i.sort, i.created_at`,
      [req.params.name, fam(req)]
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
    const type = await getVisibleType(req, req.params.typeId);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
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

// POST /api/dicts/:typeId/items  新增键值对（全局字典仅超管可加）
router.post('/:typeId/items', async (req, res) => {
  try {
    const { k, v, sort } = req.body || {};
    if (!k || !String(k).trim()) {
      return res.status(400).json({ code: 400, msg: '键(k)不能为空' });
    }
    const type = await getVisibleType(req, req.params.typeId);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    if (type.family_id === null && !req.user.isSuper) {
      return res.status(403).json({ code: 403, msg: '全局字典仅超级管理员可修改' });
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

// PUT /api/dicts/:typeId/items/:id  修改键值对（全局字典仅超管可改）
router.put('/:typeId/items/:id', async (req, res) => {
  try {
    const { k, v, sort } = req.body || {};
    if (!k || !String(k).trim()) {
      return res.status(400).json({ code: 400, msg: '键(k)不能为空' });
    }
    const type = await getVisibleType(req, req.params.typeId);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    if (type.family_id === null && !req.user.isSuper) {
      return res.status(403).json({ code: 403, msg: '全局字典仅超级管理员可修改' });
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

// DELETE /api/dicts/:typeId/items/:id  删除键值对（全局字典仅超管可删）
router.delete('/:typeId/items/:id', async (req, res) => {
  try {
    const type = await getVisibleType(req, req.params.typeId);
    if (!type) return res.status(404).json({ code: 404, msg: '字典种类不存在' });
    if (type.family_id === null && !req.user.isSuper) {
      return res.status(403).json({ code: 403, msg: '全局字典仅超级管理员可修改' });
    }
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
