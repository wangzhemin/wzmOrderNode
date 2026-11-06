// 用户管理路由（需登录）：增删改查
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired); // 本模块所有接口都需要 token

// 手机号格式校验
const PHONE_RE = /^1[3-9]\d{9}$/;

// GET /api/users?keyword=&page=1&pageSize=10  用户列表（可按姓名/手机号搜索）
router.get('/', async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const params = [];
    let where = '';
    if (keyword) {
      params.push(`%${keyword}%`);
      where = `WHERE name LIKE $${params.length} OR phone LIKE $${params.length}`;
    }
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, params);
    const total = Number(countRes.rows[0].total);
    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT id, name, phone, created_at FROM users ${where}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ code: 0, data: { list: rows, total, page, pageSize } });
  } catch (err) {
    console.error('查询用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/users  新增用户
router.post('/', async (req, res) => {
  try {
    const { name, phone, password } = req.body || {};
    if (!name || !phone || !password) {
      return res.status(400).json({ code: 400, msg: '姓名、手机号、密码不能为空' });
    }
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
    }
    if (password.length < 6) {
      return res.status(400).json({ code: 400, msg: '密码至少 6 位' });
    }
    const exist = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (exist.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该手机号已存在' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone, created_at',
      [name, phone, hash]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/users/:id  修改用户（密码可选，不传则不修改）
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, password } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ code: 400, msg: '姓名、手机号不能为空' });
    }
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
    }
    // 手机号不能和其他用户重复
    const dup = await pool.query('SELECT id FROM users WHERE phone = $1 AND id <> $2', [phone, id]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该手机号已被其他用户使用' });
    }
    let sql = 'UPDATE users SET name = $1, phone = $2';
    const params = [name, phone];
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ code: 400, msg: '密码至少 6 位' });
      }
      params.push(await bcrypt.hash(password, 10));
      sql += `, password_hash = $${params.length}`;
    }
    sql += ` WHERE id = $${params.length + 1} RETURNING id, name, phone, created_at`;
    params.push(id);
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '用户不存在' });
    }
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/users/:id  删除用户
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ code: 400, msg: '不能删除当前登录账号' });
    }
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ code: 404, msg: '用户不存在' });
    }
    res.json({ code: 0, msg: '删除成功' });
  } catch (err) {
    console.error('删除用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
