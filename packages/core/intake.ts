import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { processImageBytes } from "./media";
import { readyOrder } from "./orders";
import { requireSpace } from "./storage";

export function waybill(value:string) {
  const normalized=value.replace(/\s+/g,"").toUpperCase();
  guard(/^[A-Z0-9-]{5,64}$/.test(normalized),"TRACKING_INVALID","Enter the actual carrier tracking number.",422);
  return normalized;
}
export async function validCarrier(db:DB,carrier:string) {
  await one(db,"select code from carriers where code=$1 and enabled",[carrier]);
  return carrier;
}
export async function advise(db:DB,actor:Actor,input:{tracking_no:string;address_id:string;carrier_code?:string;order_ids?:string[]}) {
  const org=organization(actor),tracking=waybill(input.tracking_no);
  await lock(db,"org:"+org);await lock(db,"waybill:"+tracking);
  const carrier=input.carrier_code ? await validCarrier(db,input.carrier_code) : null;
  const matches=await candidates(db,tracking,carrier??undefined);
  const match=matches[0];
  guard(matches.length<=1 && (!match || match.org_id===org && match.advice_id),
    "TRACKING_REVIEW_REQUIRED","This tracking number requires staff verification.");
  const prev=match?{id:match.advice_id,revision:match.advice_revision}:undefined;
  const orders=[...new Set(input.order_ids??[])];
  for(const order of orders) await one(db,"select id from orders where id=$1 and org_id=$2",[order,org]);
  let row=prev;
  if(!row) {
    const address=await one(db,"select * from warehouse_addresses where id=$1 and active",[input.address_id]);
    row=await one(db,`insert into package_advices(user_id,org_id,address_id,address_snapshot) values($1,$2,$3,$4) returning id,revision`,[actor.id,org,address.id,address]);
    await db.query(`insert into tracking_records(org_id,direction,advice_id,carrier_code,tracking_norm,generation,transport_state,sync_state,next_query_at)
      values($1,'inbound',$2,$3,$4,1,'unknown',$5,now())`,[org,row.id,carrier,tracking,carrier?"pending":"needs_carrier"]);
    await audit(db,actor,"advise_parcel","package_advices",row.id);
  }
  for(const order of orders) await db.query("insert into advice_orders(advice_id,order_id,org_id) values($1,$2,$3) on conflict do nothing",[row.id,order,org]);
  return {id:row.id,revision:row.revision,state:"advised"};
}
export async function candidates(db:DB,tracking:string,carrier?:string) {
  return (await db.query(`select t.id,t.org_id,t.advice_id,t.package_id,t.carrier_code,a.revision advice_revision,p.receiving_code
    from tracking_records t left join package_advices a on a.id=t.advice_id
    left join customer_receiving_profiles p on p.user_id=a.user_id where t.direction='inbound'
    and t.tracking_norm=$1 and t.closed_at is null and ($2::text is null or t.carrier_code is null or t.carrier_code=$2)`,[tracking,carrier??null])).rows;
}
export async function lookup(db:DB,actor:Actor,input:{tracking_no:string;carrier_code?:string}) {
  role(actor,"receiver","warehouse_admin");
  const rows=await candidates(db,waybill(input.tracking_no),input.carrier_code);
  if(rows.length!==1) return {match_state:rows.length?"ambiguous":"unmatched",order_ids:[],candidate_count:rows.length};
  const t=rows[0];
  const order_ids=(await db.query("select order_id from advice_orders where advice_id=$1 order by order_id",[t.advice_id])).rows.map(x=>x.order_id);
  return {match_state:order_ids.length?"matched":t.org_id?"user_only":"unmatched",order_ids,
    ...(t.receiving_code?{receiving_code:t.receiving_code}:{}),...(t.advice_id?{advice_id:t.advice_id}:{}),...(t.package_id?{package_id:t.package_id}:{})};
}
export async function savePhoto(db:DB,actor:Actor,bytes:Buffer,kind:string) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org) guard(kind==="attachment","FORBIDDEN","Only claim documents can be uploaded.",403);
  else role(actor,"receiver","inspector","warehouse_admin");
  guard(bytes.length>0 && bytes.length<=25_000_000,"FILE_INVALID","Upload a photo up to 25 MB.",422);
  const {fullData,thumbData,width,height,capturedAt}=await processImageBytes(bytes);
  const id=uuid(), key="media/"+id, thumbKey="thumb/"+id;
  await db.query("insert into private_files(key,data,mime) values($1,$2,'image/jpeg'),($3,$4,'image/jpeg')",[key,fullData,thumbKey,thumbData]);
  await db.query(`insert into media_assets(id,kind,object_key,thumb_key,mime,size_bytes,width,height,sha256,status,captured_at,uploaded_by,org_id)
    values($1,$2,$3,$4,'image/jpeg',$5,$6,$7,$8,'ready',$9,$10,$11)`,[id,kind,key,thumbKey,fullData.length,width,height,hash(fullData),capturedAt,actor.id,org]);
  return {id};
}
export async function attachEvidence(db:DB,actor:Actor,ids:string[],kind:string,scope:{org:string|null;package?:string;task?:string}) {
  guard(new Set(ids).size===ids.length && ids.length>0,"EVIDENCE_REQUIRED","Provide distinct supporting photos.",422);
  for(const id of [...ids].sort()) {
    const m=await one(db,"select * from media_assets where id=$1 and uploaded_by=$2 for update",[id,actor.id]);
    guard(m.status==="ready","MEDIA_NOT_READY","The referenced photo is not ready yet.",409);
    guard(m.kind===kind && (!m.org_id || m.org_id===scope.org) && (!m.package_id || m.package_id===scope.package) &&
      (!m.task_id || m.task_id===scope.task),"EVIDENCE_MISMATCH","The photo belongs to another operation.");
    await db.query("update media_assets set org_id=$2,package_id=coalesce($3,package_id),task_id=coalesce($4,task_id) where id=$1",
      [id,scope.org,scope.package??null,scope.task??null]);
  }
}
export async function checkIn(db:DB,actor:Actor,input:{tracking_no:string;carrier_code?:string;weight_g?:number;advice_id?:string;outer_media_ids:string[]}) {
  role(actor,"receiver","warehouse_admin");
  const tracking=waybill(input.tracking_no);
  const carrier=input.carrier_code ? await validCarrier(db,input.carrier_code) : null;
  const before=await candidates(db,tracking,carrier??undefined);
  if(before.length===1 && before[0].org_id) await lock(db,"org:"+before[0].org_id);
  await lock(db,"waybill:"+tracking);
  const rows=await candidates(db,tracking,carrier??undefined);
  guard(rows.length<=1,"TRACKING_REVIEW_REQUIRED","More than one parcel matches. Verify the carrier.");
  const t=rows[0];
  guard(!input.advice_id || t?.advice_id===input.advice_id,"TRACKING_REVIEW_REQUIRED","The selected advice does not match the tracking number.");
  if(t?.package_id) return one(db,"select id,state,revision from packages where id=$1",[t.package_id]);
  const pkg=await one<{id:string;state:string;revision:number}>(db,`insert into packages(code,org_id,advice_id,received_by,received_at,received_quantity,weight_g,state)
    values($1,$2,$3,$4,now(),0,$5,$6) returning id,state,revision`,
    [code("P-"),t?.org_id??null,t?.advice_id??null,actor.id,input.weight_g??null,t?.org_id?"checked_in":"unmatched"]);
  await attachEvidence(db,actor,input.outer_media_ids,"intake_outer",{org:t?.org_id??null,package:pkg.id});
  if(t) await db.query(`update tracking_records set package_id=$2,carrier_code=coalesce(carrier_code,$3),
    sync_state=case when sync_state='needs_carrier' and $3::text is not null then 'pending' else sync_state end,
    revision=revision+1 where id=$1`,[t.id,pkg.id,carrier]);
  else await db.query(`insert into tracking_records(direction,package_id,carrier_code,tracking_norm,generation,transport_state,sync_state,next_query_at)
    values('inbound',$1,$2,$3,1,'unknown',case when $2::text is null then 'needs_carrier' else 'pending' end,now())`,[pkg.id,carrier,tracking]);
  await audit(db,actor,"physical_check_in","packages",pkg.id);
  await event(db,"package.received",{package_id:pkg.id});
  return pkg;
}
export async function intakeItems(db:DB,actor:Actor,id:string,input:{revision:number;items:{code:string;location_id:string;component_of?:string}[]}) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one(db,"select org_id from packages where id=$1",[id]);
  if(initial.org_id) await lock(db,"org:"+initial.org_id);
  const pkg=await one(db,"select * from packages where id=$1 for update",[id]);
  revision(pkg.revision,input.revision);
  const counts=new Map<string,number>();
  for(const item of input.items) counts.set(item.location_id,(counts.get(item.location_id)??0)+1);
  for(const id of [...counts.keys()].sort()) await requireSpace(db,id,counts.get(id)!);
  const ids=[];
  for(const item of input.items) {
    if(item.component_of) await one(db,"select id from warehouse_items where id=$1 and package_id=$2",[item.component_of,id]);
    const row=await one<{id:string}>(db,`insert into warehouse_items(code,org_id,package_id,parent_item_id,intake_batch_id,
      identity_state,condition_state,custody_state,location_id,received_at)
      values($1,$2,$3,$4,$3,'pending','unchecked','received',$5,now()) returning id`,
      [item.code,pkg.org_id,id,item.component_of??null,item.location_id]);
    ids.push(row.id);
    await db.query(`insert into storage_events(item_id,to_location_id,action,operator_id) values($1,$2,'intake',$3)`,[row.id,item.location_id,actor.id]);
  }
  await db.query("update packages set revision=revision+1,received_quantity=received_quantity+$2 where id=$1",[id,input.items.filter(x=>!x.component_of).length]);
  await audit(db,actor,"intake_items","packages",id,{count:ids.length});
  return {item_ids:ids,revision:pkg.revision+1};
}
export async function assign(db:DB,actor:Actor,itemId:string,input:{revision:number;order_line_id:string;expected_item_id:string;evidence_ids:string[]}) {
  role(actor,"receiver","warehouse_admin");
  const line=await one(db,"select * from order_lines where id=$1",[input.order_line_id]);
  await lock(db,"org:"+line.org_id);
  const order=await one(db,"select * from orders where id=$1 for update",[line.order_id]);
  const item=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,line.org_id]);
  revision(item.revision,input.revision);
  guard(order.paid_at && order.state==="awaiting_samples" && !item.parent_item_id && ["received","stored"].includes(item.custody_state),
    "ASSIGNMENT_UNAVAILABLE","This item or order is not ready for assignment.");
  await one(db,"select id from expected_items where id=$1 and order_line_id=$2 and in_scope",[input.expected_item_id,line.id]);
  guard(!(await db.query("select 1 from disposition_requests where item_id=$1 and state not in ('completed','cancelled')",[itemId])).rowCount,
    "ITEM_RESERVED","Item has an active disposition.");
  await attachEvidence(db,actor,input.evidence_ids,"label_photo",{org:line.org_id,package:item.package_id});
  const result=await one<{id:string}>(db,`insert into order_line_item_links(org_id,order_line_id,expected_item_id,item_id,linked_at)
    values($1,$2,$3,$4,now()) returning id`,[line.org_id,line.id,input.expected_item_id,itemId]);
  await db.query("update warehouse_items set identity_state='identified',custody_state='stored',revision=revision+1 where id=$1",[itemId]);
  await audit(db,actor,"assign_item","warehouse_items",itemId,{assignment_id:result.id});
  await readyOrder(db,line.order_id);
  return {assignment_id:result.id,revision:item.revision+1};
}

