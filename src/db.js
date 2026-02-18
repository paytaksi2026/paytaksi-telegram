import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: url, max: 10 });
}

export async function runMigrations(pool) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const sqlDir = path.join(__dirname, '..', 'sql');

  // Ensure app_meta exists to track version.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const res = await pool.query(`SELECT v FROM app_meta WHERE k='schema_version'`);
  const current = res.rows[0]?.v ? Number(res.rows[0].v) : 0;

  const files = fs.readdirSync(sqlDir)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();

  let applied = current;

  for (const f of files) {
    const n = Number(f.split('_')[0]);
    if (Number.isNaN(n) || n <= applied) continue;
    const sql = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO app_meta(k,v) VALUES('schema_version',$1)
                        ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [String(n)]);
      await pool.query('COMMIT');
      applied = n;
      // eslint-disable-next-line no-console
      console.log(`[db] applied migration ${f}`);
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
}
