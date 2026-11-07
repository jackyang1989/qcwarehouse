import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { attachEvidence } from "./intake";
import { templateSchema } from "./orders";
import { staffAccess } from "./staff-access";

type ResultInput={item_key:string;component:string;attempt:number;status:string;method:string;is_final:boolean;typed_value?:unknown;unit?:string;reason?:string;evidence_ids?:string[];details?:Record<string,unknown>};

const componentLabels:Record<string,string>={
  main:"Item",
  top:"Top (上装)",
  bottom:"Bottom (下装)",
  set:"Set (套装整体)",
  group:"Comparison Group",
};

function roundMetric(n:number) {
  return Math.round(n*1e6)/1e6;
}

function checkThreshold(
  check:{unit?:string;retry_threshold?:number},
  policy?:{threshold_by_unit?:Record<string,number>}
):number|undefined {
  if(typeof check.retry_threshold==="number" && check.retry_threshold>0) return check.retry_threshold;
  const unit=check.unit??"";
  if(policy?.threshold_by_unit && typeof policy.threshold_by_unit[unit]==="number") {
    return policy.threshold_by_unit[unit];
  }
  if(unit==="cm") return 0.5;
  if(unit==="g") return 1;
  return undefined;
}

function conditionMatches(cond:Record<string,unknown>|undefined,attrs:Record<string,unknown>):boolean {
  if(!cond || Object.keys(cond).length===0) return true;
  if(Array.isArray(cond.any)) {
    return cond.any.some(k=>{
      const key=String(k).replace(/^attributes\./,"");
      return Boolean(attrs[key]);
    });
  }
  for(const [rawKey,expected] of Object.entries(cond)) {
    const key=rawKey.replace(/^attributes\./,"");
    if(attrs[key]!==expected) return false;
  }
  return true;
}

async function lockedTask(db:DB,id:string) {
  const initial=await one(db,`select l.org_id from inspection_tasks t join order_lines l on l.id=t.order_line_id where t.id=$1`,[id]);
  await lock(db,"org:"+initial.org_id);
  return one(db,`select t.*,l.org_id,l.order_id,l.attributes line_attributes,v.content,o.state order_state,
    e.declared_fields
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id
    join template_versions v on v.id=t.template_version_id
    left join order_line_item_links a on a.id=t.assignment_id
    left join expected_items e on e.id=a.expected_item_id
    where t.id=$1 for update of t,o`,[id]);
}

async function components(db:DB,t:{group_id?:string|null;content?:unknown}) {
  if(!t.group_id) {
    const parsed=t.content?templateSchema.safeParse(t.content):null;
    if(parsed?.success) {
      if(parsed.data.components?.length) {
        return parsed.data.components.map(c=>typeof c==="string"?{id:c,code:componentLabels[c]??c}:c);
      }
      const compIds=[
        ...parsed.data.checks.map(c=>c.component).filter((c):c is string=>Boolean(c)),
        ...(parsed.data.shots??[]).map(s=>s.component).filter((c):c is string=>Boolean(c)),
      ];
      const unique=[...new Set(compIds)];
      if(unique.length>0 && !(unique.length===1 && unique[0]==="main")) {
        return unique.map(id=>({id,code:componentLabels[id]??id}));
      }
    }
    return [{id:"main",code:"Item"}];
  }
  const group=await one(db,"select * from inspection_groups where id=$1",[t.group_id]);
  const members=(await db.query<{id:string;code:string}>(`select w.id,w.code from group_members m
    join order_line_item_links a on a.id=m.assignment_id join warehouse_items w on w.id=a.item_id
    where m.group_id=$1 order by w.code`,[t.group_id])).rows;
  if(group.reference_id) {
    const r=await one<{id:string;code:string}>(db,`select w.id,w.code from reference_samples r join warehouse_items w on w.id=r.item_id where r.id=$1`,[group.reference_id]);
    members.push(r);
  }
  return members;
}

export type MissingCompletenessItem = {
  sample_id:string;
  component:string;
  kind:"measurement"|"photo"|"observation"|"order_photo";
  code:string;
  label:string;
  hint:string;
};

