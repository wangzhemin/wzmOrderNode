// 订单大类管理路由（需登录）
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const FIELD_TYPES = ['text', 'number', 'date', 'recycle', 'recharge'];

// 校验字段定义数组，返回 { ok, fields|msg }
function validateFields(raw) {
  if (raw == null) return { ok: true, fields: [] };
  if (!Array.isArray(raw)) return { ok: false, msg: '字段定义必须是数组' };
  const fields = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || !String(f.label || '').trim()) {
      return { ok: false, msg: '字段名称不能为空' };
    }
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    let key = String(f.key || '').trim();
    if (!key) key = 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (seen.has(key)) return { ok: false, msg: `字段标识重复: ${key}` };
    seen.add(key);
    fields.push({ key, label: String(f.label).trim(), type });
  }
  return { ok: true, fields };
}

// 家庭范围条件：追加到 params，返回 SQL 片段（业务数据必须选定家庭）
function scopeCond(req, params, col = 'family_id') {
  if (!req.familyScope) return '1=0';
  params.push(req.familyScope);
  return `${col} = $${params.length}`;
}

// GET /api/categories  大类列表（当前家庭）
router.get('/', async (req, res) => {
  try {
    const params = [];
    const fam = scopeCond(req, params, 'c.family_id');
    const { rows } = await pool.query(
      `
      SELECT c.id, c.name, c.fields, c.created_at, COUNT(o.id) AS order_count
      FROM categories c LEFT JOIN orders o ON o.category_id = c.id
      WHERE ${fam}
      GROUP BY c.id ORDER BY c.created_at
    `,
      params
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询大类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/categories/:id  大类详情（限本家庭）
router.get('/:id', async (req, res) => {
  try {
    const params = [req.params.id];
    params.push(req.familyScope || '00000000-0000-0000-0000-000000000000');
    const { rows } = await pool.query(
      `SELECT id, name, fields, created_at FROM categories WHERE id = $1 AND family_id = $2`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '大类不存在' });
    res.json({ code: 0, data: rows[0] });
  } catch (err) {
    console.error('查询大类详情失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/categories  新增大类 { name, fields }
router.post('/', async (req, res) => {
  try {
    const { name, fields } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '大类名称不能为空' });
    }
    const dup = await pool.query('SELECT id FROM categories WHERE name = $1 AND family_id = $2', [
      name.trim(),
      req.familyScope || '00000000-0000-0000-0000-000000000000',
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该大类名称已存在' });
    }
    const vf = validateFields(fields);
    if (!vf.ok) return res.status(400).json({ code: 400, msg: vf.msg });
    if (!req.familyScope) {
      return res.status(400).json({ code: 400, msg: '请先选择家庭' });
    }
    const { rows } = await pool.query(
      'INSERT INTO categories (name, fields, family_id) VALUES ($1, $2, $3) RETURNING id, name, fields, created_at',
      [name.trim(), JSON.stringify(vf.fields), req.familyScope]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增大类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/categories/:id  修改大类（名称 + 字段整体替换）
router.put('/:id', async (req, res) => {
  try {
    const { name, fields } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '大类名称不能为空' });
    }
    const dup = await pool.query(
      'SELECT id FROM categories WHERE name = $1 AND id <> $2 AND family_id = $3',
      [name.trim(), req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该大类名称已存在' });
    }
    const vf = validateFields(fields);
    if (!vf.ok) return res.status(400).json({ code: 400, msg: vf.msg });
    const { rows } = await pool.query(
      'UPDATE categories SET name = $1, fields = $2 WHERE id = $3 AND family_id = $4 RETURNING id, name, fields, created_at',
      [name.trim(), JSON.stringify(vf.fields), req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '大类不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改大类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/categories/:id  删除大类（级联删除其订单，限本家庭）
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM categories WHERE id = $1 AND family_id = $2',
      [req.params.id, req.familyScope || '00000000-0000-0000-0000-000000000000']
    );
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '大类不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除大类失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
