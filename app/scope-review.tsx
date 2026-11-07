"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Action, Empty, ErrorBlock, Field, Form, Panel, Select, request, stamp, text, useLoad, usd, type Row } from "./ui";

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
  const mismatchedPositions=positions.filter(p=>p.in_scope&&(p.identity_state==="mismatch"||p.declared_fields?.mismatch_note));
  const comparePositions=positions.filter(p=>p.in_scope&&p.service==="compare");
  const unreceivedCompare=comparePositions.filter(p=>!p.item_code);
  const inspectionLineMap=new Map<string,string>();
  for(const p of positions) {
    if(p.service==="inspection"&&!inspectionLineMap.has(p.line_id)) {
      inspectionLineMap.set(p.line_id,staff?(p.title["zh-CN"]??p.title.en):p.title.en);
    }
  }
  const inspectionLines=[...inspectionLineMap.entries()].map(([id,label])=>({id,label}));
  const lineNameOf=(lineId:string)=>inspectionLineMap.get(lineId)??lineId;
  const nameOf=(id:string)=>{
    const item=positions.find(p=>p.id===id);
    return item?(staff?item.title["zh-CN"]??item.title.en:item.title.en)+" · "+item.position+(item.item_code?" · "+item.item_code:""):id;
  };
  return <Panel title={staff?"委托范围变更与收货差异":"Inspection scope & sample discrepancies"}>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">{staff?"正在读取范围…":"Loading scope changes…"}</p>}
    {data&&!error&&<>
      {mismatchedPositions.length>0&&<div className="card">
        <h3>{staff?"收货身份不符待确认":"Action needed: sample discrepancy reported"}</h3>
        {mismatchedPositions.map((m:Row)=><div key={m.id} className="notice">
          <p><strong>{nameOf(m.id)}</strong></p>
          <p className="small">
            {staff?"申报：":"Declared: "}
            {m.declared_fields?.size_label??m.declared_fields?.size??"—"} / {m.declared_fields?.color_declared??m.declared_fields?.color??"—"}
            {" · "}
            {staff?"实收标签：":"Received label: "}
            {m.declared_fields?.actual_label_info?.size_label??"—"} / {m.declared_fields?.actual_label_info?.color_found??"—"}
          </p>
          {m.declared_fields?.mismatch_note&&<p className="bad">{m.declared_fields.mismatch_note}</p>}
          {!staff&&<Form label="Submit discrepancy decision" run={async f=>{
            await request("/orders/"+orderId+"/mismatch-response","POST",{
              expected_item_id:m.id,
              decision:text(f,"decision"),
              note:text(f,"note")||undefined,
            });
            updated();
          }}>
            <Select name="decision" label="How should we proceed with this sample?" choices={[
              {id:"proceed_as_received",label:"Inspect the received sample as-is"},
              {id:"replace_sample",label:"Hold position open for a replacement sample"},
              {id:"return_sample",label:"Unlink this sample for return to seller"},
            ]}/>
            <Field name="note" label="Note for warehouse / support (optional)" required={false}/>
          </Form>}
        </div>)}
      </div>}
      {data.proposals.length===0&&<Empty>{staff?"暂无范围变更。":"No scope changes have been proposed."}</Empty>}
      {data.proposals.map((p:Row)=><div className="card" id={"scope-"+p.id} key={p.id}>
        <h3>{staff?"变更版本":"Change"} {p.revision} · {staff?({pending:"待客户确认",accepted:"已接受",stale:"已失效"} as Row)[p.state]:
          ({pending:"Awaiting your decision",accepted:"Accepted",stale:"No longer applicable"} as Row)[p.state]}</h3>
        <p>{p.reason}</p>
        <p>{staff?"保留检查位":"Retained inspection positions"}</p><ul>{p.proposed_positions.map((id:string)=><li key={id}>{nameOf(id)}</li>)}</ul>
        <p>{staff?"取消检查位":"Removed inspection positions"}</p><ul>{p.previous_positions.filter((id:string)=>!p.proposed_positions.includes(id))
          .map((id:string)=><li key={id}>{nameOf(id)}</li>)}</ul>
        {Array.isArray(p.proposed_additions)&&p.proposed_additions.length>0&&<>
          <p>{staff?"新增检查位":"Added inspection positions"}</p>
          <ul>{p.proposed_additions.map((a:Row,idx:number)=><li key={a.order_line_id??idx}>
            {lineNameOf(a.order_line_id)} · +{a.count} {staff?"件":"positions"}
          </li>)}</ul>
        </>}
        {p.adjustment_cents<=0
          ?<p>{staff?"拟审核退费金额":"Proposed refund for review"} · <strong>{usd(-p.adjustment_cents)}</strong></p>
          :<p>{staff?"需补付服务费差额":"Supplemental inspection charge"} · <strong>{usd(p.adjustment_cents)}</strong></p>}
        {p.accepted_at&&<p>{staff?"接受时间":"Accepted"} {stamp(p.accepted_at)}</p>}
        {p.refund_case&&<p><Link href={(staff?"/admin/tickets/":"/support/cases/")+p.refund_case.id}>
          {staff?"查看退款审核工单":"View refund review case"}</Link></p>}
        {!staff&&p.supplemental_charge&&!p.supplemental_charge.paid&&!p.supplemental_charge.voided&&<Action primary run={async()=>{
          const res=await request("/charges/"+p.supplemental_charge.id+"/checkout","POST",{quote_revision:p.supplemental_charge.quote_revision});
          if(res.checkout_url) location.assign(res.checkout_url);
          else updated();
        }}>Pay supplemental charge ({usd(p.supplemental_charge.amount_cents)})</Action>}
        {!staff&&p.state==="pending"&&<Action primary run={async()=>{
          if(!window.confirm("Accept these exact inspection positions and the proposed price adjustment?"))return;
          await request("/scope-revisions/"+p.id+"/accept","POST",{revision:p.revision});updated();
        }}>Accept scope change</Action>}
      </div>)}
      {data.order.state==="awaiting_samples"&&comparePositions.length===3&&unreceivedCompare.length>=1&&<details className="card">
        <summary>{staff?"三件对比改两件对比（3-to-2）":"Convert 3-item comparison to 2-item comparison"}</summary>
        <p className="muted">
          {staff?"当第三件对比样品迟迟未到且尚未开检时，可剔除未到样品改为两件对比，差额进入退款审核。":
            "If one of your 3 comparison samples is delayed, you can drop the unreceived position and proceed with a 2-item comparison. The price difference will be queued for refund review."}
        </p>
        <Form label={staff?"确认三改二":"Convert to 2-item comparison"} run={async f=>{
          await request("/orders/"+orderId+"/convert-to-two","POST",{
            revision:data.order.revision,
            expected_item_id:text(f,"expected_item_id"),
            reason:text(f,"reason")||undefined,
          });
          updated();
        }}>
          <Select name="expected_item_id" label={staff?"剔除未到样品位置":"Unreceived position to drop"} choices={unreceivedCompare.map(p=>({id:p.id,label:nameOf(p.id)}))}/>
          <Field name="reason" label={staff?"变更说明":"Reason (optional)"} required={false}/>
        </Form>
      </details>}
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
      {data.order.state==="awaiting_samples"&&inspectionLines.length>0&&<details className="card">
        <summary>{staff?"增加标准质检样品件数":"Add inspection sample positions"}</summary>
        <p className="muted">
          {staff?"开检前为现有标准质检服务行增补件数，客户确认并补付差额后自动生成新样品检查位。":
            "Add extra sample positions to your standard inspection line before inspection starts. Supplemental charges apply per added unit."}
        </p>
        <Form key={"add-"+data.order.revision} label={staff?"生成增补变更方案":"Propose additional sample positions"} run={async fields=>{
          const keep=positions.filter(p=>p.in_scope).map(p=>p.id);
          const count=Number(text(fields,"count"));
          const sizeLabel=text(fields,"size_label");
          await request("/orders/"+orderId+"/scope-additions","POST",{
            revision:data.order.revision,
            reason:text(fields,"reason"),
            positions:keep,
            additions:[{
              order_line_id:text(fields,"order_line_id"),
              count,
              ...(sizeLabel?{declared_fields:Array.from({length:count},()=>({size_label:sizeLabel}))}:{}),
            }],
          });
          updated();
        }}>
          <Select name="order_line_id" label={staff?"目标质检服务行":"Inspection service line"} choices={inspectionLines}/>
          <Field name="count" label={staff?"新增样品件数":"Additional sample count"} type="number" min={1} max={50} value={1}/>
          <Field name="size_label" label={staff?"尺码 / 规格备注（可选）":"Size / specification note (optional)"} required={false}/>
          <Field name="reason" label={staff?"客户可见英文增补说明":"Reason for adding samples"}/>
        </Form>
      </details>}
      {!staff&&data.order.state==="awaiting_samples"&&<details className="card">
        <summary>Extend sample arrival window</summary>
        <Form label="Request arrival extension" run={async f=>{
          await request("/orders/"+orderId+"/extend","POST",{
            revision:data.order.revision,
            extend_days:Number(text(f,"extend_days")),
            reason:text(f,"reason"),
          });
          updated();
        }}>
          <Field name="extend_days" label="Additional days needed (1–30)" type="number" min={1} max={30} value={7}/>
          <Field name="reason" label="Reason for extension"/>
        </Form>
      </details>}
    </>}
  </Panel>;
}
