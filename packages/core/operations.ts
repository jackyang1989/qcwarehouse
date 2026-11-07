import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { activatePaidOrder, priceSchema, readyOrder, templateSchema } from "./orders";
import { assertItemNotFrozen, requireSpace } from "./storage";

export async function computeOrderRefundStage(
  db:DB,
  orderId:string,
  opts?:{platform_fault?:boolean;restricted_item?:boolean}
) {
  const o=await one<{id:string;state:string;paid_at:Date|null;price_cents:number|null}>(
    db,
    "select id,state,paid_at,price_cents from orders where id=$1",
    [orderId]
  );
  const {assigned_count,received_pkg_count,started_task_count}=await one<{assigned_count:number;received_pkg_count:number;started_task_count:number}>(
    db,
    `select
       (select count(*)::int from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.unlinked_at is null where l.order_id=$1) assigned_count,
       (select count(*)::int from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id where ao.order_id=$1 and tr.package_id is not null) received_pkg_count,
       (select count(*)::int from order_lines l join inspection_tasks t on t.order_line_id=l.id where l.order_id=$1 and t.state in ('IN_PROGRESS','SUBMITTED','QA_APPROVED')) started_task_count`,
    [orderId]
  );
  const {paid_cents,refundable_cents}=await one<{paid_cents:number;refundable_cents:number}>(
    db,
    `select
       coalesce(sum(p.amount_cents),0)::int paid_cents,
       coalesce(sum(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id and r.state in ('approved','succeeded')),0)),0)::int refundable_cents
     from inspection_quotes q
     join charge_items c on c.inspection_quote_id=q.id
     join payments p on p.charge_item_id=c.id
     where q.order_id=$1 and p.state in ('succeeded','partially_refunded')`,
    [orderId]
  );
  let stage:"before_receipt"|"received_before_inspection"|"inspecting"|"report_published"|"restricted_item";
  let refundableRatio:number;
  let policySummary:string;
  if(opts?.restricted_item) {
    stage="restricted_item";
    refundableRatio=1;
    policySummary="Restricted item unable to inspect: 100% service fee refund";
  } else if(["report_ready","action_pending","closed"].includes(o.state)) {
    stage="report_published";
    refundableRatio=opts?.platform_fault?1:0;
    policySummary=opts?.platform_fault
      ?"Report published with verified platform error: 100% service fee refund"
      :"Report published: 0% standard refund (re-inspection or platform-fault review available)";
  } else if(["inspecting","qa_review"].includes(o.state) || started_task_count>0) {
    stage="inspecting";
    refundableRatio=opts?.platform_fault?1:0.5;
    policySummary=opts?.platform_fault
      ?"Inspection in progress with platform fault: 100% service fee refund"
      :"Inspection in progress (before report publication): 50% service fee refund";
  } else if(assigned_count>0 || received_pkg_count>0) {
    stage="received_before_inspection";
    refundableRatio=1;
    policySummary="Received at warehouse before inspection starts: 100% service fee refund (outbound shipping billed separately)";
  } else {
    stage="before_receipt";
    refundableRatio=1;
    policySummary="Before warehouse receipt: 100% service fee refund";
  }
  const recommendedRefundCents=Math.min(refundable_cents,Math.round(paid_cents*refundableRatio));
  return {
    order_id:o.id,
    state:o.state,
    stage,
    refundable_ratio:refundableRatio,
    refund_rate_pct:Math.round(refundableRatio*100),
    paid_cents,
    already_refunded_cents:Math.max(0,paid_cents-refundable_cents),
    refundable_cents,
    recommended_refund_cents:recommendedRefundCents,
    policy_summary:policySummary,
    assigned_count,
    started_task_count,
  };
}

export async function cancelOrder(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const o=await one(db,"select * from orders where id=$1 and org_id=$2 for update",[id,org]);
  revision(o.revision,rev);
  guard(["draft","awaiting_payment","awaiting_samples","queued","inspecting","qa_review","on_hold"].includes(o.state),
    "CANCELLATION_UNAVAILABLE","Contact support about an already completed order.");
  const preview=o.paid_at?await computeOrderRefundStage(db,id):null;
  await db.query(`update charge_items c set voided_at=now() from inspection_quotes q where q.id=c.inspection_quote_id
    and q.order_id=$1 and c.applied_payment_id is null and c.voided_at is null`,[id]);
  await db.query(`update inspection_tasks t set state='VOID',revision=t.revision+1 from order_lines l
    where l.id=t.order_line_id and l.order_id=$1 and t.state<>'QA_APPROVED'`,[id]);
  await db.query(`update reference_reservations r set released_at=now() from inspection_groups g,order_lines l
    where r.group_id=g.id and g.order_line_id=l.id and l.order_id=$1 and r.released_at is null`,[id]);
  await db.query("update order_blocks set resolved_at=now() where order_id=$1 and resolved_at is null",[id]);
  await db.query("update orders set state='cancelled',held_at=null,held_from_state=null,hold_reason=null,revision=revision+1 where id=$1",[id]);
  if(o.paid_at && preview) {
    await db.query(
      `insert into tickets(id,public_no,org_id,order_id,category,subject,details)
       values($1,$2,$3,$4,'payment_refund','Review cancellation and refundable amount',$5)`,
      [
        uuid(),
        code("C-"),
        org,
        id,
        {
          stage:preview.stage,
          refundable_ratio:preview.refundable_ratio,
          recommended_refund_cents:preview.recommended_refund_cents,
          paid_cents:preview.paid_cents,
        },
      ]
    );
  }
  await audit(db,actor,"cancel_order","orders",id,preview?{stage:preview.stage,recommended_refund_cents:preview.recommended_refund_cents}:undefined);
  await event(db,"order.cancelled",{order_id:id});
  return {
    state:"cancelled",
    ...(preview?{
      refund_stage:preview.stage,
      refundable_ratio:preview.refundable_ratio,
      recommended_refund_cents:preview.recommended_refund_cents,
    }:{}),
  };
}

