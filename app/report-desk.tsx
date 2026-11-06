"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, request, Select, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

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
export function StaffReport({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/reports/"+id);
  const editing=data?.state==="draft"&&data.snapshot.amends_version&&data.created_by===actor.id;
  const canReview=data?.state==="submitted"&&actor.roles.some((r:string)=>r==="reviewer"||r==="super_admin");
  return <>
    <div className="page-head"><Link href="/wh/review">← 报告队列</Link><p className="eyebrow report-eyebrow">WAREHOUSE / REPORT VERSION</p>
      <h1>{data?.public_no??"报告版本"}</h1>{data&&<p>版本 {data.version} · <Tag>{states[data.state]}</Tag></p>}</div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在读取报告内容…</p>}
    {data&&!error&&<>
      {data.amend_reason&&<Panel title="本次修订原因"><p>{data.amend_reason}</p>
        {data.review_feedback&&<p className="notice">复核意见 · {data.review_feedback}</p>}</Panel>}
      {data.snapshot.sections.map((section:Row,s:number)=><Panel key={section.task_id} title={section.title}>
        <Table headers={["实物","检查项","原发布值","当前值","状态","证据"]} rows={section.results.map((result:Row,r:number)=>{
          const original=data.base_snapshot?.sections[s]?.results[r];
          return [result.item,result.label,original?valueOf(original):"—",valueOf(result),result.status,
            result.evidence_ids.map((media:string)=><a className="button" key={media}
              href={"/api/v1/media/"+media} target="_blank" rel="noreferrer">照片</a>)];
        })}/>
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
  </>;
}
