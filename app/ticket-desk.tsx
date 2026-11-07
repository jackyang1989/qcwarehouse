"use client";

import Link from "next/link";
import { useState } from "react";
import { Action, Empty, ErrorBlock, Field, FileInput, Form, MediaButton, Panel, request, stamp, Table, Tag, text, usd, useLoad, type Row } from "./ui";

const status:Record<string,[string,string]>={
  open:["Open","待处理"],waiting_customer:["Awaiting your reply","待客户回复"],
  waiting_internal:["With support","待内部处理"],resolved:["Resolved","已解决"],closed:["Closed","已关闭"],
};
const categories:Record<string,string>={
  identity_unclear:"包裹认领",receipt_mismatch:"实物不符",measurement_dispute:"质检异议",
  return_info_incomplete:"退货资料",damage_or_loss:"丢损",payment_refund:"付款与退款",
  privacy_share:"隐私与分享",non_standard_quote:"非标咨询",
};
const isOpen=(state:string)=>state!=="resolved"&&state!=="closed";

function Conversation({events,staff=false}:{events:Row[];staff?:boolean}) {
  if(!events.length)return <Empty>{staff?"暂无工单记录。":"There are no messages yet."}</Empty>;
  return <ol className="timeline case-conversation">{events.map(entry=><li key={entry.id}>
    <div className="row"><strong>{staff?entry.kind==="internal_note"?"内部备注":entry.kind==="state_change"?"操作记录":
      entry.actor_type==="customer"?"客户":"客服":entry.actor_type==="customer"?"You":"QC Warehouse"}</strong>
      <small>{stamp(entry.created_at)}</small></div><p>{entry.body}</p>
      {entry.media_ids?.length>0&&<div className="actions" style={{marginTop:6}}>
        <MediaButton ids={entry.media_ids} label={staff?`查看附件照片 (${entry.media_ids.length})`:`View attached photo${entry.media_ids.length>1?`s (${entry.media_ids.length})`:""}`}/>
      </div>}
  </li>)}</ol>;
}
export function CustomerCase({id,order}:{id:string;order?:string}) {
  const api="/cases/"+id;
  const {data,error,reload}=useLoad(api+(order?"?"+new URLSearchParams({order}):""));
  const [sent,setSent]=useState<number>();
  return <>
    <div className="page-head"><Link href={order?"/orders/"+order:"/support"}>{order?"← Inspection order":"← Support"}</Link>
      <p className="eyebrow report-eyebrow">CLIENT WORKSPACE / SUPPORT</p><h1>{data?.subject??"Support case"}</h1>
      {data&&<p><span className="code">{data.public_no}</span> · <Tag>{status[data.state]?.[0]}</Tag></p>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
    {!error&&!data&&<p role="status">Loading your support case…</p>}
    {!error&&data&&<>
      <Panel title="Messages">
        {data.state==="waiting_customer"&&data.next_action_at&&<p className="notice">Please reply by {stamp(data.next_action_at)}.</p>}
        <Conversation events={data.events}/>
      </Panel>
      {data.incident&&<Panel title="Incident & Compensation Proposal">
        <dl className="location-facts">
          <div><dt>Incident type</dt><dd>{data.incident.kind}</dd></div>
          <div><dt>Status</dt><dd><Tag>{data.incident.status}</Tag></dd></div>
          <div><dt>Service fee refund</dt><dd>{usd(data.incident.service_refund_cents??0)}</dd></div>
          <div><dt>Compensation</dt><dd>{usd(data.incident.compensation_cents??0)}</dd></div>
        </dl>
        <p>{data.incident.summary_en}</p>
        {data.incident.payout_reference&&<p className="muted">Payout reference: <span className="code">{data.incident.payout_reference}</span> ({data.incident.payout_method})</p>}
        {data.incident.status==="customer_pending"&&<Form label="Submit compensation decision" run={async fields=>{
          await request("/me/incidents/"+data.incident.id+"/response","POST",{
            decision:text(fields,"decision"),
            note:text(fields,"note")||undefined,
          });
          reload();
        }}>
          <label>Decision<select name="decision" defaultValue="accept">
            <option value="accept">Accept compensation proposal</option>
            <option value="reject">Reject and request further review</option>
          </select></label>
          <Field name="note" label="Response note (optional)" required={false}/>
        </Form>}
      </Panel>}
      {isOpen(data.state)&&<Panel title="Reply to support">
        <Form key={sent} label="Send reply" run={async fields=>{
          const photo=fields.get("photo");
          const message={revision:data.revision,body:text(fields,"body")};
          const payload=photo instanceof File&&photo.size?fields:message;
          if(payload instanceof FormData)payload.set("revision",String(message.revision));
          const result=await request(api+"/messages","POST",payload);
          setSent(result.revision);reload();
        }}><label>Reply<textarea name="body" required minLength={2} maxLength={2000}/></label>
          <label>Evidence photo (optional)<FileInput name="photo"/></label>
        </Form>
        {sent&&<p role="status">Your reply was sent.</p>}
      </Panel>}
    </>}
  </>;
}

export function StaffTicketQueue() {
  const [state,setState]=useState("");
  const [category,setCategory]=useState("");
  const [assignee,setAssignee]=useState("");
  const [reference,setReference]=useState("");
  const params=new URLSearchParams();
  if(state)params.set("state",state);
  if(category)params.set("category",category);
  if(assignee)params.set("assignee",assignee);
  if(reference)params.set("reference",reference);
  const {data,error,reload}=useLoad("/staff/tickets"+(params.size?"?"+params:""));
  return <>
    <div className="page-head"><p className="eyebrow">OPERATIONS / SUPPORT</p><h1>客户工单</h1>
      <p className="muted">按下一处理时限、分类和指派状态查看工单、接手和回复。</p></div>
    <Panel title="工单队列">
      <div className="form inline-form">
        <label>工单状态<select value={state} onChange={e=>setState(e.target.value)}>
          <option value="">全部</option>{Object.entries(status).map(([value,names])=><option key={value} value={value}>{names[1]}</option>)}
        </select></label>
        <label>工单分类<select value={category} onChange={e=>setCategory(e.target.value)}>
          <option value="">全部分类</option>{Object.entries(categories).map(([value,labelText])=><option key={value} value={value}>{labelText}</option>)}
        </select></label>
        <label>指派范围<select value={assignee} onChange={e=>setAssignee(e.target.value)}>
          <option value="">全部</option>
          <option value="unassigned">未领取</option>
          <option value="mine">我负责的</option>
        </select></label>
        <button type="button" className="button" onClick={reload}>刷新</button>
      </div>
      <Form inline label="查工单" run={async fields=>setReference(text(fields,"reference").toUpperCase())}>
        <Field name="reference" label="完整工单或订单号" required={false}/>
      </Form>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在读取工单…</p>}
      {data&&!error&&<Table headers={["工单","分类","状态","关联订单","负责人","处理时限"]} rows={data.rows.map((entry:Row)=>[
        <Link className="case-queue-link" href={"/admin/tickets/"+entry.id}><strong className="code">{entry.public_no}</strong><br/>{entry.subject}</Link>,
        categories[entry.category]??entry.category,<Tag>{status[entry.state]?.[1]}</Tag>,entry.order_number??"—",
        entry.assignee??"未领取",stamp(entry.next_action_at),
      ])} empty="没有符合条件的工单。"/>}
    </Panel>
  </>;
}