export async function requestOrderAfterSales(
  db:DB,
  actor:Actor,
  orderId:string,
  input:{
    kind?:"re_inspect"|"service_refund";
    resolution_type?:"re_inspect"|"service_refund";
    reason:string;
    platform_fault?:boolean;
    restricted_item?:boolean;
  }
) {
  const kind=input.kind??input.resolution_type??"service_refund";
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null) role(actor,"support","super_admin");
  const o=await one<{id:string;org_id:string;state:string}>(
    db,
    "select id,org_id,state from orders where id=$1 and ($2::uuid is null or org_id=$2)",
    [orderId,org]
  );
  await lock(db,"org:"+o.org_id);
  if(kind==="re_inspect") {
    guard(["report_ready","action_pending"].includes(o.state),"REINSPECT_UNAVAILABLE","Re-inspection is only available after a report has been published.");
  }
  const preview=await computeOrderRefundStage(db,orderId,{
    platform_fault:input.platform_fault,
    restricted_item:input.restricted_item,
  });
  const ticketId=uuid(),publicNo=code("TKT-");
  const category=kind==="re_inspect"?"measurement_dispute":"payment_refund";
  const subject=kind==="re_inspect"?"After-sales re-inspection request":"Stage-based service refund request";
  await db.query(
    `insert into tickets(id,public_no,org_id,order_id,category,state,subject,details,next_action_at)
     values($1,$2,$3,$4,$5,'open',$6,$7,now()+interval '24 hours')`,
    [
      ticketId,
      publicNo,
      o.org_id,
      orderId,
      category,
      subject,
      {
        after_sales_kind:kind,
        reason:input.reason.trim(),
        platform_fault:Boolean(input.platform_fault),
        restricted_item:Boolean(input.restricted_item),
        stage:preview.stage,
        refundable_ratio:preview.refundable_ratio,
        recommended_refund_cents:preview.recommended_refund_cents,
      },
    ]
  );
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
     values($1,$2,$3,$4,'message',$5)`,
    [uuid(),ticketId,actor.kind==="staff"?"staff":"customer",actor.id,input.reason.trim()]
  );
  await audit(db,actor,"request_order_after_sales","orders",orderId,{
    ticket_id:ticketId,
    kind,
    stage:preview.stage,
    recommended_refund_cents:preview.recommended_refund_cents,
  });
  return {
    ticket_id:ticketId,
    public_no:publicNo,
    ticket_no:publicNo,
    kind,
    resolution_type:kind,
    ...preview,
  };
}
export async function holdOrder(db:DB,actor:Actor,id:string,reason:string) {
  role(actor,"receiver","warehouse_admin","inspector","reviewer","support","finance","template_admin","super_admin");
  const initial=await one(db,"select org_id from orders where id=$1",[id]);
  await lock(db,"org:"+initial.org_id);
  const o=await one(db,"select * from orders where id=$1 for update",[id]);
  if(o.state==="on_hold") return {id:o.id,state:"on_hold",revision:o.revision,held_from_state:o.held_from_state};
  guard(["draft","awaiting_payment","awaiting_samples","queued","inspecting","qa_review"].includes(o.state),
    "ORDER_HOLD_UNAVAILABLE","This order cannot be placed on hold.");
  const updated=await one(db,`update orders set state='on_hold',held_at=now(),held_from_state=state,hold_reason=$2,revision=revision+1
    where id=$1 returning id,state,revision,held_from_state`,[id,reason.trim()]);
  await db.query(`insert into order_blocks(id,order_id,reason,object_key,opened_at)
    values($1,$2,'staff_hold','order',now())
    on conflict(order_id,reason,object_key) where resolved_at is null do nothing`,[uuid(),id]);
  await audit(db,actor,"hold_order","orders",id,{reason:reason.trim(),from_state:o.state});
  await event(db,"order.held",{order_id:id});
  return updated;
}
export async function resumeOrder(db:DB,actor:Actor,id:string,reason:string) {
  role(actor,"receiver","warehouse_admin","inspector","reviewer","support","finance","template_admin","super_admin");
  const initial=await one(db,"select org_id from orders where id=$1",[id]);
  await lock(db,"org:"+initial.org_id);
  const o=await one(db,"select * from orders where id=$1 for update",[id]);
  guard(o.state==="on_hold" && o.held_from_state,"ORDER_NOT_ON_HOLD","This order is not currently on hold.");
  await db.query("update order_blocks set resolved_at=now() where order_id=$1 and reason='staff_hold' and resolved_at is null",[id]);
  const openBlocks=(await db.query("select reason from order_blocks where order_id=$1 and resolved_at is null",[id])).rowCount;
  guard(!openBlocks,"ORDER_BLOCKED","Resolve all active order blocks before resuming.");
  const fromState=o.held_from_state as string;
  const paidWhileHeld=fromState==="awaiting_payment" && o.submission_snapshot?.quote_id &&
    (await db.query(`select 1 from charge_items where inspection_quote_id=$1 and voided_at is null
      and (applied_payment_id is not null or free_authorization is not null)`,[o.submission_snapshot.quote_id])).rowCount;
  await db.query(`update orders set state=$2,
    sla_due_at=case when sla_due_at is not null and held_at is not null then sla_due_at+greatest(now()-held_at,interval '0 seconds') else sla_due_at end,
    held_at=null,held_from_state=null,hold_reason=null,revision=revision+1 where id=$1`,[id,fromState]);
  if(paidWhileHeld) {
    await activatePaidOrder(db,id);
  } else if(fromState==="awaiting_samples") {
    await readyOrder(db,id);
  }
  const updated=await one(db,"select id,state,revision,sla_due_at from orders where id=$1",[id]);
  await audit(db,actor,"resume_order","orders",id,{reason:reason.trim(),resumed_state:updated.state});
  await event(db,"order.resumed",{order_id:id});
  return updated;
}
export async function setAddress(
  db:DB,
  actor:Actor,
  data:{address_zh:string;address_en:string;contact_name:string;contact_phone:string;is_default?:boolean}
) {
  role(actor,"super_admin");
  await lock(db,"warehouse_default_address");
  const isDefault=data.is_default!==false;
  if(isDefault) {
    await db.query("update warehouse_addresses set is_default=false where is_default");
  }
  const a=await one<{id:string;is_default:boolean;active:boolean}>(
    db,
    `insert into warehouse_addresses(id,address_zh,address_en,contact_name,contact_phone,active,is_default)
     values($1,$2,$3,$4,$5,true,$6)
     returning id,is_default,active`,
    [uuid(),data.address_zh,data.address_en,data.contact_name,data.contact_phone,isDefault]
  );
  await audit(db,actor,isDefault?"set_default_address":"create_warehouse_address","warehouse_addresses",a.id,{is_default:a.is_default,active:a.active});
  return a;
}

export async function updateWarehouseAddress(
  db:DB,
  actor:Actor,
  id:string,
  input:{is_default?:boolean;active?:boolean}
) {
  role(actor,"super_admin");
  await lock(db,"warehouse_default_address");
  const addr=await one<{id:string;is_default:boolean;active:boolean}>(
    db,
    "select id,is_default,active from warehouse_addresses where id=$1 for update",
    [id]
  );
  if(input.is_default===true) {
    await db.query("update warehouse_addresses set is_default=false where is_default and id<>$1",[id]);
    const updated=await one<{id:string;is_default:boolean;active:boolean}>(
      db,
      "update warehouse_addresses set active=true,is_default=true where id=$1 returning id,is_default,active",
      [id]
    );
    await audit(db,actor,"set_default_address","warehouse_addresses",id,{is_default:true,active:true});
    return updated;
  }
  if(input.active===false) {
    guard(!addr.is_default,"DEFAULT_ADDRESS_REQUIRED","Promote another warehouse address to default before deactivating the current default address.",409);
    const updated=await one<{id:string;is_default:boolean;active:boolean}>(
      db,
      "update warehouse_addresses set active=false where id=$1 returning id,is_default,active",
      [id]
    );
    await audit(db,actor,"deactivate_warehouse_address","warehouse_addresses",id,{is_default:false,active:false});
    return updated;
  }
  if(input.active===true && !addr.active) {
    const updated=await one<{id:string;is_default:boolean;active:boolean}>(
      db,
      "update warehouse_addresses set active=true where id=$1 returning id,is_default,active",
      [id]
    );
    await audit(db,actor,"activate_warehouse_address","warehouse_addresses",id,{is_default:updated.is_default,active:true});
    return updated;
  }
  return addr;
}

export async function updateBusinessCalendar(
  db:DB,
  actor:Actor,
  input:{holidays:string[];extra_workdays?:string[]}
) {
  role(actor,"super_admin");
  const holidays=[...new Set(input.holidays.map(d=>d.trim()).filter(Boolean))].sort();
  const extraWorkdays=[...new Set((input.extra_workdays??[]).map(d=>d.trim()).filter(Boolean))].sort();
  await db.query(
    `insert into app_config(key,value,updated_by,updated_at)
     values('calendar.holidays',$1::jsonb,$2,now())
     on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,
    [JSON.stringify(holidays),actor.id]
  );
  await db.query(
    `insert into app_config(key,value,updated_by,updated_at)
     values('calendar.extra_workdays',$1::jsonb,$2,now())
     on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,
    [JSON.stringify(extraWorkdays),actor.id]
  );
  await audit(db,actor,"update_business_calendar","app_config",null,{
    count:holidays.length,
    days:extraWorkdays.length,
  });
  return {holidays,extra_workdays:extraWorkdays};
}

export async function createTermsVersion(
  db:DB,
  actor:Actor,
  input:{
    kind:"terms"|"privacy"|"restricted_items"|"report_notice";
    version:string;
    content_md:string;
    publish_now?:boolean;
  }
) {
  role(actor,"super_admin");
  await lock(db,"terms:"+input.kind);
  const contentMd=input.content_md.trim();
  const contentHash=hash(contentMd);
  const publishNow=Boolean(input.publish_now);
  const row=await one<{
    id:string;
    kind:string;
    version:string;
    effective_at:Date|null;
    content_hash:string;
  }>(
    db,
    `insert into terms_versions(id,kind,version,effective_at,content_md,content_hash)
     values($1,$2,$3,case when $4 then now() else null end,$5,$6)
     returning id,kind,version,effective_at,content_hash`,
    [uuid(),input.kind,input.version.trim(),publishNow,contentMd,contentHash]
  );
  await audit(db,actor,publishNow?"publish_terms_version":"create_terms_version","terms_versions",row.id,{
    kind:row.kind,
    version:row.version,
    active:publishNow,
  });
  return {
    ...row,
    state:row.effective_at?"published":"draft",
  };
}

export async function publishTermsVersion(db:DB,actor:Actor,id:string) {
  role(actor,"super_admin");
  const existing=await one<{id:string;kind:string;version:string;effective_at:Date|null}>(
    db,
    "select id,kind,version,effective_at from terms_versions where id=$1 for update",
    [id]
  );
  await lock(db,"terms:"+existing.kind);
  const updated=await one<{id:string;kind:string;version:string;effective_at:Date;content_hash:string}>(
    db,
    "update terms_versions set effective_at=coalesce(effective_at,now()) where id=$1 returning id,kind,version,effective_at,content_hash",
    [id]
  );
  await audit(db,actor,"publish_terms_version","terms_versions",id,{
    kind:updated.kind,
    version:updated.version,
    active:true,
  });
  return {
    ...updated,
    state:"published",
  };
}
export async function newTemplate(db:DB,actor:Actor,input:{template_key:string;category_id:string;service_type_id:string;content:unknown;capability_ids:string[]}) {
  role(actor,"template_admin","super_admin");
  const content=templateSchema.parse(input.content);
  await lock(db,"template:"+input.template_key);
  const v=await one<{n:number}>(db,"select coalesce(max(version),0)::int+1 n from template_versions where template_key=$1",[input.template_key]);
  const t=await one(db,`insert into template_versions(template_key,category_id,service_type_id,version,content,content_hash,state,author_id)
    values($1,$2,$3,$4,$5,$6,'IN_REVIEW',$7) returning id,version,state`,[input.template_key,input.category_id,input.service_type_id,v.n,content,hash(JSON.stringify(content)),actor.id]);
  for(const id of input.capability_ids) {
    await one(db,"select id from capabilities where id=$1 and approved_by is not null and revoked_at is null",[id]);
    await db.query("insert into template_capabilities values($1,$2)",[t.id,id]);
  }
  await audit(db,actor,"submit_template","template_versions",t.id);
  return t;
}
export async function publishTemplate(db:DB,actor:Actor,id:string) {
  role(actor,"reviewer","super_admin");
  const t=await one(db,"select * from template_versions where id=$1 for update",[id]);
  guard(t.state==="IN_REVIEW" && t.author_id!==actor.id,"SELF_REVIEW_FORBIDDEN","Independent template review is required.");
  const caps=(await db.query(`select c.approved_by,c.revoked_at from template_capabilities t join capabilities c on c.id=t.capability_id where t.template_version_id=$1`,[id])).rows;
  guard(caps.length && caps.every(c=>c.approved_by&&!c.revoked_at),"CAPABILITY_UNAVAILABLE","Approve the required capabilities first.");
  await db.query("update template_versions set reviewer_id=$2,state='PUBLISHED',published_at=now() where id=$1",[id,actor.id]);
  await audit(db,actor,"publish_template","template_versions",id);
  return {id,state:"PUBLISHED"};
}
export async function createCapability(db:DB,actor:Actor,input:{code:string;method:string;approval?:Record<string,unknown>}) {
  role(actor,"template_admin","super_admin");
  await lock(db,"capability:"+input.code);
  const cap=await one<{id:string;code:string;method:string}>(db,`insert into capabilities(id,code,method,approval,approved_by)
    values($1,$2,$3,$4,null) returning id,code,method`,
    [uuid(),input.code,input.method,{...(input.approval??{}),author_id:actor.id,submitted_at:new Date().toISOString()}]);
  await audit(db,actor,"create_capability","capabilities",cap.id,{code:cap.code});
  return {...cap,state:"pending_approval"};
}
export async function approveCapability(db:DB,actor:Actor,id:string) {
  role(actor,"reviewer","super_admin");
  const cap=await one(db,"select * from capabilities where id=$1 for update",[id]);
  guard(!cap.revoked_at,"CAPABILITY_UNAVAILABLE","Revoked capabilities cannot be approved.");
  guard(cap.approval?.author_id!==actor.id,"SELF_REVIEW_FORBIDDEN","Independent capability approval is required.");
  await db.query("update capabilities set approved_by=$2 where id=$1",[id,actor.id]);
  await audit(db,actor,"approve_capability","capabilities",id,{code:cap.code});
  return {id,code:cap.code,state:"approved"};
}
export async function revokeCapability(db:DB,actor:Actor,id:string,reason:string) {
  role(actor,"super_admin");
  const cap=await one(db,"select * from capabilities where id=$1 for update",[id]);
  await db.query(`update capabilities set revoked_at=now(),
    approval=approval||jsonb_build_object('revoked_by',$2::uuid,'revoked_reason',$3::text) where id=$1`,[id,actor.id,reason.trim()]);
  await audit(db,actor,"revoke_capability","capabilities",id,{code:cap.code,reason:reason.trim()});
  return {id,code:cap.code,state:"revoked"};
}
export async function createCategory(db:DB,actor:Actor,input:{slug:string;labels:{en:string;"zh-CN":string};parent_id?:string}) {
  role(actor,"template_admin","super_admin");
  await lock(db,"category:"+input.slug);
  const cat=await one(db,`insert into categories(id,slug,parent_id,labels,status,admission_snapshot)
    values($1,$2,$3,$4,'PLANNED',null) returning id,slug,labels,status,revision`,
    [uuid(),input.slug,input.parent_id??null,input.labels]);
  await audit(db,actor,"create_category","categories",cat.id,{code:cat.slug});
  return cat;
}
export async function updateCategoryStatus(db:DB,actor:Actor,id:string,input:{
  status:"PLANNED"|"ACTIVE"|"PAUSED"|"RESTRICTED"|"RETIRED";
  admission_snapshot?:Record<string,unknown>;
}) {
  role(actor,"super_admin");
  const cat=await one(db,"select * from categories where id=$1 for update",[id]);
  const nextAdmission=input.admission_snapshot?{...(cat.admission_snapshot??{}),...input.admission_snapshot}:cat.admission_snapshot;
  if(input.status==="ACTIVE") {
    const missing:string[]=[];
    if(typeof nextAdmission?.sop_ref!=="string" || !nextAdmission.sop_ref.trim()) missing.push("sop_ref");
    if(nextAdmission?.training_completed!==true) missing.push("training_completed");
    if(nextAdmission?.equipment_verified!==true) missing.push("equipment_verified");
    if(typeof nextAdmission?.pilot_evidence!=="string" || !nextAdmission.pilot_evidence.trim()) missing.push("pilot_evidence");
    guard(missing.length===0,"CATEGORY_ADMISSION_INCOMPLETE",
      `Category admission requires SOP, training, equipment verification, and pilot evidence (missing: ${missing.join(", ")}).`,422);
    const publishedTpl=(await db.query(`
      select t.id from template_versions t where t.category_id=$1 and t.state='PUBLISHED'
        and exists(select 1 from template_capabilities tc where tc.template_version_id=t.id)
        and not exists(select 1 from template_capabilities tc join capabilities cap on cap.id=tc.capability_id
          where tc.template_version_id=t.id and (cap.revoked_at is not null or cap.approved_by is null))
      limit 1`,[id])).rowCount;
    guard(publishedTpl,"CATEGORY_ADMISSION_INCOMPLETE","Category activation requires at least one published template with approved capabilities.",422);
  }
  const updated=await one(db,`update categories set status=$2,admission_snapshot=$3,revision=revision+1
    where id=$1 returning id,slug,labels,status,revision,admission_snapshot`,[id,input.status,nextAdmission]);
  await audit(db,actor,"update_category_status","categories",id,{code:cat.slug,active:input.status==="ACTIVE"});
  return updated;
}
export async function publishSkuPrice(db:DB,actor:Actor,skuCode:string,input:{rules:z.infer<typeof priceSchema>}) {
  role(actor,"super_admin");
  const rules=priceSchema.parse(input.rules);
  const offer=await one<{id:string;sku_code:string}>(db,"select id,sku_code from service_offers where sku_code=$1 for update",[skuCode]);
  const next=await one<{n:number}>(db,"select coalesce(max(version),0)::int+1 n from sku_prices where offer_id=$1",[offer.id]);
  await db.query("update sku_prices set effective_to=now() where offer_id=$1 and (effective_to is null or effective_to>now())",[offer.id]);
  const price=await one<{id:string;version:number}>(db,`insert into sku_prices(id,offer_id,version,currency,rules,effective_from)
    values($1,$2,$3,'USD',$4,now()) returning id,version`,[uuid(),offer.id,next.n,rules]);
  await audit(db,actor,"publish_sku_price","service_offers",offer.id,{code:offer.sku_code,version:price.version});
  return {id:price.id,offer_id:offer.id,sku_code:offer.sku_code,version:price.version,rules};
}
export async function upsertOffer(db:DB,actor:Actor,input:{
  sku_code:string;category_id:string;service_type_id:string;template_version_id:string;
  title:{en:string;"zh-CN":string};enabled?:boolean;rules:z.infer<typeof priceSchema>;
}) {
  role(actor,"super_admin");
  const tpl=await one(db,"select * from template_versions where id=$1 and category_id=$2 and service_type_id=$3",
    [input.template_version_id,input.category_id,input.service_type_id]);
  guard(tpl.state==="PUBLISHED","TEMPLATE_NOT_PUBLISHED","Only published templates can be bound to a purchasable offer.");
  const offer=await one<{id:string;sku_code:string;enabled:boolean}>(db,`
    insert into service_offers(id,sku_code,service_type_id,title,enabled)
    values($1,$2,$3,$4,$5)
    on conflict(sku_code) do update set title=excluded.title,enabled=excluded.enabled
    returning id,sku_code,enabled`,[uuid(),input.sku_code,input.service_type_id,input.title,input.enabled??true]);
  await db.query(`insert into offer_templates(offer_id,category_id,service_type_id,template_version_id)
    values($1,$2,$3,$4) on conflict do nothing`,[offer.id,input.category_id,input.service_type_id,input.template_version_id]);
  const price=await publishSkuPrice(db,actor,offer.sku_code,{rules:input.rules});
  await audit(db,actor,"publish_offer","service_offers",offer.id,{code:offer.sku_code,version:price.version});
  return {...offer,price_version:price.id,version:price.version};
}
export const orderCaseCategory=z.enum(["receipt_mismatch","measurement_dispute","return_info_incomplete","damage_or_loss","payment_refund"]);
export async function reportIssue(db:DB,actor:Actor,subject:string,message:string,orderId?:string,category?:z.infer<typeof orderCaseCategory>) {
  const org=organization(actor);
  guard(!category||orderId,"ORDER_REQUIRED","Select an order for this type of support case.",422);
  if(orderId) await one(db,"select id from orders where id=$1 and org_id=$2",[orderId,org]);
  const id=uuid();
  const ticket=await one(db,`insert into tickets(id,public_no,org_id,order_id,category,subject,next_action_at)
    values($1,$2,$3,$4,$5,$6,now()+interval '24 hours') returning id,public_no,state`,
    [id,code("C-"),org,orderId??null,category??"non_standard_quote",subject]);
  await db.query("insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body) values($1,$2,'customer',$3,'message',$4)",[uuid(),id,actor.id,message]);
  await audit(db,actor,"create_ticket","tickets",id);
  return ticket;
}
export async function moveItem(db:DB,actor:Actor,id:string,rev:number,location:string) {
  role(actor,"receiver","warehouse_admin");
  const initial=await one(db,"select org_id from warehouse_items where id=$1",[id]);
  if(initial.org_id) await lock(db,"org:"+initial.org_id);
  const w=await one(db,"select * from warehouse_items where id=$1 for update",[id]);
  revision(w.revision,rev);
  guard(["stored","received"].includes(w.custody_state),"ITEM_UNAVAILABLE","This item is not in storage.");
  await assertItemNotFrozen(db,[id],"ITEM_UNAVAILABLE");
  guard(w.location_id!==location,"LOCATION_UNCHANGED","Choose a different storage location.");
  await requireSpace(db,location,1);
  await db.query("update warehouse_items set location_id=$2,revision=revision+1 where id=$1",[id,location]);
  await db.query("insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'move',$4)",[id,w.location_id,location,actor.id]);
  await audit(db,actor,"move_item","warehouse_items",id,{location_id:location});
  return {id,revision:rev+1};
}
export type ScopeAddition={order_line_id:string;count:number;declared_fields?:Record<string,unknown>[]};
export async function scopeProposal(
  db:DB,
  actor:Actor,
  id:string,
  input:{revision:number;reason:string;positions:string[];additions?:ScopeAddition[]}
) {
  if(actor.kind==="staff") role(actor,"support","super_admin");
  const first=await one(db,"select org_id from orders where id=$1 and ($2::uuid is null or org_id=$2)",[id,actor.org]);
  await lock(db,"org:"+first.org_id);
  const o=await one(db,"select * from orders where id=$1 for update",[id]);
  revision(o.revision,input.revision);
  guard(o.state==="awaiting_samples","SCOPE_UNAVAILABLE","Scope can change before inspection begins.");
  const allPositions=(await db.query<{id:string;order_line_id:string;in_scope:boolean;options:unknown;service:string}>(
    `select e.id,e.order_line_id,e.in_scope,l.options,st.code service
     from expected_items e join order_lines l on l.id=e.order_line_id
     join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
     where l.order_id=$1`,
    [id]
  )).rows;
  const currentInScope=allPositions.filter(p=>p.in_scope);
  const currentInScopeIds=new Set(currentInScope.map(p=>p.id));
  const ids=new Set(input.positions);
  const additions=(input.additions??[]).filter(a=>a.count>0);
  const hasAdditions=additions.length>0;
  const changedPositions=ids.size!==currentInScopeIds.size || [...ids].some(pid=>!currentInScopeIds.has(pid));
  guard(
    ids.size===input.positions.length &&
      (changedPositions || hasAdditions) &&
      input.positions.every(p=>allPositions.some(x=>x.id===p)),
    "SCOPE_UNAVAILABLE",
    "Choose the exact set of items to retain or add."
  );
  const base=o.submission_snapshot.lines as {order_line_id:string;quantity:number;amount_cents:number;business_days?:number}[];
  const addByLine=new Map<string,ScopeAddition>();
  for(const add of additions) {
    guard(!addByLine.has(add.order_line_id) && base.some(l=>l.order_line_id===add.order_line_id),
      "SCOPE_UNAVAILABLE","Specify valid order lines for added positions.",422);
    addByLine.set(add.order_line_id,add);
  }
  let adjustment=0;
  for(const l of base) {
    const lineAll=allPositions.filter(x=>x.order_line_id===l.order_line_id);
    const existing=lineAll.filter(x=>x.in_scope);
    const next=lineAll.filter(x=>ids.has(x.id)).length;
    const addCount=addByLine.get(l.order_line_id)?.count??0;
    if(next===existing.length && addCount===0) continue;
    guard(lineAll[0]?.service==="inspection","SCOPE_REVIEW_REQUIRED","A comparison or reference scope change requires staff pricing.");
    const unitCents=Math.floor(l.amount_cents/l.quantity);
    adjustment+=(next-existing.length+addCount)*unitCents;
  }
  const seq=await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from scope_revisions where order_id=$1",[id]);
  const row=await one(db,`insert into scope_revisions(id,order_id,revision,previous_snapshot,proposed_snapshot,reason,adjustment_cents)
    values($1,$2,$3,$4,$5,$6,$7) returning id as scope_revision_id,adjustment_cents,revision`,
    [
      uuid(),
      id,
      seq.n,
      {positions:currentInScope.map(x=>x.id),order_revision:o.revision},
      {positions:input.positions,...(hasAdditions?{additions}:{})},
      input.reason,
      adjustment,
    ]);
  await audit(db,actor,"propose_scope","orders",id,{scope_revision_id:row.scope_revision_id,adjustment_cents:adjustment});
  return row;
}
export async function scopeReview(db:DB,actor:Actor,id:string) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null)role(actor,"support","super_admin");
  const order=await one<{id:string;revision:number;state:string;public_no:string;hold_reason:string|null}>(db,
    "select id,revision,state,public_no,hold_reason from orders where id=$1 and ($2::uuid is null or org_id=$2)",[id,org]);
  const positions=(await db.query(`select e.id,e.position,e.in_scope,e.declared_fields,l.id line_id,s.title,st.code service,
    w.id item_id,w.code item_code,w.identity_state
    from expected_items e join order_lines l on l.id=e.order_line_id join service_offers s on s.id=l.offer_id
    join service_types st on st.id=s.service_type_id
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id and w.org_id=l.org_id
    where l.order_id=$1 order by l.id,e.position`,[id])).rows;
  const proposals=(await db.query(`select s.id,s.revision,s.reason,s.adjustment_cents,s.accepted_at,
    s.previous_snapshot->'positions' previous_positions,s.proposed_snapshot->'positions' proposed_positions,
    coalesce(s.proposed_snapshot->'additions','[]'::jsonb) proposed_additions,
    case when s.accepted_at is not null then 'accepted'
      when $2='awaiting_samples' and s.previous_snapshot->>'order_revision'=$3::text then 'pending' else 'stale' end state,
    (select jsonb_build_object('id',k.id,'state',k.state) from tickets k
      where k.order_id=s.order_id and k.category='payment_refund' and k.details->>'scope_revision_id'=s.id::text
      order by k.created_at desc limit 1) refund_case,
    (select jsonb_build_object(
      'id',c.id,'amount_cents',c.amount_cents,'quote_revision',q.revision,'expires_at',q.expires_at,
      'paid',c.applied_payment_id is not null or c.free_authorization is not null,
      'voided',c.voided_at is not null
    ) from charge_items c join inspection_quotes q on q.id=c.inspection_quote_id
      where c.scope_revision_id=s.id limit 1) supplemental_charge
    from scope_revisions s where s.order_id=$1 order by s.revision desc`,[id,order.state,order.revision])).rows;
  return {order,positions,proposals};
}

export async function applyScopePositionsAndAdditions(
  db:DB,
  orderId:string,
  previousPositions:string[],
  proposedPositions:string[],
  additions:ScopeAddition[]=[]
) {
  const dropped=previousPositions.filter((p:string)=>!proposedPositions.includes(p));
  if(dropped.length) {
    await db.query("update expected_items set in_scope=false where id=any($1::uuid[])",[dropped]);
    await db.query("update order_line_item_links set unlinked_at=now(),reason='scope_reduced' where expected_item_id=any($1::uuid[]) and unlinked_at is null",[dropped]);
  }
  const restored=proposedPositions.filter((p:string)=>!previousPositions.includes(p));
  if(restored.length) {
    await db.query("update expected_items set in_scope=true where id=any($1::uuid[])",[restored]);
  }
  for(const add of additions) {
    if(!add.count || add.count<=0) continue;
    const maxPos=await one<{m:number}>(db,"select coalesce(max(position),0)::int m from expected_items where order_line_id=$1",[add.order_line_id]);
    for(let i=0;i<add.count;i++) {
      const pos=maxPos.m+i+1;
      const fields=(add.declared_fields?.[i]??{}) as Record<string,unknown>;
      await db.query(
        "insert into expected_items(order_line_id,position,declared_fields,in_scope) values($1,$2,$3,true)",
        [add.order_line_id,pos,JSON.stringify({position:pos,sample_code:fields.sample_code??`ADD-P${String(pos).padStart(2,"0")}`,...fields})]
      );
    }
    await db.query("update order_lines set quantity=quantity+$2 where id=$1",[add.order_line_id,add.count]);
  }
}

export async function acceptScope(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const row=await one(db,`select s.*,o.revision order_revision,o.state,o.submission_snapshot from scope_revisions s join orders o on o.id=s.order_id where s.id=$1 and o.org_id=$2 for update of s,o`,[id,org]);
  revision(row.revision,rev);
  guard(!row.accepted_at && row.state==="awaiting_samples" && row.previous_snapshot.order_revision===row.order_revision,
    "SCOPE_UNAVAILABLE","This scope proposal is no longer applicable.");
  await db.query(
    `update charge_items set voided_at=now()
     where scope_revision_id in (select id from scope_revisions where order_id=$1)
       and applied_payment_id is null and voided_at is null`,
    [row.order_id]
  );
  await db.query(
    "update order_blocks set resolved_at=now() where order_id=$1 and reason='scope_payment_pending' and resolved_at is null",
    [row.order_id]
  );
  const additions=(Array.isArray(row.proposed_snapshot.additions)?row.proposed_snapshot.additions:[]) as ScopeAddition[];
  if(row.adjustment_cents>0) {
    await db.query("update scope_revisions set accepted_at=now(),accepted_by=$2 where id=$1",[id,actor.id]);
    const nextQuote=await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from inspection_quotes where order_id=$1",[row.order_id]);
    const quote=await one<{id:string;revision:number;expires_at:string}>(
      db,
      `insert into inspection_quotes(id,order_id,revision,line_snapshot,terms_snapshot,amount_cents,currency,expires_at,accepted_at)
       values($1,$2,$3,$4,$5,$6,'USD',now()+interval '30 minutes',now())
       returning id,revision,expires_at`,
      [
        uuid(),
        row.order_id,
        nextQuote.n,
        JSON.stringify(row.submission_snapshot?.lines??[]),
        JSON.stringify({scope_revision_id:id,order_revision:row.order_revision}),
        row.adjustment_cents,
      ]
    );
    const charge=await one<{id:string}>(
      db,
      `insert into charge_items(id,org_id,purpose,inspection_quote_id,scope_revision_id,amount_cents,currency,snapshot)
       values($1,$2,'inspection',$3,$4,$5,'USD',$6)
       returning id`,
      [uuid(),org,quote.id,id,row.adjustment_cents,{order_id:row.order_id,scope_revision_id:id,quote_revision:quote.revision}]
    );
    await db.query(
      `insert into order_blocks(id,order_id,reason,object_key,opened_at)
       values($1,$2,'scope_payment_pending',$3,now())
       on conflict(order_id,reason,object_key) where resolved_at is null do nothing`,
      [uuid(),row.order_id,id]
    );
    await audit(db,actor,"accept_upward_scope","orders",row.order_id,{scope_revision_id:id,charge_item_id:charge.id,amount_cents:row.adjustment_cents});
    return {
      scope_revision_id:id,
      state:"awaiting_supplemental_payment",
    };
  }
  await applyScopePositionsAndAdditions(db,row.order_id,row.previous_snapshot.positions,row.proposed_snapshot.positions,additions);
  await db.query("update scope_revisions set accepted_at=now(),accepted_by=$2 where id=$1",[id,actor.id]);
  await db.query("update orders set revision=revision+1 where id=$1",[row.order_id]);
  if(row.adjustment_cents<0) await db.query(`insert into tickets(id,public_no,org_id,order_id,category,subject,details)
    values($1,$2,$3,$4,'payment_refund','Scope reduction refund review',$5)`,[uuid(),code("C-"),org,row.order_id,{scope_revision_id:id,amount_cents:-row.adjustment_cents}]);
  await audit(db,actor,"accept_scope","orders",row.order_id,{scope_revision_id:id});
  await readyOrder(db,row.order_id);
  return {scope_revision_id:id,state:"accepted"};
}

export async function respondOrderMismatch(
  db:DB,
  actor:Actor,
  orderId:string,
  input:{
    revision?:number;
    expected_item_id?:string;
    sample_label?:string;
    item_id?:string;
    decision:"proceed_as_received"|"replace_sample"|"return_sample";
    note?:string;
  }
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const order=await one(db,"select * from orders where id=$1 and org_id=$2 for update",[orderId,org]);
  if(input.revision!==undefined) revision(order.revision,input.revision);
  guard(["awaiting_samples","on_hold"].includes(order.state),"ORDER_NOT_EDITABLE","Mismatch responses can only be submitted before inspection begins.");
  const candidates=(await db.query<{
    expected_item_id:string;
    position:number;
    declared_fields:Record<string,unknown>;
    order_line_id:string;
    assignment_id:string;
    item_id:string;
    item_code:string;
    identity_state:string;
  }>(
    `select e.id as expected_item_id,e.position,e.declared_fields,l.id as order_line_id,
            a.id as assignment_id,w.id as item_id,w.code as item_code,w.identity_state
     from order_lines l
     join expected_items e on e.order_line_id=l.id and e.in_scope
     join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
     join warehouse_items w on w.id=a.item_id
     where l.order_id=$1
     order by l.id,e.position`,
    [orderId]
  )).rows;
  const label=(input.sample_label??"").trim();
  const target=candidates.find(c=>{
    if(input.expected_item_id && c.expected_item_id===input.expected_item_id) return true;
    if(input.item_id && c.item_id===input.item_id) return true;
    if(label && (c.item_code===label || c.declared_fields?.sample_code===label || c.declared_fields?.label===label || String(c.position)===label)) return true;
    return false;
  }) ?? (candidates.filter(c=>c.identity_state==="mismatch").length===1?candidates.find(c=>c.identity_state==="mismatch"):undefined);
  guard(target,"MISMATCH_NOT_FOUND","Select the mismatched sample position to respond to.",422);
  const blockCount=(await db.query(
    "select 1 from order_blocks where order_id=$1 and reason='identity_mismatch' and object_key=$2 and resolved_at is null",
    [orderId,target.expected_item_id]
  )).rowCount;
  guard(target.identity_state==="mismatch" || Boolean(blockCount),"MISMATCH_NOT_FOUND","This sample position does not have an open identity mismatch.",409);
  await db.query(
    "update order_blocks set resolved_at=now() where order_id=$1 and reason='identity_mismatch' and object_key=$2 and resolved_at is null",
    [orderId,target.expected_item_id]
  );
  if(input.decision==="proceed_as_received") {
    await db.query("update warehouse_items set identity_state='identified',custody_state='stored',revision=revision+1 where id=$1",[target.item_id]);
    await db.query(
      "update expected_items set declared_fields=declared_fields||jsonb_build_object('accepted_mismatch',true,'mismatch_decision','proceed_as_received') where id=$1",
      [target.expected_item_id]
    );
  } else {
    const unlinkReason=input.decision==="replace_sample"?"mismatch_replace":"mismatch_return";
    await db.query("update order_line_item_links set unlinked_at=now(),reason=$2 where id=$1",[target.assignment_id,unlinkReason]);
    await db.query("update warehouse_items set identity_state='identified',custody_state='stored',revision=revision+1 where id=$1",[target.item_id]);
    await db.query(
      "update expected_items set declared_fields=(declared_fields - 'actual_label_info' - 'mismatch_note')||jsonb_build_object('mismatch_decision',$2::text) where id=$1",
      [target.expected_item_id,input.decision]
    );
  }
  const openTicket=(await db.query<{id:string}>(
    `select id from tickets where order_id=$1 and category='receipt_mismatch'
       and details->>'expected_item_id'=$2 and state in ('open','waiting_customer','waiting_internal')
     order by created_at desc limit 1 for update`,
    [orderId,target.expected_item_id]
  )).rows[0];
  if(openTicket) {
    await db.query(
      `update tickets set state='resolved',resolved_at=now(),next_action_at=null,revision=revision+1,
         details=details||$2::jsonb where id=$1`,
      [openTicket.id,{customer_decision:input.decision,customer_note:input.note??null}]
    );
    await db.query(
      `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
       values($1,$2,'customer',$3,'message',$4)`,
      [uuid(),openTicket.id,actor.id,input.note?.trim()||`Customer selected: ${input.decision}`]
    );
  }
  const remainingBlocks=(await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null",[orderId])).rowCount;
  if(order.state==="on_hold" && !remainingBlocks) {
    const fromState=(order.held_from_state as string|null)??"awaiting_samples";
    await db.query(
      `update orders set state=$2,
         sla_due_at=case when sla_due_at is not null and held_at is not null then sla_due_at+greatest(now()-held_at,interval '0 seconds') else sla_due_at end,
         held_at=null,held_from_state=null,hold_reason=null,revision=revision+1
       where id=$1`,
      [orderId,fromState]
    );
  } else {
    await db.query("update orders set revision=revision+1 where id=$1",[orderId]);
  }
  await audit(db,actor,"respond_order_mismatch","orders",orderId,{
    expected_item_id:target.expected_item_id,
    item_id:target.item_id,
    decision:input.decision,
  });
  await readyOrder(db,orderId);
  const updated=await one<{id:string;state:string;revision:number}>(db,"select id,state,revision from orders where id=$1",[orderId]);
  return {
    order_id:updated.id,
    state:updated.state,
    revision:updated.revision,
    expected_item_id:target.expected_item_id,
    item_id:target.item_id,
    decision:input.decision,
  };
}

export async function extendOrderArrival(
  db:DB,
  actor:Actor,
  orderId:string,
  input:{revision:number;extend_days:number;reason:string}
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const order=await one(db,"select * from orders where id=$1 and org_id=$2 for update",[orderId,org]);
  revision(order.revision,input.revision);
  guard(order.state==="awaiting_samples","EXTENSION_UNAVAILABLE","Sample arrival windows can only be extended while awaiting samples.");
  const extendedUntil=new Date(Date.now()+input.extend_days*86400_000).toISOString();
  const nextSource={...(order.source??{}),arrival_extension:{extend_days:input.extend_days,reason:input.reason.trim(),extended_until:extendedUntil,requested_at:new Date().toISOString()}};
  const updated=await one<{id:string;state:string;revision:number;sla_due_at:string|null}>(
    db,
    "update orders set source=$2,revision=revision+1,updated_at=now() where id=$1 returning id,state,revision,sla_due_at",
    [orderId,nextSource]
  );
  await audit(db,actor,"extend_order_arrival","orders",orderId,{extend_days:input.extend_days,reason:input.reason.trim(),extended_until:extendedUntil});
  return {...updated,extended_until:extendedUntil};
}

export async function convertOrderToTwo(
  db:DB,
  actor:Actor,
  orderId:string,
  input:{revision?:number;expected_item_id?:string;drop_label?:string;reason?:string}
) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null) role(actor,"support","super_admin");
  const initial=await one<{org_id:string}>(db,"select org_id from orders where id=$1 and ($2::uuid is null or org_id=$2)",[orderId,org]);
  await lock(db,"org:"+initial.org_id);
  const order=await one(db,"select * from orders where id=$1 for update",[orderId]);
  if(input.revision!==undefined) revision(order.revision,input.revision);
  guard(order.state==="awaiting_samples","CONVERT_TO_TWO_UNAVAILABLE","Three-to-two conversion is only available while awaiting samples before inspection starts.");
  const comparePositions=(await db.query<{
    id:string;
    position:number;
    declared_fields:Record<string,unknown>;
    order_line_id:string;
    category_id:string;
    offer_id:string;
    template_version_id:string;
    service_type_id:string;
    linked_item_id:string|null;
  }>(
    `select e.id,e.position,e.declared_fields,l.id as order_line_id,l.category_id,l.offer_id,l.template_version_id,
            so.service_type_id,a.item_id as linked_item_id
     from order_lines l
     join service_offers so on so.id=l.offer_id
     join service_types st on st.id=so.service_type_id
     join expected_items e on e.order_line_id=l.id and e.in_scope
     left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
     where l.order_id=$1 and st.code='compare'
     order by l.id,e.position`,
    [orderId]
  )).rows;
  guard(comparePositions.length===3,"CONVERT_TO_TWO_UNAVAILABLE","Three-to-two conversion requires an active 3-item comparison line.");
  const dropLabel=(input.drop_label??"").trim();
  const dropped=comparePositions.find(p=>{
    if(input.expected_item_id && p.id===input.expected_item_id) return true;
    if(dropLabel && (p.declared_fields?.sample_code===dropLabel || p.declared_fields?.label===dropLabel || String(p.position)===dropLabel || ["A","B","C"][p.position-1]===dropLabel.toUpperCase())) return true;
    return false;
  }) ?? (comparePositions.filter(p=>!p.linked_item_id).length===1?comparePositions.find(p=>!p.linked_item_id):undefined);
  guard(dropped,"CONVERT_TO_TWO_UNAVAILABLE","Select the unreceived sample position to drop.",422);
  guard(!dropped.linked_item_id,"CONVERT_TO_TWO_UNAVAILABLE","Only a sample position that has not yet arrived can be dropped in a 3-to-2 conversion.");
  const lineId=dropped.order_line_id;
  const alreadyConverted=(await db.query(
    "select 1 from scope_revisions where order_id=$1 and accepted_at is not null and proposed_snapshot->>'conversion'='three_to_two' and proposed_snapshot->>'order_line_id'=$2",
    [orderId,lineId]
  )).rowCount;
  guard(!alreadyConverted,"CONVERT_TO_TWO_UNAVAILABLE","This comparison line has already been converted from 3 to 2 items.");
  const snapshotLines=(order.submission_snapshot?.lines??[]) as {order_line_id:string;quantity:number;amount_cents:number}[];
  const origLine=snapshotLines.find(l=>l.order_line_id===lineId);
  guard(origLine,"CONVERT_TO_TWO_UNAVAILABLE","Original line price snapshot is missing.");
  const twoOffer=(await db.query<{offer_id:string;rules:{package_cents?:number;unit_cents?:number}}>(
    `select so.id as offer_id,sp.rules
     from service_offers so
     join offer_templates ot on ot.offer_id=so.id and ot.category_id=$1 and ot.service_type_id=$2 and ot.template_version_id=$3
     join lateral (
       select rules from sku_prices p
       where p.offer_id=so.id and p.effective_from<=coalesce($4::timestamptz,now())
       order by p.effective_from desc,p.version desc limit 1
     ) sp on true
     where (sp.rules->>'minimum')::int<=2 and (sp.rules->>'maximum')::int>=2
     order by (sp.rules->>'minimum')::int desc limit 1`,
    [dropped.category_id,dropped.service_type_id,dropped.template_version_id,order.paid_at??order.created_at]
  )).rows[0];
  const twoCents=twoOffer
    ?(twoOffer.rules.package_cents??(twoOffer.rules.unit_cents!*2))
    :Math.floor((origLine.amount_cents*2)/3);
  const adjustmentCents=Math.min(0,twoCents-origLine.amount_cents);
  await db.query("update expected_items set in_scope=false where id=$1",[dropped.id]);
  await db.query("update order_lines set quantity=2,offer_id=coalesce($2,offer_id) where id=$1",[lineId,twoOffer?.offer_id??null]);
  const allInScope=(await db.query<{id:string}>(
    "select e.id from expected_items e join order_lines l on l.id=e.order_line_id where l.order_id=$1 and e.in_scope",
    [orderId]
  )).rows.map(r=>r.id);
  const seq=await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from scope_revisions where order_id=$1",[orderId]);
  const revId=uuid();
  const reason=(input.reason??"Convert 3-item comparison to 2-item comparison for unreceived sample").trim();
  await db.query(
    `insert into scope_revisions(id,order_id,revision,previous_snapshot,proposed_snapshot,reason,accepted_by,accepted_at,adjustment_cents)
     values($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
    [
      revId,
      orderId,
      seq.n,
      {positions:[...allInScope,dropped.id],order_revision:order.revision,offer_id:dropped.offer_id},
      {positions:allInScope,conversion:"three_to_two",order_line_id:lineId,dropped_expected_item_id:dropped.id,offer_id:twoOffer?.offer_id??dropped.offer_id},
      reason,
      actor.id,
      adjustmentCents,
    ]
  );
  let refundTicketId:string|null=null;
  if(adjustmentCents<0) {
    refundTicketId=uuid();
    await db.query(
      `insert into tickets(id,public_no,org_id,order_id,category,subject,details)
       values($1,$2,$3,$4,'payment_refund','3-to-2 comparison conversion refund review',$5)`,
      [
        refundTicketId,
        code("C-"),
        initial.org_id,
        orderId,
        {scope_revision_id:revId,order_line_id:lineId,dropped_expected_item_id:dropped.id,amount_cents:-adjustmentCents},
      ]
    );
  }
  await db.query("update orders set revision=revision+1 where id=$1",[orderId]);
  await audit(db,actor,"convert_order_to_two","orders",orderId,{
    scope_revision_id:revId,
    dropped_expected_item_id:dropped.id,
    adjustment_cents:adjustmentCents,
    refund_ticket_id:refundTicketId,
  });
  await readyOrder(db,orderId);
  const updated=await one<{id:string;state:string;revision:number}>(db,"select id,state,revision from orders where id=$1",[orderId]);
  return {
    order_id:updated.id,
    state:updated.state,
    revision:updated.revision,
    scope_revision_id:revId,
    dropped_expected_item_id:dropped.id,
    adjustment_cents:adjustmentCents,
    refund_ticket_id:refundTicketId,
  };
}
export async function exportCustomerPrivacyData(db:DB,actor:Actor) {
  const org=organization(actor);
  const user=await one<{
    id:string;
    display_name:string|null;
    locale:string;
    timezone:string;
    status:string;
    created_at:Date;
  }>(db,"select id,display_name,locale,timezone,status,created_at from users where id=$1",[actor.id]);
  const emails=(await db.query(
    "select id,original_email,is_primary,login_enabled,verified_at,delivery_state from user_emails where user_id=$1 order by is_primary desc,id",
    [actor.id]
  )).rows;
  const identities=(await db.query(
    "select id,provider,status,linked_at,last_authenticated_at from auth_identities where user_id=$1 order by linked_at",
    [actor.id]
  )).rows;
  const receivingProfile=(await db.query(
    "select receiving_code,created_at from customer_receiving_profiles where user_id=$1 and org_id=$2",
    [actor.id,org]
  )).rows[0]??null;
  const orders=(await db.query(
    "select id,public_no,state,price_cents,currency,created_at,paid_at,sla_due_at from orders where org_id=$1 order by created_at desc",
    [org]
  )).rows;
  const items=(await db.query(
    "select id,code,custody_state,identity_state,received_at,storage_until from warehouse_items where org_id=$1 order by received_at desc",
    [org]
  )).rows;
  const charges=(await db.query(
    "select id,purpose,amount_cents,currency,applied_payment_id,voided_at from charge_items where org_id=$1 order by id desc",
    [org]
  )).rows;
  const consents=(await db.query(
    "select id,order_id,terms_version_ids,acknowledgements,created_at from consents where user_id=$1 order by created_at desc",
    [actor.id]
  )).rows;
  const privacyRequests=(await db.query(
    "select id,public_no,state,subject,details,created_at,resolved_at from tickets where org_id=$1 and category='privacy_share' order by created_at desc",
    [org]
  )).rows;
  const activeOrders=orders.filter((o:{state:string})=>!["closed","cancelled"].includes(o.state)).length;
  const storedItems=items.filter((i:{custody_state:string})=>["received","stored"].includes(i.custody_state)).length;
  const unpaidCharges=charges.filter((c:{voided_at:unknown;applied_payment_id:unknown})=>!c.voided_at && !c.applied_payment_id).length;
  await audit(db,actor,"export_privacy_data","users",actor.id,{
    count:orders.length,
  });
  return {
    exported_at:new Date().toISOString(),
    user,
    emails,
    identities,
    receiving_profile:receivingProfile,
    orders,
    items,
    charges,
    consents,
    privacy_requests:privacyRequests,
    retention_exceptions:{
      active_orders:activeOrders,
      stored_items:storedItems,
      unpaid_charges:unpaidCharges,
      can_close_immediately:activeOrders===0 && storedItems===0 && unpaidCharges===0,
      financial_and_audit_retained:true,
      policy_note:"Financial settlements, tax/payment records, published report hashes, and immutable security audit logs are retained under statutory compliance exceptions.",
    },
  };
}

