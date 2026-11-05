import { pool, transaction } from "../db";
import { publishReport } from "./inspection";
import { executeRefund } from "./payments";
import { consumeTrackingCallback, subscribeTrackingOnce, syncTrackingOnce } from "./logistics";

const businessEvents=["account.registered","report.render","refund.approved","package.received","order.ready","order.cancelled","dispatch.quoted","quote.offered","shipment.handed_over","shipment.return_received","payment.confirmed","report.published"];
export async function workOnce() {
  let jobId:string|undefined;
  try {
    const worked=await transaction(async db=>{
      const j=(await db.query(`select * from outbox_events where processed_at is null and next_attempt_at<=now() and attempts<10
        and type=any($1::text[]) order by id limit 1 for update skip locked`,[businessEvents])).rows[0];
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
          (select org_id from charge_items where id=$5),$6::uuid)`,[j.payload.order_id??null,j.payload.package_id??null,
          j.payload.batch_id??null,j.payload.shipment_id??null,j.payload.charge_id??null,j.payload.org_id??null])).rows[0];
        if(recipient) await db.query(`insert into notifications(user_id,order_id,template,locale,payload,dedupe_key)
          values($1,$2,$3,'en',$4,$5) on conflict do nothing`,[recipient.user_id,j.payload.order_id??null,j.type,j.payload,"outbox:"+j.id]);
      }
      await db.query("update outbox_events set processed_at=now(),last_error=null where id=$1",[j.id]);
      return true;
    });
    if(worked) return true;
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
  return subscribed||synced;
}
