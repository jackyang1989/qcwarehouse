import { z } from "zod";
import { pool, type DB } from "../db";
import { currentTerms, requireCustomerActive } from "./auth";
import { audit, code, event, guard, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { validCarrier, waybill } from "./intake";
import { requireSpace } from "./storage";

type Destination={recipient:string;phone:string;address:string;member_code?:string};
type InstructionInput={action:string;item_id?:string;destination?:Destination;return_info?:Record<string,unknown>;terms_version_id:string;condition_note?:string;days?:number};
export async function instruct(db:DB,actor:Actor,itemId:string,input:InstructionInput,orderId?:string) {
  await requireCustomerActive(db,actor);
  const org=organization(actor);
  await lock(db,"org:"+org);
  const w=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,org]);
  guard(["stored","received"].includes(w.custody_state) && !w.parent_item_id && w.identity_state!=="quarantined",
    "ITEM_UNAVAILABLE","This item cannot be released.");
  const order=(await db.query(`select o.id,o.state,l.category_id from orders o join order_lines l on l.order_id=o.id
    join order_line_item_links a on a.order_line_id=l.id where a.item_id=$1 and a.unlinked_at is null`,[itemId])).rows[0];
  guard(!orderId || order?.id===orderId,"NOT_FOUND","Item is not in this order.",404);
  guard(!order || ["report_ready","action_pending","cancelled","closed"].includes(order.state),
    "ITEM_IN_INSPECTION","Resolve the active inspection before requesting shipment.");
  const activeLock=(await db.query<{id:string}>(`select r.id from reference_reservations rr join reference_samples r on r.id=rr.reference_id
    where r.item_id=$1 and rr.released_at is null`,[itemId])).rows[0];
  if(activeLock) {
    await pool.query(`update reference_samples set authorization_snapshot=authorization_snapshot||jsonb_build_object('outbound_conflict_at',now(),'requested_action',$2::text) where id=$1`,[activeLock.id,input.action]);
    await audit(pool,actor,"reference_outbound_conflict","reference_samples",activeLock.id,{code:"ITEM_RESERVED",reason:"Outbound instruction requested while reference sample is in use."});
    guard(false,"ITEM_RESERVED","An inspection still needs this reference sample.");
  }
  const terms=await currentTerms(db,["terms"]);
  guard(terms[0]?.id===input.terms_version_id,"TERMS_CHANGED","Review the current terms.");
  guard(!(await db.query("select 1 from disposition_requests where item_id=$1 and state not in ('completed','cancelled')",[itemId])).rowCount,
    "ITEM_RESERVED","Resolve the active handling instruction before submitting a new one.");
  if(input.action==="reserve_reference") {
    await db.query("update reference_samples set state='expired' where item_id=$1 and state='active' and expires_at<=now()",[itemId]);
    guard(!(await db.query("select 1 from reference_samples where item_id=$1 and state='active' and expires_at>now()",[itemId])).rowCount,
      "REFERENCE_ALREADY_ACTIVE","This item is already an active reference sample.");
    await db.query("update warehouse_items set custody_state='stored',revision=revision+1 where id=$1 and custody_state='received'",[itemId]);
    const out=await one(db,`insert into disposition_requests(org_id,item_id,action,destination,return_info,authorization_snapshot,state,created_by)
      values($1,$2,'reserve_reference',null,null,jsonb_build_object('terms_version_id',$3::uuid,'authorized_at',now()),'completed',$4)
      returning id,item_id,state,revision`,[org,itemId,input.terms_version_id,actor.id]);
    const nextRev=await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from reference_samples where item_id=$1",[itemId]);
    const ref=await one<{id:string}>(db,`insert into reference_samples(id,item_id,org_id,revision,authorization_snapshot,condition_note,expires_at,state)
      values($1,$2,$3,$4,$5,$6,now()+interval '90 days','active') returning id`,[
      uuid(),itemId,org,nextRev.n,
      {terms_version_id:input.terms_version_id,authorized_by:actor.id,authorized_at:new Date().toISOString(),disposition_id:out.id,...(order?.category_id?{category_id:order.category_id}:{})},
      input.condition_note??null,
    ]);
    await audit(db,actor,"authorize_disposition","disposition_requests",out.id);
    await audit(db,actor,"reserve_reference","reference_samples",ref.id,{version:nextRev.n});
    return out;
  }
  if(["to_forwarder","to_domestic_address","return_to_seller"].includes(input.action)) {
    guard(!(await db.query("select 1 from reference_samples where item_id=$1 and state='active' and expires_at>now()",[itemId])).rowCount,
      "REFERENCE_RELEASE_REQUIRED","Release the active reference sample authorization before shipping this item.");
    guard(
      Boolean(input.destination?.recipient?.trim() && input.destination?.phone?.trim() && input.destination?.address?.trim()),
      "DESTINATION_INCOMPLETE","Provide the recipient, phone number, and full shipping address.",422
    );
    if(input.action==="to_forwarder") {
      guard(Boolean(input.destination?.member_code?.trim()),"DESTINATION_INCOMPLETE","Provide your freight forwarder warehouse member/inbound code.",422);
    }
  }
  let storedReturnInfo:Record<string,unknown>|null=input.return_info??null;
  if(input.action==="return_to_seller") {
    const info=z.object({requested_from_seller:z.literal(true),customer_pays_shipping:z.literal(true),deadline:z.iso.datetime().optional()}).parse(input.return_info);
    guard(!info.deadline || new Date(info.deadline)>new Date(),"RETURN_EXPIRED","The seller's return deadline has passed.");
    storedReturnInfo=info;
  } else if(input.action==="retain") {
    const days=input.days ?? (typeof input.return_info?.days==="number"?Number(input.return_info.days):30);
    guard(Number.isInteger(days) && days>=1 && days<=365,"INVALID_STORAGE_DAYS","Choose a valid storage extension period.",422);
    storedReturnInfo={...(input.return_info??{}),days};
  }
  const out=await one(db,`insert into disposition_requests(org_id,item_id,action,destination,return_info,authorization_snapshot,state,created_by)
    values($1,$2,$3,$4,$5,jsonb_build_object('terms_version_id',$6::uuid,'authorized_at',now()),'requested',$7)
    returning id,item_id,state,revision`,[org,itemId,input.action,input.destination??null,storedReturnInfo,input.terms_version_id,actor.id]);
  await audit(db,actor,"authorize_disposition","disposition_requests",out.id);
  return out;
}

