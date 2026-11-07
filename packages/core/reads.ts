import type { DB } from "../db";
import { z } from "zod";
import { guard, hash, one, organization, role, type Actor } from "./common";
import { receiving } from "./auth";
import { customerEmailDeliveryStatus } from "./email";
import { orderDTO } from "./orders";
import { orderShipments } from "./fulfillment-reads";
import { waybill } from "./intake";
import { hasStaffAccess, staffAccess } from "./staff-access";
import { effectiveDispatchCharge } from "./dispatch";

export async function items(db:DB,actor:Actor) {
  return (await db.query(`select w.id item_id,w.code,w.custody_state,w.revision,w.identity_state,w.condition_state,w.storage_until,w.received_at,
    p.code package_code,a.order_line_id,o.id order_id,o.public_no order_no,sl.code location_code,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'custody_state',c.custody_state) order by c.code),'[]'::jsonb)
     from warehouse_items c where c.parent_item_id=w.id) components,
    (select jsonb_build_object(
      'reference_id',r.id,'state',r.state,'revision',r.revision,'expires_at',r.expires_at,
      'expired',r.expires_at<=now(),
      'in_use',exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null)
    ) from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_sample,
    array(select d.id from disposition_requests d where d.item_id=w.id and d.state='requested'
      and not exists(select 1 from dispatch_batch_items bi where bi.disposition_id=d.id and bi.released_at is null)) instructions
    from warehouse_items w join packages p on p.id=w.package_id
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join order_lines l on l.id=a.order_line_id left join orders o on o.id=l.order_id
    left join storage_locations sl on sl.id=w.location_id
    where w.org_id=$1 and w.parent_item_id is null order by w.received_at desc limit 400`,[organization(actor)])).rows.map(w=>({
      ...w,allowed_actions:["stored","received"].includes(w.custody_state)&&w.identity_state!=="quarantined"?["request_disposition"]:[],
    }));
}
export async function bills(db:DB,actor:Actor) {
  const org=organization(actor);
  return (await db.query(`select c.id charge_item_id,c.purpose,c.amount_cents,c.currency,
    case when c.voided_at is not null then 'void' when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
      when exists(select 1 from payments p where p.charge_item_id=c.id and p.state='processing') then 'processing' else 'open' end state,
    coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id and r.state='succeeded'),0) refunded_cents,
    case when i.order_id is not null then array[i.order_id] else array(select a.order_id from charge_allocations a where a.charge_id=c.id) end order_ids,
    case when i.order_id is not null then array(select o.public_no from orders o where o.id=i.order_id)
      else array(select o.public_no from charge_allocations a join orders o on o.id=a.order_id where a.charge_id=c.id) end order_numbers,
    d.batch_id,
    (select p.state from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_attempt_state,
    (select p.provider_ref from payments p where p.id=c.applied_payment_id) paid_ref,
    case when c.free_authorization is not null then 'FREE-AUTH' else null end receipt_summary,
    coalesce(i.revision,d.revision,s.revision) quote_revision
    from charge_items c left join inspection_quotes i on i.id=c.inspection_quote_id left join dispatch_quote_versions d on d.id=c.dispatch_quote_id
    left join storage_quotes s on s.id=c.storage_quote_id where c.org_id=$1 order by c.id desc limit 200`,[org])).rows;
}
export async function customerActions(db:DB,actor:Actor) {
  const org=organization(actor);
  const {rows}=await db.query(`select * from (
    select o.id,'order' kind,o.state,o.public_no reference,null::timestamptz due_at
    from orders o where o.org_id=$1 and (
      o.state='draft' or
      (o.state='awaiting_payment' and not exists(
        select 1 from charge_items c join payments p on p.charge_item_id=c.id
        where c.inspection_quote_id::text=o.submission_snapshot->>'quote_id' and c.voided_at is null and p.state='processing')) or
      (o.state='awaiting_samples' and not exists(select 1 from advice_orders a where a.order_id=o.id and a.org_id=o.org_id))
    )
    union all select q.id,'quote',b.action,null,q.expires_at from dispatch_quote_versions q
      join dispatch_batches b on b.id=q.batch_id where b.org_id=$1 and b.state='quoted' and q.accepted_at is null and q.expires_at>now()
    union all select q.id,'quote','retain',w.code,q.expires_at from storage_quotes q
      join disposition_requests d on d.id=q.disposition_id join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
      where d.org_id=$1 and d.state='requested' and q.accepted_at is null and q.expires_at>now()
    union all select c.id,'charge',c.purpose,null,coalesce(q.expires_at,s.expires_at,iq.expires_at) from charge_items c
      left join dispatch_quote_versions q on q.id=c.dispatch_quote_id left join storage_quotes s on s.id=c.storage_quote_id
      left join inspection_quotes iq on iq.id=c.inspection_quote_id
      where c.org_id=$1 and (c.purpose in ('dispatch','storage') or (c.purpose='inspection' and c.scope_revision_id is not null))
      and c.voided_at is null and c.applied_payment_id is null and c.free_authorization is null
      and not exists(select 1 from payments p where p.charge_item_id=c.id and p.state='processing')
    union all select t.advice_id,'parcel',t.sync_state,t.tracking_norm,null from tracking_records t
      where t.org_id=$1 and t.direction='inbound' and t.advice_id is not null and t.closed_at is null
      and t.sync_state in ('needs_verification','needs_carrier')
    union all select k.id,'support',k.state,k.public_no,k.next_action_at from tickets k
      where k.org_id=$1 and k.state='waiting_customer'
    union all select s.id,'scope','scope_review',o.public_no,null from scope_revisions s join orders o on o.id=s.order_id
      where o.org_id=$1 and o.state='awaiting_samples' and s.accepted_at is null
      and s.previous_snapshot->>'order_revision'=o.revision::text
    union all select e.id,'email',e.delivery_state,null,null from user_emails e
      where e.user_id=$2 and e.is_primary and e.delivery_state in ('bounced','complained')
    union all select r.id,'reference',
      case when r.expires_at<=now() then 'reference_expired' else 'reference_conflict' end,
      w.code,r.expires_at
      from reference_samples r join warehouse_items w on w.id=r.item_id
      where r.org_id=$1 and r.state='active' and (
        r.expires_at<=now() or (
          r.authorization_snapshot ? 'outbound_conflict_at'
          and exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null)
        )
      )
    union all select w.id,'storage',
      case when w.storage_until<=now() then 'storage_expired' else 'storage_expiring' end,
      w.code,w.storage_until
      from warehouse_items w
      where w.org_id=$1 and w.custody_state in ('received','stored') and w.parent_item_id is null
        and w.storage_until is not null and w.storage_until<=now()+interval '3 days'
        and not exists(select 1 from disposition_requests d where d.item_id=w.id and d.state='requested')
  ) actions order by due_at nulls last,kind,reference,id limit 200`,[org,actor.id]);
  return {rows};
}
export async function customerDesk(db:DB,actor:Actor) {
  const org=organization(actor);
  const orders=(await db.query(`select id,public_no,state,revision,price_cents,created_at from orders where org_id=$1 order by created_at desc limit 200`,[org])).rows;
  const advices=(await db.query(`select a.id,a.address_snapshot,t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,p.state warehouse_state,
    array(select order_id from advice_orders where advice_id=a.id) order_ids,
    array(select o.public_no from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=a.id order by o.public_no) order_numbers
    from package_advices a
    join tracking_records t on t.advice_id=a.id and t.closed_at is null left join packages p on p.advice_id=a.id
    where a.org_id=$1 order by a.created_at desc limit 200`,[org])).rows;
  const shipments=(await db.query(`select s.id,s.state,s.tracking_norm,s.carrier_code,s.shipped_at,b.action from shipments s join dispatch_batches b on b.id=s.batch_id
    where b.org_id=$1 and s.shipped_at is not null order by s.shipped_at desc limit 200`,[org])).rows;
  const quotes=(await db.query(`select q.id,q.revision,q.amount_cents,q.expires_at,'dispatch' purpose,q.batch_id,b.action,
    q.snapshot, (select jsonb_object_agg(w.id::text,w.code) from dispatch_batch_items bi join warehouse_items w
      on w.id=bi.item_id and w.org_id=bi.org_id where bi.batch_id=b.id and bi.org_id=b.org_id) item_codes
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id where b.org_id=$1 and b.state='quoted' and q.accepted_at is null and q.expires_at>now()
    union all select q.id,q.revision,q.amount_cents,q.expires_at,'storage',null,d.action,q.snapshot,jsonb_build_object(w.id::text,w.code)
    from storage_quotes q join disposition_requests d on d.id=q.disposition_id join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
    where d.org_id=$1 and q.accepted_at is null and q.expires_at>now() limit 100`,[org])).rows;
  const batches=(await db.query("select id,state,revision,action from dispatch_batches where org_id=$1 and state='draft' limit 100",[org])).rows;
  const reports=(await db.query(`select r.order_id,r.public_no,r.published_version,o.public_no order_no from reports r join orders o on o.id=r.order_id
    where o.org_id=$1 and r.published_version is not null limit 200`,[org])).rows;
  const tickets=(await db.query(`select id,public_no,subject,state,details->>'decision' decision from tickets where org_id=$1 order by created_at desc limit 100`,[org])).rows;
  const notices=(await customerNotifications(db,actor)).rows;
  const references=(await db.query(`select r.id reference_id,r.item_id,r.state,r.revision,r.condition_note,r.expires_at,
    r.expires_at<=now() expired,
    exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null) in_use,
    coalesce(
      (select l.category_id from order_line_item_links a join order_lines l on l.id=a.order_line_id where a.item_id=w.id order by a.linked_at desc limit 1),
      (r.authorization_snapshot->>'category_id')::uuid
    ) category_id,
    w.code,w.custody_state
    from reference_samples r join warehouse_items w on w.id=r.item_id
    where r.org_id=$1 order by r.expires_at desc,r.revision desc limit 100`,[org])).rows;
  return {orders,advices,shipments,quotes,batches,reports,tickets,notices,references,profile:await receiving(db,actor.id),email_delivery:await customerEmailDeliveryStatus(db,actor),items:await items(db,actor),bills:await bills(db,actor)};
}
export async function customerNotifications(db:DB,actor:Actor,unread=false,before:string|null=null) {
  const org=organization(actor),pageSize=50;
  if(before)await one(db,"select id from notifications where id=$1 and user_id=$2",[before,actor.id]);
  const {rows}=await db.query(`with batch as (
    select n.id,n.template,n.read_at,n.created_at,n.order_id,n.payload
    from notifications n where n.user_id=$1 and (not $3::boolean or n.read_at is null)
    and ($4::uuid is null or (coalesce(n.created_at,'-infinity'),n.id)<(
      select coalesce(prev.created_at,'-infinity'),prev.id from notifications prev where prev.id=$4 and prev.user_id=$1))
    order by n.created_at desc nulls last,n.id desc limit $5
  )
  select n.id,n.template,n.read_at,n.created_at,o.public_no order_number,
    (select v.version from reports r join report_versions v on v.report_id=r.id
      where r.order_id=o.id and v.version::text=n.payload->>'version' and v.state in ('published','superseded')) report_version,
    (select k.id from tickets k where k.id::text=n.payload->>'ticket_id' and k.org_id=$2) case_id,
    coalesce((select s.id from shipments s join dispatch_batches b on b.id=s.batch_id
      where s.id::text=n.payload->>'shipment_id' and b.org_id=$2),
      (select tr.shipment_id from tracking_records tr where tr.id::text=n.payload->>'tracker_id' and tr.org_id=$2)) shipment_id,
    coalesce((select p.advice_id from packages p where p.id::text=n.payload->>'package_id' and p.org_id=$2),
      (select tr.advice_id from tracking_records tr where tr.id::text=n.payload->>'tracker_id' and tr.org_id=$2)) advice_id,
    (select c.id from charge_items c where c.id::text=n.payload->>'charge_id' and c.org_id=$2) charge_id
  from batch n left join orders o on o.id=n.order_id and o.org_id=$2
  order by n.created_at desc nulls last,n.id desc`,[actor.id,org,unread,before,pageSize+1]);
  const page=rows.slice(0,pageSize);
  return {rows:page,next_before:rows.length>pageSize?page.at(-1)?.id:null};
}
export async function markNotificationRead(db:DB,actor:Actor,id:string) {
  organization(actor);
  return one(db,`update notifications set read_at=coalesce(read_at,now()) where id=$1 and user_id=$2 returning id,read_at`,[id,actor.id]);
}
export async function warehousePackage(db:DB,actor:Actor,value:string,byCode=false) {
  role(actor,...staffAccess.intake);
  const parcel=await one(db,`select p.id,p.code,p.state,p.revision,p.received_quantity,p.received_at,p.weight_g,
    p.condition_note,p.org_id,sl.code location_code,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=p.org_id limit 1) receiving_code,
    t.tracking_norm,t.transport_state,t.sync_state,
    (select s.events_json from tracking_snapshots s where s.tracker_id=t.id and s.locale='zh-CN'
      order by s.latest_event_at desc nulls last,s.fetched_at desc limit 1) tracking_events,
    array(select o.public_no from advice_orders ao join orders o on o.id=ao.order_id
      where ao.advice_id=p.advice_id order by o.public_no) order_numbers
    from packages p
    left join storage_locations sl on sl.id=p.location_id
    left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null
    where ${byCode?"p.code":"p.id"}=$1`,[value]);
  const items=(await db.query(`select w.id,w.code,w.parent_item_id,w.intake_batch_id,w.identity_state,w.condition_state,w.custody_state,l.code location
    from warehouse_items w left join storage_locations l on l.id=w.location_id
    where w.package_id=$1 order by w.received_at,w.code`,[parcel.id])).rows;
  return {parcel,items};
}
export async function warehouseItem(db:DB,actor:Actor,code:string) {
  role(actor,...staffAccess.intake);
  const item=await one(db,`select w.id,w.code,w.org_id,w.revision,w.parent_item_id,w.intake_batch_id,
    w.identity_state,w.condition_state,w.custody_state,
    p.code package_code,sl.code location,o.id order_id,o.public_no order_number,o.state order_state,
    a.order_line_id,a.expected_item_id,e.position expected_position,e.declared_fields,
    exists(select 1 from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled')) reserved,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'custody_state',c.custody_state) order by c.code),'[]'::jsonb)
     from warehouse_items c where c.parent_item_id=w.id) components
    from warehouse_items w join packages p on p.id=w.package_id
    left join storage_locations sl on sl.id=w.location_id
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join expected_items e on e.id=a.expected_item_id
    left join order_lines l on l.id=a.order_line_id left join orders o on o.id=l.order_id
    where w.code=$1`,[code]);
  const movable=["received","stored"].includes(item.custody_state);
  const eligible=item.org_id&&!item.parent_item_id&&!item.order_number&&!item.reserved&&movable&&item.identity_state!=="quarantined";
  const positions=eligible?(await db.query(`select e.id,e.position,e.declared_fields,l.id order_line_id,o.public_no,s.title
    from expected_items e join order_lines l on l.id=e.order_line_id
    join orders o on o.id=l.order_id join service_offers s on s.id=l.offer_id
    where l.org_id=$1 and o.state='awaiting_samples' and o.paid_at is not null and e.in_scope
    and not exists(select 1 from order_line_item_links a where a.expected_item_id=e.id and a.unlinked_at is null)
    order by o.public_no,l.id,e.position`,[item.org_id])).rows:[];
  return {item:{id:item.id,code:item.code,revision:item.revision,parent_item_id:item.parent_item_id,
    intake_batch_id:item.intake_batch_id,identity_state:item.identity_state,condition_state:item.condition_state,
    custody_state:item.custody_state,package_code:item.package_code,location:item.location,
    order_id:item.order_id??null,order_number:item.order_number,order_state:item.order_state??null,
    order_line_id:item.order_line_id??null,expected_item_id:item.expected_item_id??null,
    expected_position:item.expected_position??null,declared_fields:item.declared_fields??null,
    can_unassign:Boolean(item.order_number && ["awaiting_samples","on_hold"].includes(item.order_state)),
    can_identify:Boolean(item.order_number && ["awaiting_samples","on_hold"].includes(item.order_state) && item.identity_state!=="quarantined"),
    components:item.components,ownership_verified:!!item.org_id,movable},positions};
}
const warehouseBatches=`select b.id,b.revision,b.state,b.action,b.destination_snapshot,q.id quote_id,q.snapshot,
  q.revision quote_revision,q.amount_cents,q.expires_at,q.accepted_at,
  q.expires_at<=now() and q.accepted_at is null renewable_quote,
  (select jsonb_agg(jsonb_build_object('id',w.id,'code',w.code) order by w.code)
    from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id and w.org_id=bi.org_id
    where bi.batch_id=b.id and bi.released_at is null) items,
  array(select si.item_id from shipment_items si where si.batch_id=b.id) packed_item_ids
  from dispatch_batches b left join lateral(
    select * from dispatch_quote_versions q where q.batch_id=b.id order by revision desc limit 1
  ) q on true`;
