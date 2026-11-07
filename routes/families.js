// 家庭管理路由（需登录）
// 列表：超管看全部，其他人只看本家庭；新增/修改/删除/设家庭主：仅超管（families.manage 权限）
const express = require('express');
const pool = require('../db');
const { authRequired, requirePerm } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 家庭字段（地址 + 经纬度）
const FAMILY_FIELDS = ['name', 'province', 'city', 'district', 'street', 'community', 'house_no'];

// 从 body 提取家庭字段
function pickFields(body) {
  const vals = {};
  for (const k of FAMILY_FIELDS) {
    vals[k] = String(body[k] == null ? '' : body[k]).trim();
  }
  const lng = parseFloat(body.lng);
  const lat = parseFloat(body.lat);
  vals.lng = isNaN(lng) ? null : lng;
  vals.lat = isNaN(lat) ? null : lat;
  return vals;
}

// GET /api/families  家庭列表（超管全部 + 成员数/户主；其他人仅本家庭）
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (!req.user.isSuper) {
      params.push(req.user.family_id || '00000000-0000-0000-0000-000000000000');
      where = `WHERE f.id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT f.*,
              (SELECT COUNT(*)::int FROM users u WHERE u.family_id = f.id) AS member_count,
              (SELECT u.name FROM users u
               JOIN user_roles ur ON ur.user_id = u.id
               JOIN roles r ON r.id = ur.role_id
               WHERE u.family_id = f.id AND r.code = 'family_head' LIMIT 1) AS head_name
       FROM families f ${where} ORDER BY f.created_at DESC`,
      params
    );
    res.json({ code: 0, data: { list: rows } });
  } catch (err) {
    console.error('查询家庭失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/families  新增家庭（仅超管）
router.post('/', requirePerm('families.manage'), async (req, res) => {
  try {
    const vals = pickFields(req.body || {});
    if (!vals.name) {
      return res.status(400).json({ code: 400, msg: '家庭名称不能为空' });
    }
    const dup = await pool.query('SELECT id FROM families WHERE name = $1', [vals.name]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该家庭名称已存在' });
    }
    const { rows } = await pool.query(
      `INSERT INTO families (name, province, city, district, street, community, house_no, lng, lat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [vals.name, vals.province, vals.city, vals.district, vals.street, vals.community, vals.house_no, vals.lng, vals.lat]
    );
    // 每个家庭独立维护「账号」字典：新建家庭时自动创建空字典，账号由家庭主自行维护
    await pool.query(
      "INSERT INTO dict_types (name, family_id) VALUES ('账号', $1) ON CONFLICT DO NOTHING",
      [rows[0].id]
    );
    res.json({ code: 0, msg: '新增成功', data: rows[0] });
  } catch (err) {
    console.error('新增家庭失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// PUT /api/families/:id  修改家庭（仅超管）
router.put('/:id', requirePerm('families.manage'), async (req, res) => {
  try {
    const vals = pickFields(req.body || {});
    if (!vals.name) {
      return res.status(400).json({ code: 400, msg: '家庭名称不能为空' });
    }
    const dup = await pool.query('SELECT id FROM families WHERE name = $1 AND id <> $2', [
      vals.name,
      req.params.id,
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 409, msg: '该家庭名称已存在' });
    }
    const { rows } = await pool.query(
      `UPDATE families SET name = $1, province = $2, city = $3, district = $4, street = $5,
              community = $6, house_no = $7, lng = $8, lat = $9
       WHERE id = $10 RETURNING *`,
      [vals.name, vals.province, vals.city, vals.district, vals.street, vals.community, vals.house_no, vals.lng, vals.lat, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, msg: '家庭不存在' });
    res.json({ code: 0, msg: '修改成功', data: rows[0] });
  } catch (err) {
    console.error('修改家庭失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// DELETE /api/families/:id  删除家庭（级联删除其业务数据，仅超管）
router.delete('/:id', requirePerm('families.manage'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM families WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ code: 404, msg: '家庭不存在' });
    res.json({ code: 0, msg: '删除成功（该家庭下业务数据已一并删除）' });
  } catch (err) {
    console.error('删除家庭失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/families/:id/set-head  设置家庭主（仅超管，一个家庭只有一个）
// { user_id }  该用户必须属于该家庭
router.post('/:id/set-head', requirePerm('families.manage'), async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ code: 400, msg: '请选择要设为家庭主的用户' });
    const famRes = await pool.query('SELECT id, name FROM families WHERE id = $1', [req.params.id]);
    if (famRes.rows.length === 0) return res.status(404).json({ code: 404, msg: '家庭不存在' });
    const userRes = await pool.query('SELECT id, name, family_id FROM users WHERE id = $1', [user_id]);
    if (userRes.rows.length === 0) return res.status(404).json({ code: 404, msg: '用户不存在' });
    const user = userRes.rows[0];
    if (user.family_id !== req.params.id) {
      return res.status(400).json({ code: 400, msg: '该用户不属于此家庭，请先调整其所属家庭' });
    }
    const roleRes = await pool.query("SELECT id FROM roles WHERE code = 'family_head'");
    if (roleRes.rows.length === 0) {
      return res.status(500).json({ code: 500, msg: '系统缺少家庭主角色' });
    }
    const headRoleId = roleRes.rows[0].id;
    // 换主：移除该家庭现任家庭主的角色，再授予新主
    await pool.query(
      `DELETE FROM user_roles ur
       USING users u
       WHERE ur.user_id = u.id AND ur.role_id = $1 AND u.family_id = $2`,
      [headRoleId, req.params.id]
    );
    await pool.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user_id, headRoleId]
    );
    res.json({ code: 0, msg: `已将 ${user.name} 设为「${famRes.rows[0].name}」的家庭主` });
  } catch (err) {
    console.error('设置家庭主失败:', err.message);
    res.status(500).json({ code: 500, msg: '服务器内部错误' });
  }
});

module.exports = router;