export async function requestCustomerPrivacyAction(
  db:DB,
  actor:Actor,
  input:{kind:"export"|"deletion";note?:string}
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const {active_orders,stored_items,unpaid_charges}=await one<{
    active_orders:number;
    stored_items:number;
    unpaid_charges:number;
  }>(
    db,
    `select
       (select count(*)::int from orders where org_id=$1 and state not in ('closed','cancelled')) active_orders,
       (select count(*)::int from warehouse_items where org_id=$1 and custody_state in ('received','stored')) stored_items,
       (select count(*)::int from charge_items where org_id=$1 and voided_at is null and applied_payment_id is null and free_authorization is null) unpaid_charges`,
    [org]
  );
  const canCloseImmediately=active_orders===0 && stored_items===0 && unpaid_charges===0;
  const ticketId=uuid(),publicNo=code("PRV-");
  const subject=input.kind==="deletion"
    ?"Account deletion and data erasure request"
    :"Personal data export archive request";
  const details={
    privacy_kind:input.kind,
    note:input.note?.trim()??null,
    active_orders,
    stored_items,
    unpaid_charges,
    can_close_immediately:canCloseImmediately,
    financial_and_audit_retained:true,
  };
  await db.query(
    `insert into tickets(id,public_no,org_id,category,state,subject,details,next_action_at)
     values($1,$2,$3,'privacy_share','open',$4,$5,now()+interval '24 hours')`,
    [ticketId,publicNo,org,subject,details]
  );
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
     values($1,$2,'customer',$3,'message',$4)`,
    [uuid(),ticketId,actor.id,input.note?.trim()||subject]
  );
  await audit(db,actor,"request_privacy_action","tickets",ticketId,{
    kind:input.kind,
    active:canCloseImmediately,
  });
  return {
    ticket_id:ticketId,
    public_no:publicNo,
    kind:input.kind,
    state:"open",
    retention_exceptions:{
      active_orders,
      stored_items,
      unpaid_charges,
      can_close_immediately:canCloseImmediately,
      financial_and_audit_retained:true,
    },
  };
}

export async function systemHealthAndBackupCheck(db:DB,actor:Actor) {
  role(actor,"super_admin");
  const counts=await one<{
    users_count:number;
    orders_count:number;
    items_count:number;
    payments_count:number;
    reports_count:number;
    audit_count:number;
    pending_jobs_count:number;
    failed_jobs_count:number;
  }>(
    db,
    `select
       (select count(*)::int from users) users_count,
       (select count(*)::int from orders) orders_count,
       (select count(*)::int from warehouse_items) items_count,
       (select count(*)::int from payments) payments_count,
       (select count(*)::int from report_versions where state='published') reports_count,
       (select count(*)::int from audit_events) audit_count,
       (select count(*)::int from outbox_events where processed_at is null and attempts=0) pending_jobs_count,
       (select count(*)::int from outbox_events where processed_at is null and attempts>0) failed_jobs_count`
  );
  const triggers=(await db.query<{tgname:string}>(
    `select tgname from pg_trigger
     where not tgisinternal and tgname in ('immutable_audit','immutable_logistics','freeze_report','freeze_template','freeze_inspection_quote')
     order by tgname`
  )).rows.map(r=>r.tgname);
  const recoveryRuns=(await db.query(
    "select id,restored_to,started_at,finished_at,reconciliation,approved_by from recovery_runs order by started_at desc limit 10"
  )).rows;
  return {
    checked_at:new Date().toISOString(),
    healthy:triggers.length>=5,
    counts,
    immutable_triggers:triggers,
    recovery_runs:recoveryRuns,
  };
}

export async function setDisposalExecutionSwitch(
  db:DB,
  actor:Actor,
  input:{enabled:boolean;legal_policy_ref?:string}
) {
  role(actor,"super_admin");
  await db.query(
    `insert into app_config(key,value,updated_by,updated_at)
     values('disposal.production_execution_enabled',$1::jsonb,$2,now())
     on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,
    [JSON.stringify(Boolean(input.enabled)),actor.id]
  );
  await audit(db,actor,"set_disposal_execution_switch","app_config",null,{
    active:Boolean(input.enabled),
    reason:input.legal_policy_ref?.trim()??null,
  });
  return {production_execution_enabled:Boolean(input.enabled)};
}

