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
  let unmatchedLocId:string|null=null;
  if(!t?.org_id) {
    const loc=(await db.query<{id:string}>("select id from storage_locations where zone='unmatched' and active order by code limit 1")).rows[0];
    unmatchedLocId=loc?.id??null;
  }
  const pkg=await one<{id:string;state:string;revision:number}>(db,`insert into packages(code,org_id,advice_id,received_by,received_at,received_quantity,weight_g,state,location_id)
    values($1,$2,$3,$4,now(),0,$5,$6,$7) returning id,state,revision`,
    [code("P-"),t?.org_id??null,t?.advice_id??null,actor.id,input.weight_g??null,t?.org_id?"checked_in":"unmatched",unmatchedLocId]);
  if(unmatchedLocId) {
    await db.query("insert into storage_events(package_id,to_location_id,action,operator_id) values($1,$2,'intake_unmatched',$3)",[pkg.id,unmatchedLocId,actor.id]);
  }
  await attachEvidence(db,actor,input.outer_media_ids,"intake_outer",{org:t?.org_id??null,package:pkg.id});
  if(t) await db.query(`update tracking_records set package_id=$2,carrier_code=coalesce(carrier_code,$3),
    sync_state=case when sync_state='needs_carrier' and $3::text is not null then 'pending' else sync_state end,
    revision=revision+1 where id=$1`,[t.id,pkg.id,carrier]);
  else await db.query(`insert into tracking_records(direction,package_id,carrier_code,tracking_norm,generation,transport_state,sync_state,next_query_at)
    values('inbound',$1,$2,$3,1,'unknown',case when $2::text is null then 'needs_carrier' else 'pending' end,now())`,[pkg.id,carrier,tracking]);
  if(!t?.org_id) {
    await db.query(`insert into tickets(id,public_no,org_id,category,subject,details)
      values($1,$2,null,'identity_unclear',$3,$4)`,
      [uuid(),code("UNM-"),"Unmatched inbound parcel: "+tracking,{tracking_no:tracking,carrier_code:carrier,package_id:pkg.id}]);
  }
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
  guard(pkg.state!=="quarantined","PACKAGE_QUARANTINED","Quarantined parcels cannot be unpacked into regular inventory.");
  const counts=new Map<string,number>();
  for(const item of input.items) counts.set(item.location_id,(counts.get(item.location_id)??0)+1);
  for(const locId of [...counts.keys()].sort()) await requireSpace(db,locId,counts.get(locId)!);
  const batchId=uuid();
  const ids=[];
  for(const item of input.items) {
    if(item.component_of) {
      const parent=await one<{id:string;parent_item_id:string|null}>(db,"select id,parent_item_id from warehouse_items where id=$1 and package_id=$2",[item.component_of,id]);
      guard(!parent.parent_item_id,"COMPONENT_NESTING_INVALID","Components must attach to a top-level item in the same package.",422);
    }
    const row=await one<{id:string}>(db,`insert into warehouse_items(code,org_id,package_id,parent_item_id,intake_batch_id,
      identity_state,condition_state,custody_state,location_id,received_at)
      values($1,$2,$3,$4,$5,'pending','unchecked','received',$6,now()) returning id`,
      [item.code,pkg.org_id,id,item.component_of??null,batchId,item.location_id]);
    ids.push(row.id);
    await db.query(`insert into storage_events(item_id,to_location_id,action,operator_id) values($1,$2,'intake',$3)`,[row.id,item.location_id,actor.id]);
  }
  await db.query("update packages set revision=revision+1,received_quantity=received_quantity+$2 where id=$1",[id,input.items.filter(x=>!x.component_of).length]);
  await audit(db,actor,"intake_items","packages",id,{count:ids.length,intake_batch_id:batchId});
  return {item_ids:ids,revision:pkg.revision+1};
}
export async function assign(db:DB,actor:Actor,itemId:string,input:{revision:number;order_line_id:string;expected_item_id:string;evidence_ids:string[]}) {
  role(actor,"receiver","warehouse_admin");
  const line=await one(db,"select * from order_lines where id=$1",[input.order_line_id]);
  await lock(db,"org:"+line.org_id);
  const order=await one(db,"select * from orders where id=$1 for update",[line.order_id]);
  const item=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,line.org_id]);
  revision(item.revision,input.revision);
  guard(item.identity_state!=="quarantined" && item.condition_state!=="restricted",
    "ITEM_QUARANTINED","Quarantined or restricted items cannot be assigned to an inspection order.");
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
export async function unassignItem(db:DB,actor:Actor,itemId:string,input:{revision:number;reason:string}) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one<{org_id:string|null}>(db,"select org_id from warehouse_items where id=$1",[itemId]);
  guard(initial.org_id,"ASSIGNMENT_UNAVAILABLE","This item has no verified organization.");
  await lock(db,"org:"+initial.org_id);
  const item=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,initial.org_id]);
  revision(item.revision,input.revision);
  const link=await one<{id:string;order_line_id:string;expected_item_id:string}>(
    db,
    "select id,order_line_id,expected_item_id from order_line_item_links where item_id=$1 and unlinked_at is null for update",
    [itemId]
  );
  const line=await one<{order_id:string}>(db,"select order_id from order_lines where id=$1",[link.order_line_id]);
  const order=await one<{id:string;state:string}>(db,"select id,state from orders where id=$1 for update",[line.order_id]);
  guard(order.state==="awaiting_samples","UNASSIGN_UNAVAILABLE","Items can only be unlinked before the order enters the inspection queue.");
  await db.query("update order_line_item_links set unlinked_at=now(),reason=$2 where id=$1",[link.id,input.reason.trim()]);
  await db.query("update warehouse_items set identity_state='pending',revision=revision+1 where id=$1",[itemId]);
  await audit(db,actor,"unassign_item","warehouse_items",itemId,{assignment_id:link.id,order_id:order.id,reason:input.reason.trim()});
  return {item_id:itemId,unlinked_assignment_id:link.id,revision:item.revision+1};
}

