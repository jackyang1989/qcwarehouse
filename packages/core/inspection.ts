import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { attachEvidence } from "./intake";
import { templateSchema } from "./orders";
import { staffAccess } from "./staff-access";

type ResultInput={item_key:string;component:string;attempt:number;status:string;method:string;is_final:boolean;typed_value?:unknown;unit?:string;reason?:string;evidence_ids?:string[];details?:object};
async function lockedTask(db:DB,id:string) {
  const initial=await one(db,`select l.org_id from inspection_tasks t join order_lines l on l.id=t.order_line_id where t.id=$1`,[id]);
  await lock(db,"org:"+initial.org_id);
  return one(db,`select t.*,l.org_id,l.order_id,v.content,o.state order_state
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id
    join template_versions v on v.id=t.template_version_id where t.id=$1 for update of t,o`,[id]);
}
async function components(db:DB,t:{group_id?:string}) {
  if(!t.group_id) return [{id:"main",code:"Item"}];
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
export async function taskDetail(db:DB,actor:Actor,id:string) {
  role(actor,"inspector","reviewer","warehouse_admin");
  const t=await one(db,`select t.id,t.state,t.revision,t.assignee_id,t.group_id,t.template_version_id,v.content,
    o.public_no,o.id order_id,o.revision order_revision,w.code item_code,
    case when o.state='inspecting' then (select ae.after->>'reason' from reports r
      join report_versions rv on rv.report_id=r.id and rv.state='draft'
      join audit_events ae on ae.entity_id=rv.id and ae.entity_type='report_versions' and ae.action='return_report'
      where r.order_id=o.id order by rv.version desc limit 1) end review_feedback
    from inspection_tasks t join template_versions v on v.id=t.template_version_id join order_lines l on l.id=t.order_line_id
    join orders o on o.id=l.order_id left join order_line_item_links a on a.id=t.assignment_id
    left join warehouse_items w on w.id=a.item_id where t.id=$1`,[id]);
  return {...t,components:await components(db,t),results:(await db.query(`select r.*,array(select m.id from media_assets m where m.result_id=r.id) evidence_ids
    from inspection_results r where r.task_id=$1 order by r.item_key,r.component,r.attempt`,[id])).rows};
}
function dto(t:{id:string;state:string;revision:number;template_version_id:string}) {
  return {id:t.id,state:t.state,revision:t.revision,template_version_id:t.template_version_id};
}
export async function startTask(db:DB,actor:Actor,id:string,rev:number) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,rev);
  guard(t.state==="READY" && ["queued","inspecting"].includes(t.order_state),"TASK_UNAVAILABLE","The task is already claimed or blocked.");
  const ref=(await db.query(`select r.id from inspection_groups g join reference_samples r on r.id=g.reference_id
    where g.id=$1 and (r.state<>'active' or r.expires_at<=now())`,[t.group_id])).rowCount;
  guard(!ref,"REFERENCE_UNAVAILABLE","The reference sample is no longer active.");
  const updated=await one<{id:string;state:string;revision:number;template_version_id:string}>(db,`update inspection_tasks
    set state='IN_PROGRESS',assignee_id=$2,revision=revision+1 where id=$1 returning *`,[id,actor.id]);
  await db.query("update orders set state='inspecting',revision=revision+1 where id=$1 and state='queued'",[t.order_id]);
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
  for(const value of results) {
    const check=template.checks.find(c=>c.key===value.item_key);
    guard(check && members.some(m=>m.id===value.component) && check.method===value.method,"RESULT_INVALID","Check, item, and method must match the template.",422);
    if(value.status==="RECORDED") guard(typeof value.typed_value===check.type && (check.unit??undefined)===(value.unit??undefined),"RESULT_INVALID","Enter the configured value type and unit.",422);
    if(value.status==="OBSERVED_ISSUE") guard(value.evidence_ids?.length && (value.reason?.trim() || value.details),"EVIDENCE_REQUIRED","Describe the issue and attach evidence.",422);
    if(value.is_final) await db.query("update inspection_results set is_final=false where task_id=$1 and item_key=$2 and component=$3 and is_final",[id,value.item_key,value.component]);
    const r=await one<{id:string}>(db,`insert into inspection_results(task_id,item_key,component,attempt,status,typed_value,unit,method,reason,details,is_final,recorded_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict(task_id,item_key,component,attempt) do update set status=excluded.status,typed_value=excluded.typed_value,unit=excluded.unit,
      method=excluded.method,reason=excluded.reason,details=excluded.details,is_final=excluded.is_final,recorded_by=excluded.recorded_by,recorded_at=now()
      returning id`,[id,value.item_key,value.component,value.attempt,value.status,value.typed_value==null?null:JSON.stringify(value.typed_value),
      value.unit??null,value.method,value.reason??null,value.details??null,value.is_final,actor.id]);
    if(value.evidence_ids?.length) {
      await attachEvidence(db,actor,value.evidence_ids,"shot",{org:t.org_id,task:id});
      await db.query("update media_assets set result_id=$2 where id=any($1::uuid[]) and (result_id is null or result_id=$2)",[value.evidence_ids,r.id]);
      const attached=await one<{n:number}>(db,"select count(*)::int n from media_assets where id=any($1::uuid[]) and result_id=$2",[value.evidence_ids,r.id]);
      guard(attached.n===value.evidence_ids.length,"EVIDENCE_MISMATCH","Evidence is already assigned to another result.");
    }
  }
  await db.query("update inspection_tasks set revision=revision+1 where id=$1",[id]);
  await audit(db,actor,"record_results","inspection_tasks",id,{count:results.length});
  return dto({...t,revision:t.revision+1} as Parameters<typeof dto>[0]);
}
export async function submitTask(db:DB,actor:Actor,id:string,rev:number) {
  role(actor,"inspector");
  const t=await lockedTask(db,id);
  revision(t.revision,rev);
  guard(t.state==="IN_PROGRESS" && t.assignee_id===actor.id && t.order_state==="inspecting","TASK_UNAVAILABLE","This task is not assigned to you.");
  const template=templateSchema.parse(t.content);
  const results=(await db.query(`select r.*,exists(select 1 from media_assets m where m.result_id=r.id and m.status='ready') has_evidence
    from inspection_results r where r.task_id=$1 and r.is_final`,[id])).rows;
  for(const member of await components(db,t)) for(const c of template.checks) {
    if(!c.required) continue;
    const r=results.find(r=>r.component===member.id && r.item_key===c.key);
    guard(r && r.status!=="BLOCKED" && (!c.evidence || r.has_evidence),"RESULT_INCOMPLETE",`Complete ${c.label} for ${member.code}.`);
  }
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