const activeLocations="select id,code from storage_locations where active order by code";
const activeRates="select id,version from shipping_rate_versions where effective_at<=now() order by version desc";
export const dispatchQueueStates=["weighing","payment","packing","handover","shipped","returned","blocked"] as const;
export async function warehouseDispatchQueue(db:DB,actor:Actor,state:typeof dispatchQueueStates[number],reference:string|null) {
  role(actor,...staffAccess.dispatch);
  const {rows}=await db.query(`with queue as (
    select b.id,b.action,q.expires_at,
      (select min((d.return_info->>'deadline')::timestamptz) from dispatch_batch_items i
        join disposition_requests d on d.id=i.disposition_id where i.batch_id=b.id and i.released_at is null) return_deadline,
      (select count(*)::int from dispatch_batch_items i where i.batch_id=b.id and i.released_at is null) remaining,
      s.packed,s.shipped,s.returns,s.last_handover,s.waybills,
      exists(select 1 from dispatch_quote_versions dq join charge_items c on c.dispatch_quote_id=dq.id
        where dq.batch_id=b.id and ${effectiveDispatchCharge}) paid,
      exists(select 1 from dispatch_batch_items i left join shipment_items si on si.batch_id=i.batch_id and si.item_id=i.item_id
        where i.batch_id=b.id and i.released_at is null and si.item_id is null) needs_packing,
      b.state,(q.expires_at<=now() and q.accepted_at is null) renewable
    from dispatch_batches b left join lateral(select expires_at,accepted_at from dispatch_quote_versions
      where batch_id=b.id order by revision desc limit 1) q on true
    left join lateral(select count(*) filter (where sh.state='packed')::int packed,
      count(*) filter (where sh.shipped_at is not null)::int shipped,
      count(*) filter (where exists(select 1 from shipment_return_items sr where sr.shipment_id=sh.id))::int returns,
      max(sh.shipped_at) last_handover,
      array_agg(distinct sh.tracking_norm order by sh.tracking_norm) filter (where sh.tracking_norm is not null) waybills
      from shipments sh where sh.batch_id=b.id) s on true
    where b.state<>'draft' and ($2::text is null or b.id::text=$2 or $2=any(s.waybills))
  ) select id,action,state,expires_at,return_deadline,remaining,packed,shipped,returns,last_handover,waybills from queue where case $1::text
    when 'weighing' then state='confirmed' or state='quoted' and renewable
    when 'payment' then state='quoted' and not coalesce(renewable,false)
    when 'packing' then state='paid' and paid and needs_packing
    when 'handover' then state='paid' and paid and packed>0
    when 'shipped' then shipped>0
    when 'returned' then returns>0
    when 'blocked' then state='paid' and not paid
    else false end
  order by case when $1 in ('weighing','payment','packing','handover') then least(return_deadline,
    case when $1 in ('weighing','payment') then expires_at end) end nulls last,
    last_handover desc nulls last,id limit 100`,[state,reference]);
  return {rows};
}
export async function warehouseDispatchBatch(db:DB,actor:Actor,id:string) {
  role(actor,...staffAccess.dispatch);
  const batch=await one(db,warehouseBatches+" where b.id=$1 and b.state<>'draft'",[id]);
  const {rows:shipments}=await db.query(`select s.id,s.revision,s.state,s.weight_g,s.carrier_code,s.tracking_norm,
    s.shipped_at,s.returned_at,t.transport_state,t.sync_state,zh.fetched_at tracking_updated_at,zh.events_json tracking_events,
    (select jsonb_agg(jsonb_build_object('id',w.id,'code',w.code,'received_at',r.received_at) order by w.code)
      from shipment_items si join warehouse_items w on w.id=si.item_id and w.org_id=b.org_id
      left join shipment_return_items r on r.shipment_id=si.shipment_id and r.item_id=si.item_id
      where si.shipment_id=s.id) items,
    array(select m.id from media_assets m where m.shipment_id=s.id and m.org_id=b.org_id and m.kind='dispatch'
      and m.status='ready' order by m.id) evidence_ids
    from shipments s join dispatch_batches b on b.id=s.batch_id
    left join tracking_records t on t.shipment_id=s.id and t.batch_id=b.id and t.org_id=b.org_id and t.closed_at is null
    left join lateral(select fetched_at,events_json from tracking_snapshots
      where tracker_id=t.id and locale='zh-CN' order by latest_event_at desc nulls last,fetched_at desc limit 1) zh on true
    where s.batch_id=$1 order by s.shipped_at nulls first,s.id`,[id]);
  return {batch,shipments,rates:(await db.query(activeRates)).rows,locations:(await db.query(activeLocations)).rows};
}
export async function warehouseDesk(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","inspector","reviewer");
  const canReceive=actor.roles.some(r=>["receiver","warehouse_admin"].includes(r)),canShip=actor.roles.includes("warehouse_admin");
  const packages=canReceive?(await db.query(`select p.id,p.code,p.state,p.org_id,p.revision,p.received_quantity,t.tracking_norm from packages p
    left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null order by p.received_at desc limit 100`)).rows:[];
  const items=canReceive?(await db.query(`select w.id,w.code,w.package_id,w.org_id,w.revision,w.custody_state,l.code location from warehouse_items w left join storage_locations l on l.id=w.location_id
    where w.custody_state in ('received','stored') order by w.received_at desc limit 400`)).rows:[];
  const locations=canReceive?(await db.query(activeLocations)).rows:[];
  const tasks=actor.roles.some(r=>["inspector","reviewer"].includes(r))?(await db.query(`select t.id,t.state,t.revision,t.assignee_id,l.order_id,o.public_no,o.state order_state,o.sla_due_at,o.samples_ready_at,
    (o.sla_due_at is not null and o.sla_due_at<=now()) sla_overdue,
    so.title,st.code service,c.labels category_labels,w.id item_id,w.code item_code
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    join categories c on c.id=l.category_id
    left join order_line_item_links a on a.id=t.assignment_id left join warehouse_items w on w.id=a.item_id
    where t.state in ('READY','IN_PROGRESS','SUBMITTED') and o.state in ('queued','inspecting','qa_review')
    order by o.sla_due_at asc nulls last,o.samples_ready_at asc nulls last,o.created_at asc,t.id asc limit 400`)).rows:[];
  const reports=actor.roles.includes("reviewer")?(await db.query(`select v.id,v.version,v.state,v.revision,v.snapshot,r.published_version,o.public_no from report_versions v join reports r on r.id=v.report_id
    join orders o on o.id=r.order_id where v.state in ('submitted','qa_approved') and o.state='qa_review' limit 100`)).rows:[];
  const batches=canShip?(await db.query(warehouseBatches+
    " where b.state in ('confirmed','quoted','paid') order by q.expires_at nulls last,b.id limit 100")).rows:[];
  const shipments=canShip?(await db.query(`select s.id,s.state,s.revision,s.tracking_norm,s.batch_id,b.action,s.weight_g,
    array(select item_id from shipment_items where shipment_id=s.id) item_ids,
    (select jsonb_object_agg(w.id::text,w.code) from shipment_items si join warehouse_items w on w.id=si.item_id where si.shipment_id=s.id) item_codes,
    array(select item_id from shipment_return_items where shipment_id=s.id) returned_item_ids from shipments s join dispatch_batches b on b.id=s.batch_id
    order by s.shipped_at desc nulls first limit 100`)).rows:[];
  const rates=canShip?(await db.query(activeRates)).rows:[];
  const retain=canShip?(await db.query(`select d.id,w.code from disposition_requests d join warehouse_items w on w.id=d.item_id
    where d.action='retain' and d.state='requested' and not exists(select 1 from storage_quotes q where q.disposition_id=d.id)`)).rows:[];
  return {packages,items,locations,tasks,reports,batches,shipments,rates,retain};
}
export async function adminDesk(db:DB,actor:Actor) {
  role(actor,...staffAccess.administration);
  const finance=hasStaffAccess(actor.roles,staffAccess.finance);
  const ops=hasStaffAccess(actor.roles,staffAccess.orders);
  const templates=hasStaffAccess(actor.roles,staffAccess.templates);
  const overviewMetrics=ops?(await db.query(`select
    count(*) filter (where coalesce(is_test,false)=false and state='awaiting_samples')::int awaiting_samples,
    count(*) filter (where coalesce(is_test,false)=false and state in ('queued','inspecting'))::int queued_or_inspecting,
    count(*) filter (where coalesce(is_test,false)=false and state in ('queued','inspecting','qa_review') and sla_due_at is not null and sla_due_at<=now())::int sla_overdue,
    count(*) filter (where coalesce(is_test,false)=false and state='qa_review')::int qa_review,
    count(*) filter (where coalesce(is_test,false)=false)::int production_orders,
    count(*) filter (where coalesce(is_test,false)=true)::int test_orders,
    (select count(*)::int from dispatch_batches where state in ('confirmed','quoted','paid')) dispatch_pending,
    (select count(*)::int from tickets where state in ('open','waiting_customer','waiting_internal')) open_tickets,
    (select count(*)::int from payment_disputes where state<>'resolved_by_staff') open_disputes,
    (select count(*)::int from packages where state='unmatched' or org_id is null) unmatched_packages
    from orders`)).rows[0]:null;
  return {
    overviewMetrics,
    orders:ops?(await db.query("select id,public_no,state,coalesce(is_test,false) is_test,sla_due_at,created_at from orders order by created_at desc limit 150")).rows:[],
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
    refunds:finance?(await db.query(`select r.id,r.payment_id,r.amount_cents,r.state,r.reason,r.revision,r.requested_by,
      r.provider_ref,r.source,c.purpose,o.public_no from refunds r join payments p on p.id=r.payment_id
      join charge_items c on c.id=p.charge_item_id left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id order by r.created_at desc limit 100`)).rows:[],
    payments:finance?(await db.query(`select p.id,p.charge_item_id,p.state,p.amount_cents,p.provider_ref,p.created_at,
      c.purpose,o.public_no,coalesce(o.is_test,false) is_test
      from payments p join charge_items c on c.id=p.charge_item_id
      left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id
      order by p.created_at desc limit 150`)).rows:[],
    disputes:finance?(await db.query(`select d.provider_id provider_dispute_id,d.payment_id,p.charge_item_id,
      q.order_id,dq.batch_id,d.state status,p.amount_cents,c.currency,
      d.evidence_due_at,d.updated_at,p.provider_ref payment_provider_ref,o.public_no
      from payment_disputes d
      join payments p on p.id=d.payment_id
      join charge_items c on c.id=p.charge_item_id
      left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id
      left join dispatch_quote_versions dq on dq.id=c.dispatch_quote_id
      order by d.updated_at desc limit 100`)).rows:[],
    shippingRates:(finance||actor.roles.includes("super_admin"))?(await db.query("select id,version,rules,effective_at from shipping_rate_versions order by version desc limit 50")).rows:[],
    warehouseAddressAlert:actor.roles.includes("super_admin")?(await db.query(`select 1 from notifications
      where user_id=$1 and template='warehouse.address_required'
      and not exists(select 1 from warehouse_addresses where is_default and active) limit 1`,[actor.id])).rowCount===1:false,
    addresses:actor.roles.includes("super_admin")?(await db.query(
      `select w.id,w.address_zh,w.address_en,w.contact_name,w.contact_phone,w.active,w.is_default,w.created_at,
              (select count(*)::int from package_advices pa where pa.address_id=w.id) advice_count
       from warehouse_addresses w
       order by w.is_default desc,w.active desc,w.created_at desc`
    )).rows:[],
    calendar:actor.roles.includes("super_admin")?await (async()=>{
      const cfg=(await db.query<{key:string;value:unknown}>("select key,value from app_config where key in ('calendar.holidays','business_holidays','calendar.extra_workdays')")).rows;
      const holidays=new Set<string>();
      const extraWorkdays=new Set<string>();
      for(const r of cfg) {
        if((r.key==="calendar.holidays"||r.key==="business_holidays")&&Array.isArray(r.value)) {
          for(const d of r.value) if(typeof d==="string") holidays.add(d);
        }
        if(r.key==="calendar.extra_workdays"&&Array.isArray(r.value)) {
          for(const d of r.value) if(typeof d==="string") extraWorkdays.add(d);
        }
      }
      return {holidays:[...holidays].sort(),extra_workdays:[...extraWorkdays].sort()};
    })():{holidays:[],extra_workdays:[]},
    termsVersions:actor.roles.includes("super_admin")?(await db.query(
      `select id,kind,version,effective_at,content_md,content_hash,
              case when effective_at is not null and effective_at<=now() then 'published' else 'draft' end state
       from terms_versions
       order by kind,effective_at desc nulls first,version desc`
    )).rows:[],
    staffUsers:actor.roles.includes("super_admin")?(await db.query(
      `select u.id,u.display_name,u.status,u.auth_version,u.created_at,u.updated_at,
              (select ue.original_email from user_emails ue where ue.user_id=u.id order by ue.is_primary desc,ue.id limit 1) email,
              coalesce(array(select sr.role from staff_roles sr where sr.user_id=u.id order by sr.role), array[]::text[]) roles
       from users u
       where exists(select 1 from staff_roles sr where sr.user_id=u.id)
          or u.mfa_secret_enc is not null
       order by u.created_at asc`
    )).rows:[],
    templates:templates?(await db.query(`select t.id,t.template_key,t.category_id,t.service_type_id,t.version,t.state,t.content,
      t.content_hash,t.author_id,t.reviewer_id,t.published_at,
      array(select c.code from template_capabilities tc join capabilities c on c.id=tc.capability_id
        where tc.template_version_id=t.id order by c.code) capability_codes
      from template_versions t order by t.published_at desc nulls first,t.template_key,t.version desc limit 100`)).rows:[],
    categories:templates?(await db.query("select id,slug,labels,status,revision,admission_snapshot from categories order by slug")).rows:[],
    services:templates?(await db.query("select id,code,labels from service_types order by code")).rows:[],
    capabilities:templates?(await db.query("select id,code,method from capabilities where approved_by is not null and revoked_at is null order by code")).rows:[],
    allCapabilities:templates?(await db.query("select id,code,method,approval,approved_by,revoked_at from capabilities order by code")).rows:[],
    offers:templates?(await db.query(`select o.id,o.sku_code,o.title,o.enabled,o.service_type_id,ot.category_id,ot.template_version_id,
      p.version price_version,p.rules from service_offers o
      left join offer_templates ot on ot.offer_id=o.id
      left join lateral(select version,rules from sku_prices sp where sp.offer_id=o.id and effective_from<=now()
        and (effective_to is null or effective_to>now()) order by effective_from desc,version desc limit 1) p on true
      order by o.sku_code`)).rows:[],
    jobErrors:actor.roles.includes("super_admin")?(await db.query("select id,type,attempts,last_error,next_attempt_at from outbox_events where processed_at is null and attempts>0 order by id desc limit 50")).rows:[],
  };
}
export async function readOrderByPublicNumber(db:DB,actor:Actor,publicNo:string) {
  const row=await one<{id:string;public_no:string;revision:number;state:string}>(db,"select id,public_no,revision,state from orders where public_no=$1 and org_id=$2",[publicNo,organization(actor)]);
  return orderDTO(row);
}
const inboundBelongsToOrder=`t.org_id=o.org_id and (exists(
  select 1 from advice_orders ao where ao.advice_id=t.advice_id and ao.org_id=o.org_id and ao.order_id=o.id
) or exists(
  select 1 from warehouse_items w join order_line_item_links a on a.item_id=w.id and a.org_id=w.org_id and a.unlinked_at is null
  join order_lines l on l.id=a.order_line_id
  where w.package_id=t.package_id and w.org_id=o.org_id and l.order_id=o.id
))`;
export const staffOrderFilters=z.object({
  query:z.string().trim().max(254).default(""),
  state:z.enum(["draft","awaiting_payment","awaiting_samples","samples_ready","queued","inspecting","qa_review",
    "report_ready","action_pending","closed","on_hold","cancelled"]).optional(),
  from:z.iso.date().optional(),to:z.iso.date().optional(),
  test:z.enum(["all","production","test"]).default("all"),
  limit:z.coerce.number().int().min(1).max(100).default(50),
  cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).optional(),
}).refine(v=>!v.from||!v.to||v.from<=v.to,{message:"The end date must be on or after the start date."});
const staffOrderCursor=z.object({at:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  id:z.uuid(),filter:z.string().length(64)});
export async function searchStaffOrders(db:DB,actor:Actor,filters:z.infer<typeof staffOrderFilters>) {
  role(actor,...staffAccess.orders);
  const {query,state,from,to,test,limit,cursor}=filters;
  const key=query?query.includes("@")?z.email().parse(query.toLowerCase()):waybill(query):"";
  const filter=hash(JSON.stringify({key,state,from,to,test,limit}));
  let after:z.infer<typeof staffOrderCursor>|undefined;
  if(cursor) {
    let decoded:unknown;
    try {decoded=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}
    catch {guard(false,"INVALID_CURSOR","Reload the order search.",422);}
    after=staffOrderCursor.parse(decoded);
    guard(after.filter===filter,"INVALID_CURSOR","Restart pagination after changing search filters.",422);
  }
  const {rows}=await db.query(`select o.id,o.public_no,o.state,o.created_at,o.is_test,
    to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time from orders o
    where ($1='' or o.public_no=$1 or exists(
      select 1 from tracking_records t where t.tracking_norm=$1 and t.direction='inbound'
      and t.closed_at is null and ${inboundBelongsToOrder}
    ) or exists(
      select 1 from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.org_id=o.org_id
      join warehouse_items w on w.id=a.item_id and w.org_id=a.org_id
      where l.order_id=o.id and upper(w.code)=$1 and a.unlinked_at is null
    ) or exists(select 1 from memberships m join user_emails e on e.user_id=m.user_id
      where m.org_id=o.org_id and e.normalized_email=$1 and e.verified_at is not null))
    and ($2::text is null or o.state=$2)
    and ($3::date is null or o.created_at>=($3::date)::timestamp at time zone 'UTC')
    and ($4::date is null or o.created_at<($4::date+1)::timestamp at time zone 'UTC')
    and ($5='all' or o.is_test=($5='test'))
    and ($6::timestamptz is null or (o.created_at,o.id)<($6::timestamptz,$7::uuid))
    order by o.created_at desc,o.id desc limit $8`,[key,state??null,from??null,to??null,test,after?.at??null,after?.id??null,limit+1]);
  const page=rows.slice(0,limit),last=page.at(-1);
  return {rows:page.map(({cursor_time,...row})=>row),
    next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.cursor_time,id:last.id,filter})).toString("base64url"):null};
}
export async function staffOrderDetail(db:DB,actor:Actor,publicNo:string) {
  role(actor,...staffAccess.orders);
  const order=await one<Parameters<typeof orderDTO>[0]&{org_id:string;created_at:Date;paid_at:Date|null;samples_ready_at:Date|null;
    sla_due_at:Date|null;report_published_at:Date|null;closed_at:Date|null}>(db,`select id,org_id,public_no,state,revision,created_at,paid_at,samples_ready_at,sla_due_at,
    report_published_at,closed_at from orders where public_no=$1`,[publicNo]);
  const {id,org_id}=order;
  const {rows:lines}=await db.query(`select l.quantity,s.title,l.id,
    (select count(*)::int from expected_items e where e.order_line_id=l.id and e.in_scope) current_positions
    from order_lines l join service_offers s on s.id=l.offer_id where l.order_id=$1 order by l.id`,[id]);
  const {rows:items}=await db.query(`select w.code,w.custody_state,w.identity_state,loc.code location,e.position
    from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.org_id=$2 and a.unlinked_at is null
    join expected_items e on e.id=a.expected_item_id
    join warehouse_items w on w.id=a.item_id and w.org_id=a.org_id left join storage_locations loc on loc.id=w.location_id
    where l.order_id=$1 order by l.id,e.position`,[id,org_id]);
  const {rows:parcels}=await db.query(`select t.tracking_norm,t.carrier_code,t.transport_state,p.code,p.state custody,p.received_at
    from orders o join tracking_records t on t.org_id=o.org_id and t.direction='inbound' and t.closed_at is null
    left join packages p on p.id=t.package_id and p.org_id=o.org_id
    where o.id=$1 and ${inboundBelongsToOrder} order by t.tracking_norm`,[id]);
  const {rows:tickets}=await db.query(`select id,public_no,subject,state from tickets where order_id=$1 and org_id=$2
    order by created_at desc,id limit 100`,[id,org_id]);
  const {rows:blocks}=await db.query(`select reason,opened_at,resolved_at from order_blocks
    where order_id=$1 order by opened_at desc,id`,[id]);
  const {rows:activity}=await db.query(`select a.id,a.at,a.actor_type,a.action,u.display_name
    from audit_events a left join users u on u.id=a.actor_id where a.entity_type='orders' and a.entity_id=$1
    order by a.at desc,a.id desc limit 100`,[id]);
  const customer=(await db.query(`select u.id,u.status,p.receiving_code,e.normalized_email::text as email
    from customer_receiving_profiles p join users u on u.id=p.user_id left join user_emails e on e.user_id=u.id and e.is_primary
    where p.org_id=$1 limit 1`,[org_id])).rows[0]??null;
  const shipments=(await orderShipments(db,id,org_id)).map(({state,tracking_norm,shipped_at,action})=>({state,tracking_norm,shipped_at,action}));
  return {order:orderDTO(order),created_at:order.created_at,paid_at:order.paid_at,
    samples_ready_at:order.samples_ready_at,sla_due_at:order.sla_due_at,report_published_at:order.report_published_at,closed_at:order.closed_at,
    customer,lines,items,parcels,tickets,blocks,activity,shipments};
}