export function StaffTicket({id,actor}:{id:string;actor:Row}) {
  const api="/staff/tickets/"+id;
  const {data,error,reload}=useLoad(api);
  const [saved,setSaved]=useState<number>();
  async function update(body:Row) {
    const result=await request(api+"/events","POST",{revision:data?.revision,...body});
    setSaved(result.revision);reload();
  }
  const open=data&&isOpen(data.state);
  const canWork=open&&(data.assignee_id===actor.id||actor.roles.includes("super_admin"));
  return <>
    <div className="page-head"><Link href="/admin/tickets">← 客户工单</Link>
      <p className="eyebrow report-eyebrow">OPERATIONS / CASE RECORD</p><h1>{data?.subject??"工单详情"}</h1>
      {data&&<p className="code">{data.public_no}</p>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!error&&!data&&<p role="status">正在读取工单…</p>}
    {data&&!error&&<>
      <Panel title="工单信息">
        <dl className="location-facts">
          <div><dt>分类</dt><dd>{categories[data.category]??data.category}</dd></div>
          <div><dt>状态</dt><dd><Tag>{status[data.state]?.[1]}</Tag></dd></div>
          <div><dt>关联订单</dt><dd className="code">{data.order_number?<Link href={"/admin/orders/"+data.order_number}>{data.order_number}</Link>:"—"}</dd></div>
          <div><dt>负责人</dt><dd>{data.assignee??"未领取"}</dd></div>
          <div><dt>下一处理时间</dt><dd>{stamp(data.next_action_at)}</dd></div>
          {data.inquiry&&<>
            <div><dt>咨询品类</dt><dd>{data.inquiry.category["zh-CN"]??data.inquiry.category.en}</dd></div>
            <div><dt>委托件数</dt><dd>{data.inquiry.sample_count}</dd></div>
            <div><dt>联系邮箱</dt><dd>{data.inquiry.contact_email}</dd></div>
          </>}
        </dl>
        {open&&!data.assignee_id&&<div className="actions"><Action primary run={()=>update({kind:"claim"})}>领取工单</Action></div>}
        {open&&(data.staff_candidates?.length??0)>0&&<Form inline label="指派/转派" run={async f=>{
          const target=text(f,"assignee_id");
          await update({kind:"assign",assignee_id:target||null,body:text(f,"body")||undefined});
        }}>
          <label>指派负责人<select name="assignee_id" defaultValue={data.assignee_id??""}>
            <option value="">未领取（释放指派）</option>
            {data.staff_candidates.map((c:Row)=><option key={c.id} value={c.id}>{c.display_name} ({c.email})</option>)}
          </select></label>
          <Field name="body" label="转派说明（可选）" required={false}/>
        </Form>}
        {data.category==="identity_unclear"&&open&&<p><Link href={"/admin/orders#case-"+id}>打开专用认领核验</Link></p>}
      </Panel>
      {data.incident&&<Panel title="关联丢损与赔付单">
        <dl className="location-facts">
          <div><dt>实物编码</dt><dd className="code">{data.incident.item_code??data.incident.item_id}</dd></div>
          <div><dt>类型</dt><dd>{data.incident.kind}</dd></div>
          <div><dt>状态</dt><dd><Tag>{data.incident.status}</Tag></dd></div>
          <div><dt>退质检费</dt><dd>{usd(data.incident.service_refund_cents??0)}</dd></div>
          <div><dt>赔偿金额</dt><dd>{usd(data.incident.compensation_cents??0)}</dd></div>
          <div><dt>客户决定</dt><dd>{data.incident.customer_decision??"待客户确认"}</dd></div>
        </dl>
        <p>{data.incident.summary_en}</p>
        {data.incident.internal_note&&<p className="muted">内部备注：{data.incident.internal_note}</p>}
      </Panel>}
      {data.account_recovery&&<Panel title="账号恢复与双人审批">
        <dl className="location-facts">
          <div><dt>恢复状态</dt><dd><Tag>{data.account_recovery.state}</Tag></dd></div>
          <div><dt>专属收件码</dt><dd className="code">{data.account_recovery.receiving_code??"—"}</dd></div>
          <div><dt>账号状态</dt><dd>{data.account_recovery.user_status??"—"}</dd></div>
          <div><dt>可最终执行时间</dt><dd>{stamp(data.account_recovery.executable_after)}</dd></div>
        </dl>
        <p className="muted">客户提交核验说明：{data.account_recovery.evidence_summary}</p>
        {["pending_review","awaiting_approval"].includes(data.account_recovery.state)&&<Form label={data.account_recovery.state==="pending_review"?"客服初审通过并提交超管审批":"超管独立复核批准"} run={async f=>{
          const decision=text(f,"decision");
          await request("/staff/account-recoveries/"+data.account_recovery.id+"/"+decision,"POST",{
            reason:text(f,"reason"),
            ...(f.get("emergency")==="on"?{emergency:true}:{}),
          });
          reload();
        }}>
          <label>审批结论<select name="decision" defaultValue="approve"><option value="approve">通过</option><option value="reject">驳回</option></select></label>
          <Field name="reason" label="核验依据与审批说明"/>
          {actor.roles.includes("super_admin")&&data.account_recovery.state==="awaiting_approval"&&
            <label className="check"><input type="checkbox" name="emergency"/> 紧急跳过 24 小时冷静期（仅超管经核实后勾选）</label>}
        </Form>}
        {data.account_recovery.state==="approved"&&actor.roles.includes("super_admin")&&
          <Action primary run={async()=>{await request("/staff/account-recoveries/"+data.account_recovery.id+"/execute","POST",{});reload();}}>执行账号恢复换绑并撤销旧会话</Action>}
      </Panel>}
      <Panel title="沟通与处理记录"><Conversation events={data.events} staff/></Panel>
      {canWork&&<>
        {data.inquiry?.portal_reply===false?<Panel title="访客跟进">
          <p>请通过咨询邮箱联系访客，并在内部备注记录跟进结果。</p>
        </Panel>:<Panel title="公开回复">
          <Form key={"reply-"+saved} label="发送给客户" run={async fields=>{
            const replyBy=text(fields,"reply_by");
            await update({kind:"reply",body:text(fields,"body"),...(replyBy?{reply_by:new Date(replyBy).toISOString()}:{})});
          }}><label>回复内容<textarea name="body" required minLength={2} maxLength={2000}/></label>
            <Field name="reply_by" label="要求客户回复的期限（可选，本地时间）" type="datetime-local" required={false}/>
          </Form>
        </Panel>}
        <Panel title="内部处理">
          <Form key={"note-"+saved} label="保存内部备注" run={async f=>update({kind:"internal_note",body:text(f,"body")})}>
            <label>内部备注<textarea name="body" required minLength={2} maxLength={2000}/></label>
          </Form>
          {data.category!=="identity_unclear"&&<Form label="结案" run={async f=>update({kind:"resolve",body:text(f,"body")})}>
            <label>结案原因<textarea name="body" required minLength={2} maxLength={2000}/></label>
          </Form>}
        </Panel>
      </>}
      {saved&&<p className="notice" role="status">工单操作已保存。</p>}
    </>}
  </>;
}
