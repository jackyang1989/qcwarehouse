"use client";

import Link from "next/link";
import { useState } from "react";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, Photo, request, Select, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";

const label=(s:string)=>({
  READY:"待领取",IN_PROGRESS:"检查中",SUBMITTED:"已提交",submitted:"待复核",qa_approved:"生成 PDF",pending:"待查询",
  received:"待识别",stored:"已在库",unmatched:"待认领",confirmed:"待报价",quoted:"待付款",paid:"已付款",packed:"已装箱",shipped:"已交接",
  delivered:"快递已签收",outbound:"已出库",returned:"已退回仓库",unknown:"未知",active:"跟踪中",in_transit:"在途",exception:"异常",
} as Record<string,string>)[s]??s;
const options=(rows:Row[],name="code")=>rows.map(r=>({id:r.id,label:String(r[name])}));
export function WarehouseDesk({path,actor}:{path:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/desk"),carriers=useLoad("/carriers");
  const [found,setFound]=useState<Row>(),[trackNo,setTrackNo]=useState(""),[carrier,setCarrier]=useState("");
  const [itemId,setItem]=useState("");
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载工作台…</p>;
  const canReceive=actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r));
  const canInspect=actor.roles.includes("inspector"),canReview=actor.roles.includes("reviewer"),canShip=actor.roles.includes("warehouse_admin");
  const item=data.items.find((i:Row)=>i.id===itemId);
  const locations=options(data.locations);
  const carrierOptions=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  const current=path.split("/")[2]??"overview";
  const groups=Object.values(data.tasks.reduce((g:Record<string,Row[]>,t:Row)=>{(g[t.order_id]??=[]).push(t);return g;},{})) as Row[][];
  return <><p className="eyebrow">WAREHOUSE OPERATIONS</p><h1>仓库工作台</h1>
    {current==="overview"&&<div className="grid">
      {canReceive&&<Link className="card" href="/wh/intake"><h2>收货与匹配</h2><p>{data.packages.length} 条包裹记录</p></Link>}
      {(canInspect||canReview)&&<Link className="card" href="/wh/inspection"><h2>质检与复核</h2><p>{data.tasks.length} 项检查任务 · {data.reports.length} 份待复核报告</p></Link>}
      {canShip&&<Link className="card" href="/wh/dispatch"><h2>发运与退回</h2><p>{data.batches.length} 个待处理批次</p></Link>}
    </div>}
    {current==="intake"&&canReceive&&<>
      <Panel title="搜索卖家运单">
        <Form inline label="搜索" run={async f=>{
          const n=text(f,"tracking"),c=text(f,"carrier");setTrackNo(n);setCarrier(c);
          setFound(await request("/staff/intake/lookup","POST",{tracking_no:n,...(c?{carrier_code:c}:{})}));
        }}><Field name="tracking" label="扫描条码或手动输入运单号"/><Select name="carrier" label="快递公司" choices={carrierOptions} required={false}/></Form>
        {found&&<div className="notice"><p>匹配结果 <strong>{({matched:"已关联订单",user_only:"已找到客户，待关联订单",unmatched:"待认领",ambiguous:"多个候选，请核对快递公司"} as Row)[found.match_state]}</strong></p>
          {found.receiving_code&&<p className="code">{found.receiving_code}</p>}
          {found.order_ids.length>0&&<p>关联订单数 {found.order_ids.length}</p>}
          {found.package_id&&<p>此运单已有实收入库记录。</p>}
        </div>}
        {found&&found.match_state!=="ambiguous"&&!found.package_id&&<Form label="确认实物到仓" run={async f=>{
          const photo=await upload(f.get("photo"),"intake_outer");
          const weight=text(f,"weight");
          const p=await request("/staff/intake/check-in","POST",{tracking_no:trackNo,...(carrier?{carrier_code:carrier}:{}),
            ...(found.advice_id?{advice_id:found.advice_id}:{}),...(weight?{weight_g:Number(weight)}:{}),outer_media_ids:[photo]});
          setFound({...found,package_id:p.id});reload();
        }}><Field name="weight" label="包裹实重（克）" type="number" min={1} required={false}/><Photo label="包裹外箱照片"/></Form>}
      </Panel>
      <Panel title="拆包登记">
        <Table headers={["包裹","运单","件数","状态"]} rows={data.packages.map((p:Row)=>[p.code,p.tracking_norm??"—",p.received_quantity,label(p.state)])}/>
        <Form label="逐件建档" run={async f=>{
          const p=data.packages.find((p:Row)=>p.id===text(f,"package"));
          const n=Number(text(f,"quantity"));
          if(!p || !Number.isInteger(n) || n<1 || n>100)throw new Error("请选择包裹与实际件数。");
          const items=Array.from({length:n},()=>({code:"S-"+crypto.randomUUID().replaceAll("-","").slice(0,12).toUpperCase(),location_id:text(f,"location")}));
          await request("/staff/packages/"+p.id+"/items","POST",{revision:p.revision,items});reload();
        }}><Select name="package" label="入仓包裹" value={found?.package_id} choices={data.packages.map((p:Row)=>({id:p.id,label:p.code+" · "+(p.tracking_norm??"")}))}/>
        <Field name="quantity" label="本次新增实物件数" type="number" min={1} max={100} value={1}/><Select name="location" label="目标库位" choices={locations}/></Form>
      </Panel>
      <Panel title="实物识别与委托绑定">
        <Table headers={["实物码","库存状态","库位"]} rows={data.items.map((i:Row)=>[i.code,label(i.custody_state),i.location??"—"])}/>
        <Form label="核对并绑定" run={async f=>{
          const p=data.positions.find((p:Row)=>p.id===text(f,"position"));
          if(!item||!p)throw new Error("请选择实物及对应委托位置。");
          const proof=await upload(f.get("photo"),"label_photo");
          await request("/staff/items/"+item.id+"/assign","POST",{revision:item.revision,order_line_id:p.order_line_id,expected_item_id:p.id,evidence_ids:[proof]});
          setItem("");reload();
        }}>
          <label>扫描或选择实物码<select required value={itemId} onChange={e=>setItem(e.target.value)}><option value="">选择实物</option>
            {data.items.filter((i:Row)=>i.org_id).map((i:Row)=><option key={i.id} value={i.id}>{i.code}</option>)}</select></label>
          <Select key={itemId} name="position" label="同一客户的委托位置" choices={data.positions.filter((p:Row)=>p.org_id===item?.org_id).map((p:Row)=>({id:p.id,label:p.public_no+" · "+p.title["zh-CN"]+" · "+p.position}))}/>
          <Photo label="商品标签核对照"/>
        </Form>
      </Panel>
      <Panel title="库位移动"><Form label="登记移动" run={async f=>{
        const i=data.items.find((i:Row)=>i.id===text(f,"item"));
        await request("/staff/storage/move","POST",{item_id:i.id,revision:i.revision,location_id:text(f,"location")});reload();
      }}><Select name="item" label="实物" choices={options(data.items)}/><Select name="location" label="新库位" choices={locations}/></Form></Panel>
    </>}
    {current==="inspection"&&(canInspect||canReview)&&<>
      {canInspect&&<Panel title="质检队列">
        {!groups.length&&<Empty>暂无可领取任务。付款并核对到齐后自动进入队列。</Empty>}
        {groups.map(ts=><div key={ts[0].order_id} className="card"><h3>{ts[0].public_no}</h3>
          <Table headers={["物件或组","服务","状态",""]} rows={ts.map(t=>[t.item_code??"比较组",t.title["zh-CN"],label(t.state),
            <Link href={"/wh/task/"+t.id}>查看检查项</Link>])}/>
          {ts.every(t=>t.state==="SUBMITTED")&&ts.some(t=>t.assignee_id===actor.id)&&<Action primary run={async()=>{
            const res=await request("/staff/inspection-tasks/"+ts[0].id);
            await request("/staff/orders/"+ts[0].order_id+"/report/submit","POST",{revision:res.order_revision,task_ids:ts.map(t=>t.id)});reload();
          }}>汇总并提交报告</Action>}
        </div>)}
      </Panel>}
      {canReview&&<Panel title="报告复核">
        {!data.reports.length&&<Empty>暂无报告等待复核。</Empty>}
        {data.reports.map((r:Row)=><div className="card" key={r.id}><h3>{r.public_no} · 版本 {r.version} · {label(r.state)}</h3>
          {r.snapshot.sections.map((s:Row)=><details key={s.task_id}><summary>{s.title}</summary>
            <Table headers={["实物","检查项","结果","证据"]} rows={s.results.map((x:Row)=>[x.item,x.label,String(x.typed_value??x.reason??x.status),
              x.evidence_ids.map((id:string)=><a key={id} href={"/api/v1/media/"+id} target="_blank" rel="noreferrer">照片 </a>)])}/>
          </details>)}
          {r.state==="submitted"&&<Form label="审批并生成 PDF" run={async f=>{
            if(!checked(f,"lang")||!checked(f,"evidence"))throw new Error("请核对英文及证据。");
            await request("/staff/reports/"+r.id+"/approve","POST",{revision:r.revision,checklist:["reviewed_en","evidence_checked"]});reload();
          }}><label className="check"><input type="checkbox" name="lang" required/>英文内容和范围已核对</label>
            <label className="check"><input type="checkbox" name="evidence" required/>证据及结果已核对</label></Form>}
        </div>)}
        <button type="button" onClick={reload}>刷新复核状态</button>
      </Panel>}
    </>}
    {current==="dispatch"&&canShip&&<>
      <Panel title="批次称重、报价和装箱">
        {!data.batches.length&&<Empty>客户确认的批次将显示在这里。</Empty>}
        {data.batches.map((b:Row)=><div key={b.id} className="card"><h3>{label(b.state)} · {b.action==="return_to_seller"?"寄回商家":b.action==="to_forwarder"?"寄集运仓":"国内转寄"}</h3>
          <p>{b.destination_snapshot.recipient} · {b.destination_snapshot.address}</p>
          <p className="code">{(b.items??[]).map((x:Row)=>x.code).join(", ")}</p>
          {b.state==="confirmed"&&<Form label="生成运费报价" inline run={async f=>{
            const split=Number(text(f,"split")||0),items=b.items.map((x:Row)=>x.id);
            if(split>=items.length)throw new Error("分包件数需小于总件数。");
            const parcels=split>0?[{item_ids:items.slice(0,split),weight_g:Number(text(f,"weight"))},
              {item_ids:items.slice(split),weight_g:Number(text(f,"second"))}]:[{item_ids:items,weight_g:Number(text(f,"weight"))}];
            if(parcels.some(p=>!p.weight_g))throw new Error("请填写每个包裹的实重。");
            await request("/staff/dispatch-batches/"+b.id+"/quote","POST",{revision:b.revision,rate_version_id:text(f,"rate"),parcels});reload();
          }}><Select label="运价版本" name="rate" value={data.rates[0]?.id} choices={data.rates.map((r:Row)=>({id:r.id,label:"版本 "+r.version}))}/>
            <Field label="首包实重（克）" name="weight" type="number" min={1}/><Field label="分包时首包件数" name="split" type="number" min={1} required={false}/>
            <Field label="第二包实重（克）" name="second" type="number" min={1} required={false}/>
          </Form>}
          {b.state==="paid"&&b.snapshot?.parcels.filter((p:Row)=>p.item_ids.every((id:string)=>!data.shipments.some((s:Row)=>s.batch_id===b.id&&s.item_ids.includes(id)))).map((p:Row,i:number)=>
            <Form key={i} label="确认装箱" run={async f=>{
              const photo=await upload(f.get("photo"),"dispatch");
              await request("/staff/dispatch-batches/"+b.id+"/parcels","POST",{revision:b.revision,quote_id:b.quote_id,item_ids:p.item_ids,weight_g:p.weight_g,packed_media_ids:[photo]});reload();
            }}><p>待装箱 {p.item_ids.length} 件 · {p.weight_g} g · {(b.items??[]).filter((x:Row)=>p.item_ids.includes(x.id)).map((x:Row)=>x.code).join(", ")}</p>
              <label className="check"><input type="checkbox" required/>已核对每件实物码与报价清单</label><Photo label="装箱照片"/></Form>)}
        </div>)}
      </Panel>
      <Panel title="实际交接及退回">
        {data.shipments.map((s:Row)=><div className="card" key={s.id}><h3>{label(s.state)} · {s.item_ids.length} 件</h3>
          {s.tracking_norm&&<p className="code">{s.tracking_norm}</p>}
          {s.state==="packed"&&<Form label="确认已交给快递" run={async f=>{
            const photo=await upload(f.get("photo"),"dispatch");
            await request("/staff/shipments/"+s.id+"/handover","POST",{revision:s.revision,item_ids:s.item_ids,carrier_code:text(f,"carrier"),
              tracking_no:text(f,"tracking"),evidence_ids:[photo],handed_at:new Date().toISOString()});reload();
          }}><Select name="carrier" label="实际承运商" choices={carrierOptions}/><Field name="tracking" label="实际寄出运单号"/>
            <label className="check"><input type="checkbox" required/>已核对清单并完成实物交接</label><Photo label="交接照片"/></Form>}
          {["shipped","delivered"].includes(s.state)&&s.item_ids.some((id:string)=>!s.returned_item_ids.includes(id))&&
            <details><summary>登记实际退回</summary><Form label="确认退回入库" run={async f=>{
              const ids=f.getAll("returned").map(String);
              if(!ids.length)throw new Error("选择本次实际收到的物件。");
              const photo=await upload(f.get("photo"),"dispatch");
              await request("/staff/shipments/"+s.id+"/receive-return","POST",{revision:s.revision,item_ids:ids,location_id:text(f,"location"),
                evidence_ids:[photo],received_at:new Date().toISOString()});reload();
            }}>{s.item_ids.filter((id:string)=>!s.returned_item_ids.includes(id)).map((id:string)=><label className="check code" key={id}><input type="checkbox" name="returned" value={id}/>{id}</label>)}
              <Select name="location" label="库位" choices={locations}/><Photo label="退回实物照片"/></Form></details>}
        </div>)}
      </Panel>
      {!!data.retain.length&&<Panel title="续存报价">
        {data.retain.map((i:Row)=><p key={i.id}>{i.code} <Action run={async()=>{await request("/staff/dispositions/"+i.id+"/storage-quote","POST",{});reload();}}>生成 30 天报价</Action></p>)}
      </Panel>}
    </>}
  </>;
}
export function TaskView({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/inspection-tasks/"+id);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载检查项…</p>;
  const writable=data.state==="IN_PROGRESS"&&data.assignee_id===actor.id;
  return <><Link href="/wh/inspection">← 质检队列</Link><h1>{data.public_no}</h1><p>{data.item_code??"对比组"} · {label(data.state)}</p>
    {data.state==="READY"&&actor.roles.includes("inspector")&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/start","POST",{revision:data.revision});reload();}}>领取并开始</Action>}
    {data.components.map((m:Row)=><Panel key={m.id} title={m.id==="main"?(data.item_code??"实物"):m.code}>
      {data.content.checks.map((c:Row)=>{
        const prev=data.results.find((r:Row)=>r.item_key===c.key&&r.component===m.id&&r.is_final);
        return <div className="card" key={c.key}><h3>{c.zh} · {c.label}</h3><p className="muted small">{c.method}{c.unit?" · "+c.unit:""}</p>
          {prev&&<p><Tag>{prev.status}</Tag> {String(prev.typed_value??prev.reason??"")}</p>}
          {writable&&<Form label="保存该项" run={async f=>{
            const status=text(f,"status"),value=text(f,"value"),reason=text(f,"reason"),photo=f.get("photo");
            const evidence=photo instanceof File&&photo.size?[await upload(photo,"shot")]:[];
            if(status==="RECORDED"&&!value)throw new Error("录入实际值，或明确选择无法检查。");
            const typed=c.type==="number"?Number(value):c.type==="boolean"?value==="true":value;
            await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[{
              item_key:c.key,component:m.id,attempt:(prev?.attempt??0)+1,status,is_final:true,method:c.method,
              ...(status==="RECORDED"?{typed_value:typed,...(c.unit?{unit:c.unit}:{})}:{}),
              ...(reason?{reason}:{}),...(evidence.length?{evidence_ids:evidence}:{}),
            }]});reload();
          }}>
            <Select name="status" label="结果" value="RECORDED" choices={[
              {id:"RECORDED",label:"已测量或观察"},{id:"OBSERVED_ISSUE",label:"发现问题"},{id:"NOT_OBSERVED",label:"未观察到问题"},
              {id:"NOT_TESTED",label:"未检查"},{id:"NOT_APPLICABLE",label:"不适用"},{id:"BLOCKED",label:"无法继续"}]}/>
            {c.type==="boolean"?<Select name="value" label="观察值" required={false} choices={[{id:"true",label:"是"},{id:"false",label:"否"}]}/>:
              <Field name="value" label="实际值" required={false} type={c.type==="number"?"number":"text"} step="any"/>}
            <Field name="reason" label="英文说明或缺测原因" required={false}/>
            <label>证据照片{c.evidence?"（提交前必填）":""}<input name="photo" type="file" accept="image/*"/></label>
          </Form>}
        </div>;
      })}
    </Panel>)}
    {writable&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/submit","POST",{revision:data.revision});location.assign("/wh/inspection");}}>提交此任务</Action>}
  </>;
}
export function LogisticsDesk() {
  const {data,error,reload}=useLoad("/staff/tracking");
  return <><h1>物流监控</h1>{error&&<ErrorBlock error={error}/>}<Panel title="入仓与寄出运输">
    <button type="button" onClick={reload}>刷新</button>
    {data?.rows.map((r:Row)=><details className="card" key={r.id}><summary>{r.tracking_norm} · {label(r.transport_state)} · {label(r.sync_state)}</summary>
      <p className="muted">最近同步 {stamp(r.last_success_at)}</p>
      {r.events?.length?<ol className="timeline">{r.events.map((e:Row)=><li key={e.id}>{stamp(e.occurred_at)} · {e.text}</li>)}</ol>:<Empty>暂无承运商中文轨迹。</Empty>}
    </details>)}
  </Panel></>;
}
export function AdminDesk({actor,path}:{actor:Row;path:string}) {
  const {data,error,reload}=useLoad("/staff/admin/desk"),terms=useLoad("/public/terms");
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载后台…</p>;
  const page=path.split("/")[2]??"overview";
  const superAdmin=actor.roles.includes("super_admin");
  return <><p className="eyebrow">QCW OPERATIONS</p><h1>管理后台</h1>
    {superAdmin&&data.warehouseAddressAlert&&<div className="notice">
      客户已领码，默认收件仓址待发布。<Link href="/admin/settings">设置仓址</Link>
    </div>}
    {page==="overview"&&<div className="grid">
      <Link className="card" href="/admin/orders"><h2>订单与工单</h2><p>{data.orders.length} 笔订单 · {data.tickets.length} 个工单</p></Link>
      <Link className="card" href="/admin/finance"><h2>收款与退款</h2><p>{data.payments.length} 笔支付 · {data.refunds.length} 项退款</p></Link>
      <Link className="card" href="/admin/settings"><h2>仓址与模板</h2><p>{data.addresses.length} 个仓址版本 · {data.templates.length} 个模板版本</p></Link>
    </div>}
    {page==="orders"&&<>
      <Panel title="检查订单"><Table headers={["订单","状态","创建"]} rows={data.orders.map((o:Row)=>[o.public_no,label(o.state),stamp(o.created_at)])}/></Panel>
      {data.manualQuotes.length>0&&<Panel title="人工询价">
        {data.manualQuotes.map((q:Row)=><details key={q.id} className="card">
          <summary>{q.public_no} · {q.state}</summary><p>{q.reason}</p>
          {(!q.assignee_id||q.assignee_id===actor.id)&&<Form label="发送人工报价" run={async f=>{
            const lines=q.lines.map((l:Row)=>({order_line_id:l.id,amount_cents:Math.round(Number(text(f,l.id+"_amount"))*100),business_days:Number(text(f,l.id+"_days"))}));
            await request("/staff/orders/"+q.order_id+"/quotes","POST",{revision:q.revision,lines,
              reason:text(f,"reason"),expires_at:new Date(text(f,"expiry")).toISOString(),terms_version_ids:terms.data?.terms.map((t:Row)=>t.id)??[]});reload();
          }}>
            {q.lines.map((l:Row)=><div key={l.id} className="inline-form">
              <Field name={l.id+"_amount"} label={l.title+" × "+l.quantity+" · 合计 USD"} type="number" min={0} step=".01"/>
              <Field name={l.id+"_days"} label="工作日" type="number" min={1} max={180}/></div>)}
            <Field name="expiry" label="报价到期时间" type="datetime-local"/><Field name="reason" label="报价依据"/>
          </Form>}
        </details>)}
      </Panel>}
      {data.claims.length>0&&<Panel title="未匹配包裹认领">
        {data.claims.map((c:Row)=><details key={c.id} className="card">
          <summary>{c.public_no} · {c.carrier_code} {c.tracking_no} · {c.decision??c.state}</summary>
          <div className="actions"><a href={"/api/v1/media/"+c.proof_id} target="_blank" rel="noreferrer">查看客户发货凭证</a>
          {c.outer_photo_ids.map((id:string)=><a key={id} href={"/api/v1/media/"+id} target="_blank" rel="noreferrer">核对仓库外箱照片</a>)}</div>
          {c.state==="open"&&<Form label="记录核验结论" run={async f=>{
            const decision=text(f,"decision");
            if(decision==="approve"&&!c.outer_photo_ids.length)throw new Error("先确认实物入库及外箱凭证。");
            await request("/staff/intake-claims/"+c.id+"/decision","POST",{decision,reason:text(f,"reason")});reload();
          }}><Select name="decision" label="归属核验" choices={[{id:"approve",label:"核实通过并认领"},{id:"reject",label:"驳回"}]}/>
            <Field name="reason" label="核验证据和原因"/></Form>}
        </details>)}
      </Panel>}
      <Panel title="客户及异常工单"><Table headers={["编号","主题","类别","状态"]} rows={data.tickets.map((t:Row)=>[t.public_no,t.subject,t.category,t.state])}/></Panel>
    </>}
    {page==="finance"&&<>
      <Panel title="支付与核对"><Table headers={["付款 ID","金额","状态","来源"]} rows={data.payments.map((p:Row)=>[p.id,usd(p.amount_cents),p.state,p.provider_ref??"—"])}/>
        {actor.roles.some((r:string)=>["support","super_admin"].includes(r))&&<Form label="建立退款申请" run={async f=>{
          await request("/staff/payments/"+text(f,"payment")+"/refunds","POST",{amount_cents:Math.round(Number(text(f,"amount"))*100),reason:text(f,"reason")});reload();
        }}><Select name="payment" label="实收付款" choices={data.payments.filter((p:Row)=>p.state==="succeeded").map((p:Row)=>({id:p.id,label:p.id+" · "+usd(p.amount_cents)}))}/>
        <Field name="amount" label="退款金额（USD）" type="number" min={.01} step=".01"/><Field name="reason" label="退款原因"/></Form>}
      </Panel>
      <Panel title="退款审批"><Table headers={["原因","金额","状态",""]} rows={data.refunds.map((r:Row)=>[r.reason,usd(r.amount_cents),r.state,
        r.state==="requested"&&superAdmin&&r.requested_by!==actor.id?<Action run={async()=>{await request("/staff/refunds/"+r.id+"/approve","POST",{revision:r.revision});reload();}}>审批退款</Action>:null])}/></Panel>
    </>}
    {page==="settings"&&<>
      {superAdmin&&<Panel title="公共收件仓址">
        <Table headers={["中文地址","英文地址","收件人","状态"]} rows={data.addresses.map((a:Row)=>[a.address_zh,a.address_en,a.contact_name,a.is_default?"默认":"历史"])}/>
        <Form label="发布新默认仓址" run={async f=>{await request("/staff/admin/warehouse-addresses","POST",Object.fromEntries(f));reload();}}>
          <Field name="address_zh" label="中文地址"/><Field name="address_en" label="英文地址"/>
          <Field name="contact_name" label="仓库收件人"/><Field name="contact_phone" label="仓库电话"/>
        </Form>
      </Panel>}
      <Panel title="类目及模板版本">
        <Table headers={["模板","版本","状态",""]} rows={data.templates.map((t:Row)=>[t.template_key,t.version,t.state,
          t.state==="IN_REVIEW"&&superAdmin?<Action run={async()=>{await request("/staff/admin/templates/"+t.id+"/publish","POST",{});reload();}}>独立审核发布</Action>:null])}/>
        {!!data.categories.length&&<Form label="提交模板审核" run={async f=>{
          const content=JSON.parse(text(f,"content"));
          await request("/staff/admin/templates","POST",{template_key:text(f,"key"),category_id:text(f,"category"),service_type_id:text(f,"service"),
            capability_ids:[text(f,"capability")],content});reload();
        }}><Field name="key" label="模板键"/><Select name="category" label="类目" choices={data.categories.map((c:Row)=>({id:c.id,label:c.labels["zh-CN"]}))}/>
        <Select name="service" label="服务类型" choices={data.services.map((x:Row)=>({id:x.id,label:x.labels["zh-CN"]}))}/>
        <Select name="capability" label="获批能力" choices={options(data.capabilities)}/>
        <label>模板 JSON<textarea name="content" required placeholder={'{"checks":[{"key":"width","label":"Width","zh":"宽度","type":"number","unit":"cm","method":"Ruler","required":true,"evidence":true}]}'}/></label></Form>}
      </Panel>
      <Panel title="作业异常"><Table headers={["作业","尝试","错误","下次"]} rows={data.jobErrors.map((j:Row)=>[j.type,j.attempts,j.last_error,stamp(j.next_attempt_at)])}/></Panel>
    </>}
  </>;
}
