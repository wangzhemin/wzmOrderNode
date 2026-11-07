// 回收商品管理路由（需登录）：种类 + 回收单价 增删改查
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 带大类名称的查询
const SELECT_SQL = `
  SELECT ri.id, ri.name, ri.price, ri.category_id, c.name AS category_name, ri.color, ri.created_at
  FROM recycle_items ri
  LEFT JOIN categories c ON c.id = ri.category_id
`;

// 校验颜色格式：#rgb 或 #rrggbb，可为空
function normalizeColor(color) {
  const c = String(color || '').trim().toLowerCase();
  if (!c) return '';
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) {
    throw new Error('颜色格式不正确');
  }
  return c;
}

// 家庭过滤参数（无家庭范围时用零值 uuid，查不到任何数据）
const fam = (req) => req.familyScope || '00000000-0000-0000-0000-000000000000';

// 校验大类 id：为空返回 null，否则必须存在且属于本家庭
async function checkCategory(req, client, categoryId) {
  if (!categoryId) return null;
  const { rows } = await client.query('SELECT id FROM categories WHERE id = $1 AND family_id = $2', [
    categoryId,
    fam(req),
  ]);
  if (rows.length === 0) {
    throw new Error('所属大类不存在');
  }
  return categoryId;
}

// GET /api/recycle-items
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_SQL} WHERE ri.family_id = $1 ORDER BY ri.created_at DESC`, [
      fam(req),
    ]);
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/recycle-items  { name, price, category_id?, color? }
router.post('/', async (req, res) => {
  try {
    const { name, price, category_id, color } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '种类名称不能为空' });
    }
    const p = parseFloat(price);
    if (isNaN(p) || p < 0) {
      return res.status(400).json({ code: 400, msg: '回收金额不正确' });
    }
    const c = normalizeColor(color);
    await checkCategory(req, pool, category_id);
    const dup = await pool.query('SELECT id FROM recycle_items WHERE name = $1 AND family_id = $2', [
      name.trim(),
      fam(req),
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该种类已存在' });
    }
    if (!req.familyScope) {
      return res.status(400).json({ code: 400, msg: '请先选择家庭' });
    }
    await pool.query(
      'INSERT INTO recycle_items (name, price, category_id, color, family_id) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), p, category_id || null, c, req.familyScope]
    );
    const { rows } = await pool.query(`${SELECT_SQL} WHERE ri.name = $1 AND ri.family_id = $2`, [
      name.trim(),
      fam(req),
    ]);
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    if (err.message === '所属大类不存在' || err.message === '颜色格式不正确') {
      return res.status(400).json({ code: 400, msg: err.message });
    }
    console.error('新增回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/recycle-items/:id  { name, price, category_id?, color? }
router.put('/:id', async (req, res) => {
  try {
    const { name, price, category_id, color } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, msg: '种类名称不能为空' });
    }
    const p = parseFloat(price);
    if (isNaN(p) || p < 0) {
      return res.status(400).json({ code: 400, msg: '回收金额不正确' });
    }
    const c = normalizeColor(color);
    await checkCategory(req, pool, category_id);
    const dup = await pool.query(
      'SELECT id FROM recycle_items WHERE name = $1 AND id <> $2 AND family_id = $3',
      [name.trim(), req.params.id, fam(req)]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该种类已存在' });
    }
    const { rowCount } = await pool.query(
      'UPDATE recycle_items SET name = $1, price = $2, category_id = $3, color = $4 WHERE id = $5 AND family_id = $6',
      [name.trim(), p, category_id || null, c, req.params.id, fam(req)]
    );
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '回收商品不存在' });
    const { rows } = await pool.query(`${SELECT_SQL} WHERE ri.id = $1 AND ri.family_id = $2`, [
      req.params.id,
      fam(req),
    ]);
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    if (err.message === '所属大类不存在' || err.message === '颜色格式不正确') {
      return res.status(400).json({ code: 400, msg: err.message });
    }
    console.error('修改回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/recycle-items/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM recycle_items WHERE id = $1 AND family_id = $2',
      [req.params.id, fam(req)]
    );
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '回收商品不存在' });
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除回收商品失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
