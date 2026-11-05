import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the target database.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("select pg_advisory_lock(481630)");
  await client.query("create table if not exists qc_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())");
  const folder = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(folder)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
    const sql = await readFile(new URL(name, folder), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const previous = await client.query("select sha256 from qc_migrations where name=$1", [name]);
    if (previous.rowCount) {
      if (previous.rows[0].sha256 !== hash) throw new Error(`Migration changed after application: ${name}`);
      continue;
    }
    const body = sql.replace(/^BEGIN;\s*$/im, "").replace(/^COMMIT;\s*$/im, "");
    await client.query("begin");
    try {
      await client.query(body);
      await client.query("insert into qc_migrations(name,sha256) values($1,$2)", [name, hash]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.log(`Applied ${name}`);
  }
} finally {
  await client.end();
}
