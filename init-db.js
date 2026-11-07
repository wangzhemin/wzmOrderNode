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