export async function requestIntakeClaim(db:DB,actor:Actor,input:{tracking_no:string;carrier_code:string;advice_id?:string},bytes:Buffer) {
  const org=organization(actor),tracking=waybill(input.tracking_no);
  await lock(db,"org:"+org);
  await validCarrier(db,input.carrier_code);
  if(input.advice_id) await one(db,`select a.id from package_advices a join tracking_records t on t.advice_id=a.id
    where a.id=$1 and a.org_id=$2 and t.closed_at is null and t.tracking_norm=$3 and coalesce(t.carrier_code,$4)=$4`,
    [input.advice_id,org,tracking,input.carrier_code]);
  const current=(await db.query(`select public_no,state from tickets where org_id=$1 and category='identity_unclear'
    and details->>'tracking_no'=$2 and details->>'carrier_code'=$3 and state in ('open','waiting_internal')`,
    [org,tracking,input.carrier_code])).rows[0];
  if(current) return current;
  const proof=await savePhoto(db,actor,bytes,"attachment");
  const id=uuid();
  const ticket=await one(db,`insert into tickets(id,public_no,org_id,category,subject,details)
    values($1,$2,$3,'identity_unclear','Inbound parcel ownership review',$4) returning public_no,state`,
    [id,code("CLAIM-"),org,{tracking_no:tracking,carrier_code:input.carrier_code,applicant_id:actor.id,proof_id:proof.id,advice_id:input.advice_id}]);
  await audit(db,actor,"request_intake_claim","tickets",id);
  return ticket;
}