export async function identifyItem(
  db:DB,
  actor:Actor,
  itemId:string,
  input:{
    revision:number;
    matches_advice:boolean;
    actual_label_info?:Record<string,unknown>;
    mismatch_note?:string;
    media_ids?:string[];
    evidence_ids?:string[];
    order_line_id?:string;
    expected_item_id?:string;
  }
) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one<{org_id:string|null}>(db,"select org_id from warehouse_items where id=$1",[itemId]);
  guard(initial.org_id,"ASSIGNMENT_UNAVAILABLE","Verify parcel ownership before identifying sample items.");
  await lock(db,"org:"+initial.org_id);
  const item=await one(db,"select * from warehouse_items where id=$1 and org_id=$2 for update",[itemId,initial.org_id]);
  revision(item.revision,input.revision);
  guard(item.identity_state!=="quarantined" && item.condition_state!=="restricted",
    "ITEM_QUARANTINED","Quarantined or restricted items cannot be identified for inspection.");
  guard(["received","stored"].includes(item.custody_state) && !item.parent_item_id,
    "ASSIGNMENT_UNAVAILABLE","This item is not eligible for sample identification.");
  const evidenceIds=[...new Set([...(input.media_ids??[]),...(input.evidence_ids??[])])];
  if(evidenceIds.length) {
    await attachEvidence(db,actor,evidenceIds,"label_photo",{org:initial.org_id,package:item.package_id});
  }
  let link=(await db.query<{id:string;order_line_id:string;expected_item_id:string}>(
    "select id,order_line_id,expected_item_id from order_line_item_links where item_id=$1 and unlinked_at is null for update",
    [itemId]
  )).rows[0];
  if(!link) {
    guard(input.order_line_id && input.expected_item_id,"ASSIGNMENT_REQUIRED","Assign the item to an expected order position first.",422);
    const line=await one(db,"select * from order_lines where id=$1 and org_id=$2",[input.order_line_id,initial.org_id]);
    const orderForLink=await one(db,"select * from orders where id=$1 for update",[line.order_id]);
    guard(orderForLink.paid_at && ["awaiting_samples","on_hold"].includes(orderForLink.state),
      "ASSIGNMENT_UNAVAILABLE","This order is not accepting sample assignments.");
    await one(db,"select id from expected_items where id=$1 and order_line_id=$2 and in_scope",[input.expected_item_id,line.id]);
    link=await one<{id:string;order_line_id:string;expected_item_id:string}>(
      db,
      `insert into order_line_item_links(org_id,order_line_id,expected_item_id,item_id,linked_at)
       values($1,$2,$3,$4,now()) returning id,order_line_id,expected_item_id`,
      [initial.org_id,line.id,input.expected_item_id,itemId]
    );
  }
  const line=await one<{id:string;order_id:string}>(db,"select id,order_id from order_lines where id=$1",[link.order_line_id]);
  const expected=await one<{id:string;position:number;declared_fields:Record<string,unknown>}>(
    db,
    "select id,position,declared_fields from expected_items where id=$1 for update",
    [link.expected_item_id]
  );
  const order=await one(db,"select * from orders where id=$1 for update",[line.order_id]);
  guard(["awaiting_samples","on_hold"].includes(order.state),
    "ORDER_NOT_EDITABLE","Sample identity can only be verified before inspection begins.");
  if(input.matches_advice) {
    await db.query("update warehouse_items set identity_state='identified',custody_state='stored',revision=revision+1 where id=$1",[itemId]);
    if(input.actual_label_info && Object.keys(input.actual_label_info).length) {
      await db.query(
        "update expected_items set declared_fields=declared_fields||jsonb_build_object('verified_label_info',$2::jsonb) where id=$1",
        [expected.id,JSON.stringify(input.actual_label_info)]
      );
    }
    await db.query(
      "update order_blocks set resolved_at=now() where order_id=$1 and reason='identity_mismatch' and object_key=$2 and resolved_at is null",
      [order.id,expected.id]
    );
    await db.query(
      `update tickets set state='resolved',resolved_at=now(),next_action_at=null,revision=revision+1
       where order_id=$1 and category='receipt_mismatch' and details->>'expected_item_id'=$2 and state in ('open','waiting_customer','waiting_internal')`,
      [order.id,expected.id]
    );
    const remainingBlocks=(await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null",[order.id])).rowCount;
    if(order.state==="on_hold" && !remainingBlocks) {
      const fromState=(order.held_from_state as string|null)??"awaiting_samples";
      await db.query(
        `update orders set state=$2,
           sla_due_at=case when sla_due_at is not null and held_at is not null then sla_due_at+greatest(now()-held_at,interval '0 seconds') else sla_due_at end,
           held_at=null,held_from_state=null,hold_reason=null,revision=revision+1
         where id=$1`,
        [order.id,fromState]
      );
    }
    await audit(db,actor,"identify_item","warehouse_items",itemId,{matches_advice:true,expected_item_id:expected.id});
    await readyOrder(db,order.id);
    const refreshed=await one<{state:string}>(db,"select state from orders where id=$1",[order.id]);
    return {item_id:itemId,identity_state:"identified",order_id:order.id,order_state:refreshed.state,revision:item.revision+1};
  }
  const mismatchNote=(input.mismatch_note??"").trim();
  guard(mismatchNote.length>=2,"VALIDATION_FAILED","Describe the label or sample discrepancy so the customer can respond.",422);
  await db.query("update warehouse_items set identity_state='mismatch',custody_state='stored',revision=revision+1 where id=$1",[itemId]);
  await db.query(
    "update expected_items set declared_fields=declared_fields||jsonb_build_object('actual_label_info',$2::jsonb,'mismatch_note',$3::text) where id=$1",
    [expected.id,JSON.stringify(input.actual_label_info??{}),mismatchNote]
  );
  await db.query(
    `insert into order_blocks(id,order_id,reason,object_key,opened_at)
     values($1,$2,'identity_mismatch',$3,now())
     on conflict(order_id,reason,object_key) where resolved_at is null do nothing`,
    [uuid(),order.id,expected.id]
  );
  if(order.state!=="on_hold") {
    await db.query(
      "update orders set state='on_hold',held_at=now(),held_from_state=state,hold_reason=$2,revision=revision+1 where id=$1",
      [order.id,mismatchNote]
    );
  } else {
    await db.query("update orders set hold_reason=$2,revision=revision+1 where id=$1",[order.id,mismatchNote]);
  }
  const ticketId=uuid();
  const ticket=await one<{id:string;public_no:string}>(
    db,
    `insert into tickets(id,public_no,org_id,order_id,category,state,subject,details,next_action_at)
     values($1,$2,$3,$4,'receipt_mismatch','waiting_customer',$5,$6,now()+interval '48 hours')
     returning id,public_no`,
    [
      ticketId,
      code("MIS-"),
      initial.org_id,
      order.id,
      `Sample label or attribute mismatch on ${item.code}`,
      {
        item_id:itemId,
        item_code:item.code,
        expected_item_id:expected.id,
        expected_position:expected.position,
        order_line_id:line.id,
        declared_fields:expected.declared_fields,
        actual_label_info:input.actual_label_info??{},
        mismatch_note:mismatchNote,
        evidence_ids:evidenceIds,
      },
    ]
  );
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body,media_ids)
     values($1,$2,'staff',$3,'message',$4,$5)`,
    [uuid(),ticket.id,actor.id,mismatchNote,evidenceIds.length?evidenceIds:null]
  );
  await audit(db,actor,"identify_item_mismatch","warehouse_items",itemId,{
    expected_item_id:expected.id,
    order_id:order.id,
    ticket_id:ticket.id,
    mismatch_note:mismatchNote,
  });
  await event(db,"order.identity_mismatch",{
    order_id:order.id,
    item_id:itemId,
    expected_item_id:expected.id,
    ticket_id:ticket.id,
  });
  return {
    item_id:itemId,
    identity_state:"mismatch",
    order_id:order.id,
    order_state:"on_hold",
    ticket_id:ticket.id,
    ticket_no:ticket.public_no,
    revision:item.revision+1,
  };
}

async function resolveQuarantineLocation(db:DB,requestedId?:string) {
  if(requestedId) {
    const loc=await one<{id:string;zone:string;active:boolean}>(db,"select id,zone,active from storage_locations where id=$1",[requestedId]);
    guard(loc.active,"LOCATION_INACTIVE","This storage location is disabled.");
    guard(loc.zone==="quarantine","QUARANTINE_LOCATION_REQUIRED","Select a storage location in the quarantine zone.",422);
    return loc.id;
  }
  const existing=(await db.query<{id:string}>("select id from storage_locations where zone='quarantine' and active order by code limit 1")).rows[0];
  if(existing) return existing.id;
  const created=await one<{id:string}>(
    db,
    `insert into storage_locations(id,code,zone,active,capacity,notes)
     values($1,'Q-QUAR-01','quarantine',true,200,'Default quarantine zone')
     on conflict(code) do update set active=true returning id`,
    [uuid()]
  );
  return created.id;
}

export async function quarantinePackage(
  db:DB,
  actor:Actor,
  packageId:string,
  input:{revision:number;reason:string;location_id?:string;evidence_ids?:string[]}
) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one<{org_id:string|null}>(db,"select org_id from packages where id=$1",[packageId]);
  if(initial.org_id) await lock(db,"org:"+initial.org_id);
  const pkg=await one(db,"select * from packages where id=$1 for update",[packageId]);
  revision(pkg.revision,input.revision);
  const locId=await resolveQuarantineLocation(db,input.location_id);
  if(input.evidence_ids?.length) {
    for(const eid of input.evidence_ids) {
      const m=await one(db,"select * from media_assets where id=$1 for update",[eid]);
      guard(m.status==="ready","MEDIA_NOT_READY","The referenced photo is not ready yet.",409);
      await db.query("update media_assets set org_id=coalesce(org_id,$2),package_id=coalesce(package_id,$3) where id=$1",[eid,pkg.org_id,packageId]);
    }
  }
  await db.query(
    "update packages set state='quarantined',condition_note=$2,location_id=$3,revision=revision+1 where id=$1",
    [packageId,input.reason.trim(),locId]
  );
  await db.query(
    "insert into storage_events(package_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'quarantine',$4)",
    [packageId,pkg.location_id??null,locId,actor.id]
  );
  const {rows:pkgItems}=await db.query<{id:string;location_id:string|null}>(
    "select id,location_id from warehouse_items where package_id=$1 and custody_state in ('received','stored') for update",
    [packageId]
  );
  for(const it of pkgItems) {
    await db.query(
      "update warehouse_items set identity_state='quarantined',condition_state='restricted',location_id=$2,revision=revision+1 where id=$1",
      [it.id,locId]
    );
    await db.query(
      "insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'quarantine',$4)",
      [it.id,it.location_id,locId,actor.id]
    );
  }
  const ticketId=uuid();
  await db.query(
    `insert into tickets(id,public_no,org_id,category,subject,details)
     values($1,$2,$3,'receipt_mismatch',$4,$5)`,
    [ticketId,code("QUAR-"),pkg.org_id,"Restricted or non-conforming parcel quarantined: "+pkg.code,{package_id:packageId,reason:input.reason.trim(),location_id:locId}]
  );
  await audit(db,actor,"quarantine_package","packages",packageId,{reason:input.reason.trim(),location_id:locId,ticket_id:ticketId});
  return {id:packageId,state:"quarantined",location_id:locId,revision:pkg.revision+1,ticket_id:ticketId};
}

export async function quarantineItem(
  db:DB,
  actor:Actor,
  itemId:string,
  input:{revision:number;reason:string;location_id?:string}
) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one<{org_id:string|null}>(db,"select org_id from warehouse_items where id=$1",[itemId]);
  if(initial.org_id) await lock(db,"org:"+initial.org_id);
  const item=await one(db,"select * from warehouse_items where id=$1 for update",[itemId]);
  revision(item.revision,input.revision);
  guard(["received","stored"].includes(item.custody_state),"ITEM_UNAVAILABLE","This item is not in warehouse custody.");
  const locId=await resolveQuarantineLocation(db,input.location_id);
  await requireSpace(db,locId,1);
  await db.query(
    "update warehouse_items set identity_state='quarantined',condition_state='restricted',location_id=$2,revision=revision+1 where id=$1",
    [itemId,locId]
  );
  await db.query(
    "insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'quarantine',$4)",
    [itemId,item.location_id,locId,actor.id]
  );
  await audit(db,actor,"quarantine_item","warehouse_items",itemId,{reason:input.reason.trim(),location_id:locId});
  return {id:itemId,identity_state:"quarantined",condition_state:"restricted",location_id:locId,revision:item.revision+1};
}

export async function bindUnmatchedPackageOwner(
  db:DB,
  actor:Actor,
  packageId:string,
  input:{revision:number;receiving_code:string;evidence_ids:string[];reason:string}
) {
  role(actor,"receiver","warehouse_admin","support","super_admin");
  const profile=await one<{user_id:string;org_id:string;receiving_code:string}>(
    db,
    "select user_id,org_id,receiving_code from customer_receiving_profiles where upper(receiving_code)=upper($1)",
    [input.receiving_code.trim()]
  );
  await lock(db,"org:"+profile.org_id);
  const pkg=await one(db,"select * from packages where id=$1 for update",[packageId]);
  revision(pkg.revision,input.revision);
  guard(!pkg.org_id && pkg.state==="unmatched","CLAIM_NOT_AVAILABLE","This parcel already has an assigned owner or is not unmatched.");
  await attachEvidence(db,actor,input.evidence_ids,"label_photo",{org:profile.org_id,package:packageId});
  const address=await one(db,"select * from warehouse_addresses where active and is_default");
  const advice=await one<{id:string}>(
    db,
    "insert into package_advices(user_id,org_id,address_id,address_snapshot) values($1,$2,$3,$4) returning id",
    [profile.user_id,profile.org_id,address.id,address]
  );
  await db.query("update packages set org_id=$2,advice_id=$3,state='checked_in',revision=revision+1 where id=$1",[packageId,profile.org_id,advice.id]);
  await db.query("update warehouse_items set org_id=$2,revision=revision+1 where package_id=$1 and org_id is null",[packageId,profile.org_id]);
  await db.query("update media_assets set org_id=$2 where package_id=$1 and org_id is null",[packageId,profile.org_id]);
  await db.query(
    `update tracking_records set org_id=$2,advice_id=$3,revision=revision+1
     where package_id=$1 and direction='inbound' and closed_at is null`,
    [packageId,profile.org_id,advice.id]
  );
  await db.query(
    `insert into package_claims(id,package_id,applicant_id,evidence_ids,state,reviewed_by,decided_at)
     values($1,$2,$3,$4,'approved',$5,now())`,
    [uuid(),packageId,profile.user_id,input.evidence_ids,actor.id]
  );
  await db.query(
    `update tickets set state='resolved',resolved_at=now(),details=details||$2::jsonb
     where category='identity_unclear' and details->>'package_id'=$1 and state in ('open','waiting_internal')`,
    [packageId,{decision:"approve",reviewed_by:actor.id,reason:input.reason.trim()}]
  );
  await audit(db,actor,"bind_unmatched_package","packages",packageId,{org_id:profile.org_id,receiving_code:profile.receiving_code,reason:input.reason.trim()});
  await event(db,"package.received",{package_id:packageId});
  return {id:packageId,org_id:profile.org_id,receiving_code:profile.receiving_code,state:"checked_in",revision:pkg.revision+1};
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
    await db.query(
      `update tickets set state='resolved',resolved_at=now(),next_action_at=null,revision=revision+1,details=details||$2::jsonb
       where category='identity_unclear' and org_id is null and details->>'package_id'=$1 and state='open'`,
      [match.package_id,{decision:"approve",reviewed_by:actor.id,claim_ticket_id:id}]
    );
    await event(db,"package.received",{package_id:match.package_id});
  }
  await db.query("update tickets set state='resolved',resolved_at=now(),next_action_at=null,revision=revision+1,details=details||$2::jsonb where id=$1",
    [id,{decision,reviewed_by:actor.id}]);
  await db.query(`insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
    values($1,$2,'staff',$3,'internal_note',$4)`,[uuid(),id,actor.id,reason]);
  await audit(db,actor,"decide_intake_claim","tickets",id,{decision});
  return {public_no:ticket.public_no,state:"resolved",decision};
}
