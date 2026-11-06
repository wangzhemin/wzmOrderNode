// 认证相关路由：登录
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login  { phone, password }
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) {
      return res.status(400).json({ code: 400, msg: '手机号和密码不能为空' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ code: 401, msg: '手机号或密码错误' });
    }
    const token = signToken(user);
    res.json({ code: 0, msg: '登录成功', data: { token, user: { id: user.id, name: user.name, phone: user.phone } } });
  } catch (err) {
    console.error('登录失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// GET /api/auth/me  获取当前登录用户信息
router.get('/me', require('../middleware/auth').authRequired, async (req, res) => {
  res.json({ code: 0, data: { user: req.user } });
});

module.exports = router;