export async function recordRecoveryDrill(
  db:DB,
  actor:Actor,
  input:{
    environment?:string;
    backup_reference?:string;
    restored_to?:string;
    note?:string;
    notes?:string;
    rpo_seconds?:number;
    rto_seconds?:number;
    revoked_session_ids?:string[];
    closed_user_ids?:string[];
    revoked_identity_ids?:string[];
    suppressed_emails?:string[];
  }
) {
  role(actor,"super_admin");
  const startedAt=new Date();
  const restoredTo=input.restored_to?new Date(input.restored_to):new Date();

  // T105: Replay post-restore revocation / deletion / suppression manifest so PITR never resurrects revoked sessions, identities, or closed accounts
  let replayedSessions=0;
  let replayedUsers=0;
  let replayedIdentities=0;
  let replayedSuppressedEmails=0;

  if(input.revoked_session_ids?.length) {
    const r=await db.query(
      "update sessions set revoked_at=coalesce(revoked_at,now()) where id=any($1::uuid[])",
      [input.revoked_session_ids]
    );
    replayedSessions=r.rowCount??0;
  }
  if(input.closed_user_ids?.length) {
    const r=await db.query(
      "update users set status='closed',auth_version=auth_version+1,updated_at=now() where id=any($1::uuid[])",
      [input.closed_user_ids]
    );
    await db.query("update sessions set revoked_at=coalesce(revoked_at,now()) where user_id=any($1::uuid[])",[input.closed_user_ids]);
    await db.query("update auth_identities set status='revoked' where user_id=any($1::uuid[])",[input.closed_user_ids]);
    await db.query("update user_emails set is_primary=false,login_enabled=false where user_id=any($1::uuid[])",[input.closed_user_ids]);
    replayedUsers=r.rowCount??0;
  }
  if(input.revoked_identity_ids?.length) {
    const r=await db.query(
      "update auth_identities set status='revoked' where id=any($1::uuid[])",
      [input.revoked_identity_ids]
    );
    replayedIdentities=r.rowCount??0;
  }
  if(input.suppressed_emails?.length) {
    const norms=input.suppressed_emails.map(e=>e.trim().toLowerCase()).filter(Boolean);
    if(norms.length) {
      await db.query(
        "update user_emails set delivery_state='bounced' where normalized_email=any($1::citext[])",
        [norms]
      );
      replayedSuppressedEmails=norms.length;
    }
  }

  // T106: Reconcile external payment/refund records & physical warehouse handovers
  const finRec=await one<{
    succeeded_payments:number;
    missing_provider_ref:number;
    handed_over_shipments:number;
    shipments_missing_tracker:number;
  }>(
    db,
    `select
       (select count(*)::int from payments where state in ('succeeded','partially_refunded','refunded')) succeeded_payments,
       (select count(*)::int from payments where state in ('succeeded','partially_refunded','refunded') and (provider_ref is null or provider_ref='')) missing_provider_ref,
       (select count(*)::int from shipments where state in ('shipped','delivered','returned')) handed_over_shipments,
       (select count(*)::int from shipments s where s.state in ('shipped','delivered','returned') and not exists(select 1 from tracking_records tr where tr.shipment_id=s.id)) shipments_missing_tracker`
  );

  const health=await systemHealthAndBackupCheck(db,actor);
  const runId=uuid();
  const finishedAt=new Date();
  const rtoSeconds=input.rto_seconds ?? Math.max(1,Math.round((finishedAt.valueOf()-startedAt.valueOf())/1000));
  const rpoSeconds=input.rpo_seconds ?? Math.max(0,Math.round((startedAt.valueOf()-restoredTo.valueOf())/1000));
  const paymentHandoverReconciled=finRec.missing_provider_ref===0 && finRec.shipments_missing_tracker===0;
  const replayed={
    sessions_revoked:replayedSessions,
    closed_users:replayedUsers,
    identities_revoked:replayedIdentities,
    emails_suppressed:replayedSuppressedEmails,
  };

  const reconciliation={
    ...health.counts,
    environment:input.environment??"staging-drill",
    backup_reference:input.backup_reference??null,
    immutable_triggers:health.immutable_triggers,
    isolated_environment:true,
    rpo_seconds:rpoSeconds,
    rto_seconds:rtoSeconds,
    replayed,
    manifest_replay:{
      replayed_sessions:replayedSessions,
      replayed_closed_users:replayedUsers,
      replayed_revoked_identities:replayedIdentities,
      replayed_suppressed_emails:replayedSuppressedEmails,
    },
    payment_handover_reconciliation:{
      ...finRec,
      paid_charges_verified:finRec.succeeded_payments,
      shipments_handed_over_verified:finRec.handed_over_shipments,
      reconciled:paymentHandoverReconciled,
    },
    note:(input.note??input.notes)?.trim()??"Automated logical backup, suppression manifest replay, and payment/handover reconciliation check",
    verified:health.healthy && paymentHandoverReconciled,
  };
  const row=await one<{
    id:string;
    restored_to:Date;
    started_at:Date;
    finished_at:Date;
    reconciliation:Record<string,unknown>;
    approved_by:string;
  }>(
    db,
    `insert into recovery_runs(id,restored_to,started_at,finished_at,reconciliation,approved_by)
     values($1,$2,$3,$4,$5,$6)
     returning id,restored_to,started_at,finished_at,reconciliation,approved_by`,
    [runId,restoredTo.toISOString(),startedAt.toISOString(),finishedAt.toISOString(),reconciliation,actor.id]
  );
  await audit(db,actor,"record_recovery_run","recovery_runs",row.id,{
    count:health.counts.orders_count,
    active:health.healthy && paymentHandoverReconciled,
  });
  return {...row,replayed};
}

