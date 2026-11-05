import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import { encryptSecret, decryptSecret } from "./auth";
import { trackingSettings } from "./integrations";
import { validCarrier } from "./intake";
import { audit, guard, hash, isDemo, lock, one, organization, revision, role, type Actor } from "./common";

const md5=(s:string)=>createHash("md5").update(s).digest("hex").toUpperCase();
const states:Record<string,string>={"0":"in_transit","1":"picked_up","2":"exception","3":"delivered","4":"returned","5":"out_for_delivery","6":"returning","7":"forwarded","8":"exception"};
const payloadSchema=z.object({com:z.string().optional(),nu:z.string().optional(),state:z.union([z.string(),z.number()]).optional(),
  data:z.array(z.object({context:z.string().min(1).max(1600),ftime:z.string().optional(),time:z.string().optional(),statusCode:z.string().optional()})).max(500)});
function eventTime(time?:string) {
  if(!time) return undefined;
  const parsed=new Date(time.replace(" ","T")+(time.length===19?"+08:00":""));
  return Number.isFinite(parsed.valueOf())?parsed.toISOString():undefined;
}
async function storeSnapshot(db:DB,id:string,locale:string,source:string,input:unknown) {
  const p=payloadSchema.parse(input);
  const tracker=await one(db,"select carrier_code,tracking_norm,latest_event_at,transport_state from tracking_records where id=$1 and closed_at is null for update",[id]);
  const carrier=await one(db,"select provider_code from carriers where code=$1",[tracker.carrier_code]);
  guard((!p.com || p.com===carrier.provider_code) && (!p.nu || p.nu.toUpperCase()===tracker.tracking_norm),
    "TRACKING_MISMATCH","Carrier response does not match the transport record.");
  const events=p.data.map(e=>{
    const ts=eventTime(e.ftime??e.time);
    // Omit explicit telephone numbers from customer-facing content.
    const message=e.context.replace(/\+?\d[\d -]{6,}\d/g,"[redacted]");
    return {id:hash((ts??"")+e.context).slice(0,24),text:message,source,...(ts?{occurred_at:ts}:{}),...(e.statusCode?{status_code:e.statusCode}:{})};
  });
  const last=events.flatMap(e=>e.occurred_at?[e.occurred_at]:[]).sort().at(-1)??null;
  const state=states[String(p.state)]??"unknown";
  await db.query(`insert into tracking_snapshots(tracker_id,source,locale,payload_hash,fetched_at,latest_event_at,provider_state,events_json,schema_version)
    values($1,$2,$3,$4,now(),$5,$6,$7,1) on conflict do nothing`,[id,source,locale,hash(JSON.stringify(p)),last,state,JSON.stringify(events)]);
  await db.query(`update tracking_records set last_success_at=now(),sync_state=$4,
    latest_event_at=greatest(latest_event_at,$2),transport_state=case when $2::timestamptz is not null
    and (latest_event_at is null or latest_event_at<$2 or (latest_event_at=$2 and transport_state=$3)) then $3 else transport_state end
    where id=$1`,[id,last,state,events.length?"active":"no_record"]);
}
export async function tracking(db:DB,actor:Actor,id:string,kind:"advice"|"shipment",locale:string) {
  const org=organization(actor);
  const filter=kind==="advice"?"t.advice_id":"t.shipment_id";
  const t=await one(db,`select t.*,coalesce(p.state,s.state) warehouse_state,c.labels from tracking_records t left join packages p on p.id=t.package_id
    left join shipments s on s.id=t.shipment_id left join carriers c on c.code=t.carrier_code where ${filter}=$1 and t.org_id=$2 and t.closed_at is null order by t.generation desc limit 1`,[id,org]);
  const lang=locale==="zh-CN"?"zh-CN":"en";
  const snapshot=(await db.query(`select fetched_at,events_json from tracking_snapshots where tracker_id=$1 and locale=$2
    order by latest_event_at desc nulls last,fetched_at desc limit 1`,[t.id,lang])).rows[0];
  const canVerify=kind==="advice" && ["needs_carrier","needs_verification"].includes(t.sync_state);
  return {tracking_id:t.id,direction:t.direction,carrier:t.labels?.[lang]??t.labels?.en??t.carrier_code??null,tracking_no:t.tracking_norm,
    warehouse_state:t.warehouse_state??null,transport_state:t.transport_state,sync_state:t.sync_state,locale:lang,
    translation_status:snapshot?"ready":"pending",events:snapshot?.events_json??[],allowed_actions:canVerify?["verify_tracking"]:[],
    ...(t.last_success_at?{last_success_at:t.last_success_at}:{}),...(t.latest_event_at?{latest_event_at:t.latest_event_at}:{}),
    ...(snapshot?{localized_snapshot_at:snapshot.fetched_at}:{}),...(t.next_query_at?{next_allowed_at:t.next_query_at}:{})};
}
export async function verificationState(db:DB,actor:Actor,id:string) {
  const org=organization(actor);
  return one(db,`select t.revision,t.carrier_code,t.sync_state from tracking_records t
    where t.advice_id=$1 and t.org_id=$2 and t.closed_at is null`,[id,org]);
}
export async function verifyTracking(db:DB,actor:Actor,id:string,input:{revision:number;carrier_code:string;phone?:string}) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const initial=await one(db,"select tracking_norm from tracking_records where advice_id=$1 and org_id=$2 and closed_at is null",[id,org]);
  await lock(db,"waybill:"+initial.tracking_norm);
  const t=await one(db,"select * from tracking_records where advice_id=$1 and org_id=$2 and closed_at is null for update",[id,org]);
  revision(t.revision,input.revision);
  guard(["needs_carrier","needs_verification"].includes(t.sync_state) && (!t.carrier_code || t.carrier_code===input.carrier_code),
    "TRACKING_VERIFICATION_UNAVAILABLE","This tracking record cannot be changed here.");
  await validCarrier(db,input.carrier_code);
  const carrier=await one(db,"select phone_rule from carriers where code=$1",[input.carrier_code]);
  const phone=input.phone?.replace(/[ -]/g,"");
  guard(!carrier.phone_rule.required || phone && (carrier.phone_rule.format==="last4"?/^\d{4}$/:/^\+?\d{7,20}$/).test(phone),
    "TRACKING_VERIFICATION_REQUIRED","Enter the phone verification used on this shipping label.",422);
  const conflicts=await db.query(`select 1 from tracking_records where closed_at is null and tracking_norm=$1
    and (carrier_code is null or carrier_code=$2) and id<>$3`,[t.tracking_norm,input.carrier_code,t.id]);
  guard(!conflicts.rowCount,"TRACKING_REVIEW_REQUIRED","This tracking number requires staff verification.");
  await db.query(`update tracking_records set carrier_code=$2,source_phone_ciphertext=$3,
    sync_state='pending',next_query_at=now(),revision=revision+1 where id=$1`,
    [t.id,input.carrier_code,carrier.phone_rule.required&&phone?encryptSecret(phone):null]);
  await db.query(`update tracking_subscriptions set next_retry_at=now(),attempt_count=0
    where tracker_id=$1 and status in ('failed','unknown')`,[t.id]);
  await audit(db,actor,"verify_tracking","tracking_records",t.id,{carrier:input.carrier_code});
  return {revision:t.revision+1,sync_state:"pending"};
}
export async function providerCallback(db:DB,token:string,raw:string) {
  const sub=await one(db,"select * from tracking_subscriptions where callback_token=$1 and provider='kuaidi100'",[token]);
  const form=new URLSearchParams(raw),param=form.get("param"),sig=form.get("sign")?.toUpperCase();
  guard(param && sig && /^[0-9A-F]{32}$/.test(sig),"SIGNATURE_INVALID","Invalid callback signature.",400);
  const expected=md5(param+decryptSecret(sub.salt_ciphertext));
  guard(timingSafeEqual(Buffer.from(sig),Buffer.from(expected)),"SIGNATURE_INVALID","Invalid callback signature.",400);
  JSON.parse(param);
  await db.query(`insert into tracking_inbox(subscription_id,payload_sha256,received_at,encrypted_payload,verified_at)
    values($1,$2,now(),$3,now()) on conflict do nothing`,[sub.id,hash(param),encryptSecret(param)]);
  return {result:true,returnCode:"200",message:"成功"};
}
export async function consumeTrackingCallback(db:DB) {
  const row=(await db.query(`select i.*,s.tracker_id,t.closed_at from tracking_inbox i join tracking_subscriptions s on s.id=i.subscription_id
    join tracking_records t on t.id=s.tracker_id where i.processed_at is null order by i.received_at limit 1 for update of i skip locked`)).rows[0];
  if(!row) return false;
  if(!row.closed_at) {
    try {
      const payload=JSON.parse(decryptSecret(row.encrypted_payload));
      if(payload.lastResult?.data) await storeSnapshot(db,row.tracker_id,"zh-CN","kuaidi100_push",payload.lastResult);
      if(payload.status==="abort") await db.query("update tracking_records set sync_state='stopped' where id=$1",[row.tracker_id]);
    } catch (e) {
      if(!(e instanceof z.ZodError) && !(e instanceof Error && "code" in e && e.code==="TRACKING_MISMATCH")) throw e;
      await db.query("update tracking_inbox set error_code='INVALID_PAYLOAD' where id=$1",[row.id]);
    }
  }
  await db.query("update tracking_inbox set processed_at=now() where id=$1",[row.id]);
  return true;
}
async function postForm(url:string,body:Record<string,string>) {
  const r=await fetch(url,{method:"POST",body:new URLSearchParams(body),signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error("Tracking provider HTTP error");
  return r.json();
}
export async function syncTrackingOnce() {
  const {key,customer}=trackingSettings();
  if(isDemo() || !key || !customer) return false;
  const next=await transaction(async db=>{
    const t=(await db.query(`select t.*,c.provider_code,c.phone_rule,
      coalesce(a.address_snapshot->>'contact_phone',b.destination_snapshot->>'phone') phone
      from tracking_records t join carriers c on c.code=t.carrier_code and c.enabled left join package_advices a on a.id=t.advice_id
      left join shipments s on s.id=t.shipment_id left join dispatch_batches b on b.id=s.batch_id
      where t.closed_at is null and t.next_query_at<=now() and t.sync_state not in ('stopped','superseded','needs_verification')
      order by t.next_query_at limit 1 for update of t skip locked`)).rows[0];
    if(!t) return null;
    await lock(db,"query:"+t.carrier_code+":"+t.tracking_norm);
    await db.query("update tracking_records set next_query_at=now()+interval '61 minutes' where id=$1",[t.id]);
    if(t.phone_rule?.required && !t.phone && !t.source_phone_ciphertext) {
      await db.query("update tracking_records set sync_state='needs_verification' where id=$1",[t.id]);return null;
    }
    const counts=await one(db,`select count(*)::int n,coalesce(max(reserved_at)>now()-interval '60 minutes',false) too_soon
      from tracking_query_attempts where provider='kuaidi100' and carrier_code=$1 and tracking_norm=$2 and reserved_at>now()-interval '24 hours'`,
      [t.carrier_code,t.tracking_norm]);
    if(counts.n>=24 || counts.too_soon) return null;
    const locale=counts.n%2?"zh-CN":"en";
    const a=await one(db,`insert into tracking_query_attempts(provider,carrier_code,tracking_norm,requested_locale,reserved_at)
      values('kuaidi100',$1,$2,$3,now()) returning id`,[t.carrier_code,t.tracking_norm,locale]);
    return {t,locale,attempt:a.id};
  });
  if(!next) return false;
  const {t,locale,attempt}=next;
  try {
    const phone=t.source_phone_ciphertext?decryptSecret(t.source_phone_ciphertext):t.phone;
    const param=JSON.stringify({com:t.provider_code,num:t.tracking_norm,lang:locale==="en"?"en":"zh",resultv2:"4",...(t.phone_rule?.required?{phone}:{})});
    const response=await postForm("https://poll.kuaidi100.com/poll/query.do",{customer,param,sign:md5(param+key+customer)});
    await transaction(async db=>{
      if(Array.isArray(response.data) && String(response.status)==="200") {
        await storeSnapshot(db,t.id,locale,"kuaidi100_query",response);
        await db.query("update tracking_query_attempts set completed_at=now(),outcome='ok' where id=$1",[attempt]);
      } else {
        const returnCode=String(response.returnCode);
        const outcomes:Record<string,{state:string;outcome:string;waitHours:number}>={
          "401":{state:"unsupported",outcome:"unsupported",waitHours:24},
          "408":{state:"needs_verification",outcome:"needs_verification",waitHours:1},
          "500":{state:"no_record",outcome:"no_record",waitHours:1},
          "503":{state:"provider_error",outcome:"auth_error",waitHours:24},
          "504":{state:"delayed",outcome:"rate_limited",waitHours:24},
          "601":{state:"provider_error",outcome:"quota_exhausted",waitHours:24},
        };
        const {state,outcome,waitHours}=outcomes[returnCode]??{state:"provider_error",outcome:"provider_error",waitHours:1};
        await db.query(`update tracking_records set sync_state=$2,
          next_query_at=greatest(next_query_at,now()+make_interval(hours=>$3)) where id=$1 and closed_at is null`,[t.id,state,waitHours]);
        await db.query("update tracking_query_attempts set completed_at=now(),outcome=$2 where id=$1",[attempt,outcome]);
      }
    });
  } catch {
    await pool.query("update tracking_records set sync_state='provider_error' where id=$1 and closed_at is null",[t.id]);
    await pool.query("update tracking_query_attempts set completed_at=now(),outcome='provider_error' where id=$1",[attempt]);
  }
  return true;
}
export async function subscribeTrackingOnce() {
  const {key,callbackBase:base}=trackingSettings();
  if(isDemo() || !key || !base) return false;
  const job=await transaction(async db=>{
    const t=(await db.query(`select t.id,t.tracking_norm,t.source_phone_ciphertext,c.provider_code,c.phone_rule,
      coalesce(a.address_snapshot->>'contact_phone',b.destination_snapshot->>'phone') phone from tracking_records t
      join carriers c on c.code=t.carrier_code and c.enabled left join package_advices a on a.id=t.advice_id
      left join shipments s on s.id=t.shipment_id left join dispatch_batches b on b.id=s.batch_id
      left join tracking_subscriptions x on x.tracker_id=t.id and x.provider='kuaidi100'
      where t.closed_at is null and t.sync_state not in ('needs_verification','superseded','stopped')
      and (not coalesce((c.phone_rule->>'required')::boolean,false) or t.source_phone_ciphertext is not null
        or coalesce(a.address_snapshot->>'contact_phone',b.destination_snapshot->>'phone') is not null)
      and (x.id is null or (x.status in ('pending','failed','unknown') and x.next_retry_at<=now() and x.attempt_count<10))
      order by x.next_retry_at nulls first,t.id limit 1 for update of t skip locked`)).rows[0];
    if(!t) return null;
    const previous=(await db.query("select * from tracking_subscriptions where tracker_id=$1 and provider='kuaidi100' for update",[t.id])).rows[0];
    if(previous) {
      await db.query(`update tracking_subscriptions set status='pending',attempt_count=attempt_count+1,
        next_retry_at=now()+make_interval(mins=>least(360,15*(attempt_count+1))) where id=$1`,[previous.id]);
      return {t,token:previous.callback_token,salt:decryptSecret(previous.salt_ciphertext),id:previous.id};
    }
    const token=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
    const s=await one(db,`insert into tracking_subscriptions(tracker_id,provider,callback_token,salt_ciphertext,credential_version,status,attempt_count,next_retry_at)
      values($1,'kuaidi100',$2,$3,'1','pending',1,now()+interval '15 minutes') returning id`,[t.id,token,encryptSecret(salt)]);
    return {t,token,salt,id:s.id};
  });
  if(!job) return false;
  try {
    const phone=job.t.source_phone_ciphertext?decryptSecret(job.t.source_phone_ciphertext):job.t.phone;
    const response=await postForm("https://poll.kuaidi100.com/poll",{schema:"json",param:JSON.stringify({
      company:job.t.provider_code,number:job.t.tracking_norm,key,parameters:{callbackurl:new URL("/api/v1/webhooks/tracking/kuaidi100/"+job.token,base).href,
        salt:job.salt,resultv2:4,...(job.t.phone_rule?.required?{phone}:{})}})});
    await pool.query("update tracking_subscriptions set status=$2,last_error_code=$3 where id=$1",[job.id,response.result===true?"active":"failed",response.result===true?null:"PROVIDER_REJECTED"]);
  } catch {
    await pool.query("update tracking_subscriptions set status='unknown',last_error_code='PROVIDER_TIMEOUT' where id=$1",[job.id]);
  }
  return true;
}
export async function trackingAdmin(db:DB,actor:Actor) {
  role(actor,"warehouse_admin","receiver","support","super_admin");
  return (await db.query(`select t.id,t.direction,t.tracking_norm,t.transport_state,t.sync_state,t.package_id,t.shipment_id,
    t.last_success_at,(select s.events_json from tracking_snapshots s where s.tracker_id=t.id and s.locale='zh-CN'
    order by s.latest_event_at desc nulls last,s.fetched_at desc limit 1) events from tracking_records t where t.closed_at is null
    order by t.next_query_at desc nulls last limit 100`)).rows;
}
