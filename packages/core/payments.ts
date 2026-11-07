import Stripe from "stripe";
import { pool, type DB } from "../db";
import { appOrigin, requireCustomerActive, requireStaffMfa } from "./auth";
import { audit, code, event, guard, hash, isDemo, lock, one, organization, role, uuid, type Actor } from "./common";
import { stripeSettings } from "./integrations";
import { activatePaidOrder, readyOrder } from "./orders";
import { applyScopePositionsAndAdditions, type ScopeAddition } from "./operations";
const refundApprovalMfaMinutes=15;

export async function orderPayment(db:DB,actor:Actor,id:string) {
  const row=await one(db,`select o.state order_state,c.id,c.amount_cents,q.revision quote_revision,q.expires_at,
    c.applied_payment_id,c.free_authorization,q.expires_at>now() quote_valid,
    exists(select 1 from payments p where p.charge_item_id=c.id and p.state='processing') processing,
    exists(select 1 from payments p where p.charge_item_id=c.id and p.state='requires_payment' and p.provider_ref is not null) remote_attempt
    from orders o left join inspection_quotes q on q.order_id=o.id and q.id::text=o.submission_snapshot->>'quote_id'
    left join charge_items c on c.inspection_quote_id=q.id and c.org_id=o.org_id and c.voided_at is null
    where o.id=$1 and o.org_id=$2`,[id,organization(actor)]);
  if(!row.id) return {state:"not_due",charge:null};
  const charge={id:row.id,amount_cents:row.amount_cents,quote_revision:row.quote_revision,expires_at:row.expires_at};
  if(row.applied_payment_id || row.free_authorization) return {state:"paid",charge};
  if(row.order_state!=="awaiting_payment") return {state:"not_due",charge:null};
  if(row.processing) return {state:"processing",charge};
  return {state:row.quote_valid||row.remote_attempt?"open":"expired",charge};
}

