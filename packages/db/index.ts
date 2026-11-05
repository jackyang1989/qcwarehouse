import { Pool, type PoolClient } from "pg";

const globals = globalThis as typeof globalThis & { qcwPool?: Pool };
export const pool = globals.qcwPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
export type DB = PoolClient;
export async function transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