export async function cancelDisposition(db:DB,actor:Actor,id:string,input:{revision?:number;reason?:string}) {
  await requireCustomerActive(db,actor);
  const org=organization(actor);
  await lock(db,"org:"+org);
  const d=await one(db,"select * from disposition_requests where id=$1 and org_id=$2 for update",[id,org]);
  if(input.revision!==undefined) revision(d.revision,input.revision);
  guard(d.state==="requested","DISPOSITION_UNAVAILABLE","Only active requested instructions can be cancelled.");
  const batchLink=(await db.query<{batch_id:string;state:string}>(
    `select b.id batch_id,b.state from dispatch_batch_items bi join dispatch_batches b on b.id=bi.batch_id
     where bi.disposition_id=$1 and bi.released_at is null for update of b`,
    [id]
  )).rows[0];
  if(batchLink) {
    guard(batchLink.state==="draft","BATCH_LOCKED","This instruction is locked in an active dispatch batch; amend the batch instead.");
    await db.query("update dispatch_batch_items set released_at=now() where batch_id=$1 and disposition_id=$2",[batchLink.batch_id,id]);
    if(!(await db.query("select 1 from dispatch_batch_items where batch_id=$1 and released_at is null",[batchLink.batch_id])).rowCount) {
      await db.query("update dispatch_batches set state='cancelled',revision=revision+1 where id=$1",[batchLink.batch_id]);
    }
  }
  await db.query("update storage_quotes set expires_at=least(expires_at,now()) where disposition_id=$1 and accepted_at is null",[id]);
  await db.query(
    `update charge_items c set voided_at=now() from storage_quotes sq
     where c.storage_quote_id=sq.id and sq.disposition_id=$1 and c.applied_payment_id is null and c.voided_at is null`,
    [id]
  );
  await db.query("update disposition_requests set state='cancelled',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"cancel_disposition","disposition_requests",id,{reason:input.reason?.trim()||null});
  return {id,state:"cancelled",revision:d.revision+1};
}
export async function releaseReferenceSample(db:DB,actor:Actor,referenceId:string,input:{terms_version_id:string;reason?:string}) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const r=await one(db,"select * from reference_samples where id=$1 and org_id=$2",[referenceId,org]);
  guard(r.state==="active","REFERENCE_UNAVAILABLE","This reference sample is already released or retired.");
  const activeLock=(await db.query("select 1 from reference_reservations where reference_id=$1 and released_at is null",[referenceId])).rowCount;
  if(activeLock) {
    await pool.query(`update reference_samples set authorization_snapshot=authorization_snapshot||jsonb_build_object('outbound_conflict_at',now(),'requested_action','release') where id=$1`,[referenceId]);
    await audit(pool,actor,"reference_outbound_conflict","reference_samples",referenceId,{code:"ITEM_RESERVED",reason:"Release requested while reference sample is in use."});
    guard(false,"ITEM_RESERVED","An inspection still needs this reference sample.");
  }
  await one(db,"select id from reference_samples where id=$1 and org_id=$2 for update",[referenceId,org]);
  const terms=await currentTerms(db,["terms"]);
  guard(terms[0]?.id===input.terms_version_id,"TERMS_CHANGED","Review the current terms.");
  const updated=await one(db,`update reference_samples set state='released',
    authorization_snapshot=(authorization_snapshot - 'outbound_conflict_at')||jsonb_build_object(
      'released_at',now(),'released_by',$2::uuid,'release_terms_version_id',$3::uuid,'release_reason',$4::text
    ) where id=$1 returning id as reference_id,item_id,state,revision,expires_at`,
    [referenceId,actor.id,input.terms_version_id,input.reason?.trim()||null]);
  await audit(db,actor,"release_reference","reference_samples",referenceId,{version:updated.revision,reason:input.reason?.trim()||"Customer release"});
  return updated;
}
export async function planBatch(db:DB,actor:Actor,ids:string[]) {
  await requireCustomerActive(db,actor);
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
  await requireCustomerActive(db,actor);
  const org=organization(actor);
  await lock(db,"org:"+org);
  const b=await one(db,"select * from dispatch_batches where id=$1 and org_id=$2 for update",[id,org]);
  revision(b.revision,rev);guard(b.state==="draft","BATCH_UNAVAILABLE","The batch was already confirmed.");
  await db.query("update dispatch_batches set state='confirmed',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"confirm_dispatch","dispatch_batches",id);
  return {batch_id:id,revision:rev+1};
}
const rateSchema=z.object({
  first_weight_g:z.number().int().positive(),
  first_cents:z.number().int().positive(),
  extra_step_g:z.number().int().positive(),
  extra_cents:z.number().int().nonnegative(),
  handling_cents:z.number().int().nonnegative(),
  zones:z.record(z.string(),z.object({
    first_weight_g:z.number().int().positive(),
    first_cents:z.number().int().positive(),
    extra_step_g:z.number().int().positive(),
    extra_cents:z.number().int().nonnegative(),
  })).optional(),
});
export type ParcelPlan={item_ids:string[];weight_g:number;manual_amount_cents?:number;manual_reason?:string};
function sameItems(a:string[],b:string[]) {
  return a.length===b.length && new Set(a).size===a.length && a.every(x=>b.includes(x));
}
export async function publishShippingRate(
  db:DB,
  actor:Actor,
  input:z.infer<typeof rateSchema>
) {
  role(actor,"super_admin");
  const rules=rateSchema.parse(input);
  await lock(db,"shipping_rates");
  const nextVer=await one<{n:number}>(db,"select coalesce(max(version),0)::int+1 n from shipping_rate_versions");
  const row=await one(db,
    `insert into shipping_rate_versions(id,version,rules,effective_at,published_by)
     values($1,$2,$3,now(),$4)
     returning id,version,rules,effective_at`,
    [uuid(),nextVer.n,rules,actor.id]
  );
  await audit(db,actor,"publish_shipping_rate","shipping_rate_versions",row.id,{version:row.version});
  return row;
}
export async function calculateShippingPreview(
  db:DB,
  actor:Actor,
  input:{rate_version_id?:string;zone?:string;parcels:{weight_g:number}[]}
) {
  role(actor,"warehouse_admin","super_admin","finance");
  const rate=input.rate_version_id
    ?await one(db,"select * from shipping_rate_versions where id=$1 and effective_at<=now()",[input.rate_version_id])
    :await one(db,"select * from shipping_rate_versions where effective_at<=now() order by version desc limit 1");
  const r=rateSchema.parse(rate.rules);
  const zoneRule=(input.zone && r.zones?.[input.zone])?r.zones[input.zone]:r;
  const parcels=input.parcels.map((p,idx)=>({
    index:idx+1,
    weight_g:p.weight_g,
    amount_cents:zoneRule.first_cents+Math.ceil(Math.max(0,p.weight_g-zoneRule.first_weight_g)/zoneRule.extra_step_g)*zoneRule.extra_cents,
  }));
  const handling_cents=r.handling_cents;
  const total_cents=handling_cents+parcels.reduce((n,p)=>n+p.amount_cents,0);
  return {rate_version_id:rate.id,rate_version:rate.version,version:rate.version,zone:input.zone??"default",handling_cents,parcels,total_cents};
}
export async function quoteBatch(
  db:DB,
  actor:Actor,
  id:string,
  rev:number,
  rateId:string,
  parcels:ParcelPlan[],
  manualReason?:string
) {
  role(actor,"warehouse_admin","super_admin");
  const b=await lockBatch(db,id);
  revision(b.revision,rev);
  const expired=b.state==="quoted"&&(await one(db,`select accepted_at is null and expires_at<=now() renewable
    from dispatch_quote_versions where batch_id=$1 order by revision desc limit 1`,[id])).renewable;
  guard(b.state==="confirmed"||expired,"BATCH_UNAVAILABLE","Quote a confirmed batch or replace an expired, unaccepted quote.");
  const items=(await db.query("select item_id from dispatch_batch_items where batch_id=$1 and released_at is null",[id])).rows.map(r=>r.item_id);
  guard(parcels.length<=50 && sameItems(parcels.flatMap(p=>p.item_ids),items),"PACK_MISMATCH","The quote must cover the exact authorized items.");
  const rate=await one(db,"select * from shipping_rate_versions where id=$1 and effective_at<=now()",[rateId]);
  const r=rateSchema.parse(rate.rules);
  const planned=parcels.map(p=>{
    if(p.manual_amount_cents!==undefined) {
      const reason=(p.manual_reason ?? manualReason ?? "").trim();
      guard(reason.length>=4,"MANUAL_REASON_REQUIRED","Provide a reason for out-of-rule manual parcel pricing.",422);
      guard(Number.isInteger(p.manual_amount_cents) && p.manual_amount_cents>=0,"INVALID_AMOUNT","Manual parcel amount must be non-negative.",422);
      return {
        item_ids:p.item_ids,
        weight_g:p.weight_g,
        amount_cents:p.manual_amount_cents,
        manual_override:true,
        manual_reason:reason,
      };
    }
    return {
      item_ids:p.item_ids,
      weight_g:p.weight_g,
      amount_cents:r.first_cents+Math.ceil(Math.max(0,p.weight_g-r.first_weight_g)/r.extra_step_g)*r.extra_cents,
    };
  });
  const total=r.handling_cents+planned.reduce((n,p)=>n+p.amount_cents,0);
  const nextQuoteRev=(await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from dispatch_quote_versions where batch_id=$1",[id])).n;
  const nextBatchRev=Math.max(rev+1,nextQuoteRev);
  const q=await one(db,`insert into dispatch_quote_versions(batch_id,revision,rate_version_id,snapshot,amount_cents,expires_at)
    values($1,$2,$3,$4,$5,now()+interval '72 hours') returning id as quote_id,revision,amount_cents`,
    [id,nextBatchRev,rateId,{parcels:planned,handling_cents:r.handling_cents,destination:b.destination_snapshot,...(manualReason?{manual_reason:manualReason.trim()}:{})},total]);
  await db.query("update dispatch_batches set state='quoted',revision=$2 where id=$1",[id,nextBatchRev]);
  await audit(db,actor,"quote_batch","dispatch_batches",id,{quote_id:q.quote_id,revision:q.revision});
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
  const latestQuote=(await one<{id:string}>(db,"select id from dispatch_quote_versions where batch_id=$1 order by revision desc limit 1",[q.batch_id])).id;
  guard(q.valid && !q.accepted_at && q.batch_state==="quoted" && q.id===latestQuote,"QUOTE_EXPIRED","Review the current quote.");
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
export async function storageQuote(db:DB,actor:Actor,id:string,input?:{days?:number}) {
  role(actor,"warehouse_admin","super_admin");
  const d=await one(db,"select * from disposition_requests where id=$1 and action='retain' and state='requested' for update",[id]);
  const existing=(await db.query<{id:string;revision:number;valid:boolean;accepted_at:Date|null}>(
    "select id,revision,expires_at>now() valid,accepted_at from storage_quotes where disposition_id=$1 order by revision desc limit 1",
    [id]
  )).rows[0];
  guard(!existing || (!existing.valid && !existing.accepted_at),"QUOTE_ACTIVE","An active storage quote already exists for this request.");
  const days=input?.days ?? (typeof d.return_info?.days==="number"?Number(d.return_info.days):30);
  guard(Number.isInteger(days) && days>=1 && days<=365,"INVALID_STORAGE_DAYS","Choose a valid storage extension period.",422);
  const price=await one<{value:unknown}>(db,"select value from app_config where key='storage.daily_cents'");
  const amount=z.number().int().positive().parse(price.value)*days;
  const nextRev=(existing?.revision??0)+1;
  const q=await one(db,`insert into storage_quotes(disposition_id,revision,snapshot,amount_cents,expires_at)
    values($1,$2,$3,$4,now()+interval '72 hours') returning id as quote_id,revision,amount_cents`,[id,nextRev,{days},amount]);
  await audit(db,actor,"quote_storage","disposition_requests",id,{revision:nextRev,days});
  return q;
}

export async function readDispatchBatch(db:DB,actor:Actor,id:string) {
  const org=organization(actor);
  const batch=await one(db,"select id,action,state,revision,destination_snapshot from dispatch_batches where id=$1 and org_id=$2",[id,org]);
  const items=(await db.query(
    `select bi.item_id,bi.disposition_id,bi.released_at,w.code,w.custody_state,o.id order_id,o.public_no order_no,
            exists(select 1 from shipment_items si join shipments s on s.id=si.shipment_id where si.batch_id=bi.batch_id and si.item_id=bi.item_id and s.shipped_at is not null) shipped
     from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id and w.org_id=bi.org_id
     left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
     left join order_lines l on l.id=a.order_line_id left join orders o on o.id=l.order_id
     where bi.batch_id=$1 and bi.org_id=$2 order by w.code`,
    [id,org]
  )).rows;
  const quotes=(await db.query(
    `select q.id,q.revision,q.amount_cents,q.expires_at,q.accepted_at,q.snapshot,c.id charge_item_id,c.applied_payment_id,c.voided_at
     from dispatch_quote_versions q left join charge_items c on c.dispatch_quote_id=q.id
     where q.batch_id=$1 order by q.revision desc`,
    [id]
  )).rows;
  const shipments=(await db.query(
    `select id,revision,state,weight_g,carrier_code,tracking_norm,shipped_at,returned_at
     from shipments where batch_id=$1 order by shipped_at nulls first,id`,
    [id]
  )).rows;
  return {...batch,batch,items,quotes,shipments};
}

export async function amendDispatchBatch(
  db:DB,
  actor:Actor,
  id:string,
  input:{revision:number;destination?:Destination;remove_item_ids?:string[];reason:string}
) {
  await requireCustomerActive(db,actor);
  const org=organization(actor);
  await lock(db,"org:"+org);
  const b=await one(db,"select * from dispatch_batches where id=$1 and org_id=$2 for update",[id,org]);
  revision(b.revision,input.revision);
  guard(["draft","confirmed","quoted","paid"].includes(b.state),"BATCH_UNAVAILABLE","This dispatch batch can no longer be amended.");

  const members=(await db.query<{item_id:string;disposition_id:string;released_at:Date|null;shipped:boolean;packed_shipment_id:string|null}>(
    `select bi.item_id,bi.disposition_id,bi.released_at,
            exists(select 1 from shipment_items si join shipments s on s.id=si.shipment_id where si.batch_id=bi.batch_id and si.item_id=bi.item_id and s.shipped_at is not null) shipped,
            (select s.id from shipment_items si join shipments s on s.id=si.shipment_id where si.batch_id=bi.batch_id and si.item_id=bi.item_id and s.shipped_at is null limit 1) packed_shipment_id
     from dispatch_batch_items bi
     where bi.batch_id=$1
       and (bi.released_at is null or exists(select 1 from shipment_items si join shipments s on s.id=si.shipment_id where si.batch_id=bi.batch_id and si.item_id=bi.item_id and s.shipped_at is not null))
     for update of bi`,
    [id]
  )).rows;

  const removeSet=new Set(input.remove_item_ids??[]);
  for(const remId of removeSet) {
    const m=members.find(x=>x.item_id===remId);
    guard(m,"PACK_MISMATCH","Select items that are currently active in this batch.");
    guard(!m.shipped,"SHIPMENT_ALREADY_HANDED_OVER","Items already handed over to a carrier cannot be removed or modified.");
  }
  if(input.destination) {
    guard(!members.some(m=>m.shipped),"SHIPMENT_ALREADY_HANDED_OVER","Cannot change the batch destination after a parcel has been handed over; remove or re-batch unshipped items instead.");
    guard(
      Boolean(input.destination.recipient?.trim() && input.destination.phone?.trim() && input.destination.address?.trim()),
      "DESTINATION_INCOMPLETE","Provide the recipient, phone number, and full shipping address.",422
    );
    if(b.action==="to_forwarder") {
      guard(Boolean(input.destination.member_code?.trim()),"DESTINATION_INCOMPLETE","Provide your freight forwarder warehouse member code.",422);
    }
  }

  // Unpack any unshipped packed shipments if items or destination change
  const unshippedShipments=[...new Set(members.filter(m=>!m.shipped && m.packed_shipment_id).map(m=>m.packed_shipment_id!))];
  if(unshippedShipments.length>0) {
    await db.query("delete from shipment_items where shipment_id=any($1::uuid[])",[unshippedShipments]);
    await db.query("delete from shipments where id=any($1::uuid[]) and shipped_at is null",[unshippedShipments]);
  }

  for(const remId of removeSet) {
    await db.query("update dispatch_batch_items set released_at=now() where batch_id=$1 and item_id=$2 and released_at is null",[id,remId]);
  }
  if(input.destination) {
    const activeDispIds=members.filter(m=>!removeSet.has(m.item_id)).map(m=>m.disposition_id);
    if(activeDispIds.length>0) {
      await db.query("update disposition_requests set destination=$2,revision=revision+1 where id=any($1::uuid[])",[activeDispIds,input.destination]);
    }
  }

  // Expire any unaccepted quotes and void any unpaid charges on this batch
  await db.query("update dispatch_quote_versions set expires_at=least(expires_at,now()) where batch_id=$1 and accepted_at is null",[id]);
  await db.query(
    `update charge_items c set voided_at=now() from dispatch_quote_versions q
     where c.dispatch_quote_id=q.id and q.batch_id=$1 and c.applied_payment_id is null and c.voided_at is null`,
    [id]
  );

  // If the batch had a paid charge, create a reconciliation/refund ticket for the unshipped change
  const paidCharge=(await db.query<{id:string;applied_payment_id:string;amount_cents:number}>(
    `select c.id,c.applied_payment_id,c.amount_cents from charge_items c join dispatch_quote_versions q on q.id=c.dispatch_quote_id
     where q.batch_id=$1 and c.applied_payment_id is not null and c.voided_at is null order by q.revision desc limit 1`,
    [id]
  )).rows[0];
  let refundTicketNo:string|null=null;
  if(paidCharge) {
    refundTicketNo=code("PAY-");
    await db.query(
      `insert into tickets(id,public_no,org_id,category,subject,details)
       values($1,$2,$3,'payment_refund',$4,$5)`,
      [
        uuid(),
        refundTicketNo,
        org,
        "Reconcile paid dispatch batch amendment",
        {
          batch_id:id,
          charge_item_id:paidCharge.id,
          payment_id:paidCharge.applied_payment_id,
          removed_item_ids:[...removeSet],
          destination_changed:Boolean(input.destination),
          reason:input.reason.trim(),
        },
      ]
    );
  }

  const remainingUnshipped=members.filter(m=>!m.shipped && !removeSet.has(m.item_id));
  const anyShipped=members.some(m=>m.shipped);
  const nextState=remainingUnshipped.length===0?(anyShipped?"completed":"draft"):(b.state==="draft"?"draft":"confirmed");
  const nextRev=b.revision+1;
  await db.query(
    "update dispatch_batches set destination_snapshot=coalesce($2,destination_snapshot),state=$3,revision=$4 where id=$1",
    [id,input.destination??null,nextState,nextRev]
  );
  await audit(db,actor,"amend_dispatch_batch","dispatch_batches",id,{
    removed_item_ids:[...removeSet],
    destination_changed:Boolean(input.destination),
    next_state:nextState,
    refund_ticket_no:refundTicketNo,
  });
  return {batch_id:id,state:nextState,revision:nextRev,refund_ticket_no:refundTicketNo,refund_ticket_id:refundTicketNo};
}

export async function checkStorageReminders(db:DB) {
  const {rows}=await db.query<{item_id:string;code:string;org_id:string;storage_until:Date;user_id:string}>(
    `select w.id item_id,w.code,w.org_id,w.storage_until,m.user_id
     from warehouse_items w
     join memberships m on m.org_id=w.org_id
     where w.custody_state in ('received','stored')
       and w.parent_item_id is null
       and w.storage_until is not null
       and w.storage_until<=now()+interval '3 days'
       and not exists(select 1 from disposition_requests d where d.item_id=w.id and d.state='requested')`
  );
  let sent=0;
  for(const r of rows) {
    const round=r.storage_until<=new Date()?"expired":"expiring_3d";
    const periodKey=`storage:${r.item_id}:${r.storage_until.toISOString().slice(0,10)}:${round}`;
    const inserted=await db.query(
      `insert into notifications(id,user_id,template,locale,payload,dedupe_key)
       values($1,$2,'storage.reminder','en',$3,$4)
       on conflict(dedupe_key) do nothing
       returning id`,
      [uuid(),r.user_id,{item_id:r.item_id,item_code:r.code,storage_until:r.storage_until,round,period_key:periodKey},periodKey]
    );
    if(inserted.rowCount) sent++;
  }
  return {reminded:sent,sent_count:sent};
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
  role(actor,"warehouse_admin","super_admin");
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
  role(actor,"warehouse_admin","super_admin");
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
  role(actor,"warehouse_admin","super_admin");
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
