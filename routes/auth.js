// 认证相关路由：登录（支持手机号或用户名）/ 当前用户信息
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

// 加载用户角色权限与家庭信息（登录与 /me 共用）
async function loadUserInfo(id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.phone, u.family_id, u.relation, f.name AS family_name,
            COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
            COALESCE(ARRAY_AGG(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS role_names,
            COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS perms
     FROM users u
     LEFT JOIN families f ON f.id = u.family_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.code = rp.perm_code
     WHERE u.id = $1
     GROUP BY u.id, u.name, u.phone, u.family_id, u.relation, f.name`,
    [id]
  );
  const u = rows[0];
  if (!u) return null;
  u.roles = u.roles || [];
  u.role_names = u.role_names || [];
  u.perms = u.perms || [];
  u.isSuper = u.roles.includes('super_admin');
  return u;
}

// POST /api/auth/login  { account, password }  account 可为手机号或用户名
router.post('/login', async (req, res) => {
  try {
    const { account, password } = req.body || {};
    if (!account || !password) {
      return res.status(400).json({ code: 400, msg: '账号和密码不能为空' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1 OR name = $1', [
      String(account).trim(),
    ]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ code: 401, msg: '账号或密码错误' });
    }
    const info = await loadUserInfo(user.id);
    const token = signToken(user);
    res.json({ code: 0, msg: '登录成功', data: { token, user: info } });
  } catch (err) {
    console.error('登录失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/auth/me  获取当前登录用户信息（含权限与家庭）
router.get('/me', authRequired, async (req, res) => {
  try {
    const info = await loadUserInfo(req.user.id);
    res.json({ code: 0, data: { user: info } });
  } catch (err) {
    console.error('获取用户信息失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