async function evaluateCompleteness(
  db:DB,
  t:{id?:string;group_id?:string|null;content?:unknown;line_attributes?:unknown;declared_fields?:unknown}&Record<string,any>
):Promise<{ok:boolean;missing:MissingCompletenessItem[]}> {
  const template=templateSchema.parse(t.content);
  const members=await components(db,t);
  const attrs:Record<string,unknown>={
    ...(typeof t.line_attributes==="object"&&t.line_attributes?t.line_attributes as Record<string,unknown>:{}),
    ...(typeof t.declared_fields==="object"&&t.declared_fields?t.declared_fields as Record<string,unknown>:{}),
  };
  const allResults=(await db.query<{
    id:string;item_key:string;component:string;attempt:number;status:string;
    typed_value:unknown;unit:string|null;reason:string|null;details:Record<string,unknown>|null;
    is_final:boolean;has_evidence:boolean;
  }>(`select r.*,
    exists(
      select 1 from media_assets m
      where m.status='ready' and (
        m.result_id=r.id
        or (m.task_id=r.task_id and coalesce(m.component,r.component)=r.component and m.point_code=r.item_key)
        or m.result_id in (
          select r2.id from inspection_results r2
          where r2.task_id=r.task_id and r2.item_key=r.item_key and r2.component=r.component
        )
      )
    ) has_evidence
    from inspection_results r where r.task_id=$1 order by r.component,r.item_key,r.attempt`,[t.id])).rows;

  const readyShots=(await db.query<{id:string;component:string|null;shot_code:string|null}>(
    `select id,component,shot_code from media_assets where task_id=$1 and status='ready' and shot_code is not null`,
    [t.id]
  )).rows;

  const missing:MissingCompletenessItem[]=[];

  for(const member of members) {
    for(const c of template.checks) {
      if(!t.group_id && c.component && c.component!==member.id) continue;
      const applicable=conditionMatches(c.applies_if,attrs) && conditionMatches(c.required_if,attrs);
      if(!applicable) continue;

      const attempts=allResults.filter(r=>r.component===member.id && r.item_key===c.key);
      const finalResult=attempts.find(r=>r.is_final);
      const itemKind=c.type==="number"?"measurement":"observation";

      if(c.required && (!finalResult || finalResult.status==="BLOCKED")) {
        missing.push({
          sample_id:member.code,
          component:member.id,
          kind:itemKind,
          code:c.key,
          label:c.label,
          hint:finalResult?.status==="BLOCKED"
            ?`Blocked check ${c.label} (${member.code}) must be resolved before submission.`
            :`Complete ${c.label} for ${member.code}.`,
        });
        continue;
      }
      if(!finalResult) continue;

      if(c.type==="number" && finalResult.status==="RECORDED") {
        if(c.unit && finalResult.unit!==c.unit) {
          missing.push({
            sample_id:member.code,
            component:member.id,
            kind:"measurement",
            code:c.key,
            label:c.label,
            hint:`Unit for ${c.label} (${member.code}) must be ${c.unit}.`,
          });
        }
        const recordedAttempts=attempts.filter(a=>a.status==="RECORDED" && typeof a.typed_value==="number");
        const threshold=checkThreshold(c,template.measurement_policy);
        if(template.measurement_policy && template.measurement_policy.attempts>=2 && recordedAttempts.length<2) {
          missing.push({
            sample_id:member.code,
            component:member.id,
            kind:"measurement",
            code:c.key,
            label:c.label,
            hint:`Record at least ${template.measurement_policy.attempts} measurement attempts for ${c.label} (${member.code}).`,
          });
        } else if(threshold!==undefined && recordedAttempts.length===2) {
          const diff=roundMetric(Math.abs(Number(recordedAttempts[0].typed_value)-Number(recordedAttempts[1].typed_value)));
          if(diff>threshold) {
            missing.push({
              sample_id:member.code,
              component:member.id,
              kind:"measurement",
              code:c.key,
              label:c.label,
              hint:`Two attempts for ${c.label} (${member.code}) differ by ${diff}${c.unit??""} (> ${threshold}${c.unit??""}); a 3rd attempt is required.`,
            });
          }
        } else if(threshold!==undefined && recordedAttempts.length>=3) {
          const [a1,a2,a3]=recordedAttempts;
          const d12=roundMetric(Math.abs(Number(a1.typed_value)-Number(a2.typed_value)));
          const d13=roundMetric(Math.abs(Number(a1.typed_value)-Number(a3.typed_value)));
          const d23=roundMetric(Math.abs(Number(a2.typed_value)-Number(a3.typed_value)));
          const minDiff=Math.min(d12,d13,d23);
          const note=finalResult.reason?.trim() || (typeof finalResult.details?.note==="string"?finalResult.details.note.trim():"");
          if(minDiff>threshold && !note) {
            missing.push({
              sample_id:member.code,
              component:member.id,
              kind:"measurement",
              code:c.key,
              label:c.label,
              hint:`All 3 attempts for ${c.label} (${member.code}) exceed threshold ${threshold}${c.unit??""}; an uncertain measurement note is required.`,
            });
          }
        }
      }

      if(finalResult.status==="OBSERVED_ISSUE") {
        if(!finalResult.has_evidence) {
          missing.push({
            sample_id:member.code,
            component:member.id,
            kind:"photo",
            code:c.key,
            label:c.label,
            hint:`Attach evidence photo for observed issue on ${c.label} (${member.code}).`,
          });
        }
        const note=finalResult.reason?.trim() || (typeof finalResult.details?.note==="string"?finalResult.details.note.trim():"");
        if(!note) {
          missing.push({
            sample_id:member.code,
            component:member.id,
            kind:"observation",
            code:c.key,
            label:c.label,
            hint:`Describe the observed issue for ${c.label} (${member.code}).`,
          });
        }
      } else if(c.evidence && finalResult.status==="RECORDED" && !finalResult.has_evidence) {
        missing.push({
          sample_id:member.code,
          component:member.id,
          kind:"photo",
          code:c.key,
          label:c.label,
          hint:`Attach required evidence photo for ${c.label} (${member.code}).`,
        });
      }
    }

    for(const shot of template.shots??[]) {
      if(!t.group_id && shot.component && shot.component!==member.id) continue;
      const required=shot.required && conditionMatches(shot.required_if,attrs);
      if(!required) continue;
      const hasShot=readyShots.some(s=>s.shot_code===shot.code && (s.component??"main")===member.id);
      if(!hasShot) {
        missing.push({
          sample_id:member.code,
          component:member.id,
          kind:"photo",
          code:shot.code,
          label:shot.name,
          hint:`Missing required shot ${shot.name} (${shot.code}) for ${member.code}.`,
        });
      }
    }
  }

  if(t.group_id && template.order_shots?.length) {
    for(const code of template.order_shots) {
      const hasOrderShot=readyShots.some(s=>s.shot_code===code && ["group","order","main",null].includes(s.component));
      if(!hasOrderShot) {
        missing.push({
          sample_id:"group",
          component:"group",
          kind:"order_photo",
          code,
          label:code,
          hint:`Missing comparison group shot ${code}.`,
        });
      }
    }
  }

  return {ok:missing.length===0,missing};
}

export async function checkTaskCompleteness(db:DB,actor:Actor,id:string) {
  role(actor,"inspector","reviewer","warehouse_admin");
  const t=await one(db,`select t.id,t.revision,t.group_id,t.template_version_id,v.content,
    l.attributes line_attributes,e.declared_fields
    from inspection_tasks t join template_versions v on v.id=t.template_version_id
    join order_lines l on l.id=t.order_line_id
    left join order_line_item_links a on a.id=t.assignment_id
    left join expected_items e on e.id=a.expected_item_id
    where t.id=$1`,[id]);
  const res=await evaluateCompleteness(db,t);
  return {task_id:t.id,revision:t.revision,...res};
}

export async function findInspectionTaskByScan(db:DB,actor:Actor,input:{code:string;order_id?:string|null}) {
  role(actor,"inspector","reviewer","warehouse_admin");
  const normalized=input.code.trim().toUpperCase();
  const row=(await db.query<{
    task_id:string;state:string;revision:number;order_id:string;public_no:string;item_code:string|null;
  }>(`select t.id task_id,t.state,t.revision,o.id order_id,o.public_no,w.code item_code
    from inspection_tasks t
    join order_lines l on l.id=t.order_line_id
    join orders o on o.id=l.order_id
    left join order_line_item_links a on a.id=t.assignment_id
    left join warehouse_items w on w.id=a.item_id
    where t.state<>'VOID'
      and ($2::uuid is null or o.id=$2)
      and (
        upper(w.code)=$1
        or o.public_no=$1
        or exists(
          select 1 from group_members gm
          join order_line_item_links ga on ga.id=gm.assignment_id
          join warehouse_items gw on gw.id=ga.item_id
          where gm.group_id=t.group_id and upper(gw.code)=$1
        )
      )
    order by case when t.state='IN_PROGRESS' then 0 when t.state='READY' then 1 else 2 end, t.id limit 1`,
    [normalized,input.order_id??null])).rows[0];
  guard(row,"NOT_FOUND","No matching inspection task found for this code.",404);
  return row;
}

