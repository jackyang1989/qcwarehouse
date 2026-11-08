import { z } from "zod";
import type { DB } from "../db";
import { audit, guard, hash, one, organization, uuid, type Actor } from "./common";

export const shareTokenPattern="[A-Za-z0-9_-]{43}";
export const shareInput=z.object({days:z.union([z.literal(1),z.literal(7),z.literal(30)])}).strict();
export const reportSharingEnabled=()=>process.env.REPORT_SHARING_ENABLED==="1";

export async function listPublishedReports(db:DB,actor:Actor,reference:string|null,version:number|null) {
  const {rows}=await db.query(`select o.public_no order_number,r.public_no report_number,
    v.version,v.published_at,v.amend_reason,v.version=r.published_version is_current
    from reports r join orders o on o.id=r.order_id join report_versions v on v.report_id=r.id
    where o.org_id=$1 and v.state in ('published','superseded')
    and ($2::text is null or o.public_no=$2 or r.public_no=$2)
    and ($3::int is null or v.version=$3)
    order by v.published_at desc,v.id limit 100`,[organization(actor),reference,version]);
  return {rows};
}

async function ownedVersion(db:DB,actor:Actor,orderId:string,version:number) {
  return one<{id:string;report_id:string}>(db,`select v.id,v.report_id from report_versions v
    join reports r on r.id=v.report_id join orders o on o.id=r.order_id
    where o.id=$1 and o.org_id=$2 and v.version=$3 and v.state in ('published','superseded')`,
    [orderId,organization(actor),version]);
}
export async function listReportShares(db:DB,actor:Actor,orderId:string,version:number) {
  const report=await ownedVersion(db,actor,orderId,version);
  const {rows}=await db.query(`select id,created_at,expires_at,revoked_at,
    case when revoked_at is not null then 'revoked' when expires_at<=now() then 'expired' else 'active' end state
    from report_shares where report_version_id=$1 order by created_at desc,id limit 100`,[report.id]);
  return {enabled:reportSharingEnabled(),shares:rows};
}
export async function createReportShare(db:DB,actor:Actor,orderId:string,version:number,days:number,token:string) {
  guard(reportSharingEnabled(),"REPORT_SHARING_DISABLED","Report sharing is currently unavailable.",403);
  const report=await ownedVersion(db,actor,orderId,version);
  const share=await one<{id:string;expires_at:Date}>(db,`insert into report_shares
    (id,report_id,report_version_id,token_hash,expires_at,created_by)
    values($1,$2,$3,$4,now()+make_interval(days=>$5),$6) returning id,expires_at`,
    [uuid(),report.report_id,report.id,hash(token),days,actor.id]);
  await audit(db,actor,"create_report_share","report_shares",share.id,{version,days});
  return share;
}
export async function revokeReportShare(db:DB,actor:Actor,id:string) {
  const share=await one<{revoked_at:Date|null}>(db,`select s.revoked_at from report_shares s
    join reports r on r.id=s.report_id join orders o on o.id=r.order_id
    where s.id=$1 and o.org_id=$2 for update of s`,[id,organization(actor)]);
  if(share.revoked_at)return {id,revoked_at:share.revoked_at};
  const result=await one(db,"update report_shares set revoked_at=now() where id=$1 returning id,revoked_at",[id]);
  await audit(db,actor,"revoke_report_share","report_shares",id);
  return result;
}

type Result={item:string;label:string;status:string;typed_value:unknown;unit:string|null;evidence_ids:string[]};
type ShareSection={
  title:string;
  results:Result[];
  shots?:{code:string;component:string;media_id:string}[];
  comparison?:{
    diffs:{point_code:string;label:string;unit:string|null;max_minus_min:number|null;display_diff:string}[];
    order_shots:{code:string;media_id:string}[];
  };
};
type ShareSnapshot={order_no:string;report_no:string;not_inspected?:string[];scope_notice?:string;sections:ShareSection[]};
async function sharedVersion(db:DB,token:string) {
  guard(reportSharingEnabled(),"NOT_FOUND","Record not found.",404);
  return one<{org_id:string;version:number;snapshot:ShareSnapshot;published_at:Date}>(db,`select o.org_id,v.version,v.snapshot,v.published_at
    from report_shares s join report_versions v on v.id=s.report_version_id and v.report_id=s.report_id
    join reports r on r.id=s.report_id join orders o on o.id=r.order_id
    where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and v.state in ('published','superseded')`,[hash(token)]);
}
export async function readSharedReport(db:DB,token:string) {
  const {version,snapshot,published_at}=await sharedVersion(db,token);
  return {version,published_at,order_number:snapshot.order_no,report_number:snapshot.report_no,
    ...(snapshot.not_inspected?{not_inspected:snapshot.not_inspected}:{}),
    ...(snapshot.scope_notice?{scope_notice:snapshot.scope_notice}:{}),
    sections:snapshot.sections.map(({title,results,shots,comparison})=>({
      title,
      results:results.map(r=>({
        item:r.item,label:r.label,status:r.status,unit:r.unit,
        value:typeof r.typed_value==="number"||typeof r.typed_value==="boolean"?r.typed_value:null,
        photo_count:r.evidence_ids.length,
      })),
      ...(shots?.length?{shot_count:shots.length}:{}),
      ...(comparison?{comparison:{diffs:comparison.diffs,order_shot_count:comparison.order_shots?.length??0}}:{}),
    }))};
}
export async function readSharedPhoto(db:DB,token:string,section:number,result:number,photo:number) {
  const {org_id,snapshot}=await sharedVersion(db,token);
  const sec=snapshot.sections[section];
  const id=
    result===999998
      ?sec?.shots?.[photo]?.media_id
      :result===999999
        ?sec?.comparison?.order_shots?.[photo]?.media_id
        :sec?.results[result]?.evidence_ids[photo];
  guard(id,"NOT_FOUND","Record not found.",404);
  return one<{data:Buffer;mime:string}>(db,`select f.data,f.mime from media_assets m join private_files f on f.key=m.object_key
    where m.id=$1 and m.org_id=$2 and (m.result_id is not null or m.shot_code is not null or m.point_code is not null) and m.kind='shot' and m.status='ready'`,[id,org_id]);
}
