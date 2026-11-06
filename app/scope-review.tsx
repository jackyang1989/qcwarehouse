"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Action, Empty, ErrorBlock, Form, Panel, request, stamp, text, useLoad, usd, type Row } from "./ui";

export function ScopeReview({orderId,staff=false,onSave}:{orderId:string;staff?:boolean;onSave:()=>void}) {
  const {data,error,reload}=useLoad("/orders/"+orderId+"/scope-revisions");
  const updated=()=>{reload();onSave();};
  useEffect(()=>{
    if(!data)return;
    const anchor=location.hash.slice(1);
    if(anchor.startsWith("scope-")&&data.proposals.some((p:Row)=>"scope-"+p.id===anchor))
      document.getElementById(anchor)?.scrollIntoView({block:"start"});
  },[data]);
  const positions:Row[]=data?.positions??[];
  const nameOf=(id:string)=>{
    const item=positions.find(p=>p.id===id);
    return item?(staff?item.title["zh-CN"]??item.title.en:item.title.en)+" · "+item.position+(item.item_code?" · "+item.item_code:""):id;
  };
  return <Panel title={staff?"委托范围变更":"Inspection scope changes"}>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">{staff?"正在读取范围…":"Loading scope changes…"}</p>}
    {data&&!error&&<>
      {data.proposals.length===0&&<Empty>{staff?"暂无范围变更。":"No scope changes have been proposed."}</Empty>}
      {data.proposals.map((p:Row)=><div className="card" id={"scope-"+p.id} key={p.id}>
        <h3>{staff?"变更版本":"Change"} {p.revision} · {staff?({pending:"待客户确认",accepted:"已接受",stale:"已失效"} as Row)[p.state]:
          ({pending:"Awaiting your decision",accepted:"Accepted",stale:"No longer applicable"} as Row)[p.state]}</h3>
        <p>{p.reason}</p>
        <p>{staff?"保留检查位":"Retained inspection positions"}</p><ul>{p.proposed_positions.map((id:string)=><li key={id}>{nameOf(id)}</li>)}</ul>
        <p>{staff?"取消检查位":"Removed inspection positions"}</p><ul>{p.previous_positions.filter((id:string)=>!p.proposed_positions.includes(id))
          .map((id:string)=><li key={id}>{nameOf(id)}</li>)}</ul>
        <p>{staff?"拟审核退费金额":"Proposed refund for review"} · <strong>{usd(-p.adjustment_cents)}</strong></p>
        {p.accepted_at&&<p>{staff?"接受时间":"Accepted"} {stamp(p.accepted_at)}</p>}
        {p.refund_case&&<p><Link href={(staff?"/admin/tickets/":"/support/cases/")+p.refund_case.id}>
          {staff?"查看退款审核工单":"View refund review case"}</Link></p>}
        {!staff&&p.state==="pending"&&<Action primary run={async()=>{
          if(!window.confirm("Accept these exact inspection positions and the proposed refund review?"))return;
          await request("/scope-revisions/"+p.id+"/accept","POST",{revision:p.revision});updated();
        }}>Accept scope change</Action>}
      </div>)}
      {data.order.state==="awaiting_samples"&&<details className="card">
        <summary>{staff?"提出标准质检范围调整":"Propose a change to item-by-item inspection"}</summary>
        <p>{staff?"勾选继续质检的位置。对比和确认样服务需客服另行核价。":"Select the positions to retain. Comparison and reference services require a separate support review."}</p>
        <Form key={data.order.revision} label={staff?"生成变更预览":"Generate change preview"} run={async fields=>{
          const keep=fields.getAll("positions").map(String);
          const locked=positions.filter(p=>p.in_scope&&p.service!=="inspection").map(p=>p.id);
          await request("/orders/"+orderId+"/scope-revisions","POST",{
            revision:data.order.revision,reason:text(fields,"reason"),positions:[...keep,...locked],
          });updated();
        }}>
          {positions.filter(p=>p.in_scope).map(p=>p.service==="inspection"?<label className="check" key={p.id}>
            <input type="checkbox" name="positions" value={p.id} defaultChecked/>{nameOf(p.id)}
          </label>:<p key={p.id}>{nameOf(p.id)} · {staff?"保留原服务":"Original service retained"}</p>)}
          <label>{staff?"客户可见英文变更原因":"Reason for the change"}<textarea name="reason" required maxLength={1000}/></label>
        </Form>
      </details>}
    </>}
  </Panel>;
}
