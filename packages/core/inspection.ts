import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { attachEvidence } from "./intake";
import { templateSchema } from "./orders";
import { staffAccess } from "./staff-access";

type ResultInput={item_key:string;component:string;attempt:number;status:string;method:string;is_final:boolean;typed_value?:unknown;unit?:string;reason?:string;evidence_ids?:string[];details?:Record<string,unknown>};

const FORBIDDEN_WORDING_PATTERNS:RegExp[]=[
  /\bcertified\b/i,
  /\bcertificate\b/i,
  /\blab\s+tested\b/i,
  /\blaboratory\b/i,
  /\b100\s*%/i,
  /\bdefect[- ]?free\b/i,
  /\baql\b/i,
  /\bauthentic\b/i,
  /\bgenuine\b/i,
  /\bcounterfeit\b/i,
  /\bfake\b/i,
  /\bguaranteed\b/i,
  /\bsafe\s+for\b/i,
  /\bnon[- ]?toxic\b/i,
  /\bhypoallergenic\b/i,
  /\bpassed\b/i,
  /\bfailed\b/i,
  /\bapproved\b/i,
  /\brejected\b/i,
  /\bbest\b/i,
  /\bworst\b/i,
  /\brecommend(?:ed|s)?\b/i,
  /ΔE/i,
  /\bdelta[- ]?e\b/i,
  /\bspectrophotometer\b/i,
  /\bopaque\b/i,
  /\bsquat[- ]?proof\b/i,
  /\bgsm\s*[:=]?\s*\d/i,
  /\b\d+\s*%\s*(cotton|nylon|polyester|spandex|elastane)\b/i,
];

const DEFAULT_NOT_INSPECTED=[
  "Fiber content or fabric composition",
  "Fabric weight (GSM)",
  "Chemical safety or restricted substances",
  "Colorfastness, shrinkage, or wash durability",
  "Formal abrasion or pilling resistance",
  "Elasticity recovery over time",
  "Brand authenticity or intellectual property status",
  "Regulatory or labeling compliance",
  "Comfort or fit on a body",
  "Quality of any production batch",
];

export function assertAllowedWording(...texts:(string|null|undefined)[]) {
  for(const raw of texts) {
    if(!raw) continue;
    for(const pattern of FORBIDDEN_WORDING_PATTERNS) {
      guard(!pattern.test(raw),"FORBIDDEN_WORDING",
        "Report text contains prohibited certification, grading, or laboratory claim wording.",422);
    }
  }
}

function hasUntranslatedChinese(text:string|null|undefined):boolean {
  if(!text) return false;
  return /[\u4e00-\u9fff]/.test(text);
}

