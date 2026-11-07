import { z } from "zod";
import type { DB } from "../db";
import { currentTerms, requireCustomerActive, requireTerms } from "./auth";
import { audit, code, event, guard, isDemo, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { orderQuotes, orderShipments } from "./fulfillment-reads";

export const checkSchema = z.object({
  key:z.string().min(1).max(80), label:z.string().min(1).max(120), zh:z.string().min(1).max(120),
  type:z.enum(["boolean","number","text"]), unit:z.string().optional(), method:z.string().min(1),
  required:z.boolean().default(true), evidence:z.boolean().default(false),
  kind:z.enum(["measurement","observation","shot","order_shot"]).optional(),
  component:z.string().min(1).max(40).optional(),
  precision:z.number().positive().optional(),
  diagram:z.string().max(200).nullable().optional(),
  derived:z.object({circumference_cm:z.string().optional()}).optional(),
  retry_threshold:z.number().positive().optional(),
  parts:z.array(z.string().min(1).max(60)).optional(),
  applies_if:z.record(z.string(),z.unknown()).optional(),
  required_if:z.record(z.string(),z.unknown()).optional(),
});
export const templateShotSchema = z.object({
  code:z.string().min(1).max(80),
  name:z.string().min(1).max(120),
  zh:z.string().max(120).optional(),
  required:z.boolean().default(true),
  component:z.string().min(1).max(40).optional(),
  required_if:z.record(z.string(),z.unknown()).optional(),
});
export const templateSchema=z.object({
  checks:z.array(checkSchema).min(1).max(60),
  components:z.array(z.union([
    z.string().min(1).max(40),
    z.object({id:z.string().min(1).max(40),code:z.string().min(1).max(80)}),
  ])).optional(),
  measure_conditions:z.string().max(1000).optional(),
  measurement_policy:z.object({
    attempts:z.number().int().min(1).max(3).default(2),
    extra_attempt_on_difference:z.boolean().default(true),
    threshold_by_unit:z.record(z.string(),z.number().positive()).optional(),
  }).optional(),
  shots:z.array(templateShotSchema).optional(),
  order_shots:z.array(z.string().min(1).max(80)).optional(),
}).refine(
  t=>new Set(t.checks.map(c=>c.key)).size===t.checks.length,"Check keys must be unique.");
export const priceSchema=z.object({
  minimum:z.number().int().positive(),maximum:z.number().int().positive(),unit_cents:z.number().int().positive().optional(),
  package_cents:z.number().int().positive().optional(),business_days:z.number().int().positive(),demo:z.boolean().optional()
}).refine(p=>p.maximum>=p.minimum && Number(!!p.unit_cents)+Number(!!p.package_cents)===1);
export type LineInput={category_id:string; offer_id:string; quantity:number; options?:object; attributes?:object; items?:object[]};
async function validateLineSamples(db:DB,org:string,line:{category_id:string;options?:unknown;attributes?:unknown;items?:unknown[];draft_items?:unknown[]},service:string) {
  const items=(Array.isArray(line.items)?line.items:Array.isArray(line.draft_items)?line.draft_items:[]) as {category_id?:string;size_label?:string;size?:string;attachment_ids?:unknown}[];
  const lineAttachments=Array.isArray((line.attributes as {attachment_ids?:unknown})?.attachment_ids)
    ?((line.attributes as {attachment_ids:unknown[]}).attachment_ids):[];
  const itemAttachments=items.flatMap(item=>Array.isArray(item?.attachment_ids)?item.attachment_ids:[]);
  const allAttachments=[...new Set([...lineAttachments,...itemAttachments])];
  for(const rawId of allAttachments) {
    const mediaId=z.string().uuid().parse(rawId);
    const media=(await db.query("select 1 from media_assets where id=$1 and org_id=$2 and kind='attachment' and status='ready'",[mediaId,org])).rowCount;
    guard(media,"EVIDENCE_MISMATCH","Attachment does not belong to this account.",422);
  }
  if(service==="compare") {
    const mismatch=items.some(item=>typeof item?.category_id==="string" && item.category_id!==line.category_id);
    const optCategories=(line.options as {item_categories?:unknown})?.item_categories;
    const optMismatch=Array.isArray(optCategories) && optCategories.some(cat=>typeof cat==="string" && cat!==line.category_id);
    guard(!mismatch && !optMismatch,"INCOMPATIBLE_SAMPLES","Direct comparison requires items from the same product category.",422);
    const sizes=items.map(item=>String(item?.size_label??item?.size??"").trim()).filter(Boolean);
    const sizeMismatchConfirmed=(line.options as {size_mismatch_confirmed?:unknown})?.size_mismatch_confirmed===true ||
      (line.attributes as {size_mismatch_confirmed?:unknown})?.size_mismatch_confirmed===true;
    guard(new Set(sizes).size<=1 || sizeMismatchConfirmed,"VALIDATION_FAILED","Confirm size mismatch before comparing items of different sizes.",422);
  }
  if(service==="reference_match") {
    const ref=z.object({reference_id:z.string().uuid()}).parse(line.options);
    const sample=(await db.query<{id:string;state:string;not_expired:boolean;snapshot_cat:string|null;linked_cat:string|null}>(`
      select r.id,r.state,r.expires_at>now() not_expired,
        r.authorization_snapshot->>'category_id' snapshot_cat,
        (select l.category_id::text from order_line_item_links a join order_lines l on l.id=a.order_line_id
         where a.item_id=r.item_id order by a.linked_at desc limit 1) linked_cat
      from reference_samples r where r.id=$1 and r.org_id=$2`,[ref.reference_id,org])).rows[0];
    guard(sample,"NOT_FOUND","Record not found.",404);
    const sampleCat=sample.linked_cat??sample.snapshot_cat;
    guard(!sampleCat || sampleCat===line.category_id,"INCOMPATIBLE_SAMPLES","The reference sample belongs to a different product category.",422);
    guard(sample.state==="active" && sample.not_expired,"REFERENCE_UNAVAILABLE","The selected reference sample is expired or unavailable.");
  }
}
const offersSql=`
  select o.id offer_id,o.sku_code,o.title,c.id category_id,c.labels category,c.admission_snapshot,t.id template_version_id,t.content,
    st.code service,p.id price_version,p.rules
  from service_offers o join service_types st on st.id=o.service_type_id
  join offer_templates ot on ot.offer_id=o.id join categories c on c.id=ot.category_id
  join template_versions t on t.id=ot.template_version_id
  join lateral(select * from sku_prices sp where sp.offer_id=o.id and effective_from<=now()
    and (effective_to is null or effective_to>now()) order by effective_from desc,version desc limit 1) p on true
  where o.enabled and c.status='ACTIVE' and c.admission_snapshot is not null and t.state='PUBLISHED'
    and exists(select 1 from template_capabilities tc where tc.template_version_id=t.id)
    and not exists(select 1 from template_capabilities tc join capabilities cap on cap.id=tc.capability_id
      where tc.template_version_id=t.id and (cap.revoked_at is not null or cap.approved_by is null))
`;
function allowOfferRow(row:{rules?:{demo?:boolean};admission_snapshot?:{demo?:boolean}}) {
  return isDemo() || (row.rules?.demo!==true && row.admission_snapshot?.demo!==true);
}
export async function catalog(db: DB) {
  return (await db.query(offersSql+" order by o.sku_code,t.version desc")).rows
    .filter(allowOfferRow)
    .map(({admission_snapshot: _admission, ...rest}) => rest);
}
async function eligible(db: DB, line: LineInput,manual=false) {
  const offer=(await db.query(offersSql+" and o.id=$1 and c.id=$2 order by t.version desc limit 1",[line.offer_id,line.category_id])).rows[0];
  guard(offer && allowOfferRow(offer),"OFFER_UNAVAILABLE","This offer is not available.");
  const p=priceSchema.parse(offer.rules);
  guard(line.quantity>=p.minimum && (!line.items || line.items.length<=line.quantity) &&
    (offer.service!=="compare" || [2,3].includes(line.quantity)), "QUANTITY_UNAVAILABLE","Choose a valid quantity for this service.",422);
  guard(line.quantity<=p.maximum || manual && offer.service==="inspection","MANUAL_QUOTE_REQUIRED","Request a staff quote for this quantity.",422);
  return {offer,p};
}
export async function ownOrder(db:DB,actor:Actor,id:string,write=false) {
  const org=organization(actor);
  if(write) await lock(db,"org:"+org);
  return one(db,"select * from orders where id=$1 and org_id=$2"+(write?" for update":""),[id,org]);
}
export async function saveOrder(db:DB,actor:Actor,input:{lines:LineInput[];customer_notes?:string;revision?:number},id?:string) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  guard(input.lines.length<=20 && input.lines.reduce((n,l)=>n+l.quantity,0)<=300,"QUANTITY_UNAVAILABLE","This request needs a custom quote.",422);
  let order;
  if(id) {
    order=await ownOrder(db,actor,id,true);
    revision(order.revision,input.revision!);
    guard(order.state==="draft","ORDER_NOT_EDITABLE","Only draft orders can be edited.");
    await db.query("delete from order_lines where order_id=$1",[id]);
    order=await one(db,"update orders set customer_notes=coalesce($2,customer_notes),revision=revision+1,updated_at=now() where id=$1 returning *",[id,input.customer_notes??null]);
  } else {
    order=await one(db,`insert into orders(id,public_no,org_id,created_by,customer_notes,is_test)
      values($1,$2,$3,$4,$5,$6) returning *`,[uuid(),code("QW-"),org,actor.id,input.customer_notes??null,isDemo()]);
  }
  for(const [lineIndex,line] of input.lines.entries()) {
    const {offer}=await eligible(db,line,true);
    await validateLineSamples(db,org,line,offer.service);
    const normalizedItems=Array.from({length:line.quantity},(_,idx)=>{
      const raw=(line.items?.[idx]??{}) as Record<string,unknown>;
      const defaultCode=`L${lineIndex+1}-P${String(idx+1).padStart(2,"0")}`;
      return {
        position:idx+1,
        sample_code:typeof raw.sample_code==="string"&&raw.sample_code.trim()?raw.sample_code.trim():defaultCode,
        ...raw,
      };
    });
    await db.query(`insert into order_lines(order_id,org_id,offer_id,category_id,template_version_id,quantity,options,attributes,draft_items)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [order.id,org,line.offer_id,line.category_id,offer.template_version_id,line.quantity,line.options??{},line.attributes??{},JSON.stringify(normalizedItems)]);
  }
  await audit(db,actor,id?"edit_draft":"create_draft","orders",order.id);
  return orderDTO(order as Parameters<typeof orderDTO>[0]);
}
export function orderDTO(o:{id:string;public_no:string;state:string;revision:number}) {
  return {id:o.id,public_no:o.public_no,state:o.state,revision:o.revision};
}
const orderTerms=["terms","privacy","restricted_items","report_notice"];
async function pricedLines(db:DB,id:string,manual=false) {
  const lines=(await db.query("select * from order_lines where order_id=$1 order by id",[id])).rows;
  guard(lines.length,"ORDER_EMPTY","Add at least one service.");
  const snapshot=[];
  for(const line of lines) {
    const {offer,p}=await eligible(db,line,manual);
    guard(offer.template_version_id===line.template_version_id,"TEMPLATE_CHANGED","Review the latest inspection template.");
    await validateLineSamples(db,line.org_id,line,offer.service);
    snapshot.push({order_line_id:line.id,category_id:line.category_id,offer_id:line.offer_id,template_version_id:line.template_version_id,
      quantity:line.quantity,price_version:offer.price_version,amount_cents:p.package_cents??p.unit_cents!*line.quantity,
      business_days:p.business_days,options:line.options});
  }
  return snapshot;
}
export async function quoteOrder(db:DB,actor:Actor,id:string,rev:number) {
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,rev);
  guard(order.state==="draft" || order.state==="awaiting_payment","ORDER_NOT_EDITABLE","Order is already in fulfillment.");
  const snapshot=await pricedLines(db,id),terms=await currentTerms(db,orderTerms);
  guard(terms.length===4,"TERMS_UNAVAILABLE","Ordering is unavailable until current terms are published.");
  return storeQuote(db,id,snapshot,{terms:terms.map(t=>t.id),order_revision:rev},new Date(Date.now()+30*60_000));
}
async function storeQuote(db:DB,id:string,snapshot:Awaited<ReturnType<typeof pricedLines>>,terms:object,expires:Date) {
  const previous=await one<{n:number}>(db,"select coalesce(max(revision),0) n from inspection_quotes where order_id=$1",[id]);
  return one(db,`insert into inspection_quotes(order_id,revision,line_snapshot,terms_snapshot,amount_cents,currency,expires_at)
    values($1,$2,$3,$4,$5,'USD',$6)
    returning id,order_id,revision,line_snapshot,amount_cents,currency,expires_at`,
    [id,previous.n+1,JSON.stringify(snapshot),terms,snapshot.reduce((n,l)=>n+l.amount_cents,0),expires]);
}
export async function requestManualQuote(db:DB,actor:Actor,id:string,rev:number,reason:string) {
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,rev);
  guard(order.state==="draft","ORDER_NOT_EDITABLE","Manual quotes are available for draft orders.");
  await pricedLines(db,id,true);
  const current=(await db.query(`select id,state from manual_quote_requests
    where order_id=$1 and revision=$2 and state in ('requested','offered')`,[id,rev])).rows[0];
  if(current) return current;
  const req=await one(db,`insert into manual_quote_requests(id,org_id,order_id,revision,state,due_at,reason)
    values($1,$2,$3,$4,'requested',now()+interval '2 days',$5)
    on conflict(order_id,revision) do update set state='requested',reason=excluded.reason,
      due_at=excluded.due_at,assignee_id=null,accepted_quote_id=null
    returning id,state`,[uuid(),order.org_id,id,rev,reason]);
  await audit(db,actor,"request_manual_quote","manual_quote_requests",req.id);
  return req;
}
type ManualQuote={revision:number;reason:string;expires_at:string;terms_version_ids:string[];
  lines:{order_line_id:string;amount_cents:number;business_days:number}[]};
export async function issueManualQuote(db:DB,actor:Actor,id:string,input:ManualQuote) {
  role(actor,"support","super_admin");
  const initial=await one(db,"select org_id from orders where id=$1",[id]);
  await lock(db,"org:"+initial.org_id);
  const order=await one(db,"select * from orders where id=$1 for update",[id]);
  revision(order.revision,input.revision);
  guard(order.state==="draft","ORDER_NOT_EDITABLE","Only draft orders can receive manual quotes.");
  const request=await one(db,`select * from manual_quote_requests where order_id=$1 and revision=$2
    and state in ('requested','offered') for update`,[id,input.revision]);
  guard(!request.assignee_id || request.assignee_id===actor.id,"QUOTE_ASSIGNEE_REQUIRED","Another staff member owns this request.",403);
  const expires=new Date(input.expires_at),now=Date.now();
  guard(expires.valueOf()>now && expires.valueOf()<=now+30*86400_000,"QUOTE_EXPIRY_INVALID","Set a future expiry within 30 days.",422);
  const terms=await currentTerms(db,orderTerms);
  requireTerms(terms,input.terms_version_ids,4);
  const scoped=await pricedLines(db,id,true);
  const byLine=new Map(input.lines.map(line=>[line.order_line_id,line]));
  guard(byLine.size===input.lines.length && byLine.size===scoped.length &&
    scoped.every(line=>byLine.has(line.order_line_id)) && input.lines.every(line=>line.amount_cents<=10_000_000 && line.business_days<=180),
    "QUOTE_LINES_INVALID","Enter a valid amount and lead time for each current order line.",422);
  const snapshot=scoped.map(line=>({...line,...byLine.get(line.order_line_id)!}));
  if(snapshot.every(line=>line.amount_cents===0)) role(actor,"super_admin");
  const quote=await storeQuote(db,id,snapshot,{
    terms:terms.map(t=>t.id),order_revision:input.revision,manual_request_id:request.id,issued_by:actor.id
  },expires);
  await db.query("update manual_quote_requests set assignee_id=$2,state='offered',accepted_quote_id=$3 where id=$1",[request.id,actor.id,quote.id]);
  await audit(db,actor,"issue_manual_quote","manual_quote_requests",request.id,{quote_id:quote.id,reason:input.reason});
  await event(db,"quote.offered",{order_id:id});
  return quote;
}
export async function submitOrder(db:DB,actor:Actor,id:string,input:{revision:number;quote_id:string;terms_version_ids:string[];acknowledgements:object}) {
  await requireCustomerActive(db,actor);
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,input.revision);
  guard(order.state==="draft" || order.state==="awaiting_payment","ORDER_NOT_EDITABLE","Order is already in fulfillment.");
  const q=await one(db,`select *,expires_at>now() valid from inspection_quotes where id=$1 and order_id=$2 for update`,[input.quote_id,id]);
  const terms=await currentTerms(db,orderTerms);
  requireTerms(terms,input.terms_version_ids,4);
  const manualId=q.terms_snapshot.manual_request_id as string|undefined;
  const current=await pricedLines(db,id,!!manualId);
  if(manualId) await one(db,`select id from manual_quote_requests where id=$1 and order_id=$2
    and state='offered' and accepted_quote_id=$3 for update`,[manualId,id,q.id]);
  guard(q.valid && !q.accepted_at && q.terms_snapshot.order_revision===order.revision &&
    terms.every(t=>q.terms_snapshot.terms.includes(t.id)) &&
    current.every((l,i)=>q.line_snapshot[i]?.price_version===l.price_version && (manualId || q.line_snapshot[i]?.amount_cents===l.amount_cents)) &&
    current.length===q.line_snapshot.length,
    "QUOTE_STALE","Request a new quote before paying.");
  const existing=(await db.query(`select p.id from payments p join charge_items c on c.id=p.charge_item_id
    join inspection_quotes q on q.id=c.inspection_quote_id where q.order_id=$1 and p.state='processing'`,[id])).rowCount;
  guard(!existing,"PAYMENT_PROCESSING","Wait for the existing payment to resolve.");
  await db.query(`update charge_items c set voided_at=now() from inspection_quotes q
    where q.id=c.inspection_quote_id and q.order_id=$1 and c.applied_payment_id is null and c.voided_at is null`,[id]);
  await db.query("update inspection_quotes set accepted_at=now() where id=$1",[q.id]);
  if(manualId) await db.query("update manual_quote_requests set state='accepted' where id=$1",[manualId]);
  await db.query("insert into consents(id,order_id,user_id,terms_version_ids,acknowledgements) values($1,$2,$3,$4,$5)",[uuid(),id,actor.id,input.terms_version_ids,input.acknowledgements]);
  const charge=await one(db,`insert into charge_items(org_id,purpose,inspection_quote_id,amount_cents,currency,snapshot)
    values($1,'inspection',$2,$3,'USD',$4) returning id as charge_item_id,amount_cents,currency`,
    [order.org_id,q.id,q.amount_cents,{order_id:id,quote_revision:q.revision}]);
  const updated=await one(db,`update orders set state='awaiting_payment',price_cents=$2,submission_snapshot=$3,revision=revision+1
    where id=$1 returning *`,[id,q.amount_cents,{quote_id:q.id,lines:q.line_snapshot,terms:input.terms_version_ids}]);
  if(q.amount_cents===0) {
    guard(manualId && q.terms_snapshot.issued_by,"FREE_AUTHORIZATION_REQUIRED","A zero-price inspection requires staff authorization.");
    await db.query("update charge_items set free_authorization=$2 where id=$1",[charge.charge_item_id,{quote_id:q.id,authorized_by:q.terms_snapshot.issued_by}]);
    await activatePaidOrder(db,id);
  }
  await audit(db,actor,"submit_order","orders",id);
  const result=q.amount_cents===0?await ownOrder(db,actor,id):updated;
  return {order:orderDTO(result as Parameters<typeof orderDTO>[0]),charge};
}

export async function activatePaidOrder(db:DB,orderId:string) {
  await db.query(`insert into expected_items(order_line_id,position,declared_fields)
    select l.id,n,coalesce(l.draft_items->(n-1),'{}'::jsonb) from order_lines l
    cross join lateral generate_series(1,l.quantity) n where l.order_id=$1 on conflict do nothing`,[orderId]);
  await db.query("update orders set state='awaiting_samples',paid_at=now(),revision=revision+1 where id=$1",[orderId]);
  await readyOrder(db,orderId);
}

function parseDateList(raw:unknown):Set<string> {
  if(!raw) return new Set();
  if(Array.isArray(raw)) {
    return new Set(raw.map(x=>String(x).trim()).filter(Boolean));
  }
  if(typeof raw!=="string") return new Set();
  const trimmed=raw.trim();
  if(!trimmed) return new Set();
  try {
    const parsed=JSON.parse(trimmed);
    if(Array.isArray(parsed)) return new Set(parsed.map(x=>String(x).trim()).filter(Boolean));
  } catch {
    // Fallback to comma/space separated YYYY-MM-DD strings
  }
  return new Set(trimmed.split(/[\s,]+/).map(x=>x.trim()).filter(Boolean));
}

export function businessDeadline(start:Date,days:number,holidays:Iterable<string>=[],extraWorkdays:Iterable<string>=[]) {
  const holidaySet=new Set(holidays);
  const extraSet=new Set(extraWorkdays);
  const d=new Date(start);
  while(days>0) {
    d.setUTCDate(d.getUTCDate()+1);
    const cn=new Date(d.valueOf()+8*3600000);
    const dateKey=cn.toISOString().slice(0,10);
    const dow=cn.getUTCDay();
    const isWorkday=extraSet.has(dateKey) || (dow!==0 && dow!==6 && !holidaySet.has(dateKey));
    if(isWorkday) days--;
  }
  return d;
}
export async function readyOrder(db:DB,id:string) {
  const order=await one(db,"select * from orders where id=$1 for update",[id]);
  if(order.state!=="awaiting_samples" || !order.paid_at) return;
  const counts=await one<{total:number;ready:number}>(db,`select count(*)::int total,count(*) filter(where w.identity_state='identified' and w.custody_state in ('received','stored'))::int ready
    from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id where l.order_id=$1`,[id]);
  if(!counts.total || counts.total!==counts.ready || (await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null",[id])).rowCount) return;
  const lines=(await db.query(`select l.*,st.code service from order_lines l join service_offers o on o.id=l.offer_id join service_types st on st.id=o.service_type_id where l.order_id=$1`,[id])).rows;
  for(const line of lines) {
    const inScopeCount=await one<{n:number}>(db,"select count(*)::int n from expected_items where order_line_id=$1 and in_scope",[line.id]);
    if(!inScopeCount.n) continue;
    if(line.service==="inspection") {
      await db.query(`insert into inspection_tasks(order_line_id,template_version_id,assignment_id,state)
        select a.order_line_id,$2,a.id,'READY' from order_line_item_links a join expected_items e on e.id=a.expected_item_id
        where a.order_line_id=$1 and a.unlinked_at is null and e.in_scope on conflict do nothing`,[line.id,line.template_version_id]);
      continue;
    }
    const referenceId=line.options.reference_id??null;
    if(line.service==="reference_match") {
      const ref=(await db.query(`select r.id from reference_samples r join warehouse_items w on w.id=r.item_id where r.id=$1
        and r.org_id=$2 and r.state='active' and r.expires_at>now() and w.custody_state='stored'
        and not exists(select 1 from reference_reservations where reference_id=r.id and released_at is null)
        and not exists(select 1 from disposition_requests where item_id=w.id and state not in ('completed','cancelled')) for update of r,w`,[referenceId,order.org_id])).rows[0];
      guard(ref,"REFERENCE_UNAVAILABLE","The selected reference sample is expired or unavailable.");
    }
    const group=await one<{id:string}>(db,`insert into inspection_groups(order_line_id,purpose,reference_id) values($1,$2,$3) returning id`,[line.id,line.service,referenceId]);
    await db.query(`insert into group_members(group_id,assignment_id,order_line_id)
      select $1,a.id,a.order_line_id from order_line_item_links a join expected_items e on e.id=a.expected_item_id
      where a.order_line_id=$2 and a.unlinked_at is null and e.in_scope`,[group.id,line.id]);
    if(referenceId) await db.query("insert into reference_reservations(id,reference_id,group_id,reserved_at) values($1,$2,$3,now())",[uuid(),referenceId,group.id]);
    await db.query("insert into inspection_tasks(order_line_id,template_version_id,group_id,state) values($1,$2,$3,'READY')",[line.id,line.template_version_id,group.id]);
  }
  const calendarRows=(await db.query<{key:string;value:string}>("select key,value from app_config where key in ('calendar.holidays','business_holidays','calendar.extra_workdays')")).rows;
  const holidays=new Set<string>();
  const extraWorkdays=new Set<string>();
  for(const row of calendarRows) {
    const parsed=parseDateList(row.value);
    if(row.key==="calendar.extra_workdays") parsed.forEach(d=>extraWorkdays.add(d));
    else parsed.forEach(d=>holidays.add(d));
  }
  const days=Math.max(...order.submission_snapshot.lines.map((x:{business_days:number})=>x.business_days));
  await db.query("update orders set state='queued',samples_ready_at=coalesce(samples_ready_at,now()),sla_due_at=coalesce(sla_due_at,$2),revision=revision+1 where id=$1",
    [id,businessDeadline(new Date(),days,holidays,extraWorkdays)]);
  await event(db,"order.ready",{order_id:id});
}
export async function orderDetail(db:DB,actor:Actor,id:string) {
  const order=await ownOrder(db,actor,id);
  const lines=(await db.query(`select l.id,l.offer_id,l.category_id,l.template_version_id,l.quantity,l.options,l.attributes,l.draft_items,
    so.title,so.sku_code,st.code service
    from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    where l.order_id=$1 order by l.id`,[id])).rows;
  const rows=(await db.query(`select e.id,e.position,e.declared_fields,e.in_scope,l.id as order_line_id,l.quantity,so.title,st.code service,
    w.id item_id,w.code,w.identity_state,w.condition_state,w.custody_state,w.storage_until,pkg.code package_code,
    (select max(p.ends_at) from storage_periods p where p.item_id=w.id) paid_storage_until,
    (select jsonb_build_object('id',d.id,'action',d.action,'state',d.state,
      'awaiting_batch',d.action<>'retain' and not exists(select 1 from dispatch_batch_items bi where bi.disposition_id=d.id and bi.released_at is null))
      from disposition_requests d where d.item_id=w.id and d.org_id=w.org_id and d.state not in ('completed','cancelled')) instruction
    from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    left join expected_items e on e.order_line_id=l.id and e.in_scope
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id
    left join packages pkg on pkg.id=w.package_id
    where l.order_id=$1 order by l.id,e.position`,[id])).rows;
  const report=(await db.query("select published_version from reports where order_id=$1",[id])).rows[0];
  const manual=(await db.query(`select r.state,q.id,q.order_id,q.revision,q.amount_cents,q.expires_at,q.line_snapshot
    from manual_quote_requests r left join inspection_quotes q on q.id=r.accepted_quote_id and q.expires_at>now()
    and q.accepted_at is null where r.order_id=$1 and r.revision=$2`,[id,order.revision])).rows[0];
  const parcels=(await db.query(`select ao.advice_id id,t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,p.code package_code,p.state warehouse_state
    from advice_orders ao join tracking_records t on t.advice_id=ao.advice_id and t.org_id=ao.org_id and t.closed_at is null
    left join packages p on p.id=t.package_id and p.org_id=ao.org_id
    where ao.order_id=$1 and ao.org_id=$2 order by t.tracking_norm`,[id,order.org_id])).rows;
  const cases=(await db.query(`select id,public_no,subject,state from tickets
    where order_id=$1 and org_id=$2 order by created_at desc limit 50`,[id,order.org_id])).rows;
  const consents=(await db.query(`select c.id,c.created_at,c.acknowledgements,
    jsonb_agg(jsonb_build_object('kind',t.kind,'version',t.version) order by t.kind) policies
    from consents c join terms_versions t on t.id=any(c.terms_version_ids)
    where c.order_id=$1 group by c.id order by c.created_at desc,c.id`,[id])).rows;
  const shipments=await orderShipments(db,id,order.org_id);
  const quotes=(await orderQuotes(db,id,order.org_id)).map(({id,revision,purpose,action,state,amount_cents,expires_at,batch_id,item_codes})=>
    ({id,revision,purpose,action,state,amount_cents,expires_at,batch_id:batch_id??null,item_codes:item_codes??null}));
  return {...orderDTO(order as Parameters<typeof orderDTO>[0]),price_cents:order.price_cents,
    customer_notes:order.customer_notes??null,held_at:order.held_at??null,held_from_state:order.held_from_state??null,hold_reason:order.hold_reason??null,
    created_at:order.created_at,paid_at:order.paid_at??null,samples_ready_at:order.samples_ready_at??null,sla_due_at:order.sla_due_at??null,
    lines,items:rows,report_version:report?.published_version??null,manual_quote:manual??null,parcels,cases,shipments,quotes,consents};
}
