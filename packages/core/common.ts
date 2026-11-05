import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DB } from "../db";
import type { QueryResultRow } from "pg";

export class Problem extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function guard(condition: unknown, code: string, message: string, status?: number): asserts condition {
  if (!condition) throw new Problem(code, message, status);
}
export const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const code = (prefix: string) => prefix + randomBytes(6).toString("hex").toUpperCase();
export const isDemo = () => process.env.QCW_DEMO === "1" && process.env.NODE_ENV !== "production";
export async function one<T extends QueryResultRow>(db: DB, sql: string, values: unknown[] = []): Promise<T> {
  const row = (await db.query<T>(sql, values)).rows[0];
  guard(row, "NOT_FOUND", "Record not found.", 404);
  return row;
}
export type Actor = { id: string; org: string | null; kind: "customer" | "staff"; roles: string[] };
export function organization(actor: Actor) {
  guard(actor.kind === "customer" && actor.org, "FORBIDDEN", "Customer access required.", 403);
  return actor.org;
}
export function role(actor: Actor, ...roles: string[]) {
  guard(actor.kind === "staff" && roles.some((r) => actor.roles.includes(r)), "FORBIDDEN", "This action requires staff permission.", 403);
}
export function revision(actual: number, expected: number) {
  guard(actual === expected, "VERSION_CONFLICT", "Reload the record and review the latest version.");
}
export async function lock(db: DB, key: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
}
export async function audit(db: DB, actor: Actor | null, action: string, entity: string, id: string, after: object = {}) {
  await db.query("insert into audit_events(actor_type,actor_id,action,entity_type,entity_id,after) values($1,$2,$3,$4,$5,$6)", [actor?.kind ?? "system", actor?.id ?? null, action, entity, id, after]);
}
export async function event(db: DB, type: string, payload: object) {
  await db.query("insert into outbox_events(type,payload) values($1,$2)", [type, payload]);
}
export async function idempotent<T>(db: DB, scope: string, key: string, payload: unknown, fn: () => Promise<T>): Promise<T> {
  await lock(db, scope + ":" + key);
  const digest = hash(JSON.stringify(payload));
  const prev = (await db.query("select request_hash,response from idempotency_keys where scope=$1 and key=$2", [scope,key])).rows[0];
  if (prev) {
    guard(prev.request_hash === digest,"IDEMPOTENCY_CONFLICT","This key was used for a different request.");
    return prev.response;
  }
  const result = await fn();
  await db.query("insert into idempotency_keys(scope,key,request_hash,response) values($1,$2,$3,$4)", [scope,key,digest,JSON.stringify(result)]);
  return result;
}
export { randomUUID as uuid };
