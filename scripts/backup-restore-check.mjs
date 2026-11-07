#!/usr/bin/env node
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/qcwarehouse";

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const countsRes = await client.query(`
      select
        (select count(*)::int from users) users_count,
        (select count(*)::int from orders) orders_count,
        (select count(*)::int from warehouse_items) items_count,
        (select count(*)::int from payments) payments_count,
        (select count(*)::int from report_versions where state='published') published_reports_count,
        (select count(*)::int from audit_events) audit_events_count,
        (select count(*)::int from outbox_events where processed_at is null and attempts>0) failed_jobs_count
    `);
    const triggersRes = await client.query(`
      select tgname from pg_trigger
      where not tgisinternal
        and tgname in ('immutable_audit','immutable_logistics','freeze_report','freeze_template','freeze_inspection_quote')
      order by tgname
    `);
    const runsRes = await client.query(`
      select id, restored_to, started_at, finished_at, reconciliation
      from recovery_runs
      order by started_at desc
      limit 5
    `);
    const triggers = triggersRes.rows.map((r) => r.tgname);
    const healthy = triggers.length >= 5;
    const summary = {
      checked_at: new Date().toISOString(),
      healthy,
      counts: countsRes.rows[0],
      immutable_triggers: triggers,
      recent_recovery_runs: runsRes.rows,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!healthy) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Backup/restore check failed:", err);
  process.exit(1);
});
