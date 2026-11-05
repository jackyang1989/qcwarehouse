import type { DB } from "../db";
import { one, organization, role, type Actor } from "./common";
import { receiving } from "./auth";
import { orderDTO } from "./orders";

export async function items(db:DB,actor:Actor) {
  return (await db.query(`select w.id item_id,w.code,w.custody_state,w.revision,w.identity_state,w.storage_until,
    a.order_line_id, array(select d.id from disposition_requests d where d.item_id=w.id and d.state='requested'
      and not exists(select 1 from dispatch_batch_items bi where bi.disposition_id=d.id and bi.released_at is null)) instructions
    from warehouse_items w left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    where w.org_id=$1 and w.parent_item_id is null order by w.received_at desc limit 400`,[organization(actor)])).rows.map(w=>({
      ...w,allowed_actions:["stored","received"].includes(w.custody_state)?["request_disposition"]:[],
    }));
}
export async function bills(db:DB,actor:Actor) {
  const org=organization(actor);
  return (await db.query(`select c.id charge_item_id,c.purpose,c.amount_cents,c.currency,
    case when c.voided_at is not null then 'void' when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
      when exists(select 1 from payments p where p.charge_item_id=c.id and p.state='processing') then 'processing' else 'open' end state,
    coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id and r.state='succeeded'),0) refunded_cents,
    case when i.order_id is not null then array[i.order_id] else array(select a.order_id from charge_allocations a where a.charge_id=c.id) end order_ids,
    coalesce(i.revision,d.revision,s.revision) quote_revision
    from charge_items c left join inspection_quotes i on i.id=c.inspection_quote_id left join dispatch_quote_versions d on d.id=c.dispatch_quote_id
    left join storage_quotes s on s.id=c.storage_quote_id where c.org_id=$1 order by c.id desc limit 200`,[org])).rows;
}
export async function customerDesk(db:DB,actor:Actor) {
  const org=organization(actor);
  const orders=(await db.query(`select id,public_no,state,revision,price_cents,created_at from orders where org_id=$1 order by created_at desc limit 200`,[org])).rows;
  const advices=(await db.query(`select a.id,t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,p.state warehouse_state,
    array(select order_id from advice_orders where advice_id=a.id) order_ids from package_advices a
    join tracking_records t on t.advice_id=a.id and t.closed_at is null left join packages p on p.advice_id=a.id
    where a.org_id=$1 order by a.created_at desc limit 200`,[org])).rows;
  const shipments=(await db.query(`select s.id,s.state,s.tracking_norm,s.carrier_code,s.shipped_at,b.action from shipments s join dispatch_batches b on b.id=s.batch_id
    where b.org_id=$1 and s.shipped_at is not null order by s.shipped_at desc limit 200`,[org])).rows;
  const quotes=(await db.query(`select q.id,q.revision,q.amount_cents,q.expires_at,'dispatch' purpose,q.batch_id
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id where b.org_id=$1 and b.state='quoted' and q.accepted_at is null and q.expires_at>now()
    union all select q.id,q.revision,q.amount_cents,q.expires_at,'storage',null from storage_quotes q join disposition_requests d on d.id=q.disposition_id
    where d.org_id=$1 and q.accepted_at is null and q.expires_at>now() limit 100`,[org])).rows;
  const batches=(await db.query("select id,state,revision,action from dispatch_batches where org_id=$1 and state='draft' limit 100",[org])).rows;
  const reports=(await db.query(`select r.order_id,r.public_no,r.published_version,o.public_no order_no from reports r join orders o on o.id=r.order_id
    where o.org_id=$1 and r.published_version is not null limit 200`,[org])).rows;
  const tickets=(await db.query(`select id,public_no,subject,state,details->>'decision' decision from tickets where org_id=$1 order by created_at desc limit 100`,[org])).rows;
  const notices=(await db.query(`select id,template,read_at,created_at from notifications where user_id=$1 order by created_at desc limit 50`,[actor.id])).rows;
  const references=(await db.query(`select r.id reference_id,r.item_id,r.state,r.expires_at,w.code from reference_samples r join warehouse_items w on w.id=r.item_id
    where r.org_id=$1 order by r.expires_at desc limit 100`,[org])).rows;
  return {orders,advices,shipments,quotes,batches,reports,tickets,notices,references,profile:await receiving(db,actor.id),items:await items(db,actor),bills:await bills(db,actor)};
}
export async function warehouseDesk(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","inspector","reviewer");
  const canReceive=actor.roles.some(r=>["receiver","warehouse_admin"].includes(r)),canShip=actor.roles.includes("warehouse_admin");
  const packages=canReceive?(await db.query(`select p.id,p.code,p.state,p.org_id,p.revision,p.received_quantity,t.tracking_norm from packages p
    left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null order by p.received_at desc limit 100`)).rows:[];
  const items=canReceive?(await db.query(`select w.id,w.code,w.package_id,w.org_id,w.revision,w.custody_state,l.code location from warehouse_items w left join storage_locations l on l.id=w.location_id
    where w.custody_state in ('received','stored') order by w.received_at desc limit 400`)).rows:[];
  const positions=canReceive?(await db.query(`select e.id,e.position,l.org_id,l.id order_line_id,o.public_no,so.title from expected_items e
    join order_lines l on l.id=e.order_line_id join orders o on o.id=l.order_id join service_offers so on so.id=l.offer_id where e.in_scope
    and o.state='awaiting_samples' and not exists(select 1 from order_line_item_links a where a.expected_item_id=e.id and a.unlinked_at is null) limit 400`)).rows:[];
  const locations=canReceive?(await db.query("select id,code from storage_locations where active order by code")).rows:[];
  const tasks=actor.roles.some(r=>["inspector","reviewer"].includes(r))?(await db.query(`select t.id,t.state,t.revision,t.assignee_id,l.order_id,o.public_no,so.title,w.code item_code
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id join service_offers so on so.id=l.offer_id
    left join order_line_item_links a on a.id=t.assignment_id left join warehouse_items w on w.id=a.item_id
    where t.state in ('READY','IN_PROGRESS','SUBMITTED') and o.state in ('queued','inspecting','qa_review') order by o.created_at,t.id limit 400`)).rows:[];
  const reports=actor.roles.includes("reviewer")?(await db.query(`select v.id,v.version,v.state,v.revision,v.snapshot,o.public_no from report_versions v join reports r on r.id=v.report_id
    join orders o on o.id=r.order_id where v.state in ('submitted','qa_approved') and o.state='qa_review' limit 100`)).rows:[];
  const batches=canShip?(await db.query(`select b.id,b.revision,b.state,b.action,b.destination_snapshot,q.id quote_id,q.snapshot,
    (select jsonb_agg(jsonb_build_object('id',w.id,'code',w.code)) from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id where bi.batch_id=b.id and bi.released_at is null) items
    from dispatch_batches b left join lateral(select * from dispatch_quote_versions q where q.batch_id=b.id order by revision desc limit 1) q on true
    where b.state in ('confirmed','quoted','paid') limit 100`)).rows:[];
  const shipments=canShip?(await db.query(`select s.id,s.state,s.revision,s.tracking_norm,s.batch_id,
    array(select item_id from shipment_items where shipment_id=s.id) item_ids,
    array(select item_id from shipment_return_items where shipment_id=s.id) returned_item_ids from shipments s
    order by s.shipped_at desc nulls first limit 100`)).rows:[];
  const rates=canShip?(await db.query("select id,version from shipping_rate_versions where effective_at<=now() order by version desc")).rows:[];
  const retain=canShip?(await db.query(`select d.id,w.code from disposition_requests d join warehouse_items w on w.id=d.item_id
    where d.action='retain' and d.state='requested' and not exists(select 1 from storage_quotes q where q.disposition_id=d.id)`)).rows:[];
  return {packages,items,positions,locations,tasks,reports,batches,shipments,rates,retain};
}
export async function adminDesk(db:DB,actor:Actor) {
  role(actor,"super_admin","finance","support","template_admin");
  const finance=actor.roles.some(r=>["super_admin","finance"].includes(r));
  const ops=actor.roles.some(r=>["super_admin","support"].includes(r));
  const templates=actor.roles.some(r=>["super_admin","template_admin"].includes(r));
  return {
    orders:ops?(await db.query("select id,public_no,state,created_at from orders order by created_at desc limit 150")).rows:[],
    tickets:ops?(await db.query("select id,public_no,subject,category,state,next_action_at from tickets order by created_at desc limit 150")).rows:[],
    claims:ops?(await db.query(`select k.id,k.public_no,k.state,k.details->>'tracking_no' tracking_no,
      k.details->>'carrier_code' carrier_code,k.details->>'proof_id' proof_id,k.details->>'decision' decision,
      array(select m.id from tracking_records t join media_assets m on m.package_id=t.package_id
        where t.direction='inbound' and t.closed_at is null and t.org_id is null
        and t.tracking_norm=k.details->>'tracking_no' and coalesce(t.carrier_code,k.details->>'carrier_code')=k.details->>'carrier_code'
        and m.kind='intake_outer' and m.status='ready') outer_photo_ids
      from tickets k where category='identity_unclear' and details ? 'proof_id'
      order by created_at desc limit 100`)).rows:[],
    manualQuotes:ops?(await db.query(`select r.id,r.order_id,r.revision,r.state,r.assignee_id,r.reason,o.public_no,
      (select jsonb_agg(jsonb_build_object('id',l.id,'quantity',l.quantity,'title',s.title->>'zh-CN') order by l.id)
       from order_lines l join service_offers s on s.id=l.offer_id where l.order_id=r.order_id) lines
      from manual_quote_requests r join orders o on o.id=r.order_id and o.revision=r.revision
      where o.state='draft' and r.state in ('requested','offered') order by r.due_at limit 100`)).rows:[],
    refunds:finance?(await db.query("select id,payment_id,amount_cents,state,reason,revision,requested_by from refunds order by created_at desc limit 100")).rows:[],
    payments:finance?(await db.query("select id,charge_item_id,state,amount_cents,provider_ref from payments order by created_at desc limit 150")).rows:[],
    warehouseAddressAlert:actor.roles.includes("super_admin")?(await db.query(`select 1 from notifications
      where user_id=$1 and template='warehouse.address_required'
      and not exists(select 1 from warehouse_addresses where is_default and active) limit 1`,[actor.id])).rowCount===1:false,
    addresses:actor.roles.includes("super_admin")?(await db.query("select id,address_zh,address_en,contact_name,contact_phone,is_default from warehouse_addresses order by created_at desc")).rows:[],
    templates:templates?(await db.query("select id,template_key,version,state from template_versions order by published_at desc nulls first limit 100")).rows:[],
    categories:templates?(await db.query("select id,labels,status from categories order by slug")).rows:[],
    services:templates?(await db.query("select id,labels from service_types order by code")).rows:[],
    capabilities:templates?(await db.query("select id,code from capabilities where approved_by is not null and revoked_at is null")).rows:[],
    jobErrors:actor.roles.includes("super_admin")?(await db.query("select id,type,attempts,last_error,next_attempt_at from outbox_events where processed_at is null and attempts>0 order by id desc limit 50")).rows:[],
  };
}
export async function readOrderByPublicNumber(db:DB,actor:Actor,publicNo:string) {
  const row=await one<{id:string;public_no:string;revision:number;state:string}>(db,"select id,public_no,revision,state from orders where public_no=$1 and org_id=$2",[publicNo,organization(actor)]);
  return orderDTO(row);
}