export async function reconcileFinance(db:DB,actor:Actor,includeTest=true) {
  role(actor,...staffAccess.finance);
  const {rows}=await db.query<{
    charge_item_id:string;purpose:string;amount_cents:number;currency:string;
    state:string;paid_cents:number;refunded_cents:number;batch_id:string|null;
    inspection_order_id:string|null;inspection_order_no:string|null;is_test:boolean;
    allocations:{order_id:string;public_no:string;amount_cents:number}[];
  }>(
    `select c.id charge_item_id,c.purpose,c.amount_cents,c.currency,
            case when c.voided_at is not null then 'void'
                 when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
                 else 'open' end state,
            coalesce((select p.amount_cents from payments p where p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')),0)::int paid_cents,
            coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id and r.state in ('approved','succeeded')),0)::int refunded_cents,
            dq.batch_id,
            iq.order_id inspection_order_id,
            io.public_no inspection_order_no,
            coalesce(io.is_test,false) is_test,
            coalesce((
              select jsonb_agg(jsonb_build_object('order_id',a.order_id,'public_no',o.public_no,'amount_cents',a.amount_cents) order by o.public_no)
              from charge_allocations a join orders o on o.id=a.order_id
              where a.charge_id=c.id
            ),'[]'::jsonb) allocations
     from charge_items c
     left join inspection_quotes iq on iq.id=c.inspection_quote_id
     left join orders io on io.id=iq.order_id
     left join dispatch_quote_versions dq on dq.id=c.dispatch_quote_id
     left join storage_quotes sq on sq.id=c.storage_quote_id
     where ($1::boolean or coalesce(io.is_test,false)=false)
     order by c.id desc limit 400`,
    [includeTest]
  );

  const items=rows.map(r=>{
    const allocs=r.purpose==="inspection" && r.inspection_order_id && r.inspection_order_no
      ?[{order_id:r.inspection_order_id,public_no:r.inspection_order_no,amount_cents:r.amount_cents}]
      :(r.allocations??[]);
    const allocatedCents=allocs.reduce((n,a)=>n+Number(a.amount_cents),0);
    const unallocatedCents=r.amount_cents-allocatedCents;
    const netCents=r.paid_cents-r.refunded_cents;
    return {
      charge_id:r.charge_item_id,
      charge_item_id:r.charge_item_id,
      purpose:r.purpose,
      order_public_no:r.inspection_order_no,
      amount_cents:r.amount_cents,
      currency:r.currency,
      state:r.state,
      paid_cents:r.paid_cents,
      refunded_cents:r.refunded_cents,
      net_cents:netCents,
      batch_id:r.batch_id,
      allocations:allocs,
      allocated_cents:allocatedCents,
      unallocated_cents:unallocatedCents,
      allocation_balanced:allocatedCents+unallocatedCents===r.amount_cents && unallocatedCents>=0,
    };
  });

  const inspectionPaid=items.filter(x=>x.purpose==="inspection").reduce((n,x)=>n+x.paid_cents,0);
  const dispatchPaid=items.filter(x=>x.purpose==="dispatch").reduce((n,x)=>n+x.paid_cents,0);
  const storagePaid=items.filter(x=>x.purpose==="storage").reduce((n,x)=>n+x.paid_cents,0);
  const refundedTotal=items.reduce((n,x)=>n+x.refunded_cents,0);
  const netReceived=items.reduce((n,x)=>n+x.net_cents,0);
  const summary={
    inspection_cents:inspectionPaid,
    inspection_paid_cents:inspectionPaid,
    dispatch_cents:dispatchPaid,
    dispatch_paid_cents:dispatchPaid,
    storage_cents:storagePaid,
    storage_paid_cents:storagePaid,
    paid_cents:items.reduce((n,x)=>n+x.paid_cents,0),
    refunded_cents:refundedTotal,
    net_cents:netReceived,
    net_received_cents:netReceived,
    unallocated_dispatch_cents:items.filter(x=>x.purpose==="dispatch"&&x.state==="paid").reduce((n,x)=>n+x.unallocated_cents,0),
    all_balanced:items.every(x=>x.allocation_balanced),
  };

  return {summary,rows:items};
}

