"use client";

import Link from "next/link";
import { ScopeReview } from "./scope-review";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Action, checked, CodeButton, DateInput, DefectAnnotator, type DefectAnnotation, Empty, ErrorBlock, Field, FileInput, Form, MediaButton, ModalDrawer, Panel, Photo, request, RequestError, Select, StaffObjectDrawer, type StaffObjectTarget, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";
import { switchDemoPortal } from "./chrome";
import { OverdueDisposalDesk, StocktakeReviewAndIncidentPanel } from "./storage-desk";
import { staffTabs } from "../packages/core/portal-routes";

const SAMPLE_CODE_ALPHABET="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRandomSampleCode():string {
  const bytes=new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out="S-";
  for(let i=0;i<6;i++) out+=SAMPLE_CODE_ALPHABET[bytes[i]!%SAMPLE_CODE_ALPHABET.length];
  return out;
}

const label=(s:string)=>({
  READY:"待领取",IN_PROGRESS:"检查中",SUBMITTED:"已提交",submitted:"待复核",qa_approved:"生成 PDF",pending:"待查询",
  checked_in:"已实收",received:"待识别",stored:"已在库",unmatched:"待认领",confirmed:"待报价",quoted:"待付款",paid:"已付款",packed:"已装箱",shipped:"已交接",
  delivered:"快递已签收",outbound:"已出库",returned:"已退回仓库",unknown:"未知",active:"跟踪中",in_transit:"在途",exception:"异常",
  delayed:"同步延迟",needs_carrier:"待补承运商",needs_verification:"待验证",not_supported:"不支持自动跟踪",picked_up:"已揽件",
  out_for_delivery:"派送中",returning:"退回途中",forwarded:"已转寄",
  approved:"已审批，待渠道确认",succeeded:"渠道已确认",failed:"渠道失败",processing:"处理中",partially_refunded:"部分退款",
  draft:"草稿",awaiting_payment:"待支付",awaiting_samples:"待收货",samples_ready:"样品已齐备",queued:"待质检",inspecting:"质检中",
  qa_review:"复核中",report_ready:"报告已发布",action_pending:"待处置",cancelled:"已取消",closed:"已关闭",on_hold:"暂停",
  return_to_seller:"退商家",to_forwarder:"寄集运仓",identified:"已识别",
  in_inspection:"检中",inspected:"已检",
  intact:"外箱完好",crushed:"外箱压扁变形",torn:"外箱破损开裂",wet:"外箱水渍受潮",
} as Record<string,string>)[s]??s;
const options=(rows:Row[],name="code")=>rows.map(r=>({id:r.id,label:String(r[name])}));
export function WarehouseDesk({path,actor,demo=false}:{path:string;actor:Row;demo?:boolean}) {
  const {data,error,reload}=useLoad("/staff/desk"),carriers=useLoad("/carriers");
  const [lookup,setLookup]=useState<{tracking:string;carrier:string;result:Row;context?:Row}>();
  const [receiving,setReceiving]=useState(false);
  const [packageId,setPackageId]=useState("");
  const [intakeTracking,setIntakeTracking]=useState("");
  const [batchPrintResult,setBatchPrintResult]=useState<{print_id:string;pdf_url:string;preview_png_url:string;codes:string[]}>();
  const [batchVerifyResult,setBatchVerifyResult]=useState<{verified:boolean;verified_count:number}>();
  const [discrepancyResult,setDiscrepancyResult]=useState<Row>();
  const packageDetail=useLoad(packageId?"/staff/packages/"+packageId:null);
  const selectedPackage=packageDetail.data?.parcel.id===packageId?packageDetail.data:undefined;
  const [itemCode,setItemCode]=useState("");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
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
  const canReceive=actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r));
  const canInspect=actor.roles.some((r:string)=>["inspector","super_admin"].includes(r)),canReview=actor.roles.some((r:string)=>["reviewer","super_admin"].includes(r)),canShip=actor.roles.some((r:string)=>["warehouse_admin","super_admin"].includes(r));
  const item=itemDetail.data?.item;
  const selectItem=(code:string)=>{setItemCode(code);itemDetail.reload();};
  const locations=options(data.locations);
  const carrierOptions=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  const current=path.split("/")[2]??"overview";
  const groups=Object.values(data.tasks.reduce((g:Record<string,Row[]>,t:Row)=>{(g[t.order_id]??=[]).push(t);return g;},{})) as Row[][];
  const heading={
    overview:["仓库总览","实物、证据、费用与物流是不同的业务事实。"],
    intake:["收货入库","快递公司签收不等于 QCWarehouse 仓库实收。记录外箱与实物后才能确认。"],
    packages:["包裹详情","实物包裹与原始运单、入库事务分别保存。"],
    samples:["样品识别与建档","客户物件标识与委托明细独立管理。"],
    inspection:["检查任务队列","按委托任务而非按订单数量派工，逐件检查与样品比较独立。"],
    execute:["检查执行工作台","按受控模板录入观察事实、测量值与必拍证据。"],
    sync:["本地同步与冲突处理","仓库移动设备断网后不能覆盖已发布服务端数据。"],
    dispatch:["出库与退商家待办","只有授权、报价、付款和样品可用状态全部满足，才能进入可交接队列。"],
  }[current]??["仓库总览","实物、证据、费用与物流是不同的业务事实。"];
  const pad2=(n:number)=>String(n).padStart(2,"0");
  const overviewMetrics:[string,string,string,string][]=[
    ["/wh/intake","待收实物",pad2(data.packages.length),"需扫码实收"],
    ["/wh/inspection","待检任务",pad2(data.tasks.length),"按 SLA 排序"],
    ["/wh/review","待复核报告",pad2(data.reports.length),"不同人员复核"],
    ["/wh/dispatch","待出库指令",pad2(data.batches.length),"付款及授权分别核验"],
  ];
  const activeRoleKey=actor.roles.includes("super_admin")?"admin":actor.roles.includes("reviewer")?"reviewer":actor.roles.includes("inspector")?"inspector":actor.roles.includes("warehouse_admin")?"warehouse":"receiving";
  const todayRows:[ReactNode,ReactNode,ReactNode][]=[
    ...data.packages.slice(0,3).map((parcel:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>,
      <Tag tone="green">{label(parcel.state)}</Tag>,
      <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>核对样品</Link>,
    ]),
    ...data.tasks.slice(0,3).map((task:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/task/"+task.id}>{task.public_no}</Link>,
      <Tag tone="yellow">{label(task.state)}</Tag>,
      <Link className="button sm" href={"/wh/task/"+task.id}>进入检查</Link>,
    ]),
    ...data.reports.slice(0,2).map((rep:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/review/"+rep.id}>{rep.public_no}</Link>,
      <Tag tone="yellow">{label(rep.state)}</Tag>,
      <Link className="button sm" href={"/wh/review/"+rep.id}>查看证据</Link>,
    ]),
  ];
  return <><div className="page-head row"><div><p className="eyebrow">WAREHOUSE OPERATIONS</p><h1>{heading[0]}</h1><p className="muted">{heading[1]}</p></div>
    {current==="overview"&&<div className="head-actions"><Link className="button primary" href="/wh/scan">扫码查件</Link><Link className="button" href="/wh/intake">待收登记</Link></div>}
  </div>
    {demo&&<div className="row flexwrap" role="region" aria-label="演示员工角色切换" style={{marginBottom:16,justifyContent:"flex-start",gap:10}}>
      <span className="label-inline">演示员工角色</span>
      <select
        className="input"
        style={{width:170}}
        aria-label="演示员工角色"
        value={activeRoleKey}
        onChange={e=>{
          const map:Record<string,[string,string]>={
            receiving:["receiving@qcw.test","/wh"],
            inspector:["inspector@qcw.test","/wh"],
            reviewer:["reviewer@qcw.test","/wh"],
            warehouse:["receiving@qcw.test","/wh"],
            admin:["admin@qcw.test","/wh"],
          };
          const [email,dest]=map[e.target.value]??["admin@qcw.test","/wh"];
          void switchDemoPortal(dest,email);
        }}
      >
        <option value="receiving">收货员</option>
        <option value="inspector">检查员</option>
        <option value="reviewer">复核员</option>
        <option value="warehouse">仓管</option>
        <option value="admin">超级管理员</option>
      </select>
      <Tag tone="yellow">本地演示切换服务端员工会话</Tag>
    </div>}
    {current==="overview"&&<>
      <div className="stats" aria-label="仓库作业摘要">{overviewMetrics.map(([href,title,value,detail])=>
        <Link className="stat" href={href} key={title}><span className="label">{title}</span><strong className="value">{value}</strong><small className="detail">{detail}</small></Link>)}</div>
      <div className="grid cols2">
        <Panel title="今日作业队列" subtitle="生产需按角色裁剪数据。">
          <Table headers={["对象","进度","下一步"]} rows={todayRows} empty="暂无待处理作业，可通过收货入库或客户下单创建。"/>
        </Panel>
        <Panel title="操作捷径">
          <div className="grid cols2">
            {[
              ["/wh/scan","扫码查询"],
              ["/wh/intake","收货入库"],
              ["/wh/inspection","检查队列"],
              ["/wh/review","报告复核"],
              ["/wh/dispatch","出库待办"],
              ["/wh/stocktakes","库存盘点"],
            ].map(([href,name])=><Link className="button sm" key={href} href={href}>{name}</Link>)}
          </div>
          <hr className="sep"/>
          <div className="line-note">员工端正式部署禁止依赖外部字体、CDN 或需要翻墙的资源。</div>
        </Panel>
      </div>
    </>}
    {current==="intake"&&canReceive&&<>
      <ol className="intake-stages" aria-label="收货步骤">
        <li><a href="#intake-waybill"><span>01</span>核对运单与外箱</a></li>
        <li><a href="#intake-unpack"><span>02</span>逐件建档与上架</a></li>
        <li><a href="#item-intake"><span>03</span>核对身份与委托</a></li>
      </ol>
      <section className="panel scan-panel" id="intake-waybill"><div className="section-heading"><span className="eyebrow">01 / 运单定位</span><h2>搜索卖家运单</h2><p className="muted">承运商签收后，仍需仓库核对外箱状况（完好/压扁/破损/水渍）并确认实收。</p></div>
        <fieldset disabled={receiving} style={{display:"contents"}} onChange={()=>{setLookup(undefined);setPackageId("");}}>
          <Form inline label="搜索" run={async f=>{
            const tracking=text(f,"tracking"),carrier=text(f,"carrier");
            setLookup(undefined);setPackageId("");
            const result=await request("/staff/intake/lookup","POST",{tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})});
            let context:Row|undefined;
            try {
              context=await request("/staff/intake/context?"+new URLSearchParams({tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})}));
            } catch {}
            setLookup({tracking,carrier,result,context});
            if(result.package_id)setPackageId(result.package_id);
          }}><Field key={intakeTracking} name="tracking" label="扫描条码或手动输入运单号" value={intakeTracking}/><Select name="carrier" label="快递公司" choices={carrierOptions} required={false}/></Form>
        </fieldset>
        {lookup&&<div className="notice"><p>运单 <strong className="code">{lookup.tracking}</strong></p>
          <p>匹配结果 <strong>{({matched:"已关联订单",user_only:"已找到客户，待关联订单",unmatched:"待认领（入仓后须停放未认领区 U-01）",ambiguous:"多个候选，请核对快递公司"} as Row)[lookup.result.match_state]}</strong></p>
          {lookup.result.receiving_code&&<p className="code">专属收件码：{lookup.result.receiving_code}</p>}
          {lookup.result.order_ids.length>0&&<p>关联订单数 {lookup.result.order_ids.length}</p>}
          {lookup.context&&lookup.context.orders?.length>0&&<p className="small">
            订单申报总件数：<strong>{lookup.context.total_declared_qty}</strong> 件 · 仓库累计已实收：<strong>{lookup.context.cumulative_received_qty}</strong> 件 · 在途未到仓预报运单：<strong>{lookup.context.in_transit_advices_count}</strong> 单
          </p>}
          {lookup.result.package_id&&<p>此运单已有实收记录，已定位到拆包登记。</p>}
        </div>}
        {lookup&&lookup.result.match_state!=="ambiguous"&&!lookup.result.package_id&&<Form key={lookup.tracking+"-"+lookup.carrier} label="确认实物到仓" run={async f=>{
          setReceiving(true);
          try {
            const photo=await upload(f.get("photo"),"intake_outer");
            const weight=text(f,"weight");
            const outerCondition=text(f,"outer_condition")||"intact";
            const conditionNote=text(f,"condition_note");
            const parcel=await request("/staff/intake/check-in","POST",{
              tracking_no:lookup.tracking,
              ...(lookup.carrier?{carrier_code:lookup.carrier}:{}),
              ...(lookup.result.advice_id?{advice_id:lookup.result.advice_id}:{}),
              ...(weight?{weight_g:Number(weight)}:{}),
              outer_condition:outerCondition,
              ...(conditionNote?{condition_note:conditionNote}:{}),
              outer_media_ids:[photo],
            });
            setLookup({...lookup,result:{...lookup.result,package_id:parcel.id}});setPackageId(parcel.id);reload();
          } finally {
            setReceiving(false);
          }
        }}>
          <div className="fields three">
            <Field name="weight" label="包裹实重（克）" type="number" min={1} required={false}/>
            <Select name="outer_condition" label="外箱状况（必选）" value="intact" choices={[
              {id:"intact",label:"完好 (intact)"},
              {id:"crushed",label:"压扁变形 (crushed)"},
              {id:"torn",label:"破损开裂 (torn)"},
              {id:"wet",label:"水渍受潮 (wet)"},
            ]}/>
            <Field name="condition_note" label="外箱破损/异常备注（外箱异常时必填）" required={false}/>
          </div>
          <Photo label="包裹外箱照片（含快递面单与外箱全貌）"/>
        </Form>}
      </section>
      <Panel title="02 / 拆包登记、同屏核对与批量标签打印" id="intake-unpack">
        <label>入仓包裹<select value={packageId} onChange={e=>{setPackageId(e.target.value);setBatchPrintResult(undefined);setBatchVerifyResult(undefined);setDiscrepancyResult(undefined);}}>
          <option value="">选择包裹</option>
          {packageId&&!data.packages.some((p:Row)=>p.id===packageId)&&<option value={packageId}>{selectedPackage?.parcel.code??"正在定位包裹"}</option>}
          {data.packages.map((p:Row)=><option key={p.id} value={p.id}>{p.code} · {p.tracking_norm??"—"}</option>)}
        </select></label>
        {packageId&&packageDetail.error&&<><ErrorBlock error={packageDetail.error}/><button type="button" onClick={packageDetail.reload}>重新读取包裹</button></>}
        {packageId&&!selectedPackage&&!packageDetail.error&&<p role="status">正在读取包裹…</p>}
        {selectedPackage&&<><p><Link className="code" href={"/wh/packages/"+selectedPackage.parcel.code}>{selectedPackage.parcel.code}</Link> · 本包已建档 <strong>{selectedPackage.parcel.received_quantity}</strong> 件 · 外箱 <Tag>{label(selectedPackage.parcel.outer_condition??"intact")}</Tag> · 状态 <Tag>{label(selectedPackage.parcel.state)}</Tag></p>
          {selectedPackage.parcel.order_numbers.length>0&&<p>关联订单 {selectedPackage.parcel.order_numbers.join("、")}</p>}
          {selectedPackage.intake_context&&selectedPackage.intake_context.orders?.length>0&&<div className="card" style={{marginBottom:12}}>
            <div className="row">
              <strong>客户申报 vs 仓库累计实收同屏核对（支持多包裹分批到仓）</strong>
              <span className="small muted">
                订单总申报 <strong>{selectedPackage.intake_context.total_declared_qty}</strong> 件 · 累计已收 <strong>{selectedPackage.intake_context.cumulative_received_qty}</strong> 件 · 仍差 <strong>{selectedPackage.intake_context.remaining_unreceived_qty}</strong> 件 · 在途未到运单 <strong>{selectedPackage.intake_context.in_transit_advices_count}</strong> 单
              </span>
            </div>
            <Table
              headers={["订单号 / 位置","款号 (Sample Code)","颜色","尺码","供应商","服装子类","申报运单","已绑实物码"]}
              rows={(selectedPackage.intake_context.declared_items??[]).map((di:Row)=>[
                <span className="code">{di.order_public_no} #{di.position}</span>,
                <span className="code">{di.sample_code??"—"}</span>,
                di.color??"—",
                di.size??"—",
                di.supplier_alias??"—",
                di.garment_type??"—",
                <span className="code">{di.declared_tracking_no??"—"}</span>,
                di.bound_item_code?<CodeButton code={di.bound_item_code} onClick={()=>selectItem(di.bound_item_code)}/>:<Tag tone="yellow">待绑定</Tag>,
              ])}
              empty="该包裹关联订单暂无逐件申报明细。"
            />
          </div>}
          <Table headers={["实物码","类型","库存状态","质检阶段","库位","操作"]} rows={selectedPackage.items.map((i:Row)=>[
            <span className="code">{i.code}</span>,
            i.parent_item_id?"套装组件":"主件",
            label(i.custody_state),
            <Tag tone={i.inspection_stage==="in_inspection"?"yellow":i.inspection_stage==="inspected"?"green":"gray"}>{label(i.inspection_stage??"pending")}</Tag>,
            i.location??"—",
            <a className="button sm" href="#item-intake" onClick={()=>selectItem(i.code)}>同屏核对/绑单</a>,
          ])}/>
          {selectedPackage.parcel.state!=="quarantined"&&<Form key={packageId} label="逐件建档（自动生成无歧义 6 位 Base32 样品码）" run={async f=>{
            const n=Number(text(f,"quantity"));
            const parentId=text(f,"component_of");
            if(!Number.isInteger(n) || n<1 || n>100)throw new Error("请填写实际件数。");
            const items=Array.from({length:n},()=>({
              code:generateRandomSampleCode(),
              location_id:text(f,"location"),
              ...(parentId?{component_of:parentId}:{}),
            }));
            await request("/staff/packages/"+selectedPackage.parcel.id+"/items","POST",{revision:selectedPackage.parcel.revision,items});
            packageDetail.reload();reload();
          }}>
            <div className="fields three">
              <Field name="quantity" label="本次新增实物件数" type="number" min={1} max={100} value={1}/>
              <Select name="location" label="目标库位（系统自动校验分区用途）" choices={locations}/>
              <Select name="component_of" label="套装主件（登记子组件时选择，主件留空）" required={false}
                choices={selectedPackage.items.filter((i:Row)=>!i.parent_item_id).map((i:Row)=>({id:i.id,label:i.code}))}/>
            </div>
          </Form>}
          {selectedPackage.items.length>0&&<div className="card" style={{marginTop:12}}>
            <h3 style={{marginTop:0}}>同屏批量打印本包样品标签与连续扫码回读 ({selectedPackage.items.length} 件)</h3>
            <Form inline label="批量生成本包样品条码标签" run={async f=>{
              const res=await request("/staff/labels/print","POST",{
                item_ids:selectedPackage.items.map((i:Row)=>i.id),
                label_size:text(f,"label_size")||"standard_80x50",
                ...(text(f,"reprint_reason")?{reprint_reason:text(f,"reprint_reason")}:{}),
              });
              setBatchPrintResult({
                print_id:res.print_id,
                pdf_url:res.pdf_url,
                preview_png_url:res.preview_png_url,
                codes:selectedPackage.items.map((i:Row)=>i.code),
              });
              setBatchVerifyResult(undefined);
            }}>
              <Select name="label_size" label="标签规格" value="standard_80x50" choices={[
                {id:"standard_80x50",label:"80×50mm 标准热敏签"},
                {id:"compact_50x30",label:"50×30mm 服装吊牌小签"},
                {id:"shelf_100x60",label:"100×60mm 宽幅签"},
              ]}/>
              <Field name="reprint_reason" label="重打原因（首次打印留空）" required={false}/>
            </Form>
            {batchPrintResult&&<div className="notice" role="status" style={{marginTop:8}}>
              <p>已生成 {batchPrintResult.codes.length} 张真实可解码 QR + Code-128 标签 · <a href={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/file"} target="_blank" rel="noreferrer">下载标签 PDF</a> · <a href={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/preview.png"} target="_blank" rel="noreferrer">查看 PNG 预览</a></p>
              <img src={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/preview.png"} alt="真实条码预览" style={{maxWidth:320,border:"1px solid #cbd5e1",borderRadius:6,marginTop:6}}/>
            </div>}
            <Form inline label="连续扫码批量回读核验" run={async f=>{
              const scanned=text(f,"scanned_codes").split(/[\s,，;；]+/).map(s=>s.trim()).filter(Boolean);
              const expected=selectedPackage.items.map((i:Row)=>i.code);
              const res=await request("/staff/labels/verify","POST",{expected_codes:expected,scanned_codes:scanned});
              setBatchVerifyResult(res);
            }}>
              <Field name="scanned_codes" label="依次扫描贴好后的样品码（空格或逗号分隔）" value={selectedPackage.items.map((i:Row)=>i.code).join(" ")}/>
            </Form>
            {batchVerifyResult&&<p className="notice" role="status">批量回读核验通过：共 {batchVerifyResult.verified_count} 件样品条码与数据库 100% 一致。</p>}
          </div>}
          <details className="card" style={{marginTop:12}}>
            <summary>实收件数与申报不符 / 多包裹分批在途登记</summary>
            <Form label="提交包裹数量核对结论" run={async f=>{
              const res=await request("/staff/packages/"+selectedPackage.parcel.id+"/discrepancy","POST",{
                revision:selectedPackage.parcel.revision,
                ...(selectedPackage.intake_context?.orders?.[0]?.id?{order_id:selectedPackage.intake_context.orders[0].id}:{}),
                expected_qty:Number(text(f,"expected_qty")),
                actual_qty:Number(text(f,"actual_qty")),
                discrepancy_type:text(f,"discrepancy_type"),
                note:text(f,"note"),
              });
              setDiscrepancyResult(res);
              packageDetail.reload();reload();
            }}>
              <div className="fields three">
                <Field name="expected_qty" label="订单申报总件数" type="number" min={1} value={selectedPackage.intake_context?.total_declared_qty||selectedPackage.parcel.received_quantity||1}/>
                <Field name="actual_qty" label="本包实收件数" type="number" min={0} value={selectedPackage.parcel.received_quantity||0}/>
                <Select name="discrepancy_type" label="差异类型" choices={[
                  {id:"partial_shipment_in_transit",label:"多包裹分批到货（其余运单在途，保持待收齐）"},
                  {id:"shortage",label:"卖家少发/短装（挂起订单并通知客户）"},
                  {id:"overage",label:"卖家多发/超装（挂起订单并通知客户）"},
                  {id:"wrong_item",label:"错发完全不同商品（挂起订单并通知客户）"},
                ]}/>
              </div>
              <Field name="note" label="核对差异说明（客户与客服可见）" value="已核对外箱与内物清点数量"/>
            </Form>
            {discrepancyResult&&<p className="notice" role="status">
              已记录数量核对结果：{discrepancyResult.discrepancy_type}{discrepancyResult.ticket_no?` · 已生成异常工单 ${discrepancyResult.ticket_no} 并挂起关联订单`:""}
            </p>}
          </details>
        </>}
      </Panel>
      <Panel title="03 / 实物识别与委托" id="item-intake">
        <div onChange={()=>setItemCode("")}>
          <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
            <Field name="item_code" label="扫描或输入实物码"/>
          </Form>
        </div>
        {!itemCode&&<Empty>扫描实物标签，或从上方包裹清单点击“同屏核对/绑单”直接加载。</Empty>}
        {itemCode&&itemDetail.error&&<><ErrorBlock error={itemDetail.error}/><button type="button" onClick={itemDetail.reload}>重新读取实物</button></>}
        {itemCode&&!item&&!itemDetail.error&&<p role="status">正在读取实物…</p>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} onSave={()=>{itemDetail.reload();packageDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="packages"&&<>
      <Panel title="外箱及实收包裹列表" subtitle="点击包裹编号进入单包明细，或点击原始运单号直接弹窗查看物流轨迹。">
        <Table headers={["包裹编号","原始运单","实收件数","入库状态","操作"]} rows={data.packages.map((parcel:Row)=>[
          <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>,
          parcel.tracking_norm?<CodeButton code={parcel.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:parcel.tracking_norm})}/>:<span className="muted">—</span>,
          `${parcel.received_quantity} 件`,
          <Tag tone="green">{label(parcel.state)}</Tag>,
          <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>包裹详情</Link>,
        ])} empty="暂无实收包裹记录，请前往收货入库登记。"/>
      </Panel>
    </>}
    {current==="samples"&&<>
      <Panel title="在库样品与实物清单" subtitle="逐件独立编号，绑定客户委托位置前须完成身份核对；检中与已检商品及确认样专区状态实时标识。">
        <Table headers={["样品码","当前库位","库存状态","质检进度","作业入口"]} rows={data.items.slice(0,30).map((it:Row)=>[
          <Link className="code" href={"/wh/samples/"+encodeURIComponent(it.code)}>{it.code}</Link>,
          <span className="code">{it.location??"待上架"}</span>,
          <Tag tone="green">{label(it.custody_state)}</Tag>,
          <Tag tone={it.inspection_stage==="in_inspection"?"yellow":it.inspection_stage==="inspected"?"green":"gray"}>{label(it.inspection_stage??"pending")}</Tag>,
          <div className="actions">
            <Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>样品详情</Link>
            <Link className="button sm" href={"/wh/storage?"+new URLSearchParams({item:it.code})}>移到库位</Link>
          </div>,
        ])} empty="暂无在库样品记录。"/>
      </Panel>
      <Panel title="按编号快速核对样品" id="sample-quick-lookup">
        <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
          <Field name="item_code" label="扫描或输入样品码 S-..."/>
        </Form>
        {itemCode&&itemDetail.error&&<ErrorBlock error={itemDetail.error}/>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} onSave={()=>{itemDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="inspection"&&<>
      <Panel title="待处理任务" subtitle="同一任务的并发领取在服务端只产生一个有效作业会话。">
        <Form inline label="扫码定位任务" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="扫描或输入样品码 S-... / 订单号 QW-..."/></Form>
        {!groups.length&&<Empty>暂无可领取任务。付款并核对到齐后自动进入队列。</Empty>}
        {groups.map(ts=><div key={ts[0].order_id} className="card">
          <div className="row">
            <h3>{ts[0].public_no} · {ts[0].category_labels?.["zh-CN"]??"商品"} · {ts.length} 项任务</h3>
            <span>{ts[0].sla_overdue?<Tag tone="red">SLA 已超时</Tag>:<span className="muted small">SLA 截止：{stamp(ts[0].sla_due_at)}</span>}</span>
          </div>
          <Table headers={["物件或组","服务","状态","操作"]} rows={ts.map(t=>[
            <span className="code">{t.item_code??"比较组"}</span>,t.title["zh-CN"],<Tag>{label(t.state)}</Tag>,
            <Link className="button sm" href={"/wh/task/"+t.id}>进入工作台</Link>
          ])}/>
          {canInspect&&ts.every(t=>t.state==="SUBMITTED")&&ts.some(t=>t.assignee_id===actor.id)&&<Action primary run={async()=>{
            const res=await request("/staff/inspection-tasks/"+ts[0].id);
            await request("/staff/orders/"+ts[0].order_id+"/report/submit","POST",{revision:res.order_revision,task_ids:ts.map(t=>t.id)});reload();
          }}>汇总并提交报告</Action>}
        </div>)}
      </Panel>
    </>}
    {current==="execute"&&<>
      <Panel title="选择或扫描检查任务" subtitle="扫描样品标签或从下方待执行任务直接进入检查录入工作台。">
        <Form inline label="打开检查工作台" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="样品码 S-... / 订单号 QW-..."/></Form>
        <Table headers={["关联订单","样品码","服务类型","当前状态","操作"]} rows={data.tasks.map((t:Row)=>[
          <span className="code">{t.public_no}</span>,
          <span className="code">{t.item_code??"对比组"}</span>,
          t.title?.["zh-CN"]??t.service,
          <Tag>{label(t.state)}</Tag>,
          <Link className="button sm primary" href={"/wh/task/"+t.id}>进入执行检查</Link>,
        ])} empty="当前没有待执行的检查任务。"/>
      </Panel>
    </>}
    {current==="sync"&&<OfflineSyncQueue tasks={data.tasks}/>}
    {current==="dispatch"&&<>
      {canShip?<><DispatchQueue onOpenDrawer={setDrawer}/>
      {!!data.retain.length&&<Panel title="续存报价">
        {data.retain.map((i:Row)=><p key={i.id}><CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/> <Action run={async()=>{await request("/staff/dispositions/"+i.id+"/storage-quote","POST",{});reload();}}>生成 30 天报价</Action></p>)}
      </Panel>}</>:<Panel title="出库待办"><p className="muted">当前演示角色无出库交接权限，请切换为“仓管”或“超级管理员”查看并操作发运批次。</p></Panel>}
    </>}
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}

function OfflineSyncQueue({tasks}:{tasks:Row[]}) {
  const [entries,setEntries]=useState<{key:string;taskId:string;count:number}[]>([]);
  useEffect(()=>{
    const found:{key:string;taskId:string;count:number}[]=[];
    try {
      for(let i=0;i<localStorage.length;i++) {
        const key=localStorage.key(i);
        if(key?.startsWith("qcw_task_draft_")) {
          const parsed=JSON.parse(localStorage.getItem(key)??"[]");
          if(Array.isArray(parsed)&&parsed.length>0) found.push({key,taskId:key.slice("qcw_task_draft_".length),count:parsed.length});
        }
      }
    } catch {}
    setEntries(found);
  },[]);
  return <>
    <Panel title="待同步数据与照片" subtitle="本机离线暂存的检查草稿恢复网络后可幂等批量重放至服务端。">
      <Table
        headers={["项目","本机状态","服务端事实","操作"]}
        rows={entries.map(e=>{
          const matched=tasks.find(t=>t.id===e.taskId);
          return [
            <span className="code">{matched?`${matched.public_no} (${matched.item_code??"对比组"})`:e.taskId.slice(0,8)}</span>,
            <Tag tone="yellow">待同步 {e.count} 项</Tag>,
            matched?`服务端状态：${label(matched.state)}`:"可进入工作台核对版本",
            <Link className="button sm primary" href={"/wh/task/"+e.taskId}>打开并同步</Link>,
          ];
        })}
        empty="当前浏览器没有待同步的离线检查草稿。"
      />
    </Panel>
    <Panel title="冲突恢复原则">
      <ul className="list">
        <li>作业切换账号后，旧账号未提交数据不得暴露给新账号。</li>
        <li>服务端报告发布后，旧版草稿不允许覆盖发布版本。</li>
        <li>同步重试必须去重，失败时保留原始错误与可恢复路径。</li>
      </ul>
    </Panel>
  </>;
}
function dispatchAction(action:string) {
  return action==="return_to_seller"?"寄回商家":action==="to_forwarder"?"寄集运仓":"国内转寄";
}
const dispatchQueueLabels:Record<string,string>={
  weighing:"待称重报价",payment:"待客户确认或付款",packing:"待装箱",
  handover:"待交接",shipped:"已交接",returned:"有退回记录",blocked:"付款需核对",
};
function DispatchQueue({onOpenDrawer}:{onOpenDrawer?:(t:StaffObjectTarget)=>void}) {
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
      <button type="submit" className="button primary">查批次</button>
      {reference&&<Link className="button" href={"/wh/dispatch?"+new URLSearchParams({state})}>清除编号</Link>}
      <button type="button" className="button" onClick={reload}>刷新</button>
    </form>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在查询批次…</p>}
    {data&&!error&&<Table headers={["批次编号","去向与状态","实物进度","关联运单","退货 / 报价截止","操作"]} rows={data.rows.map((batch:Row)=>[
      <div className="cell-stack">
        <Link className="code" href={"/wh/dispatch/"+batch.id} title={batch.id}>#{String(batch.id).slice(0,8)}</Link>
        {onOpenDrawer&&<small><button type="button" className="code-btn" onClick={()=>onOpenDrawer({kind:"batch",ref:batch.id})}>速览清单</button></small>}
      </div>,
      <div className="cell-stack">
        <strong>{dispatchAction(batch.action)}</strong>
        <div><Tag>{label(batch.state)}</Tag></div>
      </div>,
      <div className="cell-stack">
        <span>待发 <strong>{batch.remaining}</strong> · 已装箱 <strong>{batch.packed}</strong></span>
        <small>已交接 {batch.shipped}{batch.returns?` · 退回 ${batch.returns}`:""}</small>
      </div>,
      (batch.waybills?.length)?<div className="actions">
        {(batch.waybills as string[]).map(wb=>onOpenDrawer
          ?<CodeButton key={wb} code={wb} onClick={()=>onOpenDrawer({kind:"tracking",ref:wb})}/>
          :<span key={wb} className="code">{wb}</span>)}
      </div>:<span className="muted">—</span>,
      <div className="cell-stack">
        <span>退货：{stamp(batch.return_deadline)}</span>
        <small>报价：{stamp(batch.expires_at)}</small>
      </div>,
      <Link className="button sm primary" href={"/wh/dispatch/"+batch.id}>进入作业 →</Link>,
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
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const b=data?.batch;
  return <>
    <div className="page-head row"><div><Link href="/wh/dispatch">← 出库队列</Link>
      <p className="eyebrow report-eyebrow">WAREHOUSE / DISPATCH BATCH</p><h1>发运批次</h1>
      <p className="code">{id}</p>{b&&<p><Tag>{label(b.state)}</Tag> · {dispatchAction(b.action)}</p>}</div>
      <div className="head-actions"><button type="button" className="button sm" onClick={reload}>刷新批次状态</button></div></div>
    {error&&<ErrorBlock error={error}/>}
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
          <h3>{label(s.state)} · {s.weight_g} 克 · {s.items.length} 件</h3><p className="code">包裹单 #{String(s.id).slice(0,8)}</p>
          <Table headers={["实物码","退回实收"]} rows={s.items.map((i:Row)=>[
            <CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/>,
            i.received_at?stamp(i.received_at):"—",
          ])}/>
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
          {s.shipped_at&&<p>实际交接 {stamp(s.shipped_at)} · {s.carrier_code} {s.tracking_norm?<CodeButton code={s.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:s.tracking_norm})}/>:"—"}</p>}
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
          {s.evidence_ids?.length>0&&<div className="actions" style={{marginTop:8}}>
            <MediaButton ids={s.evidence_ids} label={`查看装箱/交接照片 (${s.evidence_ids.length})`}/>
          </div>}
        </div>)}
      </Panel>
    </>}
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}
function DispatchQuoteForm({batch,rates,reload}:{batch:Row;rates:Row[];reload:()=>void}) {
  const [count,setCount]=useState(1);
  const [manualMode,setManualMode]=useState(false);
  const items:Row[]=batch.items??[];
  const maxParcels=Math.min(50,items.length);
  const parcelNumbers=Array.from({length:count},(_,i)=>i+1);
  if(!rates.length) return <Empty>没有生效的运价版本，暂不可报价。</Empty>;
  if(!items.length) return <Empty>该批次没有待发运实物。</Empty>;
  return <Form label={manualMode?"提交人工核定运费报价":"提交称重并自动生成报价"} run={async fields=>{
    const reason=text(fields,"manual_reason");
    const parcels=parcelNumbers.map(number=>{
      const manualUsd=text(fields,"manual-usd-"+number);
      return {
        item_ids:items.filter(item=>Number(fields.get("parcel-"+item.id)??1)===number).map(item=>item.id),
        weight_g:Number(fields.get("weight-"+number)),
        ...(manualMode && manualUsd!==""?{manual_amount_cents:Math.round(Number(manualUsd)*100),...(reason?{manual_reason:reason}:{})}:{}),
      };
    });
    if(parcels.some(p=>!p.item_ids.length||!Number.isInteger(p.weight_g)||p.weight_g<1))
      throw new Error("每个包裹至少包含一件指定实物，并填写实际克数。");
    if(manualMode) {
      await request("/staff/dispatch-batches/"+batch.id+"/manual-quote","POST",{
        revision:batch.revision,rate_version_id:text(fields,"rate"),manual_reason:reason||undefined,parcels,
      });
    } else {
      await request("/staff/dispatch-batches/"+batch.id+"/quote","POST",{revision:batch.revision,rate_version_id:text(fields,"rate"),parcels});
    }
    reload();
  }}>
    <div className="fields">
      <Select label="运价版本" name="rate" value={rates[0]?.id} choices={rates.map(rate=>({id:rate.id,label:"版本 "+rate.version}))}/>
      <label>计费模式
        <select value={manualMode?"manual":"standard"} onChange={e=>setManualMode(e.target.value==="manual")}>
          <option value="standard">按运价表自动计重计费</option>
          <option value="manual">超规体积 / 偏远地区人工核定运费</option>
        </select>
      </label>
    </div>
    {maxParcels>1&&<label>实际包裹数<select value={count} onChange={e=>setCount(Number(e.target.value))}>
      {Array.from({length:maxParcels},(_,i)=><option key={i+1}>{i+1}</option>)}
    </select></label>}
    {count>1&&<div className="dispatch-assignment" key={count}>{items.map(item=><Select key={item.id} name={"parcel-"+item.id}
      label={"实物 "+item.code+" 所在包裹"} choices={parcelNumbers.map(number=>({id:String(number),label:"包裹 "+number}))}/>)}</div>}
    <div className="dispatch-assignment">{parcelNumbers.map(number=><div key={number} className="fields">
      <Field label={"包裹 "+number+" 实重（克）"} name={"weight-"+number} type="number" min={1}/>
      {manualMode&&<Field label={"包裹 "+number+" 核定运费 (USD)"} name={"manual-usd-"+number} type="number" min={0} step="0.01"/>}
    </div>)}</div>
    {manualMode&&<Field label="人工核价原因说明（客户与审计可见）" name="manual_reason" value="超体积抛重或偏远派送附加费人工核定"/>}
  </Form>;
}
export function TaskView({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/inspection-tasks/"+id);
  const draftKey="qcw_task_draft_"+id;
  const [drafts,setDrafts]=useState<Row[]>([]);
  const [conflict,setConflict]=useState<{localRevision:number;serverRevision:number;message:string}|null>(null);
  const [online,setOnline]=useState(true);
  const [checkFilter,setCheckFilter]=useState<"all"|"pending"|"issue"|"done">("all");
  const [expandedKeys,setExpandedKeys]=useState<Record<string,boolean>>({});
  const [annotationsByKey,setAnnotationsByKey]=useState<Record<string,DefectAnnotation[]>>({});
  useEffect(()=>{
    try {
      const saved=localStorage.getItem(draftKey);
      if(saved) setDrafts(JSON.parse(saved));
    } catch {}
    setOnline(navigator.onLine);
    const onOnline=()=>setOnline(true),onOffline=()=>setOnline(false);
    window.addEventListener("online",onOnline);
    window.addEventListener("offline",onOffline);
    return ()=>{window.removeEventListener("online",onOnline);window.removeEventListener("offline",onOffline);};
  },[draftKey]);
  function saveLocalDrafts(next:Row[]) {
    setDrafts(next);
    try {
      if(next.length) localStorage.setItem(draftKey,JSON.stringify(next));
      else localStorage.removeItem(draftKey);
    } catch {}
  }
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载检查项…</p>;
  const writable=data.state==="IN_PROGRESS"&&data.assignee_id===actor.id;
  const completeness=data.completeness??{ok:true,missing:[]};
  const allChecks=data.components.flatMap((m:Row)=>
    data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row)=>{
      const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
      const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
      const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
      const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
      const isDone=Boolean(prev && !retryNeeded && !prev?.details?.uncertain);
      return {m,c,attempts,prev,retryNeeded,isIssue,isDone};
    })
  );
  const doneCount=allChecks.filter((x:Row)=>x.isDone).length;
  const issueCount=allChecks.filter((x:Row)=>x.isIssue).length;
  const pendingCount=allChecks.length-doneCount;
  const syncAllDrafts=async()=>{
    try {
      await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:drafts});
      saveLocalDrafts([]);reload();
    } catch(e) {
      if(e instanceof RequestError && e.code==="VERSION_CONFLICT") {
        const fresh=await request("/staff/inspection-tasks/"+id);
        setConflict({localRevision:data.revision,serverRevision:fresh.revision,message:e.message});
        return;
      }
      throw e;
    }
  };
  return <><div className="page-head row"><div><p className="eyebrow">WAREHOUSE / INSPECTION WORKBENCH</p><h1 className="code">{data.public_no}</h1>
      <p className="muted">{data.item_code??"对比组"} · {label(data.state)} · 模板版本 <span className="code">{String(data.template_version_id).slice(0,8)}</span> · SLA {stamp(data.sla_due_at)}</p></div>
      <div className="actions"><Tag>{online?"网络在线":"离线草稿模式"}</Tag>{drafts.length>0&&<Tag>待同步草稿 {drafts.length} 项</Tag>}<Link className="button" href="/wh/inspection">返回检查队列</Link></div></div>
    {data.review_feedback&&<div className="notice"><strong>复核退回</strong><p>{data.review_feedback}</p></div>}
    {conflict&&<Panel title="断网重连与版本冲突处理">
      <p className="notice">检测到服务端版本已更新（本机基线 v{conflict.localRevision} vs 服务端 v{conflict.serverRevision}）：{conflict.message}</p>
      <div className="actions">
        <Action primary run={async()=>{
          const fresh=await request("/staff/inspection-tasks/"+id);
          await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:fresh.revision,results:drafts});
          saveLocalDrafts([]);setConflict(null);reload();
        }}>拉取最新基线并合并重放本机草稿（{drafts.length} 项）</Action>
        <Action run={async()=>{saveLocalDrafts([]);setConflict(null);reload();}}>放弃本机草稿并采用服务端版本</Action>
      </div>
    </Panel>}
    {drafts.length>0&&!conflict&&writable&&<Panel title="本机离线草稿与待同步队列">
      <p className="muted small">已暂存 {drafts.length} 条检查项结果在本机浏览器，断网不丢失，恢复在线后可一键幂等批量同步。</p>
      <div className="actions">
        <Action primary run={syncAllDrafts}>立即同步全部本机草稿</Action>
        <Action run={async()=>saveLocalDrafts([])}>清空本机草稿</Action>
      </div>
    </Panel>}
    {(data.sibling_tasks?.length??0)>1&&<Panel title="同单逐件任务切换与扫码跳转">
      <Form inline label="扫码切换样品" run={async f=>{
        const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"item_scan"),order_id:data.order_id}));
        location.assign("/wh/task/"+hit.task_id);
      }}><Field name="item_scan" label="扫描同单样品码 S-..."/></Form>
      <div className="actions">
        {data.sibling_tasks.map((st:Row)=><Link key={st.id} className={st.id===id?"button primary":"button"} href={"/wh/task/"+st.id}>
          {st.item_code??("位置 #"+(st.position??"")) } · {label(st.state)}
        </Link>)}
      </div>
    </Panel>}
    {data.state==="READY"&&actor.roles.some((r:string)=>["inspector","super_admin"].includes(r))&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/start","POST",{revision:data.revision});reload();}}>领取并开始</Action>}
    <Panel title="检查进度与视图筛选">
      <div className="row">
        <div>
          <strong>已完成 {doneCount} / {allChecks.length} 项检查</strong>
          <span className="muted"> · 必拍机位 {(data.shots??[]).length} 张 · 剩余待补齐 {completeness.missing.length} 项</span>
        </div>
        <div className="actions">
          {([
            ["all",`全部 (${allChecks.length})`],
            ["pending",`待录入 (${pendingCount})`],
            ["issue",`异常/复测 (${issueCount})`],
            ["done",`已完成 (${doneCount})`],
          ] as const).map(([key,txt])=><button
            key={key}
            type="button"
            className={"button sm"+(checkFilter===key?" primary":"")}
            onClick={()=>setCheckFilter(key)}
          >{txt}</button>)}
        </div>
      </div>
    </Panel>
    {writable&&<Panel title="分步作业计时">
      <div className="actions">
        {([["prep","准备"],["measure","测量"],["visual","外观检查"],["compare","对比核对"]] as const).map(([code,name])=><Action key={code} run={async()=>{
          await request("/staff/inspection-tasks/"+id+"/steps","POST",{step_code:code,action:"record",seconds:60});reload();
        }}>记录 {name} 工时</Action>)}
      </div>
      {(data.step_timings?.length??0)>0&&<p className="muted small">已记录步骤：{data.step_timings.map((s:Row)=>`${s.step_code}(${s.seconds??0}s)`).join("、")}</p>}
    </Panel>}
    {data.content.measure_conditions&&<div className="notice"><strong>测量与拍摄条件</strong><p>{data.content.measure_conditions}</p></div>}
    {data.content.diagram&&<Panel title="标准测量部位与机位示意图">
      <div className="row" style={{alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <img src={data.content.diagram} alt="标准测量部位示意图" style={{maxWidth:360,border:"1px solid #cbd5e1",borderRadius:8,background:"#fff"}}/>
        <div className="small muted">
          <p><strong>示意图操作规范：</strong></p>
          <ul>
            <li>严格按红色标注线所示起止点自然平铺无拉伸测量。</li>
            <li>每个数值尺寸项需连续测量 2 次（差值 ≤0.5cm 取均值，超差触发第 3 次复核）。</li>
            <li>发现瑕疵部位请选择对应部位编码，并在照片上进行非破坏性框选标注（保留原图不覆写）。</li>
          </ul>
        </div>
      </div>
    </Panel>}
    {data.components.map((m:Row)=><Panel key={m.id} title={m.id==="main"?(data.item_code??"实物"):m.code}>
      {data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row)=>{
        const rowKey=`${m.id}:${c.key}`;
        const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
        const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
        const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
        const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
        const isDone=Boolean(prev && !retryNeeded && !prev?.details?.uncertain);
        const currentAnnotations:DefectAnnotation[]=annotationsByKey[rowKey]??(Array.isArray(prev?.details?.annotations)?prev.details.annotations:[]);
        if(checkFilter==="pending" && isDone) return null;
        if(checkFilter==="done" && !isDone) return null;
        if(checkFilter==="issue" && !isIssue) return null;
        const collapsed=isDone && !expandedKeys[rowKey];
        if(collapsed) {
          return <div className="check-compact-row" key={c.key} id={`comp-${m.id}-${c.key}`}>
            <div>
              <strong>{c.zh} · {c.label}</strong>{" "}
              <Tag tone={isIssue?"yellow":"green"}>{prev.status}</Tag>{" "}
              <span className="code">{prev.typed_value!=null?`${prev.typed_value}${prev.unit?" "+prev.unit:""}`:(prev.reason??"已记录")}</span>
              {currentAnnotations.length>0&&<> <Tag tone="red">标注 {currentAnnotations.length} 处</Tag></>}
            </div>
            <div className="actions">
              {prev.evidence_ids?.length>0&&<MediaButton ids={prev.evidence_ids} annotations={currentAnnotations} label={`证据照 (${prev.evidence_ids.length})`}/>}
              {writable&&<button type="button" className="button sm" onClick={()=>setExpandedKeys(s=>({...s,[rowKey]:true}))}>展开修改 / 复测</button>}
            </div>
          </div>;
        }
        const availParts:string[]=c.parts?.length?c.parts:(data.content.parts??[]);
        return <div className="card" key={c.key} id={`comp-${m.id}-${c.key}`}>
          <div className="row">
            <div>
              <h3 style={{margin:0}}>{c.zh} · {c.label}</h3>
              <p className="muted small" style={{margin:"4px 0 0"}}>{c.method}{c.unit?" · 单位 "+c.unit:""}{c.diagram?" · 示意图 "+c.diagram:""}</p>
            </div>
            <div className="actions">
              {writable && c.type!=="number" && !c.evidence && !prev && <Action sm run={async()=>{
                const payload={item_key:c.key,component:m.id,attempt:1,status:"NOT_OBSERVED",is_final:true,method:c.method};
                if(!online) { saveLocalDrafts([...drafts,payload]); return; }
                await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]});
                reload();
              }}>快速记为未见异常</Action>}
              {isDone&&<button type="button" className="button sm" onClick={()=>setExpandedKeys(s=>({...s,[rowKey]:false}))}>收起</button>}
            </div>
          </div>
          {attempts.length>0&&<p className="small">
            历史记录：{attempts.map((a:Row)=>`#${a.attempt}: ${a.status}${a.typed_value!=null?" "+a.typed_value+(a.unit??""):""}${a.details?.derived_circumference?" (推算周长 "+a.details.derived_circumference+"cm)":""}${a.is_final?" [最终值]":""}`).join(" | ")}
          </p>}
          {retryNeeded&&<p className="notice">两次测量差值超过阈值，请录入第 3 次复测值。</p>}
          {prev?.details?.uncertain&&<p className="notice">三次测量均超阈值，已取中位数并标记为不确定值（需填写原因说明）。</p>}
          {prev?.evidence_ids?.[0]&&writable&&<div style={{marginBottom:10}}>
            <DefectAnnotator
              mediaId={prev.evidence_ids[0]}
              annotations={currentAnnotations}
              onChange={next=>setAnnotationsByKey(s=>({...s,[rowKey]:next}))}
            />
          </div>}
          {writable&&<Form label="保存该项" run={async f=>{
            const status=text(f,"status"),value=text(f,"value"),reason=text(f,"reason"),photo=f.get("photo");
            const severity=text(f,"severity"),partCode=text(f,"part_code"),offlineSave=checked(f,"save_offline");
            const uploaded=photo instanceof File&&photo.size?[await upload(photo,"shot")]:[];
            const evidence=uploaded.length?uploaded:(prev?.evidence_ids??[]);
            if(status==="RECORDED"&&!value)throw new Error("录入实际值，或明确选择无法检查。");
            const typed=c.type==="number"?Number(value):c.type==="boolean"?value==="true":value;
            const details:Record<string,unknown>={
              ...(severity?{severity}:{}),
              ...(partCode?{part_code:partCode}:{}),
              ...(reason?{note:reason}:{}),
              ...(currentAnnotations.length?{annotations:currentAnnotations}:{}),
            };
            const payload={
              item_key:c.key,component:m.id,attempt:(attempts.at(-1)?.attempt??0)+1,status,is_final:true,method:c.method,
              ...(status==="RECORDED"?{typed_value:typed,...(c.unit?{unit:c.unit}:{})}:{}),
              ...(reason?{reason}:{}),
              ...(Object.keys(details).length?{details}:{}),
              ...(evidence.length?{evidence_ids:evidence}:{}),
            };
            if(offlineSave || !online) {
              saveLocalDrafts([...drafts.filter(d=>!(d.item_key===payload.item_key&&d.component===payload.component&&d.attempt===payload.attempt)),payload]);
              return;
            }
            try {
              await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]});
              setExpandedKeys(s=>({...s,[rowKey]:false}));
              reload();
            } catch(e) {
              if(e instanceof RequestError && e.code==="VERSION_CONFLICT") {
                saveLocalDrafts([...drafts,payload]);
                const fresh=await request("/staff/inspection-tasks/"+id);
                setConflict({localRevision:data.revision,serverRevision:fresh.revision,message:e.message});
                return;
              }
              throw e;
            }
          }}>
            <Select name="status" label="结果" value={prev?.status??"RECORDED"} choices={[
              {id:"RECORDED",label:"已测量或观察"},{id:"OBSERVED_ISSUE",label:"发现问题"},{id:"NOT_OBSERVED",label:"未观察到问题"},
              {id:"NOT_TESTED",label:"未检查"},{id:"NOT_APPLICABLE",label:"不适用"},{id:"BLOCKED",label:"无法继续"}]}/>
            {c.type==="boolean"?<Select name="value" label="观察值" required={false} choices={[{id:"true",label:"是"},{id:"false",label:"否"}]}/>:
              <Field name="value" label="实际值" required={false} value={prev?.typed_value??""} type={c.type==="number"?"number":"text"} step="any"/>}
            <Select name="severity" label="严重度（发现问题时必填）" required={false} choices={[
              {id:"attention",label:"Attention（需留意）"},{id:"material_issue",label:"Material issue（明显缺陷）"},{id:"uncertain",label:"Uncertain（不确定）"}
            ]}/>
            {availParts.length>0&&<Select name="part_code" label="缺陷部位" required={false} choices={availParts.map((p:string)=>({id:p,label:p}))}/>}
            <Field name="reason" label="观察说明或缺测原因（支持中文录入，复核时译为英文）" value={prev?.reason??""} required={false}/>
            <label>证据照片{c.evidence?"（提交前必填）":""}<FileInput name="photo" accept="image/*"/></label>
            <label className="check"><input type="checkbox" name="save_offline"/>暂存到本机离线队列（稍后批量同步）</label>
          </Form>}
        </div>;
      })}
      {(data.content.shots??[]).filter((s:Row)=>Boolean(data.group_id)||!s.component||s.component===m.id).map((s:Row)=>{
        const existing=(data.shots??[]).find((x:Row)=>x.shot_code===s.code&&(x.component??"main")===m.id);
        return <div className="card" key={s.code} id={`comp-${m.id}-${s.code}`}>
          <div className="row">
            <h3 style={{margin:0}}>必拍机位：{s.zh??s.name} · <span className="code">{s.code}</span></h3>
            {existing?<div className="actions"><Tag>已上传</Tag><MediaButton ids={[existing.id]} labels={[`${s.zh??s.name} (${s.code})`]} label="查看机位照片"/></div>:<span className="muted small">尚未上传本组件该机位照片</span>}
          </div>
          {writable&&<Form label="上传组件必拍照" run={async f=>{
            const mediaId=await upload(f.get("photo"),"shot");
            await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:m.id,shot_code:s.code,media_id:mediaId});
            reload();
          }}><Photo label="选择或拍摄机位照"/></Form>}
        </div>;
      })}
    </Panel>)}
    {data.group_id&&(data.content.order_shots?.length??0)>0&&<Panel title="对比组同框必拍照">
      {data.content.order_shots.map((code:string)=>{
        const existing=(data.shots??[]).find((x:Row)=>x.shot_code===code&&["group","order","main",null].includes(x.component));
        return <div className="card" key={code} id={`comp-group-${code}`}>
          <div className="row">
            <h3 style={{margin:0}}>对比组机位：<span className="code">{code}</span></h3>
            {existing?<div className="actions"><Tag>已上传</Tag><MediaButton ids={[existing.id]} labels={[`对比组 (${code})`]} label="查看对比组照"/></div>:<span className="muted small">尚未上传该对比组照</span>}
          </div>
          {writable&&<Form label="上传对比组照" run={async f=>{
            const mediaId=await upload(f.get("photo"),"shot");
            await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:"group",shot_code:code,media_id:mediaId});
            reload();
          }}><Photo label="拍摄并排对比照"/></Form>}
        </div>;
      })}
    </Panel>}
    <Panel title="提交前完整性检查">
      {completeness.ok?<p><Tag>完整性通过</Tag> 所有必测项、复测、证据照与组件必拍照均已齐全。</p>:<>
        <p className="notice">当前仍有 {completeness.missing.length} 项缺漏，补齐前不可提交任务：</p>
        <ul>{completeness.missing.map((item:Row,idx:number)=><li key={idx}>
          <a href={`#comp-${item.component}-${item.code}`}><strong>{item.sample_id} · {item.label}</strong></a>：{item.hint}
        </li>)}</ul>
      </>}
      {writable&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/submit","POST",{revision:data.revision});location.assign("/wh/inspection");}}>提交此任务</Action>}
    </Panel>
    {drafts.length>0&&!conflict&&writable&&<div className="sticky-batch-bar">
      <div><strong>本机已暂存 {drafts.length} 条结果草稿</strong> <span className="muted">确认网络畅通后可一键批量写入服务端</span></div>
      <div className="actions">
        <Action primary sm run={syncAllDrafts}>批量同步 {drafts.length} 项草稿</Action>
      </div>
    </div>}
  </>;
}
export function LogisticsDesk({actor}:{actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/tracking");
  const monitor=useLoad("/staff/tracking/monitor");
  const carriers=useLoad("/carriers");
  const [selectedId,setSelectedId]=useState<string>("");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const rows:Row[]=data?.rows??[];
  const selectedTrack=rows.find(r=>r.id===selectedId);
  const canTranslate=Boolean(actor?.roles?.some((r:string)=>["receiver","support","reviewer","warehouse_admin","super_admin"].includes(r)));
  const canCorrectWaybill=Boolean(actor?.roles?.some((r:string)=>["warehouse_admin","super_admin"].includes(r)));
  const isSuperAdmin=Boolean(actor?.roles?.includes("super_admin"));
  const carrierChoices=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  return <><div className="page-head row"><div><p className="eyebrow">TRACKING / OPERATIONS</p><h1>物流监控</h1><p className="muted">入仓、集运及退商家均显示中文原始轨迹与客户英文事件；点击任意运单号可速览关联包裹、订单与照片。</p></div><div className="head-actions"><button type="button" className="button sm" onClick={()=>{reload();monitor.reload();}}>刷新监控</button>{isSuperAdmin&&<Link className="button sm" href="/admin/integrations/logistics">物流接口配置</Link>}</div></div>
    {error&&<ErrorBlock error={error}/>}
    {monitor.error&&<ErrorBlock error={monitor.error}/>}
    {monitor.data&&<>
      <div className="stats" aria-label="物流监控指标">
        <div className="stat"><span className="label">24h 查询请求</span><strong className="value">{monitor.data.quota_summary.queries_24h}</strong><small className="detail">活跃订阅 {monitor.data.quota_summary.active_subscriptions}</small></div>
        <div className="stat"><span className="label">限频 / 额度告警</span><strong className="value">{monitor.data.quota_summary.rate_limited_24h + monitor.data.quota_summary.quota_exhausted_24h}</strong><small className="detail">鉴权异常 {monitor.data.quota_summary.auth_errors_24h}</small></div>
        <div className="stat"><span className="label">异常运输队列</span><strong className="value">{monitor.data.alerts.filter((a:Row)=>a.state!=="resolved").length}</strong><small className="detail">超期未处理 {monitor.data.alerts.filter((a:Row)=>a.overdue).length}</small></div>
        <div className="stat"><span className="label">已签收待实收</span><strong className="value">{monitor.data.delivered_unreceived.length}</strong><small className="detail">待人工核对包裹</small></div>
      </div>
      <div className="ops-columns">
        <Panel title="异常运输告警队列">
          <Table headers={["运单号","方向","异常类型","状态","截止时间","操作"]} rows={monitor.data.alerts.map((a:Row)=>[
            <CodeButton code={a.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:a.tracking_norm})}/>,
            label(a.direction),
            <span>{a.kind} · <Tag>Ep #{a.episode}</Tag></span>,
            <Tag>{a.state}{a.overdue?" (超期)":""}</Tag>,
            stamp(a.due_at),
            a.state!=="resolved"?<div className="actions">
              {a.state==="open"&&<Action sm run={async()=>{
                await request(`/staff/tracking-alerts/${a.id}`,"POST",{action:"acknowledge",note:"Acknowledged by staff"});
                monitor.reload();
              }}>认领跟进</Action>}
              <Action sm run={async()=>{
                await request(`/staff/tracking-alerts/${a.id}`,"POST",{action:"resolve",note:"Resolved after carrier check"});
                monitor.reload();
              }}>标记解除</Action>
            </div>:"已解除",
          ])} empty="当前无物流异常告警。"/>
        </Panel>
        <Panel title="承运商已签收但仓库未实收">
          <Table headers={["运单号","承运商","订单号","签收时间","最后轨迹摘要"]} rows={monitor.data.delivered_unreceived.map((d:Row)=>[
            <CodeButton code={d.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:d.tracking_norm})}/>,
            d.carrier_code,
            d.order_no?<Link className="code" href={`/admin/orders/${d.order_no}`}>{d.order_no}</Link>:"—",
            stamp(d.delivered_at),
            d.latest_cn??"—",
          ])} empty="所有承运商签收包裹均已登记实收。"/>
        </Panel>
      </div>
    </>}
    <Panel title="查询状态区分标准">
      <div className="row flexwrap" style={{justifyContent:"flex-start"}}>
        {["正常","无物流记录","需电话验证","暂不支持","数据陈旧","英文待更新","接口故障","已签收待入库","退回"].map(x=><Tag key={x} tone="gray">{x}</Tag>)}
      </div>
    </Panel>
    <Panel
      title="入仓与寄出运输"
      subtitle="点击运单号可速览关联包裹与订单，或点击右侧按钮展开双语翻译与修正面板。"
      badge={<button type="button" className="button sm" onClick={()=>{reload();monitor.reload();}}>刷新列表</button>}
    >
      <Table
        headers={["运单号","运输状态","同步状态","轨迹节点","最近同步","操作"]}
        rows={rows.map((r:Row)=>[
          <CodeButton code={r.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:r.tracking_norm})}/>,
          <Tag>{label(r.transport_state)}</Tag>,
          <Tag tone={r.sync_state==="active"?"green":"yellow"}>{label(r.sync_state)}</Tag>,
          `${r.events?.length??0} 条记录`,
          stamp(r.last_success_at),
          <button
            type="button"
            className={"button sm"+(selectedId===r.id?" primary":"")}
            onClick={()=>setSelectedId(prev=>prev===r.id?"":r.id)}
          >{selectedId===r.id?"收起工作区":"翻译与修正"}</button>,
        ])}
        empty="暂无入仓或寄出运输记录。"
      />
      {selectedTrack&&<div className="card-soft" style={{marginTop:14}}>
        <div className="row between" style={{marginBottom:12}}>
          <strong>运单轨迹详情 · <span className="code">{selectedTrack.tracking_norm}</span></strong>
          <button type="button" className="button sm ghost" onClick={()=>setSelectedId("")}>关闭</button>
        </div>
        <div className="grid cols4" style={{marginBottom:14}}>
          <dl className="def"><dt>运单编号</dt><dd className="code">{selectedTrack.tracking_norm}</dd></dl>
          <dl className="def"><dt>承运商运输状态</dt><dd>{label(selectedTrack.transport_state)}</dd></dl>
          <dl className="def"><dt>同步状态</dt><dd>{label(selectedTrack.sync_state)}</dd></dl>
          <dl className="def"><dt>最近成功同步</dt><dd>{stamp(selectedTrack.last_success_at)}</dd></dl>
        </div>
        {selectedTrack.events?.length
          ?<ol className="timeline">{selectedTrack.events.map((e:Row)=><li key={e.id}><small className="muted">{stamp(e.occurred_at)}</small><div>{e.text}</div></li>)}</ol>
          :<Empty>暂无承运商中文轨迹（本地未开启外部快递商实时回调时保持待查询状态）。</Empty>}
        {(selectedTrack.zh_events?.length??0)>0&&<div style={{marginTop:14}}>
          <h3 style={{marginBottom:8}}>客户英文轨迹翻译与双人复核</h3>
          <Table headers={["发生时间","中文原文","当前英文译文","状态","人工翻译 / 复核"]} rows={selectedTrack.zh_events.map((ev:Row)=>[
            stamp(ev.occurred_at??ev.source_time),
            ev.text_zh??"—",
            ev.text_en??<span className="muted">尚未录入</span>,
            <Tag tone={ev.reviewed_at?"green":ev.translation_id?"yellow":"gray"}>{ev.reviewed_at?"已独立复核":ev.translation_id?"草稿待复核":"待翻译"}</Tag>,
            canTranslate?<div className="stack" style={{gap:6}}>
              <Form inline key={`tr-${ev.id}-${ev.translation_id??"new"}`} label="提交英文译稿" run={async f=>{
                await request(`/staff/tracking/${selectedTrack.id}/translations`,"POST",{
                  tracking_event_id:ev.id,
                  source_hash:ev.source_hash,
                  text_en:text(f,"text_en"),
                });
                reload();
              }}>
                <Field name="text_en" label="英文轨迹译文" value={ev.text_en??""}/>
              </Form>
              {ev.translation_id&&!ev.reviewed_at&&(
                ev.translation_source==="draft:"+actor?.id
                  ?<small className="muted">本人起草，须由另一名员工独立复核</small>
                  :<Action sm primary run={async()=>{
                    await request(`/staff/tracking-translations/${ev.translation_id}/approve`,"POST",{});
                    reload();
                  }}>独立复核通过</Action>
              )}
            </div>:"—",
          ])}/>
        </div>}
        {canCorrectWaybill&&carrierChoices.length>0&&<details className="card" style={{marginTop:14}}>
          <summary>修正运单号或承运商（需 15 分钟内员工验证登录会话）</summary>
          <p className="small muted">原运单记录将归档为 superseded 并保留历史快照；已交接出库运单修正必须上传面单照片凭证。</p>
          <Form key={`corr-${selectedTrack.id}-${selectedTrack.revision}`} label="确认修正运单" run={async f=>{
            const file=f.get("photo");
            const evidenceIds:string[]=[];
            if(file instanceof File && file.size>0) {
              evidenceIds.push(await upload(file,"label_photo"));
            } else if(selectedTrack.shipment_id) {
              throw new Error("已出库运单修正必须上传面单照片凭证。");
            }
            await request(`/staff/tracking/${selectedTrack.id}/correct`,"POST",{
              revision:selectedTrack.revision??1,
              carrier_code:text(f,"carrier_code"),
              tracking_no:text(f,"tracking_no"),
              reason:text(f,"reason"),
              ...(evidenceIds.length?{evidence_ids:evidenceIds}:{}),
            });
            setSelectedId("");
            reload();
            monitor.reload();
          }}>
            <Select name="carrier_code" label="更正后承运商" value={selectedTrack.carrier_code??carrierChoices[0]?.id} choices={carrierChoices}/>
            <Field name="tracking_no" label="更正后运单号" value={selectedTrack.tracking_norm}/>
            <Field name="reason" label="更正原因（审计必填）"/>
            <label>面单照片凭证{selectedTrack.shipment_id?"（出库运单必填）":"（可选）"}<FileInput name="photo" accept="image/*" required={Boolean(selectedTrack.shipment_id)}/></label>
          </Form>
        </details>}
      </div>}
    </Panel>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}
