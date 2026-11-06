import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const {encryptSecret,decryptSecret}=await import("../packages/core/auth");

before(async()=>{
  const actual=await pool.query<{name:string}>("select current_database() name");
  assert.equal(actual.rows[0].name,databaseName,"Connected to a different database than expected.");
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
    const req=new Request(origin+"/api/v1"+path,{method,headers:{
      cookie:[...this.jar].map(([k,v])=>k+"="+v).join("; "),
      ...(method!=="GET"?{origin,"Idempotency-Key":key,...(!multipart?{"content-type":"application/json"}:{})}:{})
    },...(body!==undefined?{body:multipart?body:JSON.stringify(body)}:{})});
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

test("all core operations have a validated success response",assertCoreCoverage);