export async function taskDetail(db:DB,actor:Actor,id:string) {
  role(actor,"inspector","reviewer","warehouse_admin");
  const t=await one(db,`select t.id,t.state,t.revision,t.assignee_id,t.group_id,t.template_version_id,v.content,
    o.public_no,o.id order_id,o.revision order_revision,o.state order_state,o.sla_due_at,o.samples_ready_at,
    l.attributes line_attributes,e.declared_fields,e.position expected_position,
    w.id item_id,w.code item_code,st.code service,
    case when o.state='inspecting' then (select ae.after->>'reason' from reports r
      join report_versions rv on rv.report_id=r.id and rv.state='draft'
      join audit_events ae on ae.entity_id=rv.id and ae.entity_type='report_versions' and ae.action='return_report'
      where r.order_id=o.id order by rv.version desc limit 1) end review_feedback
    from inspection_tasks t join template_versions v on v.id=t.template_version_id join order_lines l on l.id=t.order_line_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    join orders o on o.id=l.order_id left join order_line_item_links a on a.id=t.assignment_id
    left join expected_items e on e.id=a.expected_item_id
    left join warehouse_items w on w.id=a.item_id where t.id=$1`,[id]);
  const siblingTasks=(await db.query(`select t2.id,t2.state,t2.revision,t2.assignee_id,w2.id item_id,w2.code item_code,e2.position
    from inspection_tasks t2 join order_lines l2 on l2.id=t2.order_line_id
    left join order_line_item_links a2 on a2.id=t2.assignment_id
    left join warehouse_items w2 on w2.id=a2.item_id
    left join expected_items e2 on e2.id=a2.expected_item_id
    where l2.order_id=$1 and t2.state<>'VOID'
    order by l2.id,e2.position nulls last,w2.code nulls last,t2.id`,[t.order_id])).rows;
  const shots=(await db.query(`select id,component,shot_code,point_code,sha256,created_at
    from media_assets where task_id=$1 and status='ready' and (shot_code is not null or point_code is not null)
    order by created_at,id`,[id])).rows;
  const stepTimings=(await db.query(`select id,step_code,operator_id,started_at,ended_at,seconds
    from step_timings where order_id=$1 order by started_at desc,id desc limit 50`,[t.order_id])).rows;
  const completeness=await evaluateCompleteness(db,t);
  return {
    ...t,
    components:await components(db,t),
    sibling_tasks:siblingTasks,
    shots,
    step_timings:stepTimings,
    completeness,
    results:(await db.query(`select r.*,array(select m.id from media_assets m where m.result_id=r.id order by m.id) evidence_ids
      from inspection_results r where r.task_id=$1 order by r.item_key,r.component,r.attempt`,[id])).rows,
  };
}
function dto(t:{id:string;state:string;revision:number;template_version_id:string}) {
  return {id:t.id,state:t.state,revision:t.revision,template_version_id:t.template_version_id};
}
export async function startTask(db:DB,actor:Actor,id:string,rev:number) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,rev);
  const blocked=(await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null limit 1",[t.order_id])).rowCount;
  guard(t.state==="READY" && ["queued","inspecting"].includes(t.order_state) && !blocked,"TASK_UNAVAILABLE","The task is already claimed or blocked.");
  const ref=(await db.query(`select r.id from inspection_groups g join reference_samples r on r.id=g.reference_id
    where g.id=$1 and (r.state<>'active' or r.expires_at<=now())`,[t.group_id])).rowCount;
  guard(!ref,"REFERENCE_UNAVAILABLE","The reference sample is no longer active.");
  const updated=await one<{id:string;state:string;revision:number;template_version_id:string}>(db,`update inspection_tasks
    set state='IN_PROGRESS',assignee_id=$2,revision=revision+1 where id=$1 returning *`,[id,actor.id]);
  await db.query("update orders set state='inspecting',revision=revision+1 where id=$1 and state='queued'",[t.order_id]);
  const attrs:Record<string,unknown>={
    ...(typeof t.line_attributes==="object"&&t.line_attributes?t.line_attributes as Record<string,unknown>:{}),
    ...(typeof t.declared_fields==="object"&&t.declared_fields?t.declared_fields as Record<string,unknown>:{}),
  };
  const template=templateSchema.parse(t.content);
  const members=await components(db,t);
  for(const member of members) {
    for(const c of template.checks) {
      if(!t.group_id && c.component && c.component!==member.id) continue;
      const applicable=conditionMatches(c.applies_if,attrs) && conditionMatches(c.required_if,attrs);
      if(!applicable) {
        await db.query(`insert into inspection_results(task_id,item_key,component,attempt,status,typed_value,unit,method,reason,is_final,recorded_by)
          values($1,$2,$3,1,'NOT_APPLICABLE',null,null,$4,'Not applicable for item attributes',true,$5)
          on conflict(task_id,item_key,component,attempt) do nothing`,
          [id,c.key,member.id,c.method,actor.id]);
      }
    }
  }
  await audit(db,actor,"start_task","inspection_tasks",id);
  return dto(updated);
}
export async function recordResults(db:DB,actor:Actor,id:string,rev:number,results:ResultInput[]) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,rev);
  guard(t.state==="IN_PROGRESS" && t.assignee_id===actor.id && t.order_state==="inspecting","TASK_UNAVAILABLE","This task is not assigned to you.");
  const template=templateSchema.parse(t.content),members=await components(db,t);
  guard(results.length<=300,"RESULT_LIMIT","Save fewer results at once.",422);
  const touchedKeys=new Set<string>();
  for(const value of results) {
    const check=template.checks.find(c=>c.key===value.item_key);
    const componentAllowed=members.some(m=>m.id===value.component) && (Boolean(t.group_id) || !check?.component || check.component===value.component);
    guard(check && componentAllowed && check.method===value.method,"RESULT_INVALID","Check, item, and method must match the template.",422);
    if(value.status==="RECORDED") {
      guard(typeof value.typed_value===check.type && (check.unit??undefined)===(value.unit??undefined),"RESULT_INVALID","Enter the configured value type and unit.",422);
    }
    if(["NOT_TESTED","NOT_APPLICABLE","BLOCKED"].includes(value.status)) {
      guard(value.typed_value==null && Boolean(value.reason?.trim()),"RESULT_INVALID","Provide a reason when a check is not tested, not applicable, or blocked.",422);
    }
    if(value.status==="OBSERVED_ISSUE") {
      const note=value.reason?.trim() || (typeof value.details?.note==="string"?value.details.note.trim():"");
      guard(value.evidence_ids?.length && (note || value.details),"EVIDENCE_REQUIRED","Describe the issue and attach evidence.",422);
      if(value.details?.severity!==undefined) {
        guard(["attention","material_issue","uncertain"].includes(String(value.details.severity)),"RESULT_INVALID","Invalid issue severity.",422);
      }
      if(check.parts?.length) {
        const partCode=typeof value.details?.part_code==="string"?value.details.part_code:"";
        const severity=typeof value.details?.severity==="string"?value.details.severity:"";
        guard(["attention","material_issue","uncertain"].includes(severity) && check.parts.includes(partCode),
          "RESULT_INVALID","Observed issue requires valid severity and part_code from template parts.",422);
      }
    }
    const detailsObj:Record<string,unknown>={...(value.details??{})};
    if(value.status==="RECORDED" && check.type==="number" && typeof value.typed_value==="number") {
      if(check.derived?.circumference_cm==="value*2" || (check.key.endsWith("_flat") && check.unit==="cm")) {
        detailsObj.derived_circumference=Math.round(value.typed_value*2*100)/100;
      }
    }
    const serializedDetails=Object.keys(detailsObj).length>0?detailsObj:null;
    if(value.is_final) await db.query("update inspection_results set is_final=false where task_id=$1 and item_key=$2 and component=$3 and is_final",[id,value.item_key,value.component]);
    const r=await one<{id:string}>(db,`insert into inspection_results(task_id,item_key,component,attempt,status,typed_value,unit,method,reason,details,is_final,recorded_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict(task_id,item_key,component,attempt) do update set status=excluded.status,typed_value=excluded.typed_value,unit=excluded.unit,
      method=excluded.method,reason=excluded.reason,details=excluded.details,is_final=excluded.is_final,recorded_by=excluded.recorded_by,recorded_at=now()
      returning id`,[id,value.item_key,value.component,value.attempt,value.status,value.typed_value==null?null:JSON.stringify(value.typed_value),
      value.unit??null,value.method,value.reason??null,serializedDetails,value.is_final,actor.id]);
    if(value.evidence_ids?.length) {
      await attachEvidence(db,actor,value.evidence_ids,"shot",{org:t.org_id,task:id});
      const crossComp=(await db.query(
        `select 1 from media_assets where id=any($1::uuid[]) and component is not null and component<>$2`,
        [value.evidence_ids,value.component]
      )).rowCount;
      guard(!crossComp,"EVIDENCE_MISMATCH","A single photo cannot be reused across different components.");
      await db.query(
        `update media_assets
         set result_id=$2,
             component=$3,
             point_code=coalesce(point_code, case when $4='number' then $5 else null end)
         where id=any($1::uuid[])
           and (result_id is null or result_id=$2 or result_id in (
             select id from inspection_results where task_id=$6 and item_key=$5 and component=$3
           ))`,
        [value.evidence_ids,r.id,value.component,check.type,value.item_key,id]
      );
      const attached=await one<{n:number}>(db,"select count(*)::int n from media_assets where id=any($1::uuid[]) and result_id=$2",[value.evidence_ids,r.id]);
      guard(attached.n===value.evidence_ids.length,"EVIDENCE_MISMATCH","Evidence is already assigned to another result.");
    }
    if(check.type==="number") {
      touchedKeys.add(value.item_key+"::"+value.component);
    }
  }

  for(const keyPair of touchedKeys) {
    const [itemKey,comp]=keyPair.split("::");
    const check=template.checks.find(c=>c.key===itemKey);
    if(!check || check.type!=="number") continue;
    const threshold=checkThreshold(check,template.measurement_policy);
    if(threshold===undefined) continue;
    const attempts=(await db.query<{
      id:string;attempt:number;status:string;typed_value:unknown;reason:string|null;details:Record<string,unknown>|null;is_final:boolean;
    }>(`select id,attempt,status,typed_value,reason,details,is_final
      from inspection_results
      where task_id=$1 and item_key=$2 and component=$3 and status='RECORDED'
      order by attempt asc`,[id,itemKey,comp])).rows.filter(a=>typeof a.typed_value==="number");

    if(attempts.length===2) {
      const [a1,a2]=attempts;
      const diff=roundMetric(Math.abs(Number(a1.typed_value)-Number(a2.typed_value)));
      if(diff<=threshold) {
        await db.query("update inspection_results set is_final=(id=$2) where task_id=$1 and item_key=$3 and component=$4",[id,a1.id,itemKey,comp]);
        await db.query(`update media_assets set result_id=$1 where result_id=$2 and not exists(select 1 from media_assets m2 where m2.result_id=$1)`,[a1.id,a2.id]);
      } else {
        const nextDetails={...(a2.details??{}),retry_required:true,diff,threshold};
        await db.query("update inspection_results set details=$2 where id=$1",[a2.id,nextDetails]);
      }
    } else if(attempts.length>=3) {
      const [a1,a2,a3]=attempts;
      const d12=roundMetric(Math.abs(Number(a1.typed_value)-Number(a2.typed_value)));
      const d13=roundMetric(Math.abs(Number(a1.typed_value)-Number(a3.typed_value)));
      const d23=roundMetric(Math.abs(Number(a2.typed_value)-Number(a3.typed_value)));
      const minDiff=Math.min(d12,d13,d23);
      let winner=a1;
      let uncertain=false;
      if(minDiff<=threshold) {
        if(d12===minDiff) winner=a1;
        else if(d13===minDiff) winner=a1;
        else winner=a2;
      } else {
        uncertain=true;
        const sorted=[a1,a2,a3].slice().sort((x,y)=>Number(x.typed_value)-Number(y.typed_value) || x.attempt-y.attempt);
        winner=sorted[1];
      }
      const fallbackReason=winner.reason?.trim() || a3.reason?.trim() || a2.reason?.trim() || a1.reason?.trim() || null;
      const mergedDetails:Record<string,unknown>={
        ...(winner.details??{}),
        ...(uncertain?{uncertain:true,median_selected:true,min_diff:minDiff,threshold}:{retry_required:false,min_diff:minDiff,threshold}),
      };
      await db.query("update inspection_results set is_final=false where task_id=$1 and item_key=$2 and component=$3",[id,itemKey,comp]);
      await db.query("update inspection_results set is_final=true,reason=$2,details=$3 where id=$1",[winner.id,fallbackReason,mergedDetails]);
      await db.query(
        `update media_assets set result_id=$1
         where result_id in ($2,$3,$4)
           and not exists(select 1 from media_assets m2 where m2.result_id=$1)`,
        [winner.id,a1.id,a2.id,a3.id]
      );
    }
  }

  await db.query("update inspection_tasks set revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"record_results","inspection_tasks",id,{count:results.length});
  return dto({...t,revision:t.revision+1} as Parameters<typeof dto>[0]);
}

