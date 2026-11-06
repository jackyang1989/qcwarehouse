import { z } from "zod";
import type { DB } from "../db";
import { currentTerms } from "./auth";
import { audit, event, guard, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { validCarrier, waybill } from "./intake";
import { requireSpace } from "./storage";

type Destination={recipient:string;phone:string;address:string;member_code?:string};
type InstructionInput={action:string;item_id?:string;destination?:Destination;return_info?:object;terms_version_id:string};
export async function instruct(db:DB,actor:Actor,itemId:string,input:InstructionInput,orderId?:string) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const w=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,org]);
  guard(["stored","received"].includes(w.custody_state) && !w.parent_item_id && w.identity_state!=="quarantined",
    "ITEM_UNAVAILABLE","This item cannot be released.");
  const order=(await db.query(`select o.id,o.state from orders o join order_lines l on l.order_id=o.id
    join order_line_item_links a on a.order_line_id=l.id where a.item_id=$1 and a.unlinked_at is null`,[itemId])).rows[0];
  guard(!orderId || order?.id===orderId,"NOT_FOUND","Item is not in this order.",404);
  guard(!order || ["report_ready","action_pending","cancelled","closed"].includes(order.state),
    "ITEM_IN_INSPECTION","Resolve the active inspection before requesting shipment.");
  guard(!(await db.query(`select 1 from reference_reservations rr join reference_samples r on r.id=rr.reference_id
    where r.item_id=$1 and rr.released_at is null`,[itemId])).rowCount,"ITEM_RESERVED","An inspection still needs this reference sample.");
  const terms=await currentTerms(db,["terms"]);
  guard(terms[0]?.id===input.terms_version_id,"TERMS_CHANGED","Review the current terms.");
  if(input.action==="return_to_seller") {
    const info=z.object({requested_from_seller:z.literal(true),customer_pays_shipping:z.literal(true),deadline:z.iso.datetime().optional()}).parse(input.return_info);
    guard(!info.deadline || new Date(info.deadline)>new Date(),"RETURN_EXPIRED","The seller's return deadline has passed.");
  }
  const out=await one(db,`insert into disposition_requests(org_id,item_id,action,destination,return_info,authorization_snapshot,state,created_by)
    values($1,$2,$3,$4,$5,jsonb_build_object('terms_version_id',$6::uuid,'authorized_at',now()),'requested',$7)
    returning id,item_id,state,revision`,[org,itemId,input.action,input.destination??null,input.return_info??null,input.terms_version_id,actor.id]);
  await audit(db,actor,"authorize_disposition","disposition_requests",out.id);
  return out;
}
export async function planBatch(db:DB,actor:Actor,ids:string[]) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const rows=(await db.query("select * from disposition_requests where id=any($1::uuid[]) and org_id=$2 and state='requested' order by id for update",[ids,org])).rows;
  guard(rows.length===ids.length && ids.length>0 && ids.length<=100,"DISPOSITION_UNAVAILABLE","Some instructions cannot be combined.");
  const first=rows[0];
  const dest=(d:Destination)=>[d.recipient,d.phone,d.address,d.member_code??""].join("\n");
  guard(first.destination && rows.every(r=>r.destination && r.action===first.action && dest(r.destination)===dest(first.destination)) &&
    (first.action!=="return_to_seller" || ids.length===1),"BATCH_MISMATCH","Use matching shipping instructions. Seller returns are separate.");
  const b=await one<{id:string;revision:number}>(db,`insert into dispatch_batches(org_id,destination_snapshot,action,revision,state) values($1,$2,$3,1,'draft') returning id,revision`,[org,first.destination,first.action]);
  for(const r of rows) await db.query("insert into dispatch_batch_items(batch_id,item_id,disposition_id,org_id) values($1,$2,$3,$4)",[b.id,r.item_id,r.id,org]);
  await audit(db,actor,"plan_dispatch","dispatch_batches",b.id);
  return {batch_id:b.id,revision:b.revision};
}
async function lockBatch(db:DB,id:string) {
  const first=await one(db,"select org_id from dispatch_batches where id=$1",[id]);
  await lock(db,"org:"+first.org_id);
  return one(db,"select * from dispatch_batches where id=$1 for update",[id]);
}
export async function confirmBatch(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const b=await one(db,"select * from dispatch_batches where id=$1 and org_id=$2 for update",[id,org]);
  revision(b.revision,rev);guard(b.state==="draft","BATCH_UNAVAILABLE","The batch was already confirmed.");
  await db.query("update dispatch_batches set state='confirmed',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"confirm_dispatch","dispatch_batches",id);
  return {batch_id:id,revision:rev+1};
}
const rateSchema=z.object({first_weight_g:z.number().int().positive(),first_cents:z.number().int().positive(),
  extra_step_g:z.number().int().positive(),extra_cents:z.number().int().nonnegative(),handling_cents:z.number().int().nonnegative()});
export type ParcelPlan={item_ids:string[];weight_g:number};
function sameItems(a:string[],b:string[]) {
  return a.length===b.length && new Set(a).size===a.length && a.every(x=>b.includes(x));
}
export async function quoteBatch(db:DB,actor:Actor,id:string,rev:number,rateId:string,parcels:ParcelPlan[]) {
  role(actor,"warehouse_admin");
  const b=await lockBatch(db,id);
  revision(b.revision,rev);
  const expired=b.state==="quoted"&&(await one(db,`select accepted_at is null and expires_at<=now() renewable
    from dispatch_quote_versions where batch_id=$1 order by revision desc limit 1`,[id])).renewable;
  guard(b.state==="confirmed"||expired,"BATCH_UNAVAILABLE","Quote a confirmed batch or replace an expired, unaccepted quote.");
  const items=(await db.query("select item_id from dispatch_batch_items where batch_id=$1 and released_at is null",[id])).rows.map(r=>r.item_id);
  guard(parcels.length<=50 && sameItems(parcels.flatMap(p=>p.item_ids),items),"PACK_MISMATCH","The quote must cover the exact authorized items.");
  const rate=await one(db,"select * from shipping_rate_versions where id=$1 and effective_at<=now()",[rateId]);
  const r=rateSchema.parse(rate.rules);
  const planned=parcels.map(p=>({...p,amount_cents:r.first_cents+Math.ceil(Math.max(0,p.weight_g-r.first_weight_g)/r.extra_step_g)*r.extra_cents}));
  const total=r.handling_cents+planned.reduce((n,p)=>n+p.amount_cents,0);
  const q=await one(db,`insert into dispatch_quote_versions(batch_id,revision,rate_version_id,snapshot,amount_cents,expires_at)
    values($1,$2,$3,$4,$5,now()+interval '72 hours') returning id as quote_id,revision,amount_cents`,[id,rev+1,rateId,{parcels:planned,handling_cents:r.handling_cents,destination:b.destination_snapshot},total]);
  await db.query("update dispatch_batches set state='quoted',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"quote_batch","dispatch_batches",id);
  await event(db,"dispatch.quoted",{batch_id:id,quote_id:q.quote_id});
  return q;
}
export async function acceptQuote(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);await lock(db,"org:"+org);
  const q=(await db.query(`select q.*,q.expires_at>now() valid,b.state batch_state
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id where q.id=$1 and b.org_id=$2 for update of q,b`,[id,org])).rows[0];
  if(!q) {
    const storage=await one(db,`select q.*,q.expires_at>now() valid,d.state,d.org_id from storage_quotes q join disposition_requests d
      on d.id=q.disposition_id where q.id=$1 and d.org_id=$2 for update of q,d`,[id,org]);
    revision(storage.revision,rev);
    guard(storage.valid && !storage.accepted_at && storage.state==="requested","QUOTE_EXPIRED","Review the current quote.");
    await db.query("update storage_quotes set accepted_at=now() where id=$1",[id]);
    return one(db,`insert into charge_items(org_id,purpose,storage_quote_id,amount_cents,currency,snapshot) values($1,'storage',$2,$3,'USD',$4)
      returning id as charge_item_id,amount_cents,currency`,[org,id,storage.amount_cents,storage.snapshot]);
  }
  revision(q.revision,rev);
  guard(q.valid && !q.accepted_at && q.batch_state==="quoted","QUOTE_EXPIRED","Review the current quote.");
  await db.query("update dispatch_quote_versions set accepted_at=now() where id=$1",[id]);
  const charge=await one(db,`insert into charge_items(org_id,purpose,dispatch_quote_id,amount_cents,currency,snapshot) values($1,'dispatch',$2,$3,'USD',$4)
    returning id as charge_item_id,amount_cents,currency`,[org,id,q.amount_cents,q.snapshot]);
  const allocations=(await db.query(`select l.order_id,count(*)::int n from dispatch_batch_items bi
    left join order_line_item_links a on a.item_id=bi.item_id and a.unlinked_at is null left join order_lines l on l.id=a.order_line_id
    where bi.batch_id=$1 and bi.released_at is null group by l.order_id`,[q.batch_id])).rows as {order_id:string|null;n:number}[];
  const size=allocations.reduce((n,a)=>n+a.n,0);
  const parts=allocations.map(a=>({...a,cents:Math.floor(q.amount_cents*a.n/size),remainder:q.amount_cents*a.n%size}))
    .sort((a,b)=>b.remainder-a.remainder || (a.order_id??"").localeCompare(b.order_id??""));
  const remain=q.amount_cents-parts.reduce((n,a)=>n+a.cents,0);
  for(const [i,a] of parts.entries()) if(a.order_id) await db.query("insert into charge_allocations values($1,$2,$3)",[charge.charge_item_id,a.order_id,a.cents+Number(i<remain)]);
  await audit(db,actor,"accept_dispatch_quote","dispatch_quote_versions",id);
  return charge;
}
export async function storageQuote(db:DB,actor:Actor,id:string) {
  role(actor,"warehouse_admin");
  const d=await one(db,"select * from disposition_requests where id=$1 and action='retain' and state='requested' for update",[id]);
  const price=await one<{value:unknown}>(db,"select value from app_config where key='storage.daily_cents'");
  const amount=z.number().int().positive().parse(price.value)*30;
  const q=await one(db,`insert into storage_quotes(disposition_id,revision,snapshot,amount_cents,expires_at)
    values($1,1,$2,$3,now()+interval '72 hours') returning id as quote_id,revision,amount_cents`,[id,{days:30},amount]);
  await audit(db,actor,"quote_storage","disposition_requests",id);
  return q;
}
export const effectiveDispatchCharge=`c.voided_at is null and (c.free_authorization is not null or exists(select 1 from payments p
    where p.id=c.applied_payment_id and p.state='succeeded' and not exists(select 1 from payment_disputes d where d.payment_id=p.id)
    and not exists(select 1 from refunds r where r.payment_id=p.id and r.state in ('approved','succeeded'))))`;
async function paidBatch(db:DB,b:{id:string}) {
  return one(db,`select q.*,c.id charge_id from dispatch_quote_versions q join charge_items c on c.dispatch_quote_id=q.id
    where q.batch_id=$1 and ${effectiveDispatchCharge}
    order by q.revision desc limit 1`,[b.id]);
}
async function shipEvidence(db:DB,actor:Actor,shipmentId:string,org:string,ids:string[]) {
  for(const id of [...new Set(ids)].sort()) {
    const m=await one(db,`select id,org_id,shipment_id from media_assets where id=$1 and uploaded_by=$2 and kind='dispatch' and status='ready' for update`,[id,actor.id]);
    guard((!m.shipment_id || m.shipment_id===shipmentId)&&(!m.org_id||m.org_id===org),"EVIDENCE_MISMATCH","Photo is attached to a different shipment.");
    await db.query("update media_assets set org_id=$2,shipment_id=$3 where id=$1",[id,org,shipmentId]);
  }
}
export async function packShipment(db:DB,actor:Actor,id:string,input:{revision:number;quote_id:string;item_ids:string[];weight_g:number;packed_media_ids:string[]}) {
  role(actor,"warehouse_admin");
  const b=await lockBatch(db,id);revision(b.revision,input.revision);
  guard(b.state==="paid","BATCH_UNAVAILABLE","Confirm payment before packing.");
  const q=await paidBatch(db,b as {id:string});
  guard(q.id===input.quote_id && q.snapshot.parcels.some((p:ParcelPlan)=>sameItems(p.item_ids,input.item_ids) && p.weight_g===input.weight_g),
    "PACK_MISMATCH","Match the quoted parcel contents and weight.");
  const sh=await one<{id:string;revision:number}>(db,`insert into shipments(batch_id,weight_g,state,packed_media_ids) values($1,$2,'packed',$3) returning id,revision`,[id,input.weight_g,input.packed_media_ids]);
  await shipEvidence(db,actor,sh.id,b.org_id,input.packed_media_ids);
  for(const item of input.item_ids) {
    await one(db,"select id from warehouse_items where id=$1 and org_id=$2 and custody_state in ('received','stored') for update",[item,b.org_id]);
    await db.query("insert into shipment_items(shipment_id,batch_id,item_id) values($1,$2,$3)",[sh.id,id,item]);
  }
  await audit(db,actor,"pack_shipment","shipments",sh.id);
  return {shipment_id:sh.id,revision:sh.revision};
}
export async function handover(db:DB,actor:Actor,id:string,input:{revision:number;item_ids:string[];carrier_code:string;tracking_no:string;evidence_ids:string[];handed_at:string}) {
  role(actor,"warehouse_admin");
  const found=await one(db,"select batch_id from shipments where id=$1",[id]);
  const b=await lockBatch(db,found.batch_id);
  const sh=await one(db,"select * from shipments where id=$1 for update",[id]);
  revision(sh.revision,input.revision);
  guard(sh.state==="packed" && b.state==="paid","SHIPMENT_UNAVAILABLE","This shipment has already been handed over or is blocked.");
  await paidBatch(db,b as {id:string});
  const list=(await db.query(`select si.item_id,w.custody_state,bi.disposition_id,d.return_info
    from shipment_items si join warehouse_items w on w.id=si.item_id
    join dispatch_batch_items bi on bi.batch_id=si.batch_id and bi.item_id=si.item_id and bi.released_at is null
    join disposition_requests d on d.id=bi.disposition_id where si.shipment_id=$1 and d.state='requested' for update of w,d`,[id])).rows;
  guard(sameItems(input.item_ids,list.map(r=>r.item_id)) && list.every(r=>["received","stored"].includes(r.custody_state) &&
    (!r.return_info?.deadline || new Date(r.return_info.deadline)>new Date())),"PACK_MISMATCH","Verify the authorized items and deadline.");
  const blocked=(await db.query(`select 1 from order_line_item_links a join order_lines l on l.id=a.order_line_id join orders o on o.id=l.order_id
    where a.item_id=any($1::uuid[]) and a.unlinked_at is null and (o.state='on_hold' or
    exists(select 1 from order_blocks ob where ob.order_id=o.id and ob.resolved_at is null)
    or exists(select 1 from inspection_quotes iq join charge_items c on c.inspection_quote_id=iq.id
      join payments p on p.charge_item_id=c.id join payment_disputes d on d.payment_id=p.id where iq.order_id=o.id))`,[input.item_ids])).rowCount;
  guard(!blocked,"SHIPMENT_BLOCKED","A linked inspection or payment has an active block.");
  const carrier=await validCarrier(db,input.carrier_code),tracking=waybill(input.tracking_no);
  await lock(db,"waybill:"+tracking);
  guard(!(await db.query("select 1 from tracking_records where carrier_code=$1 and tracking_norm=$2 and closed_at is null",[carrier,tracking])).rowCount,
    "TRACKING_REVIEW_REQUIRED","The tracking number is already in use.");
  await shipEvidence(db,actor,id,b.org_id,input.evidence_ids);
  const handed=new Date(input.handed_at);
  guard(handed<=new Date(Date.now()+300000),"HANDOVER_TIME_INVALID","Handover time cannot be in the future.",422);
  await db.query("update shipments set state='shipped',shipped_at=$2,handed_by=$3,carrier_code=$4,tracking_norm=$5,revision=revision+1 where id=$1",[id,handed,actor.id,carrier,tracking]);
  for(const item of list) {
    await db.query("update warehouse_items set custody_state='outbound',location_id=null,revision=revision+1 where id=$1",[item.item_id]);
    await db.query("update disposition_requests set state='completed',revision=revision+1 where id=$1",[item.disposition_id]);
    await db.query("update dispatch_batch_items set released_at=now() where batch_id=$1 and item_id=$2",[b.id,item.item_id]);
    await db.query("insert into storage_events(item_id,action,operator_id) values($1,'handover',$2)",[item.item_id,actor.id]);
  }
  if(!(await db.query("select 1 from dispatch_batch_items where batch_id=$1 and released_at is null",[b.id])).rowCount)
    await db.query("update dispatch_batches set state='completed',revision=revision+1 where id=$1",[b.id]);
  const dir=b.action==="return_to_seller"?"outbound_return":b.action==="to_forwarder"?"outbound_forward":"outbound_domestic";
  const t=await one<{id:string}>(db,`insert into tracking_records(org_id,direction,shipment_id,carrier_code,tracking_norm,generation,transport_state,sync_state,next_query_at,batch_id)
    values($1,$2,$3,$4,$5,1,'unknown','pending',now(),$6) returning id`,[b.org_id,dir,id,carrier,tracking,b.id]);
  await audit(db,actor,"handover","shipments",id,{tracking_id:t.id});
  await event(db,"shipment.handed_over",{shipment_id:id,tracking_id:t.id});
  return {shipment_id:id,tracking_id:t.id,state:"shipped"};
}
export async function receiveReturn(db:DB,actor:Actor,id:string,input:{revision:number;item_ids:string[];evidence_ids:string[];location_id:string;received_at:string}) {
  role(actor,"warehouse_admin");
  const first=await one(db,"select batch_id from shipments where id=$1",[id]);
  const b=await lockBatch(db,first.batch_id);
  const sh=await one(db,"select * from shipments where id=$1 for update",[id]);
  guard(["shipped","delivered","returned"].includes(sh.state),"SHIPMENT_UNAVAILABLE","Only handed-over shipments can be received back.");
  const members=(await db.query(`select si.item_id,w.custody_state,r.received_at from shipment_items si join warehouse_items w on w.id=si.item_id
    left join shipment_return_items r on r.shipment_id=si.shipment_id and r.item_id=si.item_id where si.shipment_id=$1 for update of w`,[id])).rows;
  guard(input.item_ids.every(i=>members.some(m=>m.item_id===i)),"PACK_MISMATCH","Only items in the original parcel can be returned.");
  const fresh=members.filter(m=>input.item_ids.includes(m.item_id) && !m.received_at);
  if(fresh.length) {
    revision(sh.revision,input.revision);
    guard(fresh.every(r=>r.custody_state==="outbound"),"ITEM_UNAVAILABLE","An item already has a different custody record.");
    await requireSpace(db,input.location_id,fresh.length);
    await shipEvidence(db,actor,id,b.org_id,input.evidence_ids);
    for(const item of fresh) {
      await db.query("insert into shipment_return_items values($1,$2,$3,$4,$5,$6)",[id,item.item_id,input.received_at,actor.id,input.location_id,input.evidence_ids]);
      await db.query("update warehouse_items set custody_state='stored',location_id=$2,revision=revision+1 where id=$1",[item.item_id,input.location_id]);
      await db.query("insert into storage_events(item_id,to_location_id,action,operator_id) values($1,$2,'receive_return',$3)",[item.item_id,input.location_id,actor.id]);
    }
    await audit(db,actor,"receive_return","shipments",id,{count:fresh.length});
    await event(db,"shipment.return_received",{shipment_id:id,item_ids:fresh.map(m=>m.item_id)});
  }
  const all=members.filter(m=>m.received_at || fresh.includes(m)).map(m=>m.item_id);
  const done=all.length===members.length;
  if(fresh.length) await db.query("update shipments set revision=revision+1,state=case when $2 then 'returned' else state end,returned_at=case when $2 then now() else returned_at end where id=$1",[id,done]);
  return {shipment_id:id,revision:sh.revision+Number(fresh.length>0),received_item_ids:all,return_status:done?"complete":"partial"};
}
