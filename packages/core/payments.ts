import Stripe from "stripe";
import type { DB } from "../db";
import { appOrigin } from "./auth";
import { audit, event, guard, hash, isDemo, lock, one, organization, role, uuid, type Actor } from "./common";
import { stripeSettings } from "./integrations";
import { activatePaidOrder } from "./orders";

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
    await db.query("insert into tickets(id,public_no,org_id,category,subject,details) values($1,$2,$3,'payment_refund',$4,$5)",
      [uuid(),"PAY-"+pid.slice(0,8),charge.org_id,"Reconcile late or duplicate payment",{payment_id:pid}]);
    return;
  }
  if(charge.purpose==="inspection") {
    const order=await one(db,`select o.* from orders o join inspection_quotes q on q.order_id=o.id where q.id=$1 for update of o`,[charge.inspection_quote_id]);
    if(order.state!=="awaiting_payment" || order.submission_snapshot?.quote_id!==charge.inspection_quote_id) {
      await db.query("insert into tickets(id,public_no,org_id,order_id,category,subject,details) values($1,$2,$3,$4,'payment_refund',$5,$6)",
        [uuid(),"PAY-"+pid.slice(0,8),charge.org_id,order.id,"Reconcile payment against order status",{payment_id:pid}]);
      return;
    }
    await activatePaidOrder(db,order.id);
  } else if(charge.purpose==="dispatch") {
    await db.query(`update dispatch_batches b set state='paid',revision=b.revision+1 from dispatch_quote_versions q
      where q.id=$1 and q.batch_id=b.id and b.state='quoted'`,[charge.dispatch_quote_id]);
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
  await event(db,"payment.confirmed",{charge_id:charge.id});
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
      const p=await one(db,`select p.*,c.org_id from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1`,[pid]);
      guard(p.charge_item_id===s.metadata?.charge_item_id && p.org_id===s.metadata?.org_id && (!p.provider_ref || p.provider_ref===s.id)
        && p.amount_cents===s.amount_total && s.currency==="usd","PAYMENT_MISMATCH","Payment does not match the accepted charge.");
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
export async function refundRequest(db:DB,actor:Actor,pid:string,cents:number,reason:string,orderId?:string) {
  role(actor,"support","super_admin");
  const p=await one(db,`select p.*,c.org_id,c.inspection_quote_id from payments p join charge_items c on c.id=p.charge_item_id where p.id=$1`,[pid]);
  if(orderId) await one(db,`select id from inspection_quotes where id=$1 and order_id=$2`,[p.inspection_quote_id,orderId]);
  guard(["succeeded","partially_refunded"].includes(p.state) && cents>0 && cents<=p.amount_cents,"REFUND_NOT_ALLOWED","Refund exceeds the paid amount.");
  const r=await one(db,`insert into refunds(id,payment_id,source,amount_cents,reason,requested_by) values($1,$2,'platform',$3,$4,$5)
    returning id as refund_id,state`,[uuid(),pid,cents,reason,actor.id]);
  await audit(db,actor,"request_refund","refunds",r.refund_id);
  return r;
}
export async function refundApprove(db:DB,actor:Actor,id:string,rev:number,sessionHash:string) {
  role(actor,"super_admin");
  await one(db,`select id from sessions where token_hash=$1 and user_id=$2 and revoked_at is null and mfa_at>now()-interval '15 minutes'`,[sessionHash,actor.id]);
  const first=await one(db,`select c.org_id from refunds r join payments p on p.id=r.payment_id join charge_items c on c.id=p.charge_item_id where r.id=$1`,[id]);
  await lock(db,"org:"+first.org_id);
  const r=await one(db,"select * from refunds where id=$1 for update",[id]);
  guard(r.revision===rev && r.state==="requested" && r.requested_by!==actor.id,"REFUND_NOT_ALLOWED","An independent approval and current request are required.");
  const p=await one(db,"select * from payments where id=$1 for update",[r.payment_id]);
  const total=await one<{n:number}>(db,`select coalesce(sum(amount_cents),0)::int n from refunds where payment_id=$1 and state in ('approved','succeeded')`,[p.id]);
  guard(total.n+r.amount_cents<=p.amount_cents && ["succeeded","partially_refunded"].includes(p.state),"REFUND_NOT_ALLOWED","The refundable balance has changed.");
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
