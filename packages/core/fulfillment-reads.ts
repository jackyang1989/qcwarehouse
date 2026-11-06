import type { DB } from "../db";
import { guard, one, organization, type Actor } from "./common";

const relatedItems=`select a.item_id,a.linked_at,a.unlinked_at
  from order_line_item_links a join order_lines l on l.id=a.order_line_id
  where l.order_id=$1 and a.org_id=$2`;

export async function orderShipments(db:DB,orderId:string,org:string,shipmentId:string|null=null) {
  return (await db.query(`with related as (${relatedItems})
    select s.id,s.state,s.tracking_norm,s.shipped_at,s.weight_g,b.action,b.destination_snapshot,
    (select jsonb_agg(jsonb_build_object('code',w.code,'returned_at',sr.received_at) order by w.code)
      from shipment_items si join warehouse_items w on w.id=si.item_id and w.org_id=b.org_id
      left join shipment_return_items sr on sr.shipment_id=s.id and sr.item_id=w.id
      where si.shipment_id=s.id) items
    from shipments s join dispatch_batches b on b.id=s.batch_id
    where b.org_id=$2 and s.shipped_at is not null and ($3::uuid is null or s.id=$3) and exists(
      select 1 from shipment_items si join related a on a.item_id=si.item_id
      where si.shipment_id=s.id and a.linked_at<=s.shipped_at and (a.unlinked_at is null or a.unlinked_at>s.shipped_at))
    order by s.shipped_at desc,s.id`,[orderId,org,shipmentId])).rows;
}

export async function orderQuotes(db:DB,orderId:string,org:string,quoteId:string|null=null) {
  return (await db.query(`with related as (${relatedItems}), quotes as (
    select q.id,q.revision,q.amount_cents,q.expires_at,q.accepted_at,'dispatch' purpose,b.action,q.snapshot,b.state parent_state,
      (select jsonb_object_agg(w.id::text,w.code) from dispatch_batch_items bi join warehouse_items w
        on w.id=bi.item_id and w.org_id=bi.org_id where bi.batch_id=b.id and bi.org_id=$2) item_codes,
      c.id charge_id,c.applied_payment_id,c.free_authorization,c.voided_at
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id
      left join charge_items c on c.dispatch_quote_id=q.id and c.org_id=b.org_id
    where b.org_id=$2 and ($3::uuid is null or q.id=$3) and exists(
      select 1 from dispatch_batch_items bi join related a on a.item_id=bi.item_id
      join disposition_requests d on d.id=bi.disposition_id
      where bi.batch_id=b.id and a.linked_at<=(d.authorization_snapshot->>'authorized_at')::timestamptz
      and (a.unlinked_at is null or a.unlinked_at>(d.authorization_snapshot->>'authorized_at')::timestamptz))
    union all select q.id,q.revision,q.amount_cents,q.expires_at,q.accepted_at,'storage',d.action,q.snapshot,d.state,
      jsonb_build_object(w.id::text,w.code),c.id,c.applied_payment_id,c.free_authorization,c.voided_at
    from storage_quotes q join disposition_requests d on d.id=q.disposition_id
      join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
      left join charge_items c on c.storage_quote_id=q.id and c.org_id=d.org_id
    where d.org_id=$2 and ($3::uuid is null or q.id=$3) and exists(select 1 from related a where a.item_id=d.item_id
      and a.linked_at<=(d.authorization_snapshot->>'authorized_at')::timestamptz
      and (a.unlinked_at is null or a.unlinked_at>(d.authorization_snapshot->>'authorized_at')::timestamptz))
  ) select id,revision,amount_cents,expires_at,accepted_at,purpose,action,snapshot,item_codes,charge_id,
    case when applied_payment_id is not null or free_authorization is not null then 'paid'
      when voided_at is not null then 'inactive'
      when accepted_at is not null then case when exists(select 1 from payments p where p.charge_item_id=charge_id and p.state='processing')
        then 'processing' else 'accepted' end
      when expires_at<=now() then 'expired'
      when purpose='dispatch' and parent_state='quoted' or purpose='storage' and parent_state='requested' then 'open'
      else 'inactive' end state
    from quotes order by expires_at desc,id`,[orderId,org,quoteId])).rows;
}

export async function orderFulfillmentRecord(db:DB,actor:Actor,orderId:string,kind:"quotes"|"shipments",recordId:string) {
  const org=organization(actor);
  await one(db,"select id from orders where id=$1 and org_id=$2",[orderId,org]);
  const rows=await (kind==="quotes"?orderQuotes:orderShipments)(db,orderId,org,recordId);
  guard(rows[0],"NOT_FOUND","Record not found.",404);
  return rows[0];
}
