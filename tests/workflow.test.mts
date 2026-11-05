import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import sharp from "sharp";
import Stripe from "stripe";

const target=process.env.TEST_DATABASE_URL;
assert(target && /qcw_test\b/.test(target),"Set TEST_DATABASE_URL to an isolated qcw_test database.");
assert.notEqual(target,process.env.DATABASE_URL,"The test database must be separate.");
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
    const data=await response.json();
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
  const desk=await staff.fetch("/staff/desk"),loc=desk.locations[0].id;
  const items=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:[{code:"S-"+randomUUID(),location_id:loc}]},"POST",201);
  const itemId=items.item_ids[0];
  assert.equal((await c.fetch("/me/items")).items[0].item_id,itemId);
  const offer=(await c.fetch("/catalog")).offers.find((o:{service:string;category:{en:string}})=>o.service==="inspection"&&o.category.en===category);
  assert(offer);
  const {draft}=await createAndPay(c,[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}],terms);
  await another.c.fetch("/orders/"+draft.id,undefined,"GET",404);
  await c.fetch("/staff/desk",undefined,"GET",403);
  const order=await c.fetch("/orders/"+draft.id);
  assert.equal(order.state,"awaiting_samples");
  const e=order.items[0],label=await staff.photo("label_photo");
  const bind={revision:1,order_line_id:e.order_line_id,expected_item_id:e.id,evidence_ids:[label]};
  await staff.fetch("/staff/items/"+itemId+"/assign",bind);
  await staff.fetch("/staff/items/"+itemId+"/assign",bind,"POST",409);
  const task=(await inspector.fetch("/staff/desk")).tasks.find((t:{order_id:string})=>t.order_id===draft.id);
  const started=await inspector.fetch("/staff/inspection-tasks/"+task.id+"/start",{revision:task.revision});
  await inspector.fetch("/staff/inspection-tasks/"+task.id+"/submit",{revision:started.revision},"POST",409);
  const view=await inspector.fetch("/staff/inspection-tasks/"+task.id);
  assert.equal(view.content.checks[0].label,{"Apparel":"Visible condition","Bags":"Hardware condition","Home goods":"Surface finish"}[category]);
  const photo=await inspector.photo("shot");
  const measured=await inspector.photo("shot");
  const results=view.content.checks.filter((x:{required:boolean})=>x.required).map((x:{key:string;method:string;unit?:string;type:string})=>({
    item_key:x.key,component:"main",attempt:1,status:"RECORDED",method:x.method,typed_value:x.type==="number"?0:false,
    ...(x.unit?{unit:x.unit}:{}),is_final:true,evidence_ids:[x.type==="number"?measured:photo]
  }));
  const saved=await inspector.fetch("/staff/inspection-tasks/"+task.id+"/results",{revision:started.revision,results},"PUT");
  await inspector.fetch("/staff/inspection-tasks/"+task.id+"/submit",{revision:saved.revision});
  const inspecting=await c.fetch("/orders/"+draft.id);
  const report=await inspector.fetch("/staff/orders/"+draft.id+"/report/submit",{revision:inspecting.revision,task_ids:[task.id]});
  await c.fetch("/orders/"+draft.id+"/report",undefined,"GET",404);
  await reviewer.fetch("/staff/reports/"+report.id+"/approve",{revision:1,checklist:["reviewed_en","evidence_checked"]},"POST",202);
  await c.fetch("/orders/"+draft.id+"/report",undefined,"GET",404);
  for(let i=0;i<50;i++){if(!await workOnce())break;}
  const pdfPath="/orders/"+draft.id+"/report/versions/1";
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
  const instr=await c.fetch("/me/items/"+itemId+"/dispositions",{action:forward?"to_forwarder":"return_to_seller",
    terms_version_id:terms.find((t:{kind:string})=>t.kind==="terms").id,destination,
    ...(!forward?{return_info:{requested_from_seller:true,customer_pays_shipping:true}}:{})},"POST",201);
  const batch=await c.fetch("/dispatch-batches",{disposition_ids:[instr.id]},"POST",201);
  const confirmed=await c.fetch("/dispatch-batches/"+batch.batch_id+"/confirm",{revision:batch.revision});
  const rate=desk.rates[0].id;
  const quote=await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/quote",{revision:confirmed.revision,rate_version_id:rate,parcels:[{item_ids:[itemId],weight_g:540}]});
  const packedPhoto=await staff.photo("dispatch");
  const packing={revision:quote.revision,quote_id:quote.quote_id,item_ids:[itemId],weight_g:540,packed_media_ids:[packedPhoto]};
  await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/parcels",packing,"POST",409);
  const fee=await c.fetch("/quotes/"+quote.quote_id+"/accept",{revision:quote.revision});
  const payment=await c.fetch("/charges/"+fee.charge_item_id+"/checkout",{quote_revision:quote.revision});
  await c.fetch("/checkout/demo/"+payment.attempt_id,{});
  const shipment=await staff.fetch("/staff/dispatch-batches/"+batch.batch_id+"/parcels",{...packing,revision:quote.revision+1},"POST",201);
  const actual="YTO"+randomUUID().slice(0,8).toUpperCase();
  const hand={revision:shipment.revision,item_ids:[itemId],carrier_code:"yto",tracking_no:actual,evidence_ids:[await staff.photo("dispatch")],handed_at:new Date().toISOString()};
  await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/handover",hand);
  await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/handover",hand,"POST",409);
  const outbound=await c.fetch("/shipments/"+shipment.shipment_id+"/tracking");
  assert.equal(outbound.tracking_no,actual);assert.equal(outbound.direction,forward?"outbound_forward":"outbound_return");assert.equal(outbound.warehouse_state,"shipped");
  assert.equal((await c.fetch("/me/items")).items[0].custody_state,"outbound");
  const returned={revision:shipment.revision+1,item_ids:[itemId],location_id:loc,evidence_ids:[await staff.photo("dispatch")],received_at:new Date().toISOString()};
  const confirmedReturn=await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/receive-return",returned);
  const repeated=await staff.fetch("/staff/shipments/"+shipment.shipment_id+"/receive-return",returned);
  assert.equal(confirmedReturn.return_status,"complete");assert.equal(repeated.revision,confirmedReturn.revision);
  assert.equal((await c.fetch("/me/items")).items[0].custody_state,"stored");
});
}

