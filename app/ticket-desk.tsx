"use client";

import Link from "next/link";
import { useState } from "react";
import { Action, Empty, ErrorBlock, Field, Form, Panel, request, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

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
      {entry.media_ids?.map((id:string)=><a className="button" key={id} href={"/api/v1/media/"+id} target="_blank" rel="noreferrer">
        {staff?"查看附件":"View attached photo"}</a>)}
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
      {isOpen(data.state)&&<Panel title="Reply to support">
        <Form key={sent} label="Send reply" run={async fields=>{
          const photo=fields.get("photo");
          const message={revision:data.revision,body:text(fields,"body")};
          const payload=photo instanceof File&&photo.size?fields:message;
          if(payload instanceof FormData)payload.set("revision",String(message.revision));
          const result=await request(api+"/messages","POST",payload);
          setSent(result.revision);reload();
        }}><label>Reply<textarea name="body" required minLength={2} maxLength={2000}/></label>
          <label>Evidence photo (optional)<input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/heic"/></label>
        </Form>
        {sent&&<p role="status">Your reply was sent.</p>}
      </Panel>}
    </>}
  </>;
}

export function StaffTicketQueue() {
  const [state,setState]=useState("");
  const [reference,setReference]=useState("");
  const params=new URLSearchParams();
  if(state)params.set("state",state);
  if(reference)params.set("reference",reference);
  const {data,error,reload}=useLoad("/staff/tickets"+(params.size?"?"+params:""));
  return <>
    <div className="page-head"><p className="eyebrow">OPERATIONS / SUPPORT</p><h1>客户工单</h1>
      <p className="muted">按下一处理时限查看工单、接手和回复。</p></div>
    <Panel title="工单队列">
      <div className="form inline-form"><label>工单状态<select value={state} onChange={e=>setState(e.target.value)}>
        <option value="">全部</option>{Object.entries(status).map(([value,names])=><option key={value} value={value}>{names[1]}</option>)}
      </select></label><button type="button" onClick={reload}>刷新</button></div>
      <Form inline label="查工单" run={async fields=>setReference(text(fields,"reference").toUpperCase())}>
        <Field name="reference" label="完整工单编号" required={false}/>
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
        {data.category==="identity_unclear"&&open&&<p><Link href={"/admin/orders#case-"+id}>打开专用认领核验</Link></p>}
      </Panel>
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