export function LogisticsConfiguration() {
  const {data,error,reload}=useLoad("/staff/admin/tracking/health");
  const monitor=useLoad("/staff/tracking/monitor");
  return <><div className="page-head row"><div><p className="eyebrow">TRACKING / CONFIGURATION</p><h1>物流供应商接入</h1><p className="muted">供应商配置、承运商覆盖、额度、错误及恢复状态。</p></div><Link className="button sm" href="/admin/logistics">物流监控</Link></div>
    <Panel title="快递100配置预检" subtitle="状态来自当前应用配置。承运商覆盖、接口连通性和额度需用实际账号联调确认。" badge={<button type="button" className="button sm" onClick={()=>{reload();monitor.reload();}}>重新读取配置</button>}>
      {error?<ErrorBlock error={error}/>:data?<Table headers={["检查项","配置状态"]} rows={[
        ["运单查询",data.queryConfigured?"已配置":"未配置"],
        ["HTTPS 回调地址",data.httpsCallbackConfigured?"已配置":"未配置"],
        ["订阅接入",data.subscribeConfigured?"已配置":"未配置"],
        ["自动同步配置",data.workerEnabled?"已启用":"未启用"],
      ]}/>:<p role="status">正在读取配置…</p>}
    </Panel>
    {monitor.data&&<Panel title="首发承运商字典与手机号校验规则">
      <Table headers={["承运商编码","中文名称","英文名称","手机号尾号要求","状态"]} rows={monitor.data.carriers.map((c:Row)=>[
        <strong className="code">{c.code}</strong>,
        c.name_zh,
        c.name_en,
        c.requires_phone?<Tag>需收/寄件人手机号后4位</Tag>:"免手机号",
        <Tag>{c.active?"已启用":"已停用"}</Tag>,
      ])} empty="暂无承运商配置。"/>
    </Panel>}
  </>;
}
export function AdminDesk({actor,path}:{actor:Row;path:string}) {
  const {data,error,reload}=useLoad("/staff/admin/desk"),terms=useLoad("/public/terms");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
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
  const page=rawPage==="categories"?"catalog":rawPage;
  const superAdmin=actor.roles.includes("super_admin");
  const canReviewTemplate=actor.roles.some((r:string)=>["reviewer","super_admin"].includes(r));
  const canAuthorTemplate=actor.roles.some((r:string)=>["template_admin","super_admin"].includes(r));
  const links=staffTabs("admin",actor.roles);
  const heading:Record<string,[string,string]>={
    overview:["运营总览","按权限聚合订单、实物、报告、资金与异常。"],
    orders:["订单与样品管理","客服检索订单、运单与样品；客户信息在生产按角色裁剪。"],
    dispositions:["处置与发运报价","核对每件授权、运价、重量、例外原因及交接凭证。"],
    refunds:["退款审批","退款申请、审批、渠道执行与实际到账是不同事件。"],
    payments:["支付与对账","按用途对账，区分发起、待处理、渠道确认与争议处置。"],
    finance:["财务分析","金额按收款目的拆分；测试订单剔除真实收入统计。"],
    incidents:["库存事故与异常","样品丢损、冻结、调查、客户解决方案和赔偿审批。"],
    catalog:["品类与服务目录","分类、服务类型、检查模板与可售报价 SKU 分离管理。"],
    templates:["品类检查模板","受控字段、版本、证据要求和双语文案；发布后的模板不可修改。"],
    "shipping-rates":["运费费率与试算","仅配置批准的目的地区域、计重规则和版本历史。"],
    config:["业务参数与收货地址","所有共享地址、工作日历与保管规则版本化管理，不在前端写死。"],
    legal:["条款与声明管理","审阅、版本化、独立批准和发布；客户历史同意版本可追溯。"],
    users:["员工账号与权限","生产操作权限由服务端强制，关键敏感动作执行双人或二次认证守卫。"],
    settings:[superAdmin?"仓址与检查模板":"检查模板","维护当前配置与版本记录。"],
  };
  const currentHeading=heading[page]??["运营总览",""];
  const activeLinks=links.filter(([href])=>href!=="/admin");
  const canHandleOrders=activeLinks.some(([href])=>href==="/admin/orders");
  const queue=canHandleOrders?[
    ...data.claims.filter((c:Row)=>c.state==="open").map((c:Row)=>({number:c.public_no,action:"核验包裹归属",detail:c.tracking_no,href:"/admin/orders#case-"+c.id})),
    ...data.manualQuotes.filter((q:Row)=>q.state==="requested").map((q:Row)=>({number:q.public_no,action:"人工报价",detail:q.reason,href:"/admin/orders#case-"+q.id})),
  ].slice(0,8):[];
  const requestedRefunds=activeLinks.some(([href])=>href==="/admin/finance"||href==="/admin/refunds")?data.refunds.filter((r:Row)=>r.state==="requested").length:0;
  const pad2=(n:number)=>String(n).padStart(2,"0");
  const m=data.overviewMetrics??{};
  return <><div className="page-head row"><div><p className="eyebrow">OPERATIONS / 管理</p><h1>{currentHeading[0]}</h1><p className="muted">{currentHeading[1]}</p></div>
    {page==="overview"&&canHandleOrders&&<div className="head-actions"><Link className="button primary" href="/admin/orders">查看订单</Link></div>}
  </div>
    {superAdmin&&data.warehouseAddressAlert&&<div className="notice">
      客户已领码，默认收件仓址待发布。<Link href="/admin/config">设置仓址</Link>
    </div>}
    {page==="overview"&&<>
      <div className="stats" aria-label="运营总览指标">
        <Link href="/admin/orders?state=awaiting_samples" className="stat">
          <span className="label">待核实实物</span>
          <strong className="value">{pad2((m.awaiting_samples??0)+(m.unmatched_packages??0))}</strong>
          <small className="detail">含未匹配包裹 {m.unmatched_packages??0} 件</small>
        </Link>
        <Link href="/admin/orders?state=queued" className="stat">
          <span className="label">超时检查</span>
          <strong className="value">{pad2(m.sla_overdue??0)}</strong>
          <small className="detail">排队/检验中 {m.queued_or_inspecting??0} 单</small>
        </Link>
        <Link href="/admin/dispositions" className="stat">
          <span className="label">待客户确认</span>
          <strong className="value">{pad2((m.dispatch_pending??0)+data.manualQuotes.length)}</strong>
          <small className="detail">含逐件处置与人工报价</small>
        </Link>
        <Link href={superAdmin?"/admin/refunds":"/admin/finance"} className="stat">
          <span className="label">退款待审批</span>
          <strong className="value">{pad2(requestedRefunds)}</strong>
          <small className="detail">请求 ≠ 已退款</small>
        </Link>
      </div>
      <div className="grid cols2">
        <Panel title="流程健康度" subtitle="生产汇总与明细筛选采用同一口径（近 9 日 UTC 正式单趋势）。">
          <div className="bars" aria-label="近 9 日作业趋势">
            {(()=>{
              const trend:Row[]=data.dailyTrend??[];
              const maxTotal=Math.max(1,...trend.map((t:Row)=>Number(t.total??0)));
              return trend.map((t:Row)=><span
                key={t.day}
                style={{height:`${Math.max(8,Math.round((Number(t.total??0)/maxTotal)*100))}%`}}
                data-v={`${t.day} · 新建 ${t.total} / 已出报告 ${t.completed}`}
              />);
            })()}
          </div>
          <div className="row between small muted">
            <span>正式订单 {m.production_orders??0} · 测试订单 {m.test_orders??0}</span>
            <span>待 QA 复核 {m.qa_review??0} 单</span>
          </div>
        </Panel>
        <Panel title="需要处理的运营问题">
          <div className="list">
            {[
              ["/admin/logistics","物流签收但未实收",`${m.unmatched_packages??0} 个待人工核对包裹`],
              [superAdmin?"/admin/incidents":"/admin/tickets","实物差异与客服工单",`${m.open_tickets??0} 项待处理事件`],
              [superAdmin?"/admin/refunds":"/admin/finance","退款与争议审批",`${requestedRefunds+(m.open_disputes??0)} 项待复核`],
              [superAdmin?"/admin/operations":"/admin","后台重试队列",`${data.jobErrors.length} 个失败的异步适配任务`],
            ].map(([href,title,desc])=><div key={title} className="row between" style={{borderBottom:"1px solid var(--line)",padding:"11px 0"}}>
              <div><strong>{title}</strong><div className="small muted">{desc}</div></div>
              <Link className="button sm" href={href}>打开 →</Link>
            </div>)}
          </div>
        </Panel>
        <Panel title="跨部门数据索引">
          <div className="grid cols3">
            {[
              ["/admin/orders","订单"],
              ["/admin/tickets","工单"],
              [superAdmin?"/admin/dispositions":"/admin/orders","处置"],
              [superAdmin?"/admin/payments":"/admin/finance","资金"],
              [superAdmin?"/admin/catalog":"/admin/settings","目录"],
              [superAdmin?"/admin/audit":"/admin","审计"],
            ].map(([href,name])=><Link key={name} className="button sm" href={href}>{name}</Link>)}
          </div>
        </Panel>
        <Panel title="生产发布提醒">
          <p className="small">开发、模拟测试、真实支付联调、实仓验收和正式开放是不同的里程碑。未完成上线门禁签署前默认保持预发布保护。</p>
          <Tag tone={data.effectiveLaunchMode==="production"?"green":"yellow"}>Production gate: {data.effectiveLaunchMode??"staging_only"}</Tag>
        </Panel>
      </div>
      {canHandleOrders&&queue.length>0&&<Panel title="客服待处理队列">
        <Table headers={["业务编号","待办","线索"]} rows={queue.map(entry=>[<Link className="code" href={entry.href}>{entry.number}</Link>,entry.action,entry.detail])}/>
      </Panel>}
    </>}
    {page==="orders"&&<>
      <StaffOrderList/>
      {data.claims.length>0&&<Panel title="未匹配包裹认领" id="claims">
        {data.claims.map((c:Row)=><details key={c.id} className="card" id={"case-"+c.id}>
          <summary>{c.public_no} · {c.carrier_code} {c.tracking_no} · {c.decision??c.state}</summary>
          <div className="actions" style={{marginBlock:8}}>
            {c.tracking_no&&<CodeButton code={c.tracking_no} onClick={()=>setDrawer({kind:"tracking",ref:c.tracking_no})}/>}
            {c.proof_id&&<MediaButton ids={[c.proof_id]} labels={[`${c.public_no} 客户发货凭证`]} label="查看客户发货凭证"/>}
            {c.outer_photo_ids?.length>0&&<MediaButton ids={c.outer_photo_ids} label={`核对仓库外箱照片 (${c.outer_photo_ids.length})`}/>}
          </div>
          {c.state==="open"&&<Form label="记录核验结论" run={async f=>{
            const decision=text(f,"decision");
            if(decision==="approve"&&!c.outer_photo_ids.length)throw new Error("先确认实物入库及外箱凭证。");
            await request("/staff/intake-claims/"+c.id+"/decision","POST",{decision,reason:text(f,"reason")});reload();
          }}><Select name="decision" label="归属核验" choices={[{id:"approve",label:"核实通过并认领"},{id:"reject",label:"驳回"}]}/>
            <Field name="reason" label="核验证据和原因"/></Form>}
        </details>)}
      </Panel>}
    </>}
    {page==="dispositions"&&<>
      <Panel title="人工询价与例外报价" id="manual-quotes">
        {!data.manualQuotes.length&&<Empty>当前没有待人工报价的例外申请。</Empty>}
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
      </Panel>
      <OverdueDisposalDesk/>
    </>}
    {page==="incidents"&&<StocktakeReviewAndIncidentPanel/>}
    {(page==="refunds"||(page==="finance"&&!superAdmin))&&<>
      <Panel title="退款审批队列" subtitle="原收费项与可退余额必须先核验，申请与独立审批分离。">
        <Table headers={["原收费","申请原因","金额","退款状态","渠道凭据","操作"]} rows={data.refunds.map((r:Row)=>[
          <div><strong>{r.public_no??({inspection:"质检费",dispatch:"运费",storage:"保管费"} as Row)[r.purpose]}</strong><br/><small className="code">{r.payment_id}</small></div>,
          r.reason,usd(r.amount_cents),<Tag>{r.state==="requested"?"待独立审批":label(r.state)}</Tag>,r.provider_ref??"—",
          r.state==="requested"&&superAdmin?(r.requested_by===actor.id?<small>等待另一位超管审批</small>:<RefundApproval refund={r} reload={reload}/>):null,
        ])} empty="近期没有退款申请记录。"/>
      </Panel>
      <OrderRefundDesk/>
    </>}
    {(page==="payments"||(page==="finance"&&!superAdmin))&&<>
      <Panel title="收费项目与支付流水">
        <Table headers={["付款 ID","金额","状态","渠道凭据"]} rows={data.payments.map((p:Row)=>[<span className="code">{p.id}</span>,usd(p.amount_cents),<Tag>{p.state}</Tag>,<span className="code">{p.provider_ref??"—"}</span>])} empty="暂无支付流水记录。"/>
        {actor.roles.some((r:string)=>["support","super_admin"].includes(r))&&data.payments.some((p:Row)=>p.state==="succeeded")&&<Form label="建立退款申请" run={async f=>{
          await request("/staff/payments/"+text(f,"payment")+"/refunds","POST",{amount_cents:Math.round(Number(text(f,"amount"))*100),reason:text(f,"reason")});reload();
        }}><Select name="payment" label="实收付款" choices={data.payments.filter((p:Row)=>p.state==="succeeded").map((p:Row)=>({id:p.id,label:p.id+" · "+usd(p.amount_cents)}))}/>
        <Field name="amount" label="退款金额（USD）" type="number" min={.01} step=".01"/><Field name="reason" label="退款原因"/></Form>}
      </Panel>
      <Panel title="支付争议与阻断处置">
        <Table headers={["争议编号","关联订单/批次","争议金额","状态","原因","人工结论","操作"]} rows={(data.disputes??[]).map((d:Row)=>[
          <span className="code">{d.provider_dispute_id}</span>,
          d.public_no?<Link className="code" href={`/admin/orders/${d.public_no}`}>{d.public_no}</Link>:(d.batch_id?<CodeButton code={`Batch #${d.batch_id.slice(0,8)}`} onClick={()=>setDrawer({kind:"batch",ref:d.batch_id})}/>:"—"),
          usd(d.amount_cents),
          <Tag>{d.status}</Tag>,
          d.reason??"—",
          d.staff_decision?`${d.staff_decision} (${d.staff_note??""})`:"—",
          ["needs_response","under_review","warning_needs_response"].includes(d.status)?<small className="muted">等待渠道结案后裁决</small>:
          d.status!=="resolved_by_staff"?<Form inline label="裁决争议" run={async f=>{
            await request("/staff/disputes/"+encodeURIComponent(d.provider_dispute_id)+"/resolve","POST",{
              decision:text(f,"decision"),
              reason:text(f,"reason"),
            });
            reload();
          }}>
            <Select name="decision" label="动作" choices={[
              {id:"release_freeze",label:"解除出库与报告冻结"},
              {id:"maintain_hold",label:"维持冻结"},
            ]}/>
            <Field name="reason" label="裁决原因"/>
          </Form>:"已结案裁决",
        ])} empty="当前无支付拒付或争议记录。"/>
      </Panel>
    </>}
    {page==="finance"&&<FinanceReconciliationPanel onOpenDrawer={setDrawer}/>}
    {(page==="config"||page==="settings")&&superAdmin&&<>
      <Panel title="仓库收货地址版本" subtitle="切换默认地址不会影响仍发往历史地址的在途包裹入库。">
        <Table headers={["中文地址","英文地址","收件人/电话","关联预报数","状态","操作"]} rows={data.addresses.map((a:Row)=>[
          a.address_zh,
          a.address_en,
          `${a.contact_name} (${a.contact_phone})`,
          a.advice_count??0,
          <Tag>{a.is_default?"唯一默认":a.active?"候选启用":"已停用(历史保留)"}</Tag>,
          <div className="actions">
            {!a.is_default&&<Action run={async()=>{
              await request("/staff/admin/warehouse-addresses/"+a.id,"POST",{is_default:true});
              reload();
            }}>设为默认</Action>}
            {!a.is_default&&<Action run={async()=>{
              await request("/staff/admin/warehouse-addresses/"+a.id,"POST",{active:!a.active});
              reload();
            }}>{a.active?"停用":"启用"}</Action>}
          </div>,
        ])}/>
        <Form label="新增公共收件仓址" run={async f=>{
          await request("/staff/admin/warehouse-addresses","POST",{
            address_zh:text(f,"address_zh"),
            address_en:text(f,"address_en"),
            contact_name:text(f,"contact_name"),
            contact_phone:text(f,"contact_phone"),
            is_default:text(f,"is_default")==="true",
          });
          reload();
        }}>
          <Field name="address_zh" label="中文地址"/><Field name="address_en" label="英文地址"/>
          <Field name="contact_name" label="仓库收件人"/><Field name="contact_phone" label="仓库电话"/>
          <Select name="is_default" label="是否立即设为唯一默认" choices={[{id:"true",label:"设为唯一默认"},{id:"false",label:"作为候选仓址保存"}]}/>
        </Form>
      </Panel>
      <BusinessCalendarEditor calendar={data.calendar} onSave={reload}/>
    </>}
    {page==="legal"&&superAdmin&&<Panel title="合规文档与条款版本列表">
      <Table headers={["类型","版本号","状态","生效时间","内容哈希","操作"]} rows={(data.termsVersions??[]).map((t:Row)=>[
        <span className="code">{t.kind}</span>,
        <span className="code">{t.version}</span>,
        <Tag>{t.state}</Tag>,
        t.effective_at?stamp(t.effective_at):"草稿待发布",
        <span className="code">{String(t.content_hash??"").slice(0,12)}</span>,
        <div className="actions">
          {t.state==="draft"&&<Action primary run={async()=>{
            await request("/staff/admin/terms/"+t.id+"/publish","POST",{});
            reload();
          }}>发布生效</Action>}
        </div>,
      ])} empty="暂无条款版本。"/>
      <Form label="创建条款版本（预览或直接发布）" run={async f=>{
        await request("/staff/admin/terms","POST",{
          kind:text(f,"kind"),
          version:text(f,"version"),
          content_md:text(f,"content_md"),
          publish_now:text(f,"publish_now")==="true",
        });
        reload();
      }}>
        <Select name="kind" label="条款类型" choices={[
          {id:"terms",label:"服务条款 (terms)"},
          {id:"privacy",label:"隐私政策 (privacy)"},
          {id:"restricted_items",label:"禁限寄说明 (restricted_items)"},
          {id:"report_notice",label:"报告使用声明 (report_notice)"},
        ]}/>
        <Field name="version" label="版本号 (如 2026.2)"/>
        <Select name="publish_now" label="发布方式" choices={[
          {id:"false",label:"先保存草稿预览"},
          {id:"true",label:"立即发布生效"},
        ]}/>
        <label>Markdown 正文<textarea name="content_md" required minLength={10}/></label>
      </Form>
    </Panel>}
    {page==="users"&&superAdmin&&<StaffAndCustomerUsersDesk
      staffUsers={data.staffUsers??[]}
      customerUsers={data.customerUsers??[]}
      actor={actor}
      onSave={reload}
    />}
    {(page==="catalog"||page==="settings")&&<>
      <Panel title="类目运营准入" subtitle="新增分类不代表自动开放付费下单。">
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
      {superAdmin&&<Panel title="可售套餐与版本价格" subtitle="生产价格调整生成新版本并由服务端签发，旧订单保留原始价格快照。">
        <Table headers={["SKU","名称","价格版本","计价规则","状态"]} rows={(data.offers??[]).map((o:Row)=>[
          <span className="code">{o.sku_code}</span>,o.title?.["zh-CN"]??o.title?.en??o.sku_code,
          o.price_version?`v${o.price_version}`:"—",
          o.rules?`${o.rules.minimum}–${o.rules.maximum} 件 · ${usd(o.rules.package_cents??o.rules.unit_cents)} · ${o.rules.business_days} 工作日`:"—",
          <Tag>{o.enabled?"可售":"已停用"}</Tag>,
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
        {(data.templates??[]).some((t:Row)=>t.state==="PUBLISHED")&&<details className="card" style={{marginTop:12}}>
          <summary>新建或绑定可售套餐 SKU（关联已发布模板）</summary>
          <p className="small muted">新准入品类（如箱包、家居用品）完成能力审批与模板发布后，可在此直接创建可售套餐并生效上架，无需改动通用业务代码。</p>
          <Form label="创建并发布套餐 SKU" run={async f=>{
            const tplId=text(f,"template_version_id");
            const tpl=(data.templates??[]).find((t:Row)=>t.id===tplId);
            if(!tpl) throw new Error("请选择已发布的检验模板版本。");
            const cents=Math.round(Number(text(f,"price"))*100);
            const isPkg=text(f,"pricing_mode")==="package";
            await request("/staff/admin/offers","POST",{
              sku_code:text(f,"sku_code").toLowerCase(),
              category_id:tpl.category_id,
              service_type_id:tpl.service_type_id,
              template_version_id:tpl.id,
              title:{en:text(f,"title_en"),"zh-CN":text(f,"title_zh")},
              enabled:true,
              rules:{
                minimum:Number(text(f,"minimum")),
                maximum:Number(text(f,"maximum")),
                ...(isPkg?{package_cents:cents}:{unit_cents:cents}),
                business_days:Number(text(f,"days")),
              },
            });
            reload();
          }}>
            <Select name="template_version_id" label="绑定已发布检验模板" choices={(data.templates??[]).filter((t:Row)=>t.state==="PUBLISHED").map((t:Row)=>{
              const cat=(data.categories??[]).find((c:Row)=>c.id===t.category_id);
              const svc=(data.services??[]).find((s:Row)=>s.id===t.service_type_id);
              return {id:t.id,label:`${cat?.labels?.["zh-CN"]??cat?.slug??"类目"} · ${svc?.labels?.["zh-CN"]??svc?.code??"服务"} · ${t.template_key} v${t.version}`};
            })}/>
            <div className="inline-form">
              <Field name="sku_code" label="SKU 编码（小写字母/数字/连字符）"/>
              <Field name="title_zh" label="套餐中文名称"/>
              <Field name="title_en" label="套餐英文名称"/>
            </div>
            <div className="inline-form">
              <Select name="pricing_mode" label="计价方式" choices={[{id:"unit",label:"按件计价 (unit_cents)"},{id:"package",label:"整包一口价 (package_cents)"}]}/>
              <Field name="minimum" label="最少件数" type="number" min={1} max={100} value={1}/>
              <Field name="maximum" label="最多件数" type="number" min={1} max={100} value={50}/>
              <Field name="price" label="单价 / 包价（USD）" type="number" min={.01} step=".01" value={15}/>
              <Field name="days" label="承诺工作日" type="number" min={1} max={180} value={3}/>
            </div>
          </Form>
        </details>}
      </Panel>}
    </>}
    {(page==="templates"||page==="settings")&&<>
      <Panel title="检验能力准入与独立审批">
        <Table headers={["能力编码","检验方法","状态","操作"]} rows={(data.allCapabilities??data.capabilities).map((cap:Row)=>[
          <span className="code">{cap.code}</span>,cap.method,
          <Tag>{cap.revoked_at?"已撤销":cap.approved_by?"已批准":"待独立审批"}</Tag>,
          !cap.revoked_at&&!cap.approved_by&&canReviewTemplate&&cap.approval?.author_id!==actor.id?
            <Action run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/approve","POST",{});reload();}}>独立批准能力</Action>:
          !cap.revoked_at&&cap.approved_by&&superAdmin?
            <Action run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/revoke","POST",{reason:"后台调整能力准入"});reload();}}>撤销能力</Action>:null,
        ])} empty="暂无检验能力记录。"/>
        {canAuthorTemplate&&<Form inline label="提交检验能力" run={async f=>{
          await request("/staff/admin/capabilities","POST",{code:text(f,"code"),method:text(f,"method")});reload();
        }}><Field name="code" label="能力编码"/><Field name="method" label="标准方法与工具说明"/></Form>}
      </Panel>
      <Panel title="模板仓库与独立审核发布">
        <Table headers={["模板键","版本","状态","关联能力","检查项预览","操作"]} rows={data.templates.map((t:Row)=>[
          <span className="code">{t.template_key}</span>,`v${t.version}`,<Tag>{t.state}</Tag>,
          (t.capability_codes??[]).join(", ")||"—",
          t.content?.checks?`${t.content.checks.length} 项（${t.content.checks.map((c:Row)=>c.zh||c.key).join("、")}）`:"—",
          t.state==="IN_REVIEW"&&canReviewTemplate&&t.author_id!==actor.id?
            <Action run={async()=>{await request("/staff/admin/templates/"+t.id+"/publish","POST",{});reload();}}>独立审核发布</Action>:
          t.state==="IN_REVIEW"&&t.author_id===actor.id?<small>等待非作者独立复核</small>:null,
        ])} empty="暂无模板版本。"/>
        {!!data.categories.length&&canAuthorTemplate&&<TemplateAuthorForm
          categories={data.categories}
          services={data.services}
          capabilities={data.capabilities}
          onSave={reload}
        />}
      </Panel>
    </>}
    {page==="shipping-rates"&&superAdmin&&<ShippingRateConfigPanel rates={data.shippingRates??[]} onSave={reload}/>}
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}

const STAFF_ROLE_OPTIONS:[string,string,string][]=[
  ["receiver","收货员 (receiver)","扫描运单、包裹实收建档、拆包上架与实物识别"],
  ["inspector","检查员 (inspector)","领取质检任务、录入实测数据与上传机位证据照"],
  ["reviewer","独立复核员 (reviewer)","非本人报告复核批准、检查能力与模板独立审核"],
  ["warehouse_admin","仓管主管 (warehouse_admin)","库位管理、出库称重报价、打包交接与盘点复核"],
  ["support","客服专员 (support)","订单查询、工单回复、未匹配包裹认领与异常跟进"],
  ["finance","财务专员 (finance)","联合对账账本、退款核验与事故赔付打款核销"],
  ["template_admin","模板管理员 (template_admin)","规划品类、提交检验能力与编写品类检查模板"],
  ["super_admin","超级管理员 (super_admin)","全局配置、条款发布、价格上架、权限管控与双人终审"],
];

function BusinessCalendarEditor({calendar,onSave}:{calendar?:Row;onSave:()=>void}) {
  const [holidays,setHolidays]=useState<string[]>(()=>[...(calendar?.holidays??[])].sort());
  const [workdays,setWorkdays]=useState<string[]>(()=>[...(calendar?.extra_workdays??[])].sort());
  const [pickHoliday,setPickHoliday]=useState("");
  const [pickWorkday,setPickWorkday]=useState("");
  useEffect(()=>{
    setHolidays([...(calendar?.holidays??[])].sort());
    setWorkdays([...(calendar?.extra_workdays??[])].sort());
  },[calendar]);
  const addDate=(list:string[],setter:(v:string[])=>void,ymd:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || list.includes(ymd)) return;
    setter([...list,ymd].sort());
  };
  return <Panel title="工作日历与节假日配置" subtitle="通过日历点选添加或移除日期，SLA 承诺工作日自动跳过法定节假日并计入调休补班日。">
    <div className="ops-columns">
      <div className="card" style={{margin:0}}>
        <h3 style={{marginTop:0}}>法定节假日 ({holidays.length})</h3>
        <div className="inline-form">
          <div style={{flex:"1 1 200px"}}>
            <DateInput name="pick_holiday" onValueChange={setPickHoliday}/>
          </div>
          <button type="button" className="button sm" disabled={!pickHoliday} onClick={()=>addDate(holidays,setHolidays,pickHoliday)}>+ 添加节假日</button>
        </div>
        <div className="date-chips">
          {holidays.length?holidays.map(d=><span key={d} className="date-chip">{d}<button type="button" aria-label={`移除 ${d}`} onClick={()=>setHolidays(holidays.filter(x=>x!==d))}>×</button></span>):<span className="muted small">暂未配置节假日</span>}
        </div>
      </div>
      <div className="card" style={{margin:0}}>
        <h3 style={{marginTop:0}}>调休补班工作日 ({workdays.length})</h3>
        <div className="inline-form">
          <div style={{flex:"1 1 200px"}}>
            <DateInput name="pick_workday" onValueChange={setPickWorkday}/>
          </div>
          <button type="button" className="button sm" disabled={!pickWorkday} onClick={()=>addDate(workdays,setWorkdays,pickWorkday)}>+ 添加补班日</button>
        </div>
        <div className="date-chips">
          {workdays.length?workdays.map(d=><span key={d} className="date-chip">{d}<button type="button" aria-label={`移除 ${d}`} onClick={()=>setWorkdays(workdays.filter(x=>x!==d))}>×</button></span>):<span className="muted small">暂未配置调休补班日</span>}
        </div>
      </div>
    </div>
    <div className="actions" style={{marginTop:12}}>
      <Action primary run={async()=>{
        await request("/staff/admin/calendar","POST",{holidays,extra_workdays:workdays});
        onSave();
      }}>保存工作日历配置</Action>
    </div>
  </Panel>;
}

function StaffAndCustomerUsersDesk({
  staffUsers,customerUsers,actor,onSave,
}:{
  staffUsers:Row[];customerUsers:Row[];actor:Row;onSave:()=>void;
}) {
  const [editingStaff,setEditingStaff]=useState<Row|null>(null);
  const [selectedRoles,setSelectedRoles]=useState<string[]>([]);
  const [editingCustomer,setEditingCustomer]=useState<Row|null>(null);
  const [custQuery,setCustQuery]=useState("");
  const [custStatus,setCustStatus]=useState("");
  const openStaffEditor=(u:Row)=>{
    setSelectedRoles([...(u.roles??[])]);
    setEditingStaff(u);
  };
  const filteredCustomers=customerUsers.filter(c=>{
    const q=custQuery.trim().toLowerCase();
    const matchQ=!q || String(c.receiving_code??"").toLowerCase().includes(q) || String(c.email??"").toLowerCase().includes(q);
    const matchSt=!custStatus || c.status===custStatus;
    return matchQ && matchSt;
  });
  return <>
    <Panel title="员工权限列表" subtitle="点击「配置角色权限」通过多选卡片调整岗位权限；变更角色或停用账号均记录审计原因并即时生效。">
      <Table headers={["员工账号","状态","当前角色","权限与账号管控"]} rows={staffUsers.map((u:Row)=>[
        <div key={u.id} className="cell-stack">
          <strong>{u.display_name??u.id.slice(0,8)}</strong>
          <small className="code">{u.email??"—"}</small>
        </div>,
        <Tag key="st">{u.status}</Tag>,
        <div key="roles" className="actions">
          {(u.roles??[]).length?(u.roles as string[]).map(r=><Tag key={r} tone="blue">{r}</Tag>):<span className="muted">未分配角色</span>}
        </div>,
        <div key="ops" className="actions">
          <button type="button" className="button sm primary" onClick={()=>openStaffEditor(u)}>配置角色权限</button>
          {u.id!==actor.id&&<Action sm run={async()=>{
            const nextStatus=u.status==="disabled"?"active":"disabled";
            await request("/staff/users/"+u.id+"/status","POST",{status:nextStatus,reason:nextStatus==="disabled"?"后台停用员工账号":"后台恢复员工账号"});
            onSave();
          }}>{u.status==="disabled"?"恢复账号":"停用账号"}</Action>}
        </div>,
      ])} empty="暂无员工账号。"/>
    </Panel>
    <Panel title="客户账号与专属收件码目录" subtitle="按永久收件码 QCW-... 或注册邮箱检索客户，查看履约统计或执行风控状态调整。">
      <div className="form inline-form" style={{marginBottom:12}}>
        <label>搜索收件码或邮箱<input type="search" placeholder="QCW-... 或客户邮箱" value={custQuery} onChange={e=>setCustQuery(e.target.value)}/></label>
        <label>账号状态<select value={custStatus} onChange={e=>setCustStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="active">正常 (active)</option>
          <option value="restricted">限制新单 (restricted)</option>
          <option value="disabled">已停用 (disabled)</option>
        </select></label>
      </div>
      <Table
        headers={["专属收件码","主绑定邮箱","账号状态","累计订单 / 在库件数","注册时间","管控操作"]}
        rows={filteredCustomers.map(c=>[
          <strong key={c.id} className="code">{c.receiving_code}</strong>,
          <span key="em" className="code">{c.email??"—"}</span>,
          <Tag key="st">{c.status}</Tag>,
          <span key="cnt">{c.order_count??0} 单 · 在库 {c.stored_item_count??0} 件</span>,
          stamp(c.created_at,true),
          <button type="button" className="button sm" onClick={()=>setEditingCustomer(c)}>管控状态</button>,
        ])}
        empty="没有符合筛选条件的客户账号。"
      />
    </Panel>
    <Panel title="典型职责分离">
      <Table headers={["操作","允许角色","重要守卫"]} rows={[
        ["报告录入与复核","检查员 / 独立复核员","检查员不能批准本人生成的报告"],
        ["退款第二人审批","独立批准者","需重新认证并记录可追溯审批原因"],
        ["价格与模板发布","模板管理员 + 独立审核人","已确认订单保留原价格与模板快照"],
        ["物流接入管理","超级管理员","供应商密钥仅在服务端加密存储"],
      ]}/>
    </Panel>
    <ModalDrawer
      open={Boolean(editingStaff)}
      onClose={()=>setEditingStaff(null)}
      title={editingStaff?`配置员工角色权限 · ${editingStaff.display_name??editingStaff.email}`:""}
      subtitle="勾选该员工需承担的岗位角色（至少保留 1 项或停用账号），保存后立即更新服务端权限。"
    >
      {editingStaff&&<Form label="保存角色权限变更" run={async f=>{
        if(!selectedRoles.length) throw new Error("请至少勾选一个员工角色，或直接停用该账号。");
        await request("/staff/users/"+editingStaff.id+"/roles","POST",{
          roles:selectedRoles,
          reason:text(f,"reason"),
        });
        setEditingStaff(null);
        onSave();
      }}>
        <div className="role-grid">
          {STAFF_ROLE_OPTIONS.map(([code,title,desc])=><label key={code} className="role-chip">
            <input
              type="checkbox"
              checked={selectedRoles.includes(code)}
              onChange={e=>setSelectedRoles(prev=>e.target.checked?[...prev,code]:prev.filter(x=>x!==code))}
            />
            <div>
              <div>{title}</div>
              <small>{desc}</small>
            </div>
          </label>)}
        </div>
        <Field name="reason" label="权限变更原因（审计必填）" value="岗位职责调整"/>
      </Form>}
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(editingCustomer)}
      onClose={()=>setEditingCustomer(null)}
      centered
      title={editingCustomer?`客户账号状态管控 · ${editingCustomer.receiving_code}`:""}
      subtitle={editingCustomer?.email??""}
    >
      {editingCustomer&&<Form label="确认更新客户账号状态" run={async f=>{
        await request("/staff/users/"+editingCustomer.id+"/status","POST",{
          status:text(f,"status"),
          reason:text(f,"reason"),
        });
        setEditingCustomer(null);
        onSave();
      }}>
        <Select name="status" label="目标状态" value={editingCustomer.status} choices={[
          {id:"active",label:"正常启用 (active)"},
          {id:"restricted",label:"限制新建订单与付款，保留在途查询与提货 (restricted)"},
          {id:"disabled",label:"停用账号并立即撤销所有登录会话 (disabled)"},
        ]}/>
        <Field name="reason" label="风控或恢复原因说明"/>
      </Form>}
    </ModalDrawer>
  </>;
}

function TemplateAuthorForm({
  categories,services,capabilities,onSave,
}:{
  categories:Row[];services:Row[];capabilities:Row[];onSave:()=>void;
}) {
  const [editorMode,setEditorMode]=useState<"visual"|"json">("visual");
  const [selectedCaps,setSelectedCaps]=useState<string[]>(()=>capabilities[0]?.id?[capabilities[0].id]:[]);
  const [checks,setChecks]=useState<Row[]>([
    {key:"overall_appearance",label:"Overall appearance",zh:"整体外观",type:"string",unit:"",method:"Visual inspection",required:true,evidence:false},
    {key:"length_cm",label:"Length",zh:"长度",type:"number",unit:"cm",method:"Calibrated tape",required:true,evidence:true},
  ]);
  const [shots,setShots]=useState<Row[]>([
    {code:"front",name:"Front overview",zh:"正面全貌"},
    {code:"label",name:"Brand / care label",zh:"品牌与洗水标"},
  ]);
  const [measureCond,setMeasureCond]=useState("自然平铺无拉伸，使用校准卷尺测量。");
  const [rawJson,setRawJson]=useState("");
  const buildJsonObj=()=>({
    measure_conditions:measureCond,
    checks:checks.map(c=>({
      key:c.key,label:c.label,zh:c.zh,type:c.type,
      ...(c.unit?{unit:c.unit}:{}),
      method:c.method,required:Boolean(c.required),evidence:Boolean(c.evidence),
    })),
    shots:shots.filter(s=>s.code.trim()).map(s=>({code:s.code.trim(),name:s.name.trim()||s.code.trim(),zh:s.zh.trim()||s.code.trim()})),
  });
  const switchMode=(next:"visual"|"json")=>{
    if(next==="json") {
      setRawJson(JSON.stringify(buildJsonObj(),null,2));
    } else if(rawJson.trim()) {
      try {
        const parsed=JSON.parse(rawJson);
        if(Array.isArray(parsed.checks)) setChecks(parsed.checks);
        if(Array.isArray(parsed.shots)) setShots(parsed.shots);
        if(typeof parsed.measure_conditions==="string") setMeasureCond(parsed.measure_conditions);
      } catch {}
    }
    setEditorMode(next);
  };
  return <div className="card" style={{marginTop:14}}>
    <div className="row" style={{marginBottom:10}}>
      <h3 style={{margin:0}}>编写并提交新模板版本</h3>
      <div className="actions">
        <button type="button" className={"button sm"+(editorMode==="visual"?" primary":"")} onClick={()=>switchMode("visual")}>可视化构建器</button>
        <button type="button" className={"button sm"+(editorMode==="json"?" primary":"")} onClick={()=>switchMode("json")}>高级 JSON 模式</button>
      </div>
    </div>
    <Form label="提交模板至独立审核" run={async f=>{
      if(!selectedCaps.length) throw new Error("请至少勾选一项已批准的检验能力。");
      const content=editorMode==="json"?JSON.parse(text(f,"content")):buildJsonObj();
      await request("/staff/admin/templates","POST",{
        template_key:text(f,"key"),
        category_id:text(f,"category"),
        service_type_id:text(f,"service"),
        capability_ids:selectedCaps,
        content,
      });
      onSave();
    }}>
      <div className="fields three">
        <Field name="key" label="模板键 (如 bags-std)"/>
        <Select name="category" label="适用类目" choices={categories.map((c:Row)=>({id:c.id,label:c.labels["zh-CN"]}))}/>
        <Select name="service" label="服务类型" choices={services.map((x:Row)=>({id:x.id,label:x.labels["zh-CN"]}))}/>
      </div>
      <div>
        <span style={{fontWeight:650,fontSize:12.5,display:"block",marginBottom:6}}>绑定获批检验能力（支持多选）</span>
        <div className="role-grid">
          {capabilities.map((cap:Row)=><label key={cap.id} className="role-chip">
            <input
              type="checkbox"
              checked={selectedCaps.includes(cap.id)}
              onChange={e=>setSelectedCaps(prev=>e.target.checked?[...prev,cap.id]:prev.filter(x=>x!==cap.id))}
            />
            <div>
              <div className="code">{cap.code}</div>
              <small>{cap.method}</small>
            </div>
          </label>)}
        </div>
      </div>
      {editorMode==="visual"?<>
        <label>测量与拍摄环境说明
          <input value={measureCond} onChange={e=>setMeasureCond(e.target.value)}/>
        </label>
        <div>
          <div className="row" style={{marginBottom:6}}>
            <strong>检查项列表 ({checks.length})</strong>
            <button type="button" className="button sm" onClick={()=>setChecks([...checks,{key:`check_${checks.length+1}`,label:"New check",zh:"新增检查项",type:"string",unit:"",method:"Visual",required:true,evidence:false}])}>+ 新增检查项</button>
          </div>
          {checks.map((ck,idx)=><div key={idx} className="card" style={{padding:10,marginBottom:8}}>
            <div className="fields three">
              <label>字段键 (key)<input value={ck.key} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,key:e.target.value}:x))} required/></label>
              <label>中文名称<input value={ck.zh??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,zh:e.target.value}:x))} required/></label>
              <label>英文标签 (Report Label)<input value={ck.label??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,label:e.target.value}:x))} required/></label>
            </div>
            <div className="fields three" style={{marginTop:8}}>
              <label>值类型
                <select value={ck.type??"string"} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,type:e.target.value}:x))}>
                  <option value="string">文本观察 (string)</option>
                  <option value="number">数值测量 (number)</option>
                  <option value="boolean">布尔判断 (boolean)</option>
                </select>
              </label>
              <label>单位（数值选填，如 cm / g）<input value={ck.unit??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,unit:e.target.value}:x))}/></label>
              <label>检验方法/工具<input value={ck.method??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,method:e.target.value}:x))} required/></label>
            </div>
            <div className="row" style={{marginTop:8}}>
              <div className="actions">
                <label className="check"><input type="checkbox" checked={Boolean(ck.required)} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,required:e.target.checked}:x))}/> 必检项</label>
                <label className="check"><input type="checkbox" checked={Boolean(ck.evidence)} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,evidence:e.target.checked}:x))}/> 强制拍照取证</label>
              </div>
              {checks.length>1&&<button type="button" className="button sm" onClick={()=>setChecks(checks.filter((_,i)=>i!==idx))}>移除此项</button>}
            </div>
          </div>)}
        </div>
        <div>
          <div className="row" style={{marginBottom:6}}>
            <strong>组件必拍机位 ({shots.length})</strong>
            <button type="button" className="button sm" onClick={()=>setShots([...shots,{code:`shot_${shots.length+1}`,name:"Detail view",zh:"细节机位"}])}>+ 新增必拍机位</button>
          </div>
          {shots.map((sh,idx)=><div key={idx} className="inline-form" style={{marginBottom:6}}>
            <label>机位编码<input value={sh.code} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,code:e.target.value}:x))} required/></label>
            <label>中文名称<input value={sh.zh??""} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,zh:e.target.value}:x))} required/></label>
            <label>英文名称<input value={sh.name??""} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,name:e.target.value}:x))} required/></label>
            {shots.length>1&&<button type="button" className="button sm" onClick={()=>setShots(shots.filter((_,i)=>i!==idx))}>移除</button>}
          </div>)}
        </div>
      </>:<label>模板结构 JSON<textarea name="content" rows={10} value={rawJson} onChange={e=>setRawJson(e.target.value)} required/></label>}
    </Form>
  </div>;
}