export async function recordTaskShot(
  db:DB,
  actor:Actor,
  id:string,
  input:{revision:number;component:string;shot_code:string;media_id:string}
) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,input.revision);
  guard(t.state==="IN_PROGRESS" && t.assignee_id===actor.id && t.order_state==="inspecting","TASK_UNAVAILABLE","This task is not assigned to you.");
  const template=templateSchema.parse(t.content),members=await components(db,t);
  const isOrderShot=Boolean(t.group_id && template.order_shots?.includes(input.shot_code) && ["group","order","main"].includes(input.component));
  const shotDef=template.shots?.find(s=>s.code===input.shot_code);
  const validComponent=isOrderShot || (Boolean(shotDef) && members.some(m=>m.id===input.component) && (!shotDef?.component || Boolean(t.group_id) || shotDef.component===input.component));
  guard(validComponent,"RESULT_INVALID","Shot code and component must match the template.",422);

  await attachEvidence(db,actor,[input.media_id],"shot",{org:t.org_id,task:id});
  const conflict=(await db.query(
    `select 1 from media_assets
     where id=$1 and (
       result_id is not null
       or (component is not null and component<>$2)
       or (shot_code is not null and shot_code<>$3)
     )`,
    [input.media_id,input.component,input.shot_code]
  )).rowCount;
  guard(!conflict,"EVIDENCE_MISMATCH","This photo is already bound to another component, shot, or result.");

  await db.query(
    `update media_assets set component=$2,shot_code=$3 where id=$1 and task_id=$4`,
    [input.media_id,input.component,input.shot_code,id]
  );
  await db.query("update inspection_tasks set revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"record_task_shot","inspection_tasks",id,{component:input.component,shot_code:input.shot_code,media_id:input.media_id});
  return dto({...t,revision:t.revision+1} as Parameters<typeof dto>[0]);
}

