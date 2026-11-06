"use client";

import Link from "next/link";
import { ScopeReview } from "./scope-review";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, Photo, request, RequestError, Select, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";
import { staffTabs } from "../packages/core/portal-routes";

const label=(s:string)=>({
  READY:"待领取",IN_PROGRESS:"检查中",SUBMITTED:"已提交",submitted:"待复核",qa_approved:"生成 PDF",pending:"待查询",
  checked_in:"已实收",received:"待识别",stored:"已在库",unmatched:"待认领",confirmed:"待报价",quoted:"待付款",paid:"已付款",packed:"已装箱",shipped:"已交接",
  delivered:"快递已签收",outbound:"已出库",returned:"已退回仓库",unknown:"未知",active:"跟踪中",in_transit:"在途",exception:"异常",
  delayed:"同步延迟",needs_carrier:"待补承运商",needs_verification:"待验证",not_supported:"不支持自动跟踪",picked_up:"已揽件",
  out_for_delivery:"派送中",returning:"退回途中",forwarded:"已转寄",
  approved:"已审批，待渠道确认",succeeded:"渠道已确认",failed:"渠道失败",processing:"处理中",partially_refunded:"部分退款",
  draft:"草稿",awaiting_payment:"待支付",awaiting_samples:"待收货",queued:"待质检",inspecting:"质检中",
  qa_review:"复核中",report_ready:"报告已发布",action_pending:"待处置",cancelled:"已取消",closed:"已关闭",on_hold:"暂停",
  return_to_seller:"退商家",to_forwarder:"寄集运仓",identified:"已识别",
} as Record<string,string>)[s]??s;
const options=(rows:Row[],name="code")=>rows.map(r=>({id:r.id,label:String(r[name])}));
export function WarehouseDesk({path,actor}:{path:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/desk"),carriers=useLoad("/carriers");
  const [lookup,setLookup]=useState<{tracking:string;carrier:string;result:Row}>();
  const [receiving,setReceiving]=useState(false);
  const [packageId,setPackageId]=useState("");
  const [intakeTracking,setIntakeTracking]=useState("");
  const packageDetail=useLoad(packageId?"/staff/packages/"+packageId:null);
  const selectedPackage=packageDetail.data?.parcel.id===packageId?packageDetail.data:undefined;
  const [itemCode,setItemCode]=useState("");
  const itemDetail=useLoad(itemCode?"/staff/items/by-code?"+new URLSearchParams({code:itemCode}):null);
  useEffect(()=>{
    if(path!=="/wh/intake")return;
    const params=new URLSearchParams(location.search);
    setPackageId(params.get("package")??"");
    setItemCode(params.get("item")??"");
    setIntakeTracking(params.get("tracking")??"");
  },[path]);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载工作台…</p>;
  const availableLinks=staffTabs("warehouse",actor.roles);
  const canReceive=actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r));
  const canInspect=actor.roles.includes("inspector"),canReview=actor.roles.includes("reviewer"),canShip=actor.roles.includes("warehouse_admin");
  const item=itemDetail.data?.item;
  const selectItem=(code:string)=>{setItemCode(code);itemDetail.reload();};
  const locations=options(data.locations);
  const carrierOptions=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  const current=path.split("/")[2]??"overview";
  const groups=Object.values(data.tasks.reduce((g:Record<string,Row[]>,t:Row)=>{(g[t.order_id]??=[]).push(t);return g;},{})) as Row[][];
  const heading={
    overview:["仓库概览","按岗位处理实物入库、检查与出库。"],
    intake:["收货与实物登记","扫描卖家原始运单。核对实收包裹后，再登记实物及库位。"],
    inspection:["质检与复核","领取检查任务、录入证据，独立复核后发布报告。"],
    dispatch:["出库与退回","核对客户逐件授权、报价、包裹交接与退回入库。"],
  }[current]??["仓库工作台",""];
  const overviewMetrics:[string,string,number,string][]=[
    ...(canReceive?[["/wh/intake","近期包裹",data.packages.length,"已登记到仓记录"]] as [string,string,number,string][]:[]),
    ...(canInspect||canReview?[["/wh/inspection","检查任务",data.tasks.length,"待领取、执行中与已提交"]] as [string,string,number,string][]:[]),
    ...(canReview?[["/wh/review","待处理报告",data.reports.length,"复核与生成 PDF"]] as [string,string,number,string][]:[]),
    ...(canShip?[["/wh/dispatch","发运批次",data.batches.length,"待报价、待付款及已付款"]] as [string,string,number,string][]:[]),
  ];
  return <><div className="page-head row"><div><p className="eyebrow">Warehouse operations</p><h1>{heading[0]}</h1><p className="muted">{heading[1]}</p></div>
    {current==="overview"&&canReceive&&<div className="head-actions"><Link className="button primary" href="/wh/scan">扫码查件</Link><Link className="button" href="/wh/intake">收货登记</Link></div>}
  </div>
    {current==="overview"&&<>
      <div className="metric-strip" aria-label="仓库作业摘要">{overviewMetrics.map(([href,title,value,detail])=>
        <Link className="metric" href={href} key={href}><span>{title}</span><strong>{value}</strong><small>{detail}</small></Link>)}</div>
      <div className="ops-columns">
        {canReceive?<Panel title="近期实收包裹">
          <Table headers={["包裹码","实物件数","状态"]} rows={data.packages.slice(0,6).map((parcel:Row)=>[
            <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>,parcel.received_quantity,<Tag>{label(parcel.state)}</Tag>
          ])} empty="暂无实收包裹。"/>
        </Panel>:<Panel title="近期质检任务">
          <Table headers={["订单","实物码","状态"]} rows={data.tasks.slice(0,6).map((task:Row)=>[
            <Link className="code" href={"/wh/task/"+task.id}>{task.public_no}</Link>,task.item_code??"—",<Tag>{label(task.state)}</Tag>
          ])} empty="暂无质检任务。"/>
        </Panel>}
        <Panel title="作业捷径"><div className="work-shortcuts">{availableLinks.filter(([href])=>href!=="/wh").map(([href,name])=>
          <Link className="button" key={href} href={href}>{name}<span aria-hidden="true">→</span></Link>)}</div></Panel>
      </div>
    </>}
    {current==="intake"&&canReceive&&<>
      <ol className="intake-stages" aria-label="收货步骤">
        <li><a href="#intake-waybill"><span>01</span>核对运单与外箱</a></li>
        <li><a href="#intake-unpack"><span>02</span>逐件建档与上架</a></li>
        <li><a href="#item-intake"><span>03</span>核对身份与委托</a></li>
      </ol>
      <section className="panel scan-panel" id="intake-waybill"><div className="section-heading"><span className="eyebrow">01 / 运单定位</span><h2>搜索卖家运单</h2><p className="muted">承运商签收后，仍需仓库核对外箱并确认实收。</p></div>
        <fieldset disabled={receiving} style={{display:"contents"}} onChange={()=>{setLookup(undefined);setPackageId("");}}>
          <Form inline label="搜索" run={async f=>{
            const tracking=text(f,"tracking"),carrier=text(f,"carrier");
            setLookup(undefined);setPackageId("");
            const result=await request("/staff/intake/lookup","POST",{tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})});
            setLookup({tracking,carrier,result});
            if(result.package_id)setPackageId(result.package_id);
          }}><Field key={intakeTracking} name="tracking" label="扫描条码或手动输入运单号" value={intakeTracking}/><Select name="carrier" label="快递公司" choices={carrierOptions} required={false}/></Form>
        </fieldset>
        {lookup&&<div className="notice"><p>运单 <strong className="code">{lookup.tracking}</strong></p>
          <p>匹配结果 <strong>{({matched:"已关联订单",user_only:"已找到客户，待关联订单",unmatched:"待认领",ambiguous:"多个候选，请核对快递公司"} as Row)[lookup.result.match_state]}</strong></p>
          {lookup.result.receiving_code&&<p className="code">{lookup.result.receiving_code}</p>}
          {lookup.result.order_ids.length>0&&<p>关联订单数 {lookup.result.order_ids.length}</p>}
          {lookup.result.package_id&&<p>此运单已有实收记录，已定位到拆包登记。</p>}
        </div>}
        {lookup&&lookup.result.match_state!=="ambiguous"&&!lookup.result.package_id&&<Form key={lookup.tracking+"-"+lookup.carrier} label="确认实物到仓" run={async f=>{
          setReceiving(true);
          try {
            const photo=await upload(f.get("photo"),"intake_outer");
            const weight=text(f,"weight");
            const parcel=await request("/staff/intake/check-in","POST",{tracking_no:lookup.tracking,...(lookup.carrier?{carrier_code:lookup.carrier}:{}),
              ...(lookup.result.advice_id?{advice_id:lookup.result.advice_id}:{}),...(weight?{weight_g:Number(weight)}:{}),outer_media_ids:[photo]});
            setLookup({...lookup,result:{...lookup.result,package_id:parcel.id}});setPackageId(parcel.id);reload();
          } finally {
            setReceiving(false);
          }
        }}><Field name="weight" label="包裹实重（克）" type="number" min={1} required={false}/><Photo label="包裹外箱照片"/></Form>}
      </section>
      <Panel title="02 / 拆包登记与上架" id="intake-unpack">
        <label>入仓包裹<select value={packageId} onChange={e=>setPackageId(e.target.value)}>
          <option value="">选择包裹</option>
          {packageId&&!data.packages.some((p:Row)=>p.id===packageId)&&<option value={packageId}>{selectedPackage?.parcel.code??"正在定位包裹"}</option>}
          {data.packages.map((p:Row)=><option key={p.id} value={p.id}>{p.code} · {p.tracking_norm??"—"}</option>)}
        </select></label>
        {packageId&&packageDetail.error&&<><ErrorBlock error={packageDetail.error}/><button type="button" onClick={packageDetail.reload}>重新读取包裹</button></>}
        {packageId&&!selectedPackage&&!packageDetail.error&&<p role="status">正在读取包裹…</p>}
        {selectedPackage&&<><p><Link className="code" href={"/wh/packages/"+selectedPackage.parcel.code}>{selectedPackage.parcel.code}</Link> · 已登记 {selectedPackage.parcel.received_quantity} 件</p>
          {selectedPackage.parcel.order_numbers.length>0&&<p>关联订单 {selectedPackage.parcel.order_numbers.join("、")}</p>}
          <Table headers={["实物码","库存状态","库位","操作"]} rows={selectedPackage.items.map((i:Row)=>[
            i.code,label(i.custody_state),i.location??"—",
            <a href="#item-intake" onClick={()=>selectItem(i.code)}>定位实物</a>,
          ])}/>
          <Form key={packageId} label="逐件建档" run={async f=>{
            const n=Number(text(f,"quantity"));
            if(!Number.isInteger(n) || n<1 || n>100)throw new Error("请填写实际件数。");
            const items=Array.from({length:n},()=>({code:"S-"+crypto.randomUUID().replaceAll("-","").slice(0,12).toUpperCase(),location_id:text(f,"location")}));
            await request("/staff/packages/"+selectedPackage.parcel.id+"/items","POST",{revision:selectedPackage.parcel.revision,items});
            packageDetail.reload();reload();
          }}><Field name="quantity" label="本次新增实物件数" type="number" min={1} max={100} value={1}/><Select name="location" label="目标库位" choices={locations}/></Form>
        </>}
      </Panel>
      <Panel title="03 / 实物识别与委托" id="item-intake">
        <div onChange={()=>setItemCode("")}>
          <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
            <Field name="item_code" label="扫描或输入实物码"/>
          </Form>
        </div>
        {!itemCode&&<Empty>扫描实物标签，或从上方包裹清单选择。按实物码查找可定位更早的入库记录。</Empty>}
        {itemCode&&itemDetail.error&&<><ErrorBlock error={itemDetail.error}/><button type="button" onClick={itemDetail.reload}>重新读取实物</button></>}
        {itemCode&&!item&&!itemDetail.error&&<p role="status">正在读取实物…</p>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} onSave={()=>{itemDetail.reload();packageDetail.reload();reload();}}/>}
      </Panel>
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
          {r.state==="submitted"&&<><Form label="审批并生成 PDF" run={async f=>{
            if(!checked(f,"lang")||!checked(f,"evidence"))throw new Error("请核对英文及证据。");
            await request("/staff/reports/"+r.id+"/approve","POST",{revision:r.revision,checklist:["reviewed_en","evidence_checked"]});reload();
          }}><label className="check"><input type="checkbox" name="lang" required/>英文内容和范围已核对</label>
            <label className="check"><input type="checkbox" name="evidence" required/>证据及结果已核对</label></Form>
            {!r.published_version&&<details className="card"><summary>退回检查员修改</summary>
              <Form label="记录原因并退回" run={async f=>{
                await request("/staff/reports/"+r.id+"/reject","POST",{revision:r.revision,reason:text(f,"reason")});reload();
              }}><label>具体修改要求<textarea name="reason" required minLength={4} maxLength={1200}/></label></Form>
            </details>}
          </>}
        </div>)}
        <button type="button" onClick={reload}>刷新复核状态</button>
      </Panel>}
    </>}
    {current==="dispatch"&&canShip&&<>
      <DispatchQueue/>
      {!!data.retain.length&&<Panel title="续存报价">
        {data.retain.map((i:Row)=><p key={i.id}>{i.code} <Action run={async()=>{await request("/staff/dispositions/"+i.id+"/storage-quote","POST",{});reload();}}>生成 30 天报价</Action></p>)}
      </Panel>}
    </>}
  </>;
}
function dispatchAction(action:string) {
  return action==="return_to_seller"?"寄回商家":action==="to_forwarder"?"寄集运仓":"国内转寄";
}
const dispatchQueueLabels:Record<string,string>={
  weighing:"待称重报价",payment:"待客户确认或付款",packing:"待装箱",
  handover:"待交接",shipped:"已交接",returned:"有退回记录",blocked:"付款需核对",
};
function DispatchQueue() {
  const search=useSearchParams();
  const state=search.get("state")??"weighing",reference=search.get("reference")?.trim()??"";
  const params=new URLSearchParams({state,...(reference?{reference}:{})});
  const {data,error,reload}=useLoad("/staff/dispatch-batches?"+params);
  return <Panel title={dispatchQueueLabels[state]??"发运队列"}>
    <div className="actions" aria-label="发运状态">
      {Object.entries(dispatchQueueLabels).map(([key,title])=><Link key={key} className="button"
        aria-current={state===key?"page":undefined} href={"/wh/dispatch?"+new URLSearchParams({state:key,...(reference?{reference}:{})})}>{title}</Link>)}
    </div>
    <form action="/wh/dispatch" method="get" className="form inline-form" key={state+reference}>
      <input type="hidden" name="state" value={state}/>
      <label>批次 ID 或实际运单<input name="reference" defaultValue={reference} maxLength={64}/></label>
      <button type="submit" className="primary">查批次</button>
      {reference&&<Link href={"/wh/dispatch?"+new URLSearchParams({state})}>清除编号</Link>}
      <button type="button" onClick={reload}>刷新</button>
    </form>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在查询批次…</p>}
    {data&&!error&&<Table headers={["批次","去向","待发实物","已装箱待交接","已交接","退回包裹","运单","退货截止","报价到期"]} rows={data.rows.map((batch:Row)=>[
      <Link className="code" href={"/wh/dispatch/"+batch.id}>{batch.id}</Link>,dispatchAction(batch.action),
      batch.remaining,batch.packed,batch.shipped,batch.returns,batch.waybills?.join("、")??"—",stamp(batch.return_deadline),stamp(batch.expires_at),
    ])} empty="这个状态下暂无符合条件的批次。"/>}
  </Panel>;
}
function PackParcel({batch,parcel,reload}:{batch:Row;parcel:Row;reload:()=>void}) {
  const expected=parcel.item_ids.map((id:string)=>batch.items.find((item:Row)=>item.id===id));
  if(expected.some((item:Row|undefined)=>!item))return <ErrorBlock error="报价内实物已变更，请刷新核对批次。"/>;
  return <div className="card">
    <h3>待装箱 · {parcel.item_ids.length} 件 · {parcel.weight_g} 克</h3>
    <ScanAndSubmit items={expected} label="确认装箱" run={async fields=>{
      const photo=await upload(fields.get("photo"),"dispatch");
      await request("/staff/dispatch-batches/"+batch.id+"/parcels","POST",{
        revision:batch.revision,quote_id:batch.quote_id,item_ids:parcel.item_ids,
        weight_g:parcel.weight_g,packed_media_ids:[photo],
      });reload();
    }}/>
  </div>;
}
function ScanAndSubmit({items,label,run,children}:{items:Row[];label:string;run:(fields:FormData)=>Promise<void>;children?:ReactNode}) {
  const [scanned,setScanned]=useState<string[]>([]);
  return <>
    <div className="card">
      <p><strong>逐件核对</strong> · {scanned.length} / {items.length}</p>
      <Form inline label="核对实物" run={async fields=>{
        const item=items.find(i=>i.code.toUpperCase()===text(fields,"scan").toUpperCase());
        if(!item)throw new Error("该实物不在本包裹清单，请核对包裹。");
        if(scanned.includes(item.id))throw new Error("该实物已核对。");
        setScanned(previous=>[...previous,item.id]);
      }}><Field name="scan" label="扫描或输入实物码"/></Form>
      <ul>{items.map(item=><li key={item.id}><span className="code">{item.code}</span> · {scanned.includes(item.id)?"已核对":"待核对"}</li>)}</ul>
    </div>
    <Form label={label} run={async fields=>{
      if(!items.length||scanned.length!==items.length||!items.every(item=>scanned.includes(item.id)))
        throw new Error("请先逐件扫描核对本包裹实物。");
      await run(fields);
    }}>
      {children}<Photo label={label==="确认装箱"?"装箱照片":"交接照片"}/>
      <label className="check"><input type="checkbox" required/>已完成逐件核对和对应实物操作</label>
    </Form>
  </>;
}
export function WarehouseDispatchBatch({id}:{id:string}) {
  const {data,error,reload}=useLoad("/staff/dispatch-batches/"+id);
  const carriers=useLoad("/carriers");
  const b=data?.batch;
  return <>
    <div className="page-head"><Link href="/wh/dispatch">← 出库队列</Link>
      <p className="eyebrow report-eyebrow">WAREHOUSE / DISPATCH BATCH</p><h1>发运批次</h1>
      <p className="code">{id}</p>{b&&<p><Tag>{label(b.state)}</Tag> · {dispatchAction(b.action)}</p>}</div>
    {error&&<ErrorBlock error={error}/>}<button type="button" onClick={reload}>刷新批次状态</button>
    {!data&&!error&&<p role="status">正在读取批次…</p>}
    {data&&!error&&<>
      <Panel title="客户授权去向">
        <p>{b.destination_snapshot.recipient} · {b.destination_snapshot.phone}</p>
        <p>{b.destination_snapshot.address}</p>
        {b.destination_snapshot.member_code&&<p>集运会员码 <span className="code">{b.destination_snapshot.member_code}</span></p>}
        {b.quote_id&&<p>报价版本 {b.quote_revision} · {usd(b.amount_cents)} · 到期 {stamp(b.expires_at)}</p>}
      </Panel>
      {(b.state==="confirmed"||b.renewable_quote)&&<Panel title="称重与逐包报价">
        {b.renewable_quote&&<p className="notice">旧报价已过期，客户未接受。请按实际包裹重新报价。</p>}
        <DispatchQuoteForm key={b.revision} batch={b} rates={data.rates} reload={reload}/>
      </Panel>}
      {b.state==="quoted"&&<p className="notice">等待客户接受报价及付款确认。</p>}
      {b.state==="paid"&&<Panel title="待装箱包裹">
        {b.snapshot.parcels.filter((p:Row)=>p.item_ids.every((itemId:string)=>!b.packed_item_ids.includes(itemId))).map((p:Row)=>
          <PackParcel key={b.quote_id+"-"+p.item_ids.join("-")} batch={b} parcel={p} reload={reload}/>)}
      </Panel>}
      <Panel title="包裹交接与退回">
        {!data.shipments.length&&<Empty>尚未生成已装箱包裹。</Empty>}
        {data.shipments.map((s:Row)=><div className="card" key={s.id}>
          <h3>{label(s.state)} · {s.weight_g} 克 · {s.items.length} 件</h3><p className="code">{s.id}</p>
          <Table headers={["实物码","退回实收"]} rows={s.items.map((i:Row)=>[i.code,i.received_at?stamp(i.received_at):"—"])}/>
          {s.state==="packed"&&<ScanAndSubmit key={s.revision} items={s.items} label="确认已交给快递" run={async fields=>{
            const photo=await upload(fields.get("photo"),"dispatch");
            await request("/staff/shipments/"+s.id+"/handover","POST",{
              revision:s.revision,item_ids:s.items.map((i:Row)=>i.id),carrier_code:text(fields,"carrier"),
              tracking_no:text(fields,"tracking"),evidence_ids:[photo],handed_at:new Date().toISOString(),
            });reload();
          }}>
            {carriers.error&&<ErrorBlock error={carriers.error}/>}
            <Select name="carrier" label="实际承运商" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
            <Field name="tracking" label="实际寄出运单号"/>
          </ScanAndSubmit>}
          {s.shipped_at&&<p>实际交接 {stamp(s.shipped_at)} · <span className="code">{s.carrier_code} {s.tracking_norm}</span></p>}
          {s.shipped_at&&<details><summary>查看中文物流轨迹 · {label(s.transport_state??"unknown")}</summary>
            <p>同步状态 {label(s.sync_state??"unknown")} · 更新 {stamp(s.tracking_updated_at)}</p>
            <ol className="timeline">{(s.tracking_events??[]).map((event:Row)=><li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>
            {!s.tracking_events?.length&&<Empty>尚无中文轨迹。</Empty>}
          </details>}
          {["shipped","delivered"].includes(s.state)&&s.items.some((i:Row)=>!i.received_at)&&<details>
            <summary>登记实际退回</summary><Form label="确认退回入库" run={async fields=>{
              const itemIds=fields.getAll("returned").map(String);
              if(!itemIds.length)throw new Error("选择本次实际收到的物件。");
              const photo=await upload(fields.get("photo"),"dispatch");
              await request("/staff/shipments/"+s.id+"/receive-return","POST",{
                revision:s.revision,item_ids:itemIds,location_id:text(fields,"location"),evidence_ids:[photo],received_at:new Date().toISOString(),
              });reload();
            }}>
              {s.items.filter((i:Row)=>!i.received_at).map((i:Row)=><label className="check code" key={i.id}>
                <input type="checkbox" name="returned" value={i.id}/>{i.code}
              </label>)}
              <Select name="location" label="库位" choices={options(data.locations)}/><Photo label="退回实物照片"/>
            </Form>
          </details>}
          <div className="actions">{s.evidence_ids.map((media:string)=><a className="button" key={media}
            href={"/api/v1/media/"+media} target="_blank" rel="noreferrer">查看作业照片</a>)}</div>
        </div>)}
      </Panel>
    </>}
  </>;
}
function DispatchQuoteForm({batch,rates,reload}:{batch:Row;rates:Row[];reload:()=>void}) {
  const [count,setCount]=useState(1);
  const items:Row[]=batch.items??[];
  const maxParcels=Math.min(50,items.length);
  const parcelNumbers=Array.from({length:count},(_,i)=>i+1);
  if(!rates.length) return <Empty>没有生效的运价版本，暂不可报价。</Empty>;
  if(!items.length) return <Empty>该批次没有待发运实物。</Empty>;
  return <Form label="提交称重并生成报价" run={async fields=>{
    const parcels=parcelNumbers.map(number=>({
      item_ids:items.filter(item=>Number(fields.get("parcel-"+item.id)??1)===number).map(item=>item.id),
      weight_g:Number(fields.get("weight-"+number)),
    }));
    if(parcels.some(p=>!p.item_ids.length||!Number.isInteger(p.weight_g)||p.weight_g<1))
      throw new Error("每个包裹至少包含一件指定实物，并填写实际克数。");
    await request("/staff/dispatch-batches/"+batch.id+"/quote","POST",{revision:batch.revision,rate_version_id:text(fields,"rate"),parcels});
    reload();
  }}>
    <Select label="运价版本" name="rate" value={rates[0]?.id} choices={rates.map(rate=>({id:rate.id,label:"版本 "+rate.version}))}/>
    {maxParcels>1&&<label>实际包裹数<select value={count} onChange={e=>setCount(Number(e.target.value))}>
      {Array.from({length:maxParcels},(_,i)=><option key={i+1}>{i+1}</option>)}
    </select></label>}
    {count>1&&<div className="dispatch-assignment" key={count}>{items.map(item=><Select key={item.id} name={"parcel-"+item.id}
      label={"实物 "+item.code+" 所在包裹"} choices={parcelNumbers.map(number=>({id:String(number),label:"包裹 "+number}))}/>)}</div>}
    <div className="dispatch-assignment">{parcelNumbers.map(number=><Field key={number} label={"包裹 "+number+" 实重（克）"}
      name={"weight-"+number} type="number" min={1}/>)}</div>
  </Form>;
}
export function TaskView({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/inspection-tasks/"+id);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载检查项…</p>;
  const writable=data.state==="IN_PROGRESS"&&data.assignee_id===actor.id;
  return <><div className="page-head row"><div><p className="eyebrow">Warehouse / Inspection task</p><h1 className="code">{data.public_no}</h1>
      <p className="muted">{data.item_code??"对比组"} · {label(data.state)}</p></div><Link className="button" href="/wh/inspection">返回质检队列</Link></div>
    {data.review_feedback&&<div className="notice"><strong>复核退回</strong><p>{data.review_feedback}</p></div>}
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
  return <><div className="page-head"><p className="eyebrow">Tracking / Operations</p><h1>物流监控</h1><p className="muted">查看入仓、退商家及寄集运仓的承运商中文轨迹。</p></div>{error&&<ErrorBlock error={error}/>}<Panel title="入仓与寄出运输">
    <button type="button" onClick={reload}>刷新</button>
    {data?.rows.map((r:Row)=><details className="card" key={r.id}><summary>{r.tracking_norm} · {label(r.transport_state)} · {label(r.sync_state)}</summary>
      <p className="muted">最近同步 {stamp(r.last_success_at)}</p>
      {r.events?.length?<ol className="timeline">{r.events.map((e:Row)=><li key={e.id}>{stamp(e.occurred_at)} · {e.text}</li>)}</ol>:<Empty>暂无承运商中文轨迹。</Empty>}
    </details>)}
  </Panel></>;
}
export function LogisticsConfiguration() {
  const {data,error,reload}=useLoad("/staff/admin/tracking/health");
  return <><div className="page-head"><p className="eyebrow">Tracking / Configuration</p><h1>物流接入</h1><p className="muted">核对自动查询、订阅回调与后台同步的当前配置状态。</p></div>
    <Panel title="快递100配置预检">
      <p>状态来自当前应用配置。承运商覆盖、接口连通性和额度需用实际账号联调确认。</p>
      <button type="button" onClick={reload}>重新读取配置</button>
      {error?<ErrorBlock error={error}/>:data?<Table headers={["检查项","配置状态"]} rows={[
        ["运单查询",data.queryConfigured?"已配置":"未配置"],
        ["HTTPS 回调地址",data.httpsCallbackConfigured?"已配置":"未配置"],
        ["订阅接入",data.subscribeConfigured?"已配置":"未配置"],
        ["自动同步配置",data.workerEnabled?"已启用":"未启用"],
      ]}/>:<p role="status">正在读取配置…</p>}
    </Panel>
  </>;
}
export function AdminDesk({actor,path}:{actor:Row;path:string}) {
  const {data,error,reload}=useLoad("/staff/admin/desk"),terms=useLoad("/public/terms");
  useEffect(()=>{
    if(!data||path!=="/admin/orders") return;
    function revealCase() {
      const id=location.hash.slice(1);
      if(!id.startsWith("case-")) return;
      const details=document.getElementById(id);
      if(details instanceof HTMLDetailsElement) {
        details.open=true;
        details.scrollIntoView({block:"start"});
      }
    }
    revealCase();
    window.addEventListener("hashchange",revealCase);
    return ()=>window.removeEventListener("hashchange",revealCase);
  },[data,path]);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载后台…</p>;
  const rawPage=path.split("/")[2]??"overview";
  const page=["catalog","categories","templates"].includes(rawPage)?"settings":rawPage;
  const superAdmin=actor.roles.includes("super_admin");
  const canReviewTemplate=actor.roles.some((r:string)=>["reviewer","super_admin"].includes(r));
  const canAuthorTemplate=actor.roles.some((r:string)=>["template_admin","super_admin"].includes(r));
  const links=staffTabs("admin",actor.roles);
  const heading={
    overview:["运营概览","查看当前工作范围的订单、资金、目录和运输入口。"],
    orders:["订单与工单","处理客户委托、认领核验和人工报价。"],
    finance:["收款与退款","核对支付尝试、原收费及退款审批状态。"],
    settings:[superAdmin?"仓址与模板":"检查模板","维护当前配置与版本记录。"],
  }[page]??["运营后台",""];
  const summaries:Record<string,[string,number,string]>={
    "/admin/orders":["最近检查订单",data.orders.length,`${data.tickets.length} 条近期工单`],
    "/admin/finance":["最近支付尝试",data.payments.length,`${data.refunds.length} 条近期退款`],
    "/admin/settings":["模板版本",data.templates.length,superAdmin?`${data.addresses.length} 个仓址版本`:"受控模板配置"],
  };
  const modules:Record<string,string>={
    "/admin/orders":"查看委托、询价与包裹认领。",
    "/admin/tickets":"查看负责人与期限，回复客户及记录内部处理。",
    "/admin/finance":"核对原收费、支付状态与退款审批。",
    "/admin/settings":superAdmin?"发布公共仓址，查看检查模板和作业异常。":"查看模板版本与提交审核。",
    "/admin/storage/locations":"维护物理库位、容量与启用状态。",
    "/admin/logistics":"查看入仓与出库运输的中文轨迹。",
    "/admin/integrations/logistics":"核对承运商接口与回调配置。",
    "/admin/operations":"核对失败作业、重试状态和恢复原因。",
    "/admin/audit":"按操作人、动作和业务对象查询历史记录。",
  };
  const activeLinks=links.filter(([href])=>href!=="/admin");
  const canHandleOrders=activeLinks.some(([href])=>href==="/admin/orders");
  const queue=canHandleOrders?[
    ...data.claims.filter((c:Row)=>c.state==="open").map((c:Row)=>({number:c.public_no,action:"核验包裹归属",detail:c.tracking_no,href:"/admin/orders#case-"+c.id})),
    ...data.manualQuotes.filter((q:Row)=>q.state==="requested").map((q:Row)=>({number:q.public_no,action:"人工报价",detail:q.reason,href:"/admin/orders#case-"+q.id})),
  ].slice(0,8):[];
  const requestedRefunds=activeLinks.some(([href])=>href==="/admin/finance")?data.refunds.filter((r:Row)=>r.state==="requested").length:0;
  return <><div className="page-head"><p className="eyebrow">OPERATIONS / 管理</p><h1>{heading[0]}</h1><p className="muted">{heading[1]}</p></div>
    {superAdmin&&data.warehouseAddressAlert&&<div className="notice">
      客户已领码，默认收件仓址待发布。<Link href="/admin/settings">设置仓址</Link>
    </div>}
    {page==="overview"&&<>
      <div className="metric-strip" aria-label="近期数据摘要">
        {activeLinks.filter(([href])=>summaries[href]).map(([href])=>{
          const [name,value,detail]=summaries[href];
          return <Link href={href} key={href} className="metric"><span>{name}</span><strong>{value}</strong><small>{detail}</small></Link>;
        })}
      </div>
      <div className={canHandleOrders?"ops-columns":"ops-columns single-column"}>
        {canHandleOrders&&<Panel title="客服待处理">
          <Table headers={["业务编号","待办","线索"]} rows={queue.map(entry=>[<Link className="code" href={entry.href}>{entry.number}</Link>,entry.action,entry.detail])}
            empty="近期队列没有待核验认领或待报价委托。"/>
        </Panel>}
        <Panel title="工作模块">
          <div className="module-list">
            {activeLinks.map(([href,title])=><Link key={href} href={href} className="module-row">
              <span><strong>{href==="/admin/settings"&&!superAdmin?"检查模板":title}</strong>
                <small>{href==="/admin/finance"&&requestedRefunds>0?`${requestedRefunds} 条退款申请待审批`:modules[href]}</small></span>
              <span aria-hidden="true">→</span>
            </Link>)}
          </div>
        </Panel>
      </div>
      {superAdmin&&<Panel title="后台作业异常">
        <Table headers={["作业","尝试次数","最近错误","下次尝试"]} rows={data.jobErrors.map((j:Row)=>[j.type,j.attempts,j.last_error,stamp(j.next_attempt_at)])} empty="近期无待处理的作业错误。"/>
      </Panel>}
    </>}
    {page==="orders"&&<>
      <StaffOrderList/>
      {data.manualQuotes.length>0&&<Panel title="人工询价" id="manual-quotes">
        {data.manualQuotes.map((q:Row)=><details key={q.id} className="card" id={"case-"+q.id}>
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
      {data.claims.length>0&&<Panel title="未匹配包裹认领" id="claims">
        {data.claims.map((c:Row)=><details key={c.id} className="card" id={"case-"+c.id}>
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
      <Panel title="客户及异常工单"><Table headers={["编号","主题","类别","状态"]} rows={data.tickets.map((t:Row)=>[<Link className="code" href={"/admin/tickets/"+t.id}>{t.public_no}</Link>,t.subject,t.category,t.state])}/></Panel>
      <OrderRefundDesk/>
    </>}
    {page==="finance"&&<>
      <Panel title="支付与核对"><Table headers={["付款 ID","金额","状态","来源"]} rows={data.payments.map((p:Row)=>[p.id,usd(p.amount_cents),p.state,p.provider_ref??"—"])}/>
        {actor.roles.some((r:string)=>["support","super_admin"].includes(r))&&<Form label="建立退款申请" run={async f=>{
          await request("/staff/payments/"+text(f,"payment")+"/refunds","POST",{amount_cents:Math.round(Number(text(f,"amount"))*100),reason:text(f,"reason")});reload();
        }}><Select name="payment" label="实收付款" choices={data.payments.filter((p:Row)=>p.state==="succeeded").map((p:Row)=>({id:p.id,label:p.id+" · "+usd(p.amount_cents)}))}/>
        <Field name="amount" label="退款金额（USD）" type="number" min={.01} step=".01"/><Field name="reason" label="退款原因"/></Form>}
      </Panel>
      <Panel title="退款审批与渠道结果"><Table headers={["原收费","申请原因","金额","退款状态","渠道凭据","操作"]} rows={data.refunds.map((r:Row)=>[
        <div><strong>{r.public_no??({inspection:"质检费",dispatch:"运费",storage:"保管费"} as Row)[r.purpose]}</strong><br/><small className="code">{r.payment_id}</small></div>,
        r.reason,usd(r.amount_cents),r.state==="requested"?"待独立审批":label(r.state),r.provider_ref??"—",
        r.state==="requested"&&superAdmin?(r.requested_by===actor.id?<small>等待另一位超管审批</small>:<RefundApproval refund={r} reload={reload}/>):null,
      ])} empty="近期没有退款记录。"/></Panel>
    </>}
    {page==="settings"&&<>
      {superAdmin&&<Panel title="公共收件仓址">
        <Table headers={["中文地址","英文地址","收件人","状态"]} rows={data.addresses.map((a:Row)=>[a.address_zh,a.address_en,a.contact_name,a.is_default?"默认":"历史"])}/>
        <Form label="发布新默认仓址" run={async f=>{await request("/staff/admin/warehouse-addresses","POST",Object.fromEntries(f));reload();}}>
          <Field name="address_zh" label="中文地址"/><Field name="address_en" label="英文地址"/>
          <Field name="contact_name" label="仓库收件人"/><Field name="contact_phone" label="仓库电话"/>
        </Form>
      </Panel>}
      <Panel title="品类准入与开关（PAGE-M09）">
        <Table headers={["标识","中文名称","英文名称","状态","准入材料","操作"]} rows={data.categories.map((c:Row)=>[
          <span className="code">{c.slug}</span>,c.labels["zh-CN"],c.labels.en,<Tag>{c.status}</Tag>,
          c.admission_snapshot?`SOP: ${c.admission_snapshot.sop_ref??(c.admission_snapshot.demo?"演示夹具":"待补")}`:"未提交准入",
          superAdmin&&c.status!=="ACTIVE"?<Form inline label="激活类目" run={async f=>{
            await request("/staff/admin/categories/"+c.id+"/status","POST",{
              status:"ACTIVE",
              admission_snapshot:{sop_ref:text(f,"sop_ref"),pilot_evidence:text(f,"pilot_evidence"),training_completed:true,equipment_verified:true},
            });reload();
          }}><Field name="sop_ref" label="SOP 编号"/><Field name="pilot_evidence" label="试运行记录"/></Form>:
          superAdmin&&c.status==="ACTIVE"?<Action run={async()=>{
            await request("/staff/admin/categories/"+c.id+"/status","POST",{status:"PAUSED"});reload();
          }}>暂停可售</Action>:null,
        ])} empty="暂无类目记录。"/>
        {canAuthorTemplate&&<Form inline label="新建规划类目" run={async f=>{
          await request("/staff/admin/categories","POST",{slug:text(f,"slug"),labels:{en:text(f,"en"),"zh-CN":text(f,"zh")}});reload();
        }}><Field name="slug" label="类目编码"/><Field name="zh" label="中文名称"/><Field name="en" label="英文名称"/></Form>}
      </Panel>
      <Panel title="检验能力准入与独立审批（FEAT-M11）">
        <Table headers={["能力编码","检验方法","状态","操作"]} rows={(data.allCapabilities??data.capabilities).map((cap:Row)=>[
          <span className="code">{cap.code}</span>,cap.method,
          cap.revoked_at?"已撤销":cap.approved_by?"已批准":"待独立审批",
          !cap.revoked_at&&!cap.approved_by&&canReviewTemplate&&cap.approval?.author_id!==actor.id?
            <Action run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/approve","POST",{});reload();}}>独立批准能力</Action>:
          !cap.revoked_at&&cap.approved_by&&superAdmin?
            <Action run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/revoke","POST",{reason:"后台调整能力准入"});reload();}}>撤销能力</Action>:null,
        ])} empty="暂无检验能力记录。"/>
        {canAuthorTemplate&&<Form inline label="提交检验能力" run={async f=>{
          await request("/staff/admin/capabilities","POST",{code:text(f,"code"),method:text(f,"method")});reload();
        }}><Field name="code" label="能力编码"/><Field name="method" label="标准方法与工具说明"/></Form>}
      </Panel>
      <Panel title="受控模板版本与独立审核发布（PAGE-M18）">
        <Table headers={["模板键","版本","状态","关联能力","检查项预览","操作"]} rows={data.templates.map((t:Row)=>[
          <span className="code">{t.template_key}</span>,t.version,<Tag>{t.state}</Tag>,
          (t.capability_codes??[]).join(", ")||"—",
          t.content?.checks?`${t.content.checks.length} 项（${t.content.checks.map((c:Row)=>c.zh||c.key).join("、")}）`:"—",
          t.state==="IN_REVIEW"&&canReviewTemplate&&t.author_id!==actor.id?
            <Action run={async()=>{await request("/staff/admin/templates/"+t.id+"/publish","POST",{});reload();}}>独立审核发布</Action>:
          t.state==="IN_REVIEW"&&t.author_id===actor.id?<small>等待非作者独立复核</small>:null,
        ])} empty="暂无模板版本。"/>
        {!!data.categories.length&&canAuthorTemplate&&<Form label="提交模板审核" run={async f=>{
          const content=JSON.parse(text(f,"content"));
          await request("/staff/admin/templates","POST",{template_key:text(f,"key"),category_id:text(f,"category"),service_type_id:text(f,"service"),
            capability_ids:[text(f,"capability")],content});reload();
        }}><Field name="key" label="模板键"/><Select name="category" label="类目" choices={data.categories.map((c:Row)=>({id:c.id,label:c.labels["zh-CN"]}))}/>
        <Select name="service" label="服务类型" choices={data.services.map((x:Row)=>({id:x.id,label:x.labels["zh-CN"]}))}/>
        <Select name="capability" label="获批能力" choices={options(data.capabilities)}/>
        <label>模板 JSON<textarea name="content" required placeholder={'{"checks":[{"key":"width","label":"Width","zh":"宽度","type":"number","unit":"cm","method":"Ruler","required":true,"evidence":true}]}'}/></label></Form>}
      </Panel>
      {superAdmin&&<Panel title="可售套餐与版本化价格（PAGE-M09）">
        <Table headers={["SKU","名称","价格版本","计价规则","状态"]} rows={(data.offers??[]).map((o:Row)=>[
          <span className="code">{o.sku_code}</span>,o.title?.["zh-CN"]??o.title?.en??o.sku_code,
          o.price_version?`v${o.price_version}`:"—",
          o.rules?`${o.rules.minimum}–${o.rules.maximum} 件 · ${usd(o.rules.package_cents??o.rules.unit_cents)} · ${o.rules.business_days} 工作日`:"—",
          o.enabled?"可售":"已停用",
        ])} empty="暂无可售套餐。"/>
        {!!(data.offers??[]).length&&<Form inline label="发布新价格版本" run={async f=>{
          const sku=text(f,"sku"),offer=(data.offers??[]).find((o:Row)=>o.sku_code===sku);
          const cents=Math.round(Number(text(f,"price"))*100),days=Number(text(f,"days"));
          const isPackage=offer?.rules?.package_cents!=null;
          await request("/staff/admin/skus/"+sku+"/prices","POST",{rules:{
            minimum:offer?.rules?.minimum??1,maximum:offer?.rules?.maximum??100,
            ...(isPackage?{package_cents:cents}:{unit_cents:cents}),business_days:days,
          }});reload();
        }}>
          <Select name="sku" label="套餐 SKU" choices={(data.offers??[]).map((o:Row)=>({id:o.sku_code,label:o.sku_code}))}/>
          <Field name="price" label="新价格（USD）" type="number" min={.01} step=".01"/>
          <Field name="days" label="承诺工作日" type="number" min={1} max={180} value={3}/>
        </Form>}
      </Panel>}
      {superAdmin&&<Panel title="作业异常"><Table headers={["作业","尝试","错误","下次"]} rows={data.jobErrors.map((j:Row)=>[j.type,j.attempts,j.last_error,stamp(j.next_attempt_at)])}/></Panel>}
    </>}
  </>;
}

function orderSearchParams(params:Readonly<URLSearchParams>) {
  const accepted=["query","state","from","to","test","limit","cursor"];
  return new URLSearchParams([...params].filter(([key,value])=>accepted.includes(key)&&value!==""));
}
function StaffOrderList() {
  const params=orderSearchParams(useSearchParams());
  const suffix=params.size?"?"+params:"";
  const result=useLoad("/staff/orders"+suffix);
  const next=new URLSearchParams(params);
  if(result.data?.next_cursor)next.set("cursor",result.data.next_cursor);
  const first=new URLSearchParams(params);first.delete("cursor");
  return <Panel title="检查订单">
    <form className="form" method="get" action="/admin/orders" key={params.toString()}>
      <div className="inline-form">
        <label>订单号、卖家运单、实物码或客户邮箱<input name="query" defaultValue={params.get("query")??""} maxLength={254}/></label>
        <label>状态<select name="state" defaultValue={params.get("state")??""}>
          <option value="">全部</option>{["draft","awaiting_payment","awaiting_samples","queued","inspecting","qa_review","report_ready","action_pending","on_hold","closed","cancelled"]
            .map(value=><option key={value} value={value}>{label(value)}</option>)}
        </select></label>
        <label>订单类型<select name="test" defaultValue={params.get("test")??"all"}>
          <option value="all">全部</option><option value="production">正式单</option><option value="test">测试单</option>
        </select></label>
      </div>
      <div className="inline-form">
        <label>创建日期从（UTC）<input name="from" type="date" defaultValue={params.get("from")??""}/></label>
        <label>创建日期至（UTC，含当天）<input name="to" type="date" defaultValue={params.get("to")??""}/></label>
        <button className="primary" type="submit">筛选订单</button><Link href="/admin/orders">清除筛选</Link>
      </div>
    </form>
    {result.error&&<ErrorBlock error={result.error}/>}
    {!result.data&&!result.error&&<p role="status">正在查询订单…</p>}
    {!result.error&&result.data&&<>
      <Table headers={["订单","状态","类型","创建时间"]} rows={result.data.rows.map((o:Row)=>[
        <Link className="code" href={"/admin/orders/"+o.public_no+suffix}>{o.public_no}</Link>,label(o.state),
        o.is_test?"测试单":"正式单",stamp(o.created_at),
      ])} empty="没有符合条件的订单。"/>
      <div className="actions">
        {params.has("cursor")&&<Link className="button" href={"/admin/orders"+(first.size?"?"+first:"")}>回到首批</Link>}
        {result.data.next_cursor&&<Link className="button" href={"/admin/orders?"+next}>下一批 →</Link>}
        <button type="button" onClick={result.reload}>刷新</button>
      </div>
    </>}
  </Panel>;
}

export function StaffOrder({number}:{number:string}) {
  const params=orderSearchParams(useSearchParams());
  const {data,error,reload}=useLoad("/staff/orders/by-number/"+number);
  const milestones=data?[
    ["订单创建",data.created_at],["质检付款确认",data.paid_at],["样品齐备",data.samples_ready_at],
    ["报告已发布",data.report_published_at],["订单关闭",data.closed_at],
  ].filter(([,at])=>at):[];
  return <>
    <div className="page-head"><Link href={"/admin/orders"+(params.size?"?"+params:"")}>← 检查订单</Link>
      <p className="eyebrow report-eyebrow">OPERATIONS / INSPECTION ORDER</p><h1 className="code">{number}</h1>
      {data&&<p><Tag>{label(data.order.state)}</Tag> · 版本 {data.order.revision}</p>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取订单…</p>}
    {data&&!error&&<>
      <div className="ops-columns">
        <Panel title="委托范围">
          <Table headers={["服务","订购件数","当前检查位"]} rows={data.lines.map((l:Row)=>[
            l.title["zh-CN"]??l.title.en,l.quantity,l.current_positions,
          ])} empty="该订单暂无委托明细。"/>
          {data.sla_due_at&&<p>预计作业截止 {stamp(data.sla_due_at)}</p>}
        </Panel>
        <Panel title="履约节点">
          <dl className="location-facts">{milestones.map(([name,at])=><div key={name}><dt>{name}</dt><dd>{stamp(at)}</dd></div>)}</dl>
          {data.customer&&<>
            <hr className="divider"/>
            <p><strong>客户账号</strong> · <span className="code">{data.customer.receiving_code}</span> · {data.customer.email??"—"} · <Tag>{data.customer.status}</Tag></p>
            <Form inline label="更新账号状态" run={async f=>{
              await request("/staff/users/"+data.customer.id+"/status","POST",{status:text(f,"status"),reason:text(f,"reason")});
              reload();
            }}>
              <Select name="status" label="状态" value={data.customer.status} choices={[
                {id:"active",label:"正常 (active)"},
                {id:"restricted",label:"限制新单与付款 (restricted)"},
                {id:"disabled",label:"停用并撤销会话 (disabled)"},
              ]}/>
              <Field name="reason" label="处理原因"/>
            </Form>
          </>}
        </Panel>
      </div>
      <Panel title="实物及库位"><Table headers={["实物编号","检查位置","身份","保管状态","库位"]} rows={data.items.map((i:Row)=>[
        <span className="code">{i.code}</span>,i.position,label(i.identity_state),label(i.custody_state),i.location??"—",
      ])} empty="暂无实物绑定。"/></Panel>
      <Panel title="入仓包裹"><Table headers={["卖家运单","承运商","运输状态","仓内包裹","实收时间"]} rows={data.parcels.map((p:Row)=>[
        <span className="code">{p.tracking_norm}</span>,p.carrier_code??"—",label(p.transport_state),p.code??"待实收",stamp(p.received_at),
      ])} empty="暂无关联卖家运单。"/></Panel>
      <Panel title="已交接发运"><Table headers={["发运运单","处置类型","状态","交接时间"]} rows={data.shipments.map((s:Row)=>[
        <span className="code">{s.tracking_norm}</span>,label(s.action),label(s.state),stamp(s.shipped_at),
      ])} empty="暂无已交接运单。"/></Panel>
      <Panel title="关联工单与阻断">
        <Table headers={["编号","主题","状态"]} rows={data.tickets.map((t:Row)=>[
          <Link className="code" href={"/admin/tickets/"+t.id}>{t.public_no}</Link>,t.subject,label(t.state),
        ])} empty="暂无关联工单。"/>
        <Table headers={["阻断原因","开始","解除"]} rows={data.blocks.map((b:Row)=>[
          b.reason,stamp(b.opened_at),b.resolved_at?stamp(b.resolved_at):"尚未解除",
        ])}/>
      </Panel>
      <ScopeReview orderId={data.order.id} staff onSave={reload}/>
      <OrderRefundDesk initialOrder={number}/>
      <Panel title="订单操作记录"><Table headers={["时间","操作","执行者"]} rows={data.activity.map((a:Row)=>[
        stamp(a.at),({create_draft:"建立草稿",edit_draft:"修改草稿",submit_order:"提交委托",cancel_order:"取消订单",
          propose_scope:"提出范围调整",accept_scope:"接受范围调整"} as Row)[a.action]??a.action,
        a.display_name??({staff:"员工",customer:"客户",system:"系统"} as Row)[a.actor_type],
      ])} empty="暂无订单操作记录。"/></Panel>
    </>}
  </>;
}

function OrderRefundDesk({initialOrder=""}:{initialOrder?:string}) {
  const [number,setNumber]=useState(initialOrder);
  const [receipt,setReceipt]=useState<{order:string;id:string}>();
  const source=useLoad(number?"/staff/orders/by-number/"+number+"/refund-options":null);
  const options:Row[]=source.data?.rows??[];
  return <Panel title="按原质检单申请退款">
    {!initialOrder&&<Form inline label="查原订单" run={async f=>{
      const value=text(f,"order").toUpperCase();
      if(!/^QW-[A-F0-9]+$/.test(value)) throw new Error("请输入完整的 QW 订单号。");
      setNumber(value);source.reload();
    }}><Field name="order" label="质检订单号"/></Form>}
    {number&&!source.data&&!source.error&&<p role="status">正在查询原收费…</p>}
    {source.error&&<ErrorBlock error={source.error}/>}
    {source.data&&!source.error&&<>
      <p>原订单 <strong className="code">{source.data.order.public_no}</strong></p>
      <Table headers={["付款编号","实收","可申请余额","付款记录"]} rows={options.map(p=>[
        <span className="code">{p.id}</span>,usd(p.amount_cents),usd(p.refundable_cents),stamp(p.created_at),
      ])} empty="该订单没有确认实收的质检付款。"/>
      {options.some(p=>p.refundable_cents>0)&&<Form key={number+"-"+(receipt?.id??"")} label="提交退款申请" run={async f=>{
        const payment=options.find(p=>p.id===text(f,"payment"));
        const cents=Math.round(Number(text(f,"amount"))*100);
        if(!payment||cents<1||cents>payment.refundable_cents) throw new Error("申请金额须在所选实收的可退余额内。");
        const refund=await request("/staff/orders/"+source.data!.order.id+"/refunds","POST",{payment_id:payment.id,amount_cents:cents,reason:text(f,"reason")});
        setReceipt({order:number,id:refund.refund_id});
        source.reload();
      }}><Select name="payment" label="原实收付款" choices={options.filter(p=>p.refundable_cents>0).map(p=>({id:p.id,label:p.id+" · 可退 "+usd(p.refundable_cents)}))}/>
        <Field name="amount" label="申请金额（USD）" type="number" min={.01} step=".01"/>
        <Field name="reason" label="退款原因"/>
      </Form>}
      {receipt?.order===number&&<p className="notice" role="status">已提交退款申请 <span className="code">{receipt.id}</span>，待独立审批。</p>}
    </>}
  </Panel>;
}

function RefundApproval({refund,reload}:{refund:Row;reload:()=>void}) {
  const [reauth,setReauth]=useState(false);
  return reauth?<Link href="/staff/login?next=%2Fadmin%2Ffinance">重新验证员工身份</Link>:<Action run={async()=>{
    try {
      await request("/staff/refunds/"+refund.id+"/approve","POST",{revision:refund.revision});
      reload();
    } catch(error) {
      if(error instanceof RequestError&&error.code==="STAFF_REAUTH_REQUIRED") setReauth(true);
      else throw error;
    }
  }}>审批退款</Action>;
}

export function WarehouseScan() {
  const [match,setMatch]=useState<{title:string;detail:string;link?:string;action?:string}>();
  const carriers=useLoad("/carriers");
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / SCAN</p><h1>扫码查询</h1>
      <p className="muted">扫描或手输卖家运单、包裹码或实物码。</p></div><Link className="button" href="/wh/intake">收货入库</Link></div>
    <Panel title="查询仓库对象">
      <div onChange={()=>setMatch(undefined)}><Form inline label="查询" run={async f=>{
        setMatch(undefined);
        const code=text(f,"scan_code"),carrier=text(f,"carrier");
        if(/^P-[A-Z0-9-]{1,64}$/i.test(code)) {
          const {parcel}=await request("/staff/packages/by-code/"+code.toUpperCase());
          setMatch({title:parcel.code,detail:"仓库已实收 · 已登记 "+parcel.received_quantity+" 件",
            link:"/wh/packages/"+parcel.code,action:"打开包裹详情"});
        } else if(/^S-/i.test(code)) {
          const {item}=await request("/staff/items/by-code?"+new URLSearchParams({code}));
          setMatch({title:item.code,detail:label(item.custody_state)+" · 库位 "+(item.location??"未登记"),
            link:"/wh/samples/"+encodeURIComponent(item.code),action:"打开实物识别"});
        } else {
          const result=await request("/staff/intake/lookup","POST",{tracking_no:code,...(carrier?{carrier_code:carrier}:{})});
          if(result.match_state==="ambiguous") {
            setMatch({title:code,detail:"发现多个候选。请选择面单上的承运商后重新查询。"});
            return;
          }
          setMatch({title:code,detail:result.package_id?"仓库已有实收记录":result.receiving_code?
            "已匹配收件码 "+result.receiving_code:"待核验包裹归属",
            link:"/wh/intake?"+new URLSearchParams(result.package_id?{package:result.package_id}:{tracking:code}),
            action:result.package_id?"打开拆包登记":"前往收货核对"});
        }
      }}>
        <Field name="scan_code" label="条码或原始运单号"/>
        <Select name="carrier" label="承运商（运单查询）" required={false}
          choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
      </Form></div>
      {match&&<div className="notice" role="status"><strong className="code">{match.title}</strong><p>{match.detail}</p>
        {match.link&&<Link className="button" href={match.link}>{match.action}</Link>}</div>}
    </Panel>
  </>;
}

export function WarehousePackageView({code}:{code:string}) {
  const {data,error,reload}=useLoad("/staff/packages/by-code/"+code);
  const parcel=data?.parcel;
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / PACKAGE RECORD</p><h1>包裹详情</h1>
      <p className="code">{code}</p></div>{parcel&&<Link className="button primary" href={"/wh/intake?package="+parcel.id+"#intake-unpack"}>打开拆包登记</Link>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取包裹…</p>}
    {data&&parcel&&<>
      <div className="ops-columns">
        <Panel title="仓库实收">
          <dl className="location-facts">
            <div><dt>实际入仓时间</dt><dd>{stamp(parcel.received_at)}</dd></div>
            <div><dt>实收件数</dt><dd>{parcel.received_quantity} 件</dd></div>
            <div><dt>外箱实重</dt><dd>{parcel.weight_g==null?"未记录":parcel.weight_g+" 克"}</dd></div>
            <div><dt>关联委托</dt><dd className="code">{parcel.order_numbers.join("、")||"尚未关联"}</dd></div>
          </dl>
        </Panel>
        <Panel title="承运商运输">
          <p>卖家运单 <strong className="code">{parcel.tracking_norm??"尚无运单"}</strong></p>
          {parcel.tracking_norm&&<p>{label(parcel.transport_state)} · {label(parcel.sync_state)}</p>}
          {parcel.tracking_events?.length?<ol className="timeline">{parcel.tracking_events.map((event:Row)=>
            <li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>:<Empty>暂无承运商中文轨迹。</Empty>}
        </Panel>
      </div>
      <Panel title="拆包实物">
        <Table headers={["实物码","库存状态","当前位置",""]} rows={data.items.map((item:Row)=>[
          <span className="code">{item.code}</span>,label(item.custody_state),item.location??"—",
          <Link href={"/wh/samples/"+encodeURIComponent(item.code)}>核对实物</Link>,
        ])} empty="尚未登记包内实物。"/>
      </Panel>
    </>}
  </>;
}

function ItemIdentity({data,onSave}:{data:Row;onSave:()=>void}) {
  const {item}=data;
  const positions:Row[]=data.positions;
  return <>
    <div className="notice">
      <strong className="code">{item.code}</strong> · {label(item.custody_state)} · 库位 {item.location??"未登记"}
      <p>实收包裹 <Link href={"/wh/packages/"+item.package_code}>{item.package_code}</Link>{item.order_number?" · 委托 "+item.order_number:""}</p>
      {!item.ownership_verified&&<p>待核验客户归属。完成认领后才能关联委托。</p>}
    </div>
    {positions.length>0?<Form key={item.id} label="核对并绑定" run={async f=>{
      const position=positions.find(p=>p.id===text(f,"position"));
      if(!position)throw new Error("请选择同一客户的委托位置。");
      const proof=await upload(f.get("photo"),"label_photo");
      await request("/staff/items/"+item.id+"/assign","POST",{revision:item.revision,order_line_id:position.order_line_id,
        expected_item_id:position.id,evidence_ids:[proof]});
      onSave();
    }}><Select name="position" label="同一客户的待收委托位置" choices={positions.map(p=>({id:p.id,label:p.public_no+" · "+p.title["zh-CN"]+" · "+p.position}))}/>
      <Photo label="商品标签核对照"/>
    </Form>:item.ownership_verified&&!item.order_number&&<Empty>当前实物没有可绑定的委托位置。</Empty>}
    {item.movable&&<Link className="button" href={"/wh/storage?"+new URLSearchParams({item:item.code})}>移转此实物</Link>}
  </>;
}

export function WarehouseItemView({code}:{code:string}) {
  const {data,error,reload}=useLoad("/staff/items/by-code?"+new URLSearchParams({code}));
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / ITEM RECORD</p><h1>实物建档与识别</h1>
      <p className="code">{code}</p></div><Link className="button" href="/wh/scan">返回扫码</Link></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取实物…</p>}
    {data&&!error&&<Panel title="库存与委托"><ItemIdentity data={data} onSave={reload}/></Panel>}
  </>;
}