export const staffSchemas={
  address:z.object({
    address_zh:z.string().min(3).max(500),
    address_en:z.string().min(3).max(500),
    contact_name:z.string().min(1).max(100),
    contact_phone:z.string().min(5).max(30),
    is_default:z.boolean().optional(),
  }),
  addressUpdate:z.object({
    is_default:z.boolean().optional(),
    active:z.boolean().optional(),
  }),
  businessCalendar:z.object({
    holidays:z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
    extra_workdays:z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).optional(),
  }),
  termsCreate:z.object({
    kind:z.enum(["terms","privacy","restricted_items","report_notice"]),
    version:z.string().trim().min(1).max(60),
    content_md:z.string().trim().min(10).max(100_000),
    publish_now:z.boolean().optional(),
  }),
  staffRolesUpdate:z.object({
    roles:z.array(z.enum(["receiver","inspector","reviewer","warehouse_admin","support","super_admin","template_admin","finance"])).max(8),
    reason:z.string().trim().min(3).max(500),
  }),
  privacyRequest:z.object({
    kind:z.enum(["export","deletion"]),
    note:z.string().trim().max(1000).optional(),
  }),
  recoveryDrill:z.object({
    environment:z.string().trim().max(100).optional(),
    backup_reference:z.string().trim().max(200).optional(),
    restored_to:z.string().datetime().optional(),
    note:z.string().trim().max(500).optional(),
    notes:z.string().trim().max(500).optional(),
    rpo_seconds:z.number().int().min(0).max(86400).optional(),
    rto_seconds:z.number().int().min(0).max(86400).optional(),
    revoked_session_ids:z.array(z.string().uuid()).max(500).optional(),
    closed_user_ids:z.array(z.string().uuid()).max(500).optional(),
    revoked_identity_ids:z.array(z.string().uuid()).max(500).optional(),
    suppressed_emails:z.array(z.string().email()).max(500).optional(),
  }),
  disposalSwitch:z.object({
    enabled:z.boolean(),
    legal_policy_ref:z.string().trim().max(300).optional(),
    legal_basis_version:z.string().trim().max(300).optional(),
    reason:z.string().trim().max(500).optional(),
  }),
  template:z.object({template_key:z.string().min(2).max(100),category_id:z.string().uuid(),service_type_id:z.string().uuid(),content:templateSchema,
    capability_ids:z.array(z.string().uuid()).min(1).max(20)}),
  capability:z.object({code:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),method:z.string().trim().min(2).max(200),
    approval:z.record(z.string(),z.unknown()).optional()}),
  capabilityRevoke:z.object({reason:z.string().trim().min(2).max(300)}),
  categoryCreate:z.object({slug:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    labels:z.object({en:z.string().trim().min(1).max(100),"zh-CN":z.string().trim().min(1).max(100)}),
    parent_id:z.string().uuid().optional()}),
  categoryStatus:z.object({status:z.enum(["PLANNED","ACTIVE","PAUSED","RESTRICTED","RETIRED"]),
    admission_snapshot:z.record(z.string(),z.unknown()).optional()}),
  skuPrice:z.object({rules:priceSchema}),
  offer:z.object({sku_code:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,80}$/),category_id:z.string().uuid(),
    service_type_id:z.string().uuid(),template_version_id:z.string().uuid(),
    title:z.object({en:z.string().trim().min(1).max(120),"zh-CN":z.string().trim().min(1).max(100)}),
    enabled:z.boolean().optional(),rules:priceSchema}),
  referenceRelease:z.object({terms_version_id:z.string().uuid(),reason:z.string().trim().max(300).optional()}),
};