export async function recordTaskStep(
  db:DB,
  actor:Actor,
  id:string,
  input:{step_code:"prep"|"measure"|"visual"|"compare"|"qa_review";action?:("start"|"stop"|"record");started_at?:string;ended_at?:string;seconds?:number}
) {
  role(actor,"inspector","reviewer","warehouse_admin");
  const t=await one<{id:string;order_id:string}>(db,
    `select t.id,l.order_id from inspection_tasks t join order_lines l on l.id=t.order_line_id where t.id=$1`,
    [id]
  );
  const act=input.action ?? (input.seconds!==undefined || input.ended_at ? "record" : "start");
  if(act==="start") {
    await db.query(
      `update step_timings set ended_at=now() where order_id=$1 and operator_id=$2 and step_code=$3 and ended_at is null`,
      [t.order_id,actor.id,input.step_code]
    );
    const row=await one<{id:string;step_code:string;started_at:Date;ended_at:Date|null;seconds:number|null}>(db,
      `insert into step_timings(id,order_id,step_code,operator_id,started_at)
       values($1,$2,$3,$4,coalesce($5::timestamptz,now()))
       returning id,step_code,started_at,ended_at,seconds`,
      [uuid(),t.order_id,input.step_code,actor.id,input.started_at??null]
    );
    return row;
  }
  if(act==="stop") {
    const open=(await db.query<{id:string}>(
      `select id from step_timings where order_id=$1 and operator_id=$2 and step_code=$3 and ended_at is null order by started_at desc limit 1`,
      [t.order_id,actor.id,input.step_code]
    )).rows[0];
    if(open) {
      return one<{id:string;step_code:string;started_at:Date;ended_at:Date|null;seconds:number|null}>(db,
        `update step_timings set ended_at=coalesce($2::timestamptz,now()) where id=$1 returning id,step_code,started_at,ended_at,seconds`,
        [open.id,input.ended_at??null]
      );
    }
  }
  const secs=Math.max(1,Math.min(86400,Math.round(input.seconds??60)));
  const row=await one<{id:string;step_code:string;started_at:Date;ended_at:Date|null;seconds:number|null}>(db,
    `insert into step_timings(id,order_id,step_code,operator_id,started_at,ended_at)
     values($1,$2,$3,$4,now()-($5::int * interval '1 second'),now())
     returning id,step_code,started_at,ended_at,seconds`,
    [uuid(),t.order_id,input.step_code,actor.id,secs]
  );
  return row;
}