export async function orderLedger(db:DB,actor:Actor,opts:{includeTest?:boolean;limit?:number}={}) {
  role(actor,...staffAccess.finance);
  const includeTest=opts.includeTest===true;
  const limit=Math.min(Math.max(opts.limit??30,1),200);
  const hourlyLaborCents=1500;

  const {rows:orderRows}=await db.query<{
    id:string;
    public_no:string;
    state:string;
    is_test:boolean;
    created_at:string;
    category_slugs:string[];
    service_codes:string[];
    sample_count:number;
    inspection_paid_cents:number;
    inspection_refunded_cents:number;
    pass_through_shipping_cents:number;
    storage_allocated_cents:number;
    inspection_seconds:number;
    provider_refs:string[];
    anomaly_count:number;
  }>(
    `select o.id,
            o.public_no,
            o.state,
            coalesce(o.is_test,false) is_test,
            o.created_at,
            coalesce(array(
              select distinct cat.slug from order_lines ol join categories cat on cat.id=ol.category_id where ol.order_id=o.id order by cat.slug
            ), array[]::text[]) category_slugs,
            coalesce(array(
              select distinct st.code from order_lines ol join service_offers so on so.id=ol.offer_id join service_types st on st.id=so.service_type_id where ol.order_id=o.id order by st.code
            ), array[]::text[]) service_codes,
            coalesce((select sum(ol.quantity)::int from order_lines ol where ol.order_id=o.id),0)::int sample_count,
            coalesce((
              select sum(p.amount_cents)::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id and c.purpose='inspection' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where iq.order_id=o.id
            ),0)::int inspection_paid_cents,
            coalesce((
              select sum(r.amount_cents)::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id and c.purpose='inspection'
              join payments p on p.charge_item_id=c.id
              join refunds r on r.payment_id=p.id and r.state in ('approved','succeeded')
              where iq.order_id=o.id
            ),0)::int inspection_refunded_cents,
            coalesce((
              select sum(ca.amount_cents)::int
              from charge_allocations ca
              join charge_items c on c.id=ca.charge_id and c.purpose='dispatch' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where ca.order_id=o.id
            ),0)::int pass_through_shipping_cents,
            coalesce((
              select sum(ca.amount_cents)::int
              from charge_allocations ca
              join charge_items c on c.id=ca.charge_id and c.purpose='storage' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where ca.order_id=o.id
            ),0)::int storage_allocated_cents,
            coalesce((
              select sum(coalesce(st_row.seconds,0))::int
              from step_timings st_row
              where st_row.order_id=o.id
            ),0)::int inspection_seconds,
            coalesce(array(
              select distinct ref from (
                select p.provider_ref as ref
                from inspection_quotes iq
                join charge_items c on c.inspection_quote_id=iq.id
                join payments p on p.charge_item_id=c.id
                where iq.order_id=o.id and p.provider_ref is not null
                union
                select r.provider_ref as ref
                from inspection_quotes iq
                join charge_items c on c.inspection_quote_id=iq.id
                join payments p on p.charge_item_id=c.id
                join refunds r on r.payment_id=p.id
                where iq.order_id=o.id and r.provider_ref is not null
                union
                select p.provider_ref as ref
                from charge_allocations ca
                join charge_items c on c.id=ca.charge_id
                join payments p on p.charge_item_id=c.id
                where ca.order_id=o.id and p.provider_ref is not null
              ) refs where ref is not null and ref<>'' order by ref
            ), array[]::text[]) provider_refs,
            coalesce((
              select count(*)::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id
              join payments p on p.charge_item_id=c.id
              where iq.order_id=o.id and p.state in ('amount_mismatch','disputed','late_payment')
            ),0)::int anomaly_count
     from orders o
     where ($1::boolean or coalesce(o.is_test,false)=false)
       and o.state<>'draft'
     order by o.created_at desc,o.id desc
     limit $2`,
    [includeTest,limit]
  );

  const orders=orderRows.map(r=>{
    const netInspectionCents=r.inspection_paid_cents-r.inspection_refunded_cents;
    const laborCostCents=Math.round((r.inspection_seconds/3600)*hourlyLaborCents);
    const contributionCents=netInspectionCents+r.storage_allocated_cents-laborCostCents;
    const hasPaid=r.inspection_paid_cents>0||r.pass_through_shipping_cents>0||r.storage_allocated_cents>0;
    const channelReconciled=r.anomaly_count===0&&(!hasPaid||r.provider_refs.length>0);
    return {
      order_id:r.id,
      public_no:r.public_no,
      state:r.state,
      is_test:r.is_test,
      created_at:r.created_at,
      category_slug:r.category_slugs[0]??"apparel",
      category_slugs:r.category_slugs,
      service_code:r.service_codes[0]??"std",
      service_codes:r.service_codes,
      sample_count:r.sample_count,
      inspection_paid_cents:r.inspection_paid_cents,
      inspection_refunded_cents:r.inspection_refunded_cents,
      net_inspection_cents:netInspectionCents,
      pass_through_shipping_cents:r.pass_through_shipping_cents,
      storage_allocated_cents:r.storage_allocated_cents,
      inspection_seconds:r.inspection_seconds,
      inspection_minutes:Number((r.inspection_seconds/60).toFixed(2)),
      labor_cost_cents:laborCostCents,
      contribution_cents:contributionCents,
      provider_refs:r.provider_refs,
      channel_reconciled:channelReconciled,
    };
  });

  const groupMap=new Map<string,{
    category_slug:string;
    service_code:string;
    order_count:number;
    sample_count:number;
    inspection_seconds:number;
    net_inspection_cents:number;
    labor_cost_cents:number;
    contribution_cents:number;
  }>();
  for(const row of orders) {
    const key=`${row.category_slug}:${row.service_code}`;
    const cur=groupMap.get(key)??{
      category_slug:row.category_slug,
      service_code:row.service_code,
      order_count:0,
      sample_count:0,
      inspection_seconds:0,
      net_inspection_cents:0,
      labor_cost_cents:0,
      contribution_cents:0,
    };
    cur.order_count+=1;
    cur.sample_count+=row.sample_count;
    cur.inspection_seconds+=row.inspection_seconds;
    cur.net_inspection_cents+=row.net_inspection_cents;
    cur.labor_cost_cents+=row.labor_cost_cents;
    cur.contribution_cents+=row.contribution_cents;
    groupMap.set(key,cur);
  }
  const byCategoryService=[...groupMap.values()].map(g=>({
    ...g,
    avg_seconds_per_sample:g.sample_count>0?Math.round(g.inspection_seconds/g.sample_count):0,
  }));

  const sumInspectionPaid=orders.reduce((n,r)=>n+r.inspection_paid_cents,0);
  const sumInspectionRefunded=orders.reduce((n,r)=>n+r.inspection_refunded_cents,0);
  const sumNetInspection=orders.reduce((n,r)=>n+r.net_inspection_cents,0);
  const sumPassThroughShipping=orders.reduce((n,r)=>n+r.pass_through_shipping_cents,0);
  const sumStorageAllocated=orders.reduce((n,r)=>n+r.storage_allocated_cents,0);
  const sumInspectionSeconds=orders.reduce((n,r)=>n+r.inspection_seconds,0);
  const sumLaborCost=orders.reduce((n,r)=>n+r.labor_cost_cents,0);
  const sumContribution=orders.reduce((n,r)=>n+r.contribution_cents,0);

  const summary={
    include_test:includeTest,
    limit,
    order_count:orders.length,
    hourly_labor_cents:hourlyLaborCents,
    inspection_paid_cents:sumInspectionPaid,
    inspection_refunded_cents:sumInspectionRefunded,
    net_inspection_cents:sumNetInspection,
    pass_through_shipping_cents:sumPassThroughShipping,
    storage_allocated_cents:sumStorageAllocated,
    total_inspection_seconds:sumInspectionSeconds,
    total_labor_cost_cents:sumLaborCost,
    total_contribution_cents:sumContribution,
    recomputable_balanced:
      sumNetInspection===sumInspectionPaid-sumInspectionRefunded &&
      sumContribution===sumNetInspection+sumStorageAllocated-sumLaborCost,
    all_channel_reconciled:orders.every(r=>r.channel_reconciled),
  };

  return {summary,orders,by_category_service:byCategoryService};
}

