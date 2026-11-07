// JWT 认证 + RBAC 权限中间件
const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const JWT_EXPIRES_H = process.env.JWT_EXPIRES_H || '12';

// 签发 token
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone },
    JWT_SECRET,
    { expiresIn: `${JWT_EXPIRES_H}h` }
  );
}

// 校验 token：加载用户最新信息 + 角色 + 权限挂到 req.user，计算家庭数据范围 req.familyScope
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ code: 401, msg: '未登录，请先登录' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ code: 401, msg: 'token 无效或已过期，请重新登录' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.phone, u.family_id, f.name AS family_name,
              COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS perms
       FROM users u
       LEFT JOIN families f ON f.id = u.family_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.code = rp.perm_code
       WHERE u.id = $1
       GROUP BY u.id, u.name, u.phone, u.family_id, f.name`,
      [payload.id]
    );
    if (rows.length === 0) {
      return res.status(401).json({ code: 401, msg: '用户不存在，请重新登录' });
    }
    const u = rows[0];
    u.roles = u.roles || [];
    u.perms = u.perms || [];
    u.isSuper = u.roles.includes('super_admin');
    req.user = u;
    // 家庭数据范围：超管可通过 x-family-id 头切换查看任意家庭；普通用户固定本家庭
    const headerFamily = req.get('x-family-id');
    req.familyScope = u.isSuper && headerFamily ? headerFamily : u.family_id;
    // 超管未选择家庭时，默认归属「我家」，保证 admin 能直接录入/查看数据
    if (!req.familyScope) {
      const f = await pool.query(
        "SELECT id FROM families WHERE name = '我家' ORDER BY created_at LIMIT 1"
      );
      req.familyScope = f.rows.length > 0 ? f.rows[0].id : null;
    }
    next();
  } catch (err) {
    console.error('认证失败:', err.message);
    return res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
}

// 权限守卫：校验当前用户是否拥有指定权限点
function requirePerm(code) {
  return (req, res, next) => {
    if (req.user && (req.user.isSuper || req.user.perms.includes(code))) {
      return next();
    }
    return res.status(403).json({ code: 403, msg: '没有操作权限' });
  };
}

module.exports = { signToken, authRequired, requirePerm };
