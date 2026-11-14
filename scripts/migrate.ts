/**
 * Applies supabase/migrations/*.sql in order to DATABASE_URL.
 * 002 (auth trigger + RLS) is skipped automatically on a plain Postgres
 * that has no `auth` schema. All statements are idempotent.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`select 1 from information_schema.schemata where schema_name = 'auth'`);
  const hasAuth = rows.length > 0;
  const dir = join(__dirname, '../supabase/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (f.includes('supabase') && !hasAuth) {
      console.log(`skip  ${f} (no auth schema)`);
      continue;
    }
    await c.query(readFileSync(join(dir, f), 'utf8'));
    console.log(`apply ${f}`);
  }
  await c.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
