import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { z } from "zod";
import { transaction, pool, type DB } from "../db";
import { actorFrom, appOrigin, completeRegistration, cookie, currentTerms, finishProvider, getCookie, pendingProvider, staffSignIn, startOtp, startProvider, verifyOtp, reportDownloadSignature, verifyReportDownload } from "./auth";
import { Problem, guard, hash, idempotent, isDemo, one, organization, role, uuid, type Actor } from "./common";
import { integrationPreflight } from "./integrations";
import { catalog, issueManualQuote, orderDetail, quoteOrder, requestManualQuote, saveOrder, submitOrder } from "./orders";
import { advise, assign, checkIn, decideIntakeClaim, intakeItems, lookup, requestIntakeClaim, savePhoto } from "./intake";
import { approveReport, readReport, recordResults, startTask, submitReport, submitTask, taskDetail } from "./inspection";
import { acceptQuote, confirmBatch, handover, instruct, packShipment, planBatch, quoteBatch, receiveReturn, storageQuote } from "./dispatch";
import { checkout, demoPay, refundApprove, refundRequest, stripeEvent, verifyStripe } from "./payments";
import { providerCallback, tracking, trackingAdmin, verificationState, verifyTracking } from "./logistics";
import { adminDesk, bills, customerDesk, items, readOrderByPublicNumber, warehouseDesk } from "./reads";
import { acceptScope, cancelOrder, moveItem, newTemplate, publishTemplate, reportIssue, scopeProposal, setAddress, staffSchemas } from "./operations";

