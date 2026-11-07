import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import sharp from "sharp";
import Stripe from "stripe";
import { assertCoreCoverage, assertCoreResponse } from "./core-responses";
import { canOpenStaffPage, customerDestination, resolvePortalRoute, staffDestination, staffTabs } from "../packages/core/portal-routes";

const target=process.env.TEST_DATABASE_URL;
assert(target,"Set TEST_DATABASE_URL to an isolated qcw_test database.");
const targetUrl=URL.parse(target);
assert(targetUrl && ["postgres:","postgresql:"].includes(targetUrl.protocol),"Expected a PostgreSQL test URL.");
const databaseName=decodeURIComponent(targetUrl.pathname.slice(1));
assert(/^qcw_test(?:-[a-z0-9-]+)?$/.test(databaseName),"Use a dedicated qcw_test database.");
const appDatabase=process.env.DATABASE_URL?URL.parse(process.env.DATABASE_URL):null;
assert.notEqual(databaseName,appDatabase&&decodeURIComponent(appDatabase.pathname.slice(1)),
  "The test database must be separate from the application database.");
process.env.DATABASE_URL=target;
process.env.QCW_DEMO="1";
process.env.NODE_ENV="test";
const origin=new URL(process.env.APP_URL??"http://localhost:3000").origin;
const {handle}=await import("../packages/core/http");
const {pool}=await import("../packages/db");
const {workOnce}=await import("../packages/core/worker");
const {syncTrackingOnce}=await import("../packages/core/logistics");
const {encryptSecret,decryptSecret,passwordHash}=await import("../packages/core/auth");
const {businessDeadline}=await import("../packages/core/orders");

before(async()=>{
  const actual=await pool.query<{name:string}>("select current_database() name");
  assert.equal(actual.rows[0].name,databaseName,"Connected to a different database than expected.");
  await pool.query("drop schema if exists public cascade; create schema public;");
  for(const args of [["--env-file-if-exists=.env","scripts/migrate.mjs"],["--env-file-if-exists=.env","--import","tsx","scripts/demo.ts"]])
    execFileSync(process.execPath,args,{env:process.env,stdio:"pipe"});
  await pool.query(readFileSync(new URL("./shadow-categories.sql",import.meta.url),"utf8"));
  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])",[
    ["receiving","inspector","reviewer","admin"].map(name=>name+"@qcw.test")
  ]);
});
after(()=>pool.end());
class Client {
  private jar=new Map<string,string>();
  sessionHash() {
    const secret=this.jar.get("session");
    assert(secret,"Sign in before referencing the session.");
    return createHash("sha256").update(secret).digest("hex");
  }
  async fetch(path:string,body?:unknown,method=body===undefined?"GET":"POST",expected=200,key=randomUUID()) {
    const multipart=body instanceof FormData;
    const rawBinary=body instanceof Uint8Array;
    const csrf=this.jar.get("qcw_csrf");
    const req=new Request(origin+"/api/v1"+path,{method,headers:{
      cookie:[...this.jar].map(([k,v])=>k+"="+v).join("; "),
      ...(method!=="GET"?{origin,"Idempotency-Key":key,...(csrf?{"x-csrf-token":csrf}:{}),...(!multipart&&!rawBinary?{"content-type":"application/json"}:rawBinary?{"content-type":"image/png"}:{})}:{})
    },...(body!==undefined?{body:multipart?body:rawBinary?new Uint8Array(body):JSON.stringify(body)}:{})});
    const response=await handle(req,path.split("?")[0]);
    for(const c of response.headers.getSetCookie()) {
      const match=c.match(/^([^=]+)=([^;]*)/);
      if(match)this.jar.set(match[1],match[2]);
    }
    if(response.headers.get("content-type")?.startsWith("application/pdf")) {
      assert.equal(response.status,expected,path);
      return {pdf:Buffer.from(await response.arrayBuffer())};
    }
    if(response.headers.get("content-type")?.startsWith("image/")) {
      assert.equal(response.status,expected,path);
      return {image:Buffer.from(await response.arrayBuffer())};
    }
    if(response.headers.get("content-type")?.startsWith("text/csv")) {
      assert.equal(response.status,expected,path);
      return {csv:await response.text()};
    }
    const data=await response.json();
    assertCoreResponse(method,path,response.status,data);
    assert.equal(response.status,expected,path+" "+JSON.stringify(data));
    return data;
  }
  async login(email:string) {
    const otp=await this.fetch("/auth/otp/request",{email},"POST",202);
    return this.fetch("/auth/otp/verify",{challenge_id:otp.challenge_id,code:otp.demo_code});
  }
  async photo(kind:string) {
    const b=await sharp({create:{width:100,height:80,channels:3,background:"#11736d"}}).png().toBuffer();
    const f=new FormData();
    f.set("photo",new Blob([new Uint8Array(b)],{type:"image/png"}),"proof.png");f.set("kind",kind);
    return (await this.fetch("/staff/media",f,"POST",201)).id;
  }
}
const staffSessions=new Map<string,Client>();
async function staffLogin(name:string) {
  const existing=staffSessions.get(name);
  if(existing) return existing;
  const client=new Client();
  assert.equal((await client.login(name+"@qcw.test")).kind,"staff");
  staffSessions.set(name,client);
  return client;
}
async function signCustomer() {
  const c=new Client();
  const email=randomUUID()+"@qcw.test";
  const result=await c.login(email);
  assert.equal(result.state,"onboarding");
  const {terms}=await c.fetch("/public/terms");
  const registration=await c.fetch("/auth/registration/complete",{terms_version_ids:terms.filter((t:{kind:string})=>["terms","privacy"].includes(t.kind)).map((t:{id:string})=>t.id)});
  assert.match(registration.receiving_code,/^QCW-/);
  assert.equal(registration.warehouse_address_status,"available");
  return {c,registration,terms,email};
}
async function createAndPay(c:Client,lines:object[],terms:{id:string}[]) {
  const draft=await c.fetch("/orders",{lines},"POST",201);
  const quote=await c.fetch("/orders/"+draft.id+"/quotes",{revision:draft.revision},"POST",201);
  const consent={scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true};
  const body={revision:draft.revision,quote_id:quote.id,terms_version_ids:terms.map(t=>t.id),acknowledgements:consent};
  const key=randomUUID();
  const submitted=await c.fetch("/orders/"+draft.id+"/submit",body,"POST",200,key);
  const replay=await c.fetch("/orders/"+draft.id+"/submit",body,"POST",200,key);
  assert.equal(submitted.charge.charge_item_id,replay.charge.charge_item_id);
  await c.fetch("/orders/"+draft.id+"/submit",{...body,revision:99},"POST",409,key);
  const pay=await c.fetch("/charges/"+submitted.charge.charge_item_id+"/checkout",{quote_revision:quote.revision});
  assert.equal(pay.state,"requires_payment");
  await c.fetch("/checkout/demo/"+pay.attempt_id,{});
  await c.fetch("/checkout/demo/"+pay.attempt_id,{});
  return {draft,quote,submitted,pay};
}

type InspectionView = {
  content:{checks:{key:string;method:string;unit?:string;type:string;required:boolean}[]};
  components:{id:string}[];
};
async function submitRequiredChecks(inspector:Client,taskId:string,revision:number,view:InspectionView) {
  const results=[];
  for(const member of view.components) for(const check of view.content.checks.filter(c=>c.required)) {
    results.push({
      item_key:check.key,component:member.id,attempt:1,status:"RECORDED",method:check.method,
      typed_value:check.type==="number"?0:check.type==="boolean"?false:"Observed",
      ...(check.unit?{unit:check.unit}:{}),is_final:true,evidence_ids:[await inspector.photo("shot")],
    });
  }
  const path="/staff/inspection-tasks/"+taskId;
  const saved=await inspector.fetch(path+"/results",{revision,results},"PUT");
  await inspector.fetch(path+"/submit",{revision:saved.revision});
}
async function shipOne(c:Client,staff:Client,rate:string,instructionId:string,itemId:string) {
  const batch=await c.fetch("/dispatch-batches",{disposition_ids:[instructionId]},"POST",201);
  const detailPath="/staff/dispatch-batches/"+batch.batch_id;
  const queue=(state:string,reference:string=batch.batch_id)=>"/staff/dispatch-batches?"+new URLSearchParams({state,reference});
  await c.fetch(detailPath,undefined,"GET",403);
  await c.fetch(queue("weighing"),undefined,"GET",403);
  assert.deepEqual((await staff.fetch(queue("weighing"))).rows,[]);
  await (await staffLogin("inspector")).fetch(detailPath,undefined,"GET",403);
  await staff.fetch(detailPath,undefined,"GET",404);
  const confirmed=await c.fetch("/dispatch-batches/"+batch.batch_id+"/confirm",{revision:batch.revision});
  const ready=await staff.fetch(detailPath);
  assert.equal(ready.batch.state,"confirmed");
  assert.equal((await staff.fetch(queue("weighing"))).rows[0].id,batch.batch_id);
  assert.equal(ready.batch.items[0].id,itemId);
  const quote=await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/quote",{revision:confirmed.revision,rate_version_id:rate,parcels:[{item_ids:[itemId],weight_g:540}]});
  assert.equal((await staff.fetch(queue("payment"))).rows[0].id,batch.batch_id);
  assert.deepEqual((await staff.fetch(queue("packing"))).rows,[]);
  const packedPhoto=await staff.photo("dispatch");
  const packing={revision:quote.revision,quote_id:quote.quote_id,item_ids:[itemId],weight_g:540,packed_media_ids:[packedPhoto]};
  await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/parcels",packing,"POST",409);
  const fee=await c.fetch("/quotes/"+quote.quote_id+"/accept",{revision:quote.revision});
  const payment=await c.fetch("/charges/"+fee.charge_item_id+"/checkout",{quote_revision:quote.revision});
  await c.fetch("/checkout/demo/"+payment.attempt_id,{});
  assert.equal((await staff.fetch(detailPath)).batch.state,"paid");
  assert.equal((await staff.fetch(queue("packing"))).rows[0].id,batch.batch_id);
  await pool.query("update charge_items set voided_at=now() where id=$1",[fee.charge_item_id]);
  try {
    assert.deepEqual((await staff.fetch(queue("packing"))).rows,[]);
    assert.equal((await staff.fetch(queue("blocked"))).rows[0].id,batch.batch_id);
  } finally {
    await pool.query("update charge_items set voided_at=null where id=$1",[fee.charge_item_id]);
  }
  await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/parcels",{...packing,revision:quote.revision+1,item_ids:[randomUUID()]},"POST",409);
  const shipment=await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/parcels",{...packing,revision:quote.revision+1},"POST",201);
  const packed=await staff.fetch(detailPath);
  assert.equal(packed.shipments[0].items[0].id,itemId);
  assert.equal(packed.shipments[0].tracking_norm,null);
  assert.deepEqual(packed.shipments[0].evidence_ids,[packedPhoto]);
  assert.equal((await staff.fetch(queue("handover"))).rows[0].packed,1);
  assert.deepEqual((await staff.fetch(queue("packing"))).rows,[]);
  const actual="YTO"+randomUUID().slice(0,8).toUpperCase();
  const hand={revision:shipment.revision,item_ids:[itemId],carrier_code:"yto",tracking_no:actual,evidence_ids:[await staff.photo("dispatch")],handed_at:new Date().toISOString()};
  await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/handover",hand);
  await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/handover",hand,"POST",409);
  const done=await staff.fetch(detailPath);
  assert.equal(done.batch.state,"completed");
  assert.equal(done.shipments[0].tracking_norm,actual);
  assert.equal(done.shipments[0].transport_state,"unknown");
  assert.equal(done.shipments[0].tracking_events,null);
  assert.equal(done.shipments[0].evidence_ids.length,2);
  assert.equal((await staff.fetch(queue("shipped",actual.toLowerCase()))).rows[0].id,batch.batch_id);
  return {shipment,actual};
}

test("portal routing preserves valid deep links and limits staff pages by role",()=>{
  const id=randomUUID();
  const routes=[
    ["/services/compare","public","catalog"],
    ["/orders/QW-A123/report","customer","report"],
    ["/parcels/"+id,"customer","parcel"],
    ["/wh/task/"+id,"warehouse","task"],
    ["/admin/logistics","admin","logistics"],
    ["/admin/integrations/logistics","admin","logistics-configuration"],
  ];
  for(const [path,area,view] of routes) {
    const route=resolvePortalRoute(path);
    assert.equal(route?.area,area,path);
    assert.equal(route.view,view,path);
  }
  for(const path of ["/orders/not-an-order","/parcels/"+id+"/extra","/admin/finance/extra","/wh/task/abc"])
    assert.equal(resolvePortalRoute(path),undefined,path);
  const next="/orders/new?offer="+id+"#items";
  assert.equal(resolvePortalRoute("/orders/QW-A123/report/versions/2")?.version,2);
  for(const section of ["payment","parcels","dispositions","storage"])
    assert.equal(resolvePortalRoute("/orders/QW-A123/"+section)?.section,section);
  assert.equal(resolvePortalRoute("/orders/QW-A123/report/versions/2147483648"),undefined);
  assert.equal(customerDestination(next),next);
  for(const path of ["/staff/login","/admin","/checkout/demo/"+id,"//example.test/orders","/\\example.test/orders","https://example.test/orders"])
    assert.equal(customerDestination(path),null,path);
  const staffNext="/wh/intake?tracking=fixture#intake-waybill";
  assert.equal(staffDestination(staffNext,["receiver"]),staffNext);
  assert.equal(staffDestination("/admin/finance",["receiver"]),null);
  assert.equal(staffDestination("/\t/example.test/wh/intake",["receiver"]),null);
  const permits=(path:string,roles:string[])=>canOpenStaffPage(path,resolvePortalRoute(path)!,roles);
  assert(permits("/wh/intake",["receiver"]));
  assert(!permits("/wh/task/"+id,["receiver"]));
  assert(permits("/wh/task/"+id,["reviewer"]));
  assert(permits("/admin/logistics",["receiver"]));
  assert(!permits("/admin/integrations/logistics",["receiver"]));
  assert(permits("/admin/integrations/logistics",["super_admin"]));
  assert.deepEqual(staffTabs("admin",["finance"]).map(([path])=>path),["/admin","/admin/finance"]);
  assert.deepEqual(staffTabs("admin",["support"]).map(([path])=>path),["/admin","/admin/orders","/admin/tickets","/admin/logistics"]);
  assert.deepEqual(staffTabs("admin",["template_admin"]).map(([path])=>path),["/admin","/admin/settings"]);
});

test("an interrupted inspection checkout resumes the current charge and requotes the same order after expiry",async()=>{
  const {c,terms}=await signCustomer(),another=(await signCustomer()).c;
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const draft=await c.fetch("/orders",{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}]},"POST",201);
  const orderPath="/orders/"+draft.id,paymentPath=orderPath+"/payment";
  const acknowledgements={scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true};
  async function accept(revision:number,shortLived=false) {
    const quote=await c.fetch(orderPath+"/quotes",{revision},"POST",201);
    if(shortLived) await pool.query("update inspection_quotes set expires_at=now()+interval '2 seconds' where id=$1",[quote.id]);
    const submitted=await c.fetch(orderPath+"/submit",{revision,quote_id:quote.id,terms_version_ids:terms.map(t=>t.id),acknowledgements});
    return {quote,submitted,checkoutPath:"/charges/"+submitted.charge.charge_item_id+"/checkout"};
  }
  assert.deepEqual(await c.fetch(paymentPath),{state:"not_due",charge:null});
  assert.equal((await c.fetch("/actions")).rows.find((action:{id:string})=>action.id===draft.id).state,"draft");
  assert(!(await another.fetch("/actions")).rows.some((action:{id:string})=>action.id===draft.id));
  await another.fetch(paymentPath,undefined,"GET",404);
  const first=await accept(draft.revision,true);
  const due=await c.fetch(paymentPath);
  assert.equal(due.state,"open");
  assert.equal(due.charge.id,first.submitted.charge.charge_item_id);
  const params={quote_revision:due.charge.quote_revision};
  const start=await c.fetch(first.checkoutPath,params);
  const restored=await c.fetch(first.checkoutPath,params);
  assert.equal(restored.attempt_id,start.attempt_id);
  await pool.query("update payments set state='processing' where id=$1",[start.attempt_id]);
  assert.equal((await c.fetch(paymentPath)).state,"processing");
  assert(!(await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===draft.id));
  assert.equal((await c.fetch(first.checkoutPath,params)).state,"processing");
  assert.equal((await c.fetch(orderPath)).state,"awaiting_payment");
  await pool.query("update payments set state='canceled' where id=$1",[start.attempt_id]);
  await pool.query("select pg_sleep(greatest(0,extract(epoch from expires_at-clock_timestamp()))+.02) from inspection_quotes where id=$1",[first.quote.id]);
  assert.equal((await c.fetch(paymentPath)).state,"expired");
  await c.fetch(first.checkoutPath,params,"POST",409);
  const second=await accept(first.submitted.order.revision);
  assert.equal(second.submitted.order.id,draft.id);
  assert.notEqual(second.submitted.charge.charge_item_id,due.charge.id);
  assert.equal((await c.fetch(paymentPath)).charge.id,second.submitted.charge.charge_item_id);
  await c.fetch(first.checkoutPath,params,"POST",409);
  const retry=await c.fetch(second.checkoutPath,{quote_revision:second.quote.revision});
  await c.fetch("/checkout/demo/"+retry.attempt_id,{});
  assert.equal((await c.fetch(paymentPath)).state,"paid");
  assert.equal((await c.fetch(orderPath)).state,"awaiting_samples");
  assert.equal((await c.fetch("/actions")).rows.find((action:{id:string})=>action.id===draft.id).state,"awaiting_samples");
});

test("a price version change requires a new quote on the same inspection order",async()=>{
  const {c,terms}=await signCustomer();
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const draft=await c.fetch("/orders",{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}]},"POST",201);
  const orderPath="/orders/"+draft.id;
  const oldQuote=await c.fetch(orderPath+"/quotes",{revision:draft.revision},"POST",201);
  const versionId=randomUUID(),newUnit=offer.rules.unit_cents+137;
  await pool.query(`insert into sku_prices(id,offer_id,version,currency,rules,effective_from)
    select $1,$2,max(version)+1,'USD',$3,now() from sku_prices where offer_id=$2`,
    [versionId,offer.offer_id,{...offer.rules,unit_cents:newUnit}]);
  try {
    const body={revision:draft.revision,quote_id:oldQuote.id,terms_version_ids:terms.map(t=>t.id),
      acknowledgements:{scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true}};
    const stale=await c.fetch(orderPath+"/submit",body,"POST",409);
    assert.equal(stale.error.code,"QUOTE_STALE");
    assert.deepEqual(await c.fetch(orderPath+"/payment"),{state:"not_due",charge:null});
    const updated=await c.fetch(orderPath+"/quotes",{revision:draft.revision},"POST",201);
    assert.equal(updated.amount_cents,newUnit);
    assert.equal(updated.line_snapshot[0].price_version,versionId);
    const accepted=await c.fetch(orderPath+"/submit",{...body,quote_id:updated.id});
    assert.equal(accepted.order.id,draft.id);
    assert.equal(accepted.charge.amount_cents,newUnit);
  } finally {
    await pool.query("update sku_prices set effective_to=now() where id=$1",[versionId]);
  }
});

test("an order keeps the terms it accepted when new policies take effect",async()=>{
  const {c,terms}=await signCustomer(),other=(await signCustomer()).c,publicClient=new Client();
  const original=terms.find(t=>t.kind==="terms");
  assert(original);
  const offer=(await c.fetch("/catalog")).offers.find((o:{service:string})=>o.service==="inspection");
  const {draft}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],terms);
  const current=randomUUID(),draftPolicy=randomUUID(),future=randomUUID();
  const body="Temporary policy fixture.";
  await pool.query(`insert into terms_versions(id,kind,version,effective_at,content_md,content_hash)
    values($1::uuid,'terms',$1::uuid::text,now(),$4,$5),($2::uuid,'terms',$2::uuid::text,null,$4,$5),
    ($3::uuid,'terms',$3::uuid::text,now()+interval '1 year',$4,$5)`,[current,draftPolicy,future,body,createHash("sha256").update(body).digest("hex")]);
  try {
    const path="/public/terms/terms";
    assert.equal((await publicClient.fetch(path)).terms[0].version,current);
    const old=(await publicClient.fetch(path+"?"+new URLSearchParams({version:original.version}))).terms[0];
    assert.equal(old.id,original.id);
    assert(old.effective_at);
    await publicClient.fetch(path+"?version="+draftPolicy,undefined,"GET",404);
    await publicClient.fetch(path+"?version="+future,undefined,"GET",404);
    await publicClient.fetch("/public/terms/privacy?version="+current,undefined,"GET",404);
    await publicClient.fetch(path+"?version=&version="+current,undefined,"GET",422);
    const orderPath="/orders/"+draft.id;
    const saved=await c.fetch(orderPath);
    assert.equal(saved.consents.length,1);
    assert.equal(saved.consents[0].policies.length,4);
    assert.deepEqual(saved.consents[0].policies.find((t:{kind:string})=>t.kind==="terms"),{kind:"terms",version:original.version});
    await other.fetch(orderPath,undefined,"GET",404);
  } finally {
    await pool.query("delete from terms_versions where id=any($1::uuid[])",[[current,draftPolicy,future]]);
  }
});

for(const category of ["Apparel","Bags","Home goods"]) {
test(category+": customer to warehouse to PDF to dispatch on the same records",async()=>{
  const {c,registration,terms,email}=await signCustomer();
  const another=await signCustomer();
  const relogin=new Client();
  assert.equal((await relogin.login(email)).state,"signed_in");
  assert.equal((await relogin.fetch("/me/receiving-address")).receiving_code,registration.receiving_code);
  const staff=await staffLogin("receiving"),inspector=await staffLogin("inspector"),reviewer=await staffLogin("reviewer");
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,carrier_code:"zto",tracking_no:tracking},"POST",201);
  const track=await c.fetch("/me/parcels/"+advice.id+"/tracking");
  assert.equal(track.warehouse_state,null);
  await another.c.fetch("/me/parcels/"+advice.id+"/tracking",undefined,"GET",404);
  const match=await staff.fetch("/staff/intake/lookup",{tracking_no:tracking});
  assert.equal(match.match_state,"user_only");
  const proof=await staff.photo("intake_outer");
  const request={tracking_no:tracking,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[proof]};
  const pkg=await staff.fetch("/staff/intake/check-in",request,"POST",201);
  const replay=await staff.fetch("/staff/intake/check-in",request,"POST",201);
  assert.equal(replay.id,pkg.id);
  const desk=await staff.fetch("/staff/desk");
  const origin=desk.locations.find((location:{code:string})=>location.code==="R-01"),loc=origin.id;
  const items=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:[{code:"S-"+randomUUID(),location_id:loc}]},"POST",201);
  const itemId=items.item_ids[0];
  const packagePath="/staff/packages/"+pkg.id;
  const found=await staff.fetch("/staff/intake/lookup",{tracking_no:tracking});
  assert.equal(found.package_id,pkg.id);
  await staff.fetch("/staff/intake/lookup",{tracking_no:"!"},"POST",422);
  const detail=await staff.fetch(packagePath);
  const byCode="/staff/packages/by-code/"+detail.parcel.code;
  assert.equal((await staff.fetch(byCode)).parcel.id,pkg.id);
  await c.fetch(byCode,undefined,"GET",403);
  assert.equal(detail.parcel.id,pkg.id);
  assert.equal(detail.parcel.received_quantity,1);
  assert.equal(detail.parcel.revision,items.revision);
  assert.equal(detail.items[0].id,itemId);
  assert.equal(detail.items[0].location,origin.code);
  await c.fetch(packagePath,undefined,"GET",403);
  await inspector.fetch(packagePath,undefined,"GET",403);
  await staff.fetch("/staff/packages/"+randomUUID(),undefined,"GET",404);
  assert.equal((await c.fetch("/me/items")).items[0].item_id,itemId);
  const offer=(await c.fetch("/catalog")).offers.find((o:{service:string;category:{en:string}})=>o.service==="inspection"&&o.category.en===category);
  assert(offer);
  const {draft}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],terms);
  await another.c.fetch("/orders/"+draft.id,undefined,"GET",404);
  await c.fetch("/staff/desk",undefined,"GET",403);
  const order=await c.fetch("/orders/"+draft.id);
  assert.equal(order.state,"awaiting_samples");
  const scanPath="/staff/items/by-code?"+new URLSearchParams({code:detail.items[0].code});
  if(category==="Apparel") {
    const unrelated=await createAndPay(another.c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],another.terms);
    assert.notEqual(unrelated.draft.id,draft.id);
  }
  const located=await staff.fetch(scanPath);
  assert.equal(located.item.id,itemId);
  assert.equal(located.item.package_code,detail.parcel.code);
  assert.deepEqual(located.positions.map((p:{public_no:string})=>p.public_no),[draft.public_no]);
  await c.fetch(scanPath,undefined,"GET",403);
  await inspector.fetch(scanPath,undefined,"GET",403);
  await staff.fetch("/staff/items/by-code?code=S-UNKNOWN-"+randomUUID(),undefined,"GET",404);
  const e=order.items[0],label=await staff.photo("label_photo");
  const bind={revision:1,order_line_id:e.order_line_id,expected_item_id:e.id,evidence_ids:[label]};
  await staff.fetch("/staff/items/"+itemId+"/assign",bind);
  await staff.fetch("/staff/items/"+itemId+"/assign",bind,"POST",409);
  const identified=await staff.fetch(scanPath);
  assert.equal(identified.item.order_number,draft.public_no);
  assert.deepEqual(identified.positions,[]);
  const nextLocation=desk.locations.find((location:{code:string})=>location.code==="S-01");
  await staff.fetch("/staff/storage/move",{item_id:itemId,revision:identified.item.revision,location_id:nextLocation.id});
  await staff.fetch("/staff/storage/move",{item_id:itemId,revision:identified.item.revision,location_id:loc},"POST",409);
  assert.equal((await staff.fetch(scanPath)).item.location,nextLocation.code);
  const {rows:[task]}=await pool.query(`select t.id,t.revision from inspection_tasks t join order_lines l on l.id=t.order_line_id
    where l.order_id=$1`,[draft.id]);
  assert(task,"Assignment must create an inspection task");
  const started=await inspector.fetch("/staff/inspection-tasks/"+task.id+"/start",{revision:task.revision});
  await inspector.fetch("/staff/inspection-tasks/"+task.id+"/submit",{revision:started.revision},"POST",409);
  const view=await inspector.fetch("/staff/inspection-tasks/"+task.id);
  assert.equal(view.content.checks[0].label,{"Apparel":"Visible condition","Bags":"Hardware condition","Home goods":"Surface finish"}[category]);
  await submitRequiredChecks(inspector,task.id,started.revision,view);
  const inspecting=await c.fetch("/orders/"+draft.id);
  const submitReportPath="/staff/orders/"+draft.id+"/report/submit";
  let report=await inspector.fetch(submitReportPath,{revision:inspecting.revision,task_ids:[task.id]});
  await c.fetch("/orders/"+draft.id+"/report",undefined,"GET",404);
  if(category==="Bags") {
    const returnedPath="/staff/reports/"+report.id+"/reject";
    const feedback={revision:1,reason:"Recheck whether the latch closes smoothly."};
    await c.fetch(returnedPath,feedback,"POST",403);
    const inspectorId=(await inspector.fetch("/me")).actor.id;
    await pool.query("insert into staff_roles(user_id,role) values($1,'reviewer')",[inspectorId]);
    try {
      const self=await inspector.fetch(returnedPath,feedback,"POST",409);
      assert.equal(self.error.code,"SELF_REVIEW_FORBIDDEN");
    } finally {
      await pool.query("delete from staff_roles where user_id=$1 and role='reviewer'",[inspectorId]);
    }
    const key=randomUUID();
    const [first,replay]=await Promise.all([
      reviewer.fetch(returnedPath,feedback,"POST",200,key),reviewer.fetch(returnedPath,feedback,"POST",200,key),
    ]);
    assert.deepEqual(first,replay);
    await reviewer.fetch("/staff/reports/"+report.id+"/approve",{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",409);
    const taskPath="/staff/inspection-tasks/"+task.id;
    const correction=await inspector.fetch(taskPath);
    assert.equal(correction.state,"IN_PROGRESS");
    assert.equal(correction.assignee_id,inspectorId);
    assert.equal(correction.review_feedback,feedback.reason);
    const check=correction.content.checks[0];
    const saved=await inspector.fetch(taskPath+"/results",{revision:correction.revision,results:[{
      item_key:check.key,component:correction.components[0].id,attempt:2,status:"RECORDED",method:check.method,
      typed_value:true,is_final:true,evidence_ids:[await inspector.photo("shot")],
    }]},"PUT");
    await inspector.fetch(taskPath+"/submit",{revision:saved.revision});
    const updated=await c.fetch("/orders/"+draft.id);
    report=await inspector.fetch(submitReportPath,{revision:updated.revision,task_ids:[task.id]});
    assert.equal(report.version,2);
    await c.fetch("/orders/"+draft.id+"/report/versions/1",undefined,"GET",404);
  }
  await reviewer.fetch("/staff/reports/"+report.id+"/approve",{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  await c.fetch("/orders/"+draft.id+"/report",undefined,"GET",404);
  for(let i=0;i<50;i++){if(!await workOnce())break;}
  const pdfPath="/orders/"+draft.id+"/report/versions/"+report.version;
  await another.c.fetch("/orders/"+draft.id+"/report",undefined,"GET",404);
  const {rows:[privatePhoto]}=await pool.query("select id from media_assets where task_id=$1 and result_id is not null limit 1",[task.id]);
  assert(privatePhoto);
  await another.c.fetch("/media/"+privatePhoto.id,undefined,"GET",404);
  const ticket=await c.fetch(pdfPath+"/pdf");
  const url=new URL(ticket.url);
  const download=url.pathname.slice("/api/v1".length)+url.search;
  const pdf=await c.fetch(download);
  assert.equal(pdf.pdf.subarray(0,4).toString(),"%PDF");
  assert(pdf.pdf.includes(Buffer.from("/Subtype /Image")));
  await c.fetch(pdfPath+"/file",undefined,"GET",403);
  await c.fetch(download.replace(/expires=\d+/,"expires=1"),undefined,"GET",403);
  await another.c.fetch(download,undefined,"GET",404);
  const forward=category==="Home goods";
  const destination=forward?{recipient:"Forwarder",phone:"00000000000",address:"Forwarder test address",member_code:"TEST-QCW"}
    :{recipient:"Seller",phone:"00000000000",address:"Seller test address"};
  const orderEntry=category==="Apparel";
  const instructionPath=orderEntry?"/orders/"+draft.id+"/dispositions":"/me/items/"+itemId+"/dispositions";
  const instr=await c.fetch(instructionPath,{action:forward?"to_forwarder":"return_to_seller",
    ...(orderEntry?{item_id:itemId}:{}),terms_version_id:terms.find((t:{kind:string})=>t.kind==="terms").id,destination,
    ...(!forward?{return_info:{requested_from_seller:true,customer_pays_shipping:true}}:{})},"POST",201);
  const {shipment,actual}=await shipOne(c,staff,desk.rates[0].id,instr.id,itemId);
  const outbound=await c.fetch("/shipments/"+shipment.shipment_id+"/tracking");
  assert.equal(outbound.tracking_no,actual);assert.equal(outbound.direction,forward?"outbound_forward":"outbound_return");assert.equal(outbound.warehouse_state,"shipped");
  await another.c.fetch("/shipments/"+shipment.shipment_id+"/tracking",undefined,"GET",404);
  if(category==="Apparel") {
    const admin=await staffLogin("admin");
    const staffPath="/staff/orders/by-number/"+draft.public_no;
    const search=(query:string)=>"/staff/orders?"+new URLSearchParams({query});
    for(const identifier of [draft.public_no.toLowerCase(),tracking,detail.items[0].code]) {
      assert.deepEqual((await admin.fetch(search(identifier))).rows.map((row:{id:string})=>row.id),[draft.id]);
    }
    assert.deepEqual((await admin.fetch(search("NO-MATCH-"+randomUUID()))).rows,[]);
    await admin.fetch("/staff/orders/by-number/QW-000000000000",undefined,"GET",404);
    await c.fetch(staffPath,undefined,"GET",403);
    await inspector.fetch(staffPath,undefined,"GET",403);
    await staff.fetch(search(tracking),undefined,"GET",403);
    const staffView=await admin.fetch(staffPath);
    assert.equal(staffView.items[0].custody_state,"outbound");
    assert.equal(staffView.items[0].location,null);
    assert(staffView.paid_at);
    assert(staffView.report_published_at);
    assert.equal(staffView.parcels[0].code,detail.parcel.code);
    assert(staffView.parcels[0].received_at);
    assert.equal(staffView.shipments[0].tracking_norm,actual);
    assert(!("destination_snapshot" in staffView.shipments[0]));
    assert(staffView.activity.some((entry:{action:string})=>entry.action==="submit_order"));
    await assert.rejects(pool.query("update tracking_records set org_id=$2 where id=$1",
      [outbound.tracking_id,another.registration.org_id]),{code:"23503"});
  }
  assert.equal((await c.fetch("/me/items")).items[0].custody_state,"outbound");
  const returned={revision:shipment.revision+1,item_ids:[itemId],location_id:loc,evidence_ids:[await staff.photo("dispatch")],received_at:new Date().toISOString()};
  const confirmedReturn=await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/receive-return",returned);
  const repeated=await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/receive-return",returned);
  assert.equal(confirmedReturn.return_status,"complete");assert.equal(repeated.revision,confirmedReturn.revision);
  assert.equal((await c.fetch("/me/items")).items[0].custody_state,"stored");
  const dispatchDetail=await staff.fetch("/staff/dispatch-batches/"+(await pool.query("select batch_id from shipments where id=$1",[shipment.shipment_id])).rows[0].batch_id);
  assert.equal(dispatchDetail.shipments[0].state,"returned");
  assert.equal((await staff.fetch("/staff/dispatch-batches?state=returned&reference="+actual)).rows[0].returns,1);
  assert(dispatchDetail.shipments[0].items[0].received_at);
  if(category==="Apparel") {
    const {rows:[reference]}=await pool.query(`insert into reference_samples(id,item_id,org_id,revision,authorization_snapshot,expires_at,state)
      values($1,$2,$3,1,'{}',now()+interval '1 day','active') returning id`,[randomUUID(),itemId,registration.org_id]);
    assert.equal((await c.fetch("/me/reference-samples")).items[0].reference_id,reference.id);
    assert.deepEqual((await another.c.fetch("/me/reference-samples")).items,[]);
  }
});
}

test("33 physical items from three parcels share one order, report and selective return",async()=>{
  const {c,terms,registration}=await signCustomer();
  const offers=(await c.fetch("/catalog")).offers;
  const ordered=[
    {sku:"apparel-inspection-1",quantity:28},
    {sku:"bags-shadow",quantity:1},
    {sku:"home-shadow",quantity:1},
    {sku:"apparel-compare-3",quantity:3},
  ].map(({sku,quantity})=>{
    const offer=offers.find((o:{sku_code:string})=>o.sku_code===sku);
    assert(offer,"Missing offer "+sku);
    return {offer,quantity};
  });
  const {draft,quote}=await createAndPay(c,ordered.map(({offer,quantity})=>({category_id:offer.category_id,offer_id:offer.offer_id,quantity})),terms);
  const amount=ordered.reduce((total,{offer,quantity})=>total+(offer.rules.package_cents??offer.rules.unit_cents*quantity),0);
  assert.equal(quote.amount_cents,amount);
  const path="/orders/"+draft.id;
  const order=await c.fetch(path);
  assert.equal(order.items.length,33);
  assert.deepEqual(order.parcels,[]);
  const separate=await c.fetch("/orders",{lines:[{category_id:ordered[0].offer.category_id,offer_id:ordered[0].offer.offer_id,quantity:1}]},"POST",201);
  const withoutOrder={category:"receipt_mismatch",subject:"Review the declared quantities",message:"Check this order's seller waybills."};
  const issue={...withoutOrder,order_id:draft.id};
  const other=(await signCustomer()).c;
  await other.fetch("/me/cases",issue,"POST",404);
  await c.fetch("/me/cases",withoutOrder,"POST",422);
  const createdCase=await c.fetch("/me/cases",issue);
  assert.deepEqual((await c.fetch(path)).cases,[{id:createdCase.id,public_no:createdCase.public_no,subject:issue.subject,state:"open"}]);
  assert.deepEqual((await c.fetch("/orders/"+separate.id)).cases,[]);
  await c.fetch("/cases/"+createdCase.id+"?order="+draft.public_no);
  await c.fetch("/cases/"+createdCase.id+"?order="+separate.public_no,undefined,"GET",404);

  const staff=await staffLogin("receiving"),inspector=await staffLogin("inspector"),reviewer=await staffLogin("reviewer");
  const desk=await staff.fetch("/staff/desk");
  const location=desk.locations.find((row:{code:string})=>row.code==="R-01").id;
  const itemIds:string[]=[],inbound:{adviceId:string;tracking:string}[]=[];
  for(let offset=0;offset<33;offset+=11) {
    const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
    const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,carrier_code:"zto",tracking_no:tracking,order_ids:[draft.id]},"POST",201);
    inbound.push({adviceId:advice.id,tracking});
    const beforeIntake=(await c.fetch(path)).parcels.find((p:{id:string})=>p.id===advice.id);
    assert.equal(beforeIntake.transport_state,"unknown");
    assert.equal(beforeIntake.warehouse_state,null);
    const match=await staff.fetch("/staff/intake/lookup",{tracking_no:tracking,carrier_code:"zto"});
    assert.deepEqual(match.order_ids,[draft.id]);
    const pkg=await staff.fetch("/staff/intake/check-in",{tracking_no:tracking,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[await staff.photo("intake_outer")]},"POST",201);
    const positions=order.items.slice(offset,offset+11);
    const listed=positions.map(()=>({code:"S-"+randomUUID(),location_id:location}));
    const {item_ids}=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:listed},"POST",201);
    assert.equal(item_ids.length,11);
    itemIds.push(...item_ids);
    for(const [index,position] of positions.entries()) {
      await staff.fetch("/staff/items/"+item_ids[index]+"/assign",{revision:1,order_line_id:position.order_line_id,
        expected_item_id:position.id,evidence_ids:[await staff.photo("label_photo")]});
    }
    assert.equal((await c.fetch(path)).state,offset<22?"awaiting_samples":"queued");
  }
  assert.equal((await c.fetch(path)).parcels.length,3);
  const admin=await staffLogin("admin");
  const staffView=await admin.fetch("/staff/orders/by-number/"+draft.public_no);
  assert.deepEqual(staffView.parcels.map((p:{tracking_norm:string})=>p.tracking_norm),inbound.map(p=>p.tracking).sort());
  assert.equal(staffView.items.length,33);
  assert.equal(staffView.tickets[0].id,createdCase.id);
  assert(!(await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===draft.id));
  assert.deepEqual((await c.fetch("/orders/"+separate.id)).parcels,[]);
  assert.equal(new Set(itemIds).size,33);
  const {rows:tasks}=await pool.query(`select t.id,t.revision,t.assignment_id,t.group_id
    from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1 order by t.id`,[draft.id]);
  assert.equal(tasks.filter(task=>task.assignment_id).length,30);
  assert.equal(tasks.filter(task=>task.group_id).length,1);
  for(const [index,task] of tasks.entries()) {
    const taskPath="/staff/inspection-tasks/"+task.id;
    const started=await inspector.fetch(taskPath+"/start",{revision:task.revision});
    const view=await inspector.fetch(taskPath);
    assert.equal(view.components.length,task.group_id?3:1);
    if(index===tasks.length-1) {
      const pending=await c.fetch(path);
      const incomplete=await inspector.fetch("/staff/orders/"+draft.id+"/report/submit",{
        revision:pending.revision,task_ids:tasks.map(t=>t.id)
      },"POST",409);
      assert.equal(incomplete.error.code,"REPORT_INCOMPLETE");
    }
    await submitRequiredChecks(inspector,task.id,started.revision,view);
  }
  const current=await c.fetch(path);
  const report=await inspector.fetch("/staff/orders/"+draft.id+"/report/submit",{revision:current.revision,task_ids:tasks.map(t=>t.id)});
  await reviewer.fetch("/staff/reports/"+report.id+"/approve",{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  const published=await c.fetch(path+"/report");
  const sections=published.snapshot.sections as {service:string;results:{label:string;item:string}[]}[];
  assert.equal(sections.filter(s=>s.service==="inspection").length,30);
  const group=sections.find(s=>s.service==="compare");
  assert(group);
  assert.equal(new Set(group.results.map(r=>r.item)).size,3);
  const labels=sections.flatMap(s=>s.results.map(r=>r.label));
  for(const expected of ["Visible condition","Hardware condition","Surface finish"]) assert(labels.includes(expected));
  assert.deepEqual(published.versions.map((v:{version:number})=>v.version),[1]);

  const reportId=(await pool.query("select report_id from report_versions where id=$1",[report.id])).rows[0].report_id;
  const amendReason="Clarified evidence captions.",amendPath="/staff/reports/"+reportId+"/amend";
  const amendBody={base_version:1,reason:amendReason},amendKey=randomUUID();
  const orderBeforeAmend=await c.fetch(path);
  await c.fetch(amendPath,amendBody,"POST",403);
  await inspector.fetch(amendPath,amendBody,"POST",403);
  const [amended,replayed]=await Promise.all([
    staff.fetch(amendPath,amendBody,"POST",200,amendKey),staff.fetch(amendPath,amendBody,"POST",200,amendKey),
  ]);
  assert.deepEqual(amended,replayed);
  assert.equal(amended.version,2);
  const pending=await staff.fetch(amendPath,amendBody,"POST",409);
  assert.equal(pending.error.code,"AMENDMENT_PENDING");
  const revisionId=amended.id,revisionPath="/staff/reports/"+revisionId;
  assert((await staff.fetch("/staff/reports?order="+draft.public_no)).rows.some((v:{id:string})=>v.id===revisionId));
  const preview=await staff.fetch(revisionPath);
  assert.equal(preview.base_snapshot.order_no,draft.public_no);
  assert.deepEqual(preview.snapshot.sections,published.snapshot.sections);
  await c.fetch(revisionPath,undefined,"GET",403);
  await staff.fetch(revisionPath+"/submit-revision",{revision:1},"POST",409);
  const edit={revision:1,changes:[{section:0,result:0,status:"NOT_TESTED",typed_value:null,reason:"The original result needs clarification."}]};
  await reviewer.fetch(revisionPath,edit,"PATCH",409);
  await staff.fetch(revisionPath,{...edit,changes:[{...edit.changes[0],section:999}]},"PATCH",422);
  const corrected=await staff.fetch(revisionPath,edit,"PATCH");
  await staff.fetch(revisionPath,edit,"PATCH",409);
  const submitted=await staff.fetch(revisionPath+"/submit-revision",{revision:corrected.revision});
  const staffId=(await staff.fetch("/me")).actor.id;
  await pool.query("insert into staff_roles(user_id,role) values($1,'reviewer')",[staffId]);
  try {
    assert.equal((await staff.fetch(revisionPath+"/approve",{revision:submitted.revision,
      checklist:["reviewed_en","evidence_checked"]},"POST",409)).error.code,"SELF_REVIEW_FORBIDDEN");
  } finally {
    await pool.query("delete from staff_roles where user_id=$1 and role='reviewer'",[staffId]);
  }
  const returned=await reviewer.fetch(revisionPath+"/reject",{revision:submitted.revision,reason:"Clarify the revised observation."});
  const draftAgain=await staff.fetch(revisionPath);
  assert.equal(draftAgain.review_feedback,"Clarify the revised observation.");
  assert.equal(draftAgain.state,"draft");
  const resubmitted=await staff.fetch(revisionPath+"/submit-revision",{revision:draftAgain.revision});
  assert.equal(returned.state,"draft");
  await c.fetch(path+"/report/versions/2",undefined,"GET",404);
  assert.deepEqual((await c.fetch(path+"/report")).versions.map((v:{version:number})=>v.version),[1]);
  await reviewer.fetch(revisionPath+"/approve",{revision:resubmitted.revision,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  await staff.fetch(revisionPath,{...edit,revision:resubmitted.revision},"PATCH",409);
  const mediaId=published.snapshot.sections[0].results[0].evidence_ids[0];
  const mediaFile=(await pool.query("select f.key,f.data from private_files f join media_assets m on m.object_key=f.key where m.id=$1",[mediaId])).rows[0];
  await pool.query("update private_files set data=$2 where key=$1",[mediaFile.key,Buffer.from("transient unreadable evidence fixture")]);
  try {
    await assert.rejects(workOnce());
    assert.equal((await c.fetch(path+"/report")).version,1);
    assert.equal((await staff.fetch(revisionPath)).state,"qa_approved");
    assert.equal((await pool.query("select count(*)::int n from private_files where key=$1",["reports/"+revisionId+".pdf"])).rows[0].n,0);
    assert.equal((await pool.query("select count(*)::int n from notifications where order_id=$1 and template='report.amended'",[draft.id])).rows[0].n,0);
  } finally {
    await pool.query("update private_files set data=$2 where key=$1",[mediaFile.key,mediaFile.data]);
    await pool.query("update outbox_events set attempts=10,next_attempt_at=now() where type='report.render' and payload->>'version_id'=$1",[revisionId]);
  }
  const job=(await pool.query("select id from outbox_events where type='report.render' and payload->>'version_id'=$1",[revisionId])).rows[0];
  const recoveryAdmin=await staffLogin("admin");
  const failures=await recoveryAdmin.fetch("/staff/admin/jobs");
  assert.equal(failures.max_attempts,10);
  const listedJob=failures.rows.find((j:{id:string})=>j.id===job.id);
  assert.equal(listedJob.order_number,draft.public_no);
  assert(!("payload" in listedJob));
  const retryPath="/staff/admin/jobs/"+job.id+"/retry";
  const repair={attempts:10,reason:"Restored the temporarily unreadable evidence image."};
  await c.fetch("/staff/admin/jobs",undefined,"GET",403);
  await staff.fetch(retryPath,repair,"POST",403);
  await recoveryAdmin.fetch(retryPath,{...repair,attempts:9},"POST",409);
  await pool.query("update sessions set mfa_at=now()-interval '11 minutes' where token_hash=$1",[recoveryAdmin.sessionHash()]);
  assert.equal((await recoveryAdmin.fetch(retryPath,repair,"POST",403)).error.code,"STAFF_REAUTH_REQUIRED");
  await recoveryAdmin.login("admin@qcw.test");
  const retryKey=randomUUID();
  const [scheduled,retryReplay]=await Promise.all([
    recoveryAdmin.fetch(retryPath,repair,"POST",200,retryKey),recoveryAdmin.fetch(retryPath,repair,"POST",200,retryKey),
  ]);
  assert.deepEqual(scheduled,retryReplay);
  assert.equal(scheduled.state,"pending");
  await recoveryAdmin.fetch(retryPath,repair,"POST",409);
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='retry_outbox' and after->>'job_id'=$1",[job.id])).rows[0].n,1);
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  await recoveryAdmin.fetch(retryPath,repair,"POST",409);
  assert.equal((await c.fetch(path)).state,orderBeforeAmend.state);
  assert.equal((await c.fetch(path)).revision,orderBeforeAmend.revision);
  assert.equal((await pool.query("select count(*)::int n from notifications where order_id=$1 and template='report.amended'",[draft.id])).rows[0].n,1);
  const latest=await c.fetch(path+"/report"),history=await c.fetch(path+"/report/versions/1");
  assert.equal(latest.version,2);
  assert.equal(latest.amend_reason,amendReason);
  assert.deepEqual(latest.versions.map((v:{version:number})=>v.version),[2,1]);
  const reportList="/me/reports?reference="+draft.public_no;
  const versions=(await c.fetch(reportList)).rows;
  assert.deepEqual(versions.map((v:{version:number;is_current:boolean})=>[v.version,v.is_current]),[[2,true],[1,false]]);
  assert.deepEqual((await c.fetch(reportList+"&version=1")).rows.map((v:{version:number})=>v.version),[1]);
  assert.equal((await c.fetch("/me/reports?reference="+published.snapshot.report_no)).rows.length,2);
  assert.deepEqual((await other.fetch(reportList)).rows,[]);
  await c.fetch(reportList+"&version=0",undefined,"GET",422);
  assert.equal(history.state,"superseded");
  assert.deepEqual(history.snapshot,published.snapshot);
  const sharesPath=path+"/report/versions/1/shares";
  const anonymous=new Client();
  const shareSetting=process.env.REPORT_SHARING_ENABLED;
  try {
    process.env.REPORT_SHARING_ENABLED="0";
    assert.equal((await c.fetch(sharesPath)).enabled,false);
    await c.fetch(sharesPath,{days:7},"POST",403);
    process.env.REPORT_SHARING_ENABLED="1";
    await other.fetch(sharesPath,undefined,"GET",404);
    await other.fetch(sharesPath,{days:7},"POST",404);
    await c.fetch(path+"/report/versions/99/shares",{days:7},"POST",404);
    await c.fetch(sharesPath,{days:2},"POST",422);
    const shareKey=randomUUID();
    const [shared,replayed]=await Promise.all([
      c.fetch(sharesPath,{days:7},"POST",201,shareKey),c.fetch(sharesPath,{days:7},"POST",201,shareKey),
    ]);
    assert.deepEqual(shared,replayed);
    await c.fetch(sharesPath,{days:30},"POST",409,shareKey);
    const token=new URL(shared.url).pathname.split("/").at(-1)!;
    const publicPath="/public/report-shares/"+token,photoPath=publicPath+"/photos/0/0/0";
    assert.equal(token.length,43);
    const response=await handle(new Request(origin+"/api/v1"+publicPath),publicPath);
    assert.equal(response.headers.get("cache-control"),"private, no-store");
    assert.equal(response.headers.get("x-robots-tag"),"noindex, nofollow");
    assert.equal(response.headers.get("referrer-policy"),"no-referrer");
    const publicReport=await response.json();
    assert.equal(publicReport.version,1);
    assert.equal(publicReport.order_number,draft.public_no);
    assert(!JSON.stringify(publicReport).includes(mediaId));
    assert(!("inspector_id" in publicReport.sections[0]));
    assert.equal(publicReport.sections[0].results[0].reason,undefined);
    assert((await anonymous.fetch(photoPath)).image.length>0);
    await anonymous.fetch(publicPath+"/photos/0/0/999999",undefined,"GET",404);
    await anonymous.fetch("/media/"+mediaId,undefined,"GET",401);
    const expiry=await c.fetch(sharesPath,{days:1},"POST",201);
    await pool.query("update report_shares set expires_at=now()-interval '1 minute' where id=$1",[expiry.id]);
    await anonymous.fetch("/public/report-shares/"+new URL(expiry.url).pathname.split("/").at(-1),undefined,"GET",404);
    const {rows:[saved]}=await pool.query(`select s.token_hash,k.response::text receipt from report_shares s
      join idempotency_keys k on k.key=$2 where s.id=$1`,[shared.id,shareKey]);
    assert.equal(saved.token_hash,createHash("sha256").update(token).digest("hex"));
    assert(!saved.receipt.includes(token));
    const revoke="/me/report-shares/"+shared.id;
    await other.fetch(revoke,{},"DELETE",404);
    const revoked=await c.fetch(revoke,{},"DELETE");
    assert.deepEqual(await c.fetch(revoke,{},"DELETE"),revoked);
    await anonymous.fetch(publicPath,undefined,"GET",404);
    await anonymous.fetch(photoPath,undefined,"GET",404);
    const unavailable=await handle(new Request(origin+"/api/v1"+photoPath),photoPath);
    assert.equal(unavailable.headers.get("cache-control"),"private, no-store");
    assert.equal(unavailable.headers.get("referrer-policy"),"no-referrer");
    assert.equal((await c.fetch(sharesPath)).shares.find((s:{id:string})=>s.id===shared.id).state,"revoked");
    assert.equal((await c.fetch(path+"/report/versions/1")).version,1);
  } finally {
    if(shareSetting===undefined)delete process.env.REPORT_SHARING_ENABLED;
    else process.env.REPORT_SHARING_ENABLED=shareSetting;
  }
  await c.fetch(path+"/report/versions/1/pdf");
  await other.fetch(path+"/report/versions/1",undefined,"GET",404);
  await assert.rejects(pool.query("update report_versions set amend_reason='mutate history' where id=$1",[report.id]),{code:"23514"});

  const itemId=itemIds[0],termsVersion=terms.find((t:{kind:string})=>t.kind==="terms").id;
  const returnIntent={action:"return_to_seller",terms_version_id:termsVersion,
    return_info:{requested_from_seller:true,customer_pays_shipping:true}};
  const returnPath="/me/items/"+itemId+"/dispositions";
  await c.fetch(returnPath,returnIntent,"POST",422);
  const returnBody={...returnIntent,item_id:itemId,destination:{recipient:"Seller",phone:"00000000000",address:"Seller test address"}};
  await c.fetch("/orders/"+separate.id+"/dispositions",returnBody,"POST",404);
  await other.fetch(path+"/dispositions",returnBody,"POST",404);
  await c.fetch(path+"/dispositions",{...returnBody,return_info:{...returnIntent.return_info,deadline:"2000-01-01T00:00:00.000Z"}},"POST",409);
  const instruction=await c.fetch(path+"/dispositions",returnBody,"POST",201);
  const active=(await c.fetch(path)).items.find((item:{item_id:string})=>item.item_id===itemId).instruction;
  assert.deepEqual(active,{id:instruction.id,action:"return_to_seller",state:"requested",awaiting_batch:true});
  const {shipment,actual}=await shipOne(c,staff,desk.rates[0].id,instruction.id,itemId);
  assert.equal((await c.fetch("/shipments/"+shipment.shipment_id+"/tracking")).tracking_no,actual);
  assert.deepEqual((await c.fetch(path)).shipments.map((record:{tracking_norm:string})=>record.tracking_norm),[actual]);
  assert.deepEqual((await c.fetch("/orders/"+separate.id)).shipments,[]);
  for(const {adviceId,tracking} of inbound) assert.equal((await c.fetch("/me/parcels/"+adviceId+"/tracking")).tracking_no,tracking);
  const {items}=await c.fetch("/me/items");
  assert.equal(items.filter((x:{custody_state:string})=>x.custody_state==="outbound").length,1);
  assert.equal(items.filter((x:{custody_state:string})=>x.custody_state==="stored").length,32);
  await pool.query("update orders set state='closed',closed_at=now() where id=$1",[draft.id]);
  const closedBefore=await c.fetch(path);
  const secondAmend=await reviewer.fetch(amendPath,{base_version:2,reason:"Clarified the published measurement explanation."});
  const secondPath="/staff/reports/"+secondAmend.id;
  const secondSaved=await reviewer.fetch(secondPath,{revision:1,changes:[{
    section:0,result:0,status:"NOT_TESTED",typed_value:null,reason:"Measurement was outside the commissioned scope.",
  }]},"PATCH");
  const secondSubmitted=await reviewer.fetch(secondPath+"/submit-revision",{revision:secondSaved.revision});
  const reportAdmin=await staffLogin("admin");
  await reportAdmin.fetch("/media/"+mediaId);
  await reportAdmin.fetch(secondPath+"/approve",{revision:secondSubmitted.revision,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  const closedAfter=await c.fetch(path);
  assert.equal((await c.fetch(path+"/report")).version,3);
  const reportUpdates=(await c.fetch("/me/notifications")).rows.filter((n:{order_number:string;report_version:number})=>
    n.order_number===draft.public_no&&n.report_version);
  assert.deepEqual(reportUpdates.map((n:{report_version:number})=>n.report_version),[3,2,1]);
  assert.equal(closedAfter.state,"closed");
  assert.equal(closedAfter.revision,closedBefore.revision);
  assert.equal((await c.fetch("/me/items")).items.find((i:{item_id:string})=>i.item_id===itemId).custody_state,"outbound");

  const retained=itemIds[4],missingReturn=itemIds[5];
  const previous=(await c.fetch("/me/desk")).items.find((item:{item_id:string})=>item.item_id===retained);
  await c.fetch("/me/items/"+missingReturn+"/dispositions",returnIntent,"POST",422);
  const selected=itemIds.slice(1,4);
  const destination={recipient:"Forwarder",phone:"00000000000",address:"Fixture address",member_code:"TEST-FORWARDER"};
  const instructions=await Promise.all(selected.map(item=>c.fetch("/me/items/"+item+"/dispositions",{
    action:"to_forwarder",terms_version_id:termsVersion,destination,
  },"POST",201)));
  const batch=await c.fetch("/dispatch-batches",{disposition_ids:instructions.map(i=>i.id)},"POST",201);
  const confirmed=await c.fetch("/dispatch-batches/"+batch.batch_id+"/confirm",{revision:batch.revision});
  const batchPath="/staff/dispatch-batches/"+batch.batch_id;
  const parcels=[{item_ids:[selected[0],selected[2]],weight_g:620},{item_ids:[selected[1]],weight_g:380}];
  const quoteBody={revision:confirmed.revision,rate_version_id:desk.rates[0].id,parcels};
  await staff.fetch(batchPath+"/quote",{...quoteBody,parcels:[parcels[0],{...parcels[1],item_ids:[selected[0]]}]},"POST",409);
  const originalQuote=await staff.fetch(batchPath+"/quote",quoteBody);
  await staff.fetch(batchPath+"/quote",{...quoteBody,revision:originalQuote.revision},"POST",409);
  await pool.query("update dispatch_quote_versions set expires_at=now()-interval '1 minute' where id=$1",[originalQuote.quote_id]);
  const expiredQuote=await c.fetch(path+"/quotes/"+originalQuote.quote_id);
  assert.equal(expiredQuote.state,"expired");
  await c.fetch("/quotes/"+originalQuote.quote_id+"/accept",{revision:originalQuote.revision},"POST",409);
  const splitQuote=await staff.fetch(batchPath+"/quote",{...quoteBody,revision:originalQuote.revision});
  assert.equal(splitQuote.revision,originalQuote.revision+1);
  const scopedQuote=path+"/quotes/"+splitQuote.quote_id;
  assert.equal((await c.fetch(scopedQuote)).state,"open");
  await c.fetch("/orders/"+separate.id+"/quotes/"+splitQuote.quote_id,undefined,"GET",404);
  await other.fetch(scopedQuote,undefined,"GET",404);
  const savedQuote=(await c.fetch("/me/desk")).quotes.find((q:{id:string})=>q.id===splitQuote.quote_id);
  assert.equal(savedQuote.snapshot.destination.member_code,destination.member_code);
  assert.deepEqual(savedQuote.snapshot.parcels.map(({amount_cents,...parcel}:{amount_cents:number})=>{
    assert(amount_cents>0);return parcel;
  }),parcels);
  assert.equal(savedQuote.snapshot.parcels.reduce((sum:number,p:{amount_cents:number})=>sum+p.amount_cents,savedQuote.snapshot.handling_cents),splitQuote.amount_cents);
  assert.deepEqual(Object.keys(savedQuote.item_codes).sort(),selected.slice().sort());
  assert((await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===splitQuote.quote_id));
  assert(!(await other.fetch("/me/desk")).quotes.some((q:{id:string})=>q.id===splitQuote.quote_id));
  const charge=await c.fetch("/quotes/"+splitQuote.quote_id+"/accept",{revision:splitQuote.revision});
  assert(!(await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===splitQuote.quote_id));
  assert((await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===charge.charge_item_id));
  const checkout=await c.fetch("/charges/"+charge.charge_item_id+"/checkout",{quote_revision:splitQuote.revision});
  await c.fetch("/checkout/demo/"+checkout.attempt_id,{});
  assert.equal((await c.fetch(scopedQuote)).state,"paid");
  assert(!(await c.fetch("/actions")).rows.some((action:{id:string})=>action.id===charge.charge_item_id));
  const shipments=[];
  for(const parcel of parcels) {
    shipments.push(await staff.fetch(batchPath+"/parcels",{...parcel,revision:splitQuote.revision+1,quote_id:splitQuote.quote_id,
      packed_media_ids:[await staff.photo("dispatch")]},"POST",201));
  }
  const work=(await staff.fetch("/staff/desk")).batches.find((b:{id:string})=>b.id===batch.batch_id);
  assert.deepEqual(work.packed_item_ids.sort(),selected.slice().sort());
  const outboundWaybills=new Set<string>();
  for(const [index,packed] of shipments.entries()) {
    const tracking="YTO"+randomUUID().slice(0,8).toUpperCase();
    await staff.fetch("/staff/shipments/"+packed.shipment_id+"/handover",{revision:packed.revision,item_ids:parcels[index].item_ids,
      carrier_code:"yto",tracking_no:tracking,evidence_ids:[await staff.photo("dispatch")],handed_at:new Date().toISOString()});
    const record=await c.fetch("/shipments/"+packed.shipment_id+"/tracking");
    assert.equal(record.direction,"outbound_forward");
    assert.equal(record.tracking_no,tracking);
    outboundWaybills.add(record.tracking_no);
    const details=await c.fetch(path+"/shipments/"+packed.shipment_id);
    assert.equal(details.tracking_norm,tracking);
    assert.equal(details.weight_g,parcels[index].weight_g);
    assert.equal(details.items.length,parcels[index].item_ids.length);
    await c.fetch("/orders/"+separate.id+"/shipments/"+packed.shipment_id,undefined,"GET",404);
    await other.fetch(path+"/shipments/"+packed.shipment_id,undefined,"GET",404);
  }
  assert.equal(outboundWaybills.size,2);
  const retention=await c.fetch("/me/items/"+retained+"/dispositions",{action:"retain",terms_version_id:termsVersion},"POST",201);
  const storage=await staff.fetch("/staff/dispositions/"+retention.id+"/storage-quote",{});
  const storageQuote=(await c.fetch("/me/desk")).quotes.find((q:{id:string})=>q.id===storage.quote_id);
  assert.equal(storageQuote.snapshot.days,30);
  assert.equal((await c.fetch(path+"/quotes/"+storage.quote_id)).purpose,"storage");
  assert.deepEqual(Object.keys(storageQuote.item_codes),[retained]);
  const storageFee=await c.fetch("/quotes/"+storage.quote_id+"/accept",{revision:storage.revision});
  const storageCheckout=await c.fetch("/charges/"+storageFee.charge_item_id+"/checkout",{quote_revision:storage.revision});
  await c.fetch("/checkout/demo/"+storageCheckout.attempt_id,{});
  await c.fetch("/checkout/demo/"+storageCheckout.attempt_id,{});
  const inventory=(await c.fetch("/me/desk")).items;
  const retainedNow=inventory.find((item:{item_id:string})=>item.item_id===retained);
  assert.equal(retainedNow.custody_state,"stored");
  const previousDeadline=previous.storage_until?Date.parse(previous.storage_until):0;
  assert(Date.parse(retainedNow.storage_until)>Math.max(previousDeadline,Date.now()));
  assert.equal(inventory.find((item:{item_id:string})=>item.item_id===missingReturn).custody_state,"stored");
  const storedDetail=(await c.fetch(path)).items.find((item:{item_id:string})=>item.item_id===retained);
  assert.equal(storedDetail.paid_storage_until,retainedNow.storage_until);
  assert.equal(storedDetail.instruction,null);
  assert.equal((await pool.query("select 1 from storage_periods where charge_id=$1",[storageFee.charge_item_id])).rowCount,1);
});

test("unmatched intake remains private until a staff evidence decision",async()=>{
  const {c}=await signCustomer(),another=(await signCustomer()).c;
  const staff=await staffLogin("receiving"),support=await staffLogin("admin");
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const outer=await staff.photo("intake_outer");
  const pkg=await staff.fetch("/staff/intake/check-in",{tracking_no:tracking,carrier_code:"zto",outer_media_ids:[outer]},"POST",201);
  assert.equal(pkg.state,"unmatched");
  const desk=await staff.fetch("/staff/desk");
  const quarantine=desk.locations.find((location:{code:string})=>location.code==="Q-01");
  const saved=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:[{code:"S-"+randomUUID(),location_id:quarantine.id}]},"POST",201);
  async function claim(client:Client) {
    const photo=await sharp({create:{width:100,height:80,channels:3,background:"#11736d"}}).png().toBuffer();
    const form=new FormData();
    form.set("photo",new Blob([new Uint8Array(photo)],{type:"image/png"}),"seller.png");
    form.set("tracking_no",tracking);form.set("carrier_code","zto");
    return client.fetch("/me/intake-claims",form,"POST",201);
  }
  const application=await claim(c),competing=await claim(another);
  assert.notEqual(competing.public_no,application.public_no);
  assert.equal((await c.fetch("/me/items")).items.length,0);
  await c.fetch("/media/"+outer,undefined,"GET",404);
  const queue=(await support.fetch("/staff/admin/desk")).claims;
  const target=queue.find((x:{public_no:string})=>x.public_no===application.public_no);
  assert.deepEqual(target.outer_photo_ids,[outer]);
  const other=queue.find((x:{public_no:string})=>x.public_no===competing.public_no);
  const decision={decision:"approve",reason:"Seller proof and physical label were verified."};
  await staff.fetch("/staff/intake-claims/"+target.id+"/decision",decision,"POST",403);
  await support.fetch("/staff/intake-claims/"+target.id+"/decision",decision);
  await support.fetch("/staff/intake-claims/"+other.id+"/decision",decision,"POST",409);
  assert.equal((await c.fetch("/me/items")).items[0].item_id,saved.item_ids[0]);
  assert.equal((await another.fetch("/me/items")).items.length,0);
  const advices=(await c.fetch("/me/desk")).advices;
  assert.equal(advices[0].tracking_norm,tracking);
  await another.fetch("/me/parcels/"+advices[0].id+"/tracking",undefined,"GET",404);
});

test("tracking verification and signed Chinese carrier delivery stay separate from physical receipt",async()=>{
  const {c,registration}=await signCustomer(),another=(await signCustomer()).c;
  const tracking="SF"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,tracking_no:tracking},"POST",201);
  const path="/me/parcels/"+advice.id;
  const {revision}=await c.fetch(path+"/tracking-verification");
  assert.deepEqual((await c.fetch(path+"/tracking")).allowed_actions,["verify_tracking"]);
  await another.fetch(path+"/tracking-verification",undefined,"GET",404);
  await c.fetch(path+"/tracking-verification",{revision,carrier_code:"sf"},"POST",422);
  const phone="13800000000";
  await c.fetch(path+"/tracking-verification",{revision,carrier_code:"sf",phone});
  const t=(await c.fetch(path+"/tracking")).tracking_id;
  const secret=(await pool.query("select source_phone_ciphertext from tracking_records where id=$1",[t])).rows[0].source_phone_ciphertext;
  assert(!secret.includes(Buffer.from(phone)));
  assert.equal(decryptSecret(secret),phone);
  const token=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
  await pool.query(`insert into tracking_subscriptions(tracker_id,provider,callback_token,salt_ciphertext,credential_version,status)
    values($1,'kuaidi100',$2,$3,'test','active')`,[t,token,encryptSecret(salt)]);
  const callback="/webhooks/tracking/kuaidi100/"+token;
  const param=JSON.stringify({lastResult:{com:"shunfeng",nu:tracking,state:"3",data:[{context:"快件已签收",ftime:"2026-10-30 15:03:00"}]}});
  const signature=createHash("md5").update(param+salt).digest("hex").toUpperCase();
  function notifyProvider(sign:string) {
    return handle(new Request(origin+"/api/v1"+callback,{method:"POST",body:new URLSearchParams({sign,param})}),callback);
  }
  assert.equal((await notifyProvider("0".repeat(32))).status,400);
  assert.equal((await notifyProvider(signature)).status,200);
  assert.equal((await notifyProvider(signature)).status,200);
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  const english=await c.fetch(path+"/tracking?locale=en");
  assert.equal(english.transport_state,"delivered");
  assert.equal(english.warehouse_state,null);
  assert.deepEqual(english.events,[]);
  const staff=await staffLogin("receiving");
  const chinese=(await staff.fetch("/staff/tracking")).rows.find((row:{id:string})=>row.id===t);
  assert.equal(chinese.events[0].text,"快件已签收");
  assert.equal((await c.fetch("/me/items")).items.length,0);
});

test("staff quote is versioned, private and can activate 101 positions with explicit zero-charge authorization",async()=>{
  const {c,terms}=await signCustomer(),another=(await signCustomer()).c;
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const line={category_id:offer.category_id,offer_id:offer.offer_id,quantity:100};
  const original=await c.fetch("/orders",{lines:[line]},"POST",201);
  const path="/orders/"+original.id;
  const draft=await c.fetch(path,{revision:original.revision,lines:[{...line,quantity:101}]},"PATCH");
  await c.fetch(path,{revision:original.revision,lines:[line]},"PATCH",409);
  await c.fetch(path+"/quotes",{revision:draft.revision},"POST",422);
  await c.fetch(path+"/manual-quote-request",{revision:draft.revision,reason:"101 units require a custom quote."});
  await another.fetch(path+"/manual-quote-request",{revision:draft.revision,reason:"Unauthorized."},"POST",404);
  const admin=await staffLogin("admin");
  const entry=(await admin.fetch("/staff/admin/desk")).manualQuotes.find((q:{order_id:string})=>q.order_id===draft.id);
  const termsIds=terms.map((t:{id:string})=>t.id);
  const input={revision:draft.revision,reason:"Approved local zero-charge fixture",expires_at:new Date(Date.now()+3600000).toISOString(),
    terms_version_ids:termsIds,lines:[{order_line_id:entry.lines[0].id,amount_cents:0,business_days:5}]};
  const staffPath="/staff/orders/"+draft.id+"/quotes";
  await (await staffLogin("receiving")).fetch(staffPath,input,"POST",403);
  const previous=await admin.fetch(staffPath,input,"POST",201);
  const current=await admin.fetch(staffPath,input,"POST",201);
  assert.notEqual(previous.id,current.id);
  assert.equal((await c.fetch(path)).manual_quote.id,current.id);
  const acknowledgements={scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true};
  const body={revision:draft.revision,terms_version_ids:termsIds,acknowledgements};
  await c.fetch(path+"/submit",{...body,quote_id:previous.id},"POST",404);
  const result=await c.fetch(path+"/submit",{...body,quote_id:current.id});
  assert.equal(result.order.state,"awaiting_samples");
  const chargeId=result.charge.charge_item_id;
  const paid=await c.fetch("/charges/"+chargeId+"/checkout",{quote_revision:current.revision});
  assert.equal(paid.state,"paid");
  assert.equal((await c.fetch(path)).items.length,101);
  const {rows:[count]}=await pool.query("select count(*)::int n from payments where charge_item_id=$1",[chargeId]);
  assert.equal(count.n,0);
});

function setFixtureEnv(t:import("node:test").TestContext,values:Record<string,string|undefined>) {
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  function apply(env:Record<string,string|undefined>) {
    for(const [key,value] of Object.entries(env)) {
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
  }
  t.after(()=>apply(previous));
  apply(values);
}
function providerGet(path:string,query="",cookies="") {
  return handle(new Request(origin+"/api/v1"+path+query,{headers:{cookie:cookies}}),path);
}

test("Google and Microsoft authorization requests use PKCE and reject mismatched or replayed callbacks",async t=>{
  setFixtureEnv(t,{GOOGLE_CLIENT_ID:"google-fixture",GOOGLE_CLIENT_SECRET:"google-secret-fixture",
    MICROSOFT_CLIENT_ID:"microsoft-fixture",MICROSOFT_CLIENT_SECRET:"microsoft-secret-fixture"});
  const personal="https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0";
  const discovery=new Map([
    ["https://accounts.google.com/.well-known/openid-configuration",["https://accounts.google.com","https://accounts.google.com/o/oauth2/v2/auth"]],
    ["https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration",[personal,"https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"]],
  ]);
  const fetch=t.mock.method(globalThis,"fetch",async (input:URL|string)=>{
    const cfg=discovery.get(String(input));
    assert(cfg,"Only fixture discovery is expected");
    return Response.json({issuer:cfg[0],authorization_endpoint:cfg[1],token_endpoint:cfg[1]+"/fixture-token",response_types_supported:["code"]});
  });
  for(const provider of ["google","microsoft"]) {
    const base="/auth/"+provider;
    const next=provider==="google"?"/orders/new?offer=fixture#scope":"//external.example/path";
    const start=await providerGet(base+"/start","?"+new URLSearchParams({next}));
    assert.equal(start.status,303);
    const auth=new URL(start.headers.get("location")!);
    assert.equal(auth.searchParams.get("redirect_uri"),origin+"/api/v1"+base+"/callback");
    assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
    assert(auth.searchParams.get("nonce") && auth.searchParams.get("code_challenge"));
    const state=auth.searchParams.get("state")!;
    const browser=start.headers.getSetCookie().find(x=>x.startsWith("qcw_browser="))!.split(";")[0];
    const query="?error=access_denied&state="+encodeURIComponent(state);
    assert.equal((await providerGet(base+"/callback",query,"qcw_browser=wrong")).headers.get("location"),"/login?oauth=failed");
    const cancelled=new URL((await providerGet(base+"/callback",query+"&next=%2Faccount",browser)).headers.get("location")!,origin);
    assert.equal(cancelled.pathname,"/login");
    assert.equal(cancelled.searchParams.get("oauth"),"cancelled");
    assert.equal(cancelled.searchParams.get("next"),provider==="google"?next:null);
    assert.equal((await providerGet(base+"/callback",query,browser)).headers.get("location"),"/login?oauth=failed");
  }
  assert.equal(fetch.mock.callCount(),2);
  const invalid=await handle(new Request(origin+"/api/v1/auth/otp/request",{
    method:"POST",headers:{origin,cookie:"qcw_provider=invalid"},body:JSON.stringify({email:"fixture@qcw.test"})
  }),"/auth/otp/request");
  assert.equal(invalid.status,400);
  assert(invalid.headers.getSetCookie().some(cookie=>cookie.startsWith("qcw_provider=;")&&cookie.includes("Max-Age=0")));
});

test("Postmark requires an accepted message response and never returns the real OTP in JSON",async t=>{
  setFixtureEnv(t,{QCW_DEMO:"0",POSTMARK_SERVER_TOKEN:"server-token-fixture",
    EMAIL_FROM:"sender@example.test",POSTMARK_MESSAGE_STREAM:"verification"});
  const email=randomUUID()+"@example.test";
  let code="",accepted=false;
  const fetch=t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    assert.equal(url,"https://api.postmarkapp.com/email");
    assert.equal(new Headers(init.headers).get("X-Postmark-Server-Token"),"server-token-fixture");
    const payload=JSON.parse(init.body as string);
    assert.equal(payload.To,email);
    assert.equal(payload.MessageStream,"verification");
    code=payload.TextBody.match(/\d{6}/)[0];
    return Response.json(accepted?{ErrorCode:0,MessageID:"fixture-message"}:{ErrorCode:10,Message:"fixture rejection"});
  });
  const c=new Client();
  await c.fetch("/auth/otp/request",{email},"POST",503);
  const record=(await pool.query("select consumed_at from verification_challenges where target_email=$1",[email])).rows[0];
  assert(record.consumed_at);
  accepted=true;
  const otp=await c.fetch("/auth/otp/request",{email},"POST",202);
  assert(!("demo_code" in otp));
  assert.equal((await c.fetch("/auth/otp/verify",{challenge_id:otp.challenge_id,code})).state,"onboarding");
  process.env.POSTMARK_SERVER_TOKEN="POSTMARK_API_TEST";
  await c.fetch("/auth/otp/request",{email},"POST",503);
  assert.equal(fetch.mock.callCount(),2);
});

test("Stripe webhook enforces signature and mode before deduplicating and applying a payment",async t=>{
  const {c,terms}=await signCustomer();
  const {actor}=await c.fetch("/me");
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const draft=await c.fetch("/orders",{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}]},"POST",201);
  const path="/orders/"+draft.id;
  const quote=await c.fetch(path+"/quotes",{revision:draft.revision},"POST",201);
  const acknowledgements={scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true};
  const submission=await c.fetch(path+"/submit",{revision:draft.revision,quote_id:quote.id,
    terms_version_ids:terms.map((x:{id:string})=>x.id),acknowledgements});
  const chargeId=submission.charge.charge_item_id;
  const chargePath="/charges/"+chargeId+"/checkout";
  const {attempt_id}=await c.fetch(chargePath,{quote_revision:quote.revision});
  setFixtureEnv(t,{QCW_DEMO:"0",STRIPE_SECRET_KEY:"sk_test_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture"});
  const webhookPath="/webhooks/stripe";
  const eventId="evt_fixture_"+randomUUID();
  const event={id:eventId,object:"event",livemode:false,type:"checkout.session.completed",
    data:{object:{id:"cs_test_"+randomUUID(),payment_status:"paid",amount_total:quote.amount_cents,currency:"usd",
      payment_intent:"pi_fixture_"+randomUUID(),metadata:{payment_id:attempt_id,charge_item_id:chargeId,org_id:actor.org}}}};
  function send(payload:object,valid=true) {
    const body=JSON.stringify(payload);
    const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:valid?"whsec_fixture":"whsec_wrong"});
    return handle(new Request(origin+"/api/v1"+webhookPath,{method:"POST",headers:{"stripe-signature":signature},body}),webhookPath);
  }
  assert.equal((await send(event,false)).status,401);
  assert.equal((await send({...event,livemode:true})).status,400);
  assert.equal((await send({...event,id:eventId+"_other",type:"checkout.session.unsupported_fixture"})).status,200);
  assert.equal((await c.fetch(path)).state,"awaiting_payment");
  assert.equal((await send(event)).status,200);
  assert.equal((await send(event)).status,200);
  const order=await c.fetch(path);
  assert.equal(order.state,"awaiting_samples");
  assert.equal(order.items.length,1);
  const result=await pool.query("select id from payment_events where event_id=$1",[eventId]);
  assert.equal(result.rowCount,1);
});

test("Kuaidi100 query stores English events and distinguishes provider rate limits from phone verification",async t=>{
  const {c,registration}=await signCustomer();
  async function fixtureTracking(date:string) {
    const tracking="SF"+randomUUID().slice(0,8).toUpperCase();
    const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,tracking_no:tracking,carrier_code:"sf"},"POST",201);
    const path="/me/parcels/"+advice.id+"/tracking";
    const id=(await c.fetch(path)).tracking_id;
    await pool.query("update tracking_records set next_query_at=$2 where id=$1",[id,date]);
    return {tracking,path,id};
  }
  const ok=await fixtureTracking("1999-12-31");
  const limited=await fixtureTracking("2000-01-01");
  const closedDuringQuery=await fixtureTracking("2000-01-02");
  setFixtureEnv(t,{QCW_DEMO:"0",KUAIDI100_KEY:"key-fixture",KUAIDI100_CUSTOMER:"customer-fixture",
    TRACKING_CALLBACK_BASE_URL:"https://callbacks.example.test"});
  const config=await (await staffLogin("admin")).fetch("/staff/admin/tracking/health");
  assert.equal(config.check,"local_configuration_only");
  assert.equal(config.queryConfigured,true);
  assert(!JSON.stringify(config).includes("key-fixture"));
  assert(!JSON.stringify(config).includes("customer-fixture"));
  await c.fetch("/staff/admin/tracking/health",undefined,"GET",403);
  const receiving=await staffLogin("receiving"),templateAdmin=await staffLogin("inspector");
  await receiving.fetch("/staff/tracking");
  await receiving.fetch("/staff/admin/tracking/health",undefined,"GET",403);
  await receiving.fetch("/staff/admin/desk",undefined,"GET",403);
  const templateDesk=await templateAdmin.fetch("/staff/admin/desk");
  assert(templateDesk.templates.length>0);
  for(const key of ["orders","tickets","payments","refunds","addresses","jobErrors"]) assert.deepEqual(templateDesk[key],[]);
  const fetch=t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    assert.equal(url,"https://poll.kuaidi100.com/poll/query.do");
    const form=init.body as URLSearchParams;
    const param=form.get("param")!;
    const query=JSON.parse(param);
    assert([ok.tracking,limited.tracking,closedDuringQuery.tracking].includes(query.num));
    assert.equal(query.lang,"en");
    assert(query.phone);
    assert.equal(form.get("sign"),createHash("md5").update(param+"key-fixturecustomer-fixture").digest("hex").toUpperCase());
    if(query.num===closedDuringQuery.tracking) {
      await pool.query("update tracking_records set closed_at=now(),sync_state='superseded' where id=$1",[closedDuringQuery.id]);
    }
    if(query.num!==limited.tracking) return Response.json({status:"200",state:"3",com:"shunfeng",nu:query.num,
      data:[{context:"Delivered to receiving desk",ftime:"2026-11-04 15:03:00",status:"Delivered",statusCode:"301"}]});
    return Response.json({result:false,returnCode:"504",message:"Fixture rate limit"});
  });
  assert.equal(await syncTrackingOnce(),true);
  assert.equal(await syncTrackingOnce(),true);
  assert.equal(await syncTrackingOnce(),true);
  assert.equal(fetch.mock.callCount(),3);
  const english=await c.fetch(ok.path);
  assert.equal(english.events[0].text,"Delivered to receiving desk");
  assert.equal(english.events[0].status_code,"301");
  assert.equal(english.warehouse_state,null);
  const snapshot=await c.fetch(limited.path);
  assert.equal(snapshot.sync_state,"delayed");
  assert.deepEqual(snapshot.allowed_actions,[]);
  assert(Date.parse(snapshot.next_allowed_at)>Date.now()+23*60*60*1000);
  const result=await pool.query("select outcome from tracking_query_attempts where tracking_norm=$1",[limited.tracking]);
  assert.equal(result.rows[0].outcome,"rate_limited");
  const discarded=await pool.query("select outcome from tracking_query_attempts where tracking_norm=$1",[closedDuringQuery.tracking]);
  assert.equal(discarded.rows[0].outcome,"superseded");
  assert.equal((await pool.query("select 1 from tracking_snapshots where tracker_id=$1",[closedDuringQuery.id])).rowCount,0);
});

test("parallel registration issues one profile, consent set and event even without a default warehouse",async()=>{
  const {rows:[address]}=await pool.query("update warehouse_addresses set is_default=false where is_default and active returning id");
  assert(address);
  try {
    const email=randomUUID()+"@qcw.test";
    const first=new Client(),second=new Client();
    const proof=await Promise.all([first.login(email),second.login(email)]);
    assert(proof.every(result=>result.state==="onboarding"));
    const {terms}=await first.fetch("/public/terms");
    const registrationPath="/auth/registration/complete";
    const consent={terms_version_ids:terms.filter((term:{kind:string})=>["terms","privacy"].includes(term.kind)).map((term:{id:string})=>term.id)};
    await new Client().fetch(registrationPath,consent,"POST",404);
    await first.fetch(registrationPath,{terms_version_ids:[randomUUID()]},"POST",409);
    const results=await Promise.all([first.fetch(registrationPath,consent),first.fetch(registrationPath,consent),second.fetch(registrationPath,consent)]);
    assert.deepEqual(results,[results[0],results[0],results[0]]);
    const profile=results[0];
    assert.equal(profile.warehouse_address_status,"pending");
    assert.equal(profile.warehouse_address,null);
    const {rows:[counts]}=await pool.query(`select
      (select count(*)::int from user_emails where normalized_email=$1) as emails,
      (select count(*)::int from memberships where user_id=$2) as memberships,
      (select count(*)::int from account_consents where user_id=$2) as consents,
      (select count(*)::int from outbox_events where type='account.registered' and payload->>'org_id'=$3) as events`,[email,profile.user_id,profile.org_id]);
    assert.deepEqual(counts,{emails:1,memberships:1,consents:2,events:1});
    for(let i=0;i<100;i++){if(!await workOnce())break;}
    const admin=await staffLogin("admin");
    assert.equal((await admin.fetch("/staff/admin/desk")).warehouseAddressAlert,true);
    assert.equal((await first.fetch("/me/receiving-address")).receiving_code,profile.receiving_code);
    const {rows:[identity]}=await pool.query("select subject,email_id from auth_identities where user_id=$1 and provider='email_otp'",[profile.user_id]);
    assert.equal(identity.subject,identity.email_id);
    assert.notEqual(identity.subject,email);
  } finally {
    await pool.query("update warehouse_addresses set is_default=true where id=$1",[address.id]);
  }
  assert.equal((await (await staffLogin("admin")).fetch("/staff/admin/desk")).warehouseAddressAlert,false);
});

test("another provider claiming a verified email does not attach or reuse its OTP proof",async()=>{
  const {email,registration}=await signCustomer();
  const stranger=new Client();
  const otp=await stranger.fetch("/auth/otp/request",{email},"POST",202);
  // Simulate the verified provider payload already bound to this OTP by the callback.
  await pool.query("update verification_challenges set verified_identity=$2 where id=$1",[
    otp.challenge_id,{provider:"microsoft",issuer:"https://fixture.example.test",subject:randomUUID(),email}
  ]);
  const body={challenge_id:otp.challenge_id,code:otp.demo_code};
  const rejected=await stranger.fetch("/auth/otp/verify",body,"POST",409);
  assert.equal(rejected.error.code,"IDENTITY_LINK_REQUIRED");
  await stranger.fetch("/auth/otp/verify",body,"POST",400);
  await stranger.fetch("/me",undefined,"GET",401);
  const {rowCount}=await pool.query("select 1 from auth_identities where user_id=$1 and provider='microsoft'",[registration.user_id]);
  assert.equal(rowCount,0);
});

test("an inbound waybill matches the intended carrier and does not leak another organization's parcel",async()=>{
  const first=await signCustomer(),second=await signCustomer();
  const staff=await staffLogin("receiving");
  const tracking="00"+randomUUID().slice(0,8).toUpperCase();
  const body={address_id:first.registration.warehouse_address.id,tracking_no:tracking};
  const one=await first.c.fetch("/me/parcels",{...body,carrier_code:"zto"},"POST",201);
  const two=await second.c.fetch("/me/parcels",{...body,carrier_code:"yto"},"POST",201);
  assert.notEqual(one.id,two.id);
  for(const client of [first.c,second.c]) {
    const conflict=await client.fetch("/me/parcels",body,"POST",409);
    assert.deepEqual(conflict.error,{code:"TRACKING_REVIEW_REQUIRED",message:"This tracking number requires staff verification."});
  }
  await second.c.fetch("/me/parcels",{...body,carrier_code:"zto"},"POST",409);
  await second.c.fetch("/me/parcels/"+one.id+"/tracking",undefined,"GET",404);
  const scan=await staff.fetch("/staff/intake/lookup",{tracking_no:tracking});
  assert.deepEqual(scan,{match_state:"ambiguous",order_ids:[],candidate_count:2});
  const offer=(await first.c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const draft=await first.c.fetch("/orders",{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}]},"POST",201);
  const linked=await first.c.fetch("/me/parcels",{...body,carrier_code:"zto",order_ids:[draft.id]},"POST",201);
  assert.equal(linked.id,one.id);
  const exact=await staff.fetch("/staff/intake/lookup",{tracking_no:tracking,carrier_code:"zto"});
  assert.equal(exact.receiving_code,first.registration.receiving_code);
  assert.deepEqual(exact.order_ids,[draft.id]);
  const record=(await first.c.fetch("/me/parcels/"+one.id+"/tracking")).tracking_id;
  await assert.rejects(pool.query("update tracking_records set org_id=$2 where id=$1",[record,second.registration.org_id]),
    {code:"23503"});
  await assert.rejects(pool.query(`insert into tracking_records(org_id,direction,advice_id,carrier_code,tracking_norm,generation,transport_state,sync_state)
    values($1,'inbound',$2,'zto',$3,2,'unknown','pending')`,[first.registration.org_id,one.id,tracking+"ALT"]),{code:"23505"});
});

test("an unclaimed warehouse parcel has one tracker and cannot be exposed by preadvice alone",async()=>{
  const {c,registration}=await signCustomer(),staff=await staffLogin("receiving");
  const tracking="YTO"+randomUUID().slice(0,8).toUpperCase();
  const request={tracking_no:tracking,carrier_code:"yto",outer_media_ids:[await staff.photo("intake_outer")]};
  const scans=await Promise.all([
    staff.fetch("/staff/intake/check-in",request,"POST",201),staff.fetch("/staff/intake/check-in",request,"POST",201)
  ]);
  assert.equal(scans[0].id,scans[1].id);
  const conflict=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,tracking_no:tracking},"POST",409);
  assert.equal(conflict.error.code,"TRACKING_REVIEW_REQUIRED");
  const {rows:[tracker]}=await pool.query("select id,org_id,next_query_at from tracking_records where package_id=$1",[scans[0].id]);
  assert.equal(tracker.org_id,null);
  assert(tracker.next_query_at);
  await assert.rejects(pool.query("update tracking_records set org_id=$2 where id=$1",[tracker.id,registration.org_id]),
    {code:"23503"});
  assert.equal((await c.fetch("/me/desk")).advices.length,0);
});

test("a verified callback for a closed tracking instance cannot change its replacement or inventory",async()=>{
  const {c,registration}=await signCustomer();
  const tracking="YT"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,tracking_no:tracking,carrier_code:"yto"},"POST",201);
  const path="/me/parcels/"+advice.id+"/tracking";
  const old=(await c.fetch(path)).tracking_id;
  const token=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
  const {rows:[subscription]}=await pool.query(`insert into tracking_subscriptions(tracker_id,provider,callback_token,salt_ciphertext,credential_version,status)
    values($1,'kuaidi100',$2,$3,'test','active') returning id`,[old,token,encryptSecret(salt)]);
  const {transaction}=await import("../packages/db");
  const replacement=await transaction(async db=>{
    await db.query("update tracking_records set closed_at=now(),sync_state='superseded' where id=$1",[old]);
    return (await db.query(`insert into tracking_records(org_id,direction,advice_id,carrier_code,tracking_norm,generation,supersedes_id,transport_state,sync_state)
      values($1,'inbound',$2,'yto',$3,2,$4,'unknown','pending') returning id`,[registration.org_id,advice.id,tracking+"NEW",old])).rows[0].id;
  });
  const callback="/webhooks/tracking/kuaidi100/"+token;
  const param=JSON.stringify({status:"abort",lastResult:{com:"yuantong",nu:tracking,state:"3",
    data:[{context:"旧单签收",ftime:"2026-11-04 12:00:00"}]}});
  const sign=createHash("md5").update(param+salt).digest("hex").toUpperCase();
  const response=await handle(new Request(origin+"/api/v1"+callback,{method:"POST",body:new URLSearchParams({sign,param})}),callback);
  assert.equal(response.status,200);
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  const snapshot=await c.fetch(path);
  assert.equal(snapshot.tracking_id,replacement);
  assert.equal(snapshot.transport_state,"unknown");
  assert.equal(snapshot.sync_state,"pending");
  assert.equal(snapshot.warehouse_state,null);
  assert.equal((await pool.query("select 1 from tracking_snapshots where tracker_id=any($1::uuid[])",[[old,replacement]])).rowCount,0);
  assert.equal((await pool.query("select sync_state from tracking_records where id=$1",[old])).rows[0].sync_state,"superseded");
  assert((await pool.query("select processed_at from tracking_inbox where subscription_id=$1",[subscription.id])).rows[0].processed_at);
});

test("a paid scope revision and independently approved refund remain isolated and visible in billing",async()=>{
  const {c,terms}=await signCustomer(),another=(await signCustomer()).c;
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const {draft,submitted,pay}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:3}],terms);
  const path="/orders/"+draft.id;
  const original=await c.fetch(path);
  const scopeBody={revision:original.revision,reason:"One seller item will not arrive.",positions:original.items.slice(0,2).map((p:{id:string})=>p.id)};
  const admin=await staffLogin("admin"),support=await staffLogin("reviewer");
  const proposed=await c.fetch(path+"/scope-revisions",scopeBody,"POST",201);
  assert.equal(proposed.adjustment_cents,-offer.rules.unit_cents);
  const preview=await c.fetch(path+"/scope-revisions");
  assert.equal(preview.positions.length,3);
  assert.equal(preview.proposals[0].state,"pending");
  assert.deepEqual(preview.proposals[0].proposed_positions,scopeBody.positions);
  await another.fetch(path+"/scope-revisions",undefined,"GET",404);
  await (await staffLogin("receiving")).fetch(path+"/scope-revisions",undefined,"GET",403);
  const staffProposal=await admin.fetch(path+"/scope-revisions",{...scopeBody,reason:"Alternative review for the same order."},"POST",201);
  assert.equal((await admin.fetch(path+"/scope-revisions")).order.public_no,draft.public_no);
  assert((await c.fetch("/actions")).rows.some((row:{id:string;kind:string})=>row.id===proposed.scope_revision_id&&row.kind==="scope"));
  assert(!(await another.fetch("/actions")).rows.some((row:{id:string})=>row.id===proposed.scope_revision_id));
  const scopePath="/scope-revisions/"+proposed.scope_revision_id+"/accept";
  await another.fetch(scopePath,{revision:proposed.revision},"POST",404);
  const key=randomUUID(),scopeAcceptance={revision:proposed.revision};
  await Promise.all([c.fetch(scopePath,scopeAcceptance,"POST",200,key),c.fetch(scopePath,scopeAcceptance,"POST",200,key)]);
  await c.fetch(scopePath,scopeAcceptance,"POST",409);
  assert.equal((await c.fetch(path)).items.length,2);
  const acceptedPreview=await c.fetch(path+"/scope-revisions");
  assert.equal(acceptedPreview.proposals.find((p:{id:string})=>p.id===proposed.scope_revision_id).state,"accepted");
  assert.equal(acceptedPreview.proposals.find((p:{id:string})=>p.id===staffProposal.scope_revision_id).state,"stale");
  assert(acceptedPreview.proposals.find((p:{id:string})=>p.id===proposed.scope_revision_id).refund_case.id);
  assert(!(await c.fetch("/actions")).rows.some((row:{kind:string})=>row.kind==="scope"));
  assert.equal((await pool.query("select price_cents from orders where id=$1",[draft.id])).rows[0].price_cents,3*offer.rules.unit_cents);
  const {rows:[ticket]}=await pool.query("select details from tickets where order_id=$1 and details->>'scope_revision_id'=$2",[draft.id,proposed.scope_revision_id]);
  assert.equal(ticket.details.amount_cents,offer.rules.unit_cents);

  const supportId=(await support.fetch("/me")).actor.id;
  await pool.query("insert into staff_roles(user_id,role) values($1,'support')",[supportId]);
  try {
    const refundBody={amount_cents:offer.rules.unit_cents,reason:"Approved scope adjustment."};
    const refundPath="/staff/orders/"+draft.id+"/refunds";
    const optionsPath="/staff/orders/by-number/"+draft.public_no+"/refund-options";
    const originalPayment=(await support.fetch(optionsPath)).rows[0];
    assert.equal(originalPayment.id,pay.attempt_id);
    assert.equal(originalPayment.refundable_cents,3*offer.rules.unit_cents);
    await c.fetch(optionsPath,undefined,"GET",403);
    await c.fetch(refundPath,{...refundBody,payment_id:pay.attempt_id},"POST",403);
    const refund=await support.fetch(refundPath,{...refundBody,payment_id:pay.attempt_id},"POST",201);
    const otherRefund=await admin.fetch("/staff/payments/"+pay.attempt_id+"/refunds",{amount_cents:1,reason:"Independent review required."},"POST",201);
    await admin.fetch("/staff/refunds/"+otherRefund.refund_id+"/approve",{revision:1},"POST",409);
    const approval="/staff/refunds/"+refund.refund_id+"/approve";
    const receiver=await staffLogin("receiving");
    await receiver.fetch(optionsPath,undefined,"GET",403);
    await receiver.fetch(approval,{revision:1},"POST",403);
    await receiver.fetch("/staff/admin/templates/"+randomUUID()+"/publish",{},"POST",403);
    await support.fetch(approval,{revision:1},"POST",403);
    await pool.query("update sessions set mfa_at=now()-interval '20 minutes' where token_hash=$1",[admin.sessionHash()]);
    const expired=await admin.fetch(approval,{revision:1},"POST",403);
    assert.equal(expired.error.code,"STAFF_REAUTH_REQUIRED");
    assert.equal((await admin.login("admin@qcw.test")).kind,"staff");
    await admin.fetch(approval,{revision:1},"POST",202);
    await admin.fetch(approval,{revision:1},"POST",409);
    const remaining=(await support.fetch(optionsPath)).rows[0].refundable_cents;
    assert.equal(remaining,2*offer.rules.unit_cents);
    await support.fetch(refundPath,{...refundBody,amount_cents:remaining+1,payment_id:pay.attempt_id},"POST",409);
    for(let i=0;i<100;i++){if(!await workOnce())break;}
    const bill=(await c.fetch("/me/billing")).charges.find((x:{charge_item_id:string})=>x.charge_item_id===submitted.charge.charge_item_id);
    assert.equal(bill.refunded_cents,offer.rules.unit_cents);
    assert.deepEqual(bill.order_ids,[draft.id]);
    assert.deepEqual((await another.fetch("/me/billing")).charges,[]);
    const competing=await Promise.all([1,2].map(i=>support.fetch(refundPath,{
      payment_id:pay.attempt_id,amount_cents:remaining,reason:"Competing balance fixture "+i,
    },"POST",201)));
    const approvals=await Promise.allSettled(competing.map(entry=>
      admin.fetch("/staff/refunds/"+entry.refund_id+"/approve",{revision:1},"POST",202)));
    assert.equal(approvals.filter(result=>result.status==="fulfilled").length,1);
    const rejected=approvals.find(result=>result.status==="rejected");
    assert.match(String(rejected?.reason),/REFUND_NOT_ALLOWED/);
    assert.equal((await support.fetch(optionsPath)).rows[0].refundable_cents,0);
  } finally {
    await pool.query("delete from staff_roles where user_id=$1 and role='support'",[supportId]);
  }
});

test("staff order filters preserve precise pagination, dates, email and test boundaries",async()=>{
  const {c,email}=await signCustomer(),admin=await staffLogin("admin"),receiver=await staffLogin("receiving");
  const offer=(await c.fetch("/catalog")).offers.find((row:{service:string})=>row.service==="inspection");
  const drafts=[];
  for(let i=0;i<3;i++)drafts.push(await c.fetch("/orders",{
    lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],
  },"POST",201));
  const ids=drafts.map(row=>row.id);
  await pool.query("update orders set created_at='2026-01-02T23:59:59.123456Z',is_test=false where id=any($1::uuid[])",[ids]);
  await pool.query("update orders set is_test=true where id=$1",[ids[0]]);
  const filter={query:email.toUpperCase(),state:"draft",from:"2026-01-02",to:"2026-01-02",test:"all",limit:"2"};
  const url=(params:Record<string,string>)=>"/staff/orders?"+new URLSearchParams(params);
  const first=await admin.fetch(url(filter));
  assert.equal(first.rows.length,2);
  assert(first.next_cursor);
  assert(!JSON.stringify(first.rows).includes(email));
  const second=await admin.fetch(url({...filter,cursor:first.next_cursor}));
  assert.equal(second.rows.length,1);
  assert.equal(second.next_cursor,null);
  assert.deepEqual([...first.rows,...second.rows].map(row=>row.id),ids.slice().sort().reverse());
  assert.equal((await admin.fetch(url({...filter,test:"test"}))).rows[0].id,ids[0]);
  assert.equal((await admin.fetch(url({...filter,test:"production"}))).rows.length,2);
  assert.deepEqual((await admin.fetch(url({...filter,to:"2026-01-01",from:"2026-01-01"}))).rows,[]);
  assert.deepEqual((await admin.fetch(url({...filter,query:email,state:"closed"}))).rows,[]);
  await c.fetch(url(filter),undefined,"GET",403);
  await receiver.fetch(url(filter),undefined,"GET",403);
  await admin.fetch(url({...filter,state:"invented"}),undefined,"GET",422);
  await admin.fetch(url({...filter,to:"2025-01-01"}),undefined,"GET",422);
  await admin.fetch(url({...filter,limit:"101"}),undefined,"GET",422);
  await admin.fetch(url({...filter,cursor:"garbage"}),undefined,"GET",422);
  const changed=await admin.fetch(url({...filter,test:"test",cursor:first.next_cursor}),undefined,"GET",422);
  assert.equal(changed.error.code,"INVALID_CURSOR");
});

test("location master reserves capacity across organizations and preserves movement history",async()=>{
  const admin=await staffLogin("admin"),staff=await staffLogin("receiving");
  const master="/staff/admin/storage/locations";
  const suffix=Number.parseInt(randomUUID().slice(0,7),16);
  const config={prefix:String.fromCharCode(65+suffix%26),zone:"post_inspection",rack:1+Math.floor(suffix/26)%99,
    level:1+Math.floor(suffix/2574)%99,start:1+Math.floor(suffix/254826)%99,end:1+Math.floor(suffix/254826)%99,capacity:1,notes:"Capacity test"};
  await staff.fetch(master,undefined,"GET",403);
  await staff.fetch(master,config,"POST",403);
  const added=await admin.fetch(master,config);
  const target=added.added[0];
  assert(target);
  assert.deepEqual(await admin.fetch(master,config),{added:[],skipped:[target.code]});
  const origin=(await staff.fetch("/staff/storage")).locations.find((loc:{code:string})=>loc.code==="R-01");
  assert(origin);
  const items=[];
  for(let i=0;i<2;i++) {
    const {c,registration}=await signCustomer();
    const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
    const advice=await c.fetch("/me/parcels",{tracking_no:tracking,carrier_code:"zto",address_id:registration.warehouse_address.id},"POST",201);
    const parcel=await staff.fetch("/staff/intake/check-in",{tracking_no:tracking,carrier_code:"zto",advice_id:advice.id,
      outer_media_ids:[await staff.photo("intake_outer")]},"POST",201);
    const itemCode="S-"+randomUUID();
    const res=await staff.fetch("/staff/packages/"+parcel.id+"/items",{revision:parcel.revision,items:[{code:itemCode,location_id:origin.id}]},"POST",201);
    items.push({id:res.item_ids[0],code:itemCode,parcelId:parcel.id,parcelRevision:res.revision});
  }
  const move="/staff/storage/move";
  const attempts=await Promise.allSettled(items.map(item=>staff.fetch(move,{item_id:item.id,revision:1,location_id:target.id})));
  assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
  const failed=attempts.find(result=>result.status==="rejected");
  assert.match(String(failed?.reason),/LOCATION_FULL/);
  const moved=items[attempts.findIndex(result=>result.status==="fulfilled")];
  const statePath=master+"/"+target.id+"/state";
  await admin.fetch(statePath,{active:false},"POST",409);
  const location=(await admin.fetch(master)).rows.find((row:{id:string})=>row.id===target.id);
  assert.equal(location.occupied,1);
  const event=(await staff.fetch("/staff/storage")).moves.find((row:{code:string})=>row.code===moved.code);
  assert.equal(event.origin,origin.code);
  assert.equal(event.destination,target.code);
  assert(event.operator);
  await staff.fetch(move,{item_id:moved.id,revision:2,location_id:origin.id});
  await admin.fetch(statePath,{active:false});
  const disabled=await staff.fetch("/staff/packages/"+moved.parcelId+"/items",{
    revision:moved.parcelRevision,items:[{code:"S-"+randomUUID(),location_id:target.id}],
  },"POST",409);
  assert.equal(disabled.error.code,"LOCATION_INACTIVE");
  await admin.fetch(statePath,{active:true});
});

test("public inquiries create support work without exposing guest or customer contact details",async()=>{
  const visitor=new Client(),otherVisitor=new Client(),receiver=await staffLogin("receiving"),admin=await staffLogin("admin");
  const {c}=await signCustomer();
  const categories=(await visitor.fetch("/public/inquiry-categories")).categories;
  const category=categories.find((row:{id:string;label:string})=>row.label==="Apparel");
  assert(category);
  const email="inquiry-"+randomUUID()+"@example.test";
  const payload={email,category_id:category.id,sample_count:24,description:"Inspect stitching across the full batch."};
  await visitor.fetch("/public/inquiries",{...payload,description:"x".repeat(1001)},"POST",422);
  await visitor.fetch("/public/inquiries",{...payload,sample_count:1.5},"POST",422);
  await visitor.fetch("/public/inquiries",{...payload,category_id:randomUUID()},"POST",422);
  const key=randomUUID();
  const result=await visitor.fetch("/public/inquiries",payload,"POST",201,key);
  assert.deepEqual(Object.keys(result),["public_no"]);
  assert.deepEqual(await otherVisitor.fetch("/public/inquiries",payload,"POST",201,key),result);
  const conflict=await visitor.fetch("/public/inquiries",{...payload,sample_count:25},"POST",409,key);
  assert.equal(conflict.error.code,"IDEMPOTENCY_CONFLICT");
  const queue=(await admin.fetch("/staff/tickets?state=open&reference="+result.public_no)).rows.filter((row:{public_no:string})=>row.public_no===result.public_no);
  assert.equal(queue.length,1);
  assert(!JSON.stringify(queue).includes(email));
  const path="/staff/tickets/"+queue[0].id;
  await visitor.fetch(path,undefined,"GET",401);
  await receiver.fetch(path,undefined,"GET",403);
  await c.fetch("/cases/"+queue[0].id,undefined,"GET",404);
  const guest=await admin.fetch(path);
  assert.equal(guest.inquiry.contact_email,email);
  assert.equal(guest.inquiry.category.en,category.label);
  assert.equal(guest.inquiry.sample_count,24);
  assert.equal(guest.inquiry.portal_reply,false);
  assert.equal(guest.events[0].body,payload.description);
  const failedReply=await admin.fetch(path+"/events",{kind:"reply",revision:guest.revision,body:"No portal recipient."},"POST",409);
  assert.equal(failedReply.error.code,"CASE_CONTACT_REQUIRED");
  const assigned=await admin.fetch(path+"/events",{kind:"claim",revision:guest.revision});
  await admin.fetch(path+"/events",{kind:"internal_note",revision:assigned.revision,body:"Contact follow-up recorded."});
  const pending=await Promise.all([2,3,4,5].map(sample_count=>otherVisitor.fetch("/public/inquiries",{...payload,sample_count},"POST",201)));
  assert.equal(new Set(pending.map(row=>row.public_no)).size,4);
  assert.equal((await new Client().fetch("/public/inquiries",payload,"POST",429)).error.code,"INQUIRY_RATE_LIMIT");
  await otherVisitor.fetch("/public/inquiries",{...payload,email:"other-"+email},"POST",201);
  assert.equal((await otherVisitor.fetch("/public/inquiries",{...payload,email:"another-"+email},"POST",429)).error.code,"INQUIRY_RATE_LIMIT");
  const customerEmail="customer-"+email;
  const signed=await c.fetch("/public/inquiries",{...payload,email:customerEmail},"POST",201);
  const ownCase=await c.fetch("/cases/"+signed.case_id);
  assert.equal(ownCase.public_no,signed.public_no);
  assert.equal(ownCase.inquiry,undefined);
  assert.equal((await admin.fetch("/staff/tickets/"+signed.case_id)).inquiry.portal_reply,true);
});

test("support and customer can finish a case while internal notes stay private",async()=>{
  const {c}=await signCustomer(),other=(await signCustomer()).c;
  const support=await staffLogin("reviewer"),admin=await staffLogin("admin"),receiver=await staffLogin("receiving");
  const staffId=(await support.fetch("/me")).actor.id;
  await pool.query("insert into staff_roles(user_id,role) values($1,'support')",[staffId]);
  try {
    const created=await c.fetch("/me/cases",{subject:"Missing shipment detail",message:"Please check my shipping instruction."});
    const customerPath="/cases/"+created.id,staffPath="/staff/tickets/"+created.id,events=staffPath+"/events";
    await other.fetch(customerPath,undefined,"GET",404);
    await other.fetch(customerPath+"/messages",{revision:1,body:"Unauthorized reply."},"POST",404);
    await c.fetch(staffPath,undefined,"GET",403);
    await receiver.fetch(staffPath,undefined,"GET",403);
    const queued=(await support.fetch("/staff/tickets?state=open&reference="+created.public_no)).rows.find((row:{id:string})=>row.id===created.id);
    assert.equal(queued.public_no,created.public_no);
    const claimed=await support.fetch(events,{kind:"claim",revision:1});
    await admin.fetch(events,{kind:"claim",revision:claimed.revision},"POST",409);
    const note={kind:"internal_note",revision:claimed.revision,body:"Internal fixture: check carrier evidence."};
    const key=randomUUID();
    const [first,replay]=await Promise.all([support.fetch(events,note,"POST",200,key),support.fetch(events,note,"POST",200,key)]);
    assert.deepEqual(first,replay);
    await support.fetch(events,note,"POST",409);
    const response=await support.fetch(events,{kind:"reply",revision:first.revision,body:"Please confirm the return recipient.",
      reply_by:new Date(Date.now()+86400000).toISOString()});
    assert.equal(response.state,"waiting_customer");
    const detail=await c.fetch(customerPath);
    assert.equal(detail.events.length,2);
    assert(!JSON.stringify(detail).includes("Internal fixture"));
    assert(!(Object.hasOwn(detail,"assignee_id")));
    assert((await c.fetch("/actions")).rows.some((row:{id:string})=>row.id===created.id));
    const attachment=await sharp({create:{width:40,height:40,channels:3,background:"#126a70"}}).png().toBuffer();
    const form=new FormData();
    form.set("revision",String(detail.revision));
    form.set("body","The seller gave me a new address.");
    form.set("photo",new Blob([new Uint8Array(attachment)],{type:"image/png"}),"fixture.png");
    const replyKey=randomUUID();
    const replied=await c.fetch(customerPath+"/messages",form,"POST",200,replyKey);
    assert.deepEqual(await c.fetch(customerPath+"/messages",form,"POST",200,replyKey),replied);
    assert.equal(replied.state,"waiting_internal");
    assert(!(await c.fetch("/actions")).rows.some((row:{id:string})=>row.id===created.id));
    const solved=await support.fetch(events,{kind:"resolve",revision:replied.revision,body:"Resolved the inquiry with the customer."});
    assert.equal(solved.state,"resolved");
    await c.fetch(customerPath+"/messages",{revision:solved.revision,body:"Do not reopen via reply."},"POST",409);
    assert.equal((await support.fetch(staffPath)).events.filter((entry:{kind:string})=>entry.kind==="internal_note").length,2);
    assert.equal((await c.fetch(customerPath)).events.length,3);
    const attachmentId=(await c.fetch(customerPath)).events.at(-1).media_ids[0];
    assert((await c.fetch("/media/"+attachmentId)).image.length>0);
    assert((await support.fetch("/media/"+attachmentId)).image.length>0);
    await other.fetch("/media/"+attachmentId,undefined,"GET",404);
    await receiver.fetch("/media/"+attachmentId,undefined,"GET",404);
    for(let i=0;i<100;i++){if(!await workOnce())break;}
    const notice=await pool.query("select payload from notifications where template='ticket.reply' and payload->>'ticket_id'=$1",[created.id]);
    assert.equal(notice.rowCount,1);
    assert(!JSON.stringify(notice.rows).includes("Please confirm"));
    const updates=(await c.fetch("/me/desk")).notices.filter((n:{case_id:string})=>n.case_id===created.id);
    assert.equal(updates.length,1);
    assert.equal(updates[0].read_at,null);
    assert.equal(updates[0].template,"ticket.reply");
    assert(!("payload" in updates[0]));
    assert(!(await other.fetch("/me/desk")).notices.some((n:{id:string})=>n.id===updates[0].id));
    const noticePath="/me/notifications/"+updates[0].id+"/read";
    await other.fetch(noticePath,{},"POST",404);
    await support.fetch(noticePath,{},"POST",403);
    const readKey=randomUUID();
    const [read,replayedRead]=await Promise.all([
      c.fetch(noticePath,{},"POST",200,readKey),c.fetch(noticePath,{},"POST",200,readKey),
    ]);
    assert.deepEqual(read,replayedRead);
    assert(read.read_at);
    assert.equal((await c.fetch(noticePath,{})).read_at,read.read_at);
    assert.equal((await c.fetch("/me/desk")).notices.find((n:{id:string})=>n.id===updates[0].id).read_at,read.read_at);
  } finally {
    await pool.query("delete from staff_roles where user_id=$1 and role='support'",[staffId]);
  }
});

test("notification history paginates equal timestamps and keeps unread state and cursors private",async()=>{
  const {c,registration}=await signCustomer(),other=await signCustomer();
  const foreignCase=await other.c.fetch("/me/cases",{subject:"Private fixture",message:"Do not expose the case through notifications."});
  const {rows}=await pool.query(`insert into notifications(user_id,template,locale,payload,dedupe_key,created_at)
    select $1,'ticket.reply','en',$2,$3||i::text,'2026-01-02T23:59:59.123456Z' from generate_series(1,51) i
    returning id`,[registration.user_id,{ticket_id:foreignCase.id},"inbox-pagination:"+randomUUID()+":"]);
  const expected=rows.map(row=>row.id).sort().reverse();
  const list="/me/notifications?unread=1";
  const first=await c.fetch(list);
  assert.equal(first.rows.length,50);
  assert.equal(first.next_before,expected[49]);
  assert(first.rows.every((n:{case_id:string|null})=>n.case_id===null));
  assert(!JSON.stringify(first).includes(foreignCase.id));
  const anchor=first.next_before;
  await other.c.fetch(list+"&before="+anchor,undefined,"GET",404);
  await c.fetch("/me/notifications/"+anchor+"/read",{});
  const older=await c.fetch(list+"&before="+anchor);
  assert.deepEqual(older.rows.map((n:{id:string})=>n.id),[expected[50]]);
  assert.equal(older.next_before,null);
  const unread=await c.fetch(list);
  assert(!unread.rows.some((n:{id:string})=>n.id===anchor));
  const all=await c.fetch("/me/notifications");
  assert(all.rows.find((n:{id:string})=>n.id===anchor).read_at);
});

test("audit filters expose immutable records to administrators with explicit field projection",async()=>{
  const admin=await staffLogin("admin"),receiver=await staffLogin("receiving"),customer=(await signCustomer()).c;
  const actorId=(await admin.fetch("/me")).actor.id;
  const entityId=randomUUID();
  await pool.query(`insert into audit_events(at,actor_type,actor_id,action,entity_type,entity_id,before,after,ip,meta)
    select '2026-01-02T23:59:59Z','staff',$1,'audit_projection_fixture','orders',$2,$3,$4,'192.0.2.10',$5
    from generate_series(1,51)`,[actorId,entityId,{active:true,token_hash:"private-fixture"},{reason:"Fixture operation",active:false,nested:{token:"hidden"}},{request:"hidden"}]);
  const path="/staff/audit?"+new URLSearchParams({entity_type:"orders",entity_id:entityId,action:"audit_projection_fixture",
    actor_id:actorId,actor_type:"staff",from:"2026-01-02",to:"2026-01-02"});
  const first=await admin.fetch(path);
  assert.equal(first.rows.length,50);
  assert(first.next_before_id);
  const second=await admin.fetch(path+"&before_id="+first.next_before_id);
  assert.equal(second.rows.length,1);
  assert.equal(second.next_before_id,null);
  assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,51);
  assert.deepEqual(first.rows[0].before,{active:true});
  assert.deepEqual(first.rows[0].after,{reason:"Fixture operation",active:false});
  assert.equal(first.rows[0].ip,undefined);
  assert.equal(first.rows[0].meta,undefined);
  await customer.fetch(path,undefined,"GET",403);
  await receiver.fetch(path,undefined,"GET",403);
  await admin.fetch(path,{},"POST",404);
  await admin.fetch("/staff/audit?before_id=9223372036854775808",undefined,"GET",422);
  await assert.rejects(pool.query("update audit_events set action='modified' where id=$1",[first.rows[0].id]),{code:"23514"});
});

test("OTP challenges enforce generation, browser binding, cross-resend failure budget, and concurrent single-use verification",async()=>{
  const browserA=new Client(),browserB=new Client();
  const email=randomUUID()+"@qcw.test";
  const first=await browserA.fetch("/auth/otp/request",{email},"POST",202);
  assert.equal(first.resend_after,60);
  const firstRow=(await pool.query("select generation,attempts,consumed_at from verification_challenges where id=$1",[first.challenge_id])).rows[0];
  assert.equal(firstRow.generation,1);
  await browserA.fetch("/auth/otp/verify",{challenge_id:first.challenge_id,code:"000000"},"POST",400);
  await browserA.fetch("/auth/otp/verify",{challenge_id:first.challenge_id,code:"999999"},"POST",400);

  const second=await browserA.fetch("/auth/otp/request",{email},"POST",202);
  const afterResend=(await pool.query("select consumed_at from verification_challenges where id=$1",[first.challenge_id])).rows[0];
  assert(afterResend.consumed_at,"Resending an OTP must invalidate the previous challenge.");
  await browserA.fetch("/auth/otp/verify",{challenge_id:first.challenge_id,code:first.demo_code},"POST",400);
  const secondRow=(await pool.query("select generation from verification_challenges where id=$1",[second.challenge_id])).rows[0];
  assert.equal(secondRow.generation,2);

  for(let i=0;i<3;i++) {
    await browserA.fetch("/auth/otp/verify",{challenge_id:second.challenge_id,code:"111111"},"POST",400);
  }
  const exhausted=(await pool.query("select consumed_at,attempts from verification_challenges where id=$1",[second.challenge_id])).rows[0];
  assert.equal(exhausted.attempts,3);
  assert(exhausted.consumed_at,"Reaching the 1-hour total failure budget across resends must consume the active challenge.");
  await browserA.fetch("/auth/otp/verify",{challenge_id:second.challenge_id,code:second.demo_code},"POST",400);
  await browserA.fetch("/auth/otp/request",{email},"POST",429);

  const email2=randomUUID()+"@qcw.test";
  const fresh=await browserA.fetch("/auth/otp/request",{email:email2},"POST",202);
  await browserB.fetch("/auth/otp/verify",{challenge_id:fresh.challenge_id,code:fresh.demo_code},"POST",400);
  const [attempt1,attempt2]=await Promise.all([
    handle(new Request(origin+"/api/v1/auth/otp/verify",{
      method:"POST",
      headers:{origin,"content-type":"application/json",cookie:"qcw_browser="+(browserA as unknown as {jar:Map<string,string>}).jar.get("qcw_browser")},
      body:JSON.stringify({challenge_id:fresh.challenge_id,code:fresh.demo_code}),
    }),"/auth/otp/verify"),
    handle(new Request(origin+"/api/v1/auth/otp/verify",{
      method:"POST",
      headers:{origin,"content-type":"application/json",cookie:"qcw_browser="+(browserA as unknown as {jar:Map<string,string>}).jar.get("qcw_browser")},
      body:JSON.stringify({challenge_id:fresh.challenge_id,code:fresh.demo_code}),
    }),"/auth/otp/verify"),
  ]);
  assert.deepEqual([attempt1.status,attempt2.status].sort((a,b)=>a-b),[200,400]);
});

test("Postmark transactional email delivery tracks timeouts, webhooks, out-of-order events, and suppression while keeping in-app notices active",async t=>{
  const custA=await signCustomer(),custB=await signCustomer();
  for(let i=0;i<100;i++){if(!await workOnce())break;}
  const admin=await staffLogin("admin"),receiver=await staffLogin("receiving");
  const adminId=(await admin.fetch("/me")).actor.id;
  await pool.query("insert into staff_roles(user_id,role) values($1,'support') on conflict do nothing",[adminId]);
  setFixtureEnv(t,{
    QCW_DEMO:"0",
    POSTMARK_SERVER_TOKEN:"postmark-live-fixture",
    EMAIL_FROM:"no-reply@qcwarehouse.test",
    POSTMARK_MESSAGE_STREAM:"outbound",
    POSTMARK_WEBHOOK_TOKEN:"webhook-secret-fixture",
  });
  let callIndex=0;
  const fetchMock=t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    assert.equal(url,"https://api.postmarkapp.com/email");
    assert.equal(new Headers(init.headers).get("X-Postmark-Server-Token"),"postmark-live-fixture");
    callIndex++;
    if(callIndex===1) {
      throw new DOMException("The operation was aborted due to timeout","TimeoutError");
    }
    return Response.json({ErrorCode:0,MessageID:`pm-msg-${callIndex}`});
  });

  try {
    const ticketA=await custA.c.fetch("/me/cases",{subject:"Email delivery check",message:"Testing Postmark pipeline."});
    const claimedA=await admin.fetch(`/staff/tickets/${ticketA.id}/events`,{kind:"claim",revision:1});
    const repliedA=await admin.fetch(`/staff/tickets/${ticketA.id}/events`,{
      kind:"reply",revision:claimedA.revision,body:"First support update for email delivery.",
    });

    assert.equal(await workOnce(),true);
    assert.equal(await workOnce(),true);
    assert.equal(fetchMock.mock.callCount(),1);
    await workOnce();
    assert.equal(fetchMock.mock.callCount(),1);

    await custA.c.fetch("/staff/admin/email-deliveries",undefined,"GET",403);
    await receiver.fetch("/staff/admin/email-deliveries",undefined,"GET",403);
    const list1=await admin.fetch("/staff/admin/email-deliveries?state=unknown");
    assert.equal(list1.channel_alert.degraded,true);
    assert(list1.channel_alert.unknown_count>=1);
    const attempt1=list1.rows.find((r:{user_id:string})=>r.user_id===custA.registration.user_id);
    assert(attempt1);
    assert.equal(attempt1.state,"unknown");
    assert.equal(attempt1.error_code,"REQUEST_TIMEOUT");
    assert.equal(attempt1.can_retry,true);

    const retried=await admin.fetch(`/staff/admin/email-deliveries/${attempt1.id}/retry`,{
      attempt:1,reason:"Verified with Postmark that attempt 1 timed out before submission.",
    });
    assert.equal(retried.attempt,2);
    assert.equal(retried.state,"queued");

    assert.equal(await workOnce(),true);
    assert.equal(fetchMock.mock.callCount(),2);
    const attempt2=(await admin.fetch("/staff/admin/email-deliveries")).rows.find((r:{id:string})=>r.id===retried.id);
    assert.equal(attempt2.state,"submitted");
    assert.equal(attempt2.provider_message_id,"pm-msg-2");

    const webhookPath="/webhooks/email/postmark";
    function postWebhook(payload:object,secret="webhook-secret-fixture") {
      return handle(new Request(origin+"/api/v1"+webhookPath,{
        method:"POST",
        headers:{"content-type":"application/json","x-postmark-webhook-secret":secret},
        body:JSON.stringify(payload),
      }),webhookPath);
    }
    assert.equal((await postWebhook({RecordType:"Delivery",MessageID:"pm-msg-2"},"wrong-secret")).status,401);

    assert.equal((await postWebhook({
      RecordType:"Bounce",Type:"Transient",Inactive:false,MessageID:"pm-msg-2",ID:101,
    })).status,200);
    assert.equal(await workOnce(),true);
    assert.equal((await custA.c.fetch("/me/email-delivery-status")).delivery_state,"degraded");
    assert.equal((await custA.c.fetch("/me/email-delivery-status")).suppressed,false);

    assert.equal((await postWebhook({
      RecordType:"Delivery",MessageID:"pm-msg-2",DeliveredAt:"2026-11-06T12:00:00Z",
    })).status,200);
    assert.equal(await workOnce(),true);
    assert.equal((await custA.c.fetch("/me/email-delivery-status")).delivery_state,"deliverable");
    assert.equal((await admin.fetch("/staff/admin/email-deliveries")).rows.find((r:{id:string})=>r.id===retried.id).state,"delivered");

    assert.equal((await postWebhook({
      RecordType:"Bounce",Type:"HardBounce",Inactive:true,MessageID:"pm-msg-2",ID:102,
    })).status,200);
    assert.equal((await postWebhook({
      RecordType:"Bounce",Type:"HardBounce",Inactive:true,MessageID:"pm-msg-2",ID:102,
    })).status,200);
    assert.equal(await workOnce(),true);

    assert.equal((await postWebhook({
      RecordType:"Delivery",MessageID:"pm-msg-2",DeliveredAt:"2026-11-06T12:05:00Z",
    })).status,200);
    assert.equal(await workOnce(),true);
    assert.equal((await admin.fetch("/staff/admin/email-deliveries")).rows.find((r:{id:string})=>r.id===retried.id).state,"bounced");

    const statusA=await custA.c.fetch("/me/email-delivery-status");
    assert.equal(statusA.delivery_state,"bounced");
    assert.equal(statusA.suppressed,true);
    assert.equal(statusA.banner_message,"We couldn't deliver email to this address");
    assert.equal((await custA.c.fetch("/me/desk")).email_delivery.banner_message,"We couldn't deliver email to this address");
    assert((await custA.c.fetch("/actions")).rows.some((r:{kind:string;state:string})=>r.kind==="email"&&r.state==="bounced"));
    assert((await custA.c.fetch("/me/notifications")).rows.some((n:{template:string})=>n.template==="email.delivery_failed"));

    await admin.fetch(`/staff/admin/email-deliveries/${retried.id}/retry`,{
      attempt:2,reason:"Should not retry a bounced address.",
    },"POST",409);

    await admin.fetch(`/staff/tickets/${ticketA.id}/events`,{
      kind:"reply",revision:repliedA.revision,body:"Second support update while email is suppressed.",
    });
    for(let i=0;i<20;i++){if(!await workOnce())break;}
    assert.equal(fetchMock.mock.callCount(),2);
    const noticesA=await custA.c.fetch("/me/notifications");
    assert.equal(noticesA.rows.filter((n:{template:string})=>n.template==="ticket.reply").length,2);
    const suppressedRow=(await admin.fetch("/staff/admin/email-deliveries?state=bounced")).rows.find(
      (r:{user_id:string;error_code:string})=>r.user_id===custA.registration.user_id&&r.error_code==="ADDRESS_SUPPRESSED"
    );
    assert(suppressedRow);

    const ticketB=await custB.c.fetch("/me/cases",{subject:"Complaint check",message:"Testing spam complaint suppression."});
    const claimedB=await admin.fetch(`/staff/tickets/${ticketB.id}/events`,{kind:"claim",revision:1});
    await admin.fetch(`/staff/tickets/${ticketB.id}/events`,{
      kind:"reply",revision:claimedB.revision,body:"Support update for customer B.",
    });
    for(let i=0;i<20;i++){if(!await workOnce())break;}
    assert.equal(fetchMock.mock.callCount(),3);
    assert.equal((await postWebhook({
      RecordType:"SpamComplaint",MessageID:"pm-msg-3",ID:201,
    })).status,200);
    assert.equal(await workOnce(),true);
    const statusB=await custB.c.fetch("/me/email-delivery-status");
    assert.equal(statusB.delivery_state,"complained");
    assert.equal(statusB.suppressed,true);
    assert.equal(statusB.banner_message,"We couldn't deliver email to this address");
  } finally {
    await pool.query("delete from staff_roles where user_id=$1 and role='support'",[adminId]);
  }
});

test("customer 30-day sessions, staff 12-hour MFA sessions, and session-bound CSRF tokens enforce isolation and revocation",async()=>{
  const custA=await signCustomer(),custB=await signCustomer();
  const sessA=(await pool.query<{kind:string;days:number}>(
    "select kind,round(extract(epoch from (expires_at - created_at))/86400)::int as days from sessions where token_hash=$1",
    [custA.c.sessionHash()]
  )).rows[0];
  assert.equal(sessA.kind,"customer");
  assert.equal(sessA.days,30);

  const jarA=(custA.c as unknown as {jar:Map<string,string>}).jar;
  const jarB=(custB.c as unknown as {jar:Map<string,string>}).jar;
  const sessionSecretA=jarA.get("session")!;
  const csrfB=jarB.get("qcw_csrf")!;

  const missingCsrf=await handle(new Request(origin+"/api/v1/auth/logout",{
    method:"POST",headers:{origin,cookie:`session=${sessionSecretA}`},
  }),"/auth/logout");
  assert.equal(missingCsrf.status,403);
  assert.equal((await missingCsrf.json()).error.code,"CSRF_INVALID");

  const crossSessionCsrf=await handle(new Request(origin+"/api/v1/auth/logout",{
    method:"POST",headers:{origin,cookie:`session=${sessionSecretA}; qcw_csrf=${csrfB}`,"x-csrf-token":csrfB},
  }),"/auth/logout");
  assert.equal(crossSessionCsrf.status,403);
  assert.equal((await crossSessionCsrf.json()).error.code,"CSRF_INVALID");

  const badOrigin=await handle(new Request(origin+"/api/v1/auth/logout",{
    method:"POST",headers:{origin:"https://evil.example",cookie:`session=${sessionSecretA}`,"x-csrf-token":jarA.get("qcw_csrf")!},
  }),"/auth/logout");
  assert.equal(badOrigin.status,403);
  assert.equal((await badOrigin.json()).error.code,"ORIGIN_REJECTED");

  const staffId=randomUUID(),staffEmail=`mfa-${staffId}@qcw.test`;
  const totpSecretHex="3132333435363738393031323334353637383930";
  const password="StaffPassword!2026";
  await pool.query(
    "insert into users(id,display_name,locale,password_hash,mfa_secret_enc) values($1,'MFA Staff','zh-CN',$2,$3)",
    [staffId,passwordHash(password),encryptSecret(totpSecretHex).toString("base64url")]
  );
  await pool.query(
    "insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled) values($1,$2::text,($2::text)::citext,now(),true,true)",
    [staffId,staffEmail]
  );
  await pool.query("insert into staff_roles(user_id,role) values($1,'receiver')", [staffId]);

  const counter=Math.floor(Date.now()/30000);
  const bytes=Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const digest=createHmac("sha1",Buffer.from(totpSecretHex,"hex")).update(bytes).digest();
  const totp=String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1000000).padStart(6,"0");

  const staffClient=new Client();
  await staffClient.fetch("/staff/auth/login",{email:staffEmail,password:"WrongPassword",otp:totp},"POST",401);
  const loginRes=await staffClient.fetch("/staff/auth/login",{email:staffEmail,password,otp:totp},"POST",200);
  assert.equal(loginRes.kind,"staff");

  const sessStaff=(await pool.query<{kind:string;hours:number;mfa_at:Date|null}>(
    "select kind,round(extract(epoch from (expires_at - created_at))/3600)::int as hours,mfa_at from sessions where token_hash=$1",
    [staffClient.sessionHash()]
  )).rows[0];
  assert.equal(sessStaff.kind,"staff");
  assert.equal(sessStaff.hours,12);
  assert(sessStaff.mfa_at);

  const replayClient=new Client();
  await replayClient.fetch("/staff/auth/login",{email:staffEmail,password,otp:totp},"POST",401);

  await staffClient.fetch("/auth/logout",{},"POST",200);
  await staffClient.fetch("/me",undefined,"GET",401);
});

test("catalog and order creation enforce joint category, capability, template, and demo eligibility guards",async t=>{
  const {c}=await signCustomer();
  const initial=(await c.fetch("/catalog")).offers as {offer_id:string;category_id:string;sku_code:string;category:{en:string}}[];
  const bags=initial.find(o=>o.category.en==="Bags")!;
  assert(bags);

  await pool.query("update categories set status='PAUSED' where id=$1",[bags.category_id]);
  try {
    assert(!(await c.fetch("/catalog")).offers.some((o:{offer_id:string})=>o.offer_id===bags.offer_id));
    await c.fetch("/orders",{lines:[{category_id:bags.category_id,offer_id:bags.offer_id,quantity:1}]},"POST",409);
  } finally {
    await pool.query("update categories set status='ACTIVE' where id=$1",[bags.category_id]);
  }

  await pool.query("update capabilities set revoked_at=now() where code='demo-visual'");
  try {
    assert.equal((await c.fetch("/catalog")).offers.length,0);
    await c.fetch("/orders",{lines:[{category_id:bags.category_id,offer_id:bags.offer_id,quantity:1}]},"POST",409);
  } finally {
    await pool.query("update capabilities set revoked_at=null where code='demo-visual'");
  }

  setFixtureEnv(t,{QCW_DEMO:"0"});
  assert.equal((await c.fetch("/catalog")).offers.length,0);
  await c.fetch("/orders",{lines:[{category_id:bags.category_id,offer_id:bags.offer_id,quantity:1}]},"POST",409);
});

test("controlled template admin, capability approval, category admission guard, and offer pricing versions enforce independent review and audit",async()=>{
  const templateAdmin=await staffLogin("inspector");
  const reviewer=await staffLogin("reviewer");
  const admin=await staffLogin("admin");
  const receiver=await staffLogin("receiving");

  const capCode="cap-"+randomUUID().slice(0,8);
  await receiver.fetch("/staff/admin/capabilities",{code:capCode,method:"Calibrated tape measure"},"POST",403);
  const createdCap=await admin.fetch("/staff/admin/capabilities",{code:capCode,method:"Calibrated tape measure"},"POST",200);
  assert.equal(createdCap.state,"pending_approval");

  const selfApprove=await admin.fetch(`/staff/admin/capabilities/${createdCap.id}/approve`,{},"POST",409);
  assert.equal(selfApprove.error.code,"SELF_REVIEW_FORBIDDEN");
  assert((await pool.query("select 1 from audit_events where action='rejected_self_review_forbidden' and after->>'code'='SELF_REVIEW_FORBIDDEN'")).rowCount!>=1);

  const approvedCap=await reviewer.fetch(`/staff/admin/capabilities/${createdCap.id}/approve`,{},"POST",200);
  assert.equal(approvedCap.state,"approved");

  const catSlug="cat-"+randomUUID().slice(0,8);
  const createdCat=await templateAdmin.fetch("/staff/admin/categories",{
    slug:catSlug,labels:{en:"Footwear","zh-CN":"鞋靴"},
  },"POST",200);
  assert.equal(createdCat.status,"PLANNED");

  const missingSop=await admin.fetch(`/staff/admin/categories/${createdCat.id}/status`,{
    status:"ACTIVE",admission_snapshot:{training_completed:true,equipment_verified:true},
  },"POST",422);
  assert.equal(missingSop.error.code,"CATEGORY_ADMISSION_INCOMPLETE");
  assert((await pool.query("select 1 from audit_events where action='rejected_category_admission_incomplete' and after->>'code'='CATEGORY_ADMISSION_INCOMPLETE'")).rowCount!>=1);

  const missingTpl=await admin.fetch(`/staff/admin/categories/${createdCat.id}/status`,{
    status:"ACTIVE",
    admission_snapshot:{sop_ref:"SOP-FW-01",training_completed:true,equipment_verified:true,pilot_evidence:"PILOT-FW-01"},
  },"POST",422);
  assert.equal(missingTpl.error.code,"CATEGORY_ADMISSION_INCOMPLETE");

  const serviceId=(await pool.query<{id:string}>("select id from service_types where code='inspection'")).rows[0].id;
  const tplDraft=await templateAdmin.fetch("/staff/admin/templates",{
    template_key:catSlug+"-inspection",
    category_id:createdCat.id,
    service_type_id:serviceId,
    capability_ids:[createdCap.id],
    content:{checks:[
      {key:"outsole",label:"Outsole condition",zh:"外底外观",type:"boolean",method:"Visual observation",required:true,evidence:true},
      {key:"insole_len",label:"Insole length",zh:"内长",type:"number",unit:"cm",method:"Calibrated tape measure",required:true,evidence:true},
    ]},
  },"POST",200);
  assert.equal(tplDraft.state,"IN_REVIEW");

  const unpublishedOffer=await admin.fetch("/staff/admin/offers",{
    sku_code:catSlug+"-inspect-1",
    category_id:createdCat.id,
    service_type_id:serviceId,
    template_version_id:tplDraft.id,
    title:{en:"Footwear inspection","zh-CN":"鞋靴逐件检查"},
    rules:{minimum:1,maximum:50,unit_cents:3200,business_days:3,demo:true},
  },"POST",409);
  assert.equal(unpublishedOffer.error.code,"TEMPLATE_NOT_PUBLISHED");

  const publishedTpl=await reviewer.fetch(`/staff/admin/templates/${tplDraft.id}/publish`,{},"POST",200);
  assert.equal(publishedTpl.state,"PUBLISHED");
  await assert.rejects(pool.query("update template_versions set content='{}' where id=$1",[tplDraft.id]),{code:"23514"});

  const activatedCat=await admin.fetch(`/staff/admin/categories/${createdCat.id}/status`,{
    status:"ACTIVE",
    admission_snapshot:{sop_ref:"SOP-FW-01",training_completed:true,equipment_verified:true,pilot_evidence:"PILOT-FW-01",demo:true},
  },"POST",200);
  assert.equal(activatedCat.status,"ACTIVE");

  const offer=await admin.fetch("/staff/admin/offers",{
    sku_code:catSlug+"-inspect-1",
    category_id:createdCat.id,
    service_type_id:serviceId,
    template_version_id:tplDraft.id,
    title:{en:"Footwear inspection","zh-CN":"鞋靴逐件检查"},
    rules:{minimum:1,maximum:50,unit_cents:3200,business_days:3,demo:true},
  },"POST",200);
  assert.equal(offer.version,1);

  const repriced=await admin.fetch(`/staff/admin/skus/${catSlug}-inspect-1/prices`,{
    rules:{minimum:1,maximum:50,unit_cents:3400,business_days:2,demo:true},
  },"POST",200);
  assert.equal(repriced.version,2);

  const catalogOffers=(await admin.fetch("/catalog")).offers as {sku_code:string;rules:{unit_cents:number;business_days:number}}[];
  const liveOffer=catalogOffers.find(o=>o.sku_code===catSlug+"-inspect-1");
  assert(liveOffer);
  assert.equal(liveOffer.rules.unit_cents,3400);
  assert.equal(liveOffer.rules.business_days,2);
});

test("reference sample reservation, active comparison lock, outbound shipping conflict, release authorization, and expiry / category compatibility guards",async()=>{
  const {c,terms}=await signCustomer();
  const receiver=await staffLogin("receiving"),inspector=await staffLogin("inspector"),reviewer=await staffLogin("reviewer");
  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id;
  const loc=(await pool.query<{id:string}>("select id from storage_locations where code='S-01'")).rows[0].id;
  const termsId=terms.find((t:{kind:string})=>t.kind==="terms")!.id;
  const offers=(await c.fetch("/catalog")).offers as {offer_id:string;category_id:string;sku_code:string;service:string;content:{checks:{key:string;type:string;unit?:string;method:string;required:boolean}[]}}[];
  const apparelInspect=offers.find(o=>o.sku_code==="apparel-inspection-1")!;
  const apparelCompare=offers.find(o=>o.sku_code==="apparel-compare-2")!;
  const apparelRefMatch=offers.find(o=>o.sku_code==="apparel-reference_match-1")!;
  const bagsOffer=offers.find(o=>o.sku_code==="bags-shadow")!;

  async function receiveAndAssign(orderId:string) {
    const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
    const advice=await c.fetch("/me/parcels",{address_id:addr,carrier_code:"zto",tracking_no:tracking},"POST",201);
    const pkg=await receiver.fetch("/staff/intake/check-in",{tracking_no:tracking,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[await receiver.photo("intake_outer")]},"POST",201);
    const items=await receiver.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:[{code:"S-"+randomUUID(),location_id:loc}]},"POST",201);
    const itemId=items.item_ids[0];
    const order=await c.fetch("/orders/"+orderId);
    const expected=order.items[0];
    await receiver.fetch("/staff/items/"+itemId+"/assign",{revision:1,order_line_id:expected.order_line_id,expected_item_id:expected.id,evidence_ids:[await receiver.photo("label_photo")]});
    return itemId;
  }

  async function finishTaskAndApprove(orderId:string,taskId:string,taskRevision:number) {
    const started=await inspector.fetch("/staff/inspection-tasks/"+taskId+"/start",{revision:taskRevision});
    const view=await inspector.fetch("/staff/inspection-tasks/"+taskId);
    await submitRequiredChecks(inspector,taskId,started.revision,view);
    const order=await c.fetch("/orders/"+orderId);
    const report=await inspector.fetch(`/staff/orders/${orderId}/report/submit`,{revision:order.revision,task_ids:[taskId]});
    await reviewer.fetch(`/staff/reports/${report.id}/approve`,{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",202);
    for(let i=0;i<20;i++){if(!await workOnce())break;}
  }

  const incompatibleCompare=await c.fetch("/orders",{
    lines:[{
      category_id:apparelCompare.category_id,
      offer_id:apparelCompare.offer_id,
      quantity:2,
      items:[{category_id:apparelCompare.category_id},{category_id:bagsOffer.category_id}],
    }],
  },"POST",422);
  assert.equal(incompatibleCompare.error.code,"INCOMPATIBLE_SAMPLES");
  assert((await pool.query("select 1 from audit_events where action='rejected_incompatible_samples' and after->>'code'='INCOMPATIBLE_SAMPLES'")).rowCount!>=1);

  const {draft:seedOrder}=await createAndPay(c,[{category_id:apparelInspect.category_id,offer_id:apparelInspect.offer_id,quantity:1}],terms);
  const seedItemId=await receiveAndAssign(seedOrder.id);
  const {rows:[seedTask]}=await pool.query("select t.id,t.revision from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1",[seedOrder.id]);
  await finishTaskAndApprove(seedOrder.id,seedTask.id,seedTask.revision);

  const reservedInstruction=await c.fetch(`/me/items/${seedItemId}/dispositions`,{
    action:"reserve_reference",terms_version_id:termsId,
  },"POST",201);
  assert.equal(reservedInstruction.state,"completed");

  const dupReserve=await c.fetch(`/me/items/${seedItemId}/dispositions`,{
    action:"reserve_reference",terms_version_id:termsId,
  },"POST",409);
  assert.equal(dupReserve.error.code,"REFERENCE_ALREADY_ACTIVE");

  const refList=(await c.fetch("/me/reference-samples")).items as {reference_id:string;item_id:string;state:string;expires_at:string}[];
  assert.equal(refList.length,1);
  assert.equal(refList[0].item_id,seedItemId);
  assert.equal(refList[0].state,"active");
  const refId=refList[0].reference_id;

  const {draft:matchOrder}=await createAndPay(c,[{
    category_id:apparelRefMatch.category_id,
    offer_id:apparelRefMatch.offer_id,
    quantity:1,
    options:{reference_id:refId},
  }],terms);
  await receiveAndAssign(matchOrder.id);
  assert.equal((await c.fetch("/orders/"+matchOrder.id)).state,"queued");

  const deskDuringLock=await c.fetch("/me/desk");
  const lockedRef=deskDuringLock.references.find((r:{reference_id:string})=>r.reference_id===refId);
  assert.equal(lockedRef.in_use,true);

  const shipWhileInUse=await c.fetch(`/me/items/${seedItemId}/dispositions`,{
    action:"to_domestic_address",
    terms_version_id:termsId,
    destination:{recipient:"Alice",phone:"13800138000",address:"No. 1 Test Road"},
  },"POST",409);
  assert.equal(shipWhileInUse.error.code,"ITEM_RESERVED");
  assert((await pool.query("select 1 from audit_events where action='reference_outbound_conflict' and entity_id=$1",[refId])).rowCount!>=1);
  assert((await c.fetch("/actions")).rows.some((r:{kind:string;state:string;id:string})=>r.kind==="reference"&&r.state==="reference_conflict"&&r.id===refId));

  const releaseWhileInUse=await c.fetch(`/me/reference-samples/${refId}/release`,{
    terms_version_id:termsId,reason:"Attempt release during active match",
  },"POST",409);
  assert.equal(releaseWhileInUse.error.code,"ITEM_RESERVED");

  const {rows:[matchTask]}=await pool.query("select t.id,t.revision from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1",[matchOrder.id]);
  await finishTaskAndApprove(matchOrder.id,matchTask.id,matchTask.revision);

  assert.equal((await c.fetch("/orders/"+matchOrder.id)).state,"report_ready");
  assert(!(await c.fetch("/actions")).rows.some((r:{kind:string;id:string})=>r.kind==="reference"&&r.id===refId));
  assert.equal((await c.fetch("/me/desk")).references.find((r:{reference_id:string})=>r.reference_id===refId).in_use,false);

  const shipWithoutRelease=await c.fetch(`/me/items/${seedItemId}/dispositions`,{
    action:"to_domestic_address",
    terms_version_id:termsId,
    destination:{recipient:"Alice",phone:"13800138000",address:"No. 1 Test Road"},
  },"POST",409);
  assert.equal(shipWithoutRelease.error.code,"REFERENCE_RELEASE_REQUIRED");

  const released=await c.fetch(`/me/reference-samples/${refId}/release`,{
    terms_version_id:termsId,reason:"Release reference sample after comparison report",
  },"POST",200);
  assert.equal(released.state,"released");
  assert.equal((await c.fetch(`/orders/${matchOrder.id}/report`)).version,1);

  await c.fetch(`/me/items/${seedItemId}/dispositions`,{
    action:"reserve_reference",terms_version_id:termsId,
  },"POST",201);
  const refV2=(await c.fetch("/me/desk")).references.find((r:{revision:number})=>r.revision===2);
  assert(refV2);
  await pool.query("update reference_samples set expires_at=now()-interval '2 minutes' where id=$1",[refV2.reference_id]);
  assert((await c.fetch("/actions")).rows.some((r:{kind:string;state:string;id:string})=>r.kind==="reference"&&r.state==="reference_expired"&&r.id===refV2.reference_id));

  const expiredMatch=await c.fetch("/orders",{
    lines:[{
      category_id:apparelRefMatch.category_id,
      offer_id:apparelRefMatch.offer_id,
      quantity:1,
      options:{reference_id:refV2.reference_id},
    }],
  },"POST",409);
  assert.equal(expiredMatch.error.code,"REFERENCE_UNAVAILABLE");
});

test("order drafts preserve per-item declarations, attachments, compare size mismatch confirmation, and template snapshots across edits",async()=>{
  const {c,terms,registration}=await signCustomer(),other=(await signCustomer()).c;
  const admin=await staffLogin("admin"),receiver=await staffLogin("receiving");
  const offers=(await c.fetch("/catalog")).offers as {offer_id:string;category_id:string;sku_code:string;template_version_id:string}[];
  const apparelInspect=offers.find(o=>o.sku_code==="apparel-inspection-1")!;
  const apparelCompare=offers.find(o=>o.sku_code==="apparel-compare-2")!;

  const imgBuf=await sharp({create:{width:80,height:80,channels:3,background:"#225588"}}).png().toBuffer();
  const form=new FormData();
  form.set("photo",new Blob([new Uint8Array(imgBuf)],{type:"image/png"}),"size-chart.png");
  form.set("kind","attachment");
  const uploaded=await c.fetch("/me/media",form,"POST",201);
  assert(uploaded.id);
  assert((await c.fetch("/media/"+uploaded.id)).image.length>0);
  await other.fetch("/media/"+uploaded.id,undefined,"GET",404);
  await admin.fetch("/media/"+uploaded.id,undefined,"GET",404);

  const unconfirmedCompare=await c.fetch("/orders",{
    lines:[{
      category_id:apparelCompare.category_id,
      offer_id:apparelCompare.offer_id,
      quantity:2,
      items:[
        {sample_code:"Sample A",size_label:"M",color_declared:"Black"},
        {sample_code:"Sample B",size_label:"L",color_declared:"Black"},
      ],
    }],
  },"POST",422);
  assert.equal(unconfirmedCompare.error.code,"VALIDATION_FAILED");

  const confirmedCompare=await c.fetch("/orders",{
    customer_notes:"Compare two supplier batches.",
    lines:[{
      category_id:apparelCompare.category_id,
      offer_id:apparelCompare.offer_id,
      quantity:2,
      options:{size_mismatch_confirmed:true},
      attributes:{attachment_ids:[uploaded.id]},
      items:[
        {sample_code:"Sample A",size_label:"M",color_declared:"Black",tolerances:{chest_mm:15},attachment_ids:[uploaded.id]},
        {sample_code:"Sample B",size_label:"L",color_declared:"Navy",tolerances:{chest_mm:20}},
      ],
    }],
  },"POST",201);
  assert((await admin.fetch("/media/"+uploaded.id)).image.length>0);
  const compareDetail=await c.fetch("/orders/"+confirmedCompare.id);
  assert.equal(compareDetail.customer_notes,"Compare two supplier batches.");
  assert.equal(compareDetail.lines.length,1);
  assert.equal(compareDetail.lines[0].draft_items.length,2);
  assert.equal(compareDetail.lines[0].draft_items[0].sample_code,"Sample A");
  assert.equal(compareDetail.lines[0].draft_items[1].size_label,"L");

  const patched=await c.fetch("/orders/"+confirmedCompare.id,{
    revision:confirmedCompare.revision,
    lines:[{
      category_id:apparelInspect.category_id,
      offer_id:apparelInspect.offer_id,
      quantity:2,
      items:[
        {sample_code:"Hoodie-1",size_label:"XL",color_declared:"Grey",tolerances:{length_mm:10},attachment_ids:[uploaded.id]},
        {sample_code:"Hoodie-2",size_label:"XL",color_declared:"Grey"},
      ],
    }],
  },"PATCH",200);
  assert.equal(patched.revision,confirmedCompare.revision+1);

  const quote=await c.fetch(`/orders/${confirmedCompare.id}/quotes`,{revision:patched.revision},"POST",201);
  const originalTemplateVersionId=quote.line_snapshot[0].template_version_id;
  const submitted=await c.fetch(`/orders/${confirmedCompare.id}/submit`,{
    revision:patched.revision,
    quote_id:quote.id,
    terms_version_ids:terms.map(t=>t.id),
    acknowledgements:{scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true},
  });
  const checkout=await c.fetch(`/charges/${submitted.charge.charge_item_id}/checkout`,{quote_revision:quote.revision});
  await c.fetch(`/checkout/demo/${checkout.attempt_id}`,{});

  const {rows:[origTpl]}=await pool.query("select template_key,category_id,service_type_id,content,array(select capability_id from template_capabilities where template_version_id=id) capability_ids from template_versions where id=$1",[originalTemplateVersionId]);
  const templateAdmin=await staffLogin("inspector"),reviewer=await staffLogin("reviewer");
  const newDraftTpl=await templateAdmin.fetch("/staff/admin/templates",{
    template_key:origTpl.template_key,
    category_id:origTpl.category_id,
    service_type_id:origTpl.service_type_id,
    capability_ids:origTpl.capability_ids,
    content:origTpl.content,
  },"POST",200);
  await reviewer.fetch(`/staff/admin/templates/${newDraftTpl.id}/publish`,{},"POST",200);

  const desk=await receiver.fetch("/staff/desk");
  const loc=desk.locations.find((l:{code:string})=>l.code==="R-01").id;
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,carrier_code:"zto",tracking_no:tracking,order_ids:[confirmedCompare.id]},"POST",201);
  const pkg=await receiver.fetch("/staff/intake/check-in",{tracking_no:tracking,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[await receiver.photo("intake_outer")]},"POST",201);
  const createdItems=await receiver.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,
    items:[{code:"S-"+randomUUID(),location_id:loc},{code:"S-"+randomUUID(),location_id:loc}],
  },"POST",201);
  const orderAfterPay=await c.fetch("/orders/"+confirmedCompare.id);
  assert.equal(orderAfterPay.items.length,2);
  assert.equal(orderAfterPay.items[0].declared_fields.sample_code,"Hoodie-1");
  for(let i=0;i<2;i++) {
    await receiver.fetch(`/staff/items/${createdItems.item_ids[i]}/assign`,{
      revision:1,
      order_line_id:orderAfterPay.items[i].order_line_id,
      expected_item_id:orderAfterPay.items[i].id,
      evidence_ids:[await receiver.photo("label_photo")],
    });
  }
  const {rows:tasks}=await pool.query(
    "select t.template_version_id from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1",
    [confirmedCompare.id]
  );
  assert.equal(tasks.length,2);
  for(const t of tasks) {
    assert.equal(t.template_version_id,originalTemplateVersionId,"Task must use the template version snapshot from order submission (T43)");
    assert.notEqual(t.template_version_id,newDraftTpl.id);
  }
});

test("Stripe webhook signature/amount guards, order hold/resume during payment, late payment after cancellation, and warehouse address rotation preserve invariants",async t=>{
  const {c,terms,registration}=await signCustomer();
  const admin=await staffLogin("admin");
  const offers=(await c.fetch("/catalog")).offers as {offer_id:string;category_id:string;sku_code:string}[];
  const apparelInspect=offers.find(o=>o.sku_code==="apparel-inspection-1")!;
  const acknowledgements={scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true};

  async function submitNewOrder() {
    const draft=await c.fetch("/orders",{lines:[{category_id:apparelInspect.category_id,offer_id:apparelInspect.offer_id,quantity:1}]},"POST",201);
    const quote=await c.fetch(`/orders/${draft.id}/quotes`,{revision:draft.revision},"POST",201);
    const submitted=await c.fetch(`/orders/${draft.id}/submit`,{
      revision:draft.revision,quote_id:quote.id,terms_version_ids:terms.map(x=>x.id),acknowledgements,
    });
    const checkout=await c.fetch(`/charges/${submitted.charge.charge_item_id}/checkout`,{quote_revision:quote.revision});
    return {draft,quote,submitted,checkout};
  }

  const mismatchOrder=await submitNewOrder();
  const webhookSecret="whsec_test_secret_fixture_1234567890";
  setFixtureEnv(t,{QCW_DEMO:"0",STRIPE_SECRET_KEY:"sk_test_fixture_123456",STRIPE_WEBHOOK_SECRET:webhookSecret});

  const badSigRes=await handle(new Request(origin+"/api/v1/webhooks/stripe",{
    method:"POST",
    headers:{"content-type":"application/json","stripe-signature":"t=1700000000,v1=deadbeef"},
    body:JSON.stringify({id:"evt_bad_sig",type:"checkout.session.completed"}),
  }),"/webhooks/stripe");
  assert.equal(badSigRes.status,401);
  assert.equal((await badSigRes.json()).error.code,"SIGNATURE_INVALID");
  assert((await pool.query("select 1 from audit_events where action='rejected_signature_invalid' and after->>'code'='SIGNATURE_INVALID'")).rowCount!>=1);

  const mismatchPayload=JSON.stringify({
    id:"evt_mismatch_"+randomUUID(),
    object:"event",
    api_version:"2024-06-20",
    created:Math.floor(Date.now()/1000),
    livemode:false,
    pending_webhooks:1,
    request:{id:null,idempotency_key:null},
    type:"checkout.session.completed",
    data:{
      object:{
        id:"cs_test_"+randomUUID(),
        object:"checkout.session",
        payment_status:"paid",
        amount_total:mismatchOrder.quote.amount_cents+500,
        currency:"usd",
        payment_intent:"pi_test_"+randomUUID(),
        metadata:{
          payment_id:mismatchOrder.checkout.attempt_id,
          charge_item_id:mismatchOrder.submitted.charge.charge_item_id,
          org_id:registration.org_id,
          purpose:"inspection",
          quote_revision:String(mismatchOrder.quote.revision),
        },
      },
    },
  });
  const mismatchSig=Stripe.webhooks.generateTestHeaderString({payload:mismatchPayload,secret:webhookSecret});
  const mismatchRes=await handle(new Request(origin+"/api/v1/webhooks/stripe",{
    method:"POST",
    headers:{"content-type":"application/json","stripe-signature":mismatchSig},
    body:mismatchPayload,
  }),"/webhooks/stripe");
  assert.equal(mismatchRes.status,409);
  assert.equal((await mismatchRes.json()).error.code,"PAYMENT_AMOUNT_MISMATCH");
  assert.equal((await c.fetch("/orders/"+mismatchOrder.draft.id)).state,"awaiting_payment");
  assert((await pool.query("select 1 from tickets where category='payment_refund' and details->>'payment_id'=$1",[mismatchOrder.checkout.attempt_id])).rowCount!>=1);

  process.env.QCW_DEMO="1";

  const holdOrder=await submitNewOrder();
  const held=await admin.fetch(`/staff/orders/${holdOrder.draft.id}/hold`,{
    revision:holdOrder.submitted.order.revision,
    reason:"Verify declared seller SKU before sample activation.",
  });
  assert.equal(held.state,"on_hold");
  assert.equal(held.held_from_state,"awaiting_payment");
  const heldView=await c.fetch("/orders/"+holdOrder.draft.id);
  assert.equal(heldView.state,"on_hold");
  assert.equal(heldView.hold_reason,"Verify declared seller SKU before sample activation.");

  await c.fetch(`/checkout/demo/${holdOrder.checkout.attempt_id}`,{});
  assert.equal((await c.fetch("/orders/"+holdOrder.draft.id)).state,"on_hold");
  assert.equal((await c.fetch("/orders/"+holdOrder.draft.id)).items.filter((x:{id:string|null})=>x.id!==null).length,0);

  const resumed=await admin.fetch(`/staff/orders/${holdOrder.draft.id}/resume`,{
    revision:held.revision,
    reason:"Seller SKU verified; resume order.",
  });
  assert.equal(resumed.state,"awaiting_samples");
  await c.fetch(`/checkout/demo/${holdOrder.checkout.attempt_id}`,{});
  const afterResume=await c.fetch("/orders/"+holdOrder.draft.id);
  assert.equal(afterResume.state,"awaiting_samples");
  assert.equal(afterResume.items.filter((x:{id:string|null})=>x.id!==null).length,1);

  const cancelOrder=await submitNewOrder();
  const cancelled=await c.fetch(`/orders/${cancelOrder.draft.id}/cancel`,{
    revision:cancelOrder.submitted.order.revision,
    reason:"Seller out of stock before shipment.",
  });
  assert.equal(cancelled.state,"cancelled");
  await c.fetch(`/checkout/demo/${cancelOrder.checkout.attempt_id}`,{});
  const afterLatePay=await c.fetch("/orders/"+cancelOrder.draft.id);
  assert.equal(afterLatePay.state,"cancelled");
  assert.equal(afterLatePay.items.filter((x:{id:string|null})=>x.id!==null).length,0);
  const {rows:lateTickets}=await pool.query(
    "select id,order_id from tickets where category='payment_refund' and details->>'payment_id'=$1",
    [cancelOrder.checkout.attempt_id]
  );
  assert.equal(lateTickets.length,1);
  assert.equal(lateTickets[0].order_id,cancelOrder.draft.id);

  const billingRes=await c.fetch("/me/billing");
  assert(billingRes.charges.some((ch:{charge_item_id:string;state:string})=>ch.charge_item_id===holdOrder.submitted.charge.charge_item_id&&ch.state==="paid"));

  const oldAddrId=registration.warehouse_address.id;
  const trackingBefore="ZT"+randomUUID().slice(0,8).toUpperCase();
  const adviceBefore=await c.fetch("/me/parcels",{
    address_id:oldAddrId,carrier_code:"zto",tracking_no:trackingBefore,order_ids:[holdOrder.draft.id],
  },"POST",201);
  const newAddr=await admin.fetch("/staff/admin/warehouse-addresses",{
    code:"SZ-WH-"+randomUUID().slice(0,6).toUpperCase(),
    contact_name:"QC Warehouse Receiving Desk B",
    contact_phone:"0755-88889999",
    address_zh:"广东省深圳市宝安区测试路88号B仓",
    address_en:"Warehouse B, 88 Test Rd, Baoan, Shenzhen",
    is_default:true,
  },"POST",200);
  try {
    const currentReceiving=await c.fetch("/me/receiving-address");
    assert.equal(currentReceiving.receiving_code,registration.receiving_code);
    assert.equal(currentReceiving.warehouse_address.id,newAddr.id);
    const trackingAfter="ZT"+randomUUID().slice(0,8).toUpperCase();
    const adviceAfter=await c.fetch("/me/parcels",{
      address_id:newAddr.id,carrier_code:"zto",tracking_no:trackingAfter,order_ids:[holdOrder.draft.id],
    },"POST",201);
    const deskAdvices=(await c.fetch("/me/desk")).advices as {id:string;address_snapshot:{id:string};order_numbers:string[]}[];
    const snapBefore=deskAdvices.find(a=>a.id===adviceBefore.id)!;
    const snapAfter=deskAdvices.find(a=>a.id===adviceAfter.id)!;
    assert.equal(snapBefore.address_snapshot.id,oldAddrId);
    assert.equal(snapAfter.address_snapshot.id,newAddr.id);
    assert(snapAfter.order_numbers.includes(holdOrder.draft.public_no));
  } finally {
    await pool.query("update warehouse_addresses set is_default=false,active=false where id=$1",[newAddr.id]);
    await pool.query("update warehouse_addresses set is_default=true,active=true where id=$1",[oldAddrId]);
  }
});

test("bilingual tracking freshness, out-of-order callbacks, manual translation review, manual refresh cooldown and waybill correction",async()=>{
  const {c,registration}=await signCustomer();
  const receiving=await staffLogin("receiving"),admin=await staffLogin("admin");
  const wrongWaybill="YTO"+randomUUID().slice(0,8).toUpperCase();
  const rightWaybill="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,carrier_code:"yto",tracking_no:wrongWaybill,
  },"POST",201);
  const parcelPath="/me/parcels/"+advice.id;
  const verBefore=await c.fetch(parcelPath+"/tracking-verification");
  const corrected=await c.fetch(parcelPath+"/correct",{
    revision:verBefore.revision,carrier_code:"zto",tracking_no:rightWaybill,reason:"Seller sent updated ZTO waybill.",
  });
  assert.equal(corrected.tracking_no,rightWaybill);
  const trackerId=corrected.tracking_id;
  const {rows:trackers}=await pool.query(
    "select id,generation,sync_state,closed_at,tracking_norm from tracking_records where advice_id=$1 order by generation",
    [advice.id]
  );
  assert.equal(trackers.length,2);
  assert.equal(trackers[0].sync_state,"superseded");
  assert(trackers[0].closed_at);
  assert.equal(trackers[1].id,trackerId);
  assert.equal(trackers[1].generation,2);

  const refreshed=await c.fetch(parcelPath+"/tracking/refresh",{},"POST",202);
  assert.equal(refreshed.queued,true);
  assert(refreshed.next_allowed_at);
  const rateLimited=await c.fetch(parcelPath+"/tracking/refresh",{},"POST",429);
  assert.equal(rateLimited.error.code,"RATE_LIMITED");

  const token=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
  await pool.query(`insert into tracking_subscriptions(tracker_id,provider,callback_token,salt_ciphertext,credential_version,status)
    values($1,'kuaidi100',$2,$3,'test','active')`,[trackerId,token,encryptSecret(salt)]);
  const callback="/webhooks/tracking/kuaidi100/"+token;
  async function pushCallback(payload:object) {
    const param=JSON.stringify(payload);
    const sign=createHash("md5").update(param+salt).digest("hex").toUpperCase();
    const res=await handle(new Request(origin+"/api/v1"+callback,{method:"POST",body:new URLSearchParams({sign,param})}),callback);
    assert.equal(res.status,200);
    for(let i=0;i<50;i++){if(!await workOnce())break;}
  }

  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:rightWaybill,state:"3",
      data:[
        {context:"快件已签收，派件员电话 13812345678，取件码: A8-902",ftime:"2026-11-05 14:00:00",statusCode:"301"},
        {context:"快件已到达代收点柜机",ftime:"2026-11-05 14:00:00",statusCode:"302"},
      ],
    },
  });
  const {rows:eventsAfterDelivered}=await pool.query(
    "select id,text_zh,occurred_at from tracking_events where tracker_id=$1 order by occurred_at desc,text_zh asc",
    [trackerId]
  );
  assert.equal(eventsAfterDelivered.length,2);
  const enUpdating=await c.fetch(parcelPath+"/tracking?locale=en");
  assert.equal(enUpdating.transport_state,"delivered");
  assert.equal(enUpdating.warehouse_state,null);
  assert.equal(enUpdating.translation_status,"updating");

  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:rightWaybill,state:"0",
      data:[{context:"快件在途中",ftime:"2026-11-05 10:00:00",statusCode:"001"}],
    },
  });
  assert.equal((await c.fetch(parcelPath+"/tracking?locale=en")).transport_state,"delivered");

  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:rightWaybill,state:"6",
      data:[
        {context:"快件退回中",ftime:"2026-11-05 16:00:00",statusCode:"601"},
        {context:"快件已签收，派件员电话 13812345678，取件码: A8-902",ftime:"2026-11-05 14:00:00",statusCode:"301"},
      ],
    },
  });
  const afterReturn=await c.fetch(parcelPath+"/tracking?locale=en");
  assert.equal(afterReturn.transport_state,"returning");
  const {rows:returnAlerts}=await pool.query(
    "select kind,episode from tracking_alerts where tracker_id=$1 order by episode",
    [trackerId]
  );
  assert(returnAlerts.some(a=>a.kind==="returning"&&a.episode===1));

  await pushCallback({
    status:"abort",message:"3 days no update",
    lastResult:{
      com:"zhongtong",nu:rightWaybill,state:"6",
      data:[{context:"快件退回中",ftime:"2026-11-05 16:00:00",statusCode:"601"}],
    },
  });
  assert.equal((await c.fetch(parcelPath+"/tracking?locale=en")).sync_state,"stopped");
  const {rows:abortAlerts}=await pool.query(
    "select kind from tracking_alerts where tracker_id=$1 and kind='subscription_aborted'",
    [trackerId]
  );
  assert.equal(abortAlerts.length,1);

  const {rows:[latestEvent]}=await pool.query(
    "select id,text_zh from tracking_events where tracker_id=$1 order by occurred_at desc limit 1",
    [trackerId]
  );
  const sourceHash=createHash("sha256").update(latestEvent.text_zh).digest("hex");
  const draftTr=await receiving.fetch(`/staff/tracking/${trackerId}/translations`,{
    tracking_event_id:latestEvent.id,
    source_hash:sourceHash,
    text_en:"Parcel is returning to sender, courier phone 13900001111, pickup code: Z9-111",
  },"POST",201);
  await receiving.fetch(`/staff/tracking-translations/${draftTr.id}/approve`,{},"POST",403);
  await admin.fetch(`/staff/tracking-translations/${draftTr.id}/approve`,{},"POST",200);
  const enReviewed=await c.fetch(parcelPath+"/tracking?locale=en");
  assert.equal(enReviewed.translation_status,"ready");
  assert.equal(enReviewed.events[0].source,"manual_reviewed");
  assert(enReviewed.events[0].text.includes("[phone redacted]"));
  assert(enReviewed.events[0].text.includes("[pickup code redacted]"));
  assert(!enReviewed.events[0].text.includes("13900001111"));
  assert(!enReviewed.events[0].text.includes("Z9-111"));

  const outer=await receiving.photo("intake_outer");
  await receiving.fetch("/staff/intake/check-in",{
    tracking_no:rightWaybill,carrier_code:"zto",outer_media_ids:[outer],
  },"POST",201);
  const verAfterCheckin=await c.fetch(parcelPath+"/tracking-verification");
  await c.fetch(parcelPath+"/correct",{
    revision:verAfterCheckin.revision,carrier_code:"sf",tracking_no:"SF"+randomUUID().slice(0,8).toUpperCase(),reason:"Too late",
  },"POST",409);

  const {rows:[curTracker]}=await pool.query("select revision from tracking_records where id=$1",[trackerId]);
  const staffWaybill="SF"+randomUUID().slice(0,8).toUpperCase();
  const staffCorrected=await admin.fetch(`/staff/tracking/${trackerId}/correct`,{
    revision:curTracker.revision,carrier_code:"sf",tracking_no:staffWaybill,reason:"Verified physical SF label over ZTO sticker.",
  });
  assert.equal(staffCorrected.tracking_no,staffWaybill);
});

test("account security, identity linking, email change, dual-control recovery, restriction/closure, and payment email deep links (TASK-167, TASK-168, TASK-050)",async()=>{
  const admin=await staffLogin("admin");
  const {c,registration,terms,email}=await signCustomer();
  const offer=(await c.fetch("/catalog")).offers.find((o:{service:string})=>o.service==="inspection");

  // 1. TASK-050 & T39: payment.confirmed email has [TEST] prefix for test orders and parcel deep link
  const {draft}=await createAndPay(c,[{
    category_id:offer.category_id,offer_id:offer.offer_id,quantity:1,options:{},
    attributes:{name:"Parka"},items:[{position:1,sample_code:"S-1-1",name:"Parka"}],
  }],terms);
  await pool.query("update orders set is_test=true where id=$1",[draft.id]);
  while(await workOnce());
  const {rows:payEmails}=await pool.query(
    `select n.template,n.order_id,n.payload from email_deliveries d join notifications n on n.id=d.notification_id
     where n.user_id=$1 and n.template='payment.confirmed' order by n.created_at desc limit 1`,
    [registration.user_id]
  );
  assert.equal(payEmails.length,1);
  assert.equal(payEmails[0].order_id,draft.id);
  const {renderEmailContent}=await import("../packages/core/email");
  const rendered=renderEmailContent("payment.confirmed",draft.public_no,true);
  assert(rendered.subject.startsWith("[TEST] "));
  assert(rendered.text.includes(`/orders/${draft.public_no}/parcels`));

  // Cancel the paid order so we can test closure later after clearing obligations
  const ordDetail=await c.fetch("/orders/"+draft.id);
  await c.fetch(`/orders/${draft.id}/cancel`,{revision:ordDetail.revision,reason:"Clear order for security test"});

  // 2. T94: Sensitive operations require recent reauthentication
  await c.fetch("/me/email-change/request",{new_email:"next-"+email},"POST",403);
  const reauthStart=await c.fetch("/auth/reauth/start",{},"POST",202);
  assert(reauthStart.demo_code);
  const reauthOk=await c.fetch("/auth/reauth/verify",{challenge_id:reauthStart.challenge_id,code:reauthStart.demo_code});
  assert.equal(reauthOk.reauthenticated,true);

  // 3. T88, T90, T92: Identity listing, linking, duplicate link guard, and last login method guard
  const idList1=await c.fetch("/me/identities");
  assert.equal(idList1.reauthenticated,true);
  assert.equal(idList1.identities.length,1);
  const emailIdentityId=idList1.identities[0].id;
  const lastMethodErr=await c.fetch(`/me/identities/${emailIdentityId}`,{},"DELETE",409);
  assert.equal(lastMethodErr.error.code,"LAST_LOGIN_METHOD");

  // Create a verified Microsoft OIDC challenge bound to this browser & user to test linking
  const msSubject="ms-sub-"+randomUUID();
  const msOtp=await c.fetch("/auth/otp/request",{email},"POST",202);
  const msCodeHash=createHmac("sha256",process.env.AUTH_OTP_PEPPER!).update(`${msOtp.challenge_id}:link:${msOtp.demo_code}`).digest("hex");
  await pool.query(
    `update verification_challenges set purpose='link',initiator_user_id=$2,code_hmac=$3,verified_identity=$4 where id=$1`,
    [msOtp.challenge_id,registration.user_id,msCodeHash,{provider:"microsoft",issuer:"https://login.microsoftonline.com/common/v2.0",subject:msSubject,email}]
  );
  const linkedMs=await c.fetch("/me/identities/microsoft/link",{challenge_id:msOtp.challenge_id,code:msOtp.demo_code});
  assert.equal(linkedMs.provider,"microsoft");

  // Another customer attempting to link the same Microsoft subject gets 409 IDENTITY_ALREADY_LINKED (T90)
  const {c:otherC,registration:otherReg,email:otherEmail}=await signCustomer();
  const otherReauth=await otherC.fetch("/auth/reauth/start",{},"POST",202);
  await otherC.fetch("/auth/reauth/verify",{challenge_id:otherReauth.challenge_id,code:otherReauth.demo_code});
  const dupOtp=await otherC.fetch("/auth/otp/request",{email:otherEmail},"POST",202);
  const dupCodeHash=createHmac("sha256",process.env.AUTH_OTP_PEPPER!).update(`${dupOtp.challenge_id}:link:${dupOtp.demo_code}`).digest("hex");
  await pool.query(
    `update verification_challenges set purpose='link',initiator_user_id=$2,code_hmac=$3,verified_identity=$4 where id=$1`,
    [dupOtp.challenge_id,otherReg.user_id,dupCodeHash,{provider:"microsoft",issuer:"https://login.microsoftonline.com/common/v2.0",subject:msSubject,email:otherEmail}]
  );
  const dupErr=await otherC.fetch("/me/identities/microsoft/link",{challenge_id:dupOtp.challenge_id,code:dupOtp.demo_code},"POST",409);
  assert.equal(dupErr.error.code,"IDENTITY_ALREADY_LINKED");

  // Unlink Microsoft identity succeeds; unlinking the last remaining identity still fails with LAST_LOGIN_METHOD
  await c.fetch(`/me/identities/${linkedMs.id}`,{},"DELETE",200);
  await c.fetch(`/me/identities/${emailIdentityId}`,{},"DELETE",409);

  // 4. T91 & T94: Two-step primary email change preserves receiving_code and revokes other device sessions
  const secondDevice=new Client();
  assert.equal((await secondDevice.login(email)).state,"signed_in");
  const sessionsBefore=await c.fetch("/me/sessions");
  assert.equal(sessionsBefore.sessions.length,2);

  const newEmail="changed-"+randomUUID()+"@qcw.test";
  const changeReq=await c.fetch("/me/email-change/request",{new_email:newEmail},"POST",202);
  assert(changeReq.current_demo_code && changeReq.new_demo_code);
  const changeConfirm=await c.fetch("/me/email-change/confirm",{
    current_challenge_id:changeReq.current_challenge_id,
    current_code:changeReq.current_demo_code,
    new_challenge_id:changeReq.new_challenge_id,
    new_code:changeReq.new_demo_code,
  });
  assert.equal(changeConfirm.revoked_other_sessions,true);
  assert.equal(changeConfirm.primary_email,newEmail);

  // Receiving code is unchanged, other device session is revoked
  const deskAfterChange=await c.fetch("/me/desk");
  assert.equal(deskAfterChange.profile.receiving_code,registration.receiving_code);
  await secondDevice.fetch("/me",undefined,"GET",401);

  // 5. T97: Account recovery with support review + independent super_admin approval + 24h cooldown
  await pool.query("insert into staff_roles(user_id,role) select id,'support' from users where display_name='reviewer' on conflict do nothing");
  staffSessions.delete("reviewer");
  const supportStaff=await staffLogin("reviewer");
  const recoveryClient=new Client();
  const recoveryEmail="recovered-"+randomUUID()+"@qcw.test";
  const recOtp=await recoveryClient.fetch("/auth/otp/request",{email:recoveryEmail,purpose:"recovery"},"POST",202);
  const recSubmitted=await recoveryClient.fetch("/auth/recovery/request",{
    challenge_id:recOtp.challenge_id,
    code:recOtp.demo_code,
    previous_email:newEmail,
    details:"Lost email access; receiving code is "+registration.receiving_code,
  },"POST",201);
  assert.equal(recSubmitted.state,"pending_review");

  const statusOpen=await recoveryClient.fetch(
    "/auth/recovery/status?"+new URLSearchParams({request_id:recSubmitted.request_id,token:recSubmitted.status_token})
  );
  assert.equal(statusOpen.state,"pending_review");

  // Support staff performs first-stage review
  const step1=await supportStaff.fetch(`/staff/account-recoveries/${recSubmitted.request_id}/approve`,{
    reason:"Verified receiving code and historical order details.",
  });
  assert.equal(step1.state,"awaiting_approval");

  // Super admin approves (without emergency override first -> sets 24h cooldown)
  await pool.query("update sessions set mfa_at=now() where token_hash=$1",[admin.sessionHash()]);
  const step2=await admin.fetch(`/staff/account-recoveries/${recSubmitted.request_id}/approve`,{
    reason:"Independent super_admin approval after support verification.",
  });
  assert.equal(step2.state,"approved");

  // Executing before 24h cooldown expires fails with 409 RECOVERY_COOLDOWN_ACTIVE
  const cooldownErr=await admin.fetch(`/staff/account-recoveries/${recSubmitted.request_id}/execute`,{},"POST",409);
  assert.equal(cooldownErr.error.code,"RECOVERY_COOLDOWN_ACTIVE");

  // Fast-forward cooldown and execute
  await pool.query("update recovery_requests set execute_after=now()-interval '1 minute' where id=$1",[recSubmitted.request_id]);
  const executed=await admin.fetch(`/staff/account-recoveries/${recSubmitted.request_id}/execute`,{});
  assert.equal(executed.state,"executed");
  assert(executed.executed_at);

  // Old session is revoked; signing in with recoveryEmail opens the existing account with the same receiving_code
  await c.fetch("/me",undefined,"GET",401);
  const recoveredSession=new Client();
  assert.equal((await recoveredSession.login(recoveryEmail)).state,"signed_in");
  assert.equal((await recoveredSession.fetch("/me/receiving-address")).receiving_code,registration.receiving_code);

  // 6. T98: Account restriction blocks new orders/payments while keeping existing records accessible, and account closure reserves receiving_code
  await admin.fetch(`/staff/users/${registration.user_id}/status`,{
    status:"restricted",reason:"Temporary payment risk review",
  });
  // Can still read desk
  assert.equal((await recoveredSession.fetch("/me/desk")).profile.receiving_code,registration.receiving_code);
  // Creating a draft and trying to submit is blocked with 403 ACCOUNT_RESTRICTED
  const restrictedDraft=await recoveredSession.fetch("/orders",{lines:[{
    category_id:offer.category_id,offer_id:offer.offer_id,quantity:1,options:{},
    attributes:{name:"Blocked item"},items:[{position:1,sample_code:"S-1-1",name:"Blocked item"}],
  }]},"POST",201);
  const restrictedQuote=await recoveredSession.fetch("/orders/"+restrictedDraft.id+"/quotes",{revision:restrictedDraft.revision},"POST",201);
  const restrictedErr=await recoveredSession.fetch("/orders/"+restrictedDraft.id+"/submit",{
    revision:restrictedDraft.revision,quote_id:restrictedQuote.id,terms_version_ids:terms.map((t:{id:string})=>t.id),
    acknowledgements:{scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true},
  },"POST",403);
  assert.equal(restrictedErr.error.code,"ACCOUNT_RESTRICTED");

  // Restore active status
  await admin.fetch(`/staff/users/${registration.user_id}/status`,{
    status:"active",reason:"Risk review cleared",
  });

  // Reauthenticate and attempt closure while draft order is still open -> 409 ACCOUNT_HAS_ACTIVE_OBLIGATIONS
  const closeReauth=await recoveredSession.fetch("/auth/reauth/start",{},"POST",202);
  await recoveredSession.fetch("/auth/reauth/verify",{challenge_id:closeReauth.challenge_id,code:closeReauth.demo_code});
  const obligationErr=await recoveredSession.fetch("/me/account/close",{},"POST",409);
  assert.equal(obligationErr.error.code,"ACCOUNT_HAS_ACTIVE_OBLIGATIONS");

  // Cancel the draft order and close the account
  await recoveredSession.fetch(`/orders/${restrictedDraft.id}/cancel`,{revision:restrictedDraft.revision,reason:"Closing account"});
  const closed=await recoveredSession.fetch("/me/account/close",{});
  assert.equal(closed.closed,true);
  await recoveredSession.fetch("/me",undefined,"GET",401);

  // Re-signing in with the same email starts onboarding for a brand-new account with a different receiving_code
  const freshClient=new Client();
  assert.equal((await freshClient.login(recoveryEmail)).state,"onboarding");
});

test("presigned media upload, sha256 verification, 800px thumbnails, 24h stale cleanup, unified warehouse scan, and label print/readback (TASK-051 to TASK-055)",async()=>{
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const {c,registration}=await signCustomer();
  const {c:otherCustomer}=await signCustomer();

  // 1. TASK-051 & T36: Presigned upload with checksum mismatch is rejected with 422 MEDIA_CHECKSUM_MISMATCH
  const imgBytes=await sharp({create:{width:1200,height:900,channels:3,background:"#1f4e78"}})
    .withExif({IFD0:{DateTime:"2026:11:06 08:15:30"}})
    .jpeg({quality:90})
    .toBuffer();
  const realSha=createHash("sha256").update(imgBytes).digest("hex");
  const wrongSha="0".repeat(64);

  const badTicket=await receiving.fetch("/media/upload-url",{
    kind:"intake_outer",mime:"image/jpeg",size_bytes:imgBytes.length,sha256:wrongSha,
  },"POST",201);
  // Referencing a pending media asset in check-in fails with 409 MEDIA_NOT_READY
  const notReadyErr=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:"ZTO"+randomUUID().slice(0,8).toUpperCase(),carrier_code:"zto",outer_media_ids:[badTicket.media_id],
  },"POST",409);
  assert.equal(notReadyErr.error.code,"MEDIA_NOT_READY");

  const badPutPath=new URL(badTicket.upload_url).pathname.replace(/^\/api\/v1/,"")+new URL(badTicket.upload_url).search;
  await receiving.fetch(badPutPath,imgBytes,"PUT",200);
  const checksumErr=await receiving.fetch(`/media/${badTicket.media_id}/complete`,{},"POST",422);
  assert.equal(checksumErr.error.code,"MEDIA_CHECKSUM_MISMATCH");
  const {rows:[rejectedRow]}=await pool.query("select status from media_assets where id=$1",[badTicket.media_id]);
  assert.equal(rejectedRow.status,"rejected");

  // 2. TASK-051 & TASK-052: Valid presigned upload generates 800px thumbnail, parses EXIF captured_at, and is idempotent on complete
  const goodTicket=await receiving.fetch("/media/upload-url",{
    kind:"intake_outer",mime:"image/jpeg",size_bytes:imgBytes.length,sha256:realSha,
  },"POST",201);
  const goodPutPath=new URL(goodTicket.upload_url).pathname.replace(/^\/api\/v1/,"")+new URL(goodTicket.upload_url).search;
  await receiving.fetch(goodPutPath,imgBytes,"PUT",200);
  const completed1=await receiving.fetch(`/media/${goodTicket.media_id}/complete`,{});
  assert.equal(completed1.status,"ready");
  assert.equal(completed1.width,1200);
  assert.equal(completed1.height,900);
  assert(completed1.thumb_key?.startsWith("thumb/"));
  assert(String(completed1.captured_at).startsWith("2026-11-06T08:15:30"));
  // Calling complete again is idempotent
  const completed2=await receiving.fetch(`/media/${goodTicket.media_id}/complete`,{});
  assert.equal(completed2.id,goodTicket.media_id);

  // Signed URL endpoint returns 10-minute URLs for original and 800px thumbnail
  const signedUrls=await receiving.fetch(`/media/${goodTicket.media_id}/url`);
  assert(signedUrls.url.includes("variant=original"));
  assert(signedUrls.thumb_url.includes("variant=thumb"));
  const thumbPath=new URL(signedUrls.thumb_url).pathname.replace(/^\/api\/v1/,"")+new URL(signedUrls.thumb_url).search;
  const thumbResp=await receiving.fetch(thumbPath);
  const thumbMeta=await sharp(thumbResp.image).metadata();
  assert.equal(thumbMeta.width,800);
  assert.equal(thumbMeta.height,600);

  // T25: Cross-tenant customer cannot get signed URL or read another org/staff photo (404)
  const custTicket=await c.fetch("/media/upload-url",{
    kind:"attachment",mime:"image/jpeg",size_bytes:imgBytes.length,sha256:realSha,
  },"POST",201);
  const custPutPath=new URL(custTicket.upload_url).pathname.replace(/^\/api\/v1/,"")+new URL(custTicket.upload_url).search;
  await c.fetch(custPutPath,imgBytes,"PUT",200);
  await c.fetch(`/media/${custTicket.media_id}/complete`,{});
  assert((await c.fetch(`/media/${custTicket.media_id}/url`)).url);
  await otherCustomer.fetch(`/media/${custTicket.media_id}/url`,undefined,"GET",404);
  await otherCustomer.fetch(`/media/${custTicket.media_id}`,undefined,"GET",404);

  // 3. T37: Stale pending uploads older than 24 hours are cleaned up
  const staleTicket=await receiving.fetch("/media/upload-url",{
    kind:"intake_outer",mime:"image/jpeg",size_bytes:imgBytes.length,sha256:realSha,
  },"POST",201);
  const stalePutPath=new URL(staleTicket.upload_url).pathname.replace(/^\/api\/v1/,"")+new URL(staleTicket.upload_url).search;
  await receiving.fetch(stalePutPath,imgBytes,"PUT",200);
  await pool.query("update media_assets set created_at=now()-interval '25 hours' where id=$1",[staleTicket.media_id]);
  const {cleanupStaleMediaUploads}=await import("../packages/core/media");
  const cleaned=await cleanupStaleMediaUploads(pool);
  assert(cleaned.media_ids.includes(staleTicket.media_id));
  const {rowCount:staleRemaining}=await pool.query("select 1 from media_assets where id=$1",[staleTicket.media_id]);
  assert.equal(staleRemaining,0);

  // 4. TASK-054: Unified warehouse scan (/staff/scan/{code}) for waybill, P- package, and S- item, plus role guard
  const {warehouse_address:addr}=await c.fetch("/me/receiving-address");
  const waybillNo="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:addr.id,tracking_no:waybillNo,carrier_code:"zto",order_ids:[]},"POST",201);
  // Inspector without intake role cannot scan raw seller waybills (403)
  await inspector.fetch("/staff/scan/"+waybillNo,undefined,"GET",403);
  const scanWaybill=await receiving.fetch("/staff/scan/"+waybillNo);
  assert.equal(scanWaybill.kind,"waybill");
  assert.equal(scanWaybill.receiving_code,registration.receiving_code);
  assert(scanWaybill.allowed_actions.includes("check_in"));

  // Check in and unpack using the presigned outer photo
  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:waybillNo,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[goodTicket.media_id],
  },"POST",201);
  const {locations}=await receiving.fetch("/staff/desk");
  const r01=locations.find((l:{code:string})=>l.code==="R-01")??locations[0];
  const sampleCode="S-"+randomUUID().slice(0,8).toUpperCase();
  const unpacked=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,items:[{code:sampleCode,location_id:r01.id}],
  },"POST",201);
  const sampleItem={id:unpacked.item_ids[0],code:sampleCode};

  const pkgDetail=await receiving.fetch("/staff/packages/"+pkg.id);
  const pkgCode=pkgDetail.parcel.code;
  const scanPkg=await receiving.fetch("/staff/scan/"+pkgCode);
  assert.equal(scanPkg.kind,"package");
  assert.equal(scanPkg.package_id,pkg.id);
  assert(scanPkg.allowed_actions.includes("print_label"));

  const scanItem=await receiving.fetch("/staff/scan/"+encodeURIComponent(sampleItem.code));
  assert.equal(scanItem.kind,"item");
  assert.equal(scanItem.item_id,sampleItem.id);
  assert(scanItem.allowed_actions.includes("print_label"));

  // 5. TASK-055: Label printing (P-/S- codes only, PDF output, reprint reason guard) and readback verification
  const firstPrint=await receiving.fetch("/staff/labels/print",{
    package_id:pkg.id,item_ids:[sampleItem.id],
  });
  assert.equal(firstPrint.labels.length,2);
  assert.equal(firstPrint.labels[0].reprint,false);
  assert.equal(firstPrint.labels[0].qr_payload,pkgCode);
  assert.equal(firstPrint.labels[1].qr_payload,sampleItem.code);
  const labelPdf=await receiving.fetch(`/staff/labels/${firstPrint.print_id}/file`);
  assert.equal(labelPdf.pdf.subarray(0,5).toString(),"%PDF-");

  // Reprinting without reprint_reason fails with 422 REPRINT_REASON_REQUIRED
  const reprintErr=await receiving.fetch("/staff/labels/print",{package_id:pkg.id},"POST",422);
  assert.equal(reprintErr.error.code,"REPRINT_REASON_REQUIRED");
  const secondPrint=await receiving.fetch("/staff/labels/print",{
    package_id:pkg.id,reprint_reason:"Label corner wrinkled during shelving",
  });
  assert.equal(secondPrint.labels[0].reprint,true);
  assert.equal(secondPrint.labels[0].print_count,2);

  // Readback verification rejects mismatched barcode and accepts matching barcode
  const mismatchVerify=await receiving.fetch("/staff/labels/verify",{
    expected_code:sampleItem.code,scanned_code:"S-WRONG-999",
  },"POST",409);
  assert.equal(mismatchVerify.error.code,"LABEL_READBACK_MISMATCH");
  const okVerify=await receiving.fetch("/staff/labels/verify",{
    expected_code:sampleItem.code,scanned_code:sampleItem.code,
  });
  assert.equal(okVerify.verified,true);
  assert.equal(okVerify.target_id,sampleItem.id);
});

test("intake quarantine, half-unpacking, suit components, post-pay & cross-order mapping, unmatched owner binding, and zero-order return (TASK-056 to TASK-060, TASK-170)",async()=>{
  const receiving=await staffLogin("receiving");
  const {c,registration,terms}=await signCustomer();
  const termsId=terms.find((t:{kind:string})=>t.kind==="terms")!.id;
  const {locations,rates}=await receiving.fetch("/staff/desk");
  const r01=locations.find((l:{code:string})=>l.code==="R-01")??locations[0];

  // 1. TASK-059 & T11: Unmatched parcel check-in creates internal identity_unclear ticket; staff can bind owner via label receiving_code
  const unmWaybill="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const outer1=await receiving.photo("intake_outer");
  const outer2=await receiving.photo("intake_outer");
  // TASK-060 & T12/T46: Concurrent check-in of the same waybill produces a single package
  const [unmPkg1,unmPkg2]=await Promise.all([
    receiving.fetch("/staff/intake/check-in",{tracking_no:unmWaybill,carrier_code:"zto",weight_g:820,outer_media_ids:[outer1]},"POST",201),
    receiving.fetch("/staff/intake/check-in",{tracking_no:unmWaybill,carrier_code:"zto",weight_g:820,outer_media_ids:[outer2]},"POST",201),
  ]);
  assert.equal(unmPkg1.id,unmPkg2.id);
  assert.equal(unmPkg1.state,"unmatched");

  const {rows:unmTickets}=await pool.query(
    "select id,state from tickets where category='identity_unclear' and org_id is null and details->>'package_id'=$1",
    [unmPkg1.id]
  );
  assert.equal(unmTickets.length,1);
  assert.equal(unmTickets[0].state,"open");

  const bound=await receiving.fetch(`/staff/packages/${unmPkg1.id}/bind-owner`,{
    revision:unmPkg1.revision,
    receiving_code:registration.receiving_code,
    evidence_ids:[await receiving.photo("label_photo")],
    reason:"Verified customer receiving code printed on shipping label",
  });
  assert.equal(bound.state,"checked_in");
  assert.equal(bound.receiving_code,registration.receiving_code);
  const {rows:[resolvedUnm]}=await pool.query("select state from tickets where id=$1",[unmTickets[0].id]);
  assert.equal(resolvedUnm.state,"resolved");

  // 2. TASK-058 & TASK-170 & T101: Half-unpacking (2 batches) + suit sub-component (component_of does not inflate received_quantity)
  const mainCode1="S-"+randomUUID().slice(0,8).toUpperCase();
  const batch1=await receiving.fetch(`/staff/packages/${unmPkg1.id}/items`,{
    revision:bound.revision,
    items:[{code:mainCode1,location_id:r01.id}],
  },"POST",201);
  const mainItem1Id=batch1.item_ids[0];

  const compCode1="S-"+randomUUID().slice(0,8).toUpperCase();
  const mainCode2="S-"+randomUUID().slice(0,8).toUpperCase();
  const batch2=await receiving.fetch(`/staff/packages/${unmPkg1.id}/items`,{
    revision:batch1.revision,
    items:[
      {code:compCode1,location_id:r01.id,component_of:mainItem1Id},
      {code:mainCode2,location_id:r01.id},
    ],
  },"POST",201);
  const mainItem2Id=batch2.item_ids[1];

  const pkgView=await receiving.fetch(`/staff/packages/${unmPkg1.id}`);
  assert.equal(pkgView.parcel.received_quantity,2); // 2 top-level items, 1 sub-component excluded from billable count
  const batchIds=new Set(pkgView.items.map((x:{intake_batch_id:string})=>x.intake_batch_id));
  assert.equal(batchIds.size,2); // 2 distinct unpacking batches

  const item1View=await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:mainCode1}));
  assert.equal(item1View.item.components.length,1);
  assert.equal(item1View.item.components[0].code,compCode1);

  // 3. TASK-170 & T101: Post-payment order creation (先入仓后付费) and cross-order reassignment (跨本人订单映射)
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const {draft:order1}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:2}],terms);
  const {draft:order2}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],terms);

  // Assign mainItem1Id to order1 position 1 (leaves order1 in awaiting_samples because quantity is 2)
  const item1Positions=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:mainCode1}))).positions;
  const o1Pos=item1Positions.find((p:{public_no:string})=>p.public_no===order1.public_no);
  assert(o1Pos);
  const assigned1=await receiving.fetch(`/staff/items/${mainItem1Id}/assign`,{
    revision:1,order_line_id:o1Pos.order_line_id,expected_item_id:o1Pos.id,evidence_ids:[await receiving.photo("label_photo")],
  });
  assert(assigned1.assignment_id);

  // Now unassign mainItem1Id from order1 and reassign it to order2 (cross-order mapping on the same warehouse_item without recreating inventory)
  const unassigned=await receiving.fetch(`/staff/items/${mainItem1Id}/unassign`,{
    revision:assigned1.revision,reason:"Customer requested mapping this suit to their single-item order",
  });
  assert.equal(unassigned.unlinked_assignment_id,assigned1.assignment_id);

  const refreshedPositions=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:mainCode1}))).positions;
  const o2Pos=refreshedPositions.find((p:{public_no:string})=>p.public_no===order2.public_no);
  assert(o2Pos);
  await receiving.fetch(`/staff/items/${mainItem1Id}/assign`,{
    revision:unassigned.revision,order_line_id:o2Pos.order_line_id,expected_item_id:o2Pos.id,evidence_ids:[await receiving.photo("label_photo")],
  });
  // order2 had 1 item and was already paid -> enters queued once!
  const o2Detail=await c.fetch(`/orders/${order2.id}`);
  assert.equal(o2Detail.state,"queued");

  // 4. TASK-170 & T107: Zero-order uncommissioned item return to seller (mainItem2Id has no inspection order)
  const disp=await c.fetch(`/me/items/${mainItem2Id}/dispositions`,{
    action:"return_to_seller",
    destination:{recipient:"Seller Return Dept",phone:"13800138000",address:"No. 88 Return Rd, Hangzhou"},
    return_info:{requested_from_seller:true,customer_pays_shipping:true},
    terms_version_id:termsId,
  },"POST",201);
  const {shipment,actual:returnWaybill}=await shipOne(c,receiving,rates[0].id,disp.id,mainItem2Id);
  const returnTrack=await c.fetch(`/shipments/${shipment.shipment_id}/tracking`);
  assert.equal(returnTrack.tracking_no,returnWaybill);
  assert.equal(returnTrack.direction,"outbound_return");
  assert.equal(returnTrack.warehouse_state,"shipped");

  // 5. TASK-057: Restricted / prohibited parcel quarantine blocks unpacking and outbound release
  const quarWaybill="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const quarAdvice=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,tracking_no:quarWaybill,carrier_code:"zto",order_ids:[],
  },"POST",201);
  const quarPkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:quarWaybill,advice_id:quarAdvice.id,carrier_code:"zto",outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const quarResult=await receiving.fetch(`/staff/packages/${quarPkg.id}/quarantine`,{
    revision:quarPkg.revision,reason:"Contains prohibited pressurized aerosol container",
  });
  assert.equal(quarResult.state,"quarantined");
  assert(quarResult.ticket_id);
  const unpackQuarErr=await receiving.fetch(`/staff/packages/${quarPkg.id}/items`,{
    revision:quarResult.revision,items:[{code:"S-"+randomUUID().slice(0,8).toUpperCase(),location_id:r01.id}],
  },"POST",409);
  assert.equal(unpackQuarErr.error.code,"PACKAGE_QUARANTINED");
});

test("item identity mismatch, customer discrepancy response, 3-to-2 conversion, upward scope payment, and SLA calendar/hold/resume (TASK-061 to TASK-065)",async()=>{
  const receiving=await staffLogin("receiving");
  const {c,registration,terms}=await signCustomer();
  const {locations}=await receiving.fetch("/staff/desk");
  const r01=locations.find((l:{code:string})=>l.code==="R-01")??locations[0];

  // 1. TASK-064 & T31: businessDeadline skips weekend and statutory holidays (and honors extra_workdays)
  // Friday 2026-10-02 08:00 UTC (16:00 China time, Friday afternoon).
  // Suppose Monday 2026-10-05 and Tuesday 2026-10-06 are statutory holidays, so 2 business days should land on Thursday 2026-10-08!
  const friAfternoon=new Date("2026-10-02T08:00:00.000Z");
  const dueWithHolidays=businessDeadline(friAfternoon,2,["2026-10-05","2026-10-06"],[]);
  assert.equal(new Date(dueWithHolidays.valueOf()+8*3600000).toISOString().slice(0,10),"2026-10-08");

  // 2. TASK-061 & TASK-062 (T14, T47): Mismatch identification -> order on_hold -> customer replace_sample & proceed_as_received
  const cat=(await c.fetch("/catalog")).offers;
  const inspOffer=cat.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");
  const {draft:orderA}=await createAndPay(
    c,
    [{
      category_id:inspOffer.category_id,
      offer_id:inspOffer.offer_id,
      quantity:1,
      items:[{sample_code:"A-01",size_label:"M",color_declared:"Navy"}],
    }],
    terms
  );

  // Check in a parcel with 2 items (first item has wrong size label L instead of M; second item is the replacement)
  const waybillA="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const adviceA=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,tracking_no:waybillA,carrier_code:"zto",order_ids:[orderA.id],
  },"POST",201);
  const pkgA=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:waybillA,advice_id:adviceA.id,carrier_code:"zto",outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const codeWrong="S-"+randomUUID().slice(0,8).toUpperCase();
  const codeReplacement="S-"+randomUUID().slice(0,8).toUpperCase();
  const unpackedA=await receiving.fetch(`/staff/packages/${pkgA.id}/items`,{
    revision:pkgA.revision,
    items:[{code:codeWrong,location_id:r01.id},{code:codeReplacement,location_id:r01.id}],
  },"POST",201);
  const [wrongItemId,replacementItemId]=unpackedA.item_ids;

  const wrongLookup=await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:codeWrong}));
  const posA=wrongLookup.positions.find((p:{public_no:string})=>p.public_no===orderA.public_no);
  assert(posA);

  // Identify wrongItemId as mismatch directly (TASK-061, PAGE-H06, T14)
  const mismatchRes=await receiving.fetch(`/staff/items/${wrongItemId}/identify`,{
    revision:1,
    order_line_id:posA.order_line_id,
    expected_item_id:posA.id,
    matches_advice:false,
    actual_label_info:{size_label:"XL",color_found:"Red"},
    mismatch_note:"Tag reads XL Red instead of declared M Navy",
    media_ids:[await receiving.photo("label_photo")],
  });
  assert.equal(mismatchRes.identity_state,"mismatch");
  assert.equal(mismatchRes.order_state,"on_hold");
  assert(mismatchRes.ticket_id);

  // TASK-065 & T38: Duplicate outbox event for order.identity_mismatch produces only 1 notification and 1 email
  await pool.query(
    `insert into outbox_events(type,payload) values('order.identity_mismatch',$1)`,
    [JSON.stringify({order_id:orderA.id,item_id:wrongItemId,expected_item_id:posA.id,ticket_id:mismatchRes.ticket_id})]
  );
  while(await workOnce()) {}
  const mismatchNotifs=await pool.query(
    `select id from notifications where order_id=$1 and template='order.identity_mismatch'`,
    [orderA.id]
  );
  assert.equal(mismatchNotifs.rowCount,1);

  // Customer responds with replace_sample (TASK-062, PAGE-C07/C08)
  const respReplace=await c.fetch(`/orders/${orderA.id}/mismatch-response`,{
    expected_item_id:posA.id,
    decision:"replace_sample",
    note:"Please unlink the wrong XL item and use the replacement sample in the parcel",
  });
  assert.equal(respReplace.state,"awaiting_samples");

  // Now link replacementItemId and report mismatch first, then customer responds proceed_as_received
  const repMismatch=await receiving.fetch(`/staff/samples/${replacementItemId}/identify`,{
    revision:1,
    order_line_id:posA.order_line_id,
    expected_item_id:posA.id,
    matches_advice:false,
    actual_label_info:{size_label:"M",color_found:"Dark Navy"},
    mismatch_note:"Shade is slightly darker navy than description",
  });
  assert.equal(repMismatch.order_state,"on_hold");

  const respProceed=await c.fetch(`/orders/${orderA.id}/mismatch-response`,{
    expected_item_id:posA.id,
    decision:"proceed_as_received",
    note:"Dark Navy is fine, please proceed with inspection",
  });
  assert.equal(respProceed.state,"queued");

  // 3. TASK-064 & T32: Hold & resume on a queued order extends sla_due_at by the hold duration
  const beforeHold=await c.fetch(`/orders/${orderA.id}`);
  assert(beforeHold.sla_due_at);
  await receiving.fetch(`/staff/orders/${orderA.id}/hold`,{reason:"Temporary equipment calibration check"});
  // Backdate held_at by 2 hours in DB to verify deterministic SLA extension
  await pool.query("update orders set held_at=now()-interval '2 hours' where id=$1",[orderA.id]);
  const resumed=await receiving.fetch(`/staff/orders/${orderA.id}/resume`,{reason:"Calibration verified"});
  assert.equal(resumed.state,"queued");
  const afterResume=await c.fetch(`/orders/${orderA.id}`);
  const deltaMs=new Date(afterResume.sla_due_at).valueOf()-new Date(beforeHold.sla_due_at).valueOf();
  assert(deltaMs>=7100_000,"Expected sla_due_at to be extended by ~2 hours after hold/resume");

  // 4. TASK-063 & T47: 3-to-2 comparison conversion (三改二差额只退一次，迟到件仍可追踪)
  const cmp3Offer=cat.find((o:{sku_code:string})=>o.sku_code==="apparel-compare-3");
  const {draft:cmpOrder}=await createAndPay(
    c,
    [{
      category_id:cmp3Offer.category_id,
      offer_id:cmp3Offer.offer_id,
      quantity:3,
      items:[
        {sample_code:"CMP-A",size_label:"M",color_declared:"Black"},
        {sample_code:"CMP-B",size_label:"M",color_declared:"Black"},
        {sample_code:"CMP-C",size_label:"M",color_declared:"Black"},
      ],
    }],
    terms
  );
  // Extend sample arrival window (POST /orders/{id}/extend)
  const extRes=await c.fetch(`/orders/${cmpOrder.id}/extend`,{
    revision:(await c.fetch(`/orders/${cmpOrder.id}`)).revision,
    extend_days:5,
    reason:"Supplier C delayed dispatch by 5 days",
  });
  assert(extRes.extended_until);
  assert.equal(extRes.sla_due_at,null);

  // Check in 2 items for CMP-A and CMP-B; CMP-C has not arrived yet
  const cmpWaybill="YTO"+randomUUID().slice(0,8).toUpperCase();
  const cmpAdvice=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,tracking_no:cmpWaybill,carrier_code:"yto",order_ids:[cmpOrder.id],
  },"POST",201);
  const cmpPkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:cmpWaybill,advice_id:cmpAdvice.id,carrier_code:"yto",outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const cmpCode1="S-"+randomUUID().slice(0,8).toUpperCase();
  const cmpCode2="S-"+randomUUID().slice(0,8).toUpperCase();
  const cmpUnpacked=await receiving.fetch(`/staff/packages/${cmpPkg.id}/items`,{
    revision:cmpPkg.revision,
    items:[{code:cmpCode1,location_id:r01.id},{code:cmpCode2,location_id:r01.id}],
  },"POST",201);
  const cmpPositions=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:cmpCode1}))).positions
    .filter((p:{public_no:string})=>p.public_no===cmpOrder.public_no);
  assert.equal(cmpPositions.length,3);
  await receiving.fetch(`/staff/items/${cmpUnpacked.item_ids[0]}/assign`,{
    revision:1,order_line_id:cmpPositions[0].order_line_id,expected_item_id:cmpPositions[0].id,evidence_ids:[await receiving.photo("label_photo")],
  });
  await receiving.fetch(`/staff/items/${cmpUnpacked.item_ids[1]}/assign`,{
    revision:1,order_line_id:cmpPositions[1].order_line_id,expected_item_id:cmpPositions[1].id,evidence_ids:[await receiving.photo("label_photo")],
  });

  // Convert 3-to-2 by dropping the 3rd unreceived position (cmpPositions[2])
  const conv=await c.fetch(`/orders/${cmpOrder.id}/convert-to-two`,{
    expected_item_id:cmpPositions[2].id,
    reason:"Sample C is delayed; proceed with 2-item comparison",
  });
  assert.equal(conv.state,"queued"); // 2 retained items are already identified -> immediately enters queued!
  assert.equal(conv.adjustment_cents,-2000); // $59 - $79 = -$20.00
  assert(conv.refund_ticket_id);

  // Attempting convert-to-two a second time is rejected (差额只退一次)
  const convAgain=await c.fetch(`/orders/${cmpOrder.id}/convert-to-two`,{
    expected_item_id:cmpPositions[2].id,
  },"POST",409);
  assert.equal(convAgain.error.code,"CONVERT_TO_TWO_UNAVAILABLE");

  // 5. TASK-063 & T84/T108: Upward scope revision requires supplemental payment before activating new positions; stale supplemental payment cannot activate old scope
  const {draft:upOrder}=await createAndPay(
    c,
    [{category_id:inspOffer.category_id,offer_id:inspOffer.offer_id,quantity:2}],
    terms
  );
  const upScopeView=await c.fetch(`/orders/${upOrder.id}/scope-revisions`);
  const upPosIds=upScopeView.positions.map((p:{id:string})=>p.id);
  const lineId=upScopeView.positions[0].line_id;

  // Propose adding 1 extra item (+$29.00)
  const upProp=await c.fetch(`/orders/${upOrder.id}/scope-additions`,{
    revision:upScopeView.order.revision,
    reason:"Add 1 extra sample sent by seller in the same box",
    positions:upPosIds,
    additions:[{order_line_id:lineId,count:1,declared_fields:[{sample_code:"EXTRA-03",size_label:"L",color_declared:"Black"}]}],
  },"POST",201);
  assert.equal(upProp.adjustment_cents,2900);

  const upAccepted=await c.fetch(`/scope-revisions/${upProp.scope_revision_id}/accept`,{revision:upProp.revision});
  assert.equal(upAccepted.state,"awaiting_supplemental_payment");

  // Before paying the supplemental charge, positions count in scope is still 2
  const afterAcceptView=await c.fetch(`/orders/${upOrder.id}/scope-revisions`);
  assert.equal(afterAcceptView.positions.filter((p:{in_scope:boolean})=>p.in_scope).length,2);
  const suppCharge=afterAcceptView.proposals[0].supplemental_charge;
  assert(suppCharge && !suppCharge.paid);

  // Pay supplemental charge -> activates the 3rd position and resolves scope_payment_pending block!
  const suppCheckout=await c.fetch(`/charges/${suppCharge.id}/checkout`,{quote_revision:suppCharge.quote_revision});
  await c.fetch(new URL(suppCheckout.checkout_url).pathname,{});
  const afterSuppPayView=await c.fetch(`/orders/${upOrder.id}/scope-revisions`);
  assert.equal(afterSuppPayView.positions.filter((p:{in_scope:boolean})=>p.in_scope).length,3);
});

test("inspection workbench: SLA queue, scan switching, multi-component suit, retry measurement policy, shots isolation, step timings, offline conflict, and completeness (TASK-066 to TASK-075)",async()=>{
  const {c,terms}=await signCustomer();
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const reviewer=await staffLogin("reviewer");
  const admin=await staffLogin("admin");

  const desk=await receiving.fetch("/staff/desk");
  const locId=(desk.locations.find((l:{code:string})=>l.code==="R-01")??desk.locations[0]).id as string;

  // Create & publish a multi-component suit template with measurement_policy, derived circumference, parts, and component shots
  const adminDeskData=await admin.fetch("/staff/admin/desk");
  const apparelCat=adminDeskData.categories.find((cat:{slug:string})=>cat.slug==="apparel")!;
  const inspectService=adminDeskData.services.find((s:{code:string})=>s.code==="inspection")!;
  const capId=adminDeskData.capabilities[0].id as string;

  const suitTplContent={
    components:[
      {id:"top",code:"Top (上装)"},
      {id:"bottom",code:"Bottom (下装)"},
    ],
    measure_conditions:"Lay flat on a clean table without stretching.",
    measurement_policy:{
      attempts:2,
      extra_attempt_on_difference:true,
      threshold_by_unit:{cm:0.5,g:1},
    },
    checks:[
      {
        key:"waist_flat",
        label:"Flat width",
        zh:"平铺宽度",
        type:"number",
        unit:"cm",
        method:"Measure flat width with steel tape",
        required:true,
        evidence:true,
        diagram:"leggings.svg#waist",
        derived:{circumference_cm:"value*2"},
      },
      {
        key:"garment_weight",
        label:"Garment weight",
        zh:"整件克重",
        type:"number",
        unit:"g",
        method:"Electronic scale 1g",
        required:true,
        evidence:false,
      },
      {
        key:"stitch_defects",
        label:"Skipped or open stitches",
        zh:"跳线或开线",
        type:"boolean",
        method:"Visual observation",
        required:true,
        evidence:false,
        parts:["front","back","waistband","crotch","hem"],
      },
      {
        key:"pocket_check",
        label:"Pocket lining check",
        zh:"口袋内衬检查",
        type:"boolean",
        method:"Visual observation",
        required:true,
        evidence:false,
        applies_if:{"attributes.has_pocket":true},
      },
    ],
    shots:[
      {code:"front_full",name:"Front full length",zh:"正面全身照",required:true},
    ],
  };

  const suitTpl=await inspector.fetch("/staff/admin/templates",{
    template_key:"apparel-sports-set-test-"+randomUUID().slice(0,8),
    category_id:apparelCat.id,
    service_type_id:inspectService.id,
    capability_ids:[capId],
    content:suitTplContent,
  });
  await reviewer.fetch(`/staff/admin/templates/${suitTpl.id}/publish`,{});

  const suitSku="apparel-suit-test-"+randomUUID().slice(0,6);
  const suitOffer=await admin.fetch("/staff/admin/offers",{
    sku_code:suitSku,
    service_type_id:inspectService.id,
    category_id:apparelCat.id,
    template_version_id:suitTpl.id,
    title:{en:"Sports set inspection","zh-CN":"运动套装逐件检查"},
    enabled:true,
    rules:{minimum:1,maximum:30,unit_cents:3900,business_days:3,demo:true},
  });

  // Create a 2-item standard inspection order on the suit SKU (with has_pocket: false so pocket_check is auto NOT_APPLICABLE)
  const {draft:suitOrder}=await createAndPay(
    c,
    [{
      category_id:apparelCat.id,
      offer_id:suitOffer.id,
      quantity:2,
      attributes:{has_pocket:false},
      items:[
        {sample_code:"SUIT-1",size_label:"M",color_declared:"Black"},
        {sample_code:"SUIT-2",size_label:"M",color_declared:"Navy"},
      ],
    }],
    terms
  );

  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id as string;
  const suitTrk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const suitAdv=await c.fetch("/me/parcels",{address_id:addr,carrier_code:"sf",tracking_no:suitTrk,order_ids:[suitOrder.id]},"POST",201);
  const suitPkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:suitTrk,carrier_code:"sf",advice_id:suitAdv.id,weight_g:920,outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const suitCode1="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const suitCode2="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const suitItems=await receiving.fetch(`/staff/packages/${suitPkg.id}/items`,{
    revision:suitPkg.revision,
    items:[
      {code:suitCode1,location_id:locId},
      {code:suitCode2,location_id:locId},
    ],
  },"POST",201);

  const suitPos=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:suitCode1}))).positions
    .filter((p:{public_no:string})=>p.public_no===suitOrder.public_no);
  assert.equal(suitPos.length,2);

  await receiving.fetch(`/staff/items/${suitItems.item_ids[0]}/identify`,{
    revision:1,order_line_id:suitPos[0].order_line_id,expected_item_id:suitPos[0].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });
  const id2=await receiving.fetch(`/staff/items/${suitItems.item_ids[1]}/identify`,{
    revision:1,order_line_id:suitPos[1].order_line_id,expected_item_id:suitPos[1].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });
  assert.equal(id2.order_state,"queued");

  // 1. TASK-066 & TASK-067: Scan lookup by item code S-... and sibling_tasks list
  const lookup1=await inspector.fetch("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:suitCode1,order_id:suitOrder.id}));
  const lookup2=await inspector.fetch("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:suitCode2,order_id:suitOrder.id}));
  assert.notEqual(lookup1.task_id,lookup2.task_id);
  assert.equal(lookup1.item_code,suitCode1);
  assert.equal(lookup2.item_code,suitCode2);

  const taskId=lookup1.task_id as string;
  const started=await inspector.fetch(`/staff/inspection-tasks/${taskId}/start`,{revision:lookup1.revision});
  assert.equal(started.state,"IN_PROGRESS");

  // Concurrency guard: claiming an already-started task fails with 409
  await inspector.fetch(`/staff/inspection-tasks/${taskId}/start`,{revision:started.revision},"POST",409);

  const detail1=await inspector.fetch(`/staff/inspection-tasks/${taskId}`);
  assert.equal(detail1.sibling_tasks.length,2);
  assert.deepEqual(detail1.components.map((m:{id:string})=>m.id),["top","bottom"]);
  // Rule O3: pocket_check (applies_if has_pocket: true) was automatically seeded as NOT_APPLICABLE on both top and bottom!
  const autoNa=detail1.results.filter((r:{item_key:string;status:string;is_final:boolean})=>r.item_key==="pocket_check" && r.status==="NOT_APPLICABLE" && r.is_final);
  assert.equal(autoNa.length,2);

  // 2. TASK-072: Record step timings for prep & measure
  const stepStart=await inspector.fetch(`/staff/inspection-tasks/${taskId}/steps`,{step_code:"measure",action:"start"});
  assert.equal(stepStart.step_code,"measure");
  const stepStop=await inspector.fetch(`/staff/inspection-tasks/${taskId}/steps`,{step_code:"measure",action:"stop"});
  assert(stepStop.ended_at);

  // 3. TASK-068 & TASK-069 (T16, T48): Record 2 attempts on top.waist_flat that exceed 0.5cm threshold (32.0cm vs 33.2cm -> diff 1.2cm)
  const topWaistPhoto=await inspector.photo("shot");
  let taskRev=started.revision as number;
  const afterTwoAttempts=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"waist_flat",component:"top",attempt:1,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:32.0,unit:"cm",is_final:true,evidence_ids:[topWaistPhoto]},
      {item_key:"waist_flat",component:"top",attempt:2,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:33.2,unit:"cm",is_final:true},
    ],
  },"PUT");
  taskRev=afterTwoAttempts.revision;

  // Completeness check must flag top.waist_flat as needing a 3rd retry measurement!
  const compAfter2=await inspector.fetch(`/staff/inspection-tasks/${taskId}/completeness`);
  assert.equal(compAfter2.ok,false);
  assert(compAfter2.missing.some((m:{component:string;code:string;hint:string})=>m.component==="top" && m.code==="waist_flat" && m.hint.includes("3rd attempt")));

  // Record 3rd attempt on top.waist_flat (32.3cm -> diff with attempt 1 is 0.3cm <= 0.5cm -> attempt 1 (32.0cm, derived_circumference 64) wins!)
  const afterThreeAttempts=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"waist_flat",component:"top",attempt:3,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:32.3,unit:"cm",is_final:true},
    ],
  },"PUT");
  taskRev=afterThreeAttempts.revision;

  const detailAfter3=await inspector.fetch(`/staff/inspection-tasks/${taskId}`);
  const topWaistFinal=detailAfter3.results.find((r:{item_key:string;component:string;is_final:boolean})=>r.item_key==="waist_flat" && r.component==="top" && r.is_final);
  assert.equal(topWaistFinal.attempt,1);
  assert.equal(topWaistFinal.typed_value,32);
  assert.equal(topWaistFinal.details.derived_circumference,64);

  // 4. TASK-071 & T48: Attempting to reuse topWaistPhoto on bottom.waist_flat is rejected with EVIDENCE_MISMATCH!
  const reuseErr=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"waist_flat",component:"bottom",attempt:1,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:34.0,unit:"cm",is_final:true,evidence_ids:[topWaistPhoto]},
    ],
  },"PUT",409);
  assert.equal(reuseErr.error.code,"EVIDENCE_MISMATCH");

  // 5. TASK-070 (T17): OBSERVED_ISSUE without photo is rejected (422 EVIDENCE_REQUIRED); with invalid part_code is rejected (422 RESULT_INVALID)
  const noPhotoIssue=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"stitch_defects",component:"top",attempt:1,status:"OBSERVED_ISSUE",method:"Visual observation",is_final:true,reason:"Open seam",details:{severity:"attention",part_code:"crotch"}},
    ],
  },"PUT",422);
  assert.equal(noPhotoIssue.error.code,"EVIDENCE_REQUIRED");

  const defectPhoto=await inspector.photo("shot");
  const badPartIssue=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"stitch_defects",component:"top",attempt:1,status:"OBSERVED_ISSUE",method:"Visual observation",is_final:true,reason:"Open seam",details:{severity:"attention",part_code:"invalid_part"},evidence_ids:[defectPhoto]},
    ],
  },"PUT",422);
  assert.equal(badPartIssue.error.code,"RESULT_INVALID");

  // Complete remaining checks on top & bottom (including 3 uncertain attempts on bottom.garment_weight -> median 205g with reason)
  const bottomWaistPhoto=await inspector.photo("shot");
  const savedAllChecks=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:taskRev,
    results:[
      {item_key:"garment_weight",component:"top",attempt:1,status:"RECORDED",method:"Electronic scale 1g",typed_value:180,unit:"g",is_final:true},
      {item_key:"garment_weight",component:"top",attempt:2,status:"RECORDED",method:"Electronic scale 1g",typed_value:181,unit:"g",is_final:false},
      {item_key:"stitch_defects",component:"top",attempt:1,status:"OBSERVED_ISSUE",method:"Visual observation",is_final:true,reason:"Minor loose stitch at waistband",details:{severity:"attention",part_code:"waistband"},evidence_ids:[defectPhoto]},
      {item_key:"waist_flat",component:"bottom",attempt:1,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:34.0,unit:"cm",is_final:true,evidence_ids:[bottomWaistPhoto]},
      {item_key:"waist_flat",component:"bottom",attempt:2,status:"RECORDED",method:"Measure flat width with steel tape",typed_value:34.2,unit:"cm",is_final:false},
      {item_key:"garment_weight",component:"bottom",attempt:1,status:"RECORDED",method:"Electronic scale 1g",typed_value:200,unit:"g",is_final:false},
      {item_key:"garment_weight",component:"bottom",attempt:2,status:"RECORDED",method:"Electronic scale 1g",typed_value:205,unit:"g",is_final:false},
      {item_key:"garment_weight",component:"bottom",attempt:3,status:"RECORDED",method:"Electronic scale 1g",typed_value:210,unit:"g",is_final:true,reason:"Thick drawstring moisture variance; median selected"},
      {item_key:"stitch_defects",component:"bottom",attempt:1,status:"NOT_OBSERVED",method:"Visual observation",is_final:true},
    ],
  },"PUT");
  taskRev=savedAllChecks.revision;

  // 6. TASK-071 & TASK-075 (T15, T18, T48): Upload top front_full shot, try reusing it for bottom front_full (rejected), verify missing bottom front_full blocks submitTask!
  const topShotPhoto=await inspector.photo("shot");
  const afterTopShot=await inspector.fetch(`/staff/inspection-tasks/${taskId}/shots`,{
    revision:taskRev,component:"top",shot_code:"front_full",media_id:topShotPhoto,
  });
  taskRev=afterTopShot.revision;

  const shotReuseErr=await inspector.fetch(`/staff/inspection-tasks/${taskId}/shots`,{
    revision:taskRev,component:"bottom",shot_code:"front_full",media_id:topShotPhoto,
  },"POST",409);
  assert.equal(shotReuseErr.error.code,"EVIDENCE_MISMATCH");

  const compMissingBottomShot=await inspector.fetch(`/staff/inspection-tasks/${taskId}/completeness`);
  assert.equal(compMissingBottomShot.ok,false);
  assert.equal(compMissingBottomShot.missing.length,1);
  assert.equal(compMissingBottomShot.missing[0].component,"bottom");
  assert.equal(compMissingBottomShot.missing[0].code,"front_full");

  const submitBlocked=await inspector.fetch(`/staff/inspection-tasks/${taskId}/submit`,{revision:taskRev},"POST",409);
  assert.equal(submitBlocked.error.code,"INSPECTION_INCOMPLETE");

  // 7. TASK-074 (T41): Stale offline revision conflict returns 409 VERSION_CONFLICT; uploading bottom front_full with fresh revision succeeds and allows submitTask!
  const staleConflict=await inspector.fetch(`/staff/inspection-tasks/${taskId}/results`,{
    revision:1,
    results:[{item_key:"stitch_defects",component:"bottom",attempt:1,status:"NOT_OBSERVED",method:"Visual observation",is_final:true}],
  },"PUT",409);
  assert.equal(staleConflict.error.code,"VERSION_CONFLICT");

  const bottomShotPhoto=await inspector.photo("shot");
  const afterBottomShot=await inspector.fetch(`/staff/inspection-tasks/${taskId}/shots`,{
    revision:taskRev,component:"bottom",shot_code:"front_full",media_id:bottomShotPhoto,
  });
  taskRev=afterBottomShot.revision;

  const compOk=await inspector.fetch(`/staff/inspection-tasks/${taskId}/completeness`);
  assert.equal(compOk.ok,true);
  assert.deepEqual(compOk.missing,[]);

  const submittedTask=await inspector.fetch(`/staff/inspection-tasks/${taskId}/submit`,{revision:taskRev});
  assert.equal(submittedTask.state,"SUBMITTED");
});

test("report review, wording guard, English translation review, comparison diffs, tolerance display, PDF retry recovery, and report dispute case (TASK-076 to TASK-085, TASK-161)",async()=>{
  const {c,terms}=await signCustomer();
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const reviewer=await staffLogin("reviewer");

  const desk=await receiving.fetch("/staff/desk");
  const locId=(desk.locations.find((l:{code:string})=>l.code==="R-01")??desk.locations[0]).id as string;
  const cat=await c.fetch("/catalog");
  const compareOffer=cat.offers.find((o:{service:string})=>o.service==="compare")!;

  // Create a 2-sample comparison order WITHOUT customer tolerance (T23)
  const {draft}=await createAndPay(
    c,
    [{
      category_id:compareOffer.category_id,
      offer_id:compareOffer.offer_id,
      quantity:2,
      attributes:{name:"Compare Hoodie Set",size_label:"L"},
    }],
    terms
  );

  // Check in 2 items and identify them onto the comparison order
  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id as string;
  const trk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const adv=await c.fetch("/me/parcels",{address_id:addr,carrier_code:"sf",tracking_no:trk,order_ids:[draft.id]},"POST",201);
  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:trk,carrier_code:"sf",advice_id:adv.id,weight_g:900,outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const code1="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const code2="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const intake=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,
    items:[
      {code:code1,location_id:locId},
      {code:code2,location_id:locId},
    ],
  },"POST",201);
  const positions=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:code1}))).positions
    .filter((p:{public_no:string})=>p.public_no===draft.public_no);
  assert.equal(positions.length,2);
  await receiving.fetch(`/staff/items/${intake.item_ids[0]}/identify`,{
    revision:1,order_line_id:positions[0].order_line_id,expected_item_id:positions[0].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });
  await receiving.fetch(`/staff/items/${intake.item_ids[1]}/identify`,{
    revision:1,order_line_id:positions[1].order_line_id,expected_item_id:positions[1].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });

  const staffTasks=(await inspector.fetch("/staff/desk")).tasks.filter((t:{public_no:string})=>t.public_no===draft.public_no);
  assert.equal(staffTasks.length,1);
  const [t1]=staffTasks;
  const started=await inspector.fetch(`/staff/inspection-tasks/${t1.id}/start`,{revision:t1.revision});
  const view=await inspector.fetch(`/staff/inspection-tasks/${t1.id}`);
  assert.equal(view.components.length,2);
  const [compA,compB]=view.components.map((m:{id:string})=>m.id);
  const numCheck=view.content.checks.find((ch:{type:string})=>ch.type==="number")!;
  const boolCheck=view.content.checks.find((ch:{key:string})=>ch.key!==numCheck.key) ?? view.content.checks[0];

  // 1. TASK-077 (T19): Subjective/certification forbidden wording is rejected with 422 FORBIDDEN_WORDING
  const forbiddenErr=await inspector.fetch(`/staff/inspection-tasks/${t1.id}/results`,{
    revision:started.revision,
    results:[{
      item_key:boolCheck.key,
      component:compA,
      attempt:1,
      status:"OBSERVED_ISSUE",
      method:boolCheck.method,
      reason:"This item is 100% authentic and Factory A is better.",
      evidence_ids:[await inspector.photo("shot")],
      is_final:true,
    }],
  },"PUT",422);
  assert.equal(forbiddenErr.error.code,"FORBIDDEN_WORDING");

  // 2. Record valid results on compA and compB (numCheck on compB is NOT_TESTED -> missing value for T24, plus Chinese reason on boolCheck for T82)
  const resultsPayload=[];
  for(const ch of view.content.checks) {
    if(ch.key===numCheck.key) {
      resultsPayload.push({
        item_key:ch.key,component:compA,attempt:1,status:"RECORDED",typed_value:70.0,
        ...(ch.unit?{unit:ch.unit}:{}),
        method:ch.method,evidence_ids:[await inspector.photo("shot")],is_final:true,
      });
      resultsPayload.push({
        item_key:ch.key,component:compB,attempt:1,status:"NOT_TESTED",reason:"Drawstring sealed by seller tag",
        method:ch.method,is_final:true,
      });
    } else if(ch.key===boolCheck.key) {
      resultsPayload.push({
        item_key:ch.key,component:compA,attempt:1,status:"RECORDED",typed_value:ch.type==="boolean"?true:ch.type==="number"?50:"OK",
        ...(ch.unit?{unit:ch.unit}:{}),
        method:ch.method,evidence_ids:[await inspector.photo("shot")],is_final:true,
      });
      resultsPayload.push({
        item_key:ch.key,component:compB,attempt:1,status:"OBSERVED_ISSUE",reason:"袖口处有明显跳线大约2厘米",
        method:ch.method,evidence_ids:[await inspector.photo("shot")],is_final:true,
      });
    } else {
      for(const comp of [compA,compB]) {
        resultsPayload.push({
          item_key:ch.key,component:comp,attempt:1,status:"RECORDED",
          typed_value:ch.type==="boolean"?true:ch.type==="number"?50:"OK",
          ...(ch.unit?{unit:ch.unit}:{}),
          method:ch.method,evidence_ids:[await inspector.photo("shot")],is_final:true,
        });
      }
    }
  }
  const rSaved=await inspector.fetch(`/staff/inspection-tasks/${t1.id}/results`,{
    revision:started.revision,
    results:resultsPayload,
  },"PUT");
  await inspector.fetch(`/staff/inspection-tasks/${t1.id}/submit`,{revision:rSaved.revision});

  // 3. Submit report candidate
  const ordReady=await c.fetch(`/orders/${draft.id}`);
  const repSub=await inspector.fetch(`/staff/orders/${draft.id}/report/submit`,{
    revision:ordReady.revision,
    task_ids:[t1.id],
  });
  assert.equal(repSub.state,"submitted");

  // 4. TASK-078 (T20): Self-review by inspector is forbidden
  const selfRevErr=await inspector.fetch(`/staff/reports/${repSub.id}/approve`,{
    revision:1,checklist:["reviewed_en","evidence_checked"],
  },"POST",403);
  assert.ok(["FORBIDDEN","SELF_REVIEW_FORBIDDEN"].includes(selfRevErr.error.code));

  // 5. TASK-161 (T82): Approving while untranslated Chinese remains in customer-facing reason is rejected with 422 ENGLISH_TRANSLATION_REQUIRED
  const zhApproveErr=await reviewer.fetch(`/staff/reports/${repSub.id}/approve`,{
    revision:1,checklist:["reviewed_en","evidence_checked"],
  },"POST",422);
  assert.equal(zhApproveErr.error.code,"ENGLISH_TRANSLATION_REQUIRED");

  // Translate candidate report reason to English via PATCH /staff/reports/{id}/candidate
  const staffRep=await reviewer.fetch(`/staff/reports/${repSub.id}`);
  const defectIdx=staffRep.snapshot.sections[0].results.findIndex((r:{item_key:string;status:string})=>r.item_key===boolCheck.key&&r.status==="OBSERVED_ISSUE");
  const translated=await reviewer.fetch(`/staff/reports/${repSub.id}/candidate`,{
    revision:staffRep.revision,
    translations:[{
      section:0,
      result:defectIdx,
      reason_en:"Visible skipped stitch approximately 2 cm at right cuff",
    }],
  },"PATCH");
  assert.equal(translated.revision,staffRep.revision+1);

  // Now approveReport succeeds and worker renders & publishes PDF!
  const approved=await reviewer.fetch(`/staff/reports/${repSub.id}/approve`,{
    revision:translated.revision,
    checklist:["reviewed_en","evidence_checked"],
  },"POST",202);
  assert.equal(approved.state,"qa_approved");
  for(let i=0;i<50;i++){if(!await workOnce())break;}

  // 6. TASK-081, TASK-082 (T23, T24): Read published report, verify no within_tolerance when customer omitted tolerance, and verify comparison diff is "—" when a sample is NOT_TESTED
  const pubReport=await c.fetch(`/orders/${draft.id}/report`);
  assert.equal(pubReport.state,"published");
  assert.equal(pubReport.version,1);
  const sec0=pubReport.snapshot.sections[0];
  assert.equal(sec0.summary.expected_count,2);
  assert.equal(sec0.summary.checked_count,2);
  assert.equal(sec0.summary.issue_count,1);
  for(const res of sec0.results) {
    assert.equal(res.within_tolerance,undefined,"within_tolerance must be omitted when customer did not provide tolerance (T23)");
  }
  const lenDiff=sec0.comparison.diffs.find((d:{point_code:string})=>d.point_code===numCheck.key);
  assert.ok(lenDiff);
  assert.equal(lenDiff.max_minus_min,null);
  assert.equal(lenDiff.display_diff,"—");

  // 7. TASK-161 (T81): Verify signed PDF download URL generation
  const pdfMeta=await c.fetch(`/orders/${draft.id}/report/versions/1/pdf`);
  assert.equal(pdfMeta.version,1);
  assert.ok(pdfMeta.url.includes("/api/v1/orders/"));

  // 8. TASK-084: Customer opens a report dispute linked to version 1 and checkpoint boolCheck.key
  const disputeItem=sec0.results[defectIdx].item;
  const dispute=await c.fetch(`/orders/${draft.id}/report/disputes`,{
    version:1,
    item_code:disputeItem,
    item_key:boolCheck.key,
    message:"Please confirm whether the skipped stitch affects the inner lining seam.",
  },"POST",201);
  assert.equal(dispute.category,"measurement_dispute");
  assert.equal(dispute.details.dispute_type,"report_dispute");
  assert.equal(dispute.state,"waiting_internal");
  assert.equal(dispute.details.report_version,1);
  assert.equal(dispute.details.item_key,boolCheck.key);
});

test("TASK-086..100 & TASK-160: per-item dispositions, shipping rates & calculator, manual parcel pricing, consolidation/split amendments, storage reminders, and financial reconciliation",async()=>{
  const admin=await staffLogin("admin");
  const receiving=await staffLogin("receiving");
  const {c,terms}=await signCustomer();
  const termsId=terms.find((t:{kind:string})=>t.kind==="terms")?.id ?? terms[0].id;
  const stdOffer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");

  // 1. TASK-091 & TASK-092: Publish a new shipping rate version and verify the shipping rate calculator
  const newRate=await admin.fetch("/staff/admin/shipping-rates",{
    first_weight_g:1000,first_cents:900,extra_step_g:500,extra_cents:250,handling_cents:150,
  },"POST",201);
  assert.ok(newRate.version>=2);

  const calcPreview=await admin.fetch("/staff/admin/shipping-rates/calculate",{
    rate_version_id:newRate.id,
    parcels:[{weight_g:800},{weight_g:1350}],
  });
  assert.equal(calcPreview.version,newRate.version);
  // 800g -> 900 cents; 1350g -> 900 + 1*250 = 1150 cents; handling = 150 cents -> total 2200 cents
  assert.equal(calcPreview.parcels[0].amount_cents,900);
  assert.equal(calcPreview.parcels[1].amount_cents,1150);
  assert.equal(calcPreview.handling_cents,150);
  assert.equal(calcPreview.total_cents,2200);

  // 2. Create two orders (o1 with 2 items, o2 with 1 item) plus 1 zero-order stored item for c
  const {draft:o1}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:2,attributes:{name:"STD-DISP-1"}}],terms);
  const {draft:o2}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"STD-DISP-2"}}],terms);
  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id as string;
  const desk=await receiving.fetch("/staff/desk");
  const locId=(desk.locations.find((l:{code:string})=>l.code==="R-01")??desk.locations[0]).id as string;

  async function receiveAndIdentify(order:{id:string;public_no:string},count:number) {
    const trk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
    const adv=await c.fetch("/me/parcels",{address_id:addr,carrier_code:"sf",tracking_no:trk,order_ids:[order.id]},"POST",201);
    const pkg=await receiving.fetch("/staff/intake/check-in",{
      tracking_no:trk,carrier_code:"sf",advice_id:adv.id,weight_g:900,outer_media_ids:[await receiving.photo("intake_outer")],
    },"POST",201);
    const codes=Array.from({length:count},()=>"S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase());
    const unpacked=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
      revision:pkg.revision,
      items:codes.map(code=>({code,location_id:locId})),
    },"POST",201);
    const pos=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:codes[0]}))).positions
      .filter((p:{public_no:string})=>p.public_no===order.public_no);
    for(let i=0;i<count;i++) {
      await receiving.fetch(`/staff/items/${unpacked.item_ids[i]}/identify`,{
        revision:1,order_line_id:pos[i].order_line_id,expected_item_id:pos[i].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
      });
    }
    const ordNow=await c.fetch(`/orders/${order.id}`);
    await c.fetch(`/orders/${order.id}/cancel`,{revision:ordNow.revision,reason:"Cancel before inspection to test item disposition"});
    return unpacked.item_ids as string[];
  }

  const [item1A,item1B]=await receiveAndIdentify(o1,2);
  const [item2A]=await receiveAndIdentify(o2,1);

  // Also check in a zero-order parcel for customer c and unpack itemZero
  const zeroTrk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const zeroAdv=await c.fetch("/me/parcels",{address_id:addr,carrier_code:"sf",tracking_no:zeroTrk,order_ids:[]},"POST",201);
  const zeroPkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:zeroTrk,carrier_code:"sf",advice_id:zeroAdv.id,weight_g:500,outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const zeroCode="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const zeroUnpacked=await receiving.fetch(`/staff/packages/${zeroPkg.id}/items`,{
    revision:zeroPkg.revision,
    items:[{code:zeroCode,location_id:locId}],
  },"POST",201);
  const itemZero=zeroUnpacked.item_ids[0] as string;

  // 3. TASK-086, TASK-087, TASK-089, TASK-090 (T62):
  // - Forwarder disposition without member_code (or blank member_code) is rejected with 422 DESTINATION_INCOMPLETE
  const missingMember=await c.fetch(`/orders/${o1.id}/dispositions`,{
    item_id:item1A,
    action:"to_forwarder",
    terms_version_id:termsId,
    destination:{recipient:"Fwd Hub",phone:"13800001111",address:"Shenzhen Baoan Hub",member_code:"   "},
  },"POST",422);
  assert.equal(missingMember.error.code,"DESTINATION_INCOMPLETE");

  // - Request retain (storage extension for 45 days) on item1B, then cancel it before payment, then switch to return_to_seller
  const retainDisp=await c.fetch(`/orders/${o1.id}/dispositions`,{
    item_id:item1B,
    action:"retain",
    days:45,
    terms_version_id:termsId,
  },"POST",201);
  assert.ok(retainDisp.id);

  // Duplicate active disposition on item1B is rejected with 409 ITEM_RESERVED
  const dupDisp=await c.fetch(`/orders/${o1.id}/dispositions`,{
    item_id:item1B,
    action:"return_to_seller",
    terms_version_id:termsId,
    destination:{recipient:"Seller",phone:"13900002222",address:"Hangzhou"},
    return_info:{requested_from_seller:true,customer_pays_shipping:true},
  },"POST",409);
  assert.equal(dupDisp.error.code,"ITEM_RESERVED");

  // Cancel unlocked retain disposition on item1B
  const cancelledDisp=await c.fetch(`/me/dispositions/${retainDisp.id}/cancel`,{});
  assert.equal(cancelledDisp.state,"cancelled");

  // Now item1B can be instructed to return_to_seller!
  const retDisp1B=await c.fetch(`/orders/${o1.id}/dispositions`,{
    item_id:item1B,
    action:"return_to_seller",
    terms_version_id:termsId,
    destination:{recipient:"Seller Return Dept",phone:"13900002222",address:"Hangzhou Binjiang Rd"},
    return_info:{requested_from_seller:true,customer_pays_shipping:true},
  },"POST",201);
  assert.ok(retDisp1B.id);

  // 4. TASK-160 (T76, T79, T80, T111): Consolidate item1A (order 1), item2A (order 2), and itemZero (zero-order) into a single to_forwarder batch!
  const fwdDest={recipient:"Fwd Warehouse",phone:"13800001111",address:"Shenzhen Logistics Park",member_code:"MBR-8899"};
  const disp1A=await c.fetch(`/orders/${o1.id}/dispositions`,{
    item_id:item1A,action:"to_forwarder",terms_version_id:termsId,destination:fwdDest,
  },"POST",201);
  const disp2A=await c.fetch(`/orders/${o2.id}/dispositions`,{
    item_id:item2A,action:"to_forwarder",terms_version_id:termsId,destination:fwdDest,
  },"POST",201);
  const dispZero=await c.fetch(`/me/items/${itemZero}/dispositions`,{
    action:"to_forwarder",terms_version_id:termsId,destination:fwdDest,
  },"POST",201);

  const batch=await c.fetch("/dispatch-batches",{disposition_ids:[disp1A.id,disp2A.id,dispZero.id]},"POST",201);
  const confirmedBatch=await c.fetch(`/dispatch-batches/${batch.batch_id}/confirm`,{revision:batch.revision});
  assert.equal(confirmedBatch.revision,batch.revision+1);

  // Attempting to cancel a disposition locked in a confirmed batch is rejected with 409 BATCH_LOCKED
  const lockedCancelErr=await c.fetch(`/me/dispositions/${disp1A.id}/cancel`,{},"POST",409);
  assert.equal(lockedCancelErr.error.code,"BATCH_LOCKED");

  // 5. TASK-094: Out-of-rule manual parcel pricing requires manual_reason (422 MANUAL_REASON_REQUIRED without reason)
  const missingManualReason=await admin.fetch(`/staff/dispatch-batches/${batch.batch_id}/manual-quote`,{
    revision:confirmedBatch.revision,
    rate_version_id:newRate.id,
    parcels:[
      {item_ids:[item1A,item2A],weight_g:1200,manual_amount_cents:2500},
      {item_ids:[itemZero],weight_g:600},
    ],
  },"POST",422);
  assert.equal(missingManualReason.error.code,"MANUAL_REASON_REQUIRED");

  const q1=await admin.fetch(`/staff/dispatch-batches/${batch.batch_id}/manual-quote`,{
    revision:confirmedBatch.revision,
    rate_version_id:newRate.id,
    manual_reason:"Oversized coat box requires custom carrier surcharge",
    parcels:[
      {item_ids:[item1A,item2A],weight_g:1200,manual_amount_cents:2500},
      {item_ids:[itemZero],weight_g:600},
    ],
  });
  // Parcel 1 = 2500 (manual), Parcel 2 = 900 (first weight), handling = 150 -> total 3550 cents
  assert.equal(q1.amount_cents,3550);

  // Accept q1 to create charge1 (and verify cross-order + zero-order allocation!)
  const acc1=await c.fetch(`/quotes/${q1.quote_id}/accept`,{revision:q1.revision});
  assert.equal(acc1.amount_cents,3550);
  const chk1=await c.fetch(`/charges/${acc1.charge_item_id}/checkout`,{quote_revision:q1.revision});

  // 6. TASK-160 (T80): Customer amends the batch BEFORE paying (changes destination address), which voids charge1 and resets batch to confirmed
  const batchBeforeAmend=await c.fetch(`/dispatch-batches/${batch.batch_id}`);
  const amendedPrePay=await c.fetch(`/dispatch-batches/${batch.batch_id}/amend`,{
    revision:batchBeforeAmend.revision,
    destination:{...fwdDest,address:"Shenzhen New Bonded Zone #2"},
  });
  assert.equal(amendedPrePay.state,"confirmed");
  assert.equal(amendedPrePay.refund_ticket_id,null);

  // Late payment arriving for superseded q1/acc1 must NOT mark batch paid and must open a payment_refund reconciliation ticket!
  await pool.query("update charge_items set voided_at=null where id=$1",[acc1.charge_item_id]);
  await c.fetch(`/checkout/demo/${chk1.attempt_id}`,{});
  const batchAfterLate=await c.fetch(`/dispatch-batches/${batch.batch_id}`);
  assert.equal(batchAfterLate.state,"confirmed","Late payment on superseded quote must not mark amended batch paid (T80)");

  // 7. Re-quote the amended batch, accept, and pay
  const q2=await receiving.fetch(`/staff/dispatch-batches/${batch.batch_id}/quote`,{
    revision:batchAfterLate.revision,
    rate_version_id:newRate.id,
    parcels:[
      {item_ids:[item1A,item2A],weight_g:1200},
      {item_ids:[itemZero],weight_g:600},
    ],
  });
  const acc2=await c.fetch(`/quotes/${q2.quote_id}/accept`,{revision:q2.revision});
  const chk2=await c.fetch(`/charges/${acc2.charge_item_id}/checkout`,{quote_revision:q2.revision});
  await c.fetch(`/checkout/demo/${chk2.attempt_id}`,{});

  // Pack Parcel 1 ([item1A, item2A]) and hand it over to carrier, leaving itemZero unshipped
  const batchPaid=await c.fetch(`/dispatch-batches/${batch.batch_id}`);
  assert.equal(batchPaid.state,"paid");
  const pack1=await receiving.fetch(`/staff/dispatch-batches/${batch.batch_id}/parcels`,{
    revision:batchPaid.revision,
    quote_id:q2.quote_id,
    item_ids:[item1A,item2A],
    weight_g:1200,
    packed_media_ids:[await receiving.photo("dispatch")],
  },"POST",201);
  const shipTrk1="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const ship1=await receiving.fetch(`/staff/shipments/${pack1.shipment_id}/handover`,{
    revision:pack1.revision,
    item_ids:[item1A,item2A],
    carrier_code:"sf",
    tracking_no:shipTrk1,
    evidence_ids:[await receiving.photo("dispatch")],
    handed_at:new Date().toISOString(),
  });
  assert.equal(ship1.state,"shipped");

  // Attempting to remove already-shipped item1A via amend is rejected with 409 SHIPMENT_ALREADY_HANDED_OVER
  const batchPart=await c.fetch(`/dispatch-batches/${batch.batch_id}`);
  assert.equal(batchPart.state,"paid");
  const shipAmendErr=await c.fetch(`/dispatch-batches/${batch.batch_id}/amend`,{
    revision:batchPart.revision,
    remove_item_ids:[item1A],
  },"POST",409);
  assert.equal(shipAmendErr.error.code,"SHIPMENT_ALREADY_HANDED_OVER");

  // Amending remaining unshipped itemZero (removing it from this batch so it returns to requested, while the batch with shipped items completes)
  const splitRes=await c.fetch(`/dispatch-batches/${batch.batch_id}/amend`,{
    revision:batchPart.revision,
    remove_item_ids:[itemZero],
  });
  assert.equal(splitRes.state,"completed");
  assert.ok(splitRes.refund_ticket_id,"Post-payment amendment must open a payment_refund reconciliation ticket");

  // 8. TASK-099 (T53): Cancel retDisp1B so item1B has no pending instruction, then check storage reminders and verify round deduplication
  await c.fetch(`/me/dispositions/${retDisp1B.id}/cancel`,{});
  await pool.query("update warehouse_items set storage_until=now() + interval '2 days' where id=$1",[item1B]);
  const rem1=await admin.fetch("/staff/admin/storage/check-reminders",{});
  assert.ok(rem1.sent_count>=1);
  const rem2=await admin.fetch("/staff/admin/storage/check-reminders",{});
  assert.equal(rem2.sent_count,0,"Second reminder check in same storage_until window must be deduplicated (T53)");

  // Confirm customer /actions includes storage_expiring for item1B
  const cActions=await c.fetch("/actions");
  assert.ok(cActions.rows.some((r:{kind:string;state:string})=>r.kind==="storage"&&r.state==="storage_expiring"));

  // 9. TASK-100 (T56, T111): Verify joint financial reconciliation across inspection, dispatch (with cross-order + zero-order balance), storage, and refunds
  const recon=await admin.fetch("/staff/admin/reconciliation");
  assert.ok(recon.summary.inspection_paid_cents>0);
  assert.ok(recon.summary.dispatch_paid_cents>0);
  const dispatchReconRow=recon.rows.find((r:{charge_id:string})=>r.charge_id===acc2.charge_item_id);
  assert.ok(dispatchReconRow);
  assert.equal(dispatchReconRow.allocation_balanced,true);
  assert.equal(dispatchReconRow.allocations.length,2,"Two order allocations (o1 and o2)");
  assert.ok(dispatchReconRow.unallocated_cents>0,"Zero-order item share is tracked in unallocated_cents");
  assert.equal(dispatchReconRow.allocated_cents+dispatchReconRow.unallocated_cents,dispatchReconRow.amount_cents);
});

test("Stocktake, warehouse incident compensation, stage refunds, dispute freezes, and order closure (TASK-171, TASK-101..110, TASK-157, T33..T35, T52..T53, T102..T103)",async t=>{
  const {c,terms}=await signCustomer();
  const termsId=terms.find((x:{kind:string})=>x.kind==="terms")!.id;
  const stdOffer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1")!;
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const reviewer=await staffLogin("reviewer");
  const admin=await staffLogin("admin");
  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id as string;
  const desk=await receiving.fetch("/staff/desk");
  const locId=(desk.locations.find((l:{code:string})=>l.code==="R-01")??desk.locations[0]).id as string;

  // 1. T33: Stage-based refund policy before_receipt (100%)
  const {draft:oBefore}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"Stage Before Receipt"}}],terms);
  const prevBefore=await c.fetch(`/orders/${oBefore.id}/refund-preview`);
  assert.equal(prevBefore.stage.stage,"before_receipt");
  assert.equal(prevBefore.stage.refund_rate_pct,100);
  assert.equal(prevBefore.stage.recommended_refund_cents,prevBefore.stage.paid_cents);

  // 2. Receive physical items for Order oMain (2 items) and verify received_before_inspection (100%) -> inspecting (50%) -> report_published (0% / 100% platform fault)
  const {draft:oMain}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:2,attributes:{name:"Stocktake & Incident Jacket"}}],terms);
  const trk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const adv=await c.fetch("/me/parcels",{address_id:addr,tracking_no:trk,carrier_code:"sf",order_ids:[oMain.id]},"POST",201);
  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:trk,carrier_code:"sf",advice_id:adv.id,weight_g:950,outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const codeA="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const codeB="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const unpacked=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,
    items:[{code:codeA,location_id:locId},{code:codeB,location_id:locId}],
  },"POST",201);
  const itemA=unpacked.item_ids[0] as string;
  const itemB=unpacked.item_ids[1] as string;

  const prevReceived=await c.fetch(`/orders/${oMain.id}/refund-preview`);
  assert.equal(prevReceived.stage.stage,"received_before_inspection");
  assert.equal(prevReceived.stage.refund_rate_pct,100);

  // Identify both items onto oMain and start inspection -> stage becomes inspecting (50%)
  const positions=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:codeA}))).positions
    .filter((p:{public_no:string})=>p.public_no===oMain.public_no);
  await receiving.fetch(`/staff/items/${itemA}/identify`,{
    revision:1,order_line_id:positions[0].order_line_id,expected_item_id:positions[0].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });
  await receiving.fetch(`/staff/items/${itemB}/identify`,{
    revision:1,order_line_id:positions[1].order_line_id,expected_item_id:positions[1].id,matches_advice:true,media_ids:[await receiving.photo("label_photo")],
  });
  const staffTasks=(await inspector.fetch("/staff/desk")).tasks.filter((tk:{public_no:string})=>tk.public_no===oMain.public_no);
  assert.equal(staffTasks.length,2);
  const started0=await inspector.fetch(`/staff/inspection-tasks/${staffTasks[0].id}/start`,{revision:staffTasks[0].revision});

  const prevInspecting=await c.fetch(`/orders/${oMain.id}/refund-preview`);
  assert.equal(prevInspecting.stage.stage,"inspecting");
  assert.equal(prevInspecting.stage.refund_rate_pct,50);
  assert.equal(prevInspecting.stage.recommended_refund_cents,Math.round(prevInspecting.stage.paid_cents*0.5));

  // Complete and publish report -> stage becomes report_published (0% standard, 100% platform fault)
  for(let idx=0;idx<staffTasks.length;idx++) {
    const tk=staffTasks[idx];
    const startRev=idx===0?started0.revision:(await inspector.fetch(`/staff/inspection-tasks/${tk.id}/start`,{revision:tk.revision})).revision;
    const view=await inspector.fetch(`/staff/inspection-tasks/${tk.id}`);
    const resultsPayload=[];
    for(const comp of view.components.map((m:{id:string})=>m.id)) {
      for(const ch of view.content.checks) {
        resultsPayload.push({
          item_key:ch.key,component:comp,attempt:1,status:"RECORDED",
          typed_value:ch.type==="boolean"?true:ch.type==="number"?52:"OK",
          ...(ch.unit?{unit:ch.unit}:{}),
          method:ch.method,evidence_ids:[await inspector.photo("shot")],is_final:true,
        });
      }
    }
    const saved=await inspector.fetch(`/staff/inspection-tasks/${tk.id}/results`,{revision:startRev,results:resultsPayload},"PUT");
    await inspector.fetch(`/staff/inspection-tasks/${tk.id}/submit`,{revision:saved.revision});
  }
  const ordReady=await c.fetch(`/orders/${oMain.id}`);
  const repSub=await inspector.fetch(`/staff/orders/${oMain.id}/report/submit`,{revision:ordReady.revision,task_ids:staffTasks.map((tk:{id:string})=>tk.id)});
  await reviewer.fetch(`/staff/reports/${repSub.id}/approve`,{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  for(let i=0;i<50;i++){if(!await workOnce())break;}

  const prevPublished=await c.fetch(`/orders/${oMain.id}/refund-preview`);
  assert.equal(prevPublished.stage.stage,"report_published");
  assert.equal(prevPublished.stage.refund_rate_pct,0);
  assert.equal(prevPublished.stage.recommended_refund_cents,0);
  const prevFault=await c.fetch(`/orders/${oMain.id}/refund-preview?platform_fault=1`);
  assert.equal(prevFault.stage.refund_rate_pct,100);
  assert.equal(prevFault.stage.recommended_refund_cents,prevFault.stage.paid_cents);

  // T52: Customer requests after-sales re-inspection
  const afterSales=await c.fetch(`/orders/${oMain.id}/after-sales`,{
    resolution_type:"re_inspect",
    reason:"Please re-verify sleeve measurement on Jacket-A",
  },"POST",201);
  assert.match(afterSales.ticket_no,/^TKT-/);
  assert.equal(afterSales.resolution_type,"re_inspect");

  // 3. TASK-171 (T102): Stocktake creation, concurrent move triggering recount_required, missing item freezing outbound/move, found unfreezing, and independent supervisor approval
  // Move itemA and itemB to a dedicated newly-created location so the stocktake snapshot contains exactly [itemA, itemB]
  const stLocBatch=await admin.fetch("/staff/admin/storage/locations",{
    prefix:"Z",zone:"post_inspection",rack:99,level:1,start:1,end:2,capacity:10,notes:"Stocktake test locations",
  });
  const stLoc1=stLocBatch.added[0] ?? (await admin.fetch("/staff/admin/storage/locations")).rows.find((r:{code:string})=>r.code==="Z-99-01-01")!;
  const stLoc2=stLocBatch.added[1] ?? (await admin.fetch("/staff/admin/storage/locations")).rows.find((r:{code:string})=>r.code==="Z-99-01-02")!;
  for(const itId of [itemA,itemB]) {
    const rev=(await pool.query<{revision:number}>("select revision from warehouse_items where id=$1",[itId])).rows[0].revision;
    await receiving.fetch("/staff/storage/move",{item_id:itId,revision:rev,location_id:stLoc1.id});
  }

  const stCreated=await receiving.fetch("/staff/stocktakes",{
    location_ids:[stLoc1.id],
    note:"Routine post-inspection stocktake",
  },"POST",201);
  const stId=stCreated.id;
  assert.ok(stCreated.item_ids.includes(itemA));
  assert.ok(stCreated.item_ids.includes(itemB));

  // Simulate concurrent move of itemA after stocktake snapshot -> scanning itemA as missing at old location detects concurrent movement and requires recount
  const curItemA=await pool.query<{revision:number}>("select revision from warehouse_items where id=$1",[itemA]);
  await receiving.fetch("/staff/storage/move",{item_id:itemA,revision:curItemA.rows[0].revision,location_id:stLoc2.id});

  const scanConcurrent=await receiving.fetch(`/staff/stocktakes/${stId}/scan`,{
    item_id:itemA,
    status:"missing",
  });
  assert.equal(scanConcurrent.state,"recount_required","Concurrent move after snapshot must mark item recount_required (T102)");
  assert.equal(scanConcurrent.recount_required,true);

  // Recount itemA at its actual new location -> matched
  const scanRecounted=await receiving.fetch(`/staff/stocktakes/${stId}/scan`,{
    item_id:itemA,
    status:"matched",
    actual_location:stLoc2.id,
  });
  assert.equal(scanRecounted.state,"matched");

  // Mark itemB as missing -> state becomes investigating and freezes itemB from disposition/move/outbound
  const scanMissing=await receiving.fetch(`/staff/stocktakes/${stId}/scan`,{
    item_id:itemB,
    status:"missing",
    note:"Not found on shelf during initial count",
  });
  assert.equal(scanMissing.state,"investigating");
  assert.equal(scanMissing.frozen,true);

  const frozenDispErr=await c.fetch(`/orders/${oMain.id}/dispositions`,{
    item_id:itemB,
    action:"to_forwarder",
    terms_version_id:termsId,
    destination:{recipient:"Fwd",phone:"13800001111",address:"Shenzhen Fwd",member_code:"FWD-B"},
  },"POST",409);
  assert.equal(frozenDispErr.error.code,"ITEM_UNAVAILABLE");
  const curItemB=await pool.query<{revision:number}>("select revision from warehouse_items where id=$1",[itemB]);
  const frozenMoveErr=await receiving.fetch("/staff/storage/move",{item_id:itemB,revision:curItemB.rows[0].revision,location_id:stLoc2.id},"POST",409);
  assert.equal(frozenMoveErr.error.code,"ITEM_UNAVAILABLE");

  // Submit stocktake with discrepancy -> state becomes submitted; creator cannot self-approve
  const stSubmitted=await receiving.fetch(`/staff/stocktakes/${stId}/submit`,{reason:"1 missing item"});
  assert.equal(stSubmitted.state,"submitted");
  const selfApproveSt=await receiving.fetch(`/staff/stocktakes/${stId}/approve`,{decision:"approve",reason:"Self approve"},"POST",403);
  assert.equal(selfApproveSt.error.code,"SELF_REVIEW_FORBIDDEN");

  // Recover itemB (found) before final approval -> unfreezes itemB
  const scanFound=await receiving.fetch(`/staff/stocktakes/${stId}/scan`,{
    item_id:itemB,
    status:"found",
    actual_location:stLoc1.id,
    note:"Found on back of shelf Z-99-01-01",
  });
  assert.equal(scanFound.state,"matched");
  assert.equal(scanFound.recovered,true);

  const adminApproveSt=await admin.fetch(`/staff/stocktakes/${stId}/approve`,{decision:"approve",reason:"Approved after item recovery"});
  assert.equal(adminApproveSt.state,"approved");

  // 4. TASK-171 (T103): Warehouse incident & compensation workflow on itemB
  const incCreated=await receiving.fetch("/staff/incidents",{
    item_id:itemB,
    kind:"damage",
    summary_en:"Minor water stain on outer sleeve during storage move",
  },"POST",201);
  const incId=incCreated.id;
  assert.equal(incCreated.state,"open");

  // While incident is unresolved, itemB is frozen again
  const incFrozenErr=await c.fetch(`/orders/${oMain.id}/dispositions`,{
    item_id:itemB,
    action:"to_forwarder",
    terms_version_id:termsId,
    destination:{recipient:"Fwd",phone:"13800001111",address:"Shenzhen Fwd",member_code:"FWD-B"},
  },"POST",409);
  assert.equal(incFrozenErr.error.code,"ITEM_UNAVAILABLE");

  // Propose resolution separating service fee refund (within Stripe balance) and merchandise compensation
  // First verify excessive service_refund_cents (> paid order balance) is rejected with 409 REFUND_EXCEEDS_PAYMENT
  const excessSrvErr=await admin.fetch(`/staff/incidents/${incId}/propose`,{
    service_refund_cents:999999,
    compensation_cents:1500,
    currency:"USD",
    summary_en:"Excessive service refund test",
  },"POST",409);
  assert.equal(excessSrvErr.error.code,"REFUND_EXCEEDS_PAYMENT");

  const proposedInc=await receiving.fetch(`/staff/incidents/${incId}/propose`,{
    service_refund_cents:500,
    compensation_cents:2500,
    currency:"USD",
    summary_en:"Refund $5 service fee + $25 merchandise compensation",
  });
  assert.equal(proposedInc.state,"proposed");

  // Non-finance staff (receiving) listing incidents sees resolution.financial_restricted = true and undefined compensation_cents
  const recvIncList=await receiving.fetch("/staff/incidents");
  const recvIncRow=recvIncList.rows.find((r:{id:string})=>r.id===incId)!;
  assert.equal(recvIncRow.resolution.financial_restricted,true);
  assert.equal(recvIncRow.resolution.compensation_cents,undefined);

  // Admin (finance/super_admin) approves independently
  const approvedInc=await admin.fetch(`/staff/incidents/${incId}/approve`,{
    reason:"Approved $5 service refund and $25 compensation",
  });
  assert.equal(approvedInc.state,"approved_awaiting_customer");
  assert.ok(approvedInc.service_refund_id,"Service refund creates a linked refund record without mixing merchandise compensation into Stripe refund");

  // Verify the created refund record only has 500 cents (service fee), NOT 3000 cents
  const srvRefundRow=await pool.query<{amount_cents:number}>("select amount_cents from refunds where id=$1",[approvedInc.service_refund_id]);
  assert.equal(srvRefundRow.rows[0].amount_cents,500);

  // Customer reads and accepts incident proposal -> state becomes awaiting_payout (NOT paid yet!)
  const custIncView=await c.fetch(`/me/incidents/${incId}`);
  assert.equal(custIncView.service_refund_cents,500);
  assert.equal(custIncView.compensation_cents,2500);
  const custAcceptInc=await c.fetch(`/me/incidents/${incId}/response`,{
    decision:"accept",
    note:"I accept the $5 service refund + $25 compensation.",
  });
  assert.equal(custAcceptInc.state,"awaiting_payout");
  assert.equal(custAcceptInc.paid,false,"Accepting compensation proposal must not mark payout as completed until payment_proof is recorded (T103)");

  // Admin records actual payout proof -> state becomes resolved and paid = true, unfreezing itemB
  const resolvedInc=await admin.fetch(`/staff/incidents/${incId}/resolve`,{
    payout_reference:"BANK-TXN-20261107-8899",
    payout_method:"bank_transfer",
    paid_amount_cents:2500,
    note:"Payout transferred and verified",
  });
  assert.equal(resolvedInc.state,"resolved");
  assert.equal(resolvedInc.paid,true);

  // 5. TASK-105 (T53): Closing order while items are still in storage fails with 409 ITEMS_STILL_IN_STORAGE
  const closeEarlyErr=await admin.fetch(`/staff/orders/${oMain.id}/close`,{},"POST",409);
  assert.equal(closeEarlyErr.error.code,"ITEMS_STILL_IN_STORAGE");

  // 6. TASK-109, TASK-110 (T34, T35): Dispatch batch payment, Stripe dashboard refund sync (T34), and Stripe dispute freeze/unfreeze (T35)
  const dispA=await c.fetch(`/orders/${oMain.id}/dispositions`,{
    item_id:itemA,
    action:"to_forwarder",
    terms_version_id:termsId,
    destination:{recipient:"Fwd",phone:"13800001111",address:"Shenzhen Fwd",member_code:"FWD-MAIN"},
  },"POST",201);
  const dispB=await c.fetch(`/orders/${oMain.id}/dispositions`,{
    item_id:itemB,
    action:"to_forwarder",
    terms_version_id:termsId,
    destination:{recipient:"Fwd",phone:"13800001111",address:"Shenzhen Fwd",member_code:"FWD-MAIN"},
  },"POST",201);
  const batchMain=await c.fetch("/dispatch-batches",{disposition_ids:[dispA.id,dispB.id]},"POST",201);
  const confirmedBatch=await c.fetch(`/dispatch-batches/${batchMain.batch_id}/confirm`,{revision:batchMain.revision});
  const rateId=(await pool.query<{id:string}>("select id from shipping_rate_versions order by version desc limit 1")).rows[0].id;
  const qMain=await receiving.fetch(`/staff/dispatch-batches/${batchMain.batch_id}/quote`,{
    revision:confirmedBatch.revision,
    rate_version_id:rateId,
    parcels:[{item_ids:[itemA,itemB],weight_g:950}],
  });
  const accMain=await c.fetch(`/quotes/${qMain.quote_id}/accept`,{revision:qMain.revision});
  const chkMain=await c.fetch(`/charges/${accMain.charge_item_id}/checkout`,{quote_revision:qMain.revision});
  await c.fetch(`/checkout/demo/${chkMain.attempt_id}`,{});

  const payRow=(await pool.query<{id:string;provider_payment_intent_id:string}>(
    "select id,provider_data->>'payment_intent' as provider_payment_intent_id from payments where id=$1",[chkMain.attempt_id]
  )).rows[0];
  const oBeforePayRow=(await pool.query<{id:string;provider_payment_intent_id:string}>(
    `select p.id,p.provider_data->>'payment_intent' as provider_payment_intent_id
     from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id join payments p on p.charge_item_id=c.id
     where q.order_id=$1 limit 1`,
    [oBefore.id]
  )).rows[0];

  setFixtureEnv(t,{QCW_DEMO:"0",STRIPE_SECRET_KEY:"sk_test_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture"});
  function sendStripeWebhook(payload:object) {
    const body=JSON.stringify(payload);
    const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:"whsec_fixture"});
    return handle(new Request(origin+"/api/v1/webhooks/stripe",{method:"POST",headers:{"stripe-signature":signature},body}),"/webhooks/stripe");
  }

  // T34: Stripe dashboard direct refund (no pre-existing local refund row) creates provider_dashboard refund + reconciliation ticket
  const extRefundId="re_dashboard_"+randomUUID().slice(0,8);
  const refWebhookRes=await sendStripeWebhook({
    id:"evt_ref_"+randomUUID(),
    object:"event",
    livemode:false,
    type:"refund.created",
    data:{object:{
      id:extRefundId,
      payment_intent:oBeforePayRow.provider_payment_intent_id,
      amount:100,
      currency:"usd",
      status:"succeeded",
      reason:"requested_by_customer",
    }},
  });
  assert.equal(refWebhookRes.status,200);
  const dashRefRow=await pool.query<{source:string;state:string}>("select source,state from refunds where provider_ref=$1",[extRefundId]);
  assert.equal(dashRefRow.rowCount,1);
  assert.equal(dashRefRow.rows[0].source,"provider_dashboard");
  assert.equal(dashRefRow.rows[0].state,"succeeded");

  // T35: Stripe charge.dispute.created freezes dispatch batch packing/handover and places linked order on_hold
  const disputeId="dp_test_"+randomUUID().slice(0,8);
  const dispCreatedRes=await sendStripeWebhook({
    id:"evt_dp_open_"+randomUUID(),
    object:"event",
    livemode:false,
    type:"charge.dispute.created",
    data:{object:{
      id:disputeId,
      payment_intent:payRow.provider_payment_intent_id,
      amount:qMain.amount_cents,
      currency:"usd",
      status:"needs_response",
      reason:"fraudulent",
    }},
  });
  assert.equal(dispCreatedRes.status,200);

  // Order oMain is now on_hold due to payment_dispute
  const oMainFrozen=await c.fetch(`/orders/${oMain.id}`);
  assert.equal(oMainFrozen.state,"on_hold");

  // Attempting to pack shipment while dispute is active fails with 409 SHIPMENT_BLOCKED
  const batchBeforePack=await c.fetch(`/dispatch-batches/${batchMain.batch_id}`);
  const packBlockedErr=await receiving.fetch(`/staff/dispatch-batches/${batchMain.batch_id}/parcels`,{
    revision:batchBeforePack.revision,
    quote_id:qMain.quote_id,
    item_ids:[itemA,itemB],
    weight_g:950,
    packed_media_ids:[await receiving.photo("dispatch")],
  },"POST",409);
  assert.equal(packBlockedErr.error.code,"SHIPMENT_BLOCKED");

  // Stripe sends charge.dispute.closed (won), but per T35 it must remain frozen until staff explicitly reviews and resolves
  const dispClosedRes=await sendStripeWebhook({
    id:"evt_dp_close_"+randomUUID(),
    object:"event",
    livemode:false,
    type:"charge.dispute.closed",
    data:{object:{
      id:disputeId,
      payment_intent:payRow.provider_payment_intent_id,
      amount:qMain.amount_cents,
      currency:"usd",
      status:"won",
      reason:"fraudulent",
    }},
  });
  assert.equal(dispClosedRes.status,200);
  const stillBlockedErr=await receiving.fetch(`/staff/dispatch-batches/${batchMain.batch_id}/parcels`,{
    revision:batchBeforePack.revision,
    quote_id:qMain.quote_id,
    item_ids:[itemA,itemB],
    weight_g:950,
    packed_media_ids:[await receiving.photo("dispatch")],
  },"POST",409);
  assert.equal(stillBlockedErr.error.code,"SHIPMENT_BLOCKED","Closed dispute must remain frozen until staff review (T35)");

  // Staff explicitly resolves the payment dispute and releases freeze
  const resolvedDisp=await admin.fetch(`/staff/disputes/${disputeId}/resolve`,{
    decision:"release_freeze",
    reason:"Dispute won in Stripe; releasing shipment and order freeze",
  });
  assert.equal(resolvedDisp.state,"resolved_by_staff");

  // Now pack and hand over [itemA, itemB] -> both items become outbound
  const packedMain=await receiving.fetch(`/staff/dispatch-batches/${batchMain.batch_id}/parcels`,{
    revision:batchBeforePack.revision,
    quote_id:qMain.quote_id,
    item_ids:[itemA,itemB],
    weight_g:950,
    packed_media_ids:[await receiving.photo("dispatch")],
  },"POST",201);
  const shipMainTrk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const handedMain=await receiving.fetch(`/staff/shipments/${packedMain.shipment_id}/handover`,{
    revision:packedMain.revision,
    item_ids:[itemA,itemB],
    carrier_code:"sf",
    tracking_no:shipMainTrk,
    evidence_ids:[await receiving.photo("dispatch")],
    handed_at:new Date().toISOString(),
  });
  assert.equal(handedMain.state,"shipped");

  // 7. TASK-105 (T53): Now that all items of oMain are outbound, closing the order succeeds
  const closedMain=await admin.fetch(`/staff/orders/${oMain.id}/close`,{});
  assert.equal(closedMain.state,"closed");
});

test("tickets queue assignment, linked incidents, work-hours contribution, and 30-order ledger with test isolation and CSV export (TASK-111..120, T25/T26/T39/T45/T52/T54/T56)",async()=>{
  const {c,terms}=await signCustomer();
  const stdOffer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1")!;
  const admin=await staffLogin("admin");
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const support=admin;
  const addr=(await c.fetch("/me/receiving-address")).warehouse_address.id as string;
  const locId=((await receiving.fetch("/staff/desk")).locations.find((l:{code:string})=>l.code==="R-01")).id as string;

  // 1. Create a production order and a test order (is_test = true)
  const {draft:oProd}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"Ledger Prod Item"}}],terms);
  const {draft:oTest}=await createAndPay(c,[{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"Ledger Test Item"}}],terms);
  await pool.query("update orders set is_test=false where id=$1",[oProd.id]);
  await pool.query("update orders set is_test=true where id=$1",[oTest.id]);

  // Check in and assign 1 item to oProd, record step timings (1800s = 0.5h)
  const trk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const adv=await c.fetch("/me/parcels",{address_id:addr,tracking_no:trk,carrier_code:"sf",order_ids:[oProd.id]},"POST",201);
  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:trk,carrier_code:"sf",advice_id:adv.id,weight_g:500,outer_media_ids:[await receiving.photo("intake_outer")]
  },"POST",201);
  const itemCode="S-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const unp=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,items:[{code:itemCode,location_id:locId}]
  },"POST",201);
  const itemProd=unp.item_ids[0] as string;
  const pos=(await receiving.fetch("/staff/items/by-code?"+new URLSearchParams({code:itemCode}))).positions
    .find((p:{public_no:string})=>p.public_no===oProd.public_no)!;
  await receiving.fetch(`/staff/items/${itemProd}/identify`,{
    revision:1,order_line_id:pos.order_line_id,expected_item_id:pos.id,matches_advice:true,media_ids:[await receiving.photo("label_photo")]
  });
  const taskRow=(await inspector.fetch("/staff/desk")).tasks.find((tk:{public_no:string})=>tk.public_no===oProd.public_no)!;
  await inspector.fetch(`/staff/inspection-tasks/${taskRow.id}/steps`,{
    step_code:"prep",action:"record",seconds:600
  });
  await inspector.fetch(`/staff/inspection-tasks/${taskRow.id}/steps`,{
    step_code:"measure",action:"record",seconds:1200
  });

  // 2. Create a support ticket and verify category/assignee filters and staff assignment (TASK-111..114)
  const createdCase=await c.fetch("/me/cases",{
    order_id:oProd.id,
    category:"payment_refund",
    subject:"Question about invoice receipt",
    message:"Can I download my invoice receipt?",
  });
  const unassignedQueue=await support.fetch("/staff/tickets?category=payment_refund&assignee=unassigned");
  assert.ok(unassignedQueue.rows.some((r:{id:string})=>r.id===createdCase.id));

  const ticketView=await support.fetch(`/staff/tickets/${createdCase.id}`);
  assert.ok(Array.isArray(ticketView.staff_candidates) && ticketView.staff_candidates.length>0);
  const supportCandidate=ticketView.staff_candidates.find((u:{email:string})=>u.email==="support@qcwarehouse.test")??ticketView.staff_candidates[0];

  const assigned=await support.fetch(`/staff/tickets/${createdCase.id}/events`,{
    kind:"assign",
    revision:ticketView.revision,
    assignee_id:supportCandidate.id,
    body:"Assigning billing question to support specialist",
  });
  assert.equal(assigned.revision,ticketView.revision+1);

  const myQueue=await support.fetch("/staff/tickets?category=payment_refund&assignee=mine");
  assert.ok(myQueue.rows.some((r:{id:string})=>r.id===createdCase.id));

  // Add internal note and verify customer cannot see internal note or state_change events (T25/T54)
  await support.fetch(`/staff/tickets/${createdCase.id}/events`,{
    kind:"internal_note",
    revision:assigned.revision,
    body:"Internal billing check passed",
  });
  const custCaseView=await c.fetch(`/cases/${createdCase.id}`);
  assert.ok(custCaseView.events.every((e:{kind:string})=>e.kind==="message"));

  // 3. Verify AdminDesk overviewMetrics & disputes (TASK-116, TASK-117)
  const desk=await admin.fetch("/staff/admin/desk");
  assert.ok(desk.overviewMetrics);
  assert.ok(typeof desk.overviewMetrics.production_orders==="number" && desk.overviewMetrics.production_orders>=1);
  assert.ok(typeof desk.overviewMetrics.test_orders==="number" && desk.overviewMetrics.test_orders>=1);
  assert.ok(Array.isArray(desk.disputes));

  // 4. Verify 30-order ledger, work-hours & contribution, test isolation, and CSV export (TASK-118..120, T39, T56)
  const ledgerProd=await admin.fetch("/staff/admin/finance/ledger?include_test=0&limit=30");
  assert.equal(ledgerProd.summary.include_test,false);
  assert.equal(ledgerProd.summary.recomputable_balanced,true);
  assert.equal(ledgerProd.summary.all_channel_reconciled,true);
  assert.ok(ledgerProd.orders.every((r:{is_test:boolean})=>r.is_test===false),"Test orders must be excluded when include_test=0 (T39)");

  const prodRow=ledgerProd.orders.find((r:{order_id:string})=>r.order_id===oProd.id);
  assert.ok(prodRow,"Production order must appear in ledger");
  assert.equal(prodRow.inspection_seconds,1800);
  // Default hourly labor is 1500 cents ($15/h), so 1800s (0.5h) = 750 cents
  assert.equal(prodRow.labor_cost_cents,750);
  assert.equal(prodRow.contribution_cents,prodRow.net_inspection_cents+prodRow.storage_allocated_cents-prodRow.labor_cost_cents);
  assert.equal(prodRow.channel_reconciled,true);
  assert.ok(prodRow.provider_refs.length>=1);

  // Verify summing order rows equals summary totals (T56: 订单明细可重算汇总，代收运费单列)
  const sumNetInsp=ledgerProd.orders.reduce((n:number,r:{net_inspection_cents:number})=>n+r.net_inspection_cents,0);
  const sumShipping=ledgerProd.orders.reduce((n:number,r:{pass_through_shipping_cents:number})=>n+r.pass_through_shipping_cents,0);
  const sumLabor=ledgerProd.orders.reduce((n:number,r:{labor_cost_cents:number})=>n+r.labor_cost_cents,0);
  const sumContrib=ledgerProd.orders.reduce((n:number,r:{contribution_cents:number})=>n+r.contribution_cents,0);
  assert.equal(sumNetInsp,ledgerProd.summary.net_inspection_cents);
  assert.equal(sumShipping,ledgerProd.summary.pass_through_shipping_cents);
  assert.equal(sumLabor,ledgerProd.summary.total_labor_cost_cents);
  assert.equal(sumContrib,ledgerProd.summary.total_contribution_cents);

  // When include_test=1, oTest is included
  const ledgerAll=await admin.fetch("/staff/admin/finance/ledger?include_test=1&limit=200");
  assert.equal(ledgerAll.summary.include_test,true);
  assert.ok(ledgerAll.orders.some((r:{order_id:string;is_test:boolean})=>r.order_id===oTest.id && r.is_test===true));

  // Verify CSV export endpoint
  const csvRes=await admin.fetch("/staff/admin/finance/ledger.csv?include_test=0");
  assert.match(csvRes.csv,/^public_no,state,is_test,category_slug,service_code/);
  assert.ok(csvRes.csv.includes("SUMMARY,TOTAL,0,ALL,ALL"));
});

test("admin governance, terms preview/publish, multi-warehouse address & calendar, staff roles, privacy export/retention & backup drill (TASK-121..130, T04, T26, T27, T30, T37, T38, T40, T54)",async()=>{
  const {c,terms}=await signCustomer();
  const stdOffer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1")!;
  const admin=await staffLogin("admin");
  const staffMember=await staffLogin("inspector");
  const adminMe=(await admin.fetch("/me")).actor as {id:string};
  const staffMemberMe=(await staffMember.fetch("/me")).actor as {id:string};
  const initialAddr=(await c.fetch("/me/receiving-address")).warehouse_address as {id:string};

  // 1. Create an order and submit under initial terms & initial SKU price (T27/T30/T40)
  const {draft:o1,quote:q1}=await createAndPay(
    c,
    [{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"Gov Historical Item"}}],
    terms
  );

  // Register an inbound parcel on initialAddr (T04)
  const trk="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const adv1=await c.fetch("/me/parcels",{
    address_id:initialAddr.id,
    tracking_no:trk,
    carrier_code:"sf",
    order_ids:[o1.id],
  },"POST",201);

  // 2. TASK-121: Publish a new SKU price version and verify o1 retains its historical price snapshot (T27/T40)
  const newPrice=await admin.fetch("/staff/admin/skus/apparel-inspection-1/prices",{
    rules:{minimum:1,maximum:1,package_cents:2900,business_days:2},
  });
  assert.ok(newPrice.version>=2);
  const o1Detail=await c.fetch(`/orders/${o1.id}`);
  assert.equal(o1Detail.price_cents,q1.amount_cents,"Historical order must retain original quoted price (T27/T40)");
  // Restore apparel-inspection-1 price to original rules so subsequent tests see standard baseline price
  await admin.fetch("/staff/admin/skus/apparel-inspection-1/prices",{
    rules:stdOffer.rules,
  });

  // 3. TASK-122: Create a draft terms version (preview), verify it's not yet in /public/terms, then publish it and verify old order consent snapshot is preserved (T30)
  const draftTerms=await admin.fetch("/staff/admin/terms",{
    kind:"terms",
    version:"2026.9-"+randomUUID().slice(0,8),
    content_md:"# Updated Terms 2026.9\n\nPreview draft content before effective publication.",
    publish_now:false,
  },"POST",201);
  assert.equal(draftTerms.state,"draft");
  const pubBefore=await c.fetch("/public/terms");
  assert.ok(!pubBefore.terms.some((t:{id:string})=>t.id===draftTerms.id),"Draft terms must not be active in /public/terms before publication");

  const publishedTerms=await admin.fetch(`/staff/admin/terms/${draftTerms.id}/publish`,{});
  assert.equal(publishedTerms.state,"published");
  const pubAfter=await c.fetch("/public/terms");
  assert.ok(pubAfter.terms.some((t:{id:string})=>t.id===draftTerms.id),"Published terms must become active in /public/terms");

  const oldConsent=(await pool.query("select terms_version_ids from consents where order_id=$1",[o1.id])).rows[0];
  assert.ok(!oldConsent.terms_version_ids.includes(draftTerms.id),"Historical order consent must retain original terms_version_ids (T30)");

  // 4. TASK-123: Multi-warehouse addresses (candidate + unique default switch + historical advice preservation) & business calendar (T04)
  const candidateAddr=await admin.fetch("/staff/admin/warehouse-addresses",{
    address_zh:"浙江省杭州市萧山区候选仓 88 号",
    address_en:"No. 88 Candidate Warehouse, Xiaoshan, Hangzhou",
    contact_name:"Candidate Receiver",
    contact_phone:"13900008888",
    is_default:false,
  });
  assert.equal(candidateAddr.is_default,false);
  assert.equal(candidateAddr.active,true);

  // Switch candidateAddr to unique default
  const promotedAddr=await admin.fetch(`/staff/admin/warehouse-addresses/${candidateAddr.id}`,{
    is_default:true,
  });
  assert.equal(promotedAddr.is_default,true);
  const currentDefault=await c.fetch("/me/receiving-address");
  assert.equal(currentDefault.warehouse_address.id,candidateAddr.id);

  // Cannot deactivate current default address without promoting another first
  const deactDefault=await admin.fetch(`/staff/admin/warehouse-addresses/${candidateAddr.id}`,{active:false},"POST",409);
  assert.equal(deactDefault.error.code,"DEFAULT_ADDRESS_REQUIRED");

  // Restore original default address and deactivate candidateAddr while verifying adv1 still references initialAddr
  await admin.fetch(`/staff/admin/warehouse-addresses/${initialAddr.id}`,{is_default:true});
  const deactivated=await admin.fetch(`/staff/admin/warehouse-addresses/${candidateAddr.id}`,{active:false});
  assert.equal(deactivated.active,false);
  const advRow=(await pool.query("select address_id from package_advices where id=$1",[adv1.id])).rows[0];
  assert.equal(advRow.address_id,initialAddr.id,"Historical parcel advice must retain its original address_id (T04)");

  // Configure business calendar
  const cal=await admin.fetch("/staff/admin/calendar",{
    holidays:["2026-10-01","2026-10-02"],
    extra_workdays:["2026-10-10"],
  });
  assert.deepEqual(cal.holidays,["2026-10-01","2026-10-02"]);
  assert.deepEqual(cal.extra_workdays,["2026-10-10"]);

  // 5. TASK-124: Staff role assignment, self-lockout guard, and disable/restore (T26)
  const selfStrip=await admin.fetch(`/staff/users/${adminMe.id}/roles`,{
    roles:["support"],
    reason:"Attempt to strip own super_admin",
  },"POST",409);
  assert.equal(selfStrip.error.code,"SELF_LOCKOUT_FORBIDDEN","Super admin must not strip own super_admin role");

  const updatedRoles=await admin.fetch(`/staff/users/${staffMemberMe.id}/roles`,{
    roles:["inspector","reviewer"],
    reason:"Grant reviewer role after qualification",
  });
  assert.deepEqual(updatedRoles.roles,["inspector","reviewer"]);

  // Disable staffMember and verify active session is immediately rejected (T26)
  await admin.fetch(`/staff/users/${staffMemberMe.id}/status`,{
    status:"disabled",
    reason:"Temporary leave",
  });
  await staffMember.fetch("/staff/desk",undefined,"GET",401);

  await admin.fetch(`/staff/users/${staffMemberMe.id}/status`,{
    status:"active",
    reason:"Returned from leave",
  });
  await admin.fetch(`/staff/users/${staffMemberMe.id}/roles`,{
    roles:["inspector"],
    reason:"Restore default inspector role",
  });
  await staffMember.login("inspector@qcw.test");

  // 6. TASK-129: Customer privacy data export & deletion request with retention exceptions (PAGE-C16, T54)
  const exported=await c.fetch("/me/privacy/export");
  assert.ok(exported.orders.some((o:{id:string})=>o.id===o1.id));
  assert.equal(exported.retention_exceptions.active_orders,1);
  assert.equal(exported.retention_exceptions.can_close_immediately,false);
  assert.equal(exported.retention_exceptions.financial_and_audit_retained,true);

  const delReq=await c.fetch("/me/privacy/requests",{
    kind:"deletion",
    note:"Please review account deletion and retention obligations",
  },"POST",201);
  assert.match(delReq.public_no,/^PRV-/);
  assert.equal(delReq.retention_exceptions.active_orders,1);
  assert.equal(delReq.retention_exceptions.can_close_immediately,false);

  // Attempting immediate account closure while o1 is active must be blocked with 409
  const reauthStart=await c.fetch("/auth/reauth/start",{},"POST",202);
  await c.fetch("/auth/reauth/verify",{challenge_id:reauthStart.challenge_id,code:reauthStart.demo_code});
  const closeBlocked=await c.fetch("/me/account/close",{},"POST",409);
  assert.equal(closeBlocked.error.code,"ACCOUNT_HAS_ACTIVE_OBLIGATIONS");

  // 7. TASK-125 & TASK-130: System health check, recovery drill, and immutable audit log query
  const health=await admin.fetch("/staff/admin/system-health");
  assert.equal(health.healthy,true);
  assert.ok(health.immutable_triggers.includes("immutable_audit"));
  assert.ok(health.immutable_triggers.includes("freeze_report"));

  const drill=await admin.fetch("/staff/admin/recovery-runs",{
    note:"Scheduled point-in-time recovery verification drill",
  },"POST",201);
  assert.ok(drill.id);
  assert.equal(drill.reconciliation.verified,true);

  const auditRes=await admin.fetch(`/staff/audit?actor_id=${adminMe.id}&action=record_recovery_run`);
  assert.ok(auditRes.rows.some((r:{entity_id:string;action:string})=>r.entity_id===drill.id && r.action==="record_recovery_run"));
});

test("tracking monitor, exception episode deduplication, dual-control overdue disposal guard, and post-restore security replay (TASK-158, TASK-159, TASK-164, TASK-172, TASK-173, TASK-174)",async()=>{
  const admin=await staffLogin("admin");
  const reviewer=await staffLogin("reviewer");
  const receiving=await staffLogin("receiving");
  const {c,registration,terms}=await signCustomer();
  const stdOffer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1")!;
  const {draft:o1}=await createAndPay(
    c,
    [{category_id:stdOffer.category_id,offer_id:stdOffer.offer_id,quantity:1,attributes:{name:"Tracking & Disposal Item"}}],
    terms
  );

  // 1. TASK-158, TASK-159, TASK-164: Create parcel advice and test delivered-unreceived queue (T69/T78) + exception episode deduplication (T77)
  const waybill="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const adv=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,
    carrier_code:"zto",
    tracking_no:waybill,
    order_ids:[o1.id],
  },"POST",201);
  const {rows:[tracker]}=await pool.query("select id from tracking_records where advice_id=$1 order by generation desc limit 1",[adv.id]);
  const trackerId=tracker.id as string;

  const token=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
  await pool.query(`insert into tracking_subscriptions(tracker_id,provider,callback_token,salt_ciphertext,credential_version,status)
    values($1,'kuaidi100',$2,$3,'test','active')`,[trackerId,token,encryptSecret(salt)]);
  const callback="/webhooks/tracking/kuaidi100/"+token;
  async function pushCallback(payload:object) {
    const param=JSON.stringify(payload);
    const sign=createHash("md5").update(param+salt).digest("hex").toUpperCase();
    const res=await handle(new Request(origin+"/api/v1"+callback,{method:"POST",body:new URLSearchParams({sign,param})}),callback);
    assert.equal(res.status,200);
    for(let i=0;i<50;i++){if(!await workOnce())break;}
  }

  // Carrier reports delivered before warehouse check-in -> must appear in delivered_unreceived (T69/T78)
  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:waybill,state:"3",
      data:[{context:"快件已在门卫室签收",ftime:"2026-11-06 10:00:00",statusCode:"301"}],
    },
  });
  const mon1=await admin.fetch("/staff/tracking/monitor");
  assert.ok(mon1.carriers.length>=6,"Monitor must expose active carriers");
  assert.ok(mon1.delivered_unreceived.some((d:{tracking_id:string})=>d.tracking_id===trackerId),"Carrier delivered without physical check-in must appear in delivered_unreceived (T69/T78)");

  // Carrier reports exception (Episode 1)
  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:waybill,state:"2",
      data:[
        {context:"快件派送异常：收件地址无人接听",ftime:"2026-11-06 12:00:00",statusCode:"201"},
        {context:"快件已在门卫室签收",ftime:"2026-11-06 10:00:00",statusCode:"301"},
      ],
    },
  });
  const notifsAfterEp1_a=(await c.fetch("/me/notifications")).rows.filter((n:{template:string})=>n.template==="tracking.exception_opened");
  assert.equal(notifsAfterEp1_a.length,1,"Episode 1 exception must trigger exactly 1 notification (T77)");

  // Second callback within same exception episode -> must NOT create a second notification (T77 deduplication)
  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:waybill,state:"2",
      data:[
        {context:"快件异常处理中：等待二次联系",ftime:"2026-11-06 13:00:00",statusCode:"202"},
        {context:"快件派送异常：收件地址无人接听",ftime:"2026-11-06 12:00:00",statusCode:"201"},
      ],
    },
  });
  const notifsAfterEp1_b=(await c.fetch("/me/notifications")).rows.filter((n:{template:string})=>n.template==="tracking.exception_opened");
  assert.equal(notifsAfterEp1_b.length,1,"Repeated exception callbacks in same episode must deduplicate notification (T77)");

  // Staff acknowledges Episode 1 alert
  const monEp1=await admin.fetch("/staff/tracking/monitor");
  const alertEp1=monEp1.alerts.find((a:{tracker_id:string;kind:string;episode:number})=>a.tracker_id===trackerId && a.kind==="exception" && a.episode===1);
  assert.ok(alertEp1,"Episode 1 alert must be listed in monitor");
  const acked=await admin.fetch(`/staff/tracking-alerts/${alertEp1.id}`,{action:"acknowledge",note:"Contacting carrier"});
  assert.equal(acked.state,"acknowledged");

  // Carrier resumes normal transit -> automatically resolves Episode 1
  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:waybill,state:"0",
      data:[
        {context:"快件已恢复正常派送中转",ftime:"2026-11-06 14:00:00",statusCode:"001"},
        {context:"快件异常处理中：等待二次联系",ftime:"2026-11-06 13:00:00",statusCode:"202"},
      ],
    },
  });
  const {rows:[resolvedEp1]}=await pool.query("select state from tracking_alerts where id=$1",[alertEp1.id]);
  assert.equal(resolvedEp1.state,"resolved","Normal transit event must auto-resolve Episode 1 alert");

  // Carrier enters a new exception later -> opens Episode 2 and delivers a 2nd notification (T77)
  await pushCallback({
    status:"polling",
    lastResult:{
      com:"zhongtong",nu:waybill,state:"2",
      data:[
        {context:"快件二次派送异常：园区临时封闭",ftime:"2026-11-06 16:00:00",statusCode:"203"},
        {context:"快件已恢复正常派送中转",ftime:"2026-11-06 14:00:00",statusCode:"001"},
      ],
    },
  });
  const notifsAfterEp2=(await c.fetch("/me/notifications")).rows.filter((n:{template:string})=>n.template==="tracking.exception_opened");
  assert.equal(notifsAfterEp2.length,2,"New exception episode (Episode 2) after recovery must send a new notification (T77)");

  const monEp2=await admin.fetch("/staff/tracking/monitor");
  const alertEp2=monEp2.alerts.find((a:{tracker_id:string;kind:string;episode:number})=>a.tracker_id===trackerId && a.kind==="exception" && a.episode===2);
  assert.ok(alertEp2,"Episode 2 alert must exist");
  const manualResolved=await admin.fetch(`/staff/tracking-alerts/${alertEp2.id}`,{action:"resolve",note:"Gate reopened"});
  assert.equal(manualResolved.state,"resolved");

  // 2. TASK-172: Overdue/restricted disposal queue, dual-control approval, list_hash guard, and production execution switch (PAGE-M05, T104)
  const outerPhoto=await receiving.photo("intake_outer");
  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:waybill,advice_id:adv.id,carrier_code:"zto",outer_media_ids:[outerPhoto],
  },"POST",201);
  const desk=await receiving.fetch("/staff/desk");
  const locId=desk.locations.find((l:{code:string})=>l.code==="R-01").id;
  const itemCode="DSP-"+randomUUID().slice(0,8).toUpperCase();
  const createdItems=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,
    items:[{code:itemCode,location_id:locId}],
  },"POST",201);
  const dispItemId=createdItems.item_ids[0] as string;

  // Expire storage_until so the item is overdue
  await pool.query("update warehouse_items set storage_until=now()-interval '5 days' where id=$1",[dispItemId]);

  const dispQueue=await admin.fetch("/staff/disposals");
  assert.ok(dispQueue.overdue_items.some((i:{id:string})=>i.id===dispItemId),"Expired item must appear in overdue_items queue");

  const {rows:[custOrg]}=await pool.query("select org_id from orders where id=$1",[o1.id]);
  const dispCase=await receiving.fetch("/staff/disposals",{
    org_id:custOrg.org_id,
    item_ids:[dispItemId],
    reason:"Overdue > 30 days after two customer notices",
    legal_basis_version:"TOS-2026-V2",
  },"POST",201);
  assert.equal(dispCase.state,"pending_approval");
  assert.ok(dispCase.list_hash);

  // Requester cannot self-approve (dual-control guard)
  const selfApprove=await receiving.fetch(`/staff/disposals/${dispCase.id}/approve`,{
    revision:dispCase.revision,
    list_hash:dispCase.list_hash,
    reason:"Self approval attempt",
  },"POST",403);
  assert.equal(selfApprove.error.code,"SELF_REVIEW_FORBIDDEN");

  // Independent reviewer with tampered list_hash must fail with 409 DISPOSAL_LIST_CHANGED
  const wrongHash=await reviewer.fetch(`/staff/disposals/${dispCase.id}/approve`,{
    revision:dispCase.revision,
    list_hash:"0000000000000000000000000000000000000000000000000000000000000000",
    reason:"Tampered hash",
  },"POST",409);
  assert.equal(wrongHash.error.code,"DISPOSAL_LIST_CHANGED");

  // Independent reviewer approves with matching list_hash
  const approvedCase=await reviewer.fetch(`/staff/disposals/${dispCase.id}/approve`,{
    revision:dispCase.revision,
    list_hash:dispCase.list_hash,
    reason:"Verified overdue notices and item list snapshot",
  });
  assert.equal(approvedCase.state,"approved");

  // Executing disposal while production switch is disabled must be blocked (T104)
  const execBlocked=await admin.fetch(`/staff/disposals/${dispCase.id}/execute`,{
    revision:approvedCase.revision,
    method:"destroy",
    witness_note:"Attempt before production switch enabled",
  },"POST",409);
  assert.equal(execBlocked.error.code,"DISPOSAL_EXECUTION_DISABLED");

  // Enable production disposal switch with formal legal basis, execute, then turn switch back off
  await admin.fetch("/staff/admin/disposal-execution-switch",{
    enabled:true,
    legal_basis_version:"TOS-2026-V2",
    reason:"Legal counsel approved disposal policy v2",
  });
  try {
    const executedCase=await admin.fetch(`/staff/disposals/${dispCase.id}/execute`,{
      revision:approvedCase.revision,
      method:"destroy",
      witness_note:"Dual-person physical disposal completed",
    });
    assert.equal(executedCase.state,"executed");
    const {rows:[afterDisp]}=await pool.query("select custody_state,location_id from warehouse_items where id=$1",[dispItemId]);
    assert.equal(afterDisp.custody_state,"disposed");
    assert.equal(afterDisp.location_id,null);
  } finally {
    await admin.fetch("/staff/admin/disposal-execution-switch",{
      enabled:false,
      legal_basis_version:"TOS-2026-V2",
      reason:"Reset switch after test",
    });
  }

  // 3. TASK-173: Post-restore replay manifest (revoked sessions, suppressed emails) & external payment/handover reconciliation (T105, T106)
  const adminActorId=(await admin.fetch("/me")).actor.id as string;
  const {rows:[adminSession]}=await pool.query(
    `insert into sessions(id,user_id,kind,token_hash,auth_version,expires_at)
     values(gen_random_uuid(),$1,'staff',$2,1,now()+interval '1 day')
     returning id`,
    [adminActorId,"resurrected-token-"+randomUUID()]
  );
  const replayEmail=`resurrected-${randomUUID().slice(0,8)}@example.com`;
  const replayDrill=await admin.fetch("/staff/admin/recovery-runs",{
    environment:"staging-pitr-drill",
    backup_reference:"pg-basebackup-20261107-01",
    rpo_seconds:0,
    rto_seconds:38,
    revoked_session_ids:[adminSession.id],
    suppressed_emails:[replayEmail],
    notes:"Verify T105 post-restore revocation replay and T106 payment/handover reconciliation",
  },"POST",201);
  assert.equal(replayDrill.replayed.sessions_revoked,1,"Post-restore replay must revoke resurrected session IDs (T105)");
  assert.equal(replayDrill.replayed.emails_suppressed,1,"Post-restore replay must re-apply email suppressions (T105)");
  assert.equal(replayDrill.reconciliation.verified,true,"External payment and shipment handover reconciliation must verify cleanly (T106)");

  const {rows:[checkSess]}=await pool.query("select revoked_at from sessions where id=$1",[adminSession.id]);
  assert.ok(checkSess.revoked_at,"Resurrected session must have revoked_at set after recovery replay");
});

test("Week 28 full-chain regression: 1/5-item standard & 3-item compare, 3-to-2 with late-arriving 3rd sample, selective split outbound, and production catalog purity (TASK-136 to TASK-140, T43-T62, T107-T111)",async()=>{
  const {c,registration,terms}=await signCustomer();
  const other=await signCustomer();
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const reviewer=await staffLogin("reviewer");
  const admin=await staffLogin("admin");

  const desk=await receiving.fetch("/staff/desk");
  const locId=(desk.locations.find((l:{code:string})=>l.code==="R-01")??desk.locations[0]).id as string;
  const catalog=await c.fetch("/catalog");
  const apparelInspect=catalog.offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1")!;
  const apparelCompare=catalog.offers.find((o:{sku_code:string})=>o.sku_code==="apparel-compare-3")!;

  // 1. TASK-137 (T59, T60): 5-item standard inspection order -> creates 5 expected_items and 5 individual inspection tasks upon assignment
  const {draft:fiveOrder}=await createAndPay(
    c,
    [{
      category_id:apparelInspect.category_id,
      offer_id:apparelInspect.offer_id,
      quantity:5,
      items:Array.from({length:5},(_,i)=>({sample_code:`STD5-${i+1}`,size_label:"M",color_declared:"Black"})),
    }],
    terms
  );
  const fiveDetail=await c.fetch(`/orders/${fiveOrder.id}`);
  assert.equal(fiveDetail.items.length,5,"5-item standard order must create 5 expected_items positions (T60)");

  const fiveWaybill="SF"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const fiveAdv=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,
    carrier_code:"sf",
    tracking_no:fiveWaybill,
    order_ids:[fiveOrder.id],
  },"POST",201);
  const fivePkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:fiveWaybill,
    advice_id:fiveAdv.id,
    carrier_code:"sf",
    outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const fiveIntake=await receiving.fetch(`/staff/packages/${fivePkg.id}/items`,{
    revision:fivePkg.revision,
    items:Array.from({length:5},()=>({code:"S-"+randomUUID(),location_id:locId})),
  },"POST",201);
  assert.equal(fiveIntake.item_ids.length,5);

  for(let i=0;i<5;i++) {
    await receiving.fetch(`/staff/items/${fiveIntake.item_ids[i]}/assign`,{
      revision:1,
      order_line_id:fiveDetail.items[i].order_line_id,
      expected_item_id:fiveDetail.items[i].id,
      evidence_ids:[await receiving.photo("label_photo")],
    });
  }
  const fiveQueued=await c.fetch(`/orders/${fiveOrder.id}`);
  assert.equal(fiveQueued.state,"queued","5-item order must transition to queued once all 5 items are assigned");
  const {rows:fiveTasks}=await pool.query(
    "select t.id from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1",
    [fiveOrder.id]
  );
  assert.equal(fiveTasks.length,5,"5-item standard inspection must generate 5 per-item inspection_tasks");

  // 2. TASK-138 (T47): 3-item comparison order -> 2 items arrive -> convert-to-two -> 2 items inspected & report published -> 3rd late item arrives later and is independently returned to seller
  const {draft:cmp3Order}=await createAndPay(
    c,
    [{
      category_id:apparelCompare.category_id,
      offer_id:apparelCompare.offer_id,
      quantity:3,
      items:[
        {sample_code:"CMP-A",size_label:"L",color_declared:"Navy"},
        {sample_code:"CMP-B",size_label:"L",color_declared:"Navy"},
        {sample_code:"CMP-C-LATE",size_label:"L",color_declared:"Navy"},
      ],
    }],
    terms
  );
  const cmp3Detail=await c.fetch(`/orders/${cmp3Order.id}`);
  assert.equal(cmp3Detail.items.length,3);

  const earlyWaybill="ZTO"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const earlyAdv=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,
    carrier_code:"zto",
    tracking_no:earlyWaybill,
    order_ids:[cmp3Order.id],
  },"POST",201);
  const earlyPkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:earlyWaybill,
    advice_id:earlyAdv.id,
    carrier_code:"zto",
    outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const earlyItems=await receiving.fetch(`/staff/packages/${earlyPkg.id}/items`,{
    revision:earlyPkg.revision,
    items:[{code:"S-"+randomUUID(),location_id:locId},{code:"S-"+randomUUID(),location_id:locId}],
  },"POST",201);

  for(let i=0;i<2;i++) {
    await receiving.fetch(`/staff/items/${earlyItems.item_ids[i]}/assign`,{
      revision:1,
      order_line_id:cmp3Detail.items[i].order_line_id,
      expected_item_id:cmp3Detail.items[i].id,
      evidence_ids:[await receiving.photo("label_photo")],
    });
    await receiving.fetch(`/staff/items/${earlyItems.item_ids[i]}/identify`,{
      revision:2,
      matches_advice:true,
      evidence_ids:[await receiving.photo("label_photo")],
    });
  }

  // Convert 3-item comparison to 2-item comparison before 3rd sample arrives (T47)
  const convRes=await c.fetch(`/orders/${cmp3Order.id}/convert-to-two`,{
    expected_item_id:cmp3Detail.items[2].id,
    reason:"Supplier delayed 3rd sample; proceed with 2-item comparison",
  });
  assert.equal(convRes.state,"queued");
  assert.equal(convRes.adjustment_cents,-2000);
  assert.ok(convRes.refund_ticket_id,"3-to-2 conversion must create exactly 1 refund review ticket");

  // Complete inspection & publish report for the converted 2-item comparison order
  const {rows:cmp2Tasks}=await pool.query(
    "select t.id,t.revision from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1 order by t.id",
    [cmp3Order.id]
  );
  assert.equal(cmp2Tasks.length,1);
  for(const tk of cmp2Tasks) {
    const started=await inspector.fetch(`/staff/inspection-tasks/${tk.id}/start`,{revision:tk.revision});
    const view=await inspector.fetch(`/staff/inspection-tasks/${tk.id}`);
    await submitRequiredChecks(inspector,tk.id,started.revision,view);
  }
  const cmp3AfterTasks=await c.fetch(`/orders/${cmp3Order.id}`);
  const cmpReport=await inspector.fetch(`/staff/orders/${cmp3Order.id}/report/submit`,{
    revision:cmp3AfterTasks.revision,
    task_ids:cmp2Tasks.map((t:{id:string})=>t.id),
  });
  await reviewer.fetch(`/staff/reports/${cmpReport.id}/approve`,{
    revision:1,
    checklist:["reviewed_en","evidence_checked"],
  },"POST",202);
  for(let i=0;i<50;i++){if(!await workOnce())break;}
  const cmp3Published=await c.fetch(`/orders/${cmp3Order.id}`);
  assert.equal(cmp3Published.state,"report_ready");

  // Now the 3rd late-arriving parcel physically arrives at the warehouse (T47)
  const lateWaybill="YTO"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  const lateAdv=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,
    carrier_code:"yto",
    tracking_no:lateWaybill,
    order_ids:[cmp3Order.id],
  },"POST",201);
  const latePkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:lateWaybill,
    advice_id:lateAdv.id,
    carrier_code:"yto",
    outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const lateIntake=await receiving.fetch(`/staff/packages/${latePkg.id}/items`,{
    revision:latePkg.revision,
    items:[{code:"S-LATE-"+randomUUID().slice(0,8).toUpperCase(),location_id:locId}],
  },"POST",201);
  const lateItemId=lateIntake.item_ids[0] as string;

  // Late item cannot be assigned to the already-dropped 3rd position
  const assignDropped=await receiving.fetch(`/staff/items/${lateItemId}/assign`,{
    revision:1,
    order_line_id:cmp3Detail.items[2].order_line_id,
    expected_item_id:cmp3Detail.items[2].id,
    evidence_ids:[await receiving.photo("label_photo")],
  },"POST",409);
  assert.ok(assignDropped.error.code);

  // Customer still sees the late item in /me/items and can independently instruct return to seller (T47, T107)
  const myItems=(await c.fetch("/me/items")).items as {item_id:string;allowed_actions:string[]}[];
  const foundLate=myItems.find(x=>x.item_id===lateItemId);
  assert.ok(foundLate,"Late-arriving 3rd sample must remain traceable in customer's /me/items (T47)");
  assert.ok(foundLate.allowed_actions.includes("request_disposition"));

  const termsId=terms.find((t:{kind:string})=>t.kind==="terms")!.id as string;
  const lateDisp=await c.fetch(`/me/items/${lateItemId}/dispositions`,{
    action:"return_to_seller",
    destination:{
      recipient:"Seller Return Warehouse",
      phone:"13800009999",
      address:"No. 99 Seller Road, Guangzhou",
    },
    return_info:{
      requested_from_seller:true,
      customer_pays_shipping:true,
    },
    terms_version_id:termsId,
  },"POST",201);
  assert.ok(lateDisp.id);

  // 3. TASK-139 (T50, T51): Selective split disposition on the 2-item order (Item 1 -> forwarder, Item 2 -> return to seller)
  const dispForward=await c.fetch(`/orders/${cmp3Order.id}/dispositions`,{
    item_id:earlyItems.item_ids[0],
    action:"to_forwarder",
    destination:{
      recipient:"Forwarder Shenzhen",
      phone:"13900001111",
      address:"Forwarder Bay 12, Shenzhen",
      member_code:registration.receiving_code,
    },
    terms_version_id:termsId,
  },"POST",201);
  const dispReturn=await c.fetch(`/orders/${cmp3Order.id}/dispositions`,{
    item_id:earlyItems.item_ids[1],
    action:"return_to_seller",
    destination:{
      recipient:"Seller Return Dept",
      phone:"13800002222",
      address:"Seller Park 8, Hangzhou",
    },
    return_info:{
      requested_from_seller:true,
      customer_pays_shipping:true,
    },
    terms_version_id:termsId,
  },"POST",201);
  assert.ok(dispForward.id);
  assert.ok(dispReturn.id);

  // Attempting to merge two seller returns is blocked by BATCH_MISMATCH; each seller return forms its own traceable batch (T47, T76, T107)
  const mergeReturnErr=await c.fetch("/dispatch-batches",{
    disposition_ids:[dispReturn.id,lateDisp.id],
  },"POST",409);
  assert.equal(mergeReturnErr.error.code,"BATCH_MISMATCH");

  const lateReturnBatch=await c.fetch("/dispatch-batches",{
    disposition_ids:[lateDisp.id],
  },"POST",201);
  assert.ok(lateReturnBatch.batch_id);

  // 4. TASK-140 (T57, T58): Verify cross-tenant IDOR & offline version conflict recovery
  await other.c.fetch(`/orders/${cmp3Order.id}`,undefined,"GET",404);
  await other.c.fetch(`/orders/${cmp3Order.id}/report`,undefined,"GET",404);
  await c.fetch("/staff/admin/system-health",undefined,"GET",403);
});

test("Week 29 & Week 30 rehearsal archiving, Hong Kong legal entity configuration, and §23 go-live gate enforcement (TASK-141 to TASK-150, TASK-165)",async()=>{
  const {c}=await signCustomer();
  const admin=await staffLogin("admin");

  // Customer cannot access launch readiness or signoff endpoints
  await c.fetch("/staff/admin/launch-readiness",undefined,"GET",403);
  await c.fetch("/staff/admin/legal-entity",{
    entity_name:"Unauthorized Co",
    entity_address:"123 Fake St",
    br_number:"BR-000",
    support_email:"fake@example.com",
  },"POST",403);

  // 1. Initial launch readiness check before legal entity & 5 rehearsal scenarios are archived
  const initialReadiness=await admin.fetch("/staff/admin/launch-readiness");
  assert.equal(initialReadiness.gates.warehouse_address,true);
  assert.equal(initialReadiness.gates.legal_terms,true);
  assert.equal(initialReadiness.gates.shipping_rates,true);
  assert.equal(initialReadiness.gates.catalog_purity,true);
  assert.equal(initialReadiness.gates.legal_entity_configured,false);
  assert.equal(initialReadiness.gates.rehearsal_sets_completed,false);
  assert.equal(initialReadiness.effective_mode,"staging_only");
  assert.equal(typeof initialReadiness.in_flight_summary.in_flight_orders,"number");

  // 2. Configure Hong Kong legal entity metadata (TASK-146 / Appendix C.12)
  const legalEntity=await admin.fetch("/staff/admin/legal-entity",{
    entity_name:"QC Warehouse Hong Kong Limited",
    entity_address:"Unit 1208, 12/F, Harbour Centre, Wan Chai, Hong Kong",
    br_number:"HK-BR-76543210",
    support_email:"legal-support@qcwarehouse.com",
  },"POST",200);
  assert.equal(legalEntity.entity_name,"QC Warehouse Hong Kong Limited");
  assert.equal(legalEntity.br_number,"HK-BR-76543210");

  // 3. Archive all 5 rehearsal scenarios (TASK-141 to TASK-145, TASK-165) with environment separation & reverification
  const scenarios=[
    {scenario:"set_1_standard",environment:"real_warehouse",media_count:18,carrier_codes:["sf"],reverified:true,notes:"Set 1: Standard intake -> inspection -> report PDF -> disposition & handover verified"},
    {scenario:"set_2_weak_network",environment:"real_warehouse",media_count:14,carrier_codes:["yto"],reverified:true,notes:"Set 2: Handheld weak network retry, offline draft recovery, label readback & bin move verified"},
    {scenario:"set_3_return_retain",environment:"real_warehouse",media_count:16,carrier_codes:["zto","sf"],reverified:true,notes:"Set 3: Return to seller, reference retention, and multi-item consolidation/split batch verified"},
    {scenario:"set_4_recovery_alerts",environment:"staging",media_count:10,carrier_codes:["ems"],reverified:true,notes:"Set 4: Carrier return receipt, background job alert & manual retry recovery verified"},
    {scenario:"three_carrier_30_items",environment:"real_warehouse",media_count:90,carrier_codes:["sf","yto","zto"],reverified:true,notes:"TASK-165: 3-carrier 30-item inbound/outbound tracking & receipt archive verified (separated from production)"},
  ] as const;

  for(const item of scenarios) {
    const run=await admin.fetch("/staff/admin/rehearsal-runs",{
      ...item,
      passed:true,
    },"POST",201);
    assert.equal(run.scenario,item.scenario);
    assert.equal(run.passed,true);
  }

  // Ensure a verified recovery drill is present for §23 gate
  await admin.fetch("/staff/admin/recovery-runs",{
    environment:"staging-prelaunch",
    backup_reference:"pg-dump-launch-gate",
    rpo_seconds:0,
    rto_seconds:30,
    notes:"Pre-launch PITR & reconciliation verification",
  },"POST",201);

  // 4. Re-check launch readiness: internal & rehearsal gates are now satisfied
  const updatedReadiness=await admin.fetch("/staff/admin/launch-readiness");
  assert.equal(updatedReadiness.gates.legal_entity_configured,true);
  assert.equal(updatedReadiness.gates.rehearsal_sets_completed,true);
  assert.equal(updatedReadiness.gates.recovery_drill_verified,true);
  assert.equal(updatedReadiness.rehearsal_coverage.completed_scenarios.length,5);
  assert.ok(updatedReadiness.rehearsal_coverage.reverified_count>=1);

  // 5. TASK-150: Attempting to sign off target_mode="production" while external live provider gates are missing is blocked with 409 LAUNCH_GATES_INCOMPLETE ("缺一项即维持预发布")
  if(!updatedReadiness.all_gates_satisfied) {
    const prodBlocked=await admin.fetch("/staff/admin/launch-signoff",{
      target_mode:"production",
      rollback_contact:"ops-oncall@qcwarehouse.com",
      first_order_invite_enabled:false,
      notes:"Attempt production switch before external live keys are injected",
    },"POST",409);
    assert.equal(prodBlocked.error.code,"LAUNCH_GATES_INCOMPLETE");
  }

  // 6. TASK-148 to TASK-150: Signing off staging_only mode records rollback contact, penny test ref, and first-order invite state
  const stagingSignoff=await admin.fetch("/staff/admin/launch-signoff",{
    target_mode:"staging_only",
    rollback_contact:"ops-oncall@qcwarehouse.com (+852-5555-0199)",
    first_order_invite_enabled:true,
    live_penny_test_ref:"STRIPE-TEST-PENNY-001",
    notes:"All engineering & rehearsal gates verified; maintaining staging_only until live external credentials are switched by business owner.",
  },"POST",200);
  assert.equal(stagingSignoff.effective_mode,"staging_only");
  assert.equal(stagingSignoff.signoff.rollback_contact,"ops-oncall@qcwarehouse.com (+852-5555-0199)");
  assert.equal(stagingSignoff.signoff.first_order_invite_enabled,true);
});

test("parcel post-linking, staff object quick-summary RBAC, item_code incident filing, super_admin/finance media permissions, and enriched customer/admin desks",async()=>{
  const receiving=await staffLogin("receiving");
  const inspector=await staffLogin("inspector");
  const admin=await staffLogin("admin");
  await pool.query("insert into staff_roles(user_id,role) select id,'support' from users where display_name='reviewer' on conflict do nothing");
  staffSessions.delete("reviewer");
  const supportOnly=await staffLogin("reviewer");

  const {c,registration,terms}=await signCustomer();
  const {c:otherCustomer}=await signCustomer();
  const termsId=terms.find((t:{kind:string})=>t.kind==="terms")!.id;
  const offer=(await c.fetch("/catalog")).offers.find((o:{sku_code:string})=>o.sku_code==="apparel-inspection-1");

  // 1. Register an inbound parcel first without an order, then link it to a newly created order via POST /me/parcels/{id}/link-order
  const waybillNo="SF"+randomUUID().slice(0,10).toUpperCase();
  const advice=await c.fetch("/me/parcels",{
    address_id:registration.warehouse_address.id,
    tracking_no:waybillNo,
    carrier_code:"sf",
    order_ids:[],
  },"POST",201);

  const {draft:order}=await createAndPay(c,[{
    category_id:offer.category_id,offer_id:offer.offer_id,quantity:1,options:{},
    attributes:{name:"Quick-Link Jacket"},items:[{position:1,sample_code:"QL-01",name:"Quick-Link Jacket"}],
  }],terms);

  // Cross-tenant guard: another customer cannot link our parcel or link to our order
  await otherCustomer.fetch(`/me/parcels/${advice.id}/link-order`,{order_id:order.id},"POST",404);

  const linked1=await c.fetch(`/me/parcels/${advice.id}/link-order`,{order_id:order.id},"POST",200);
  assert.equal(linked1.linked,true);
  // Idempotent repeat call
  const linked2=await c.fetch(`/me/parcels/${advice.id}/link-order`,{order_id:order.id},"POST",200);
  assert.equal(linked2.linked,true);

  const ordAfterLink=await c.fetch(`/orders/${order.id}`);
  assert.equal(ordAfterLink.parcels.length,1);
  assert.equal(ordAfterLink.parcels[0].tracking_norm,waybillNo);
  assert.equal(ordAfterLink.parcels[0].carrier_code,"sf");

  // 2. Super-admin & finance media upload + check-in & unpack + /staff/object-summary RBAC
  const adminLabelPhoto=await admin.photo("label_photo");
  assert.ok(adminLabelPhoto);
  const adminPayoutProof=await admin.photo("attachment");
  assert.ok(adminPayoutProof);

  const pkg=await receiving.fetch("/staff/intake/check-in",{
    tracking_no:waybillNo,advice_id:advice.id,carrier_code:"sf",outer_media_ids:[await receiving.photo("intake_outer")],
  },"POST",201);
  const {locations}=await receiving.fetch("/staff/desk");
  const loc=locations.find((l:{code:string})=>l.code==="R-01")??locations[0];
  const sampleOne="S-"+randomUUID().slice(0,8).toUpperCase();
  const sampleTwo="S-"+randomUUID().slice(0,8).toUpperCase();
  const unpacked=await receiving.fetch(`/staff/packages/${pkg.id}/items`,{
    revision:pkg.revision,
    items:[{code:sampleOne,location_id:loc.id},{code:sampleTwo,location_id:loc.id}],
  },"POST",201);
  const pkgDetail=await receiving.fetch(`/staff/packages/${pkg.id}`);
  const pkgCode=pkgDetail.parcel.code;

  // Customer and unauthorized inspector RBAC checks on /staff/object-summary
  await c.fetch(`/staff/object-summary?kind=item&ref=${encodeURIComponent(sampleOne)}`,undefined,"GET",403);
  await inspector.fetch(`/staff/object-summary?kind=package&ref=${encodeURIComponent(pkgCode)}`,undefined,"GET",403);
  await inspector.fetch(`/staff/object-summary?kind=item&ref=${encodeURIComponent(sampleOne)}`,undefined,"GET",403);

  const sumTracking=await receiving.fetch(`/staff/object-summary?kind=tracking&ref=${encodeURIComponent(waybillNo)}`);
  assert.equal(sumTracking.kind,"tracking");
  assert.equal(sumTracking.tracker.package_code,pkgCode);
  assert.ok(Array.isArray(sumTracking.tracker.media_ids) && sumTracking.tracker.media_ids.length>=1);

  const sumPackage=await receiving.fetch(`/staff/object-summary?kind=package&ref=${encodeURIComponent(pkgCode)}`);
  assert.equal(sumPackage.kind,"package");
  assert.equal(sumPackage.parcel.code,pkgCode);
  assert.equal(sumPackage.items.length,2);

  const sumItem=await receiving.fetch(`/staff/object-summary?kind=item&ref=${encodeURIComponent(sampleOne)}`);
  assert.equal(sumItem.kind,"item");
  assert.equal(sumItem.item.code,sampleOne);

  // 3. Create incident by human-readable item_code (S-...) instead of raw UUID, and resolve compensation with attachment proof
  const incQueue=await receiving.fetch("/staff/incidents");
  assert.ok(Array.isArray(incQueue.eligible_items));
  assert.ok(incQueue.eligible_items.some((it:{code:string})=>it.code===sampleOne));

  const createdInc=await receiving.fetch("/staff/incidents",{
    item_code:sampleOne,
    kind:"damage",
    summary_en:"Corner scuff discovered during shelf transfer",
    evidence_ids:[await receiving.photo("defect")],
  },"POST",201);
  assert.equal(createdInc.state,"open");
  const custInc=await c.fetch(`/me/incidents/${createdInc.id}`);
  assert.equal(custInc.item_id,unpacked.item_ids[0]);
  assert.equal(custInc.item_code,sampleOne);

  await receiving.fetch(`/staff/incidents/${createdInc.id}/propose`,{
    compensation_cents:1500,
    summary_en:"Offering $15.00 compensation for shelf scuff",
  });
  await admin.fetch(`/staff/incidents/${createdInc.id}/approve`,{
    reason:"Approved $15.00 incident compensation",
  });
  await c.fetch(`/me/incidents/${createdInc.id}/response`,{
    decision:"accept",
    note:"Accepted compensation",
  });
  const settledInc=await admin.fetch(`/staff/incidents/${createdInc.id}/resolve`,{
    payout_reference:"BANK-TX-99881",
    payout_method:"manual_bank_transfer",
    paid_amount_cents:1500,
    proof_media_ids:[adminPayoutProof],
    note:"Transferred $15.00",
  });
  assert.equal(settledInc.state,"resolved");
  assert.equal(settledInc.paid,true);
  // Support can read the payout proof attachment linked to incident_cases
  const proofUrls=await supportOnly.fetch(`/media/${adminPayoutProof}/url`);
  assert.ok(proofUrls.url);

  // 4. Enriched customerDesk (active_batches + recent_destinations) & adminDesk (customerUsers with email masking for non-super_admin)
  const dispTwo=await c.fetch(`/me/items/${unpacked.item_ids[1]}/dispositions`,{
    action:"to_forwarder",
    destination:{recipient:"Shenzhen Forwarder Hub",phone:"13900139000",address:"Warehouse 9, Baoan, Shenzhen",member_code:"FWD-7788"},
    terms_version_id:termsId,
  },"POST",201);
  const plannedBatch=await c.fetch("/dispatch-batches",{disposition_ids:[dispTwo.id]},"POST",201);
  await c.fetch(`/dispatch-batches/${plannedBatch.batch_id}/confirm`,{revision:plannedBatch.revision});

  const sumBatch=await receiving.fetch(`/staff/object-summary?kind=batch&ref=${plannedBatch.batch_id}`);
  assert.equal(sumBatch.kind,"batch");
  assert.equal(sumBatch.batch.id,plannedBatch.batch_id);

  const custDesk=await c.fetch("/me/desk");
  assert.ok(Array.isArray(custDesk.active_batches) && custDesk.active_batches.some((b:{id:string})=>b.id===plannedBatch.batch_id));
  assert.ok(Array.isArray(custDesk.recent_destinations) && custDesk.recent_destinations.some((d:{member_code?:string})=>d.member_code==="FWD-7788"));

  const superAdminDesk=await admin.fetch("/staff/admin/desk");
  const fullRow=superAdminDesk.customerUsers.find((u:{receiving_code:string})=>u.receiving_code===registration.receiving_code);
  assert.ok(fullRow && !String(fullRow.email).includes("***"));

  const supportDesk=await supportOnly.fetch("/staff/admin/desk");
  const maskedRow=supportDesk.customerUsers.find((u:{receiving_code:string})=>u.receiving_code===registration.receiving_code);
  assert.ok(maskedRow && String(maskedRow.email).includes("***"));
});

test("all core operations have a validated success response",assertCoreCoverage);
