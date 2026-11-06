// 测试 Supabase PostgreSQL 连接
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 需要 SSL
});

async function main() {
  console.log('正在连接 Supabase 数据库...');
  const timeRes = await pool.query('SELECT NOW() AS now, CURRENT_DATABASE() AS db, VERSION() AS version');
  const { now, db, version } = timeRes.rows[0];
  console.log('✅ 连接成功！');
  console.log(`   数据库: ${db}`);
  console.log(`   服务器时间: ${now}`);
  console.log(`   版本: ${version.split(',')[0]}`);

  // 测试建表 + 插入 + 查询 + 删表（验证读写权限）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _conn_test (
      id serial PRIMARY KEY,
      note text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  const insertRes = await pool.query(
    'INSERT INTO _conn_test (note) VALUES ($1) RETURNING id, note',
    ['连接测试 ' + new Date().toISOString()]
  );
  console.log(`✅ 写入测试成功 (id=${insertRes.rows[0].id})`);

  const listRes = await pool.query('SELECT COUNT(*) AS cnt FROM _conn_test');
  console.log(`✅ 查询测试成功 (_conn_test 共 ${listRes.rows[0].cnt} 条)`);

  await pool.query('DROP TABLE _conn_test');
  console.log('✅ 已清理测试表');

  console.log('\n全部测试通过，数据库可用。');
}

main()
  .catch((err) => {
    console.error('❌ 连接失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