function csvCell(value:unknown) {
  const s=String(value??"");
  return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}

export async function orderLedgerCsv(db:DB,actor:Actor,opts:{includeTest?:boolean;limit?:number}={}) {
  const ledger=await orderLedger(db,actor,opts);
  const headers=[
    "public_no",
    "state",
    "is_test",
    "category_slug",
    "service_code",
    "sample_count",
    "inspection_paid_cents",
    "inspection_refunded_cents",
    "net_inspection_cents",
    "pass_through_shipping_cents",
    "storage_allocated_cents",
    "inspection_seconds",
    "labor_cost_cents",
    "contribution_cents",
    "channel_reconciled",
    "provider_refs",
  ];
  const lines=[headers.join(",")];
  for(const r of ledger.orders) {
    lines.push([
      r.public_no,
      r.state,
      r.is_test?"1":"0",
      r.category_slug,
      r.service_code,
      r.sample_count,
      r.inspection_paid_cents,
      r.inspection_refunded_cents,
      r.net_inspection_cents,
      r.pass_through_shipping_cents,
      r.storage_allocated_cents,
      r.inspection_seconds,
      r.labor_cost_cents,
      r.contribution_cents,
      r.channel_reconciled?"1":"0",
      r.provider_refs.join("|"),
    ].map(csvCell).join(","));
  }
  const s=ledger.summary;
  lines.push([
    "SUMMARY",
    "TOTAL",
    s.include_test?"1":"0",
    "ALL",
    "ALL",
    ledger.orders.reduce((n,r)=>n+r.sample_count,0),
    s.inspection_paid_cents,
    s.inspection_refunded_cents,
    s.net_inspection_cents,
    s.pass_through_shipping_cents,
    s.storage_allocated_cents,
    s.total_inspection_seconds,
    s.total_labor_cost_cents,
    s.total_contribution_cents,
    s.all_channel_reconciled?"1":"0",
    "",
  ].map(csvCell).join(","));
  return lines.join("\n")+"\n";
}
