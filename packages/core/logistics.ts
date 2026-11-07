import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import { encryptSecret, decryptSecret, requireStaffMfa } from "./auth";
import { trackingSettings } from "./integrations";
import { validCarrier, waybill } from "./intake";
import { staffAccess } from "./staff-access";
import { Problem, audit, event, guard, hash, isDemo, lock, one, organization, revision, role, uuid, type Actor } from "./common";

const md5=(s:string)=>createHash("md5").update(s).digest("hex").toUpperCase();
const states:Record<string,string>={"0":"in_transit","1":"picked_up","2":"exception","3":"delivered","4":"returned","5":"out_for_delivery","6":"returning","7":"forwarded","8":"exception"};
const payloadSchema=z.object({com:z.string().optional(),nu:z.string().optional(),state:z.union([z.string(),z.number()]).optional(),
  data:z.array(z.object({context:z.string().min(1).max(1600),ftime:z.string().optional(),time:z.string().optional(),statusCode:z.string().optional(),areaName:z.string().optional(),areaCode:z.string().optional()})).max(500)});
function eventTime(time?:string) {
  if(!time) return undefined;
  const parsed=new Date(time.replace(" ","T")+(time.length===19?"+08:00":""));
  return Number.isFinite(parsed.valueOf())?parsed.toISOString():undefined;
}
function redactTrackingText(raw:string) {
  return raw
    .replace(/(?:取件码|提货码|取货码|pickup\s*code)[:：\s]*[A-Za-z0-9-]+/gi,"[pickup code redacted]")
    .replace(/\+?\d[\d -]{6,}\d/g,"[phone redacted]");
}
async function openTrackingAlert(db:DB,trackerId:string,kind:string) {
  const active=(await db.query("select id from tracking_alerts where tracker_id=$1 and kind=$2 and state in ('open','acknowledged') limit 1",[trackerId,kind])).rows[0];
  if(active) return active.id as string;
  const {n}=await one<{n:number}>(db,"select coalesce(max(episode),0)::int n from tracking_alerts where tracker_id=$1 and kind=$2",[trackerId,kind]);
  const alert=await one<{id:string}>(db,`insert into tracking_alerts(id,tracker_id,kind,episode,state,due_at,last_notified_at)
    values($1,$2,$3,$4,'open',now()+interval '24 hours',now()) returning id`,[uuid(),trackerId,kind,n+1]);
  await event(db,"tracking.exception_opened",{tracker_id:trackerId,alert_id:alert.id,kind,episode:n+1});
  return alert.id;
}
async function storeSnapshot(db:DB,id:string,locale:string,source:string,input:unknown) {
  const p=payloadSchema.parse(input);
  const tracker=await one(db,"select carrier_code,tracking_norm,latest_event_at,transport_state from tracking_records where id=$1 and closed_at is null for update",[id]);
  const carrier=await one(db,"select provider_code from carriers where code=$1",[tracker.carrier_code]);
  guard((!p.com || p.com===carrier.provider_code) && (!p.nu || p.nu.toUpperCase()===tracker.tracking_norm),
    "TRACKING_MISMATCH","Carrier response does not match the transport record.");
  const events=p.data.map(e=>{
    const rawTime=e.ftime??e.time;
    const ts=eventTime(rawTime);
    const loc=e.areaName?.trim()||e.areaCode?.trim()||undefined;
    // Omit explicit telephone numbers and pickup codes from customer-facing content.
    const message=redactTrackingText(e.context);
    const fp=hash(`${rawTime??""}|${e.statusCode??""}|${loc??""}|${message}`);
    return {
      id:fp.slice(0,24),
      text:message,
      source,
      ...(ts?{occurred_at:ts}:{}),
      ...(loc?{location:loc}:{}),
      ...(e.statusCode?{status_code:e.statusCode}:{}),
      _rawTime:rawTime??null,
      _fp:fp,
    };
  });
  const storedEvents=events.map(({_rawTime,_fp,...pub})=>pub);
  const last=storedEvents.flatMap(e=>e.occurred_at?[e.occurred_at]:[]).sort().at(-1)??null;
  const state=states[String(p.state)]??"unknown";
  const payloadHash=hash(JSON.stringify(p));
  const snap=(await db.query<{id:string}>(`insert into tracking_snapshots(tracker_id,source,locale,payload_hash,fetched_at,latest_event_at,provider_state,events_json,schema_version)
    values($1,$2,$3,$4,now(),$5,$6,$7,1)
    on conflict(tracker_id,source,locale,payload_hash) do update set schema_version=tracking_snapshots.schema_version
    returning id`,[id,source,locale,payloadHash,last,state,JSON.stringify(storedEvents)])).rows[0];
  if(locale==="zh-CN" && snap) {
    for(const e of events) {
      await db.query(`insert into tracking_events(tracker_id,fingerprint,source_time,occurred_at,source_timezone,status_code,location_code,text_zh,source_snapshot_id)
        values($1,$2,$3,$4,'Asia/Shanghai',$5,$6,$7,$8) on conflict(tracker_id,fingerprint) do nothing`,
        [id,e._fp,e._rawTime,e.occurred_at??null,e.status_code??null,e.location??null,e.text,snap.id]);
    }
  }
  await db.query(`update tracking_records set last_success_at=now(),sync_state=$4,
    latest_event_at=greatest(latest_event_at,$2),transport_state=case when $2::timestamptz is not null
    and (latest_event_at is null or latest_event_at<$2::timestamptz or (latest_event_at=$2::timestamptz and ($3 in ('delivered','returning','returned','exception') or transport_state=$3))) then $3 else transport_state end
    where id=$1`,[id,last,state,storedEvents.length?"active":"no_record"]);
  if(["exception","returning","returned"].includes(state)) {
    await openTrackingAlert(db,id,state==="exception"?"exception":"returning");
  } else if(["in_transit","out_for_delivery","delivered"].includes(state)) {
    await db.query("update tracking_alerts set state='resolved' where tracker_id=$1 and kind in ('exception','stalled') and state in ('open','acknowledged')",[id]);
  }
}
export async function tracking(db:DB,actor:Actor,id:string,kind:"advice"|"shipment",locale:string) {
  const org=organization(actor);
  const filter=kind==="advice"?"t.advice_id":"t.shipment_id";
  const t=await one(db,`select t.*,coalesce(p.state,s.state) warehouse_state,c.labels from tracking_records t left join packages p on p.id=t.package_id
    left join shipments s on s.id=t.shipment_id left join carriers c on c.code=t.carrier_code where ${filter}=$1 and t.org_id=$2 and t.closed_at is null order by t.generation desc limit 1`,[id,org]);
  const lang=locale==="zh-CN"?"zh-CN":"en";
  const snapshot=(await db.query(`select fetched_at,latest_event_at,events_json from tracking_snapshots where tracker_id=$1 and locale=$2
    order by latest_event_at desc nulls last,fetched_at desc limit 1`,[t.id,lang])).rows[0];
  let events:(Record<string,unknown>)[]=Array.isArray(snapshot?.events_json)?[...snapshot.events_json]:[];
  let translationStatus=snapshot?"ready":"pending";
  if(lang==="en") {
    const zhSnap=(await db.query(`select latest_event_at from tracking_snapshots where tracker_id=$1 and locale='zh-CN'
      order by latest_event_at desc nulls last,fetched_at desc limit 1`,[t.id])).rows[0];
    const manual=(await db.query<{fingerprint:string;occurred_at:Date|null;location_code:string|null;status_code:string|null;body:string;text_zh:string;source_hash:string}>(
      `select te.fingerprint,te.occurred_at,te.location_code,te.status_code,tr.body,te.text_zh,tr.source_hash
       from tracking_events te join tracking_translations tr on tr.event_id=te.id
       where te.tracker_id=$1 and tr.locale='en' and tr.reviewed_at is not null order by te.occurred_at desc nulls last`,[t.id]
    )).rows.filter(r=>hash(r.text_zh??"")===r.source_hash);
    const seen=new Set(events.map(e=>String(e.id)));
    for(const m of manual) {
      const mid=m.fingerprint.slice(0,24);
      if(!seen.has(mid)) {
        seen.add(mid);
        events.push({
          id:mid,
          text:redactTrackingText(m.body),
          source:"manual_reviewed",
          ...(m.occurred_at?{occurred_at:new Date(m.occurred_at).toISOString()}:{}),
          ...(m.location_code?{location:m.location_code}:{}),
          ...(m.status_code?{status_code:m.status_code}:{}),
        });
      }
    }
    if(zhSnap?.latest_event_at && (!snapshot?.latest_event_at || new Date(zhSnap.latest_event_at)>new Date(snapshot.latest_event_at)) && !manual.length) {
      translationStatus="updating";
    } else if(events.length>0) {
      translationStatus="ready";
    }
  }
  const canVerify=kind==="advice" && ["needs_carrier","needs_verification"].includes(t.sync_state);
  return {tracking_id:t.id,direction:t.direction,carrier:t.labels?.[lang]??t.labels?.en??t.carrier_code??null,tracking_no:t.tracking_norm,
    warehouse_state:t.warehouse_state??null,transport_state:t.transport_state,sync_state:t.sync_state,locale:lang,
    translation_status:translationStatus,events,allowed_actions:canVerify?["verify_tracking"]:[],
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
  const row=(await db.query(`select i.*,s.tracker_id from tracking_inbox i join tracking_subscriptions s on s.id=i.subscription_id
    where i.processed_at is null order by i.received_at limit 1 for update of i skip locked`)).rows[0];
  if(!row) return false;
  const tracker=await one(db,"select closed_at from tracking_records where id=$1 for update",[row.tracker_id]);
  if(!tracker.closed_at) {
    try {
      const payload=JSON.parse(decryptSecret(row.encrypted_payload));
      if(payload.lastResult?.data) await storeSnapshot(db,row.tracker_id,"zh-CN","kuaidi100_push",payload.lastResult);
      if(payload.status==="abort") {
        await db.query("update tracking_records set sync_state='stopped' where id=$1",[row.tracker_id]);
        await openTrackingAlert(db,row.tracker_id,"subscription_aborted");
      }
    } catch (e) {
      if(!(e instanceof z.ZodError) && !(e instanceof Error && "code" in e && e.code==="TRACKING_MISMATCH")) throw e;
      await db.query("update tracking_inbox set error_code='INVALID_PAYLOAD' where id=$1",[row.id]);
    }
  }
  await db.query("update tracking_inbox set processed_at=now() where id=$1",[row.id]);
  return true;
}
export async function refreshTracking(db:DB,actor:Actor,id:string,kind:"advice"|"shipment") {
  const org=organization(actor);
  const filter=kind==="advice"?"advice_id":"shipment_id";
  const t=await one(db,`select * from tracking_records where ${filter}=$1 and org_id=$2 and closed_at is null order by generation desc limit 1 for update`,[id,org]);
  await lock(db,"query:"+(t.carrier_code??"unknown")+":"+t.tracking_norm);
  const counts=t.carrier_code
    ?await one<{n:number;too_soon:boolean;last_reserved:Date|null}>(db,`select count(*)::int n,coalesce(max(reserved_at)>now()-interval '60 minutes',false) too_soon,max(reserved_at) last_reserved
      from tracking_query_attempts where provider='kuaidi100' and carrier_code=$1 and tracking_norm=$2 and reserved_at>now()-interval '24 hours'`,
      [t.carrier_code,t.tracking_norm])
    :{n:0,too_soon:false,last_reserved:null};
  const now=new Date();
  const nextAllowed=t.next_query_at?new Date(t.next_query_at):now;
  const blocked=!t.carrier_code || ["stopped","superseded","needs_carrier","needs_verification","unsupported","delayed"].includes(t.sync_state) || counts.n>=24 || counts.too_soon || nextAllowed>now;
  let effectiveNext=nextAllowed>now?nextAllowed:new Date(now.getTime()+60*60_000);
  if(counts.too_soon && counts.last_reserved) {
    const cooldownEnd=new Date(new Date(counts.last_reserved).getTime()+60*60_000);
    if(cooldownEnd>effectiveNext) effectiveNext=cooldownEnd;
  }
  if(blocked) {
    throw new Problem("RATE_LIMITED",`Next manual refresh is available at ${effectiveNext.toISOString()}.`,429);
  }
  await db.query("update tracking_records set next_query_at=now()+interval '60 minutes' where id=$1",[t.id]);
  const snap=await tracking(db,actor,id,kind,"en");
  return {queued:true,cooldown:false,next_allowed_at:effectiveNext.toISOString(),cached_snapshot:snap};
}
export async function correctCustomerParcelTracking(
  db:DB,actor:Actor,adviceId:string,input:{revision:number;carrier_code:string;tracking_no:string;phone?:string}
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const norm=waybill(input.tracking_no);
  await lock(db,"waybill:"+norm);
  const t=await one(db,"select * from tracking_records where advice_id=$1 and org_id=$2 and closed_at is null for update",[adviceId,org]);
  revision(t.revision,input.revision);
  guard(!t.package_id,"PARCEL_ALREADY_RECEIVED","Checked-in parcels require warehouse staff verification to amend.");
  await validCarrier(db,input.carrier_code);
  const carrier=await one(db,"select phone_rule from carriers where code=$1",[input.carrier_code]);
  const phone=input.phone?.replace(/[ -]/g,"");
  guard(!carrier.phone_rule?.required || phone && (carrier.phone_rule.format==="last4"?/^\d{4}$/:/^\+?\d{7,20}$/).test(phone),
    "TRACKING_VERIFICATION_REQUIRED","Enter the phone verification used on this shipping label.",422);
  const conflicts=await db.query(`select 1 from tracking_records where closed_at is null and tracking_norm=$1
    and (carrier_code is null or carrier_code=$2) and id<>$3`,[norm,input.carrier_code,t.id]);
  guard(!conflicts.rowCount,"TRACKING_REVIEW_REQUIRED","This tracking number requires staff verification.");
  await db.query("update tracking_records set closed_at=now(),sync_state='superseded',revision=revision+1 where id=$1",[t.id]);
  const next=await one<{id:string;generation:number;revision:number}>(db,`insert into tracking_records(
    org_id,direction,advice_id,carrier_code,tracking_norm,generation,supersedes_id,source_phone_ciphertext,transport_state,sync_state,next_query_at,revision
  ) values($1,'inbound',$2,$3,$4,$5,$6,$7,'unknown','pending',now(),1) returning id,generation,revision`,
  [org,adviceId,input.carrier_code,norm,t.generation+1,t.id,carrier.phone_rule?.required&&phone?encryptSecret(phone):null]);
  await event(db,"tracking.corrected",{tracker_id:next.id,supersedes_id:t.id,advice_id:adviceId});
  await audit(db,actor,"correct_parcel_tracking","tracking_records",next.id,{supersedes_id:t.id,tracking_norm:norm,carrier_code:input.carrier_code});
  return {tracking_id:next.id,generation:next.generation,revision:next.revision,tracking_no:norm,carrier_code:input.carrier_code,sync_state:"pending"};
}
export async function correctStaffTracking(
  db:DB,actor:Actor,trackerId:string,input:{revision:number;carrier_code:string;tracking_no:string;reason:string;evidence_ids?:string[]},sessionHash:string
) {
  role(actor,"warehouse_admin","super_admin");
  await requireStaffMfa(db,actor,sessionHash,15);
  const norm=waybill(input.tracking_no);
  await validCarrier(db,input.carrier_code);
  await lock(db,"waybill:"+norm);
  const t=await one(db,"select * from tracking_records where id=$1 and closed_at is null for update",[trackerId]);
  revision(t.revision,input.revision);
  if(t.shipment_id) {
    guard(input.evidence_ids && input.evidence_ids.length>=1,"EVIDENCE_REQUIRED","Outbound waybill correction after handover requires label photo evidence.",422);
  }
  const conflicts=await db.query(`select 1 from tracking_records where closed_at is null and tracking_norm=$1
    and (carrier_code is null or carrier_code=$2) and id<>$3`,[norm,input.carrier_code,t.id]);
  guard(!conflicts.rowCount,"TRACKING_REVIEW_REQUIRED","This tracking number conflicts with another active record.");
  await db.query("update tracking_records set closed_at=now(),sync_state='superseded',revision=revision+1 where id=$1",[t.id]);
  const next=await one<{id:string;generation:number;revision:number}>(db,`insert into tracking_records(
    org_id,direction,advice_id,package_id,shipment_id,carrier_code,tracking_norm,generation,supersedes_id,source_phone_ciphertext,transport_state,sync_state,next_query_at,revision
  ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown','pending',now(),1) returning id,generation,revision`,
  [t.org_id,t.direction,t.advice_id,t.package_id,t.shipment_id,input.carrier_code,norm,t.generation+1,t.id,t.source_phone_ciphertext]);
  await event(db,"tracking.corrected",{tracker_id:next.id,supersedes_id:t.id,reason:input.reason});
  await audit(db,actor,"staff_correct_tracking","tracking_records",next.id,{supersedes_id:t.id,tracking_norm:norm,carrier_code:input.carrier_code,reason:input.reason,evidence_ids:input.evidence_ids??[]});
  return {tracking_id:next.id,generation:next.generation,revision:next.revision,tracking_no:norm,carrier_code:input.carrier_code};
}
export async function submitTrackingTranslation(
  db:DB,actor:Actor,trackerId:string,input:{event_id?:string;tracking_event_id?:string;source_hash?:string;text?:string;text_en?:string}
) {
  role(actor,"receiver","support","reviewer","warehouse_admin","super_admin");
  const eventId=input.tracking_event_id??input.event_id;
  const textEn=input.text_en??input.text??"";
  guard(eventId && textEn.trim().length>=2,"INVALID_REQUEST","Provide tracking_event_id and translated English text.",422);
  const ev=await one<{id:string;tracker_id:string;text_zh:string|null}>(db,"select id,tracker_id,text_zh from tracking_events where id=$1 and tracker_id=$2",[eventId,trackerId]);
  const expectedHash=hash(ev.text_zh??"");
  if(input.source_hash) {
    guard(input.source_hash===expectedHash,"SOURCE_HASH_MISMATCH","The Chinese source event text does not match the provided hash.");
  }
  const tr=await one<{id:string;event_id:string;source_hash:string;locale:string;body:string;source:string}>(db,
    `insert into tracking_translations(id,event_id,source_hash,locale,body,source,reviewer_id,reviewed_at)
     values($1,$2,$3,'en',$4,$5,null,null)
     on conflict(event_id,source_hash,locale) do update set body=excluded.body,source=excluded.source,reviewer_id=null,reviewed_at=null
     returning id,event_id,source_hash,locale,body,source`,
    [uuid(),ev.id,expectedHash,redactTrackingText(textEn.trim()),"draft:"+actor.id]
  );
  await audit(db,actor,"submit_tracking_translation","tracking_translations",tr.id,{event_id:ev.id,source_hash:expectedHash});
  return {id:tr.id,event_id:tr.event_id,source_hash:tr.source_hash,locale:tr.locale,text:tr.body,state:"pending_review"};
}
export async function approveTrackingTranslation(db:DB,actor:Actor,translationId:string) {
  role(actor,"receiver","reviewer","support","warehouse_admin","super_admin");
  const tr=await one<{id:string;event_id:string;source_hash:string;locale:string;body:string;source:string;reviewer_id:string|null}>(db,
    "select * from tracking_translations where id=$1 for update",[translationId]);
  guard(tr.source!=="draft:"+actor.id,"SELF_REVIEW_FORBIDDEN","Translation drafts must be approved by a different staff member.",403);
  const ev=await one<{id:string;text_zh:string|null}>(db,"select id,text_zh from tracking_events where id=$1",[tr.event_id]);
  guard(hash(ev.text_zh??"")===tr.source_hash,"TRANSLATION_STALE","Source event text changed after the translation was drafted.");
  await db.query("update tracking_translations set source='manual_reviewed',reviewer_id=$2,reviewed_at=now() where id=$1",[tr.id,actor.id]);
  await audit(db,actor,"approve_tracking_translation","tracking_translations",tr.id,{event_id:tr.event_id,source_hash:tr.source_hash});
  return {id:tr.id,event_id:tr.event_id,source_hash:tr.source_hash,locale:tr.locale,text:tr.body,state:"approved",reviewer_id:actor.id};
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
      const current=await one(db,"select closed_at from tracking_records where id=$1 for update",[t.id]);
      if(current.closed_at) {
        await db.query("update tracking_query_attempts set completed_at=now(),outcome='superseded' where id=$1",[attempt]);
        return;
      }
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
  role(actor,...staffAccess.tracking);
  const rows=(await db.query(`select t.id,t.direction,t.carrier_code,t.tracking_norm,t.revision,t.transport_state,t.sync_state,t.package_id,t.shipment_id,
    t.last_success_at,(select s.events_json from tracking_snapshots s where s.tracker_id=t.id and s.locale='zh-CN'
    order by s.latest_event_at desc nulls last,s.fetched_at desc limit 1) events,
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'occurred_at',e.occurred_at,'source_time',e.source_time,'text_zh',e.text_zh,
      'translation_id',tr.id,'text_en',tr.body,'translation_source',tr.source,'reviewed_at',tr.reviewed_at
    ) order by e.occurred_at desc nulls last,e.id desc)
    from tracking_events e
    left join tracking_translations tr on tr.event_id=e.id and tr.locale='en'
    where e.tracker_id=t.id),'[]'::jsonb) raw_events
    from tracking_records t where t.closed_at is null
    order by t.next_query_at desc nulls last limit 100`)).rows;
  return rows.map((r:any)=>{
    const zh_events=(Array.isArray(r.raw_events)?r.raw_events:[]).map((ev:any)=>{
      const source_hash=hash(ev.text_zh??"");
      return {...ev,source_hash};
    });
    const {raw_events:_unused,...rest}=r;
    return {...rest,zh_events};
  });
}

export async function trackingMonitor(db:DB,actor:Actor) {
  role(actor,...staffAccess.tracking);
  const cfg=trackingSettings();
  const carriers=(await db.query(
    `select code,provider_code,labels,phone_rule,enabled,
            coalesce(labels->>'zh-CN',code) name_zh,
            coalesce(labels->>'en',code) name_en,
            coalesce((phone_rule->>'required')::boolean,false) requires_phone,
            enabled active
     from carriers order by enabled desc,code`
  )).rows;
  const quota=await one<{
    queries_24h:number;
    ok_24h:number;
    rate_limited_24h:number;
    quota_exhausted_24h:number;
    auth_errors_24h:number;
    provider_errors_24h:number;
    active_subscriptions:number;
    failed_subscriptions:number;
  }>(
    db,
    `select
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours') queries_24h,
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours' and outcome='ok') ok_24h,
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours' and outcome='rate_limited') rate_limited_24h,
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours' and outcome='quota_exhausted') quota_exhausted_24h,
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours' and outcome='auth_error') auth_errors_24h,
       (select count(*)::int from tracking_query_attempts where reserved_at>now()-interval '24 hours' and outcome='provider_error') provider_errors_24h,
       (select count(*)::int from tracking_subscriptions where status='active') active_subscriptions,
       (select count(*)::int from tracking_subscriptions where status in ('failed','unknown')) failed_subscriptions`
  );
  const errorQueue=(await db.query(
    `select t.id,t.direction,t.carrier_code,t.tracking_norm,t.transport_state,t.sync_state,t.package_id,t.shipment_id,
            t.last_success_at,t.next_query_at
     from tracking_records t
     where t.closed_at is null
       and (t.sync_state in ('provider_error','delayed','needs_verification','needs_carrier','stopped','unsupported','no_record')
            or t.transport_state in ('exception','returning','returned'))
     order by t.next_query_at asc nulls first limit 100`
  )).rows;
  const alerts=(await db.query(
    `select a.id,a.tracker_id,a.kind,a.episode,a.state,a.assignee_id,a.due_at,a.ticket_id,a.last_notified_at,
            t.direction,t.carrier_code,t.tracking_norm,t.transport_state,t.sync_state,
            (a.due_at is not null and a.due_at<now() and a.state in ('open','acknowledged')) overdue
     from tracking_alerts a
     join tracking_records t on t.id=a.tracker_id
     order by a.state in ('open','acknowledged') desc,a.due_at asc nulls last,a.episode desc limit 100`
  )).rows;
  const deliveredUnreceived=(await db.query(
    `select t.id,t.id tracking_id,t.carrier_code,t.tracking_norm,t.advice_id,t.transport_state,t.latest_event_at,
            t.latest_event_at delivered_at,
            (select o.public_no from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=t.advice_id limit 1) order_no,
            (select te.text_zh from tracking_events te where te.tracker_id=t.id order by te.occurred_at desc nulls last limit 1) latest_cn
     from tracking_records t
     where t.closed_at is null
       and t.direction='inbound'
       and t.transport_state='delivered'
       and t.package_id is null
     order by t.latest_event_at desc nulls last limit 100`
  )).rows;
  return {
    provider_config:{
      provider:"kuaidi100",
      configured:Boolean(cfg.key && cfg.customer),
      callback_https_ready:Boolean(cfg.callbackBase && cfg.callbackBase.startsWith("https://")),
      callback_base:cfg.callbackBase??null,
      demo_mode:isDemo(),
    },
    carriers,
    quota_summary:quota,
    error_queue:errorQueue,
    alerts,
    delivered_unreceived:deliveredUnreceived,
  };
}

export async function updateTrackingAlert(
  db:DB,
  actor:Actor,
  alertId:string,
  input:{action:"acknowledge"|"resolve";note?:string}
) {
  role(actor,...staffAccess.tracking);
  const a=await one<{
    id:string;
    tracker_id:string;
    kind:string;
    episode:number;
    state:string;
    ticket_id:string|null;
  }>(db,"select * from tracking_alerts where id=$1 for update",[alertId]);
  const nextState=input.action==="resolve"?"resolved":"acknowledged";
  await db.query(
    "update tracking_alerts set state=$2,assignee_id=coalesce(assignee_id,$3) where id=$1",
    [alertId,nextState,actor.id]
  );
  await audit(db,actor,"update_tracking_alert","tracking_alerts",alertId,{
    action:input.action,
    state:nextState,
    episode:a.episode,
    note:input.note?.trim()??null,
  });
  return {id:alertId,state:nextState,episode:a.episode,assignee_id:actor.id};
}
