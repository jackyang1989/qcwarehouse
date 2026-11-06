import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { readyOrder, templateSchema } from "./orders";
import { requireSpace } from "./storage";

export async function cancelOrder(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const o=await one(db,"select * from orders where id=$1 and org_id=$2 for update",[id,org]);
  revision(o.revision,rev);
  guard(["draft","awaiting_payment","awaiting_samples","queued","inspecting","qa_review","on_hold"].includes(o.state),
    "CANCELLATION_UNAVAILABLE","Contact support about an already completed order.");
  await db.query(`update charge_items c set voided_at=now() from inspection_quotes q where q.id=c.inspection_quote_id
    and q.order_id=$1 and c.applied_payment_id is null and c.voided_at is null`,[id]);
  await db.query(`update inspection_tasks t set state='VOID',revision=t.revision+1 from order_lines l
    where l.id=t.order_line_id and l.order_id=$1 and t.state<>'QA_APPROVED'`,[id]);
  await db.query(`update reference_reservations r set released_at=now() from inspection_groups g,order_lines l
    where r.group_id=g.id and g.order_line_id=l.id and l.order_id=$1 and r.released_at is null`,[id]);
  await db.query("update orders set state='cancelled',revision=revision+1 where id=$1",[id]);
  if(o.paid_at) await db.query(`insert into tickets(id,public_no,org_id,order_id,category,subject)
    values($1,$2,$3,$4,'payment_refund','Review cancellation and refundable amount')`,[uuid(),code("C-"),org,id]);
  await audit(db,actor,"cancel_order","orders",id);
  await event(db,"order.cancelled",{order_id:id});
  return {state:"cancelled"};
}
export async function setAddress(db:DB,actor:Actor,data:{address_zh:string;address_en:string;contact_name:string;contact_phone:string}) {
  role(actor,"super_admin");
  await lock(db,"warehouse_default_address");
  await db.query("update warehouse_addresses set is_default=false where is_default");
  const a=await one(db,`insert into warehouse_addresses(id,address_zh,address_en,contact_name,contact_phone,is_default)
    values($1,$2,$3,$4,$5,true) returning id`,[uuid(),data.address_zh,data.address_en,data.contact_name,data.contact_phone]);
  await audit(db,actor,"set_default_address","warehouse_addresses",a.id);
  return a;
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
  guard(w.location_id!==location,"LOCATION_UNCHANGED","Choose a different storage location.");
  await requireSpace(db,location,1);
  await db.query("update warehouse_items set location_id=$2,revision=revision+1 where id=$1",[id,location]);
  await db.query("insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'move',$4)",[id,w.location_id,location,actor.id]);
  await audit(db,actor,"move_item","warehouse_items",id,{location_id:location});
  return {id,revision:rev+1};
}
export async function scopeProposal(db:DB,actor:Actor,id:string,input:{revision:number;reason:string;positions:string[]}) {
  if(actor.kind==="staff") role(actor,"support","super_admin");
  const first=await one(db,"select org_id from orders where id=$1 and ($2::uuid is null or org_id=$2)",[id,actor.org]);
  await lock(db,"org:"+first.org_id);
  const o=await one(db,"select * from orders where id=$1 for update",[id]);
  revision(o.revision,input.revision);
  guard(o.state==="awaiting_samples","SCOPE_UNAVAILABLE","Scope can change before inspection begins.");
  const positions=(await db.query(`select e.id,e.order_line_id,l.options,st.code service from expected_items e join order_lines l on l.id=e.order_line_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id where l.order_id=$1 and e.in_scope`,[id])).rows;
  const ids=new Set(input.positions);
  guard(ids.size===input.positions.length && ids.size<positions.length && input.positions.every(p=>positions.some(x=>x.id===p)),
    "SCOPE_UNAVAILABLE","Choose the exact set of items to retain.");
  const base=o.submission_snapshot.lines as {order_line_id:string;quantity:number;amount_cents:number}[];
  let adjustment=0;
  for(const l of base) {
    const existing=positions.filter(x=>x.order_line_id===l.order_line_id);
    const next=existing.filter(x=>ids.has(x.id)).length;
    if(next===existing.length) continue;
    guard(existing[0]?.service==="inspection","SCOPE_REVIEW_REQUIRED","A comparison or reference scope change requires staff pricing.");
    adjustment-=Math.floor(l.amount_cents*(existing.length-next)/l.quantity);
  }
  const seq=await one<{n:number}>(db,"select coalesce(max(revision),0)::int+1 n from scope_revisions where order_id=$1",[id]);
  const row=await one(db,`insert into scope_revisions(id,order_id,revision,previous_snapshot,proposed_snapshot,reason,adjustment_cents)
    values($1,$2,$3,$4,$5,$6,$7) returning id as scope_revision_id,adjustment_cents,revision`,
    [uuid(),id,seq.n,{positions:positions.map(x=>x.id),order_revision:o.revision},{positions:input.positions},input.reason,adjustment]);
  await audit(db,actor,"propose_scope","orders",id);
  return row;
}
export async function scopeReview(db:DB,actor:Actor,id:string) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null)role(actor,"support","super_admin");
  const order=await one<{id:string;revision:number;state:string;public_no:string}>(db,
    "select id,revision,state,public_no from orders where id=$1 and ($2::uuid is null or org_id=$2)",[id,org]);
  const positions=(await db.query(`select e.id,e.position,e.in_scope,l.id line_id,s.title,st.code service,w.code item_code
    from expected_items e join order_lines l on l.id=e.order_line_id join service_offers s on s.id=l.offer_id
    join service_types st on st.id=s.service_type_id
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id and w.org_id=l.org_id
    where l.order_id=$1 order by l.id,e.position`,[id])).rows;
  const proposals=(await db.query(`select s.id,s.revision,s.reason,s.adjustment_cents,s.accepted_at,
    s.previous_snapshot->'positions' previous_positions,s.proposed_snapshot->'positions' proposed_positions,
    case when s.accepted_at is not null then 'accepted'
      when $2='awaiting_samples' and s.previous_snapshot->>'order_revision'=$3::text then 'pending' else 'stale' end state,
    (select jsonb_build_object('id',k.id,'state',k.state) from tickets k
      where k.order_id=s.order_id and k.category='payment_refund' and k.details->>'scope_revision_id'=s.id::text
      order by k.created_at desc limit 1) refund_case
    from scope_revisions s where s.order_id=$1 order by s.revision desc`,[id,order.state,order.revision])).rows;
  return {order,positions,proposals};
}
export async function acceptScope(db:DB,actor:Actor,id:string,rev:number) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const row=await one(db,`select s.*,o.revision order_revision,o.state from scope_revisions s join orders o on o.id=s.order_id where s.id=$1 and o.org_id=$2 for update of s,o`,[id,org]);
  revision(row.revision,rev);
  guard(!row.accepted_at && row.state==="awaiting_samples" && row.previous_snapshot.order_revision===row.order_revision && row.adjustment_cents<=0,
    "SCOPE_UNAVAILABLE","This scope proposal is no longer applicable.");
  const dropped=row.previous_snapshot.positions.filter((p:string)=>!row.proposed_snapshot.positions.includes(p));
  await db.query("update expected_items set in_scope=false where id=any($1::uuid[])",[dropped]);
  await db.query("update order_line_item_links set unlinked_at=now(),reason='scope_reduced' where expected_item_id=any($1::uuid[]) and unlinked_at is null",[dropped]);
  await db.query("update scope_revisions set accepted_at=now(),accepted_by=$2 where id=$1",[id,actor.id]);
  await db.query("update orders set revision=revision+1 where id=$1",[row.order_id]);
  if(row.adjustment_cents<0) await db.query(`insert into tickets(id,public_no,org_id,order_id,category,subject,details)
    values($1,$2,$3,$4,'payment_refund','Scope reduction refund review',$5)`,[uuid(),code("C-"),org,row.order_id,{scope_revision_id:id,amount_cents:-row.adjustment_cents}]);
  await audit(db,actor,"accept_scope","orders",row.order_id);
  await readyOrder(db,row.order_id);
  return {scope_revision_id:id,state:"accepted"};
}
export const staffSchemas={
  address:z.object({address_zh:z.string().min(3).max(500),address_en:z.string().min(3).max(500),contact_name:z.string().min(1).max(100),contact_phone:z.string().min(5).max(30)}),
  template:z.object({template_key:z.string().min(2).max(100),category_id:z.string().uuid(),service_type_id:z.string().uuid(),content:templateSchema,
    capability_ids:z.array(z.string().uuid()).min(1).max(20)}),
};