type ContractOperation={
  operationId:string; "x-roles":string[];
  requestBody?:{content:{"application/json":{schema:object}}};
  parameters:{name:string;in:string;schema:{type?:string}}[];
  responses:Record<string,unknown>;
};
const ajv=new Ajv2020({strict:false,allErrors:false});
addFormats(ajv);
const contract=parse(readFileSync(resolve(process.cwd(),"docs/contracts/core.openapi.yaml"),"utf8")) as {
  paths:Record<string,Record<string,ContractOperation>>; components:{schemas:Record<string,object>};
};
const documentId="https://qcwarehouse.invalid/core";
ajv.addSchema({$id:documentId,components:contract.components});
function validateSchema(schema:object) {
  const expanded=JSON.parse(JSON.stringify(schema).replaceAll('"#/components/schemas/',`"${documentId}#/components/schemas/`));
  return ajv.compile(expanded);
}
const operations=Object.entries(contract.paths).flatMap(([path,methods])=>Object.entries(methods).map(([method,op])=>({
  method:method.toUpperCase(), re:new RegExp("^"+path.replace(/\{[^}]+\}/g,"([^/]+)")+"$"),
  op, path, validate:op.requestBody?validateSchema(op.requestBody.content["application/json"].schema):null,
  status:Number(Object.keys(op.responses).find(k=>/^2/.test(k))??200),
})));
const idSchema=z.string().uuid();
const revSchema=z.number().int().positive();
const emailSchema=z.email().max(254).transform(v=>v.toLowerCase());
const photoKinds=z.enum(["intake_outer","intake_open","label_photo","shot","dispatch","attachment"]);
function json(value:unknown,status=200,cookies:string[] = []) {
  const headers=new Headers({"cache-control":"no-store"});
  for(const c of cookies) headers.append("set-cookie",c);
  return Response.json(value,{status,headers});
}
function redirect(to:string,cookies:string[] = []) {
  const headers=new Headers({location:to,"cache-control":"no-store"});
  for(const c of cookies) headers.append("set-cookie",c);
  return new Response(null,{status:303,headers});
}
function browserKey(req:Request) { return getCookie(req,"qcw_browser") || uuid(); }
async function input(req:Request) {
  const text=await req.text();
  guard(text.length<=1_000_000,"BODY_TOO_LARGE","Request is too large.",413);
  try { return text ? JSON.parse(text):{}; }
  catch { throw new Problem("BAD_JSON","Invalid JSON request.",400); }
}
function actorRequired(actor:Actor|null):Actor {
  guard(actor,"SIGN_IN_REQUIRED","Sign in to continue.",401);
  return actor;
}
function csrf(req:Request) {
  const origin=req.headers.get("origin");
  guard(origin===appOrigin(),"ORIGIN_REJECTED","This request must come from QC Warehouse.",403);
}
function authResult(result:{state:string;secret:string;kind:string}) {
  return result.state==="signed_in"
    ? [cookie("session",result.secret,43200),cookie("qcw_provider","",0)]
    : [cookie("qcw_onboarding",result.secret,1200),cookie("qcw_provider","",0)];
}
function binary(file:{data:Buffer;mime:string}) {
  return new Response(new Uint8Array(file.data),{headers:{"content-type":file.mime,"cache-control":"private, no-store","x-content-type-options":"nosniff"}});
}
async function photoRead(db:DB,actor:Actor,id:string) {
  const m=await one(db,"select * from media_assets where id=$1 and status='ready'",[id]);
  if(actor.kind==="customer") {
    const org=organization(actor);
    guard(m.org_id===org && m.result_id,"NOT_FOUND","Photo not found.",404);
    await one(db,`select v.id from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
      where o.org_id=$2 and v.state in ('published','superseded') and exists(
      select 1 from jsonb_array_elements(v.snapshot->'sections') s, jsonb_array_elements(s->'results') x
      where (x->'evidence_ids') ? $1) limit 1`,[id,org]);
  } else {
    role(actor,"receiver","warehouse_admin","inspector","reviewer","support","super_admin");
    const claimProof=m.kind==="attachment" && actor.roles.some(r=>["support","super_admin"].includes(r)) &&
      (await db.query("select 1 from tickets where category='identity_unclear' and details->>'proof_id'=$1",[id])).rowCount;
    const claimOuter=m.kind==="intake_outer" && m.org_id===null && actor.roles.some(r=>["support","super_admin"].includes(r)) &&
      (await db.query(`select 1 from tracking_records t join tickets k on k.details->>'tracking_no'=t.tracking_norm
        and coalesce(t.carrier_code,k.details->>'carrier_code')=k.details->>'carrier_code'
        where t.package_id=$1 and t.closed_at is null and t.org_id is null
        and k.category='identity_unclear' and k.state='open' and k.details ? 'proof_id'`,[m.package_id])).rowCount;
    guard(claimProof || claimOuter || m.uploaded_by===actor.id || actor.roles.includes("warehouse_admin") && m.kind!=="attachment" ||
      (actor.roles.includes("reviewer") && m.task_id),"NOT_FOUND","Photo not found.",404);
  }
  return binary(await one<{data:Buffer;mime:string}>(db,"select data,mime from private_files where key=$1",[m.object_key]));
}
async function extras(req:Request,path:string,actor:Actor|null):Promise<Response|null> {
  const method=req.method;
  const url=new URL(req.url);
  if(method==="GET" && path==="/health") {
    await pool.query("select 1");
    return json({status:"ok"});
  }
  if(method==="GET" && path==="/catalog") return json({offers:await transaction(catalog)});
  if(method==="GET" && path==="/carriers") return json({carriers:(await pool.query("select code,labels from carriers where enabled order by code")).rows});
  if(method==="GET" && path==="/public/terms") return json({terms:await transaction(db=>currentTerms(db,["terms","privacy","restricted_items","report_notice"]))});
  if(method==="GET" && path==="/auth/providers") {
    const cfg=integrationPreflight();
    return json({google:cfg.google.configured,microsoft:cfg.microsoft.configured,demo:cfg.demo});
  }
  if(method==="GET" && path==="/staff/admin/tracking/health") {
    role(actorRequired(actor),"super_admin");
    return json({check:"local_configuration_only",...integrationPreflight().kuaidi100});
  }
  const oid=path.match(/^\/auth\/(google|microsoft)\/(start|callback)$/);
  if(method==="GET" && oid) {
    const browser=browserKey(req);
    const provider=oid[1]==="google"?"google":"microsoft";
    const clear=cookie("qcw_provider","",0);
    try {
      if(oid[2]==="start") return redirect(await startProvider(provider,browser),[cookie("qcw_browser",browser,3600),clear]);
      const result=await finishProvider(provider,url,browser);
      if(result.state==="cancelled") return redirect("/login?oauth=cancelled",[clear]);
      if(result.state==="verify_email") return redirect("/login?verify=1",[cookie("qcw_provider",result.secret,900)]);
      return redirect(result.state==="onboarding"?"/onboarding":"/account",authResult(result));
    } catch (e) {
      return redirect("/login?oauth="+(e instanceof Problem&&e.code==="IDENTITY_LINK_REQUIRED"?"link_required":"failed"),[clear]);
    }
  }
  if(method==="POST" && path==="/auth/otp/request") {
    csrf(req);
    const {email}=z.object({email:emailSchema}).parse(await input(req));
    const browser=browserKey(req);
    let identity:ReturnType<typeof pendingProvider>;
    try {
      identity=pendingProvider(getCookie(req,"qcw_provider"),email,browser);
    } catch (error) {
      if(!(error instanceof Problem)) throw error;
      return json({error:{code:error.code,message:error.message}},error.status,[cookie("qcw_provider","",0)]);
    }
    return json(await startOtp(email,browser,identity),202,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="POST" && path==="/auth/otp/verify") {
    csrf(req);
    const {challenge_id,code}=z.object({challenge_id:idSchema,code:z.string().regex(/^\d{6}$/)}).parse(await input(req));
    const result=await verifyOtp(challenge_id,code,getCookie(req,"qcw_browser"));
    return json({state:result.state,kind:result.kind},200,authResult(result));
  }
  if(method==="POST" && path==="/staff/auth/login") {
    csrf(req);
    const data=z.object({email:emailSchema,password:z.string().min(1).max(256),otp:z.string().regex(/^\d{6}$/)}).parse(await input(req));
    const secret=await staffSignIn(data.email,data.password,data.otp);
    guard(secret,"LOGIN_FAILED","The staff credentials are invalid.",401);
    return json({state:"signed_in",kind:"staff"},200,[cookie("session",secret,43200)]);
  }
  if(method==="POST" && path==="/auth/logout") {
    csrf(req);
    const sid=getCookie(req,"session");
    if(sid) await pool.query("update sessions set revoked_at=now() where token_hash=$1",[hash(sid)]);
    return json({ok:true},200,[cookie("session","",0),cookie("qcw_onboarding","",0),cookie("qcw_provider","",0)]);
  }
  if(method==="POST" && path==="/webhooks/stripe") {
    const event=verifyStripe(await req.text(),req.headers.get("stripe-signature")??"");
    return json(await transaction(db=>stripeEvent(db,event)));
  }
  const callback=path.match(/^\/webhooks\/tracking\/kuaidi100\/([a-f0-9]{64})$/);
  if(method==="POST" && callback) {
    const raw=await req.text();
    guard(raw.length<=500000,"BODY_TOO_LARGE","Callback too large.",413);
    return json(await transaction(db=>providerCallback(db,callback[1],raw)));
  }
  if(method==="GET" && path==="/me") return json({actor:actorRequired(actor)});
  if(method==="GET" && path==="/me/desk") return json(await transaction(db=>customerDesk(db,actorRequired(actor))));
  if(method==="GET" && path==="/me/receiving-address") {
    const a=actorRequired(actor);organization(a);
    const {receiving}=await import("./auth");
    return json(await transaction(db=>receiving(db,a.id)));
  }
  if(method==="GET" && path==="/staff/desk") return json(await transaction(db=>warehouseDesk(db,actorRequired(actor))));
  if(method==="GET" && path==="/staff/admin/desk") return json(await transaction(db=>adminDesk(db,actorRequired(actor))));
  if(method==="GET" && path==="/staff/tracking") return json({rows:await transaction(db=>trackingAdmin(db,actorRequired(actor)))});
  const byNo=path.match(/^\/orders\/by-number\/(QW-[A-F0-9]+)$/);
  if(method==="GET" && byNo) return json(await transaction(db=>readOrderByPublicNumber(db,actorRequired(actor),byNo[1])));
  const order=path.match(/^\/orders\/([a-f0-9-]{36})$/i);
  if(method==="GET" && order) return json(await transaction(db=>orderDetail(db,actorRequired(actor),idSchema.parse(order[1]))));
  const task=path.match(/^\/staff\/inspection-tasks\/([a-f0-9-]{36})$/i);
  if(method==="GET" && task) return json(await transaction(db=>taskDetail(db,actorRequired(actor),idSchema.parse(task[1]))));
  const report=path.match(/^\/orders\/([a-f0-9-]{36})\/report(?:\/versions\/(\d+)(\/file)?)?$/i);
  if(method==="GET" && report) return transaction(async db=>{
    const a=actorRequired(actor);
    const r=await readReport(db,a,idSchema.parse(report[1]),report[2]?Number(report[2]):undefined);
    if(report[3]) {
      verifyReportDownload(a.id,r.id,url.searchParams.get("expires")??"",url.searchParams.get("sig")??"");
      return binary(await one<{data:Buffer;mime:string}>(db,"select data,mime from private_files where key=$1",[r.pdf_key]));
    }
    return json({id:r.id,version:r.version,state:r.state,snapshot:r.snapshot,published_at:r.published_at});
  });
  const media=path.match(/^\/media\/([a-f0-9-]{36})$/i);
  if(method==="GET" && media) return transaction(db=>photoRead(db,actorRequired(actor),idSchema.parse(media[1])));
  if(method==="POST" && path==="/staff/media") {
    csrf(req);
    const a=actorRequired(actor);role(a,"receiver","warehouse_admin","inspector");
    guard(Number(req.headers.get("content-length")??0)<=8_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const form=await req.formData(),file=form.get("photo");
    guard(file instanceof File,"FILE_INVALID","Choose a photo.",422);
    const kind=photoKinds.parse(form.get("kind")),bytes=Buffer.from(await file.arrayBuffer());
    return json(await transaction(db=>savePhoto(db,a,bytes,kind)),201);
  }
  if(method==="POST" && path==="/me/intake-claims") {
    csrf(req);
    const a=actorRequired(actor);organization(a);
    const key=idSchema.parse(req.headers.get("idempotency-key"));
    guard(Number(req.headers.get("content-length")??0)<=8_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const form=await req.formData(),photo=form.get("photo");
    guard(photo instanceof File && photo.size<=8_000_000,"FILE_INVALID","Choose a photo up to 8 MB.",422);
    const fields=z.object({tracking_no:z.string().min(5).max(80),carrier_code:z.string().min(1).max(40),advice_id:idSchema.optional()}).parse(
      {tracking_no:form.get("tracking_no"),carrier_code:form.get("carrier_code"),advice_id:form.get("advice_id")||undefined});
    const bytes=Buffer.from(await photo.arrayBuffer());
    return json(await transaction(db=>idempotent(db,a.id+":"+path,key,{...fields,proof:hash(bytes)},
      ()=>requestIntakeClaim(db,a,fields,bytes))),201);
  }
  const claim=path.match(/^\/staff\/intake-claims\/([a-f0-9-]{36})\/decision$/i);
  if(method==="POST" && claim) return extraWrite(req,path,actor,z.object({
    decision:z.enum(["approve","reject"]),reason:z.string().trim().min(4).max(1000)
  }),(db,a,b)=>decideIntakeClaim(db,a,idSchema.parse(claim[1]),b.decision,b.reason));
  const verification=path.match(/^\/me\/parcels\/([a-f0-9-]{36})\/tracking-verification$/i);
  if(verification && method==="GET") return json(await transaction(db=>verificationState(db,actorRequired(actor),idSchema.parse(verification[1]))));
  if(verification && method==="POST") return extraWrite(req,path,actor,z.object({revision:revSchema,
    carrier_code:z.string().min(1).max(40),phone:z.string().max(30).optional()
  }),(db,a,b)=>verifyTracking(db,a,idSchema.parse(verification[1]),b));
  const manual=path.match(/^\/orders\/([a-f0-9-]{36})\/manual-quote-request$/i);
  if(method==="POST" && manual) return extraWrite(req,path,actor,z.object({revision:revSchema,reason:z.string().trim().min(4).max(1200)}),
    (db,a,b)=>requestManualQuote(db,a,idSchema.parse(manual[1]),b.revision,b.reason));
  if(method==="POST" && path==="/me/cases") {
    const b=z.object({subject:z.string().trim().min(2).max(150),message:z.string().trim().min(2).max(2000),order_id:idSchema.optional()});
    return extraWrite(req,path,actor,b,(db,a,v)=>reportIssue(db,a,v.subject,v.message,v.order_id));
  }
  if(method==="POST" && path==="/staff/admin/warehouse-addresses")
    return extraWrite(req,path,actor,staffSchemas.address,setAddress);
  if(method==="POST" && path==="/staff/admin/templates")
    return extraWrite(req,path,actor,staffSchemas.template,newTemplate);
  const publish=path.match(/^\/staff\/admin\/templates\/([a-f0-9-]{36})\/publish$/i);
  if(method==="POST" && publish) return extraWrite(req,path,actor,z.object({}),(db,a)=>publishTemplate(db,a,idSchema.parse(publish[1])));
  const store=path.match(/^\/staff\/dispositions\/([a-f0-9-]{36})\/storage-quote$/i);
  if(method==="POST" && store) return extraWrite(req,path,actor,z.object({}),(db,a)=>storageQuote(db,a,idSchema.parse(store[1])));
  const cancel=path.match(/^\/orders\/([a-f0-9-]{36})\/cancel$/i);
  if(method==="POST" && cancel) return extraWrite(req,path,actor,z.object({revision:revSchema}),(db,a,b)=>cancelOrder(db,a,idSchema.parse(cancel[1]),b.revision));
  if(method==="POST" && path==="/staff/storage/move") return extraWrite(req,path,actor,z.object({
    item_id:idSchema,revision:revSchema,location_id:idSchema}),(db,a,b)=>moveItem(db,a,b.item_id,b.revision,b.location_id));
  const fake=path.match(/^\/checkout\/demo\/([a-f0-9-]{36})$/i);
  if(method==="POST" && fake && isDemo()) return extraWrite(req,path,actor,z.object({}),(db,a)=>demoPay(db,a,idSchema.parse(fake[1])));
  return null;
}
async function extraWrite<S extends z.ZodType>(req:Request,path:string,actor:Actor|null,schema:S,run:(db:DB,actor:Actor,data:z.output<S>)=>Promise<unknown>) {
  csrf(req);
  const a=actorRequired(actor),key=idSchema.parse(req.headers.get("idempotency-key")),data=schema.parse(await input(req));
  return json(await transaction(db=>idempotent(db,a.id+":"+path,key,data,()=>run(db,a,data))));
}

// The request is validated against the operation's OpenAPI schema before dispatch.
async function dispatch(db:DB,actor:Actor,id:string,op:string,b:Record<string,any>,req:Request) {
  switch(op) {
    case "createDraft": return saveOrder(db,actor,b as Parameters<typeof saveOrder>[2]);
    case "editDraft": return saveOrder(db,actor,b as Parameters<typeof saveOrder>[2],id);
    case "quoteOrder": return quoteOrder(db,actor,id,b.revision);
    case "issueManualQuote": return issueManualQuote(db,actor,id,b as Parameters<typeof issueManualQuote>[3]);
    case "submitOrder": return submitOrder(db,actor,id,b as Parameters<typeof submitOrder>[3]);
    case "checkout": return checkout(db,actor,id,b.quote_revision);
    case "adviseParcel": return advise(db,actor,b as Parameters<typeof advise>[2]);
    case "lookupParcel": return lookup(db,actor,b as Parameters<typeof lookup>[2]);
    case "checkIn": return checkIn(db,actor,b as Parameters<typeof checkIn>[2]);
    case "intakeItems": return intakeItems(db,actor,id,b as Parameters<typeof intakeItems>[3]);
    case "assignItem": return assign(db,actor,id,b as Parameters<typeof assign>[3]);
    case "startTask": return startTask(db,actor,id,b.revision);
    case "recordResults": return recordResults(db,actor,id,b.revision,b.results);
    case "submitTask": return submitTask(db,actor,id,b.revision);
    case "submitReport": return submitReport(db,actor,id,b.revision,b.task_ids);
    case "approveReport": return approveReport(db,actor,id,b.revision,b.checklist);
    case "instruct": return instruct(db,actor,b.item_id,b as Parameters<typeof instruct>[3],id);
    case "instructWithoutOrder": return instruct(db,actor,id,b as Parameters<typeof instruct>[3]);
    case "planBatch": return planBatch(db,actor,b.disposition_ids);
    case "confirmBatch": return confirmBatch(db,actor,id,b.revision);
    case "quoteBatch": return quoteBatch(db,actor,id,b.revision,b.rate_version_id,b.parcels);
    case "acceptShippingQuote": return acceptQuote(db,actor,id,b.revision);
    case "packShipment": return packShipment(db,actor,id,b as Parameters<typeof packShipment>[3]);
    case "handover": return handover(db,actor,id,b as Parameters<typeof handover>[3]);
    case "receiveShipmentReturn": return receiveReturn(db,actor,id,b as Parameters<typeof receiveReturn>[3]);
    case "trackInbound":
    case "trackOutbound":
      return tracking(db,actor,id,op==="trackInbound"?"advice":"shipment",new URL(req.url).searchParams.get("locale")??"en");
    case "ownedItems": return {items:(await items(db,actor)).map(x=>({item_id:x.item_id,code:x.code,custody_state:x.custody_state,allowed_actions:x.allowed_actions}))};
    case "billing": return {charges:(await bills(db,actor)).map(x=>({
      charge_item_id:x.charge_item_id,purpose:x.purpose,state:x.state,amount_cents:x.amount_cents,currency:x.currency,
      refunded_cents:x.refunded_cents,order_ids:x.order_ids
    }))};
    case "references": return {items:(await db.query(`select id reference_id,item_id,state,expires_at from reference_samples where org_id=$1 order by expires_at desc`,[organization(actor)])).rows};
    case "requestRefund": return refundRequest(db,actor,b.payment_id,b.amount_cents,b.reason,id);
    case "requestPaymentRefund": return refundRequest(db,actor,id,b.amount_cents,b.reason);
    case "approveRefund": return refundApprove(db,actor,id,b.revision,hash(getCookie(req,"session")));
    case "proposeScope": return scopeProposal(db,actor,id,b as Parameters<typeof scopeProposal>[3]);
    case "acceptScope": return acceptScope(db,actor,id,b.revision);
    case "reportPDF": {
      const n=Number(new URL(req.url).pathname.match(/\/versions\/(\d+)\/pdf$/)?.[1]);
      const r=await readReport(db,actor,id,n);
      const expires=Date.now()+300000;
      const query=new URLSearchParams({expires:String(expires),sig:reportDownloadSignature(actor.id,r.id,expires)});
      return {version:r.version,url:`${appOrigin()}/api/v1/orders/${id}/report/versions/${n}/file?${query}`,expires_at:new Date(expires)};
    }
    default: throw new Problem("NOT_IMPLEMENTED","This operation is still being implemented.",501);
  }
}
export async function handle(req:Request,path:string) {
  try {
    const actor=await actorFrom(req);
    const entry=operations.find(e=>e.method===req.method && e.re.test(path));
    if(!entry) {
      const response=await extras(req,path,actor);
      if(response) return response;
      return json({error:{code:"NOT_FOUND",message:"This endpoint does not exist."}},404);
    }
    const {op,validate,status,re}=entry;
    const args=re.exec(path)?.slice(1)??[];
    const pathParams=op.parameters.filter(p=>p.in==="path");
    for(const [i,arg] of args.entries()) {
      if(pathParams[i]?.schema.type==="integer") z.coerce.number().int().positive().parse(arg);
      else idSchema.parse(arg);
    }
    if(req.method!=="GET") csrf(req);
    const data=validate?await input(req):{};
    if(validate && !validate(data)) throw new Problem("INVALID_REQUEST",`Check the submitted fields: ${validate.errors?.[0]?.instancePath??""} ${validate.errors?.[0]?.message??""}`,422);
    const key=op.parameters.some(p=>p.in==="header" && p.name.toLowerCase()==="idempotency-key")
      ?idSchema.parse(req.headers.get("idempotency-key")):null;
    if(op.operationId==="completeRegistration") {
      const result=await completeRegistration(getCookie(req,"qcw_onboarding"),getCookie(req,"qcw_browser"),data.terms_version_ids);
      return json(result.profile,status,[cookie("session",result.secret,43200),cookie("qcw_onboarding","",0)]);
    }
    const a=actorRequired(actor);
    guard(a.kind==="customer"?op["x-roles"].includes("customer"):op["x-roles"].some(r=>a.roles.includes(r)),
      "FORBIDDEN","This action requires a different role.",403);
    return json(await transaction(db=>{
      const run=()=>dispatch(db,a,args[0]??"",op.operationId,data,req);
      return key?idempotent(db,a.id+":"+req.method+":"+path,key,data,run):run();
    }),status);
  } catch(e) {
    if(e instanceof Problem) return json({error:{code:e.code,message:e.message}},e.status);
    if(e instanceof z.ZodError) return json({error:{code:"INVALID_REQUEST",message:e.issues.map(x=>x.path.join(".")+": "+x.message).join("; ")}},422);
    if(e instanceof Error && "code" in e && ["23505","23514","23503"].includes(String(e.code))) {
      return json({error:{code:"RECORD_CONFLICT",message:"This operation conflicts with an existing record or state."}},409);
    }
    console.error("QC Warehouse request failed",req.method,path,e instanceof Error?{name:e.name,code:"code" in e?e.code:undefined}:undefined);
    return json({error:{code:"SERVER_ERROR",message:"The operation failed. Retry or contact support."}},500);
  }
}
