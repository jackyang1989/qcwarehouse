import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { z } from "zod";
import { transaction, pool, type DB } from "../db";
import { actorFrom, appOrigin, closeCustomerAccount, completeRegistration, confirmEmailChange, cookie, csrfCookie, csrfTokenFor, currentTerms, decideAccountRecovery, executeAccountRecovery, finishProvider, getCookie, linkProviderIdentity, listIdentities, listSessions, pendingProvider, publicPolicy, readAccountRecoveryStatus, reportDownloadSignature, reportShareToken, requestAccountRecovery, requestEmailChange, revokeOtherSessions, revokeSession, staffSignIn, staffUpdateUserStatus, startCustomerReauth, startOtp, startProvider, unlinkIdentity, verifyCsrfToken, verifyCustomerReauth, verifyOtp, verifyReportDownload } from "./auth";
import { Problem, audit, guard, hash, idempotent, isDemo, one, organization, role, uuid, type Actor } from "./common";
import { integrationPreflight, signInMethods } from "./integrations";
import { failedJobs, retryFailedJob } from "./worker";
import { customerEmailDeliveryStatus, receivePostmarkWebhook, retryEmailDelivery, staffEmailDeliveries } from "./email";
import { catalog, issueManualQuote, orderDetail, quoteOrder, requestManualQuote, saveOrder, submitOrder } from "./orders";
import { advise, assign, bindUnmatchedPackageOwner, checkIn, decideIntakeClaim, identifyItem, intakeItems, lookup, quarantineItem, quarantinePackage, requestIntakeClaim, savePhoto, unassignItem, waybill } from "./intake";
import { amendReport, amendReportInput, approveReport, checkTaskCompleteness, editReportRevision, findInspectionTaskByScan, readReport, recordResults, recordTaskShot, recordTaskStep, reportDesk, returnReport, revisionChanges, staffReport, startTask, submitReport, submitReportRevision, submitTask, taskDetail } from "./inspection";
import { acceptQuote, confirmBatch, handover, instruct, packShipment, planBatch, quoteBatch, receiveReturn, releaseReferenceSample, storageQuote } from "./dispatch";
import { checkout, demoPay, orderPayment, orderRefundPayments, refundApprove, refundRequest, stripeEvent, verifyStripe } from "./payments";
import { approveTrackingTranslation, correctCustomerParcelTracking, correctStaffTracking, providerCallback, refreshTracking, submitTrackingTranslation, tracking, trackingAdmin, verificationState, verifyTracking } from "./logistics";
import { adminDesk, bills, customerActions, customerDesk, customerNotifications, dispatchQueueStates, items, markNotificationRead, readOrderByPublicNumber, searchStaffOrders, staffOrderDetail, staffOrderFilters, warehouseDesk, warehouseDispatchBatch, warehouseDispatchQueue, warehouseItem, warehousePackage } from "./reads";
import { staffAccess } from "./staff-access";
import { customerDestination, withDestination } from "./portal-routes";
import { orderFulfillmentRecord } from "./fulfillment-reads";
import { canReadCasePhoto, caseDetail, createPublicInquiry, customerTicketMessage, inquiryCategories, publicInquiry, replyToCase, staffTicketEvent, staffTicketQueue, writeStaffTicket } from "./tickets";
import { createLocations, locationBatchSchema, locationMaster, setLocationActive, storageMovementDesk } from "./storage";
import { acceptScope, approveCapability, cancelOrder, convertOrderToTwo, createCapability, createCategory, extendOrderArrival, holdOrder, moveItem, newTemplate, orderCaseCategory, publishSkuPrice, publishTemplate, reportIssue, respondOrderMismatch, resumeOrder, revokeCapability, scopeProposal, scopeReview, setAddress, staffSchemas, updateCategoryStatus, upsertOffer } from "./operations";
import { createReportShare, listPublishedReports, listReportShares, readSharedPhoto, readSharedReport, reportSharingEnabled, revokeReportShare, shareInput, shareTokenPattern } from "./report-shares";
import { auditFilters, readAudit } from "./audit-read";
import { completeMediaUpload, createMediaReadUrl, createMediaUploadUrl, putMediaStaging, readMediaBinary, uploadUrlInputSchema } from "./media";
import { labelPrintInputSchema, labelVerifyInputSchema, printLabels, readLabelPdf, scanWarehouseCode, verifyLabelReadback } from "./labels";

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
const publicShareRoute=new RegExp("^/public/report-shares/("+shareTokenPattern+")(?:/photos/(\\d{1,6})/(\\d{1,6})/(\\d{1,6}))?$");
function privateShareResponse(response:Response) {
  response.headers.set("cache-control","private, no-store");
  response.headers.set("referrer-policy","no-referrer");
  response.headers.set("x-robots-tag","noindex, nofollow");
  return response;
}
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
  const secret=getCookie(req,"session")||getCookie(req,"qcw_onboarding");
  if(secret) {
    guard(verifyCsrfToken(secret,req.headers.get("x-csrf-token")??""),"CSRF_INVALID","Session security token is missing or invalid.",403);
  }
}
function authResult(result:{state:string;secret:string;kind:string}) {
  if(result.state==="signed_in") {
    const age=result.kind==="customer"?2592000:43200;
    return [cookie("session",result.secret,age),csrfCookie(csrfTokenFor(result.secret),age),cookie("qcw_provider","",0)];
  }
  return [cookie("qcw_onboarding",result.secret,1200),csrfCookie(csrfTokenFor(result.secret),1200),cookie("qcw_provider","",0)];
}
function binary(file:{data:Buffer;mime:string}) {
  return new Response(new Uint8Array(file.data),{headers:{"content-type":file.mime,"cache-control":"private, no-store","x-content-type-options":"nosniff"}});
}
async function extras(req:Request,path:string,actor:Actor|null):Promise<Response|null> {
  const method=req.method;
  const url=new URL(req.url);
  const share=publicShareRoute.exec(path);
  if(method==="GET"&&share) {
    const response=await transaction(async db=>share[2]===undefined?json(await readSharedReport(db,share[1])):
      binary(await readSharedPhoto(db,share[1],Number(share[2]),Number(share[3]),Number(share[4]))));
    return privateShareResponse(response);
  }
  const versionShares=path.match(/^\/orders\/([a-f0-9-]{36})\/report\/versions\/(\d+)\/shares$/i);
  if(versionShares&&(method==="GET"||method==="POST")) {
    const customer=actorRequired(actor);
    organization(customer);
    const orderId=idSchema.parse(versionShares[1]);
    const version=z.coerce.number().int().min(1).max(2147483647).parse(versionShares[2]);
    if(method==="GET")return json(await transaction(db=>listReportShares(db,customer,orderId,version)));
    csrf(req);
    guard(reportSharingEnabled(),"REPORT_SHARING_DISABLED","Report sharing is currently unavailable.",403);
    const key=idSchema.parse(req.headers.get("idempotency-key"));
    const {days}=shareInput.parse(await input(req));
    const token=reportShareToken(customer.id,orderId,version,key);
    const receipt=await transaction(db=>idempotent(db,customer.id+":report-share:"+orderId+":"+version,key,{days},
      ()=>createReportShare(db,customer,orderId,version,days,token)));
    return json({...receipt,url:appOrigin()+"/r/"+token},201);
  }
  const revokeShare=path.match(/^\/me\/report-shares\/([a-f0-9-]{36})$/i);
  if(method==="DELETE"&&revokeShare)return extraWrite(req,path,actor,z.object({}).strict(),
    (db,customer)=>revokeReportShare(db,customer,idSchema.parse(revokeShare[1])));
  if(method==="GET"&&path==="/me/reports") {
    const reference=z.string().trim().toUpperCase().pipe(z.string().regex(/^(QW|R)-[A-F0-9]{1,64}$/)).optional()
      .parse(url.searchParams.get("reference")||undefined)??null;
    const version=z.coerce.number().int().min(1).max(2147483647).optional().parse(url.searchParams.get("version")||undefined)??null;
    return json(await transaction(db=>listPublishedReports(db,actorRequired(actor),reference,version)));
  }
  if(method==="GET" && path==="/health") {
    await pool.query("select 1");
    return json({status:"ok"});
  }
  if(method==="GET" && path==="/catalog") return json({offers:await transaction(catalog)});
  if(method==="GET" && path==="/carriers") return json({carriers:(await pool.query("select code,labels from carriers where enabled order by code")).rows});
  if(method==="GET" && path==="/public/terms") return json({terms:await transaction(db=>currentTerms(db,["terms","privacy","restricted_items","report_notice"]))});
  const policy=path.match(/^\/public\/terms\/(terms|privacy|restricted_items|report_notice)$/);
  if(method==="GET"&&policy) {
    const versions=url.searchParams.getAll("version");
    guard(versions.length<=1&&versions[0]!=="","INVALID_REQUEST","Provide one policy version.",422);
    return json({terms:[await transaction(db=>publicPolicy(db,policy[1],versions[0]??null))]});
  }
  if(method==="GET" && path==="/public/inquiry-categories") {
    const browser=idSchema.safeParse(getCookie(req,"qcw_browser")).data??uuid();
    return json({categories:await transaction(inquiryCategories)},200,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="POST" && path==="/public/inquiries") {
    csrf(req);
    const data=publicInquiry.parse(await input(req));
    const key=idSchema.parse(req.headers.get("idempotency-key"));
    const customer=actor?.kind==="customer"?actor:null;
    const browser=idSchema.safeParse(getCookie(req,"qcw_browser")).data??uuid();
    const scope="public-inquiry:"+(customer?.org??hash(data.email));
    const result=await transaction(db=>idempotent(db,scope,key,data,()=>createPublicInquiry(db,customer,browser,data)));
    return json(result,201,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="GET" && path==="/auth/providers") return json(signInMethods());
  if(method==="GET" && path==="/staff/admin/tracking/health") {
    role(actorRequired(actor),...staffAccess.trackingConfiguration);
    return json({check:"local_configuration_only",...integrationPreflight().kuaidi100});
  }
  const oid=path.match(/^\/auth\/(google|microsoft)\/(start|callback)$/);
  if(method==="GET" && oid) {
    const browser=browserKey(req);
    const provider=oid[1]==="google"?"google":"microsoft";
    const clear=cookie("qcw_provider","",0);
    const next=oid[2]==="start"?customerDestination(url.searchParams.get("next")):null;
    try {
      if(oid[2]==="start") return redirect(await startProvider(provider,browser,next),[cookie("qcw_browser",browser,3600),clear]);
      const result=await finishProvider(provider,url,browser);
      const destination=customerDestination(result.next);
      if(result.state==="linked") return redirect(destination??"/account/security",[clear]);
      if(!("secret" in result)) {
        return redirect(withDestination("/login?oauth="+result.state,destination),[clear]);
      }
      if(result.state==="verify_email") return redirect(withDestination("/login?verify=1",destination),[cookie("qcw_provider",result.secret,900)]);
      if(result.state==="onboarding") return redirect(withDestination("/onboarding",destination),authResult(result));
      return redirect(destination??"/account",authResult(result));
    } catch {
      return redirect(withDestination("/login?oauth=failed",next),[clear]);
    }
  }
  if(method==="POST" && path==="/auth/otp/request") {
    csrf(req);
    const {email,purpose}=z.object({email:emailSchema,purpose:z.enum(["signin","recovery","link"]).optional()}).parse(await input(req));
    const browser=browserKey(req);
    let identity:ReturnType<typeof pendingProvider>;
    try {
      identity=pendingProvider(getCookie(req,"qcw_provider"),email,browser);
    } catch (error) {
      if(!(error instanceof Problem)) throw error;
      return json({error:{code:error.code,message:error.message}},error.status,[cookie("qcw_provider","",0)]);
    }
    const otpPurpose=purpose??"signin";
    const initiatorId=otpPurpose==="link"?actorRequired(actor).id:undefined;
    return json(await startOtp(email,browser,identity,otpPurpose,initiatorId),202,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="POST" && path==="/auth/otp/verify") {
    csrf(req);
    const {challenge_id,code}=z.object({challenge_id:idSchema,code:z.string().regex(/^\d{6}$/)}).parse(await input(req));
    const result=await verifyOtp(challenge_id,code,getCookie(req,"qcw_browser"));
    return json({state:result.state,kind:result.kind},200,authResult(result));
  }
  if(method==="POST" && path==="/auth/reauth/start") {
    csrf(req);
    const browser=browserKey(req);
    return json(await startCustomerReauth(actorRequired(actor),browser),202,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="POST" && path==="/auth/reauth/verify") {
    csrf(req);
    const {challenge_id,code}=z.object({challenge_id:idSchema,code:z.string().regex(/^\d{6}$/)}).parse(await input(req));
    return json(await verifyCustomerReauth(actorRequired(actor),hash(getCookie(req,"session")),challenge_id,code,getCookie(req,"qcw_browser")));
  }
  if(method==="POST" && path==="/auth/recovery/request") {
    csrf(req);
    const key=idSchema.parse(req.headers.get("idempotency-key"));
    const browser=browserKey(req);
    const body=z.object({
      challenge_id:idSchema,
      code:z.string().regex(/^\d{6}$/),
      previous_email:emailSchema,
      details:z.string().trim().min(4).max(2000),
    }).parse(await input(req));
    return json(await transaction(db=>idempotent(db,"recovery:"+hash(browser),key,body,
      ()=>requestAccountRecovery(db,browser,body))),201,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="GET" && path==="/auth/recovery/status") {
    const requestId=idSchema.parse(url.searchParams.get("request_id"));
    const statusToken=z.string().min(16).max(128).parse(url.searchParams.get("token"));
    return json(await transaction(db=>readAccountRecoveryStatus(db,requestId,statusToken)));
  }
  if(method==="GET" && path==="/me/identities") {
    return json(await transaction(db=>listIdentities(db,actorRequired(actor),hash(getCookie(req,"session")))));
  }
  const linkIdentityRoute=path.match(/^\/me\/identities\/(google|microsoft)\/link$/);
  if(method==="POST" && linkIdentityRoute) {
    const provider=linkIdentityRoute[1] as "google"|"microsoft";
    const browser=browserKey(req);
    return extraWrite(req,path,actor,z.object({challenge_id:idSchema.optional(),code:z.string().regex(/^\d{6}$/).optional()}),
      (db,a,b)=>linkProviderIdentity(db,a,hash(getCookie(req,"session")),browser,provider,b));
  }
  const deleteIdentityRoute=path.match(/^\/me\/identities\/([a-f0-9-]{36})$/i);
  if(method==="DELETE" && deleteIdentityRoute) {
    return extraWrite(req,path,actor,z.object({}),
      (db,a)=>unlinkIdentity(db,a,idSchema.parse(deleteIdentityRoute[1]),hash(getCookie(req,"session"))));
  }
  if(method==="POST" && path==="/me/email-change/request") {
    csrf(req);
    const browser=browserKey(req);
    const {new_email}=z.object({new_email:emailSchema}).parse(await input(req));
    return json(await requestEmailChange(actorRequired(actor),hash(getCookie(req,"session")),new_email,browser),202,[cookie("qcw_browser",browser,3600)]);
  }
  if(method==="POST" && path==="/me/email-change/confirm") {
    const browser=getCookie(req,"qcw_browser");
    return extraWrite(req,path,actor,z.object({
      current_challenge_id:idSchema,current_code:z.string().regex(/^\d{6}$/),
      new_challenge_id:idSchema,new_code:z.string().regex(/^\d{6}$/),
    }),(db,a,b)=>confirmEmailChange(db,a,hash(getCookie(req,"session")),browser,b));
  }
  if(method==="GET" && path==="/me/sessions") {
    return json(await transaction(db=>listSessions(db,actorRequired(actor),hash(getCookie(req,"session")))));
  }
  const deleteSessionRoute=path.match(/^\/me\/sessions\/([a-f0-9-]{36})$/i);
  if(method==="DELETE" && deleteSessionRoute) {
    return extraWrite(req,path,actor,z.object({}),
      (db,a)=>revokeSession(db,a,idSchema.parse(deleteSessionRoute[1])));
  }
  if(method==="POST" && path==="/me/sessions/revoke-others") {
    return extraWrite(req,path,actor,z.object({}),
      (db,a)=>revokeOtherSessions(db,a,hash(getCookie(req,"session"))));
  }
  if(method==="POST" && path==="/me/account/close") {
    csrf(req);
    const a=actorRequired(actor),key=idSchema.parse(req.headers.get("idempotency-key")),data=z.object({}).parse(await input(req));
    const res=await transaction(db=>idempotent(db,a.id+":"+path,key,data,()=>closeCustomerAccount(db,a,hash(getCookie(req,"session")))));
    return json(res,200,[cookie("session","",0),csrfCookie("",0)]);
  }
  const staffRecovery=path.match(/^\/staff\/account-recoveries\/([a-f0-9-]{36})\/(approve|reject|execute)$/i);
  if(method==="POST" && staffRecovery) {
    const reqId=idSchema.parse(staffRecovery[1]);
    const act=staffRecovery[2].toLowerCase() as "approve"|"reject"|"execute";
    if(act==="execute") {
      return extraWrite(req,path,actor,z.object({}),
        (db,a)=>executeAccountRecovery(db,a,reqId,hash(getCookie(req,"session"))));
    }
    return extraWrite(req,path,actor,z.object({reason:z.string().trim().min(4).max(1000),emergency:z.boolean().optional()}),
      (db,a,b)=>decideAccountRecovery(db,a,reqId,act,b,hash(getCookie(req,"session"))));
  }
  const staffUserStatus=path.match(/^\/staff\/users\/([a-f0-9-]{36})\/status$/i);
  if(method==="POST" && staffUserStatus) {
    return extraWrite(req,path,actor,z.object({
      status:z.enum(["active","restricted","disabled"]),
      reason:z.string().trim().min(4).max(1000),
    }),(db,a,b)=>staffUpdateUserStatus(db,a,idSchema.parse(staffUserStatus[1]),b,hash(getCookie(req,"session"))));
  }
  if(method==="POST" && path==="/staff/auth/login") {
    csrf(req);
    const data=z.object({email:emailSchema,password:z.string().min(1).max(256),otp:z.string().regex(/^\d{6}$/)}).parse(await input(req));
    const secret=await staffSignIn(data.email,data.password,data.otp);
    guard(secret,"LOGIN_FAILED","The staff credentials are invalid.",401);
    return json({state:"signed_in",kind:"staff"},200,[cookie("session",secret,43200),csrfCookie(csrfTokenFor(secret),43200)]);
  }
  if(method==="POST" && path==="/auth/logout") {
    csrf(req);
    const sid=getCookie(req,"session");
    if(sid) await pool.query("update sessions set revoked_at=now() where token_hash=$1",[hash(sid)]);
    return json({ok:true},200,[cookie("session","",0),cookie("qcw_onboarding","",0),cookie("qcw_provider","",0),csrfCookie("",0)]);
  }
  if(method==="POST" && path==="/webhooks/stripe") {
    const event=verifyStripe(await req.text(),req.headers.get("stripe-signature")??"");
    return json(await transaction(db=>stripeEvent(db,event)));
  }
  if(method==="POST" && path==="/webhooks/email/postmark") {
    const raw=await req.text();
    guard(raw.length<=500000,"BODY_TOO_LARGE","Webhook payload too large.",413);
    return json(await transaction(db=>receivePostmarkWebhook(db,req,raw)));
  }
  const callback=path.match(/^\/webhooks\/tracking\/kuaidi100\/([a-f0-9]{64})$/);
  if(method==="POST" && callback) {
    const raw=await req.text();
    guard(raw.length<=500000,"BODY_TOO_LARGE","Callback too large.",413);
    return json(await transaction(db=>providerCallback(db,callback[1],raw)));
  }
  if(method==="GET" && path==="/me") return json({actor:actorRequired(actor)});
  if(method==="GET" && path==="/me/desk") return json(await transaction(db=>customerDesk(db,actorRequired(actor))));
  if(method==="GET" && path==="/me/email-delivery-status") return json(await transaction(db=>customerEmailDeliveryStatus(db,actorRequired(actor))));
  if(method==="GET"&&path==="/me/notifications") {
    const unread=z.enum(["1","0"]).nullable().parse(url.searchParams.get("unread"))==="1";
    const before=idSchema.nullable().parse(url.searchParams.get("before"));
    return json(await transaction(db=>customerNotifications(db,actorRequired(actor),unread,before)));
  }
  const readNotice=path.match(/^\/me\/notifications\/([a-f0-9-]{36})\/read$/i);
  if(method==="POST"&&readNotice)return extraWrite(req,path,actor,z.object({}).strict(),
    (db,a)=>markNotificationRead(db,a,idSchema.parse(readNotice[1])));
  if(method==="GET" && path==="/actions") return json(await transaction(db=>customerActions(db,actorRequired(actor))));
  const caseRoute=path.match(/^\/cases\/([a-f0-9-]{36})(\/messages)?$/i);
  if(caseRoute&&method==="GET"&&!caseRoute[2]) {
    const customer=actorRequired(actor);organization(customer);
    const order=z.string().regex(/^QW-[A-F0-9]+$/).nullable().parse(url.searchParams.get("order"));
    return json(await transaction(db=>caseDetail(db,customer,idSchema.parse(caseRoute[1]),order)));
  }
  if(caseRoute&&method==="POST"&&caseRoute[2]&&req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    csrf(req);
    const customer=actorRequired(actor);organization(customer);
    const id=idSchema.parse(caseRoute[1]),key=idSchema.parse(req.headers.get("idempotency-key"));
    guard(Number(req.headers.get("content-length")??0)<=8_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const form=await req.formData(),file=form.get("photo");
    guard(file instanceof File&&file.size>0&&file.size<=8_000_000,"FILE_INVALID","Choose a photo up to 8 MB.",422);
    const input=customerTicketMessage.parse({revision:Number(form.get("revision")),body:form.get("body")});
    const bytes=Buffer.from(await file.arrayBuffer());
    return json(await transaction(db=>idempotent(db,customer.id+":"+path,key,{...input,photo:hash(bytes)},
      ()=>replyToCase(db,customer,id,input,bytes))));
  }
  if(caseRoute&&method==="POST"&&caseRoute[2]) return extraWrite(req,path,actor,customerTicketMessage,
    (db,a,b)=>replyToCase(db,a,idSchema.parse(caseRoute[1]),b));
  if(method==="GET"&&path==="/staff/tickets") {
    const state=z.enum(["open","waiting_customer","waiting_internal","resolved","closed"]).nullable().parse(url.searchParams.get("state"));
    const reference=z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z0-9-]{1,63}$/)).nullable().parse(url.searchParams.get("reference"));
    return json(await transaction(db=>staffTicketQueue(db,actorRequired(actor),state,reference)));
  }
  const ticketRoute=path.match(/^\/staff\/tickets\/([a-f0-9-]{36})(\/events)?$/i);
  if(ticketRoute&&method==="GET"&&!ticketRoute[2]) {
    const staff=actorRequired(actor);role(staff,...staffAccess.orders);
    return json(await transaction(db=>caseDetail(db,staff,idSchema.parse(ticketRoute[1]),null)));
  }
  if(ticketRoute&&method==="POST"&&ticketRoute[2]) return extraWrite(req,path,actor,staffTicketEvent,
    (db,a,b)=>writeStaffTicket(db,a,idSchema.parse(ticketRoute[1]),b));
  if(method==="GET" && path==="/me/receiving-address") {
    const a=actorRequired(actor);organization(a);
    const {receiving}=await import("./auth");
    return json(await transaction(db=>receiving(db,a.id)));
  }
  if(method==="GET" && path==="/staff/desk") return json(await transaction(db=>warehouseDesk(db,actorRequired(actor))));
  if(method==="GET"&&path==="/staff/reports") {
    const order=z.string().regex(/^QW-[A-F0-9]+$/).nullable().parse(url.searchParams.get("order"));
    return json(await transaction(db=>reportDesk(db,actorRequired(actor),order)));
  }
  const revisionRoute=path.match(/^\/staff\/reports\/([a-f0-9-]{36})(?:\/(amend|submit-revision))?$/i);
  if(revisionRoute) {
    const id=idSchema.parse(revisionRoute[1]);
    if(method==="GET"&&!revisionRoute[2])return json(await transaction(db=>staffReport(db,actorRequired(actor),id)));
  }
  const batchDetail=path.match(/^\/staff\/dispatch-batches\/([a-f0-9-]{36})$/i);
  if(method==="GET"&&batchDetail) return json(await transaction(db=>warehouseDispatchBatch(db,actorRequired(actor),idSchema.parse(batchDetail[1]))));
  if(method==="GET"&&path==="/staff/dispatch-batches") {
    const state=z.enum(dispatchQueueStates).parse(url.searchParams.get("state"));
    const raw=url.searchParams.get("reference")?.trim();
    const reference=raw?idSchema.safeParse(raw).success?raw.toLowerCase():waybill(raw):null;
    return json(await transaction(db=>warehouseDispatchQueue(db,actorRequired(actor),state,reference)));
  }
  if(method==="GET" && path==="/staff/storage") return json(await transaction(db=>storageMovementDesk(db,actorRequired(actor))));
  if(path==="/staff/admin/storage/locations") {
    if(method==="GET") return json(await transaction(db=>locationMaster(db,actorRequired(actor))));
    if(method==="POST") return extraWrite(req,path,actor,locationBatchSchema,createLocations);
  }
  const locationState=path.match(/^\/staff\/admin\/storage\/locations\/([a-f0-9-]{36})\/state$/i);
  if(method==="POST"&&locationState) return extraWrite(req,path,actor,z.object({active:z.boolean()}),
    (db,a,b)=>setLocationActive(db,a,idSchema.parse(locationState[1]),b.active));
  if(method==="GET" && path==="/staff/items/by-code") {
    const code=z.string().trim().min(1).max(100).parse(url.searchParams.get("code"));
    return json(await transaction(db=>warehouseItem(db,actorRequired(actor),code)));
  }
  const packageDetail=path.match(/^\/staff\/packages\/([a-f0-9-]{36})$/i);
  if(method==="GET" && packageDetail) return json(await transaction(db=>warehousePackage(db,actorRequired(actor),idSchema.parse(packageDetail[1]))));
  const packageCode=path.match(/^\/staff\/packages\/by-code\/(P-[A-Z0-9-]{1,64})$/);
  if(method==="GET"&&packageCode) return json(await transaction(db=>warehousePackage(db,actorRequired(actor),packageCode[1],true)));
  if(method==="GET" && path==="/staff/admin/desk") return json(await transaction(db=>adminDesk(db,actorRequired(actor))));
  if(method==="GET"&&path==="/staff/audit") {
    const filters=auditFilters.parse(Object.fromEntries([...url.searchParams].filter(([,value])=>value!=="")));
    return json(await transaction(db=>readAudit(db,actorRequired(actor),filters)));
  }
  if(method==="GET"&&path==="/staff/admin/jobs") return json(await transaction(db=>failedJobs(db,actorRequired(actor))));
  const retryJob=path.match(/^\/staff\/admin\/jobs\/([0-9]+)\/retry$/);
  if(method==="POST"&&retryJob) {
    const id=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n).parse(retryJob[1]);
    return extraWrite(req,path,actor,z.object({attempts:z.number().int().positive(),reason:z.string().trim().min(4).max(1000)}).strict(),
      (db,a,b)=>retryFailedJob(db,a,id,b.attempts,b.reason,hash(getCookie(req,"session"))));
  }
  if(method==="GET"&&path==="/staff/admin/email-deliveries") {
    const state=url.searchParams.get("state")?.trim()||null;
    return json(await transaction(db=>staffEmailDeliveries(db,actorRequired(actor),state)));
  }
  const retryEmail=path.match(/^\/staff\/admin\/email-deliveries\/([a-f0-9-]{36})\/retry$/i);
  if(method==="POST"&&retryEmail) {
    const id=idSchema.parse(retryEmail[1]);
    return extraWrite(req,path,actor,z.object({attempt:z.number().int().positive(),reason:z.string().trim().min(4).max(1000)}).strict(),
      (db,a,b)=>retryEmailDelivery(db,a,id,b.attempt,b.reason,hash(getCookie(req,"session"))));
  }
  if(method==="GET"&&path==="/staff/orders") {
    const filters=staffOrderFilters.parse(Object.fromEntries([...url.searchParams].filter(([,value])=>value!=="")));
    return json(await transaction(db=>searchStaffOrders(db,actorRequired(actor),filters)));
  }
  const staffOrder=path.match(/^\/staff\/orders\/by-number\/(QW-[A-F0-9]+)$/);
  if(method==="GET"&&staffOrder) return json(await transaction(db=>staffOrderDetail(db,actorRequired(actor),staffOrder[1])));
  const refundOptions=path.match(/^\/staff\/orders\/by-number\/(QW-[A-F0-9]+)\/refund-options$/);
  if(method==="GET"&&refundOptions) return json(await transaction(db=>orderRefundPayments(db,actorRequired(actor),refundOptions[1])));
  if(method==="GET" && path==="/staff/tracking") return json({rows:await transaction(db=>trackingAdmin(db,actorRequired(actor)))});
  const byNo=path.match(/^\/orders\/by-number\/(QW-[A-F0-9]+)$/);
  if(method==="GET" && byNo) return json(await transaction(db=>readOrderByPublicNumber(db,actorRequired(actor),byNo[1])));
  const order=path.match(/^\/orders\/([a-f0-9-]{36})$/i);
  if(method==="GET" && order) return json(await transaction(db=>orderDetail(db,actorRequired(actor),idSchema.parse(order[1]))));
  const scopes=path.match(/^\/orders\/([a-f0-9-]{36})\/scope-revisions$/i);
  if(method==="GET"&&scopes)return json(await transaction(db=>scopeReview(db,actorRequired(actor),idSchema.parse(scopes[1]))));
  const fulfillment=path.match(/^\/orders\/([a-f0-9-]{36})\/(quotes|shipments)\/([a-f0-9-]{36})$/i);
  if(method==="GET"&&fulfillment) return json(await transaction(db=>orderFulfillmentRecord(db,actorRequired(actor),
    idSchema.parse(fulfillment[1]),fulfillment[2].toLowerCase() as "quotes"|"shipments",idSchema.parse(fulfillment[3]))));
  if(method==="GET" && path==="/staff/inspection-tasks/lookup") {
    const code=z.string().trim().min(1).max(100).parse(url.searchParams.get("code"));
    const orderId=idSchema.nullable().parse(url.searchParams.get("order_id"));
    return json(await transaction(db=>findInspectionTaskByScan(db,actorRequired(actor),{code,order_id:orderId})));
  }
  const task=path.match(/^\/staff\/inspection-tasks\/([a-f0-9-]{36})$/i);
  if(method==="GET" && task) return json(await transaction(db=>taskDetail(db,actorRequired(actor),idSchema.parse(task[1]))));
  const taskCompleteness=path.match(/^\/staff\/inspection-tasks\/([a-f0-9-]{36})\/completeness$/i);
  if(method==="GET" && taskCompleteness) return json(await transaction(db=>checkTaskCompleteness(db,actorRequired(actor),idSchema.parse(taskCompleteness[1]))));
  const taskShots=path.match(/^\/staff\/inspection-tasks\/([a-f0-9-]{36})\/shots$/i);
  if(method==="POST" && taskShots) return extraWrite(req,path,actor,z.object({
    revision:revSchema,
    component:z.string().trim().min(1).max(40),
    shot_code:z.string().trim().min(1).max(80),
    media_id:idSchema,
  }),(db,a,b)=>recordTaskShot(db,a,idSchema.parse(taskShots[1]),b));
  const taskSteps=path.match(/^\/staff\/inspection-tasks\/([a-f0-9-]{36})\/steps$/i);
  if(method==="POST" && taskSteps) return extraWrite(req,path,actor,z.object({
    step_code:z.enum(["prep","measure","visual","compare","qa_review"]),
    action:z.enum(["start","stop","record"]).optional(),
    started_at:z.string().optional(),
    ended_at:z.string().optional(),
    seconds:z.number().int().min(1).max(86400).optional(),
  }),(db,a,b)=>recordTaskStep(db,a,idSchema.parse(taskSteps[1]),b));
  const report=path.match(/^\/orders\/([a-f0-9-]{36})\/report(?:\/versions\/(\d+)(\/file)?)?$/i);
  if(method==="GET" && report) return transaction(async db=>{
    const a=actorRequired(actor);
    const version=report[2]?z.coerce.number().int().min(1).max(2147483647).parse(report[2]):undefined;
    const r=await readReport(db,a,idSchema.parse(report[1]),version);
    if(report[3]) {
      verifyReportDownload(a.id,r.id,url.searchParams.get("expires")??"",url.searchParams.get("sig")??"");
      return binary(await one<{data:Buffer;mime:string}>(db,"select data,mime from private_files where key=$1",[r.pdf_key]));
    }
    return json({id:r.id,version:r.version,state:r.state,snapshot:r.snapshot,published_at:r.published_at,amend_reason:r.amend_reason,versions:r.versions});
  });
  const mediaUrlRoute=path.match(/^\/media\/([a-f0-9-]{36})\/url$/i);
  if(method==="GET" && mediaUrlRoute) {
    return json(await transaction(db=>createMediaReadUrl(db,actorRequired(actor),idSchema.parse(mediaUrlRoute[1]))));
  }
  const mediaPutRoute=path.match(/^\/media\/([a-f0-9-]{36})\/put$/i);
  if(method==="PUT" && mediaPutRoute) {
    csrf(req);
    guard(Number(req.headers.get("content-length")??0)<=25_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const bytes=Buffer.from(await req.arrayBuffer());
    return json(await transaction(db=>putMediaStaging(
      db,
      idSchema.parse(mediaPutRoute[1]),
      url.searchParams.get("expires")??"",
      url.searchParams.get("sig")??"",
      bytes
    )));
  }
  const mediaCompleteRoute=path.match(/^\/media\/([a-f0-9-]{36})\/complete$/i);
  if(method==="POST" && mediaCompleteRoute) {
    return extraWrite(req,path,actor,z.object({}),
      (db,a)=>completeMediaUpload(db,a,idSchema.parse(mediaCompleteRoute[1])));
  }
  if(method==="POST" && path==="/media/upload-url") {
    return extraWrite(req,path,actor,uploadUrlInputSchema,
      (db,a,b)=>createMediaUploadUrl(db,a,b),201);
  }
  const media=path.match(/^\/media\/([a-f0-9-]{36})$/i);
  if(method==="GET" && media) {
    const variant=z.enum(["original","thumb"]).default("original").parse(url.searchParams.get("variant")??"original");
    return transaction(async db=>binary(await readMediaBinary(
      db,
      actorRequired(actor),
      idSchema.parse(media[1]),
      variant,
      url.searchParams.get("expires"),
      url.searchParams.get("sig")
    )));
  }
  const scanRoute=path.match(/^\/staff\/scan\/([^/]+)$/);
  if(method==="GET" && scanRoute) {
    const code=decodeURIComponent(scanRoute[1]);
    const carrierCode=url.searchParams.get("carrier_code")?.trim()||null;
    return json(await transaction(db=>scanWarehouseCode(db,actorRequired(actor),code,carrierCode)));
  }
  if(method==="POST" && path==="/staff/labels/print") {
    return extraWrite(req,path,actor,labelPrintInputSchema,
      (db,a,b)=>printLabels(db,a,b));
  }
  if(method==="POST" && path==="/staff/labels/verify") {
    return extraWrite(req,path,actor,labelVerifyInputSchema,
      (db,a,b)=>verifyLabelReadback(db,a,b));
  }
  const labelPdfRoute=path.match(/^\/staff\/labels\/([a-f0-9-]{36})\/file$/i);
  if(method==="GET" && labelPdfRoute) {
    return transaction(async db=>binary(await readLabelPdf(db,actorRequired(actor),idSchema.parse(labelPdfRoute[1]))));
  }
  if(method==="POST" && path==="/staff/media") {
    csrf(req);
    const a=actorRequired(actor);role(a,"receiver","warehouse_admin","inspector");
    guard(Number(req.headers.get("content-length")??0)<=8_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const form=await req.formData(),file=form.get("photo");
    guard(file instanceof File,"FILE_INVALID","Choose a photo.",422);
    const kind=photoKinds.parse(form.get("kind")),bytes=Buffer.from(await file.arrayBuffer());
    return json(await transaction(db=>savePhoto(db,a,bytes,kind)),201);
  }
  if(method==="POST" && path==="/me/media") {
    csrf(req);
    const a=actorRequired(actor);organization(a);
    guard(Number(req.headers.get("content-length")??0)<=8_100_000,"BODY_TOO_LARGE","Photo is too large.",413);
    const form=await req.formData(),file=form.get("photo");
    guard(file instanceof File,"FILE_INVALID","Choose a photo.",422);
    const bytes=Buffer.from(await file.arrayBuffer());
    return json(await transaction(db=>savePhoto(db,a,bytes,"attachment")),201);
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
  const pkgQuarantine=path.match(/^\/staff\/packages\/([a-f0-9-]{36})\/quarantine$/i);
  if(method==="POST" && pkgQuarantine) return extraWrite(req,path,actor,z.object({
    revision:revSchema,reason:z.string().trim().min(4).max(1000),location_id:idSchema.optional(),evidence_ids:z.array(idSchema).optional()
  }),(db,a,b)=>quarantinePackage(db,a,idSchema.parse(pkgQuarantine[1]),b));
  const pkgBindOwner=path.match(/^\/staff\/packages\/([a-f0-9-]{36})\/bind-owner$/i);
  if(method==="POST" && pkgBindOwner) return extraWrite(req,path,actor,z.object({
    revision:revSchema,receiving_code:z.string().trim().min(3).max(64),evidence_ids:z.array(idSchema).min(1),reason:z.string().trim().min(4).max(1000)
  }),(db,a,b)=>bindUnmatchedPackageOwner(db,a,idSchema.parse(pkgBindOwner[1]),b));
  const itemQuarantine=path.match(/^\/staff\/items\/([a-f0-9-]{36})\/quarantine$/i);
  if(method==="POST" && itemQuarantine) return extraWrite(req,path,actor,z.object({
    revision:revSchema,reason:z.string().trim().min(4).max(1000),location_id:idSchema.optional()
  }),(db,a,b)=>quarantineItem(db,a,idSchema.parse(itemQuarantine[1]),b));
  const itemUnassign=path.match(/^\/staff\/items\/([a-f0-9-]{36})\/unassign$/i);
  if(method==="POST" && itemUnassign) return extraWrite(req,path,actor,z.object({
    revision:revSchema,reason:z.string().trim().min(4).max(1000)
  }),(db,a,b)=>unassignItem(db,a,idSchema.parse(itemUnassign[1]),b));
  const itemIdentify=path.match(/^\/staff\/(items|samples)\/([a-f0-9-]{36})\/identify$/i);
  if(method==="POST" && itemIdentify) return extraWrite(req,path,actor,z.object({
    revision:revSchema,
    matches_advice:z.boolean(),
    actual_label_info:z.record(z.string(),z.unknown()).optional(),
    mismatch_note:z.string().trim().max(1000).optional(),
    media_ids:z.array(idSchema).optional(),
    evidence_ids:z.array(idSchema).optional(),
    order_line_id:idSchema.optional(),
    expected_item_id:idSchema.optional(),
  }),(db,a,b)=>identifyItem(db,a,idSchema.parse(itemIdentify[2]),b));
  const mismatchResp=path.match(/^\/orders\/([a-f0-9-]{36})\/mismatch-response$/i);
  if(method==="POST" && mismatchResp) return extraWrite(req,path,actor,z.object({
    revision:revSchema.optional(),
    expected_item_id:idSchema.optional(),
    sample_label:z.string().trim().max(120).optional(),
    item_id:idSchema.optional(),
    decision:z.enum(["proceed_as_received","replace_sample","return_sample"]),
    note:z.string().trim().max(1000).optional(),
  }),(db,a,b)=>respondOrderMismatch(db,a,idSchema.parse(mismatchResp[1]),b));
  const convertTwo=path.match(/^\/orders\/([a-f0-9-]{36})\/convert-to-two$/i);
  if(method==="POST" && convertTwo) return extraWrite(req,path,actor,z.object({
    revision:revSchema.optional(),
    expected_item_id:idSchema.optional(),
    drop_label:z.string().trim().max(120).optional(),
    reason:z.string().trim().max(1000).optional(),
  }),(db,a,b)=>convertOrderToTwo(db,a,idSchema.parse(convertTwo[1]),b));
  const orderExtend=path.match(/^\/orders\/([a-f0-9-]{36})\/extend$/i);
  if(method==="POST" && orderExtend) return extraWrite(req,path,actor,z.object({
    revision:revSchema,
    extend_days:z.number().int().min(1).max(30),
    reason:z.string().trim().min(2).max(1000),
  }),(db,a,b)=>extendOrderArrival(db,a,idSchema.parse(orderExtend[1]),b));
  const scopeAdditions=path.match(/^\/orders\/([a-f0-9-]{36})\/scope-additions$/i);
  if(method==="POST" && scopeAdditions) return extraWrite(req,path,actor,z.object({
    revision:revSchema,
    reason:z.string().trim().min(1).max(1000),
    positions:z.array(idSchema),
    additions:z.array(z.object({
      order_line_id:idSchema,
      count:z.number().int().min(1).max(100),
      declared_fields:z.array(z.record(z.string(),z.unknown())).optional(),
    })).min(1),
  }),(db,a,b)=>scopeProposal(db,a,idSchema.parse(scopeAdditions[1]),b),201);
  const verification=path.match(/^\/me\/parcels\/([a-f0-9-]{36})\/tracking-verification$/i);
  if(verification && method==="GET") return json(await transaction(db=>verificationState(db,actorRequired(actor),idSchema.parse(verification[1]))));
  if(verification && method==="POST") return extraWrite(req,path,actor,z.object({revision:revSchema,
    carrier_code:z.string().min(1).max(40),phone:z.string().max(30).optional()
  }),(db,a,b)=>verifyTracking(db,a,idSchema.parse(verification[1]),b));
  const parcelRefresh=path.match(/^\/me\/parcels\/([a-f0-9-]{36})\/tracking\/refresh$/i);
  if(parcelRefresh && method==="POST") return extraWrite(req,path,actor,z.object({}),
    (db,a)=>refreshTracking(db,a,idSchema.parse(parcelRefresh[1]),"advice"),202);
  const shipmentRefresh=path.match(/^\/shipments\/([a-f0-9-]{36})\/tracking\/refresh$/i);
  if(shipmentRefresh && method==="POST") return extraWrite(req,path,actor,z.object({}),
    (db,a)=>refreshTracking(db,a,idSchema.parse(shipmentRefresh[1]),"shipment"),202);
  const parcelCorrect=path.match(/^\/me\/parcels\/([a-f0-9-]{36})\/correct$/i);
  if(parcelCorrect && method==="POST") return extraWrite(req,path,actor,z.object({
    revision:revSchema,carrier_code:z.string().min(1).max(40),tracking_no:z.string().min(5).max(80),reason:z.string().trim().min(4).max(1000)
  }),(db,a,b)=>correctCustomerParcelTracking(db,a,idSchema.parse(parcelCorrect[1]),b));
  const staffCorrect=path.match(/^\/staff\/tracking\/([a-f0-9-]{36})\/correct$/i);
  if(staffCorrect && method==="POST") return extraWrite(req,path,actor,z.object({
    revision:revSchema,carrier_code:z.string().min(1).max(40),tracking_no:z.string().min(5).max(80),
    reason:z.string().trim().min(4).max(1000),evidence_ids:z.array(idSchema).optional()
  }),(db,a,b)=>correctStaffTracking(db,a,idSchema.parse(staffCorrect[1]),b,hash(getCookie(req,"session"))));
  const staffTranslation=path.match(/^\/staff\/tracking\/([a-f0-9-]{36})\/translations$/i);
  if(staffTranslation && method==="POST") return extraWrite(req,path,actor,z.object({
    tracking_event_id:idSchema,source_hash:z.string().min(8).max(128),text_en:z.string().trim().min(2).max(2000)
  }),(db,a,b)=>submitTrackingTranslation(db,a,idSchema.parse(staffTranslation[1]),b),201);
  const approveTranslation=path.match(/^\/staff\/tracking-translations\/([a-f0-9-]{36})\/approve$/i);
  if(approveTranslation && method==="POST") return extraWrite(req,path,actor,z.object({}),
    (db,a)=>approveTrackingTranslation(db,a,idSchema.parse(approveTranslation[1])));
  const manual=path.match(/^\/orders\/([a-f0-9-]{36})\/manual-quote-request$/i);
  if(method==="POST" && manual) return extraWrite(req,path,actor,z.object({revision:revSchema,reason:z.string().trim().min(4).max(1200)}),
    (db,a,b)=>requestManualQuote(db,a,idSchema.parse(manual[1]),b.revision,b.reason));
  if(method==="POST" && path==="/me/cases") {
    const b=z.object({subject:z.string().trim().min(2).max(150),message:z.string().trim().min(2).max(2000),order_id:idSchema.optional(),category:orderCaseCategory.optional()});
    return extraWrite(req,path,actor,b,(db,a,v)=>reportIssue(db,a,v.subject,v.message,v.order_id,v.category));
  }
  if(method==="POST" && path==="/staff/admin/warehouse-addresses")
    return extraWrite(req,path,actor,staffSchemas.address,setAddress);
  if(method==="POST" && path==="/staff/admin/templates")
    return extraWrite(req,path,actor,staffSchemas.template,newTemplate);
  const publish=path.match(/^\/staff\/admin\/templates\/([a-f0-9-]{36})\/publish$/i);
  if(method==="POST" && publish) return extraWrite(req,path,actor,z.object({}),(db,a)=>publishTemplate(db,a,idSchema.parse(publish[1])));
  if(method==="POST" && path==="/staff/admin/capabilities")
    return extraWrite(req,path,actor,staffSchemas.capability,createCapability);
  const capApprove=path.match(/^\/staff\/admin\/capabilities\/([a-f0-9-]{36})\/approve$/i);
  if(method==="POST" && capApprove) return extraWrite(req,path,actor,z.object({}),(db,a)=>approveCapability(db,a,idSchema.parse(capApprove[1])));
  const capRevoke=path.match(/^\/staff\/admin\/capabilities\/([a-f0-9-]{36})\/revoke$/i);
  if(method==="POST" && capRevoke) return extraWrite(req,path,actor,staffSchemas.capabilityRevoke,(db,a,b)=>revokeCapability(db,a,idSchema.parse(capRevoke[1]),b.reason));
  if(method==="POST" && path==="/staff/admin/categories")
    return extraWrite(req,path,actor,staffSchemas.categoryCreate,createCategory);
  const catStatus=path.match(/^\/staff\/admin\/categories\/([a-f0-9-]{36})\/status$/i);
  if(method==="POST" && catStatus) return extraWrite(req,path,actor,staffSchemas.categoryStatus,(db,a,b)=>updateCategoryStatus(db,a,idSchema.parse(catStatus[1]),b));
  if(method==="POST" && path==="/staff/admin/offers")
    return extraWrite(req,path,actor,staffSchemas.offer,upsertOffer);
  const skuPrice=path.match(/^\/staff\/admin\/skus\/([a-z0-9_-]{2,80})\/prices$/i);
  if(method==="POST" && skuPrice) return extraWrite(req,path,actor,staffSchemas.skuPrice,(db,a,b)=>publishSkuPrice(db,a,skuPrice[1].toLowerCase(),b));
  const refRelease=path.match(/^\/me\/reference-samples\/([a-f0-9-]{36})\/release$/i);
  if(method==="POST" && refRelease) return extraWrite(req,path,actor,staffSchemas.referenceRelease,(db,a,b)=>releaseReferenceSample(db,a,idSchema.parse(refRelease[1]),b));
  const store=path.match(/^\/staff\/dispositions\/([a-f0-9-]{36})\/storage-quote$/i);
  if(method==="POST" && store) return extraWrite(req,path,actor,z.object({}),(db,a)=>storageQuote(db,a,idSchema.parse(store[1])));
  const cancel=path.match(/^\/orders\/([a-f0-9-]{36})\/cancel$/i);
  if(method==="POST" && cancel) return extraWrite(req,path,actor,z.object({revision:revSchema}),(db,a,b)=>cancelOrder(db,a,idSchema.parse(cancel[1]),b.revision));
  const hold=path.match(/^\/staff\/orders\/([a-f0-9-]{36})\/(hold|resume)$/i);
  if(method==="POST" && hold) return extraWrite(req,path,actor,z.object({reason:z.string().trim().min(2).max(1000)}),(db,a,b)=>
    hold[2].toLowerCase()==="hold"?holdOrder(db,a,idSchema.parse(hold[1]),b.reason):resumeOrder(db,a,idSchema.parse(hold[1]),b.reason));
  if(method==="POST" && path==="/staff/storage/move") return extraWrite(req,path,actor,z.object({
    item_id:idSchema,revision:revSchema,location_id:idSchema}),(db,a,b)=>moveItem(db,a,b.item_id,b.revision,b.location_id));
  const fake=path.match(/^\/checkout\/demo\/([a-f0-9-]{36})$/i);
  if(method==="POST" && fake && isDemo()) return extraWrite(req,path,actor,z.object({}),(db,a)=>demoPay(db,a,idSchema.parse(fake[1])));
  return null;
}
async function extraWrite<S extends z.ZodType>(req:Request,path:string,actor:Actor|null,schema:S,run:(db:DB,actor:Actor,data:z.output<S>)=>Promise<unknown>,status=200) {
  csrf(req);
  const a=actorRequired(actor),key=idSchema.parse(req.headers.get("idempotency-key")),data=schema.parse(await input(req));
  return json(await transaction(db=>idempotent(db,a.id+":"+path,key,data,()=>run(db,a,data))),status);
}

// The request is validated against the operation's OpenAPI schema before dispatch.
async function dispatch(db:DB,actor:Actor,id:string,op:string,b:Record<string,any>,req:Request) {
  switch(op) {
    case "createDraft": return saveOrder(db,actor,b as Parameters<typeof saveOrder>[2]);
    case "editDraft": return saveOrder(db,actor,b as Parameters<typeof saveOrder>[2],id);
    case "quoteOrder": return quoteOrder(db,actor,id,b.revision);
    case "issueManualQuote": return issueManualQuote(db,actor,id,b as Parameters<typeof issueManualQuote>[3]);
    case "submitOrder": return submitOrder(db,actor,id,b as Parameters<typeof submitOrder>[3]);
    case "orderPayment": return orderPayment(db,actor,id);
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
    case "returnReport": return returnReport(db,actor,id,b.revision,b.reason);
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
      refunded_cents:x.refunded_cents,order_ids:x.order_ids,
      ...(x.batch_id?{batch_id:x.batch_id}:{}),
      ...(x.latest_attempt_state?{latest_attempt_state:x.latest_attempt_state}:{}),
    }))};
    case "references": return {items:(await db.query(`select id reference_id,item_id,state,expires_at from reference_samples where org_id=$1 order by expires_at desc`,[organization(actor)])).rows};
    case "requestRefund": return refundRequest(db,actor,b.payment_id,b.amount_cents,b.reason,id);
    case "requestPaymentRefund": return refundRequest(db,actor,id,b.amount_cents,b.reason);
    case "approveRefund": return refundApprove(db,actor,id,b.revision,hash(getCookie(req,"session")));
    case "proposeScope": return scopeProposal(db,actor,id,b as Parameters<typeof scopeProposal>[3]);
    case "acceptScope": return acceptScope(db,actor,id,b.revision);
    case "amendReport": return amendReport(db,actor,id,amendReportInput.parse(b));
    case "editReportRevision": return editReportRevision(db,actor,id,revisionChanges.parse(b));
    case "submitReportRevision": return submitReportRevision(db,actor,id,b.revision);
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
  let actor:Actor|null=null;
  try {
    actor=await actorFrom(req);
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
      return json(result.profile,status,[cookie("session",result.secret,2592000),csrfCookie(csrfTokenFor(result.secret),2592000),cookie("qcw_onboarding","",0)]);
    }
    const a=actorRequired(actor);
    guard(a.kind==="customer"?op["x-roles"].includes("customer"):op["x-roles"].some(r=>a.roles.includes(r)),
      "FORBIDDEN","This action requires a different role.",403);
    return json(await transaction(db=>{
      const run=()=>dispatch(db,a,args[0]??"",op.operationId,data,req);
      return key?idempotent(db,a.id+":"+req.method+":"+path,key,data,run):run();
    }),status);
  } catch(e) {
    if(e instanceof Problem) {
      if(e.status===403 || ["INCOMPATIBLE_SAMPLES","SELF_REVIEW_FORBIDDEN","CATEGORY_ADMISSION_INCOMPLETE","REFERENCE_UNAVAILABLE","REFERENCE_RELEASE_REQUIRED","SIGNATURE_INVALID","PAYMENT_MODE_MISMATCH","PAYMENT_AMOUNT_MISMATCH","LAST_LOGIN_METHOD","IDENTITY_ALREADY_LINKED","EMAIL_CHANGE_CONFLICT","ACCOUNT_HAS_ACTIVE_OBLIGATIONS","RECOVERY_COOLDOWN_ACTIVE"].includes(e.code)) {
        await audit(pool,actor,"rejected_"+e.code.toLowerCase(),"http_request",null,{code:e.code,reason:e.message}).catch(()=>undefined);
      }
      const response=json({error:{code:e.code,message:e.message}},e.status);
      return path.startsWith("/public/report-shares/")?privateShareResponse(response):response;
    }
    if(e instanceof z.ZodError) return json({error:{code:"INVALID_REQUEST",message:e.issues.map(x=>x.path.join(".")+": "+x.message).join("; ")}},422);
    if(e instanceof Error && "code" in e && ["23505","23514","23503"].includes(String(e.code))) {
      return json({error:{code:"RECORD_CONFLICT",message:"This operation conflicts with an existing record or state."}},409);
    }
    const logPath=path.startsWith("/public/report-shares/")?"/public/report-shares/{token}":path;
    console.error("QC Warehouse request failed",req.method,logPath,e instanceof Error?{name:e.name,code:"code" in e?e.code:undefined}:undefined);
    return json({error:{code:"SERVER_ERROR",message:"The operation failed. Retry or contact support."}},500);
  }
}
