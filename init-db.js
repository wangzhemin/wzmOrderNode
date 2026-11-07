// 初始化数据库：建表 + 种子数据（管理员账号、默认大类）
// 用法: npm run init-db
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

// 订单默认字段（与用户 Excel 列一致：账号 店铺名 商品种类 数量 购买日期 订单编号 充值金 订单金额 订单成本 返利 最终成本 回收 最终利润）
const DEFAULT_FIELDS = [
  { key: 'account', label: '账号', type: 'text' },
  { key: 'shop', label: '店铺名', type: 'text' },
  { key: 'category_name', label: '商品种类', type: 'recycle' },
  { key: 'quantity', label: '数量', type: 'number' },
  { key: 'prebuy_date', label: '购买日期', type: 'date' },
  { key: 'order_no', label: '订单编号', type: 'text' },
  { key: 'recharge_full', label: '订单金额', type: 'number' },
  { key: 'order_cost', label: '订单成本', type: 'number' },
  { key: 'rebate', label: '返利', type: 'number' },
  { key: 'latest_cost', label: '最终成本', type: 'number' },
  { key: 'recycle_amount', label: '回收', type: 'number' },
  { key: 'est_profit', label: '最终利润', type: 'number' },
];

// 字段标准 meta（key → label/type），迁移时按此统一标签
const FIELD_META = Object.fromEntries(DEFAULT_FIELDS.map((f) => [f.key, f]));
// 字段标准顺序（Excel 列顺序；充值金/充值卡已合并为 recharge_gold）
const FIELD_ORDER = DEFAULT_FIELDS.map((f) => f.key);

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'init.sql'), 'utf8');
  await pool.query(sql);
  console.log('✅ 数据表已就绪');

  // 种子管理员
  const phone = '13800000001';
  const exist = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (exist.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query('INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3)', [
      '管理员',
      phone,
      hash,
    ]);
    console.log(`✅ 已创建管理员账号: ${phone} / admin123`);
  } else {
    console.log('ℹ️ 管理员账号已存在，跳过');
  }

  // 迁移：移除旧的「是否收到」动态字段（已由内置状态 pending/received/shipped 替代）
  await pool.query(`
    UPDATE categories SET fields = (
      SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
      FROM jsonb_array_elements(fields) f
      WHERE f->>'key' <> 'received'
    )
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(fields) f WHERE f->>'key' = 'received')
  `);

  // 迁移：充值卡并入充值金（两列本是一个东西，统一叫充值金）
  await pool.query(`
    UPDATE orders SET data = jsonb_set(data, '{recharge_gold}', data->'recharge_card')
    WHERE (data->>'recharge_gold' IS NULL OR data->>'recharge_gold' = '')
      AND COALESCE(data->>'recharge_card', '') <> ''
  `);
  await pool.query(`UPDATE orders SET data = data - 'recharge_card' WHERE data ? 'recharge_card'`);
  // 商品名字段移除（订单已关联商品种类）
  await pool.query(`UPDATE orders SET data = data - 'product_name' WHERE data ? 'product_name'`);
  // 充值金/关联充值金从订单中移除（充值金管理模块独立记账，不再与订单关联）
  await pool.query(
    `UPDATE orders SET data = data - 'recharge_gold' - 'recharge_ref' - 'recharge_used'
     WHERE data ?| array['recharge_gold','recharge_ref','recharge_used']`
  );

  // 迁移：现有大类字段统一为 Excel 列顺序与标签（自定义的额外字段保留在末尾）
  const cats = await pool.query('SELECT id, fields FROM categories');
  for (const c of cats.rows) {
    const old = new Map(
      (c.fields || [])
        .filter(
          (f) =>
            !['received', 'recharge_card', 'product_name', 'recharge_gold', 'recharge_ref'].includes(f.key)
        )
        .map((f) => [f.key, f])
    );
    const fields = [];
    for (const key of FIELD_ORDER) {
      fields.push({ ...FIELD_META[key] });
      old.delete(key);
    }
    // 用户自定义的额外字段放在末尾
    for (const f of old.values()) fields.push(f);
    await pool.query('UPDATE categories SET fields = $1 WHERE id = $2', [
      JSON.stringify(fields),
      c.id,
    ]);
  }
  console.log('✅ 大类字段迁移完成');

  // ============================================================
  // 家庭 + RBAC 种子与存量数据归属
  // ============================================================

  // 权限点定义（code → 名称/模块）
  const PERMS = [
    ['families.manage', '家庭管理', '家庭'],
    ['users.manage', '用户管理', '用户'],
    ['orders.view', '订单查看', '订单'],
    ['orders.manage', '订单管理', '订单'],
    ['shipments.view', '出货查看', '出货'],
    ['shipments.manage', '出货管理', '出货'],
    ['recharges.view', '充值金查看', '充值金'],
    ['recharges.manage', '充值金管理', '充值金'],
    ['recycle.view', '回收商品查看', '回收'],
    ['recycle.manage', '回收商品管理', '回收'],
    ['categories.view', '大类查看', '大类'],
    ['categories.manage', '大类管理', '大类'],
    ['dicts.view', '字典查看', '字典'],
    ['dicts.manage', '字典管理', '字典'],
    ['dashboard.view', '数据看板', '看板'],
    ['logs.view', '操作日志', '日志'],
  ];
  for (const [code, name, module] of PERMS) {
    await pool.query(
      'INSERT INTO permissions (code, name, module) VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, module = EXCLUDED.module',
      [code, name, module]
    );
  }
  console.log(`✅ 权限点就绪（${PERMS.length} 个）`);

  // 系统角色
  const ROLE_DEFS = [
    ['super_admin', '超级管理员'],
    ['family_head', '家庭主'],
    ['family_member', '家庭成员'],
  ];
  for (const [code, name] of ROLE_DEFS) {
    await pool.query(
      'INSERT INTO roles (code, name, is_system) VALUES ($1, $2, true) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name',
      [code, name]
    );
  }
  const roleRows = await pool.query('SELECT id, code FROM roles');
  const roleId = Object.fromEntries(roleRows.rows.map((r) => [r.code, r.id]));

  // 角色-权限（家庭主 = 全部业务权限；成员 = 查看+录单发货）
  const HEAD_PERMS = PERMS.map((p) => p[0]).filter((c) => c !== 'families.manage');
  const MEMBER_PERMS = [
    'orders.view', 'orders.manage', 'shipments.view', 'shipments.manage',
    'recharges.view', 'recycle.view', 'categories.view', 'dashboard.view',
  ];
  const ROLE_PERMS = {
    super_admin: PERMS.map((p) => p[0]),
    family_head: HEAD_PERMS,
    family_member: MEMBER_PERMS,
  };
  for (const [code, perms] of Object.entries(ROLE_PERMS)) {
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId[code]]);
    for (const p of perms) {
      await pool.query('INSERT INTO role_permissions (role_id, perm_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        roleId[code],
        p,
      ]);
    }
  }
  console.log('✅ 角色与权限绑定完成');

  // 种子家庭：我家（存量数据全部归入）
  let fam = await pool.query('SELECT id FROM families WHERE name = $1', ['我家']);
  if (fam.rows.length === 0) {
    fam = await pool.query(
      `INSERT INTO families (name, province, city, district, street, community, house_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      ['我家', '浙江省', '杭州市', '临平区', '星桥街道', '月映星语园', '7-404']
    );
    console.log('✅ 已创建默认家庭: 我家（浙江省杭州市临平区星桥街道月映星语园 7-404）');
  }
  const myHomeId = fam.rows[0].id;

  // 存量业务数据归入「我家」
  for (const table of ['categories', 'orders', 'shipments', 'recharges', 'recycle_items', 'dict_types']) {
    const r = await pool.query(`UPDATE ${table} SET family_id = $1 WHERE family_id IS NULL`, [myHomeId]);
    if (r.rowCount > 0) console.log(`  · ${table} 归入我家 ${r.rowCount} 行`);
  }

  // 种子超级管理员 admin（有且只有一个）
  const superExist = await pool.query(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id WHERE r.code = 'super_admin'`
  );
  if (superExist.rows.length === 0) {
    const dup = await pool.query('SELECT id FROM users WHERE phone = $1', ['13800000000']);
    let superId;
    if (dup.rows.length > 0) {
      superId = dup.rows[0].id;
    } else {
      const hash = await bcrypt.hash('Codvision@wzm', 10);
      const ins = await pool.query(
        "INSERT INTO users (name, phone, password_hash) VALUES ('admin', '13800000000', $1) RETURNING id",
        [hash]
      );
      superId = ins.rows[0].id;
    }
    await pool.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [superId, roleId.super_admin]
    );
    console.log('✅ 已创建超级管理员: admin / Codvision@wzm（手机号 13800000000）');
  } else {
    console.log('ℹ️ 超级管理员已存在，跳过');
  }

  // 原管理员账号 → 我家家庭主；其余无角色用户 → 我家成员
  await pool.query('UPDATE users SET family_id = $1 WHERE family_id IS NULL', [myHomeId]);
  const oldAdmin = await pool.query('SELECT id FROM users WHERE phone = $1', ['13800000001']);
  if (oldAdmin.rows.length > 0) {
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      oldAdmin.rows[0].id,
      roleId.family_head,
    ]);
  }
  const noRole = await pool.query(
    `SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`
  );
  for (const u of noRole.rows) {
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      u.id,
      roleId.family_member,
    ]);
  }
  console.log('✅ 用户家庭与角色分配完成');

  // 种子全局字典：家庭关系（与户主的关系，新增家庭成员时选择）
  const RELATIONS = [
    '妻子', '丈夫', '儿子', '女儿', '爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆',
    '哥哥', '姐姐', '弟弟', '妹妹', '叔叔', '婶婶', '舅舅', '舅妈', '姑姑', '姑父',
    '侄子', '侄女', '外甥', '外甥女', '其他',
  ];
  let relType = await pool.query('SELECT id FROM dict_types WHERE name = $1 AND family_id IS NULL', ['家庭关系']);
  if (relType.rows.length === 0) {
    relType = await pool.query(
      "INSERT INTO dict_types (name, family_id) VALUES ('家庭关系', NULL) RETURNING id"
    );
    console.log('✅ 已创建全局字典种类: 家庭关系');
  }
  for (let i = 0; i < RELATIONS.length; i++) {
    const dup = await pool.query(
      'SELECT id FROM dict_items WHERE type_id = $1 AND k = $2',
      [relType.rows[0].id, RELATIONS[i]]
    );
    if (dup.rows.length === 0) {
      await pool.query('INSERT INTO dict_items (type_id, k, v, sort) VALUES ($1, $2, $2, $3)', [
        relType.rows[0].id,
        RELATIONS[i],
        i,
      ]);
    }
  }
  console.log(`✅ 家庭关系字典就绪（${RELATIONS.length} 项）`);

  // 种子字典：账号（按家庭隔离，新增订单时从字典里选）
  const dictName = '账号';
  let dictType = await pool.query('SELECT id FROM dict_types WHERE name = $1 AND family_id = $2', [
    dictName,
    myHomeId,
  ]);
  if (dictType.rows.length === 0) {
    dictType = await pool.query('INSERT INTO dict_types (name, family_id) VALUES ($1, $2) RETURNING id', [
      dictName,
      myHomeId,
    ]);
    console.log(`✅ 已创建字典种类: ${dictName}（我家）`);
  }
  const dictTypeId = dictType.rows[0].id;
  // 种子值 = 现有订单里出现过的账号（新库没有订单时为空，账号在字典管理里自行维护）
  const orderAccounts = await pool.query(
    `SELECT DISTINCT o.data->>'account' AS name FROM orders o
     WHERE o.family_id = $1 AND o.data->>'account' IS NOT NULL AND o.data->>'account' <> ''`,
    [myHomeId]
  );
  for (const r of orderAccounts.rows) {
    await pool.query(
      'INSERT INTO dict_items (type_id, k, v) SELECT $1, $2, $2 WHERE NOT EXISTS (SELECT 1 FROM dict_items WHERE type_id = $1 AND k = $2)',
      [dictTypeId, r.name]
    );
  }
  console.log(`✅ 账号字典就绪（${orderAccounts.rows.length} 个账号来自现有订单）`);

  // 种子大类：奶粉、美妆（字段默认同图中订单列）
  for (const name of ['奶粉', '美妆']) {
    const existCat = await pool.query('SELECT id FROM categories WHERE name = $1', [name]);
    if (existCat.rows.length === 0) {
      await pool.query('INSERT INTO categories (name, fields) VALUES ($1, $2)', [
        name,
        JSON.stringify(DEFAULT_FIELDS),
      ]);
      console.log(`✅ 已创建默认大类: ${name}（${DEFAULT_FIELDS.length} 个字段）`);
    } else {
      console.log(`ℹ️ 大类「${name}」已存在，跳过`);
    }
  }
}

main()
  .catch((err) => {
    console.error('❌ 初始化失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
