import { z } from "zod";
import type { DB } from "../db";
import { role, type Actor } from "./common";

const auditKey=z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const auditPageSize=50;
export const auditFilters=z.object({
  actor_id:z.uuid().optional(),actor_type:z.enum(["customer","staff","system"]).optional(),
  action:auditKey.optional(),entity_type:auditKey.optional(),entity_id:z.uuid().optional(),
  from:z.iso.date().optional(),to:z.iso.date().optional(),
  before_id:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n).optional(),
}).refine(filters=>!filters.from||!filters.to||filters.from<=filters.to,"The end date must be on or after the start date.");

const visibleFields=["reason","decision","count","task_count","base_version","version","days",
  "job_id","type","previous_attempts","previous_error","code","zone","capacity","active","location_id",
  "event_id","assignment_id","quote_id","tracking_id","carrier","status","previous_status","kind","is_default"] as const;
function auditDetails(value:Record<string,unknown>|null) {
  return Object.fromEntries(visibleFields.flatMap(key=>{
    const field=value?.[key];
    return typeof field==="string"||typeof field==="number"||typeof field==="boolean"?[[key,field]]:[];
  }));
}
export async function readAudit(db:DB,actor:Actor,filters:z.infer<typeof auditFilters>) {
  role(actor,"super_admin");
  const {actor_id,actor_type,action,entity_type,entity_id,from,to,before_id}=filters;
  const {rows}=await db.query(`select id,at,actor_type,actor_id,action,entity_type,entity_id,before,after
    from audit_events where ($1::uuid is null or actor_id=$1) and ($2::text is null or actor_type=$2)
    and ($3::text is null or action=$3) and ($4::text is null or entity_type=$4)
    and ($5::uuid is null or entity_id=$5)
    and ($6::date is null or at>=($6::date)::timestamp at time zone 'UTC')
    and ($7::date is null or at<($7::date+1)::timestamp at time zone 'UTC')
    and ($8::bigint is null or id<$8) order by id desc limit $9`,
    [actor_id??null,actor_type??null,action??null,entity_type??null,entity_id??null,from??null,to??null,before_id??null,auditPageSize+1]);
  const page=rows.slice(0,auditPageSize);
  return {rows:page.map(({before,after,...event})=>({...event,before:auditDetails(before),after:auditDetails(after)})),
    next_before_id:rows.length>auditPageSize?page.at(-1)?.id:null};
}
