// 用户管理路由（需登录）：家庭范围内的用户增删改查
// 超级管理员：管理所有用户，可指定家庭与角色
// 家庭主：只能新增/维护本家庭成员（固定 family_member 角色，必填与户主关系）
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired); // 本模块所有接口都需要 token

// 手机号格式校验
const PHONE_RE = /^1[3-9]\d{9}$/;

// 用户列表 SELECT（含家庭名、角色名）
const USER_SELECT = `
  SELECT u.id, u.name, u.phone, u.family_id, u.relation, u.created_at,
         f.name AS family_name,
         COALESCE(ARRAY_AGG(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS role_names,
         COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
  FROM users u
  LEFT JOIN families f ON f.id = u.family_id
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id
`;

// 判断目标用户是否超级管理员
async function isSuperUser(userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.code = 'super_admin'`,
    [userId]
  );
  return rows.length > 0;
}

// GET /api/users?keyword=&page=1&pageSize=10  用户列表（超管看全部，其他人看本家庭）
router.get('/', async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const where = [];
    const params = [];
    if (!req.user.isSuper) {
      params.push(req.user.family_id || '00000000-0000-0000-0000-000000000000');
      where.push(`u.family_id = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      where.push(`(u.name LIKE $${params.length} OR u.phone LIKE $${params.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    const total = Number(countRes.rows[0].total);
    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `${USER_SELECT} ${whereSql}
       GROUP BY u.id, u.name, u.phone, u.family_id, u.relation, u.created_at, f.name
       ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ code: 0, data: { list: rows, total, page, pageSize } });
  } catch (err) {
    console.error('查询用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/users  新增用户
// 超管：{ name, phone, password, family_id, role_code, relation? }
// 家庭主：{ name, phone, password, relation }（固定本家庭 + family_member）
router.post('/', async (req, res) => {
  try {
    const { name, phone, password, family_id, role_code, relation } = req.body || {};
    if (!name || !phone || !password) {
      return res.status(400).json({ code: 400, msg: '姓名、手机号、密码不能为空' });
    }
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
    }
    if (password.length < 6) {
      return res.status(400).json({ code: 400, msg: '密码至少 6 位' });
    }
    // 确定家庭与角色
    let targetFamily = null;
    let targetRole = 'family_member';
    if (req.user.isSuper) {
      if (!family_id) return res.status(400).json({ code: 400, msg: '请选择所属家庭' });
      const f = await pool.query('SELECT id FROM families WHERE id = $1', [family_id]);
      if (f.rows.length === 0) return res.status(404).json({ code: 404, msg: '家庭不存在' });
      targetFamily = family_id;
      if (role_code && ['family_head', 'family_member'].includes(role_code)) {
        targetRole = role_code;
      }
    } else {
      if (!req.user.family_id) {
        return res.status(403).json({ code: 403, msg: '您不属于任何家庭，无法新增成员' });
      }
      targetFamily = req.user.family_id;
      targetRole = 'family_member';
      if (!relation || !String(relation).trim()) {
        return res.status(400).json({ code: 400, msg: '请选择与户主的关系' });
      }
    }
    const exist = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (exist.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该手机号已存在' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, phone, password_hash, family_id, relation) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, phone, created_at',
      [name, phone, hash, targetFamily, String(relation || '').trim()]
    );
    const user = rows[0];
    // 绑定角色
    const role = await pool.query('SELECT id FROM roles WHERE code = $1', [targetRole]);
    if (role.rows.length > 0) {
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
        user.id,
        role.rows[0].id,
      ]);
    }
    res.json({ code: 0, msg: '新增成功', data: user });
  } catch (err) {
    console.error('新增用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/users/:id  修改用户（密码可选；超管可改家庭/角色/关系）
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, password, family_id, role_code, relation } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ code: 400, msg: '姓名、手机号不能为空' });
    }
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
    }
    // 越权检查：非超管只能改本家庭用户，且不能改超管
    if (!req.user.isSuper) {
      const target = await pool.query('SELECT family_id FROM users WHERE id = $1', [id]);
      if (target.rows.length === 0) return res.status(404).json({ code: 404, msg: '用户不存在' });
      if (target.rows[0].family_id !== req.user.family_id) {
        return res.status(403).json({ code: 403, msg: '只能修改本家庭成员' });
      }
      if (await isSuperUser(id)) {
        return res.status(403).json({ code: 403, msg: '不能修改超级管理员' });
      }
    }
    // 手机号不能和其他用户重复
    const dup = await pool.query('SELECT id FROM users WHERE phone = $1 AND id <> $2', [phone, id]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该手机号已被其他用户使用' });
    }
    let sql = 'UPDATE users SET name = $1, phone = $2, relation = $3';
    const params = [name, phone, String(relation || '').trim()];
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ code: 400, msg: '密码至少 6 位' });
      }
      params.push(await bcrypt.hash(password, 10));
      sql += `, password_hash = $${params.length}`;
    }
    // 超管可调整家庭
    if (req.user.isSuper && family_id) {
      const f = await pool.query('SELECT id FROM families WHERE id = $1', [family_id]);
      if (f.rows.length === 0) return res.status(404).json({ code: 404, msg: '家庭不存在' });
      params.push(family_id);
      sql += `, family_id = $${params.length}`;
    }
    sql += ` WHERE id = $${params.length + 1} RETURNING id, name, phone, family_id, relation, created_at`;
    params.push(id);
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '用户不存在' });
    }
    // 超管可调整角色（家庭主/成员）
    if (req.user.isSuper && role_code && ['family_head', 'family_member'].includes(role_code)) {
      const oldRole = await pool.query(
        `DELETE FROM user_roles ur WHERE ur.user_id = $1
         AND ur.role_id IN (SELECT id FROM roles WHERE code IN ('family_head','family_member'))`,
        [id]
      );
      const role = await pool.query('SELECT id FROM roles WHERE code = $1', [role_code]);
      if (role.rows.length > 0) {
        await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          id,
          role.rows[0].id,
        ]);
      }
    }
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改用户失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/users/:id  删除用户（非超管仅能删本家庭成员，不能删超管）
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ code: 400, msg: '不能删除当前登录账号' });
    }
    if (!req.user.isSuper) {
      const target = await pool.query('SELECT family_id FROM users WHERE id = $1', [id]);
      if (target.rows.length === 0) return res.status(404).json({ code: 404, msg: '用户不存在' });
      if (target.rows[0].family_id !== req.user.family_id) {
        return res.status(403).json({ code: 403, msg: '只能删除本家庭成员' });
      }
      if (await isSuperUser(id)) {
        return res.status(403).json({ code: 403, msg: '不能删除超级管理员' });
      }
    } else if (await isSuperUser(id)) {
      return res.status(400).json({ code: 400, msg: '不能删除超级管理员' });
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
