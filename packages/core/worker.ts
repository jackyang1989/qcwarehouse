import { pool, transaction } from "../db";
import { publishReport } from "./inspection";
import { executeRefund } from "./payments";
import { consumeTrackingCallback, subscribeTrackingOnce, syncTrackingOnce } from "./logistics";
import { consumeEmailWebhook, deliverEmailOnce, queueNotificationEmail } from "./email";
import { cleanupStaleMediaUploads } from "./media";
import { audit, guard, one, role, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import type { DB } from "../db";

const businessEvents=["account.registered","report.render","refund.approved","package.received","order.ready","order.identity_mismatch","order.cancelled","dispatch.quoted","quote.offered","shipment.handed_over","shipment.return_received","payment.confirmed","report.published","report.amended","ticket.reply","tracking.exception_opened"];
const maxJobAttempts=10;

function eventDedupeKey(j:{id:string;type:string;payload:Record<string,unknown>}):string {
  if(typeof j.payload?.dedupe_key==="string" && j.payload.dedupe_key.trim()) return j.payload.dedupe_key.trim();
  switch(j.type) {
    case "package.received":
      return j.payload?.package_id?`package.received:${j.payload.package_id}`:`outbox:${j.id}`;
    case "order.ready":
      return j.payload?.order_id?`order.ready:${j.payload.order_id}`:`outbox:${j.id}`;
    case "order.identity_mismatch":
      return j.payload?.order_id&&j.payload?.expected_item_id
        ?`order.identity_mismatch:${j.payload.order_id}:${j.payload.expected_item_id}`
        :`outbox:${j.id}`;
    case "order.cancelled":
      return j.payload?.order_id?`order.cancelled:${j.payload.order_id}`:`outbox:${j.id}`;
    case "payment.confirmed":
      return j.payload?.charge_id?`payment.confirmed:${j.payload.charge_id}`:`outbox:${j.id}`;
    case "report.published":
      return j.payload?.order_id?`report.published:${j.payload.order_id}:${j.payload.version??1}`:`outbox:${j.id}`;
    case "report.amended":
      return j.payload?.order_id&&j.payload?.version?`report.amended:${j.payload.order_id}:${j.payload.version}`:`outbox:${j.id}`;
    case "shipment.handed_over":
      return j.payload?.shipment_id?`shipment.handed_over:${j.payload.shipment_id}`:`outbox:${j.id}`;
    case "tracking.exception_opened":
      return j.payload?.tracker_id
        ?`tracking.exception_opened:${j.payload.tracker_id}:${j.payload.kind??"exception"}:${j.payload.episode??1}`
        :`outbox:${j.id}`;
    default:
      return `outbox:${j.id}`;
  }
}
export async function failedJobs(db:DB,actor:Actor) {
  role(actor,"super_admin");
  const {rows}=await db.query(`select j.id,j.type,j.attempts,j.last_error,j.next_attempt_at,j.created_at,
    (select o.public_no from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
      where v.id::text=j.payload->>'version_id' and j.type='report.render') order_number
    from outbox_events j where j.processed_at is null and j.attempts>0 and j.type=any($1::text[])
    order by j.attempts>=$2 desc,j.next_attempt_at,j.id limit 100`,[businessEvents,maxJobAttempts]);
  return {rows,max_attempts:maxJobAttempts};
}
export async function retryFailedJob(db:DB,actor:Actor,id:string,attempts:number,reason:string,sessionHash:string) {
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash);
  const job=await one(db,"select * from outbox_events where id=$1 for update",[id]);
  guard(!job.processed_at&&job.attempts>0&&businessEvents.includes(job.type),"JOB_NOT_RETRYABLE","This job is already processed, pending, or requires a separate recovery procedure.");
  guard(job.attempts===attempts,"VERSION_CONFLICT","Reload the job queue and review the current failure.");
  await db.query("update outbox_events set attempts=0,last_error=null,next_attempt_at=now() where id=$1",[id]);
  await audit(db,actor,"retry_outbox","outbox_events",null,{job_id:id,type:job.type,previous_attempts:attempts,
    previous_error:job.last_error,reason});
  return {id,state:"pending"};
}
export async function workOnce() {
  let jobId:string|undefined;
  try {
    const worked=await transaction(async db=>{
      const j=(await db.query(`select * from outbox_events where processed_at is null and next_attempt_at<=now() and attempts<$2
        and type=any($1::text[]) order by id limit 1 for update skip locked`,[businessEvents,maxJobAttempts])).rows[0];
      if(!j) return false;
      jobId=j.id;
      if(j.type==="report.render") await publishReport(db,j.payload.version_id);
      else if(j.type==="refund.approved") await executeRefund(db,j.payload.refund_id);
      else {
        if(j.type==="account.registered" && j.payload.warehouse_address_status==="pending") {
          await db.query(`insert into notifications(user_id,template,locale,payload,dedupe_key)
            select u.id,'warehouse.address_required','zh-CN','{}'::jsonb,'missing-warehouse-address:'||u.id::text
            from users u join staff_roles s on s.user_id=u.id and s.role='super_admin'
            where u.status='active' and not exists(select 1 from warehouse_addresses where is_default and active)
            on conflict(dedupe_key) do update set read_at=null,created_at=now()`);
        }
        const recipient=(await db.query(`select p.user_id from customer_receiving_profiles p where org_id=coalesce(
          (select org_id from orders where id=$1),(select org_id from packages where id=$2),
          (select org_id from dispatch_batches where id=$3),(select b.org_id from shipments s join dispatch_batches b on b.id=s.batch_id where s.id=$4),
          (select org_id from charge_items where id=$5),(select org_id from tracking_records where id=$6),$7::uuid)`,[j.payload.order_id??null,j.payload.package_id??null,
          j.payload.batch_id??null,j.payload.shipment_id??null,j.payload.charge_id??null,j.payload.tracker_id??null,j.payload.org_id??null])).rows[0];
        if(recipient) {
          const dedupeKey=eventDedupeKey(j);
          const inserted=(await db.query<{id:string}>(`insert into notifications(user_id,order_id,template,locale,payload,dedupe_key)
            values($1,$2,$3,'en',$4,$5) on conflict do nothing returning id`,[recipient.user_id,j.payload.order_id??null,j.type,j.payload,dedupeKey])).rows[0];
          if(inserted) await queueNotificationEmail(db,inserted.id,recipient.user_id);
        }
      }
      await db.query("update outbox_events set processed_at=now(),last_error=null where id=$1",[j.id]);
      return true;
    });
    if(worked) return true;
    if(await deliverEmailOnce()) return true;
    if(await transaction(consumeEmailWebhook)) return true;
    return await transaction(consumeTrackingCallback);
  } catch (error) {
    if(jobId) await pool.query(`update outbox_events set attempts=attempts+1,last_error=$2,
      next_attempt_at=now()+make_interval(secs=>least(900,10*(attempts+1))) where id=$1 and processed_at is null`,
      [jobId,error instanceof Error && "code" in error?String(error.code):"JOB_FAILED"]);
    throw error;
  }
}
export async function trackingTick() {
  const subscribed=await subscribeTrackingOnce();
  const synced=await syncTrackingOnce();
  const cleaned=(await transaction(cleanupStaleMediaUploads)).cleaned>0;
  return subscribed||synced||cleaned;
}