function FinanceReconciliationPanel({onOpenDrawer}:{onOpenDrawer?:(t:StaffObjectTarget)=>void}) {
  const [includeTest,setIncludeTest]=useState(false);
  const query=`?include_test=${includeTest?"1":"0"}`;
  const {data,error,reload}=useLoad("/staff/admin/reconciliation"+query);
  const ledger=useLoad("/staff/admin/finance/ledger"+query);
  return <>
    <Panel title="多笔收费联合对账与跨单分摊">
      <div className="row">
        <p className="muted">展示质检费、运费（含跨单分摊与零委托分摊校验）、仓储延期费与退款汇总。默认隔离测试订单。</p>
        <div className="actions">
          <label className="check"><input type="checkbox" checked={includeTest} onChange={e=>setIncludeTest(e.target.checked)}/> 包含测试单 (is_test)</label>
          <button type="button" onClick={()=>{reload();ledger.reload();}}>刷新对账</button>
        </div>
      </div>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在加载对账数据…</p>}
      {data&&<>
        {data.summary&&<div className="stats">
          <div className="stat"><span className="label">质检实收</span><strong className="value">{usd(data.summary.inspection_paid_cents)}</strong></div>
          <div className="stat"><span className="label">运费实收</span><strong className="value">{usd(data.summary.dispatch_paid_cents)}</strong></div>
          <div className="stat"><span className="label">仓储实收</span><strong className="value">{usd(data.summary.storage_paid_cents)}</strong></div>
          <div className="stat"><span className="label">已退总额</span><strong className="value">{usd(data.summary.refunded_cents)}</strong></div>
          <div className="stat"><span className="label">净实收</span><strong className="value">{usd(data.summary.net_received_cents)}</strong></div>
        </div>}
        <Table headers={["收费项","类型","关联订单/批次","应收","实收","已退","跨单分摊校验","状态"]} rows={(data.rows??[]).map((r:Row)=>[
          <span className="code">{r.charge_id.slice(0,8)}</span>,
          ({inspection:"质检费",dispatch:"运费",storage:"仓储费"} as Row)[r.purpose]??r.purpose,
          r.order_public_no
            ?<Link className="code" href={`/admin/orders/${r.order_public_no}`}>{r.order_public_no}</Link>
            :(r.batch_id?(onOpenDrawer?<CodeButton code={`Batch #${r.batch_id.slice(0,8)}`} onClick={()=>onOpenDrawer({kind:"batch",ref:r.batch_id})}/>:`Batch ${r.batch_id.slice(0,8)}` ):"—"),
          usd(r.amount_cents),usd(r.paid_cents),usd(r.refunded_cents),
          r.purpose==="dispatch"?(r.allocation_balanced?
            `平衡（订单分摊 ${usd(r.allocated_cents)}${r.unallocated_cents?` + 零委托 ${usd(r.unallocated_cents)}`:""}）`:"分摊异常"):"—",
          <Tag>{label(r.state)}</Tag>,
        ])} empty="暂无收费对账记录。"/>
      </>}
    </Panel>
    <Panel title="按订单分解的经济模型与毛利账本">
      <div className="row">
        <p className="muted">订单明细可重算汇总，代收运费单列，渠道付款/退款凭据逐单核对。</p>
        <a className="button primary sm" href={"/api/v1/staff/admin/finance/ledger.csv"+query}>导出 CSV 账本</a>
      </div>
      {ledger.error&&<ErrorBlock error={ledger.error}/>}
      {!ledger.data&&!ledger.error&&<p role="status">正在加载对账账本…</p>}
      {ledger.data&&<>
        <div className="stats">
          <div className="stat"><span className="label">账本订单数</span><strong className="value">{ledger.data.summary.order_count}</strong><small className="detail">{ledger.data.summary.include_test?"含测试单":"仅正式单"}</small></div>
          <div className="stat"><span className="label">净质检实收</span><strong className="value">{usd(ledger.data.summary.net_inspection_cents)}</strong><small className="detail">实收 {usd(ledger.data.summary.inspection_paid_cents)} / 已退 {usd(ledger.data.summary.inspection_refunded_cents)}</small></div>
          <div className="stat"><span className="label">代收运费（单列）</span><strong className="value">{usd(ledger.data.summary.pass_through_shipping_cents)}</strong><small className="detail">不计入质检毛利</small></div>
          <div className="stat"><span className="label">工时成本估算</span><strong className="value">{usd(ledger.data.summary.total_labor_cost_cents)}</strong><small className="detail">总计 {ledger.data.summary.total_inspection_seconds}s · 时薪 {usd(ledger.data.summary.hourly_labor_cents)}/h</small></div>
          <div className="stat"><span className="label">净贡献毛利</span><strong className="value">{usd(ledger.data.summary.total_contribution_cents)}</strong><small className="detail">{ledger.data.summary.recomputable_balanced?"明细重算平衡":"重算待核对"}</small></div>
        </div>
        <Table headers={["类目","服务","订单数","样品数","总作业秒数","单件均耗(s)","净质检收入","工时成本","净贡献"]} rows={(ledger.data.by_category_service??[]).map((g:Row)=>[
          <span className="code">{g.category_slug}</span>,
          <span className="code">{g.service_code}</span>,
          g.order_count,
          g.sample_count,
          g.inspection_seconds,
          g.avg_seconds_per_sample,
          usd(g.net_inspection_cents),
          usd(g.labor_cost_cents),
          usd(g.contribution_cents),
        ])} empty="暂无类目与服务工时统计。"/>
        <Table headers={["订单与状态","类目 / 服务 / 件数","质检净实收","代收运费 / 仓储","检验工时与成本","毛利贡献","渠道凭据核对"]} rows={(ledger.data.orders??[]).map((o:Row)=>[
          <div className="cell-stack">
            <div><Link className="code" href={"/admin/orders/"+o.public_no}>{o.public_no}</Link>{o.is_test&&<> <Tag>TEST</Tag></>}</div>
            <div><Tag>{label(o.state)}</Tag></div>
          </div>,
          <div className="cell-stack">
            <span className="code">{o.category_slug} / {o.service_code}</span>
            <small>{o.sample_count} 件委托样品</small>
          </div>,
          <div className="cell-stack">
            <strong>{usd(o.net_inspection_cents)}</strong>
            <small>实收 {usd(o.inspection_paid_cents)}{o.inspection_refunded_cents?` · 已退 ${usd(o.inspection_refunded_cents)}`:""}</small>
          </div>,
          <div className="cell-stack">
            <span>运费 {usd(o.pass_through_shipping_cents)}</span>
            <small>仓储 {usd(o.storage_allocated_cents)}</small>
          </div>,
          <div className="cell-stack">
            <span>{usd(o.labor_cost_cents)}</span>
            <small>计时 {o.inspection_seconds}s</small>
          </div>,
          <strong>{usd(o.contribution_cents)}</strong>,
          o.channel_reconciled
            ?<div className="cell-stack"><Tag tone="green">已对齐</Tag><small className="code">{o.provider_refs.join(", ")||"零费用"}</small></div>
            :<Tag tone="red">渠道未对齐</Tag>,
        ])} empty="暂无符合过滤条件的订单账本记录。"/>
      </>}
    </Panel>
  </>;
}