test("30 items and a separate 3-item comparison have different frozen price rules",async()=>{
  const {c,terms,registration}=await signCustomer();
  const offers=(await c.fetch("/catalog")).offers;
  const normal=offers.find((o:{service:string;category:{en:string}})=>o.service==="inspection"&&o.category.en==="Apparel");
  const compare=offers.find((o:{service:string;rules:{minimum:number}})=>o.service==="compare"&&o.rules.minimum===3);
  const {draft,quote}=await createAndPay(c,[
    {category_id:normal.category_id,offer_id:normal.offer_id,quantity:30},
    {category_id:compare.category_id,offer_id:compare.offer_id,quantity:3},
  ],terms);
  assert.equal(quote.amount_cents,30*normal.rules.unit_cents+compare.rules.package_cents);
  const d=await c.fetch("/orders/"+draft.id);
  assert.equal(d.items.length,33);
  assert.equal(d.items.filter((r:{quantity:number})=>r.quantity===30).length,30);
  assert.equal(d.items.filter((r:{quantity:number})=>r.quantity===3).length,3);
  const staff=await staffLogin("receiving");
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const advice=await c.fetch("/me/parcels",{address_id:registration.warehouse_address.id,carrier_code:"zto",tracking_no:tracking,order_ids:[draft.id]},"POST",201);
  const pkg=await staff.fetch("/staff/intake/check-in",{tracking_no:tracking,advice_id:advice.id,carrier_code:"zto",outer_media_ids:[await staff.photo("intake_outer")]},"POST",201);
  const desk=await staff.fetch("/staff/desk");
  const listed=d.items.map(()=>({code:"S-"+randomUUID(),location_id:desk.locations[0].id}));
  const {item_ids}=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:listed},"POST",201);
  assert.equal(item_ids.length,33);
  for(const [index,position] of d.items.entries()) {
    await staff.fetch("/staff/items/"+item_ids[index]+"/assign",{revision:1,order_line_id:position.order_line_id,
      expected_item_id:position.id,evidence_ids:[await staff.photo("label_photo")]});
  }
  const {rows:[{standard,comparison}]}=await pool.query(`select count(t.assignment_id)::int standard,count(t.group_id)::int comparison
    from inspection_tasks t join order_lines l on l.id=t.order_line_id where l.order_id=$1`,[draft.id]);
  assert.equal(standard,30);
  assert.equal(comparison,1);
});