type ToleranceRule={point_code:string;min?:number;max?:number;unit?:string};
function extractTolerances(options:unknown,attributes:unknown):ToleranceRule[] {
  const rules:ToleranceRule[]=[];
  for(const src of [options,attributes]) {
    if(!src || typeof src!=="object") continue;
    const raw=(src as Record<string,unknown>).customer_tolerance ?? (src as Record<string,unknown>).tolerances;
    if(Array.isArray(raw)) {
      for(const item of raw) {
        if(item && typeof item==="object" && typeof (item as Record<string,unknown>).point_code==="string") {
          rules.push({
            point_code:String((item as Record<string,unknown>).point_code),
            ...(typeof (item as Record<string,unknown>).min==="number"?{min:Number((item as Record<string,unknown>).min)}:{}),
            ...(typeof (item as Record<string,unknown>).max==="number"?{max:Number((item as Record<string,unknown>).max)}:{}),
            ...(typeof (item as Record<string,unknown>).unit==="string"?{unit:String((item as Record<string,unknown>).unit)}:{}),
          });
        }
      }
    }
  }
  return rules;
}

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
  const parsedTpl=templateSchema.parse(t.content);
  const attrs:Record<string,unknown>={
    ...(typeof t.line_attributes==="object"&&t.line_attributes?t.line_attributes as Record<string,unknown>:{}),
    ...(typeof t.declared_fields==="object"&&t.declared_fields?t.declared_fields as Record<string,unknown>:{}),
  };
  const filteredContent={
    ...parsedTpl,
    checks:parsedTpl.checks.filter(c=>conditionMatches(c.applies_if,attrs) && conditionMatches(c.required_if,attrs)),
    shots:(parsedTpl.shots??[]).filter(s=>conditionMatches(s.required_if,attrs)),
  };
  return {
    ...t,
    content:filteredContent,
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
      const expectedJsType=check.type==="text"?"string":check.type;
      guard(typeof value.typed_value===expectedJsType && (check.unit??undefined)===(value.unit??undefined),"RESULT_INVALID","Enter the configured value type and unit.",422);
    }
    if(["NOT_TESTED","NOT_APPLICABLE","BLOCKED"].includes(value.status)) {
      guard(value.typed_value==null && Boolean(value.reason?.trim()),"RESULT_INVALID","Provide a reason when a check is not tested, not applicable, or blocked.",422);
    }
    assertAllowedWording(
      value.reason,
      typeof value.typed_value==="string"?value.typed_value:null,
      typeof value.details?.note==="string"?value.details.note:null,
      typeof value.details?.note_en==="string"?value.details.note_en:null,
    );
    if(value.status==="OBSERVED_ISSUE") {
      const note=value.reason?.trim() || (typeof value.details?.note==="string"?value.details.note.trim():"");
      guard(value.evidence_ids?.length && (note || value.details),"EVIDENCE_REQUIRED","Describe the issue and attach evidence.",422);
      if(value.details?.severity!==undefined) {
        guard(["attention","material_issue","uncertain"].includes(String(value.details.severity)),"RESULT_INVALID","Invalid issue severity.",422);
      }
      if(check.parts?.length && (value.details?.part_code!==undefined || value.details?.severity!==undefined)) {
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
        await db.query("update inspection_results set is_final=false where task_id=$1 and item_key=$2 and component=$3 and is_final",[id,itemKey,comp]);
        await db.query("update inspection_results set is_final=true where id=$1",[a1.id]);
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
  const storedComponent=isOrderShot?"group":input.component;

  await attachEvidence(db,actor,[input.media_id],"shot",{org:t.org_id,task:id});
  const conflict=(await db.query(
    `select 1 from media_assets
     where id=$1 and (
       result_id is not null
       or (component is not null and component<>$2)
       or (shot_code is not null and shot_code<>$3)
     )`,
    [input.media_id,storedComponent,input.shot_code]
  )).rowCount;
  guard(!conflict,"EVIDENCE_MISMATCH","This photo is already bound to another component, shot, or result.");

  await db.query(
    `update media_assets set component=$2,shot_code=$3 where id=$1 and task_id=$4`,
    [input.media_id,storedComponent,input.shot_code,id]
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
  const unlinkedExpected=(await db.query(
    `select 1 from order_lines l join expected_items e on e.order_line_id=l.id
     where l.order_id=$1 and e.in_scope
       and not exists(select 1 from order_line_item_links a where a.expected_item_id=e.id and a.unlinked_at is null)
     limit 1`,
    [id]
  )).rowCount;
  guard(!unlinkedExpected,"REPORT_INCOMPLETE","All in-scope items must be linked and inspected before report submission.");
  const tasks=(await db.query(`select t.*,st.code service,so.title,v.content,l.options line_options,l.attributes line_attributes,
    (select count(*)::int from expected_items e where e.order_line_id=l.id and e.in_scope) expected_count
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join template_versions v on v.id=t.template_version_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id where l.order_id=$1 and t.state<>'VOID' order by t.id`,[id])).rows;
  guard(tasks.length===new Set(ids).size && tasks.every(t=>t.state==="SUBMITTED" && ids.includes(t.id)) &&
    tasks.some(t=>t.assignee_id===actor.id),"REPORT_INCOMPLETE","All commissioned tasks must be submitted before review.");
  const sections=[];
  for(const t of tasks) {
    const template=templateSchema.parse(t.content);
    const tolerances=extractTolerances(t.line_options,t.line_attributes);
    const rows=(await db.query(`select r.item_key,r.component,r.attempt,r.status,r.typed_value,r.unit,r.method,r.reason,r.details,
      r.recorded_by,u.display_name recorded_by_name,r.recorded_at,
      array(select m.id from media_assets m where m.result_id=r.id and m.status='ready' order by m.id) evidence_ids
      from inspection_results r
      left join users u on u.id=r.recorded_by
      where r.task_id=$1 and r.is_final
      order by r.component,r.item_key`,[t.id])).rows;
    const allAttempts=(await db.query(`select r.item_key,r.component,r.attempt,r.status,r.typed_value,r.unit,r.method,
      r.recorded_by,u.display_name recorded_by_name,r.recorded_at
      from inspection_results r
      left join users u on u.id=r.recorded_by
      where r.task_id=$1
      order by r.component,r.item_key,r.attempt`,[t.id])).rows;
    const members=await components(db,t);
    const single=t.assignment_id?await one<{code:string}>(db,`select w.code from warehouse_items w join order_line_item_links a on a.item_id=w.id where a.id=$1`,[t.assignment_id]):null;
    const mappedResults=rows.map(r=>{
      const check=template.checks.find(c=>c.key===r.item_key);
      const tol=tolerances.find(rule=>rule.point_code===r.item_key);
      const hasTolerance=Boolean(tol && (typeof tol.min==="number" || typeof tol.max==="number") && r.status==="RECORDED" && typeof r.typed_value==="number");
      const withinTolerance=hasTolerance
        ?((typeof tol!.min!=="number" || Number(r.typed_value)>=tol!.min) && (typeof tol!.max!=="number" || Number(r.typed_value)<=tol!.max))
        :undefined;
      const derivedCircumference=typeof r.details?.derived_circumference==="number"?r.details.derived_circumference:undefined;
      const englishReason=(typeof r.details?.note_en==="string" && r.details.note_en.trim())?r.details.note_en.trim():r.reason;
      const reasonZh=typeof r.reason==="string" && hasUntranslatedChinese(r.reason)?r.reason:(typeof r.details?.note_zh==="string"?r.details.note_zh:undefined);
      const typedValueZh=typeof r.typed_value==="string" && hasUntranslatedChinese(r.typed_value)
        ?r.typed_value
        :(typeof r.details?.typed_value_zh==="string"?r.details.typed_value_zh:undefined);
      const effectiveTypedValue=(typeof r.details?.typed_value_en==="string" && r.details.typed_value_en.trim())
        ?r.details.typed_value_en.trim()
        :r.typed_value;
      assertAllowedWording(englishReason,typeof effectiveTypedValue==="string"?effectiveTypedValue:null);
      const annotations=Array.isArray(r.details?.annotations)
        ?r.details.annotations
            .filter((a:unknown)=>a && typeof a==="object" && typeof (a as {x?:unknown}).x==="number" && typeof (a as {y?:unknown}).y==="number")
            .map((a:{x:number;y:number;w?:number;h?:number;label?:string;label_zh?:string})=>({
              ...a,
              ...(typeof a.label==="string" && hasUntranslatedChinese(a.label) && !a.label_zh?{label_zh:a.label}:{}),
            }))
        :undefined;
      const resultAttempts=allAttempts
        .filter(a=>a.component===r.component && a.item_key===r.item_key)
        .map(a=>({
          attempt:a.attempt,
          status:a.status,
          typed_value:a.typed_value,
          unit:a.unit,
          method:a.method,
          recorded_by:a.recorded_by,
          recorded_by_name:a.recorded_by_name??null,
          recorded_at:a.recorded_at?new Date(a.recorded_at).toISOString():null,
        }));
      return {
        item_key:r.item_key,
        component:r.component,
        status:r.status,
        typed_value:effectiveTypedValue,
        ...(typedValueZh?{typed_value_zh:typedValueZh}:{}),
        unit:r.unit,
        method:r.method,
        reason:englishReason,
        ...(reasonZh?{reason_zh:reasonZh}:{}),
        recorded_by:r.recorded_by??null,
        recorded_by_name:r.recorded_by_name??null,
        recorded_at:r.recorded_at?new Date(r.recorded_at).toISOString():null,
        ...(resultAttempts.length?{attempts:resultAttempts}:{}),
        evidence_ids:r.evidence_ids,
        label:check?.label??r.item_key,
        item:single?.code??members.find(m=>m.id===r.component)?.code??r.component,
        ...(derivedCircumference!==undefined?{derived_circumference:derivedCircumference}:{}),
        ...(withinTolerance!==undefined?{within_tolerance:withinTolerance}:{}),
        ...(r.details?.severity?{severity:r.details.severity}:{}),
        ...(r.details?.part_code?{part_code:r.details.part_code}:{}),
        ...(r.details?.uncertain?{uncertain:true}:{}),
        ...(annotations && annotations.length?{annotations}:{}),
      };
    });

    const orderShotCodes=t.group_id?(template.order_shots??[]):[];
    const sectionShots=(await db.query<{code:string;component:string|null;media_id:string}>(
      `select shot_code code,component,id media_id from media_assets
       where task_id=$1 and status='ready' and shot_code is not null
         and coalesce(component,'main') not in ('group','order')
         and not (shot_code = any($2::text[]))
       order by component nulls first,shot_code,id`,
      [t.id,orderShotCodes]
    )).rows.map(s=>({
      code:s.code,
      component:s.component??"main",
      item:single?.code??members.find(m=>m.id===s.component)?.code??s.component??"main",
      media_id:s.media_id,
    }));

    let comparison:{
      diffs:{point_code:string;label:string;unit:string|null;max_minus_min:number|null;display_diff:string}[];
      order_shots:{code:string;media_id:string}[];
    }|undefined;
    if(t.group_id) {
      const diffs=template.checks.filter(c=>c.type==="number").map(c=>{
        const memberRows=members.map(m=>mappedResults.find(r=>r.component===m.id && r.item_key===c.key));
        const allNumeric=memberRows.length>=2 && memberRows.every(r=>r && r.status==="RECORDED" && typeof r.typed_value==="number");
        if(!allNumeric) {
          return {point_code:c.key,label:c.label,unit:c.unit??null,max_minus_min:null,display_diff:"—"};
        }
        const nums=memberRows.map(r=>Number(r!.typed_value));
        const diff=roundMetric(Math.max(...nums)-Math.min(...nums));
        return {point_code:c.key,label:c.label,unit:c.unit??null,max_minus_min:diff,display_diff:String(diff)};
      });
      const orderShots=(await db.query<{code:string;media_id:string}>(
        `select shot_code code,id media_id from media_assets
         where task_id=$1 and status='ready' and shot_code is not null
           and (coalesce(component,'group') in ('group','order') or shot_code = any($2::text[]))
         order by shot_code,id`,
        [t.id,orderShotCodes]
      )).rows;
      comparison={diffs,order_shots:orderShots};
    }

    const issueCount=mappedResults.filter(r=>r.status==="OBSERVED_ISSUE").length;
    sections.push({
      task_id:t.id,
      order_line_id:t.order_line_id,
      template_version_id:t.template_version_id,
      title:t.title.en,
      service:t.service,
      inspector_id:t.assignee_id,
      measure_conditions:template.measure_conditions??"Garment laid flat on standard inspection table without stretching; steel tape calibrated to 0.1 cm.",
      ...(template.measurement_policy?{measurement_policy:template.measurement_policy}:{}),
      summary:{
        expected_count:t.group_id?members.length:1,
        checked_count:t.group_id?members.length:1,
        issue_count:issueCount,
      },
      ...(sectionShots.length?{shots:sectionShots}:{}),
      ...(comparison?{comparison}:{}),
      results:mappedResults,
    });
  }
  const report=(await db.query("select * from reports where order_id=$1 for update",[id])).rows[0] ??
    await one(db,"insert into reports(id,order_id,public_no) values($1,$2,$3) returning *",[uuid(),id,code("R-")]);
  const version=await one<{n:number}>(db,"select coalesce(max(version),0)::int+1 n from report_versions where report_id=$1",[report.id]);
  const snapshot={
    order_no:o.public_no,
    report_no:report.public_no,
    quote_id:o.submission_snapshot.quote_id,
    not_inspected:DEFAULT_NOT_INSPECTED,
    scope_notice:"Findings apply only to the physical samples received and the checks listed in this report.",
    sections,
  };
  const v=await one(db,`insert into report_versions(id,report_id,version,state,snapshot,created_by)
    values($1,$2,$3,'submitted',$4,$5) returning id,version,state`,
    [uuid(),report.id,version.n,snapshot,actor.id]);
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
  guard(!hasUntranslatedChinese(v.amend_reason),
    "ENGLISH_TRANSLATION_REQUIRED",
    "Amendment reason must be in English before approval.",422);
  for(const section of v.snapshot.sections??[]) {
    for(const res of section.results??[]) {
      assertAllowedWording(res.reason,typeof res.typed_value==="string"?res.typed_value:null);
      const hasChineseAnnotation=Array.isArray(res.annotations) && res.annotations.some((a:{label?:string})=>hasUntranslatedChinese(a?.label));
      guard(!hasUntranslatedChinese(res.reason) && (typeof res.typed_value!=="string" || !hasUntranslatedChinese(res.typed_value)) && !hasChineseAnnotation,
        "ENGLISH_TRANSLATION_REQUIRED",
        "Customer-facing report observations, annotations, and reasons must be reviewed in English before approval.",422);
    }
  }
  await db.query("update report_versions set state='qa_approved',reviewed_by=$2,reviewed_at=now(),revision=revision+1 where id=$1",[id,actor.id]);
  await event(db,"report.render",{version_id:id});
  await audit(db,actor,"approve_report","report_versions",id);
  return {id,version:v.version,state:"qa_approved"};
}

export async function translateReportCandidate(
  db:DB,
  actor:Actor,
  id:string,
  input:{revision:number;translations:{section:number;result:number;typed_value_en?:string;reason_en?:string;annotations_en?:string[]}[]}
) {
  const v=await reviewTarget(db,actor,id,input.revision);
  for(const item of input.translations) {
    const section=v.snapshot.sections?.[item.section];
    const result=section?.results?.[item.result];
    guard(result,"RESULT_INVALID","Select a valid checkpoint in this report candidate.",422);
    const hasTyped=typeof item.typed_value_en==="string" && item.typed_value_en.trim().length>0;
    const hasReason=typeof item.reason_en==="string" && item.reason_en.trim().length>0;
    const hasAnn=Array.isArray(item.annotations_en) && item.annotations_en.some(a=>typeof a==="string" && a.trim().length>0);
    guard(hasTyped || hasReason || hasAnn,"ENGLISH_TRANSLATION_REQUIRED","Provide at least one English translation field.",422);
    if(hasTyped) {
      const cleanTyped=item.typed_value_en!.trim();
      guard(!hasUntranslatedChinese(cleanTyped),"ENGLISH_TRANSLATION_REQUIRED","Translated observation value must be in English.",422);
      assertAllowedWording(null,cleanTyped);
      if(typeof result.typed_value==="string" && !result.typed_value_zh) {
        result.typed_value_zh=result.typed_value;
      }
      result.typed_value=cleanTyped;
    }
    if(hasReason) {
      const cleanEn=item.reason_en!.trim();
      guard(cleanEn.length>=2 && !hasUntranslatedChinese(cleanEn),"ENGLISH_TRANSLATION_REQUIRED","Provide a complete English translation.",422);
      assertAllowedWording(cleanEn);
      if(result.reason && !result.reason_zh) {
        result.reason_zh=result.reason;
      }
      result.reason=cleanEn;
    }
    if(Array.isArray(item.annotations_en) && Array.isArray(result.annotations)) {
      result.annotations=result.annotations.map((ann:{label?:string;label_zh?:string;x:number;y:number;w?:number;h?:number},idx:number)=>{
        const nextLabel=item.annotations_en?.[idx]?.trim();
        if(nextLabel) {
          guard(!hasUntranslatedChinese(nextLabel),"ENGLISH_TRANSLATION_REQUIRED","Annotation labels must be in English.",422);
          return {...ann,label_zh:ann.label_zh??ann.label,label:nextLabel};
        }
        return ann;
      });
    }
  }
  await db.query("update report_versions set snapshot=$2,revision=revision+1 where id=$1",[id,v.snapshot]);
  await audit(db,actor,"translate_report_candidate","report_versions",id,{count:input.translations.length});
  return {id,version:v.version,revision:v.revision+1,state:v.state};
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
  assertAllowedWording(input.reason);
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
    const expectedJsType=check.type==="text"?"string":check.type;
    guard(edit.status!=="RECORDED"||typeof edit.typed_value===expectedJsType,"RESULT_INVALID","Use the checkpoint's configured value type.",422);
    guard(!["NOT_TESTED","NOT_APPLICABLE","OBSERVED_ISSUE"].includes(edit.status)||edit.reason.length>=2,
      "RESULT_INVALID","Explain the observed issue or missing result.",422);
    guard(edit.status!=="OBSERVED_ISSUE"||result.evidence_ids.length>0,"EVIDENCE_REQUIRED","An observed issue requires supporting evidence.",422);
    assertAllowedWording(edit.reason,typeof edit.typed_value==="string"?edit.typed_value:null);
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

export async function createReportDispute(
  db:DB,
  actor:Actor,
  orderId:string,
  input:{version?:number;item_code?:string;item_key:string;subject?:string;message:string}
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const v=await one<{id:string;version:number;report_no:string;order_no:string;snapshot:{sections:{results:{item:string;item_key:string;label:string}[]}[]}}>(
    db,
    `select v.id,v.version,r.public_no report_no,o.public_no order_no,v.snapshot
     from orders o join reports r on r.order_id=o.id join report_versions v on v.report_id=r.id
     where o.id=$1 and o.org_id=$2 and v.version=coalesce($3,r.published_version) and v.state in ('published','superseded')`,
    [orderId,org,input.version??null]
  );
  const matched=v.snapshot.sections.flatMap(s=>s.results).find(r=>
    r.item_key===input.item_key && (!input.item_code || r.item===input.item_code)
  );
  guard(matched,"RESULT_INVALID","Select a valid checkpoint in this report version.",422);
  const ticketId=uuid(),publicNo=code("CASE-");
  const subject=(input.subject?.trim() || `Report ${v.report_no} v${v.version} dispute: ${matched.label} (${matched.item})`).slice(0,150);
  const details={
    dispute_type:"report_dispute",
    report_version_id:v.id,
    report_version:v.version,
    report_no:v.report_no,
    item_code:matched.item,
    item_key:matched.item_key,
    checkpoint_label:matched.label,
  };
  await db.query(
    `insert into tickets(id,public_no,org_id,order_id,category,subject,state,details,next_action_at)
     values($1,$2,$3,$4,'measurement_dispute',$5,'waiting_internal',$6,now() + interval '24 hours')`,
    [ticketId,publicNo,org,orderId,subject,details]
  );
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body,media_ids)
     values($1,$2,'customer',$3,'message',$4,'{}'::uuid[])`,
    [uuid(),ticketId,actor.id,input.message.trim()]
  );
  await audit(db,actor,"create_report_dispute","tickets",ticketId,details);
  return {ticket_id:ticketId,public_no:publicNo,state:"waiting_internal",category:"measurement_dispute",details};
}

type ReportResult={
  item:string;label:string;status:string;typed_value:unknown;typed_value_zh?:string;unit:string|null;reason:string|null;reason_zh?:string;method:string;
  recorded_by?:string|null;recorded_by_name?:string|null;recorded_at?:string|null;
  attempts?:{attempt:number;status:string;typed_value:unknown;unit:string|null;method:string;recorded_by?:string|null;recorded_by_name?:string|null;recorded_at?:string|null}[];
  evidence_ids:string[];derived_circumference?:number;within_tolerance?:boolean;
  severity?:string;part_code?:string;uncertain?:boolean;
  annotations?:{x:number;y:number;w?:number;h?:number;label?:string;label_zh?:string}[];
};
type Snapshot={
  order_no:string;report_no:string;quote_id:string;
  not_inspected?:string[];
  scope_notice?:string;
  sections:{
    title:string;service:string;
    measure_conditions?:string;
    shots?:{code:string;component?:string;item?:string;media_id:string}[];
    comparison?:{
      diffs:{point_code:string;label:string;unit:string|null;max_minus_min:number|null;display_diff:string}[];
      order_shots?:{code:string;media_id:string}[];
    };
    results:ReportResult[];
  }[];
};
async function renderPDF(db:DB,org:string,snapshot:Snapshot,version:number,amendReason?:string) {
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`QC Warehouse ${snapshot.report_no}`);
  const pages:ReturnType<typeof doc.addPage>[]=[];
  const newPage=()=>{const p=doc.addPage([595,842]);pages.push(p);return p;};
  let page=newPage(),y=790;
  const latin=(s:string)=>s
    .replace(/[\u2013\u2014]/g,"-")
    .replace(/[\u2018\u2019]/g,"'")
    .replace(/[\u201c\u201d]/g,'"')
    .replace(/\u2026/g,"...")
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g,"?");
  function print(s:string,size=10,strong=false) {
    const f=strong?bold:font;
    for(const line of latin(s).match(/.{1,94}/g)??[""]) {
      if(y<64) {page=newPage(); y=790;}
      page.drawText(line,{x:45,y,size,font:f,color:rgb(.06,.13,.16)}); y-=size+6;
    }
  }
  const images=new Map<string,Awaited<ReturnType<typeof doc.embedJpg>>>();
  async function evidence(
    id:string,
    caption?:string,
    annotations?:{x:number;y:number;w?:number;h?:number;label?:string}[]
  ) {
    const cacheKey=annotations?.length?`${id}:${JSON.stringify(annotations)}`:id;
    let image=images.get(cacheKey);
    if(!image) {
      const file=(await db.query<{data:Buffer}>(`select f.data from media_assets m join private_files f on f.key=m.object_key
        where m.id=$1 and m.org_id=$2 and m.kind='shot' and m.status='ready'
          and (m.result_id is not null or m.shot_code is not null or m.point_code is not null)`,[id,org])).rows[0];
      if(!file) return;
      const resized=await sharp(file.data).resize({width:640,height:480,fit:"inside",withoutEnlargement:true}).jpeg({quality:80}).toBuffer({resolveWithObject:true});
      let preview=resized.data;
      if(annotations?.length) {
        const iw=Math.max(64,resized.info.width||320);
        const ih=Math.max(64,resized.info.height||240);
        const rects=annotations.map((ann,idx)=>{
          const xPct=Math.max(0,Math.min(95,Number(ann.x)||0));
          const yPct=Math.max(0,Math.min(95,Number(ann.y)||0));
          const wPct=Math.max(6,Math.min(100-xPct,Number(ann.w)||16));
          const hPct=Math.max(6,Math.min(100-yPct,Number(ann.h)||16));
          const rx=Math.round((xPct/100)*iw);
          const ry=Math.round((yPct/100)*ih);
          const rw=Math.max(16,Math.round((wPct/100)*iw));
          const rh=Math.max(16,Math.round((hPct/100)*ih));
          const lbl=latin(ann.label||`Defect #${idx+1}`).replace(/[<>&"']/g,"");
          const ty=ry>16?ry-4:Math.min(ih-4,ry+rh+12);
          return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="rgba(220,38,38,0.16)" stroke="#dc2626" stroke-width="3" rx="2"/>`+
                 `<text x="${rx}" y="${ty}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#dc2626">${lbl}</text>`;
        }).join("");
        const overlaySvg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}" viewBox="0 0 ${iw} ${ih}">${rects}</svg>`);
        preview=await sharp(preview).composite([{input:overlaySvg,top:0,left:0}]).jpeg({quality:82}).toBuffer();
      }
      image=await doc.embedJpg(preview);
      images.set(cacheKey,image);
    }
    if(caption) print(`  Photo: ${caption}`,9,false);
    const scale=Math.min(220/image.width,144/image.height,1);
    const {width,height}=image.scale(scale);
    if(y-height<64) {page=newPage();y=790;}
    const imgX=45,imgY=y-height;
    page.drawImage(image,{x:imgX,y:imgY,width,height});
    if(annotations?.length) {
      for(const ann of annotations) {
        const xPct=Math.max(0,Math.min(95,Number(ann.x)||0));
        const yPct=Math.max(0,Math.min(95,Number(ann.y)||0));
        const wPct=Math.max(6,Math.min(100-xPct,Number(ann.w)||16));
        const hPct=Math.max(6,Math.min(100-yPct,Number(ann.h)||16));
        const boxW=(wPct/100)*width;
        const boxH=(hPct/100)*height;
        const boxX=imgX+(xPct/100)*width;
        const boxY=imgY+height-((yPct+hPct)/100)*height;
        page.drawRectangle({
          x:boxX,
          y:boxY,
          width:boxW,
          height:boxH,
          borderColor:rgb(0.86,0.15,0.15),
          borderWidth:1.5,
        });
      }
    }
    y-=height+10;
  }
  print("QC WAREHOUSE | INSPECTION REPORT",19,true);
  print(`${snapshot.report_no}   Version ${version}   Order ${snapshot.order_no}`,12);
  if(amendReason)print("Amendment: "+amendReason);
  print(snapshot.scope_notice||"Results relate to the inspected items and scope shown below.");y-=12;
  for(const s of snapshot.sections) {
    print(s.title,13,true);
    if(s.measure_conditions) {
      print(`Measurement Conditions: ${s.measure_conditions}`,9,false);
    }
    if(s.shots?.length) {
      print("Standard Camera Angle Shots:",11,true);
      for(const shot of s.shots) {
        await evidence(shot.media_id,`${shot.item??shot.component??"Sample"} - ${shot.code}`);
      }
    }
    for(const r of s.results) {
      const circ=typeof r.derived_circumference==="number"?` (Circumference: ${r.derived_circumference} cm)`:"";
      const tol=typeof r.within_tolerance==="boolean"?` [${r.within_tolerance?"Within stated tolerance":"Outside stated tolerance"}]`:"";
      const sev=r.severity?` [Severity: ${r.severity}]`:"";
      const part=r.part_code?` [Part: ${r.part_code}]`:"";
      const unc=r.uncertain?" [Uncertain - requires verification]":"";
      const mth=r.method?` [Method: ${r.method}]`:"";
      print(`${r.item} | ${r.label} | ${r.status} ${r.typed_value??""} ${r.unit??""}${circ}${tol}${sev}${part}${unc}${mth} ${r.reason??""}`);
      const traceParts=[
        r.method?`Method: ${r.method}`:"",
        (r.recorded_by_name||r.recorded_by)?`Inspector: ${r.recorded_by_name??r.recorded_by}`:"",
        r.recorded_at?`Recorded: ${String(r.recorded_at).slice(0,19).replace("T"," ")} UTC`:"",
      ].filter(Boolean);
      if(traceParts.length) {
        print(`  Traceability: ${traceParts.join(" | ")}`,8.5,false);
      }
      if(r.attempts && r.attempts.length>0 && (r.attempts.length>1 || typeof r.typed_value==="number")) {
        const readings=r.attempts.map(a=>`Attempt #${a.attempt}: ${a.typed_value??"-"} ${a.unit??""}`.trim()).join(" ; ");
        print(`  Measurement Readings: ${readings} -> Final: ${r.typed_value??"-"} ${r.unit??""}`.trim(),8.5,false);
      }
      if(r.annotations?.length) {
        for(const ann of r.annotations) {
          print(`  Defect Marker: (${Math.round(ann.x)}%, ${Math.round(ann.y)}%)${ann.label?` - ${ann.label}`:""}`,9,false);
        }
      }
      for(const id of r.evidence_ids) await evidence(id,`${r.item} - ${r.label}`,r.annotations);
    }
    if(s.comparison?.diffs?.length) {
      print("Comparison differences (max - min):",11,true);
      for(const d of s.comparison.diffs) {
        print(`  ${d.label}: ${d.display_diff}${d.max_minus_min!==null && d.unit?" "+d.unit:""}`);
      }
    }
    if(s.comparison?.order_shots?.length) {
      print("Side-by-Side Comparison Photos:",11,true);
      for(const shot of s.comparison.order_shots) {
        await evidence(shot.media_id,`Comparison - ${shot.code}`);
      }
    }
    y-=10;
  }
  const notInspected=snapshot.not_inspected?.length?snapshot.not_inspected:DEFAULT_NOT_INSPECTED;
  print("Scope & Exclusions (Not Inspected):",11,true);
  for(const line of notInspected) {
    print(`  - ${line}`,9,false);
  }
  const totalPages=pages.length;
  pages.forEach((p,idx)=>{
    p.drawText(
      latin(`QC Warehouse | ${snapshot.report_no} v${version} | Page ${idx+1} of ${totalPages} | Findings apply only to the samples received.`),
      {x:45,y:28,size:8,font,color:rgb(.35,.42,.46)}
    );
  });
  return Buffer.from(await doc.save());
}