function ShippingRateConfigPanel({rates,onSave}:{rates:Row[];onSave:()=>void}) {
  const [preview,setPreview]=useState<Row>();
  return <Panel title="国内运价版本与运费试算">
    <Table headers={["版本","首重 (g)","首重费","续重步长 (g)","续重单价","操作费","发布时间"]} rows={rates.map((r:Row)=>[
      `v${r.version}`,r.rules?.first_weight_g??1000,usd(r.rules?.first_cents??0),
      r.rules?.extra_step_g??500,usd(r.rules?.extra_cents??0),usd(r.rules?.handling_cents??0),stamp(r.published_at),
    ])} empty="暂无运价版本。"/>
    <div className="ops-columns">
      <Form label="发布新运价版本" run={async f=>{
        await request("/staff/admin/shipping-rates","POST",{
          first_weight_g:Number(text(f,"first_weight_g")),
          first_cents:Math.round(Number(text(f,"first_usd"))*100),
          extra_step_g:Number(text(f,"step_g")),
          extra_cents:Math.round(Number(text(f,"step_usd"))*100),
          handling_cents:Math.round(Number(text(f,"handling_usd"))*100),
        });
        onSave();
      }}>
        <Field name="first_weight_g" label="首重克重 (g)" type="number" min={1} value={1000}/>
        <Field name="first_usd" label="首重费用 (USD)" type="number" min={0} step=".01" value={8}/>
        <Field name="step_g" label="续重步长 (g)" type="number" min={1} value={500}/>
        <Field name="step_usd" label="续重单价 (USD)" type="number" min={0} step=".01" value={2}/>
        <Field name="handling_usd" label="每批操作费 (USD)" type="number" min={0} step=".01" value={1}/>
      </Form>
      <div>
        <Form label="试算运费" run={async f=>{
          const weights=text(f,"weights").split(",").map(s=>Number(s.trim())).filter(n=>n>0);
          const res=await request("/staff/admin/shipping-rates/calculate","POST",{
            ...(text(f,"rate_version_id")?{rate_version_id:text(f,"rate_version_id")}:{}),
            parcels:weights.map(weight_g=>({weight_g})),
          });
          setPreview(res);
        }}>
          <Select name="rate_version_id" label="运价版本（默认最新）" required={false}
            choices={rates.map(r=>({id:r.id,label:`v${r.version}`}))}/>
          <Field name="weights" label="包裹重量列表（克，逗号分隔，如 800, 1350）" value="1200"/>
        </Form>
        {preview&&<p className="notice" role="status">
          试算结果（版本 v{preview.version}）：包裹运费合计 {usd(preview.parcels.reduce((sum:number,p:Row)=>sum+p.amount_cents,0))} + 操作费 {usd(preview.handling_cents)} = <strong>{usd(preview.total_cents)}</strong>
        </p>}
      </div>
    </div>
  </Panel>;
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
          <option value="">全部</option>{["draft","awaiting_payment","awaiting_samples","samples_ready","queued","inspecting","qa_review","report_ready","action_pending","on_hold","closed","cancelled"]
            .map(value=><option key={value} value={value}>{label(value)}</option>)}
        </select></label>
        <label>订单类型<select name="test" defaultValue={params.get("test")??"all"}>
          <option value="all">全部</option><option value="production">正式单</option><option value="test">测试单</option>
        </select></label>
      </div>
      <div className="inline-form">
        <Field name="from" label="创建日期从（UTC）" type="date" required={false} value={params.get("from")??""}/>
        <Field name="to" label="创建日期至（UTC，含当天）" type="date" required={false} value={params.get("to")??""}/>
        <button className="button primary" type="submit">筛选订单</button><Link className="button" href="/admin/orders">清除筛选</Link>
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
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
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
      <Panel title="实物及库位" subtitle="点击实物编号或包裹编号可直接弹出速览抽屉。"><Table headers={["实物编号","来源包裹","检查位置","身份","保管状态","库位"]} rows={data.items.map((i:Row)=>[
        <CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/>,
        i.package_code?<CodeButton code={i.package_code} onClick={()=>setDrawer({kind:"package",ref:i.package_code})}/>:"—",
        i.position,label(i.identity_state),label(i.custody_state),i.location??"—",
      ])} empty="暂无实物绑定。"/></Panel>
      <Panel title="入仓包裹" subtitle="点击卖家运单查看物流轨迹，点击包裹码查看拆包明细。"><Table headers={["卖家运单","承运商","运输状态","仓内包裹","实收时间"]} rows={data.parcels.map((p:Row)=>[
        <CodeButton code={p.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:p.tracking_norm})}/>,
        p.carrier_code??"—",
        label(p.transport_state),
        p.code?<CodeButton code={p.code} onClick={()=>setDrawer({kind:"package",ref:p.code})}/>:"待实收",
        stamp(p.received_at),
      ])} empty="暂无关联卖家运单。"/></Panel>
      <Panel title="已交接发运" subtitle="点击发运单号查看出库物流轨迹，点击批次号核对装箱记录。"><Table headers={["发运运单","发运批次","处置类型","状态","交接时间"]} rows={data.shipments.map((s:Row)=>[
        s.tracking_norm?<CodeButton code={s.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:s.tracking_norm})}/>:"待填单",
        s.batch_id?<CodeButton code={`#${String(s.batch_id).slice(0,8)}`} onClick={()=>setDrawer({kind:"batch",ref:s.batch_id})}/>:"—",
        label(s.action),label(s.state),stamp(s.shipped_at),
      ])} empty="暂无已交接运单。"/></Panel>
      <Panel title="关联工单与阻断">
        <Table headers={["编号","主题","状态"]} rows={data.tickets.map((t:Row)=>[
          <Link className="code" href={"/admin/tickets/"+t.id}>{t.public_no}</Link>,t.subject,label(t.state),
        ])} empty="暂无关联工单。"/>
        <Table headers={["阻断原因","开始","解除"]} rows={data.blocks.map((b:Row)=>[
          b.reason,stamp(b.opened_at),b.resolved_at?stamp(b.resolved_at):"尚未解除",
        ])}/>
        <div className="ops-columns">
          {data.order.state!=="on_hold"&&!["closed","cancelled"].includes(data.order.state)&&<Form inline label="暂停订单 (Hold)" run={async f=>{
            await request("/staff/orders/"+data.order.id+"/hold","POST",{reason:text(f,"reason")});
            reload();
          }}><Field name="reason" label="暂停原因"/></Form>}
          {data.order.state==="on_hold"&&<Form inline label="恢复订单 (Resume)" run={async f=>{
            await request("/staff/orders/"+data.order.id+"/resume","POST",{reason:text(f,"reason")});
            reload();
          }}><Field name="reason" label="恢复说明"/></Form>}
          {["report_ready","action_pending"].includes(data.order.state)&&<Action run={async()=>{
            await request("/staff/orders/"+data.order.id+"/close","POST",{revision:data.order.revision});
            reload();
          }}>全部实物终态后关闭订单</Action>}
        </div>
      </Panel>
      <ScopeReview orderId={data.order.id} staff onSave={reload}/>
      <OrderRefundDesk initialOrder={number}/>
      <Panel title="订单操作记录"><Table headers={["时间","操作","执行者"]} rows={data.activity.map((a:Row)=>[
        stamp(a.at),({create_draft:"建立草稿",edit_draft:"修改草稿",submit_order:"提交委托",cancel_order:"取消订单",
          propose_scope:"提出范围调整",accept_scope:"接受范围调整"} as Row)[a.action]??a.action,
        a.display_name??({staff:"员工",customer:"客户",system:"系统"} as Row)[a.actor_type],
      ])} empty="暂无订单操作记录。"/></Panel>
    </>}
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
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
  const [match,setMatch]=useState<{title:string;detail:string;link?:string|null;action?:string;allowed?:string[];raw?:Row}>();
  const [cameraNotice,setCameraNotice]=useState<string>();
  const carriers=useLoad("/carriers");
  async function lookupScan(code:string,carrier?:string) {
    setMatch(undefined);
    const query=carrier?"?"+new URLSearchParams({carrier_code:carrier}):"";
    const result=await request("/staff/scan/"+encodeURIComponent(code)+query);
    const actionLabel=result.kind==="package"?"打开包裹详情":result.kind==="item"?
      (result.link?.startsWith("/wh/task/")?"打开质检任务":"打开实物识别"):
      result.kind==="location"?"前往库位移转":
      result.package_id?"打开拆包登记":"前往收货核对";
    setMatch({
      title:result.code,
      detail:result.summary,
      link:result.link,
      action:actionLabel,
      allowed:result.allowed_actions,
      raw:result,
    });
  }
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / SCAN</p><h1>扫码查询</h1>
      <p className="muted">扫描或手输卖家运单、包裹码 (P-)、实物码 (S-) 或库位码 (A-04-02-01 / R-01)。</p></div><Link className="button" href="/wh/intake">收货入库</Link></div>
    <Panel title="查询仓库对象">
      <div className="actions">
        <button type="button" onClick={async()=>{
          setCameraNotice(undefined);
          if(typeof navigator==="undefined" || !navigator.mediaDevices?.getUserMedia) {
            setCameraNotice("当前设备或浏览器未开放相机扫码权限，请使用扫码枪、上传条码图片或下方手动输入。");
            return;
          }
          try {
            const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
            stream.getTracks().forEach(t=>t.stop());
            setCameraNotice("相机权限已就绪，请将条码对准取景框、上传条码照片或使用扫码枪直接输入。");
          } catch {
            setCameraNotice("未能获取相机权限，已切换为扫码枪/图片解码/手动输入模式。");
          }
        }}>启用相机扫码</button>
      </div>
      {cameraNotice&&<p className="muted small" role="status">{cameraNotice}</p>}
      <div onChange={()=>setMatch(undefined)}><Form inline label="查询" run={async f=>{
        await lookupScan(text(f,"scan_code"),text(f,"carrier")||undefined);
      }}>
        <Field name="scan_code" label="条码或原始运单号（支持包裹码 / 样品码 / 库位码）"/>
        <Select name="carrier" label="承运商（运单查询）" required={false}
          choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
      </Form></div>
      <Form inline label="从条码图片解码并查询" run={async f=>{
        const file=f.get("barcode_image");
        if(!(file instanceof File)||!file.size) throw new Error("请选择包含 QR 或 Code-128 条码的 PNG 图片。");
        const buf=await file.arrayBuffer();
        const bytes=new Uint8Array(buf);
        let binary="";
        for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]!);
        const res=await request("/staff/scan/decode-image","POST",{image_base64:btoa(binary)});
        await lookupScan(res.decoded_code);
      }}>
        <label>上传条码图像识别 (QR / Code-128)<FileInput name="barcode_image" accept="image/png"/></label>
      </Form>
      {match&&<div className="notice" role="status"><strong className="code">{match.title}</strong><p>{match.detail}</p>
        {match.allowed?.length?<p className="small muted">可执行操作：{match.allowed.join(" · ")}</p>:null}
        {match.raw?.kind==="location"&&match.raw?.location&&<div className="card" style={{marginTop:8}}>
          <strong>库位详情：{match.raw.location.code}（仓区：{match.raw.location.zone} · 占用 {match.raw.location.occupied}/{match.raw.location.capacity??"∞"}）</strong>
          <Table
            headers={["实物码","库存状态","质检阶段","关联订单","操作"]}
            rows={(match.raw.items??[]).map((it:Row)=>[
              <span className="code">{it.code}</span>,
              label(it.custody_state),
              <Tag tone={it.inspection_stage==="in_inspection"?"yellow":it.inspection_stage==="inspected"?"green":"gray"}>{label(it.inspection_stage??"pending")}</Tag>,
              <span className="code">{it.order_number??"—"}</span>,
              <Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>查看实物</Link>,
            ])}
            empty="当前库位内无登记样品。"
          />
        </div>}
        {match.link&&<Link className="button" href={match.link}>{match.action}</Link>}</div>}
    </Panel>
  </>;
}