test("unmatched intake remains private until a staff evidence decision",async()=>{
  const {c}=await signCustomer(),another=(await signCustomer()).c;
  const staff=await staffLogin("receiving"),support=await staffLogin("admin");
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const outer=await staff.photo("intake_outer");
  const pkg=await staff.fetch("/staff/intake/check-in",{tracking_no:tracking,carrier_code:"zto",outer_media_ids:[outer]},"POST",201);
  assert.equal(pkg.state,"unmatched");
  const desk=await staff.fetch("/staff/desk");
  const saved=await staff.fetch("/staff/packages/"+pkg.id+"/items",{revision:pkg.revision,items:[{code:"S-"+randomUUID(),location_id:desk.locations[0].id}]},"POST",201);
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
  const draft=await c.fetch("/orders",{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:101}]},"POST",201);
  const path="/orders/"+draft.id;
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
    const start=await providerGet(base+"/start");
    assert.equal(start.status,303);
    const auth=new URL(start.headers.get("location")!);
    assert.equal(auth.searchParams.get("redirect_uri"),origin+"/api/v1"+base+"/callback");
    assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
    assert(auth.searchParams.get("nonce") && auth.searchParams.get("code_challenge"));
    const state=auth.searchParams.get("state")!;
    const browser=start.headers.getSetCookie().find(x=>x.startsWith("qcw_browser="))!.split(";")[0];
    const query="?error=access_denied&state="+encodeURIComponent(state);
    assert.equal((await providerGet(base+"/callback",query,"qcw_browser=wrong")).headers.get("location"),"/login?oauth=failed");
    assert.equal((await providerGet(base+"/callback",query,browser)).headers.get("location"),"/login?oauth=cancelled");
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
    return {tracking,path};
  }
  const ok=await fixtureTracking("1999-12-31");
  const limited=await fixtureTracking("2000-01-01");
  setFixtureEnv(t,{QCW_DEMO:"0",KUAIDI100_KEY:"key-fixture",KUAIDI100_CUSTOMER:"customer-fixture",
    TRACKING_CALLBACK_BASE_URL:"https://callbacks.example.test"});
  const config=await (await staffLogin("admin")).fetch("/staff/admin/tracking/health");
  assert.equal(config.check,"local_configuration_only");
  assert.equal(config.queryConfigured,true);
  assert(!JSON.stringify(config).includes("key-fixture"));
  await c.fetch("/staff/admin/tracking/health",undefined,"GET",403);
  const fetch=t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    assert.equal(url,"https://poll.kuaidi100.com/poll/query.do");
    const form=init.body as URLSearchParams;
    const param=form.get("param")!;
    const query=JSON.parse(param);
    assert([ok.tracking,limited.tracking].includes(query.num));
    assert.equal(query.lang,"en");
    assert(query.phone);
    assert.equal(form.get("sign"),createHash("md5").update(param+"key-fixturecustomer-fixture").digest("hex").toUpperCase());
    if(query.num===ok.tracking) return Response.json({status:"200",state:"3",com:"shunfeng",nu:ok.tracking,
      data:[{context:"Delivered to receiving desk",ftime:"2026-11-04 15:03:00",status:"Delivered",statusCode:"301"}]});
    return Response.json({result:false,returnCode:"504",message:"Fixture rate limit"});
  });
  assert.equal(await syncTrackingOnce(),true);
  assert.equal(await syncTrackingOnce(),true);
  assert.equal(fetch.mock.callCount(),2);
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