export async function submitTask(db:DB,actor:Actor,id:string,rev:number) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,rev);
  guard(t.state==="IN_PROGRESS" && t.assignee_id===actor.id && t.order_state==="inspecting","TASK_UNAVAILABLE","This task is not assigned to you.");
  const comp=await evaluateCompleteness(db,t);
  guard(comp.ok,"INSPECTION_INCOMPLETE",comp.missing[0]?.hint ?? "Complete all required checks and photos before submitting.");
  await db.query("update inspection_tasks set state='SUBMITTED',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"submit_task","inspection_tasks",id);
  return dto({...t,state:"SUBMITTED",revision:t.revision+1} as Parameters<typeof dto>[0]);
}
export async function submitReport(db:DB,actor:Actor,id:string,rev:number,ids:string[]) {
  role(actor,"inspector");
  const initial=await one(db,"select org_id from orders where id=$1",[id]);
  await lock(db,"org:"+initial.org_id);
  const o=await one(db,"select * from orders where id=$1 for update",[id]);
  revision(o.revision,rev);
  guard(o.state==="inspecting","REPORT_UNAVAILABLE","The order is not ready for report submission.");
  const tasks=(await db.query(`select t.*,st.code service,so.title,v.content
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join template_versions v on v.id=t.template_version_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id where l.order_id=$1 and t.state<>'VOID' order by t.id`,[id])).rows;
  guard(tasks.length===new Set(ids).size && tasks.every(t=>t.state==="SUBMITTED" && ids.includes(t.id)) &&
    tasks.some(t=>t.assignee_id===actor.id),"REPORT_INCOMPLETE","All commissioned tasks must be submitted before review.");
  const sections=[];
  for(const t of tasks) {
    const template=templateSchema.parse(t.content);
    const rows=(await db.query(`select r.item_key,r.component,r.status,r.typed_value,r.unit,r.method,r.reason,
      array(select m.id from media_assets m where m.result_id=r.id and m.status='ready' order by m.id) evidence_ids
      from inspection_results r where r.task_id=$1 and r.is_final order by r.component,r.item_key`,[t.id])).rows;
    const members=await components(db,t);
    const single=t.assignment_id?await one<{code:string}>(db,`select w.code from warehouse_items w join order_line_item_links a on a.item_id=w.id where a.id=$1`,[t.assignment_id]):null;
    sections.push({task_id:t.id,template_version_id:t.template_version_id,title:t.title.en,service:t.service,inspector_id:t.assignee_id,
      results:rows.map(r=>({...r,label:template.checks.find(c=>c.key===r.item_key)?.label??r.item_key,item:single?.code??members.find(m=>m.id===r.component)?.code??r.component}))});
  }
  const report=(await db.query("select * from reports where order_id=$1 for update",[id])).rows[0] ??
    await one(db,"insert into reports(id,order_id,public_no) values($1,$2,$3) returning *",[uuid(),id,code("R-")]);
  const version=await one<{n:number}>(db,"select coalesce(max(version),0)::int+1 n from report_versions where report_id=$1",[report.id]);
  const v=await one(db,`insert into report_versions(id,report_id,version,state,snapshot,created_by)
    values($1,$2,$3,'submitted',$4,$5) returning id,version,state`,
    [uuid(),report.id,version.n,{order_no:o.public_no,report_no:report.public_no,quote_id:o.submission_snapshot.quote_id,sections},actor.id]);
  await db.query("update orders set state='qa_review',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"submit_report","report_versions",v.id);
  return v;
}
async function reviewTarget(db:DB,actor:Actor,id:string,rev:number) {
  role(actor,"reviewer","super_admin");
  const first=await one(db,`select o.org_id from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id where v.id=$1`,[id]);
  await lock(db,"org:"+first.org_id);
  const v=await one(db,`select v.*,o.id order_id,o.state order_state,r.published_version from report_versions v join reports r on r.id=v.report_id
    join orders o on o.id=r.order_id where v.id=$1 for update of v,r,o`,[id]);
  revision(v.revision,rev);
  guard(v.state==="submitted"&&(v.snapshot.amends_version?v.snapshot.amends_version===v.published_version:v.order_state==="qa_review"),
    "REPORT_UNAVAILABLE","This report is not waiting for review.");
  guard(v.created_by!==actor.id && v.snapshot.sections.every((s:{inspector_id:string})=>s.inspector_id!==actor.id),
    "SELF_REVIEW_FORBIDDEN","The reviewer must be independent.");
  return v;
}
export async function approveReport(db:DB,actor:Actor,id:string,rev:number,checklist:string[]) {
  const v=await reviewTarget(db,actor,id,rev);
  guard(checklist.includes("reviewed_en")&&checklist.includes("evidence_checked"),
    "REPORT_UNAVAILABLE","Confirm the English text and inspect the evidence before approval.");
  await db.query("update report_versions set state='qa_approved',reviewed_by=$2,reviewed_at=now(),revision=revision+1 where id=$1",[id,actor.id]);
  await event(db,"report.render",{version_id:id});
  await audit(db,actor,"approve_report","report_versions",id);
  return {id,version:v.version,state:"qa_approved"};
}
export async function returnReport(db:DB,actor:Actor,id:string,rev:number,reason:string) {
  const v=await reviewTarget(db,actor,id,rev);
  const message=reason.trim();
  guard(message.length>=4,"RETURN_REASON_REQUIRED","Describe the corrections the inspector needs to make.",422);
  if(v.snapshot.amends_version) {
    await db.query("update report_versions set state='draft',reviewed_by=null,reviewed_at=null,revision=revision+1 where id=$1",[id]);
    await audit(db,actor,"return_report","report_versions",id,{reason:message});
    return {id,version:v.version,state:"draft"};
  }
  guard(v.published_version===null,"REPORT_REVISION_REQUIRED","Use the revision workflow for a published report.");
  const taskIds=v.snapshot.sections.map((section:{task_id:string})=>section.task_id);
  const updated=await db.query(`update inspection_tasks t set state='IN_PROGRESS',revision=t.revision+1
    from order_lines l where l.id=t.order_line_id and l.order_id=$1 and t.id=any($2::uuid[]) and t.state='SUBMITTED'`,
    [v.order_id,taskIds]);
  guard(taskIds.length>0&&updated.rowCount===taskIds.length,"REPORT_UNAVAILABLE","The submitted tasks have changed. Reload the review.");
  await db.query("update report_versions set state='draft',reviewed_by=$2,reviewed_at=now(),revision=revision+1 where id=$1",[id,actor.id]);
  await db.query("update orders set state='inspecting',revision=revision+1 where id=$1",[v.order_id]);
  await audit(db,actor,"return_report","report_versions",id,{reason:message,task_count:taskIds.length});
  return {id,version:v.version,state:"draft"};
}
export const amendReportInput=z.object({base_version:z.number().int().positive(),reason:z.string().trim().min(4).max(1000)}).strict();
export const revisionChanges=z.object({
  revision:z.number().int().positive(),
  changes:z.array(z.object({
    section:z.number().int().nonnegative(),result:z.number().int().nonnegative(),
    status:z.enum(["RECORDED","OBSERVED_ISSUE","NOT_OBSERVED","NOT_TESTED","NOT_APPLICABLE"]),
    typed_value:z.union([z.number().finite(),z.boolean(),z.string().max(2000),z.null()]),
    reason:z.string().trim().max(2000),
  }).strict()).min(1).max(300),
}).strict();
async function revisionTarget(db:DB,actor:Actor,id:string) {
  role(actor,...staffAccess.reportEditing);
  const first=await one(db,`select o.org_id from report_versions v join reports r on r.id=v.report_id
    join orders o on o.id=r.order_id where v.id=$1`,[id]);
  await lock(db,"org:"+first.org_id);
  return one(db,`select v.*,r.order_id,r.published_version,o.state order_state from report_versions v
    join reports r on r.id=v.report_id join orders o on o.id=r.order_id where v.id=$1 for update of v,r,o`,[id]);
}
export async function reportDesk(db:DB,actor:Actor,order:string|null) {
  role(actor,...staffAccess.reportEditing);
  const {rows}=await db.query(`select v.id,v.report_id,v.version,v.state,v.revision,v.amend_reason,v.created_by,
    v.created_at,o.public_no,r.published_version,v.snapshot->>'amends_version' amends_version
    from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
    where ($1::text is null or o.public_no=$1) and (v.state in ('submitted','qa_approved','published')
      or v.state='draft' and v.snapshot ? 'amends_version')
    order by v.created_at desc,v.id limit 100`,[order]);
  return {rows};
}
export async function staffReport(db:DB,actor:Actor,id:string) {
  role(actor,...staffAccess.reportEditing);
  const version=await one(db,`select v.id,v.report_id,v.version,v.state,v.revision,v.snapshot,v.amend_reason,v.created_by,v.published_at,
    r.published_version,o.public_no,
    (select ae.after->>'reason' from audit_events ae where ae.entity_id=v.id and ae.entity_type='report_versions'
      and ae.action='return_report' order by ae.at desc,ae.id desc limit 1) review_feedback,
    base.snapshot base_snapshot
    from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
    left join report_versions base on base.report_id=r.id and base.version=(v.snapshot->>'amends_version')::int
    where v.id=$1`,[id]);
  const templates=(await db.query("select id,content from template_versions where id=any($1::uuid[])",
    [version.snapshot.sections.map((section:{template_version_id:string})=>section.template_version_id)])).rows;
  return {...version,field_types:Object.fromEntries(templates.map(t=>[t.id,
    Object.fromEntries(templateSchema.parse(t.content).checks.map(c=>[c.key,c.type]))]))};
}
export async function amendReport(db:DB,actor:Actor,id:string,input:z.infer<typeof amendReportInput>) {
  role(actor,...staffAccess.reportEditing);
  const initial=await one(db,"select org_id from orders where id=(select order_id from reports where id=$1)",[id]);
  await lock(db,"org:"+initial.org_id);
  const current=await one(db,`select v.* from reports r join report_versions v on v.report_id=r.id
    and v.version=r.published_version where r.id=$1 and v.state='published' for update of r,v`,[id]);
  guard(current.version===input.base_version,"VERSION_CONFLICT","Review the latest published report.");
  guard(!(await db.query(`select 1 from report_versions where report_id=$1 and state in ('draft','submitted','qa_approved')
    and snapshot ? 'amends_version'`,[id])).rowCount,"AMENDMENT_PENDING","This report already has a pending amendment.");
  const next=await one<{n:number}>(db,"select max(version)::int+1 n from report_versions where report_id=$1",[id]);
  const draft=await one(db,`insert into report_versions(id,report_id,version,state,snapshot,created_by,amend_reason)
    values($1,$2,$3,'draft',$4,$5,$6) returning id,version,state,revision`,
    [uuid(),id,next.n,{...current.snapshot,amends_version:current.version},actor.id,input.reason]);
  await audit(db,actor,"amend_report","report_versions",draft.id,{base_version:current.version});
  return draft;
}
export async function editReportRevision(db:DB,actor:Actor,id:string,input:z.infer<typeof revisionChanges>) {
  const v=await revisionTarget(db,actor,id);
  revision(v.revision,input.revision);
  guard(v.state==="draft"&&v.snapshot.amends_version&&v.created_by===actor.id,"REPORT_UNAVAILABLE","Only the amendment author can edit this draft.");
  guard(v.published_version===v.snapshot.amends_version,"VERSION_CONFLICT","The published report has changed.");
  const changed=new Set<string>();
  for(const edit of input.changes) {
    const key=edit.section+":"+edit.result;
    guard(!changed.has(key),"RESULT_INVALID","Save each result once per request.",422);changed.add(key);
    const section=v.snapshot.sections[edit.section],result=section?.results[edit.result];
    guard(result,"RESULT_INVALID","Select a result in this report.",422);
    const template=await one(db,"select content from template_versions where id=$1",[section.template_version_id]);
    const check=templateSchema.parse(template.content).checks.find(c=>c.key===result.item_key);
    guard(check,"RESULT_INVALID","The checkpoint is missing from its original template.",422);
    guard(edit.status!=="RECORDED"||typeof edit.typed_value===check.type,"RESULT_INVALID","Use the checkpoint's configured value type.",422);
    guard(!["NOT_TESTED","NOT_APPLICABLE","OBSERVED_ISSUE"].includes(edit.status)||edit.reason.length>=2,
      "RESULT_INVALID","Explain the observed issue or missing result.",422);
    guard(edit.status!=="OBSERVED_ISSUE"||result.evidence_ids.length>0,"EVIDENCE_REQUIRED","An observed issue requires supporting evidence.",422);
    Object.assign(result,{status:edit.status,typed_value:edit.status==="RECORDED"?edit.typed_value:null,reason:edit.reason||null});
  }
  await db.query("update report_versions set snapshot=$2,revision=revision+1 where id=$1",[id,v.snapshot]);
  await audit(db,actor,"edit_report_revision","report_versions",id,{count:input.changes.length});
  return {id,revision:v.revision+1};
}
export async function submitReportRevision(db:DB,actor:Actor,id:string,rev:number) {
  const v=await revisionTarget(db,actor,id);
  revision(v.revision,rev);
  guard(v.state==="draft"&&v.snapshot.amends_version&&v.created_by===actor.id,"REPORT_UNAVAILABLE","Only the amendment author can submit this draft.");
  guard(v.published_version===v.snapshot.amends_version,"VERSION_CONFLICT","The published report has changed.");
  const base=await one(db,"select snapshot from report_versions where report_id=$1 and version=$2",[v.report_id,v.snapshot.amends_version]);
  guard(JSON.stringify(base.snapshot.sections)!==JSON.stringify(v.snapshot.sections),"AMENDMENT_UNCHANGED","Save the report corrections before submitting.");
  await db.query("update report_versions set state='submitted',revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"submit_revision","report_versions",id);
  return {id,revision:v.revision+1,state:"submitted"};
}
type ReportResult={item:string;label:string;status:string;typed_value:unknown;unit:string|null;reason:string|null;method:string;evidence_ids:string[]};
type Snapshot={order_no:string;report_no:string;quote_id:string;sections:{title:string;service:string;results:ReportResult[]}[]};
async function renderPDF(db:DB,org:string,snapshot:Snapshot,version:number,amendReason?:string) {
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`QC Warehouse ${snapshot.report_no}`);
  let page=doc.addPage([595,842]),y=790;
  const latin=(s:string)=>s.normalize("NFKD").replace(/[^\x20-\x7e]/g,"?");
  function print(s:string,size=10,strong=false) {
    const f=strong?bold:font;
    for(const line of latin(s).match(/.{1,94}/g)??[""]) {
      if(y<52) {page=doc.addPage([595,842]); y=790;}
      page.drawText(line,{x:45,y,size,font:f,color:rgb(.06,.13,.16)}); y-=size+6;
    }
  }
  const images=new Map<string,Awaited<ReturnType<typeof doc.embedJpg>>>();
  async function evidence(id:string) {
    let image=images.get(id);
    if(!image) {
      const file=await one<{data:Buffer}>(db,`select f.data from media_assets m join private_files f on f.key=m.object_key
        where m.id=$1 and m.org_id=$2 and m.kind='shot' and m.status='ready' and m.result_id is not null`,[id,org]);
      const preview=await sharp(file.data).resize({width:640,height:480,fit:"inside",withoutEnlargement:true}).jpeg({quality:76}).toBuffer();
      image=await doc.embedJpg(preview);
      images.set(id,image);
    }
    const scale=Math.min(220/image.width,144/image.height,1);
    const {width,height}=image.scale(scale);
    if(y-height<52) {page=doc.addPage([595,842]);y=790;}
    page.drawImage(image,{x:45,y:y-height,width,height});
    y-=height+10;
  }
  print("QC WAREHOUSE | INSPECTION REPORT",19,true);
  print(`${snapshot.report_no}   Version ${version}   Order ${snapshot.order_no}`,12);
  if(amendReason)print("Amendment: "+amendReason);
  print("Results relate to the inspected items and scope shown below.");y-=12;
  for(const s of snapshot.sections) {
    print(s.title,13,true);
    for(const r of s.results) {
      print(`${r.item} | ${r.label} | ${r.status} ${r.typed_value??""} ${r.unit??""} ${r.reason??""}`);
      for(const id of r.evidence_ids) await evidence(id);
    }
    y-=10;
  }
  return Buffer.from(await doc.save());
}
export async function publishReport(db:DB,id:string) {
  const first=await one(db,`select o.org_id from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id where v.id=$1`,[id]);
  await lock(db,"org:"+first.org_id);
  const v=await one(db,`select v.*,o.id order_id,o.state order_state,o.submission_snapshot, r.published_version
    from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id where v.id=$1 for update of v,r,o`,[id]);
  if(v.state!=="qa_approved")return;
  const amendment=v.snapshot.amends_version!==undefined;
  if(amendment)guard(v.snapshot.amends_version===v.published_version,"VERSION_CONFLICT","The published report has changed.");
  else if(v.order_state==="cancelled"||v.snapshot.quote_id!==v.submission_snapshot?.quote_id)return;
  guard((amendment||v.order_state==="qa_review") && !(await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null",[v.order_id])).rowCount,
    "REPORT_BLOCKED","Report is temporarily blocked.");
  const bytes=await renderPDF(db,first.org_id,v.snapshot,v.version,v.amend_reason);
  const key="reports/"+id+".pdf";
  await db.query("insert into private_files(key,data,mime) values($1,$2,'application/pdf')",[key,bytes]);
  if(v.published_version) await db.query("update report_versions set state='superseded' where report_id=$1 and version=$2 and state='published'",[v.report_id,v.published_version]);
  await db.query(`update report_versions set state='published',pdf_key=$2,pdf_sha256=$3,renderer_version='pdf-lib-v2',published_at=now(),revision=revision+1 where id=$1`,[id,key,hash(bytes)]);
  await db.query("update reports set published_version=$2,current_version=$2 where id=$1",[v.report_id,v.version]);
  if(!amendment) {
    await db.query(`update inspection_tasks t set state='QA_APPROVED',revision=t.revision+1 from order_lines l
      where t.order_line_id=l.id and l.order_id=$1 and t.state='SUBMITTED'`,[v.order_id]);
    await db.query(`update reference_reservations r set released_at=now() from inspection_groups g,order_lines l
      where r.group_id=g.id and g.order_line_id=l.id and l.order_id=$1 and r.released_at is null`,[v.order_id]);
    await db.query("update orders set state='report_ready',report_published_at=now(),revision=revision+1 where id=$1",[v.order_id]);
  }
  await audit(db,null,"publish_report","report_versions",id);
  await event(db,amendment?"report.amended":"report.published",{order_id:v.order_id,version:v.version});
}
export async function readReport(db:DB,actor:Actor,orderId:string,version?:number) {
  const org=organization(actor);
  return one(db,`select v.id,v.version,v.state,v.snapshot,v.published_at,v.pdf_key,v.amend_reason,
    (select jsonb_agg(jsonb_build_object('version',h.version,'state',h.state,'published_at',h.published_at,'amend_reason',h.amend_reason)
      order by h.version desc) from report_versions h where h.report_id=r.id and h.state in ('published','superseded')) versions
    from orders o join reports r on r.order_id=o.id join report_versions v on v.report_id=r.id
    where o.id=$1 and o.org_id=$2 and v.version=coalesce($3,r.published_version) and v.state in ('published','superseded')`,[orderId,org,version??null]);
}
