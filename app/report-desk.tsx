"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Action, checked, CodeButton, Empty, ErrorBlock, Field, Form, MediaButton, Panel, request, Select, StaffObjectDrawer, type StaffObjectTarget, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

const states:Record<string,string>={draft:"修订草稿",submitted:"待独立复核",qa_approved:"待生成 PDF",published:"已发布",superseded:"历史版本"};
export function ReportDesk() {
  const query=useSearchParams().get("order")?.trim().toUpperCase()??"";
  const {data,error,reload}=useLoad("/staff/reports"+(query?"?"+new URLSearchParams({order:query}):""));
  return <>
    <div className="page-head"><p className="eyebrow">WAREHOUSE / REPORTS</p><h1>报告与修订</h1>
      <p className="muted">核对报告证据，为已发布报告建立修订并提交独立复核。</p></div>
    <Panel title="报告版本">
      <form className="form inline-form" action="/wh/review" method="get" key={query}>
        <label>原质检订单号<input name="order" defaultValue={query} required maxLength={64}/></label>
        <button type="submit" className="primary">查报告</button><Link href="/wh/review">全部近期版本</Link>
      </form>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在读取报告…</p>}
      {data&&!error&&<Table headers={["订单","版本","状态","修订原因","建立时间"]} rows={data.rows.map((v:Row)=>[
        <Link className="code" href={"/wh/review/"+v.id}>{v.public_no}</Link>,v.version,<Tag>{states[v.state]}</Tag>,
        v.amend_reason??"—",stamp(v.created_at),
      ])} empty="没有符合条件的报告。"/>}
      <button type="button" onClick={reload}>刷新报告队列</button>
    </Panel>
  </>;
}
function valueOf(result:Row) {
  if(result.typed_value!==null&&result.typed_value!==undefined)return String(result.typed_value)+(result.unit?" "+result.unit:"");
  return result.reason??result.status;
}
type DraftTranslationEntry={
  section:number;
  result:number;
  hasTypedField:boolean;
  hasReasonField:boolean;
  typed_value_en:string;
  reason_en:string;
  annotations_en:string[];
};
export function StaffReport({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/reports/"+id);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const [drafts,setDrafts]=useState<Record<string,DraftTranslationEntry>>({});
  const [batchSavedNotice,setBatchSavedNotice]=useState<string>("");
  const editing=data?.state==="draft"&&data.snapshot.amends_version&&data.created_by===actor.id;
  const hasReviewRole=actor.roles.some((r:string)=>r==="reviewer"||r==="super_admin");
  const isSelfReview=Boolean(data&&(data.created_by===actor.id||data.snapshot.sections.some((s:Row)=>s.inspector_id===actor.id)));
  const canReview=data?.state==="submitted"&&hasReviewRole&&!isSelfReview;
  const hasChinese=(val:unknown)=>/\p{Script=Han}/u.test(String(val??""));

  useEffect(()=>{
    if(!data?.snapshot?.sections) return;
    const init:Record<string,DraftTranslationEntry>={};
    data.snapshot.sections.forEach((section:Row,s:number)=>{
      (section.results??[]).forEach((res:Row,r:number)=>{
        const typedIsZh=typeof res.typed_value==="string"&&hasChinese(res.typed_value);
        const hasTypedField=Boolean(typedIsZh||res.typed_value_zh);
        const reasonIsZh=hasChinese(res.reason);
        const hasReasonField=Boolean(reasonIsZh||res.reason_zh||res.reason);
        const anns=Array.isArray(res.annotations)?res.annotations:[];
        if(hasTypedField||hasReasonField||anns.length>0) {
          init[`${s}-${r}`]={
            section:s,
            result:r,
            hasTypedField,
            hasReasonField,
            typed_value_en:typedIsZh?"":(typeof res.typed_value==="string"?res.typed_value:""),
            reason_en:reasonIsZh?"":String(res.reason??""),
            annotations_en:anns.map((a:Row)=>hasChinese(a.label)?"":String(a.label??"")),
          };
        }
      });
    });
    setDrafts(init);
  },[data?.revision,data?.id]);

  const updateDraft=(key:string,updater:(prev:DraftTranslationEntry)=>DraftTranslationEntry)=>{
    setDrafts(prev=>prev[key]?{...prev,[key]:updater(prev[key]!)}:prev);
  };

  const untranslatedItems:{key:string;anchorId:string;item:string;label:string}[]=[];
  if(data?.snapshot?.sections) {
    data.snapshot.sections.forEach((section:Row,s:number)=>{
      (section.results??[]).forEach((result:Row,r:number)=>{
        const annHasZh=Array.isArray(result.annotations)&&result.annotations.some((a:Row)=>hasChinese(a.label));
        const needsEn=hasChinese(result.reason)||(typeof result.typed_value==="string"&&hasChinese(result.typed_value))||annHasZh;
        if(needsEn) {
          untranslatedItems.push({
            key:`${s}-${r}`,
            anchorId:`tr-${s}-${r}`,
            item:String(result.item??`#${r+1}`),
            label:String(result.label??result.item_key??""),
          });
        }
      });
    });
  }

  return <>
    <div className="page-head"><Link href="/wh/review">← 报告队列</Link><p className="eyebrow report-eyebrow">WAREHOUSE / REPORT VERSION</p>
      <h1>{data?.public_no??"报告版本"}</h1>{data&&<p>版本 {data.version} · <Tag>{states[data.state]}</Tag></p>}</div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在读取报告内容…</p>}
    {data&&!error&&<>
      {data.amend_reason&&<Panel title="本次修订原因"><p>{data.amend_reason}</p>
        {data.review_feedback&&<p className="notice">复核意见 · {data.review_feedback}</p>}</Panel>}
      {data.state==="submitted"&&hasReviewRole&&isSelfReview&&<Panel title="独立复核限制">
        <p className="notice">当前账号为该报告版本的提交人或执行检查员。按职责分离规则，须由另一名独立复核员（reviewer）执行英文校对与批准。</p>
      </Panel>}
      {canReview&&<Panel title="双语校对导航与一键批量保存译文" subtitle="现场中文原始观察永久保留在中文原记字段，客户可见报告与 PDF 仅呈现校对后的客观英文事实。保存译文不会自动发布报告，最终批准须在底部独立确认。">
        <div className="row between flexwrap" style={{gap:10}}>
          <div>
            {untranslatedItems.length>0
              ?<span>当前仍有 <Tag tone="yellow">{untranslatedItems.length} 项含中文待译</Tag>（批准前须全部完成英文校对）：</span>
              :<Tag tone="green">全部检查项、观察值与瑕疵框选标签均已完成英文校对</Tag>}
          </div>
          <Action primary run={async()=>{
            const payloadList:Record<string,unknown>[]=[];
            for(const entry of Object.values(drafts)) {
              const itemPayload:Record<string,unknown>={section:entry.section,result:entry.result};
              let hasField=false;
              if(entry.hasTypedField && entry.typed_value_en.trim().length>=1) {
                itemPayload.typed_value_en=entry.typed_value_en.trim();
                hasField=true;
              }
              if(entry.hasReasonField && entry.reason_en.trim().length>=2) {
                itemPayload.reason_en=entry.reason_en.trim();
                hasField=true;
              }
              if(entry.annotations_en.length>0 && entry.annotations_en.every(lbl=>lbl.trim().length>=1)) {
                itemPayload.annotations_en=entry.annotations_en.map(lbl=>lbl.trim());
                hasField=true;
              }
              if(hasField) payloadList.push(itemPayload);
            }
            if(!payloadList.length) throw new Error("请先在下方填写至少一项英文译文后再点击批量保存。");
            await request("/staff/reports/"+id+"/candidate","PATCH",{
              revision:data.revision,
              translations:payloadList,
            });
            setBatchSavedNotice(`已批量保存 ${payloadList.length} 项英文校对译文（中文原始记录已完整保留）。`);
            reload();
          }}>一键批量保存全部英文译文</Action>
        </div>
        {untranslatedItems.length>0&&<div className="actions" style={{marginTop:10,flexWrap:"wrap"}}>
          <span className="small muted">快速定位待译项：</span>
          {untranslatedItems.map((u,idx)=><a key={u.key} className="button sm" href={`#${u.anchorId}`}>
            #{idx+1} {u.item} · {u.label}
          </a>)}
        </div>}
        {batchSavedNotice&&<p className="notice" role="status" style={{marginTop:10}}>{batchSavedNotice}</p>}
      </Panel>}
      {data.snapshot.sections.map((section:Row,s:number)=><Panel key={section.task_id} title={section.title}>
        <Table headers={["实物","检查项","原发布值","当前值 / 英文说明","中文现场原记（保留）","状态","证据"]} rows={section.results.map((result:Row,r:number)=>{
          const original=data.base_snapshot?.sections[s]?.results[r];
          const annHasZh=Array.isArray(result.annotations)&&result.annotations.some((a:Row)=>hasChinese(a.label));
          const needsEn=hasChinese(result.reason)||(typeof result.typed_value==="string"&&hasChinese(result.typed_value))||annHasZh;
          const zhParts:string[]=[];
          if(result.typed_value_zh || (typeof result.typed_value==="string"&&hasChinese(result.typed_value))) {
            zhParts.push(`值: ${result.typed_value_zh??result.typed_value}`);
          }
          if(result.reason_zh || hasChinese(result.reason)) {
            zhParts.push(`说明: ${result.reason_zh??result.reason}`);
          }
          if(Array.isArray(result.annotations)&&result.annotations.some((a:Row)=>a.label_zh||hasChinese(a.label))) {
            zhParts.push(`框选: ${result.annotations.map((a:Row)=>a.label_zh??a.label).filter(Boolean).join(" / ")}`);
          }
          return [
            result.item?<CodeButton code={result.item} onClick={()=>setDrawer({kind:"item",ref:result.item})}/>:"—",
            result.label,
            original?valueOf(original):"—",
            <div>
              {valueOf(result)}
              {result.reason&&result.typed_value!==null&&result.typed_value!==undefined&&<div className="small muted">{result.reason}</div>}
              {Array.isArray(result.annotations)&&result.annotations.length>0&&<div className="small muted">非破坏性瑕疵框选：{result.annotations.map((a:Row,ai:number)=>`#${ai+1} ${a.label||"Defect"}`).join("；")}</div>}
              {needsEn&&<div><a href={`#tr-${s}-${r}`}><Tag tone="yellow">待译英文</Tag></a></div>}
            </div>,
            zhParts.length>0?<div className="small">{zhParts.join(" · ")}</div>:"—",
            result.status,
            result.evidence_ids?.length?<MediaButton ids={result.evidence_ids} annotations={result.annotations??[]} labels={result.evidence_ids.map((_:string,idx:number)=>`${result.item} · ${result.label} (#${idx+1})`)} label={`查看证据照 (${result.evidence_ids.length})`}/>:"—",
          ];
        })}/>
        {(section.shots?.length??0)>0&&<div className="card" style={{marginTop:10}}>
          <strong>标准必拍机位照片 ({section.shots.length})</strong>
          <div className="actions" style={{marginTop:6}}>
            <MediaButton
              ids={section.shots.map((sh:Row)=>sh.media_id)}
              labels={section.shots.map((sh:Row)=>`${sh.item??""} · ${sh.label??sh.shot_code}`)}
              label={`查看必拍机位照 (${section.shots.length})`}
            />
          </div>
        </div>}
        {(section.comparison?.order_shots?.length??0)>0&&<div className="card" style={{marginTop:10}}>
          <strong>横向对比同框照片 ({section.comparison.order_shots.length})</strong>
          <div className="actions" style={{marginTop:6}}>
            <MediaButton
              ids={section.comparison.order_shots.map((sh:Row)=>sh.media_id)}
              labels={section.comparison.order_shots.map((sh:Row)=>`对比同框 · ${sh.shot_code}`)}
              label={`查看同框对比照 (${section.comparison.order_shots.length})`}
            />
          </div>
        </div>}
        {canReview&&section.results.map((result:Row,r:number)=>{
          const key=`${s}-${r}`;
          const draft=drafts[key];
          if(!draft) return null;
          const annList=Array.isArray(result.annotations)?result.annotations:[];
          const needsEn=hasChinese(result.reason)||(typeof result.typed_value==="string"&&hasChinese(result.typed_value))||annList.some((a:Row)=>hasChinese(a.label));
          return <details className="card" key={"tr-"+r} id={`tr-${s}-${r}`} open={needsEn}>
            <summary>英文复核校对 · {result.item} · {result.label}{needsEn?"（含中文待译）":""}</summary>
            <div className="stack" style={{gap:8,marginTop:8}}>
              {draft.hasTypedField&&<div>
                <p className="small muted" style={{margin:"0 0 4px"}}>检查员中文观察值原记：{result.typed_value_zh??result.typed_value}</p>
                <label>客户可见英文观察值 (typed_value_en)
                  <input
                    value={draft.typed_value_en}
                    onChange={e=>updateDraft(key,d=>({...d,typed_value_en:e.target.value}))}
                    placeholder="Enter objective English observation value"
                  />
                </label>
              </div>}
              {draft.hasReasonField&&<div>
                {(result.reason_zh||hasChinese(result.reason))&&<p className="small muted" style={{margin:"0 0 4px"}}>检查员中文说明原记：{result.reason_zh??result.reason}</p>}
                <label>客户可见英文说明（禁止保留中文或主观合格性结论）
                  <textarea
                    value={draft.reason_en}
                    onChange={e=>updateDraft(key,d=>({...d,reason_en:e.target.value}))}
                    minLength={2}
                    maxLength={2000}
                    placeholder="Enter objective English description for customer report & PDF"
                  />
                </label>
              </div>}
              {annList.length>0&&<div>
                <strong className="small">瑕疵图片框选英文标注 ({annList.length} 处)</strong>
                {annList.map((ann:Row,ai:number)=><div key={ai} style={{marginTop:4}}>
                  <small className="muted">框选 #{ai+1} 中文原标：{ann.label_zh??ann.label??"—"}</small>
                  <input
                    value={draft.annotations_en[ai]??""}
                    onChange={e=>updateDraft(key,d=>{
                      const next=[...d.annotations_en];
                      next[ai]=e.target.value;
                      return {...d,annotations_en:next};
                    })}
                    placeholder={`Annotation #${ai+1} English label (e.g. Loose seam thread)`}
                  />
                </div>)}
              </div>}
              <div className="actions">
                <Action sm run={async()=>{
                  const payload:Record<string,unknown>={section:s,result:r};
                  if(draft.hasTypedField&&draft.typed_value_en.trim()) payload.typed_value_en=draft.typed_value_en.trim();
                  if(draft.hasReasonField&&draft.reason_en.trim()) payload.reason_en=draft.reason_en.trim();
                  if(annList.length>0&&draft.annotations_en.every(x=>x.trim().length>=1)) payload.annotations_en=draft.annotations_en.map(x=>x.trim());
                  await request("/staff/reports/"+id+"/candidate","PATCH",{
                    revision:data.revision,
                    translations:[payload],
                  });
                  reload();
                }}>保存此项译文</Action>
              </div>
            </div>
          </details>;
        })}
        {editing&&section.results.map((result:Row,r:number)=><details className="card" key={r}>
          <summary>修订 {result.item} · {result.label}</summary>
          <Form key={data.revision+"-"+s+"-"+r} label="保存该项修订" run={async fields=>{
            const raw=text(fields,"value");
            const kind=data.field_types[section.template_version_id][result.item_key];
            const status=text(fields,"status");
            if(status==="RECORDED"&&!raw)throw new Error("请填写修订后的值。");
            const value=kind==="number"?Number(raw):kind==="boolean"?raw==="true":raw||null;
            await request("/staff/reports/"+id,"PATCH",{revision:data.revision,changes:[{
              section:s,result:r,status,typed_value:value,reason:text(fields,"reason"),
            }]});reload();
          }}>
            <Select name="status" label="结果状态" value={result.status} choices={[
              {id:"RECORDED",label:"已测量或观察"},{id:"OBSERVED_ISSUE",label:"发现问题"},
              {id:"NOT_OBSERVED",label:"未观察到问题"},{id:"NOT_TESTED",label:"未检查"},{id:"NOT_APPLICABLE",label:"不适用"},
            ]}/>
            {data.field_types[section.template_version_id][result.item_key]==="boolean"?
              <Select name="value" label="修订后的观察值" value={String(result.typed_value)} choices={[{id:"true",label:"是"},{id:"false",label:"否"}]}/>:
              <Field name="value" label={"修订值"+(result.unit?"（"+result.unit+"）":"")} value={result.typed_value??""} required={false}/>}
            <label>客户可见英文说明<textarea name="reason" defaultValue={result.reason??""} maxLength={2000}/></label>
          </Form>
        </details>)}
      </Panel>)}
      {editing&&<Panel title="提交独立复核"><Action primary run={async()=>{
        if(!window.confirm("确认提交本次修订供独立复核？"))return;
        await request("/staff/reports/"+id+"/submit-revision","POST",{revision:data.revision});reload();
      }}>提交修订</Action></Panel>}
      {canReview&&<Panel title="独立复核">
        <Form label="批准并生成新版 PDF" run={async fields=>{
          if(!checked(fields,"language")||!checked(fields,"evidence"))throw new Error("请核对英文内容和证据。");
          await request("/staff/reports/"+id+"/approve","POST",{revision:data.revision,checklist:["reviewed_en","evidence_checked"]});reload();
        }}>
          <label className="check"><input name="language" type="checkbox" required/>已核对客户可见英文、单位和修订差异</label>
          <label className="check"><input name="evidence" type="checkbox" required/>已核对证据和委托范围</label>
        </Form>
        <Form label="记录原因并退回" run={async fields=>{
          await request("/staff/reports/"+id+"/reject","POST",{revision:data.revision,reason:text(fields,"reason")});reload();
        }}><label>修改要求<textarea name="reason" required minLength={4} maxLength={1200}/></label></Form>
      </Panel>}
      {data.state==="published"&&<Panel title="建立修订草稿">
        <p>修订经独立审核并生成 PDF 后发布，客户可以查看历史版本。</p>
        <Form label="建立修订" run={async fields=>{
          const draft=await request("/staff/reports/"+data.report_id+"/amend","POST",{base_version:data.version,reason:text(fields,"reason")});
          location.assign("/wh/review/"+draft.id);
        }}><label>修订原因<textarea name="reason" required minLength={4} maxLength={1000}/></label></Form>
      </Panel>}
      {data.state==="qa_approved"&&<Empty>等待后台生成并校验 PDF。生成成功后客户可以查看新版本。</Empty>}
    </>}
    <button type="button" onClick={reload}>刷新报告状态</button>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}