export async function decideIntakeClaim(db:DB,actor:Actor,id:string,decision:"approve"|"reject",reason:string) {
  role(actor,"support","super_admin");
  const initial=await one(db,"select org_id from tickets where id=$1 and category='identity_unclear' and details ? 'proof_id'",[id]);
  await lock(db,"org:"+initial.org_id);
  const ticket=await one(db,"select * from tickets where id=$1 for update",[id]);
  guard(ticket.state==="open","CLAIM_DECIDED","This claim has already been decided.");
  const details=ticket.details;
  if(decision==="approve") {
    await lock(db,"waybill:"+details.tracking_no);
    const matches=await candidates(db,details.tracking_no,details.carrier_code);
    const match=matches[0];
    guard(matches.length===1 && match.package_id && !match.org_id && !match.advice_id,
      "CLAIM_NOT_AVAILABLE","Confirm there is a single unassigned physical parcel before approving.");
    const pkg=await one(db,"select org_id,state from packages where id=$1 for update",[match.package_id]);
    guard(!pkg.org_id && pkg.state==="unmatched","CLAIM_NOT_AVAILABLE","This parcel is no longer unassigned.");
    const address=await one(db,"select * from warehouse_addresses where active and is_default");
    const advice=await one(db,`insert into package_advices(user_id,org_id,address_id,address_snapshot)
      values($1,$2,$3,$4) returning id`,[details.applicant_id,ticket.org_id,address.id,address]);
    await db.query("update packages set org_id=$2,advice_id=$3,state='checked_in',revision=revision+1 where id=$1",
      [match.package_id,ticket.org_id,advice.id]);
    await db.query("update warehouse_items set org_id=$2,revision=revision+1 where package_id=$1 and org_id is null",[match.package_id,ticket.org_id]);
    await db.query("update media_assets set org_id=$2 where package_id=$1 and org_id is null",[match.package_id,ticket.org_id]);
    await db.query(`update tracking_records set org_id=$2,advice_id=$3,carrier_code=coalesce(carrier_code,$4),
      sync_state=case when sync_state='needs_carrier' then 'pending' else sync_state end,
      next_query_at=coalesce(next_query_at,now()),revision=revision+1 where id=$1`,
      [match.id,ticket.org_id,advice.id,details.carrier_code]);
    await db.query(`insert into package_claims(id,package_id,applicant_id,evidence_ids,state,reviewed_by,decided_at)
      values($1,$2,$3,$4,'approved',$5,now())`,[uuid(),match.package_id,details.applicant_id,[details.proof_id],actor.id]);
    await event(db,"package.received",{package_id:match.package_id});
  }
  await db.query("update tickets set state='resolved',resolved_at=now(),next_action_at=null,revision=revision+1,details=details||$2::jsonb where id=$1",
    [id,{decision,reviewed_by:actor.id}]);
  await db.query(`insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
    values($1,$2,'staff',$3,'internal_note',$4)`,[uuid(),id,actor.id,reason]);
  await audit(db,actor,"decide_intake_claim","tickets",id,{decision});
  return {public_no:ticket.public_no,state:"resolved",decision};
}
