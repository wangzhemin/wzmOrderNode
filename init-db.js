// 初始化数据库：建表 + 种子数据（管理员账号、默认大类）
// 用法: npm run init-db
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

// 图中订单的默认字段（奶粉 / 美妆等大类共用）
const DEFAULT_FIELDS = [
  { key: 'shop', label: '店铺名', type: 'text' },
  { key: 'account', label: '购买账号', type: 'text' },
  { key: 'product_name', label: '商品名', type: 'text' },
  { key: 'category_name', label: '商品种类', type: 'recycle' },
  { key: 'quantity', label: '数量', type: 'number' },
  { key: 'prebuy_date', label: '预买日期', type: 'date' },
  { key: 'order_no', label: '订单编号', type: 'text' },
  { key: 'recharge_ref', label: '使用充值金', type: 'recharge' },
  { key: 'recharge_gold', label: '充值金', type: 'number' },
  { key: 'recharge_card', label: '充值卡', type: 'number' },
  { key: 'recharge_full', label: '充值金额全款', type: 'number' },
  { key: 'recycle_amount', label: '回收金额', type: 'number' },
  { key: 'order_cost', label: '订单成本', type: 'number' },
  { key: 'latest_cost', label: '最近成本', type: 'number' },
  { key: 'est_profit', label: '预计利润', type: 'number' },
];

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

  // 迁移：现有大类字段升级
  // 1) category_name 改为 recycle 类型（联动回收商品）
  // 2) 注入 recharge_ref（使用充值金）、recycle_amount（回收金额）字段
  const cats = await pool.query('SELECT id, fields FROM categories');
  for (const c of cats.rows) {
    let fields = (c.fields || []).filter((f) => f.key !== 'received');
    fields = fields.map((f) => (f.key === 'category_name' ? { ...f, type: 'recycle' } : f));
    if (!fields.some((f) => f.key === 'recharge_ref')) {
      const idx = fields.findIndex((f) => f.key === 'recharge_gold');
      fields.splice(idx >= 0 ? idx : fields.length, 0, {
        key: 'recharge_ref',
        label: '使用充值金',
        type: 'recharge',
      });
    }
    if (!fields.some((f) => f.key === 'recycle_amount')) {
      const idx = fields.findIndex((f) => f.key === 'order_cost');
      fields.splice(idx >= 0 ? idx : fields.length, 0, {
        key: 'recycle_amount',
        label: '回收金额',
        type: 'number',
      });
    }
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