export const APPAREL_SUBCATEGORY_TEMPLATES = {
  tops: {
    code: "apparel-tops-inspection",
    subcategory: "tops",
    title: { en: "Tops & Knitwear Inspection", zh: "上衣/针织衫专项质检" },
    content: {
      measurement_policy: { attempts: 2, extra_attempt_on_difference: true, threshold_by_unit: { cm: 0.5, g: 1 } },
      measure_conditions: "Garment laid flat on standard inspection table without stretching; relaxed for 15 minutes; steel tape calibrated to 0.1 cm.",
      diagram: "/diagrams/tops.svg",
      parts: [
        { code: "collar", label: "Collar / Neckband (领口)" },
        { code: "shoulder_left", label: "Left Shoulder Seam (左肩缝)" },
        { code: "shoulder_right", label: "Right Shoulder Seam (右肩缝)" },
        { code: "chest_front", label: "Front Chest Panel (前胸幅)" },
        { code: "back_panel", label: "Back Panel (后背幅)" },
        { code: "sleeve_left", label: "Left Sleeve & Cuff (左袖/袖口)" },
        { code: "sleeve_right", label: "Right Sleeve & Cuff (右袖/袖口)" },
        { code: "side_seam", label: "Side Seam (侧缝)" },
        { code: "hem", label: "Bottom Hem (下摆)" },
        { code: "care_label", label: "Main / Care Label (主唛/洗水唛)" },
      ],
      shots: [
        { code: "front_full", name: "Front Full Flat Lay", zh: "正面平铺全景", required: true },
        { code: "back_full", name: "Back Full Flat Lay", zh: "背面平铺全景", required: true },
        { code: "collar_label", name: "Collar & Size/Brand Label", zh: "领口与主唛微距", required: true },
        { code: "care_label_shot", name: "Care & Composition Label", zh: "洗水唛与成分标", required: true },
        { code: "inside_seams", name: "Interior Seam & Overlock", zh: "内里缝线与包边", required: true },
        { code: "chest_tape_shot", name: "Chest Width Tape Photo", zh: "胸宽拉尺实拍", required: true },
      ],
      checks: [
        { key: "body_length_cm", label: "Front Body Length HPS", zh: "前衣长 (肩顶至下摆)", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure from High Point Shoulder (HPS) vertically down to bottom hem." },
        { key: "chest_flat_cm", label: "1/2 Chest Width Flat", zh: "平铺半胸围", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure straight across chest 2.5cm below armhole seam." },
        { key: "shoulder_width_cm", label: "Shoulder Width", zh: "肩宽", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure straight from left shoulder point to right shoulder point." },
        { key: "sleeve_length_cm", label: "Sleeve Length", zh: "袖长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure from shoulder seam apex along outer sleeve fold to cuff edge." },
        { key: "hem_flat_cm", label: "1/2 Bottom Hem Width", zh: "平铺下摆宽", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure straight across bottom sweep from left edge to right edge." },
        { key: "neck_opening_cm", label: "Neck Opening Width", zh: "领口宽", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/tops.svg", required: true, evidence: false, method: "Measure inside seam-to-seam across collar opening." },
        { key: "unit_weight_g", label: "Garment Unit Weight", zh: "单件克重", kind: "measurement", type: "number", unit: "g", precision: 0.1, retry_threshold: 1.0, required: true, evidence: false, method: "Weigh single garment unpacked on calibrated digital scale." },
        { key: "workmanship_seams", label: "Seam & Stitching Workmanship", zh: "车缝与线头外观", kind: "observation", type: "text", required: true, evidence: false, parts: ["collar", "shoulder_left", "shoulder_right", "sleeve_left", "sleeve_right", "side_seam", "hem"], method: "Inspect collar, cuffs, armholes, side seams, and hem for skipped stitches, puckering, or loose threads." },
        { key: "fabric_surface", label: "Fabric Surface & Stains", zh: "面料外观与污渍", kind: "observation", type: "text", required: true, evidence: false, parts: ["chest_front", "back_panel", "sleeve_left", "sleeve_right"], method: "Check front/back panels under D65 light for oil stains, holes, snags, or shading." },
        { key: "label_marking_check", label: "Label & Size Marking Accuracy", zh: "唛头与尺码核对", kind: "observation", type: "text", required: true, evidence: false, parts: ["collar", "care_label"], method: "Verify main label, size tag, and care label match order declaration." },
      ],
    },
  },
  bottoms: {
    code: "apparel-bottoms-inspection",
    subcategory: "bottoms",
    title: { en: "Bottoms, Pants & Leggings Inspection", zh: "裤装/紧身裤专项质检" },
    content: {
      measurement_policy: { attempts: 2, extra_attempt_on_difference: true, threshold_by_unit: { cm: 0.5, g: 1 } },
      measure_conditions: "Garment laid flat on standard inspection table without stretching; relaxed for 15 minutes; steel tape calibrated to 0.1 cm.",
      diagram: "/diagrams/bottoms.svg",
      parts: [
        { code: "waistband", label: "Waistband (腰头)" },
        { code: "crotch_gusset", label: "Crotch / Gusset Seam (裆部/三角裤裆)" },
        { code: "hip_panel", label: "Hip / Seat Panel (臀围区)" },
        { code: "thigh_left", label: "Left Thigh & Inseam (左大腿/内长缝)" },
        { code: "thigh_right", label: "Right Thigh & Inseam (右大腿/内长缝)" },
        { code: "outseam", label: "Outer Side Seam (外侧缝)" },
        { code: "leg_opening", label: "Leg Opening / Ankle Cuff (脚口)" },
        { code: "care_label", label: "Size / Care Label (尺码/洗水唛)" },
      ],
      shots: [
        { code: "front_full", name: "Front Full Flat Lay", zh: "裤装正面平铺全景", required: true },
        { code: "back_full", name: "Back Full Flat Lay", zh: "裤装背面平铺全景", required: true },
        { code: "waistband_label", name: "Waistband & Inner Print/Label", zh: "腰头与尺码唛微距", required: true },
        { code: "crotch_gusset_shot", name: "Crotch Gusset Flatlock Seam", zh: "裆部四针六线缝合微距", required: true },
        { code: "waist_inseam_tape", name: "Waist & Inseam Tape Photo", zh: "腰围与内长拉尺实拍", required: true },
      ],
      checks: [
        { key: "waist_flat_cm", label: "1/2 Waist Width Relaxed", zh: "平铺半腰围", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Align front and back top edges of waistband; measure straight across." },
        { key: "hip_flat_cm", label: "1/2 Hip Width Flat", zh: "平铺半臀围", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure straight across hip at 18cm below top of waistband (or 5cm above crotch)." },
        { key: "front_rise_cm", label: "Front Rise incl. Waistband", zh: "前浪长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure from top center of front waistband along seam to crotch intersection." },
        { key: "back_rise_cm", label: "Back Rise incl. Waistband", zh: "后浪长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure from top center of back waistband along seam to crotch intersection." },
        { key: "inseam_cm", label: "Inseam Length", zh: "内长/裤内长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure from crotch seam intersection along inner leg seam to bottom ankle opening." },
        { key: "outseam_cm", label: "Outseam Total Length", zh: "外裤长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure from top outer edge of waistband along side to leg opening." },
        { key: "leg_opening_flat_cm", label: "1/2 Leg Opening Width", zh: "平铺半脚口宽", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/bottoms.svg", required: true, evidence: false, method: "Measure straight across bottom ankle/leg opening." },
        { key: "unit_weight_g", label: "Garment Unit Weight", zh: "单件克重", kind: "measurement", type: "number", unit: "g", precision: 0.1, retry_threshold: 1.0, required: true, evidence: false, method: "Weigh single pants/leggings unpacked on calibrated digital scale." },
        { key: "crotch_flatlock_check", label: "Crotch Gusset & Flatlock Seam", zh: "裆部拼缝与四针六线", kind: "observation", type: "text", required: true, evidence: false, parts: ["waistband", "crotch_gusset", "thigh_left", "thigh_right", "outseam", "leg_opening"], method: "Inspect crotch gusset and flatlock seams under gentle hand tension for grinning or skipped stitches." },
        { key: "fabric_surface", label: "Fabric Surface & Elasticity Feel", zh: "面料外观与对称度", kind: "observation", type: "text", required: true, evidence: false, parts: ["hip_panel", "thigh_left", "thigh_right", "leg_opening"], method: "Inspect for snags, dye streaks, oil marks, or uneven leg symmetry." },
      ],
    },
  },
  sports_bra: {
    code: "apparel-sports-bra-inspection",
    subcategory: "sports_bra",
    title: { en: "Sports Bra & Intimate Activewear Inspection", zh: "运动内衣专项质检" },
    content: {
      measurement_policy: { attempts: 2, extra_attempt_on_difference: true, threshold_by_unit: { cm: 0.5, g: 1 } },
      measure_conditions: "Garment laid flat on standard inspection table with removable cups flat inside; steel tape calibrated to 0.1 cm.",
      diagram: "/diagrams/sports_bra.svg",
      parts: [
        { code: "strap_left", label: "Left Shoulder Strap (左肩带)" },
        { code: "strap_right", label: "Right Shoulder Strap (右肩带)" },
        { code: "neckline_binding", label: "Neckline / Armhole Binding (领圈/袖笼包边)" },
        { code: "cup_lining", label: "Inner Cup Lining & Pad Opening (胸垫内胆与插口)" },
        { code: "removable_pads", label: "Removable Bra Pads Pair (可拆卸胸垫对)" },
        { code: "underbust_band", label: "Underbust Elastic Band (下扒松紧带)" },
        { code: "back_strap_cross", label: "Back Cross / Clasp Area (后背交叉带/背扣)" },
      ],
      shots: [
        { code: "front_full", name: "Front Full Flat Lay", zh: "运动内衣正面平铺", required: true },
        { code: "back_full", name: "Back Full Flat Lay", zh: "运动内衣背面平铺", required: true },
        { code: "inner_lining_pads", name: "Inner Cup Lining & Pads Removed", zh: "内胆及胸垫取出同框照", required: true },
        { code: "underbust_tape", name: "Underbust Band Tape Photo", zh: "下扒宽拉尺实拍", required: true },
      ],
      checks: [
        { key: "bust_flat_cm", label: "1/2 Bust Width Flat", zh: "平铺半胸围", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/sports_bra.svg", required: true, evidence: false, method: "Measure straight across fullest part of chest 2cm below armhole." },
        { key: "underbust_flat_cm", label: "1/2 Underbust Band Relaxed", zh: "平铺半下扒宽", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, derived: { circumference_cm: "2x" }, diagram: "/diagrams/sports_bra.svg", required: true, evidence: false, method: "Measure straight across bottom edge of elastic underbust band relaxed." },
        { key: "strap_to_hem_cm", label: "Total Length HPS to Underbust", zh: "肩带顶点至下扒总长", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/sports_bra.svg", required: true, evidence: false, method: "Measure vertically from top of shoulder strap to bottom edge of underbust band." },
        { key: "center_front_height_cm", label: "Center Front Height", zh: "前中高度", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.5, diagram: "/diagrams/sports_bra.svg", required: true, evidence: false, method: "Measure vertically from center front neckline down to bottom edge of band." },
        { key: "band_height_cm", label: "Underbust Elastic Band Height", zh: "下扒松紧带高度", kind: "measurement", type: "number", unit: "cm", precision: 0.1, retry_threshold: 0.3, diagram: "/diagrams/sports_bra.svg", required: true, evidence: false, method: "Measure vertical height of bottom elastic band." },
        { key: "unit_weight_g", label: "Garment Unit Weight incl. Pads", zh: "含胸垫单件克重", kind: "measurement", type: "number", unit: "g", precision: 0.1, retry_threshold: 1.0, required: true, evidence: false, method: "Weigh sports bra with both pads inserted on digital scale." },
        { key: "pad_symmetry_check", label: "Removable Pads Symmetry & Smoothness", zh: "胸垫对称度与平整度", kind: "observation", type: "text", required: true, evidence: false, parts: ["cup_lining", "removable_pads"], method: "Remove pads to inspect for creases, delamination, size mismatch, or rough pocket openings." },
        { key: "strap_bar_tack_check", label: "Strap Reinforcement & Binding Seams", zh: "肩带打枣加固与包边车缝", kind: "observation", type: "text", required: true, evidence: false, parts: ["strap_left", "strap_right", "neckline_binding", "underbust_band", "back_strap_cross"], method: "Check strap joints, elastic band recovery, and binding seams for skipped stitches." },
      ],
    },
  },
} as const;

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
  await db.query(
    `insert into private_files(key,data,mime) values($1,$2,'application/pdf')
     on conflict(key) do update set data=excluded.data,mime=excluded.mime`,
    [key,bytes]
  );
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