function LabelPrintPanel({targetType,targetId,code}:{targetType:"package"|"item"|"location";targetId:string;code:string}) {
  const [printed,setPrinted]=useState<{print_id:string;pdf_url:string;preview_png_url?:string;reprint:boolean;print_count:number;label_size?:string}>();
  const [verified,setVerified]=useState(false);
  return <Panel title="内部标签打印与扫码回读">
    <p className="muted">内部标签采用标准 ISO/IEC 18004 QR Code + ISO/IEC 15417 Code-128B 双码生成，仅含 <span className="code">{code}</span>，不含客户姓名、邮箱或外部地址。</p>
    <Form inline label="打印 / 重打标签" run={async f=>{
      const reason=text(f,"reprint_reason");
      const labelSize=text(f,"label_size")||"standard_80x50";
      const res=await request("/staff/labels/print","POST",{
        ...(targetType==="package"?{package_id:targetId}:targetType==="location"?{location_ids:[targetId]}:{item_ids:[targetId]}),
        label_size:labelSize,
        ...(reason?{reprint_reason:reason}:{}),
      });
      const first=res.labels?.[0];
      setPrinted({
        print_id:res.print_id,
        pdf_url:res.pdf_url,
        preview_png_url:res.preview_png_url,
        reprint:Boolean(first?.reprint),
        print_count:first?.print_count??1,
        label_size:res.label_size,
      });
      setVerified(false);
    }}>
      <Select name="label_size" label="标签尺寸" value="standard_80x50" choices={[
        {id:"standard_80x50",label:"80×50mm 标准热敏标签"},
        {id:"compact_50x30",label:"50×30mm 样品吊牌小签"},
        {id:"shelf_100x60",label:"100×60mm 货架/外箱大签"},
      ]}/>
      <Field name="reprint_reason" label="重打原因（首次打印可留空）" required={false}/>
    </Form>
    {printed&&<div className="notice" role="status">
      <p>已生成标签（第 {printed.print_count} 次打印 · 规格 {printed.label_size??"standard_80x50"}） · <a href={"/api/v1/staff/labels/"+printed.print_id+"/file"} target="_blank" rel="noreferrer">打开标签 PDF</a> · <a href={"/api/v1/staff/labels/"+printed.print_id+"/preview.png"} target="_blank" rel="noreferrer">打开条码 PNG</a></p>
      <img src={"/api/v1/staff/labels/"+printed.print_id+"/preview.png"} alt={`条码预览 ${code}`} style={{maxWidth:320,border:"1px solid #cbd5e1",borderRadius:6,marginTop:6}}/>
    </div>}
    <Form inline label="回读核验标签" run={async f=>{
      await request("/staff/labels/verify","POST",{expected_code:code,scanned_code:text(f,"scanned_code")});
      setVerified(true);
    }}>
      <Field name="scanned_code" label="扫描贴好后的标签条码以确认一致" value={code}/>
    </Form>
    {verified&&<p className="notice" role="status">标签回读核验通过：<span className="code">{code}</span></p>}
  </Panel>;
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
            <div><dt>包裹状态</dt><dd><Tag>{label(parcel.state)}</Tag></dd></div>
            <div><dt>外箱状况</dt><dd><Tag>{label(parcel.outer_condition??"intact")}</Tag></dd></div>
            <div><dt>实际入仓时间</dt><dd>{stamp(parcel.received_at)}</dd></div>
            <div><dt>实收件数</dt><dd>{parcel.received_quantity} 件</dd></div>
            <div><dt>外箱实重</dt><dd>{parcel.weight_g==null?"未记录":parcel.weight_g+" 克"}</dd></div>
            <div><dt>存放库位</dt><dd className="code">{parcel.location_code??"未设定"}</dd></div>
            <div><dt>客户收件码</dt><dd className="code">{parcel.receiving_code??"待核验"}</dd></div>
            <div><dt>关联委托</dt><dd className="code">{parcel.order_numbers.join("、")||"尚未关联"}</dd></div>
            {parcel.condition_note&&<div><dt>外箱异常与隔离说明</dt><dd>{parcel.condition_note}</dd></div>}
          </dl>
        </Panel>
        <Panel title="承运商运输">
          <p>卖家运单 <strong className="code">{parcel.tracking_norm??"尚无运单"}</strong></p>
          {parcel.tracking_norm&&<p>{label(parcel.transport_state)} · {label(parcel.sync_state)}</p>}
          {parcel.tracking_events?.length?<ol className="timeline">{parcel.tracking_events.map((event:Row)=>
            <li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>:<Empty>暂无承运商中文轨迹。</Empty>}
        </Panel>
      </div>
      {data.intake_context&&data.intake_context.orders?.length>0&&<Panel title="客户申报与仓库累计实收对照">
        <p className="small muted">
          订单申报总件数：<strong>{data.intake_context.total_declared_qty}</strong> 件 · 仓库累计已实收：<strong>{data.intake_context.cumulative_received_qty}</strong> 件 · 在途未到仓预报运单：<strong>{data.intake_context.in_transit_advices_count}</strong> 单
        </p>
        <Table
          headers={["订单号 / 位置","款号","颜色","尺码","供应商","服装子类","申报运单","当前绑定实物"]}
          rows={(data.intake_context.declared_items??[]).map((di:Row)=>[
            <span className="code">{di.order_public_no} #{di.position}</span>,
            <span className="code">{di.sample_code??"—"}</span>,
            di.color??"—",
            di.size??"—",
            di.supplier_alias??"—",
            di.garment_type??"—",
            <span className="code">{di.declared_tracking_no??"—"}</span>,
            di.bound_item_code?<Link className="code" href={"/wh/samples/"+encodeURIComponent(di.bound_item_code)}>{di.bound_item_code}</Link>:<Tag tone="yellow">待绑定</Tag>,
          ])}
          empty="暂无客户逐件申报明细。"
        />
      </Panel>}
      {parcel.state==="unmatched"&&<Panel title="无预报包裹归属核验">
        <p className="muted">若外箱面单写有客户专属收件码（QCW-），上传面单标签照并核验绑定归属。</p>
        <Form label="核验面单并绑定客户" run={async f=>{
          const proof=await upload(f.get("photo"),"label_photo");
          await request("/staff/packages/"+parcel.id+"/bind-owner","POST",{
            revision:parcel.revision,
            receiving_code:text(f,"receiving_code"),
            reason:text(f,"reason"),
            evidence_ids:[proof],
          });
          reload();
        }}>
          <Field name="receiving_code" label="面单上的客户专属收件码"/>
          <Field name="reason" label="核验依据说明"/>
          <Photo label="面单收件码核对照"/>
        </Form>
      </Panel>}
      {parcel.state!=="quarantined"&&<Panel title="禁限品与异常包裹隔离">
        <details className="card">
          <summary>登记为禁限品或拒收异常并转入隔离区（Quarantine）</summary>
          <Form label="确认转入隔离区" run={async f=>{
            await request("/staff/packages/"+parcel.id+"/quarantine","POST",{
              revision:parcel.revision,
              reason:text(f,"reason"),
            });
            reload();
          }}>
            <Field name="reason" label="禁限品或异常原因"/>
          </Form>
        </details>
      </Panel>}
      <LabelPrintPanel targetType="package" targetId={parcel.id} code={parcel.code}/>
      <Panel title="拆包实物">
        <Table headers={["实物码","类型","库存状态","质检阶段","当前位置",""]} rows={data.items.map((item:Row)=>[
          <span className="code">{item.code}</span>,
          item.parent_item_id?"套装组件":"主件",
          label(item.custody_state),
          <Tag tone={item.inspection_stage==="in_inspection"?"yellow":item.inspection_stage==="inspected"?"green":"gray"}>{label(item.inspection_stage??"pending")}</Tag>,
          item.location??"—",
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
      <strong className="code">{item.code}</strong> · {label(item.custody_state)} · 身份状态 {label(item.identity_state)} · 质检进度 <Tag tone={item.inspection_stage==="in_inspection"?"yellow":item.inspection_stage==="inspected"?"green":"gray"}>{label(item.inspection_stage??"pending")}</Tag> · 库位 <span className="code">{item.location??"未登记"}</span>
      <p>实收包裹 <Link href={"/wh/packages/"+item.package_code}>{item.package_code}</Link>{item.order_number?" · 委托 "+item.order_number:" · 无委托实物"}</p>
      {item.components?.length>0&&<p className="small">包含套装组件：{item.components.map((c:Row)=>c.code).join("、")}</p>}
      {item.is_reference_sample&&<p><Tag tone="yellow">确认样核对委托 (Golden Sample / Reference Match)</Tag></p>}
      {item.reference_zone_warning&&<p className="bad"><strong>确认样库位告警：</strong>{item.reference_zone_warning}</p>}
      {!item.ownership_verified&&<p>待核验客户归属。完成认领后才能关联委托。</p>}
    </div>
    {item.declared_fields&&<div className="card">
      <strong>客户委托申报信息（位置 #{item.expected_position}）</strong>
      <p className="small">
        款号/编号：<span className="code">{item.declared_fields.sample_code??"—"}</span> · 颜色：{item.declared_fields.color_declared??item.declared_fields.color??"—"} · 尺码：{item.declared_fields.size_label??item.declared_fields.size??"—"} · 供应商：{item.declared_fields.supplier_alias??"—"} · 服装子类：{item.declared_fields.garment_type??"—"} · 申报运单：<span className="code">{item.declared_fields.source_tracking_no??"—"}</span>
      </p>
      {item.declared_fields.mismatch_note&&<p className="bad small">当前登记不符：{item.declared_fields.mismatch_note}</p>}
    </div>}
    {item.can_identify&&<details className="card" open={item.identity_state==="mismatch"}>
      <summary>实物身份核对与收货不符登记</summary>
      <Form label="提交身份核对结论" run={async f=>{
        const matches=text(f,"matches_advice")==="true";
        const file=f.get("photo");
        const mediaIds:string[]=[];
        if(file instanceof File && file.size>0) {
          mediaIds.push(await upload(file,"label_photo"));
        }
        await request("/staff/items/"+item.id+"/identify","POST",{
          revision:item.revision,
          matches_advice:matches,
          actual_label_info:{
            size_label:text(f,"actual_size")||undefined,
            color_found:text(f,"actual_color")||undefined,
          },
          mismatch_note:matches?undefined:text(f,"mismatch_note"),
          media_ids:mediaIds.length?mediaIds:undefined,
        });
        onSave();
      }}>
        <Select name="matches_advice" label="核对结论" choices={[
          {id:"true",label:"实物标签与客户申报一致（确认 identified）"},
          {id:"false",label:"实物与申报不符（暂停订单并通知客户确认）"},
        ]}/>
        <Field name="actual_size" label="实拍吊牌/洗标尺码（选填）" required={false}/>
        <Field name="actual_color" label="实收外观颜色（选填）" required={false}/>
        <Field name="mismatch_note" label="不符说明（客户可见英文，不符时必填）" required={false}/>
        <label>补充标签核对照（选填）<FileInput name="photo" accept="image/jpeg,image/png,image/webp"/></label>
      </Form>
    </details>}
    {positions.length>0?<>
      <div className="card" style={{marginBottom:10}}>
        <strong>候选待绑定委托位置明细（请核对款号、颜色、尺码、供应商及运单来源）</strong>
        <Table
          headers={["订单与位置","服务","款号 (Sample Code)","颜色","尺码","供应商","服装子类","申报运单"]}
          rows={positions.map(p=>[
            <span className="code">{p.public_no} #{p.position}</span>,
            p.title["zh-CN"],
            <span className="code">{p.sample_code??"—"}</span>,
            p.color??"—",
            p.size??"—",
            p.supplier_alias??"—",
            p.garment_type??"—",
            <span className="code">{p.source_tracking_no??"—"}</span>,
          ])}
        />
      </div>
      <Form key={item.id} label="核对并绑定" run={async f=>{
        const position=positions.find(p=>p.id===text(f,"position"));
        if(!position)throw new Error("请选择同一客户的委托位置。");
        const proof=await upload(f.get("photo"),"label_photo");
        await request("/staff/items/"+item.id+"/assign","POST",{revision:item.revision,order_line_id:position.order_line_id,
          expected_item_id:position.id,evidence_ids:[proof]});
        onSave();
      }}><Select name="position" label="同一客户的待收委托位置（含款号/颜色/尺码/供应商）" choices={positions.map(p=>({
        id:p.id,
        label:`${p.public_no} · ${p.title["zh-CN"]} · #${p.position}${p.sample_code?` · 款号:${p.sample_code}`:""}${p.color?` · 颜色:${p.color}`:""}${p.size?` · 尺码:${p.size}`:""}${p.supplier_alias?` · 供应商:${p.supplier_alias}`:""}${p.source_tracking_no?` · 运单:${p.source_tracking_no}`:""}`,
      }))}/>
        <Photo label="商品标签核对照"/>
      </Form>
    </>:item.ownership_verified&&!item.order_number&&<Empty>当前实物没有可绑定的委托位置（可保留为无委托实物或由客户直接发起退回/转运）。</Empty>}
    {item.can_unassign&&<details className="card">
      <summary>解除当前委托绑定（跨本人订单重新映射）</summary>
      <Form label="确认解除委托位置关联" run={async f=>{
        await request("/staff/items/"+item.id+"/unassign","POST",{revision:item.revision,reason:text(f,"reason")});
        onSave();
      }}>
        <Field name="reason" label="解除并重新映射原因"/>
      </Form>
    </details>}
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
    {data&&!error&&<>
      <Panel title="库存与委托"><ItemIdentity data={data} onSave={reload}/></Panel>
      <LabelPrintPanel targetType="item" targetId={data.item.id} code={data.item.code}/>
    </>}
  </>;
}