function stripe() {
  const {key,mode,webhook,liveEnabled}=stripeSettings();
  guard(key && mode && webhook,"STRIPE_UNAVAILABLE","Stripe checkout and webhook are not configured.",503);
  guard(mode!=="live" || liveEnabled,"LIVE_PAYMENTS_DISABLED","Live payments have not been enabled.",503);
  return new Stripe(key,{timeout:10000,maxNetworkRetries:1});
}
async function verifyCharge(db:DB,id:string,org:string,rev:number) {
  await lock(db,"org:"+org);
  const fee=await one(db,`select c.*,coalesce(i.revision,d.revision,s.revision) quote_revision,
    coalesce(i.expires_at,d.expires_at,s.expires_at)>now() quote_valid,o.is_test
    from charge_items c left join inspection_quotes i on i.id=c.inspection_quote_id
    left join orders o on o.id=i.order_id left join dispatch_quote_versions d on d.id=c.dispatch_quote_id
    left join storage_quotes s on s.id=c.storage_quote_id where c.id=$1 and c.org_id=$2 for update of c`,[id,org]);
  guard(!fee.voided_at && fee.quote_revision===rev,"QUOTE_STALE","Review the current quote.");
  return fee;
}
async function attempt(db:DB,id:string,amount:number) {
  const open=(await db.query("select * from payments where charge_item_id=$1 and state in ('requires_payment','processing')",[id])).rows[0];
  if(open) return open;
  const sequence=await one<{n:number}>(db,"select count(*)::int n from payments where charge_item_id=$1",[id]);
  const digest=hash(`stripe-checkout:${id}:${sequence.n}`);
  // Reuse the Stripe key if the transaction rolls back after the remote session was created.
  const pid=`${digest.slice(0,8)}-${digest.slice(8,12)}-8${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  return one(db,`insert into payments(id,charge_item_id,provider,amount_cents,state,idempotency_key)
    values($1::uuid,$2,'stripe',$3,'requires_payment',($1::uuid)::text) returning *`,[pid,id,amount]);
}
export async function checkout(db:DB,actor:Actor,id:string,rev:number) {
  await requireCustomerActive(db,actor);
  const org=organization(actor);
  const fee=await verifyCharge(db,id,org,rev);
  if(fee.applied_payment_id || fee.free_authorization) return {state:"paid",charge_item_id:id};
  const open=await attempt(db,id,fee.amount_cents);
  if(open.state==="processing") return {state:"processing",charge_item_id:id};
  if(isDemo()) {
    guard(fee.quote_valid,"QUOTE_EXPIRED","Request a new quote before continuing.");
    return {state:"requires_payment",attempt_id:open.id,checkout_url:appOrigin()+"/checkout/demo/"+open.id};
  }
  guard(!fee.is_test,"TEST_ORDER","Test orders use the isolated development checkout.");
  const api=stripe();
  if(open.provider_ref) {
    const session=await api.checkout.sessions.retrieve(open.provider_ref);
    if(session.status==="open" && session.url) return {state:"requires_payment",attempt_id:open.id,checkout_url:session.url};
    if(session.status==="complete") return {state:"processing",charge_item_id:id};
    await db.query("update payments set state='canceled' where id=$1",[open.id]);
  }
  guard(fee.quote_valid,"QUOTE_EXPIRED","Request a new quote before continuing.");
  const fresh=open.provider_ref?await attempt(db,id,fee.amount_cents):open;
  const session=await api.checkout.sessions.create({
    mode:"payment",client_reference_id:id,metadata:{payment_id:fresh.id,charge_item_id:id,org_id:org},
    payment_intent_data:{metadata:{payment_id:fresh.id,charge_item_id:id,org_id:org}},
    line_items:[{quantity:1,price_data:{currency:"usd",unit_amount:fee.amount_cents,product_data:{name:`QC Warehouse · ${fee.purpose}`}}}],
    success_url:appOrigin()+"/account/billing",cancel_url:appOrigin()+"/account/billing",
  },{idempotencyKey:fresh.id});
  guard(session.url,"STRIPE_UNAVAILABLE","Checkout could not be started.",503);
  await db.query("update payments set provider_ref=$2 where id=$1",[fresh.id,session.id]);
  return {state:"requires_payment",attempt_id:fresh.id,checkout_url:session.url};
}
async function applyPayment(db:DB,pid:string,providerRef:string,details:object) {
  const link=await one(db,`select c.org_id from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1`,[pid]);
  await lock(db,"org:"+link.org_id);
  const payment=await one(db,"select * from payments where id=$1 for update",[pid]);
  const charge=await one(db,"select * from charge_items where id=$1 for update",[payment.charge_item_id]);
  if(["succeeded","partially_refunded","refunded"].includes(payment.state)) return;
  await db.query("update payments set state='succeeded',provider_ref=$2,provider_data=$3,updated_at=now() where id=$1",[pid,providerRef,details]);
  if(charge.voided_at || charge.applied_payment_id) {
    const orderId=charge.inspection_quote_id
      ?(await db.query<{order_id:string}>("select order_id from inspection_quotes where id=$1",[charge.inspection_quote_id])).rows[0]?.order_id??null
      :null;
    await db.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,$4,'payment_refund',$5,$6)",
      [uuid(),code("PAY-"),charge.org_id,orderId,"Reconcile late or duplicate payment",{payment_id:pid}]);
    return;
  }
  let confirmedOrderId:string|null=null;
  if(charge.purpose==="inspection") {
    const order=await one(db,`select o.* from orders o join inspection_quotes q on q.order_id=o.id where q.id=$1 for update of o`,[charge.inspection_quote_id]);
    if(charge.scope_revision_id) {
      const sr=await one(db,"select * from scope_revisions where id=$1 and order_id=$2 for update",[charge.scope_revision_id,order.id]);
      const validScope=order.state==="awaiting_samples" && sr.accepted_at && sr.previous_snapshot?.order_revision===order.revision;
      if(!validScope) {
        await db.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,$4,'payment_refund',$5,$6)",
          [uuid(),code("PAY-"),charge.org_id,order.id,"Reconcile late supplemental scope payment",{payment_id:pid,scope_revision_id:charge.scope_revision_id}]);
        return;
      }
      const additions=(Array.isArray(sr.proposed_snapshot?.additions)?sr.proposed_snapshot.additions:[]) as ScopeAddition[];
      await applyScopePositionsAndAdditions(db,order.id,sr.previous_snapshot.positions,sr.proposed_snapshot.positions,additions);
      await db.query("update order_blocks set resolved_at=now() where order_id=$1 and reason='scope_payment_pending' and object_key=$2 and resolved_at is null",
        [order.id,charge.scope_revision_id]);
      await db.query("update orders set price_cents=coalesce(price_cents,0)+$2,revision=revision+1 where id=$1",[order.id,charge.amount_cents]);
      await db.query("update charge_items set applied_payment_id=$2 where id=$1",[charge.id,pid]);
      await readyOrder(db,order.id);
      await audit(db,null,"payment_confirmed","charge_items",charge.id,{scope_revision_id:charge.scope_revision_id});
      await event(db,"payment.confirmed",{charge_id:charge.id,order_id:order.id});
      return;
    }
    const heldForPayment=order.state==="on_hold" && order.held_from_state==="awaiting_payment" && order.submission_snapshot?.quote_id===charge.inspection_quote_id;
    if(!heldForPayment && (order.state!=="awaiting_payment" || order.submission_snapshot?.quote_id!==charge.inspection_quote_id)) {
      await db.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,$4,'payment_refund',$5,$6)",
        [uuid(),code("PAY-"),charge.org_id,order.id,"Reconcile payment against order status",{payment_id:pid}]);
      return;
    }
    confirmedOrderId=order.id;
    if(!heldForPayment) await activatePaidOrder(db,order.id);
  } else if(charge.purpose==="dispatch") {
    const dq=await one(db,
      `select q.id,q.batch_id,b.state batch_state,
              (select id from dispatch_quote_versions where batch_id=b.id order by revision desc limit 1) latest_quote_id
       from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id
       where q.id=$1 for update of q,b`,
      [charge.dispatch_quote_id]
    );
    if(dq.batch_state!=="quoted" || dq.id!==dq.latest_quote_id) {
      await db.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,null,'payment_refund',$4,$5)",
        [uuid(),code("PAY-"),charge.org_id,"Reconcile late payment for superseded dispatch quote",{payment_id:pid,batch_id:dq.batch_id,dispatch_quote_id:dq.id}]);
      return;
    }
    await db.query("update dispatch_batches set state='paid',revision=revision+1 where id=$1",[dq.batch_id]);
  } else {
    const item=await one(db,`select d.item_id,d.id,q.snapshot from storage_quotes q join disposition_requests d on d.id=q.disposition_id where q.id=$1`,[charge.storage_quote_id]);
    const updated=await one(db,`update warehouse_items set storage_until=greatest(coalesce(storage_until,now()),now())+make_interval(days=>$2),
      revision=revision+1 where id=$1 returning storage_until`,[item.item_id,item.snapshot.days]);
    await db.query(`insert into storage_periods(id,item_id,starts_at,ends_at,charge_id,policy_snapshot)
      values($1,$2,$3::timestamptz-make_interval(days=>$4),$3,$5,$6)`,[uuid(),item.item_id,updated.storage_until,item.snapshot.days,charge.id,item.snapshot]);
    await db.query("update disposition_requests set state='completed',revision=revision+1 where id=$1",[item.id]);
  }
  await db.query("update charge_items set applied_payment_id=$2 where id=$1",[charge.id,pid]);
  await audit(db,null,"payment_confirmed","charge_items",charge.id);
  await event(db,"payment.confirmed",{charge_id:charge.id,...(confirmedOrderId?{order_id:confirmedOrderId}:{})});
}
export async function demoPay(db:DB,actor:Actor,id:string) {
  guard(isDemo(),"NOT_FOUND","Checkout not found.",404);
  const org=organization(actor);
  const p=await one(db,"select p.* from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1 and c.org_id=$2",[id,org]);
  guard(["requires_payment","succeeded"].includes(p.state),"PAYMENT_UNAVAILABLE","This checkout has ended.");
  await applyPayment(db,id,"demo_"+id,{demo:true});
  return {state:"paid"};
}
export function verifyStripe(raw:string,signature:string) {
  const {webhook,mode}=stripeSettings();
  guard(webhook && mode && !isDemo(),"STRIPE_UNAVAILABLE","Stripe webhooks are unavailable.",503);
  let event:Stripe.Event;
  try { event=Stripe.webhooks.constructEvent(raw,signature,webhook); }
  catch { guard(false,"SIGNATURE_INVALID","Webhook signature is invalid.",401); }
  guard(event.livemode===(mode==="live"),"PAYMENT_MODE_MISMATCH","Webhook does not match the configured Stripe mode.",400);
  return event;
}
export async function stripeEvent(db:DB,e:Stripe.Event) {
  const inserted=await db.query(`insert into payment_events(id,provider,event_id,type,payload) values($1,'stripe',$2,$3,$4)
    on conflict(provider,event_id) do nothing`,[uuid(),e.id,e.type,e]);
  if(!inserted.rowCount) return {received:true};
  if(["checkout.session.completed","checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed","checkout.session.expired"].includes(e.type)) {
    const s=e.data.object as Stripe.Checkout.Session;
    const pid=s.metadata?.payment_id;
    if(pid && /^[0-9a-f-]{36}$/i.test(pid)) {
      const p=await one(db,`select p.*,c.org_id,c.inspection_quote_id from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1`,[pid]);
      guard(p.charge_item_id===s.metadata?.charge_item_id && p.org_id===s.metadata?.org_id && (!p.provider_ref || p.provider_ref===s.id),
        "PAYMENT_MISMATCH","Payment does not match the accepted charge.");
      if(p.amount_cents!==s.amount_total || s.currency!=="usd") {
        const orderId=p.inspection_quote_id
          ?(await db.query<{order_id:string}>("select order_id from inspection_quotes where id=$1",[p.inspection_quote_id])).rows[0]?.order_id??null
          :null;
        await pool.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,$4,'payment_refund',$5,$6)",
          [uuid(),code("PAY-"),p.org_id,orderId,"Reconcile payment amount or currency mismatch",{
            payment_id:pid,expected_cents:p.amount_cents,actual_cents:s.amount_total??null,currency:s.currency??null,event_id:e.id,
          }]);
        await audit(pool,null,"payment_amount_mismatch","payments",pid,{expected_cents:p.amount_cents,actual_cents:s.amount_total??null,currency:s.currency??null});
        guard(false,"PAYMENT_AMOUNT_MISMATCH","Callback amount does not match the charge snapshot.",409);
      }
      if((e.type==="checkout.session.completed" || e.type==="checkout.session.async_payment_succeeded") && s.payment_status==="paid") {
        await applyPayment(db,pid,s.id,{payment_intent:s.payment_intent});
      } else {
        await lock(db,"org:"+p.org_id);
        const state=e.type==="checkout.session.expired"?"canceled":e.type==="checkout.session.async_payment_failed"?"failed":"processing";
        await db.query(`update payments set state=$2,provider_ref=$3 where id=$1 and state in ('requires_payment','processing')`,[pid,state,s.id]);
      }
    }
  } else if(e.type==="charge.dispute.created" || e.type==="charge.dispute.closed" || e.type==="charge.dispute.updated") {
    const dispute=e.data.object;
    const p=(await db.query(`select p.id,c.org_id from payments p join charge_items c on c.id=p.charge_item_id
      where p.provider_data->>'payment_intent'=$1`,[typeof dispute.payment_intent==="string"?dispute.payment_intent:dispute.payment_intent?.id])).rows[0];
    if(p) {
      await lock(db,"org:"+p.org_id);
      await db.query(`insert into payment_disputes(provider_id,payment_id,state,evidence_due_at,updated_at) values($1,$2,$3,$4,now())
        on conflict(provider_id) do update set state=excluded.state,evidence_due_at=excluded.evidence_due_at,updated_at=now()`,
        [dispute.id,p.id,dispute.status,dispute.evidence_details.due_by?new Date(dispute.evidence_details.due_by*1000):null]);
    }
  } else if(e.type==="refund.created" || e.type==="refund.updated") {
    const r=e.data.object;
    const intent=typeof r.payment_intent==="string"?r.payment_intent:r.payment_intent?.id;
    const p=(await db.query(`select p.id,c.org_id from payments p join charge_items c on c.id=p.charge_item_id
      where p.provider_data->>'payment_intent'=$1`,[intent])).rows[0];
    if(p) {
      await lock(db,"org:"+p.org_id);
      const state=r.status==="succeeded"?"succeeded":["failed","canceled"].includes(r.status??"")?"failed":"approved";
      const updated=await db.query(`update refunds set provider_ref=$2,state=$3 where payment_id=$4 and amount_cents=$5
        and (id::text=$1 or provider_ref=$2) and state in ('approved','succeeded','failed') and (state!='succeeded' or $3='succeeded')`,
        [r.metadata?.refund_id??"",r.id,state,p.id,r.amount]);
      if(!updated.rowCount) await db.query(`insert into refunds(id,payment_id,source,amount_cents,reason,state,provider_ref)
        values($1,$2,'provider_dashboard',$3,'Stripe dashboard',$4,$5) on conflict do nothing`,[uuid(),p.id,r.amount,state,r.id]);
    }
  }
  await db.query("update payment_events set processed_at=now() where provider='stripe' and event_id=$1",[e.id]);
  return {received:true};
}
const refundableStates=["succeeded","partially_refunded"];
const committedRefunds=`select coalesce(sum(r.amount_cents),0)::int from refunds r
  where r.payment_id=p.id and r.state in ('approved','succeeded')`;
export async function orderRefundPayments(db:DB,actor:Actor,number:string) {
  role(actor,"support","super_admin");
  const order=await one(db,"select id,public_no from orders where public_no=$1",[number]);
  const rows=(await db.query(`select p.id,p.amount_cents,p.state,p.created_at,p.amount_cents-(${committedRefunds}) refundable_cents
    from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id join payments p on p.charge_item_id=c.id
    where q.order_id=$1 and p.state=any($2::text[]) order by p.created_at desc`,[order.id,refundableStates])).rows;
  return {order,rows};
}
export async function refundRequest(db:DB,actor:Actor,pid:string,cents:number,reason:string,orderId?:string) {
  role(actor,"support","super_admin");
  const first=await one(db,`select c.org_id from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1`,[pid]);
  await lock(db,"org:"+first.org_id);
  const p=await one(db,`select p.id,p.state,c.inspection_quote_id,p.amount_cents-(${committedRefunds}) refundable_cents
    from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1 for update of p`,[pid]);
  if(orderId) await one(db,`select id from inspection_quotes where id=$1 and order_id=$2`,[p.inspection_quote_id,orderId]);
  guard(refundableStates.includes(p.state) && cents>0 && cents<=p.refundable_cents,"REFUND_NOT_ALLOWED","Refund exceeds the available paid balance.");
  const r=await one(db,`insert into refunds(id,payment_id,source,amount_cents,reason,requested_by) values($1,$2,'platform',$3,$4,$5)
    returning id as refund_id,state`,[uuid(),pid,cents,reason,actor.id]);
  await audit(db,actor,"request_refund","refunds",r.refund_id);
  return r;
}
export async function refundApprove(db:DB,actor:Actor,id:string,rev:number,sessionHash:string) {
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash,refundApprovalMfaMinutes);
  const first=await one(db,`select c.org_id from refunds r join payments p on p.id=r.payment_id join charge_items c on c.id=p.charge_item_id where r.id=$1`,[id]);
  await lock(db,"org:"+first.org_id);
  const r=await one(db,"select * from refunds where id=$1 for update",[id]);
  guard(r.revision===rev && r.state==="requested" && r.requested_by!==actor.id,"REFUND_NOT_ALLOWED","An independent approval and current request are required.");
  const p=await one(db,`select p.state,p.amount_cents-(${committedRefunds}) refundable_cents from payments p where p.id=$1 for update`,[r.payment_id]);
  guard(r.amount_cents<=p.refundable_cents && refundableStates.includes(p.state),"REFUND_NOT_ALLOWED","The refundable balance has changed.");
  await db.query("update refunds set state='approved',approved_by=$2,revision=revision+1 where id=$1",[id,actor.id]);
  await event(db,"refund.approved",{refund_id:id});
  await audit(db,actor,"approve_refund","refunds",id);
  return {refund_id:id,state:"approved"};
}
export async function executeRefund(db:DB,id:string) {
  const r=await one(db,`select r.*,p.provider_data from refunds r join payments p on p.id=r.payment_id where r.id=$1 for update of r`,[id]);
  if(r.state!=="approved" || r.provider_ref) return;
  if(isDemo() && r.provider_data.demo) {
    await db.query("update refunds set state='succeeded',provider_ref=$2 where id=$1",[id,"demo_refund_"+id]);
    return;
  }
  const result=await stripe().refunds.create({payment_intent:r.provider_data.payment_intent,amount:r.amount_cents,metadata:{refund_id:id}},{idempotencyKey:id});
  await db.query("update refunds set provider_ref=$2,state=$3 where id=$1",[id,result.id,result.status==="succeeded"?"succeeded":result.status==="failed"?"failed":"approved"]);
}
