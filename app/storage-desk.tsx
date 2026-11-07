"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, request, Select, stamp, Table, Tag, text, useLoad, usd, type Row } from "./ui";

const zones:Record<string,string>={
  receiving:"收货区",queue:"待检区",inspecting:"检查区",post_inspection:"检后存放区",
  reference:"确认样区",unmatched:"未认领区",quarantine:"隔离区",
};
const zoneChoices=Object.entries(zones).map(([id,label])=>({id,label}));

export function StorageLocations({warehouseLinks}:{warehouseLinks:[string,string][]}) {
  const api="/staff/admin/storage/locations";
  const {data,error,reload}=useLoad(api);
  const [query,setQuery]=useState("");
  const [status,setStatus]=useState("");
  const [result,setResult]=useState<{added:Row[];skipped:string[]}>();
  const locations:Row[]=data?.rows??[];
  const active=locations.filter(location=>location.active).length;
  const visible=locations.filter(location=>location.code.toUpperCase().includes(query.trim().toUpperCase())&&
    (!status||location.active===(status==="active")));
  return <>
    <div className="page-head row"><div><p className="eyebrow">Operations / Storage</p><h1>库位管理</h1>
      <p className="muted">维护仓库的物理位置、启用状态和每格容量。仓库工作台使用同一份库位档案。</p></div>
      <div className="head-actions">{warehouseLinks.filter(([href])=>href==="/wh/intake"||href==="/wh/storage").map(([href,name])=>
        <Link className="button" href={href} key={href}>{name}</Link>)}</div></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取库位…</p>}
    {data&&<>
      <div className="metric-strip" aria-label="库位概览">
        <div className="metric"><span>库位档案</span><strong>{locations.length}</strong><small>包含启用及停用记录</small></div>
        <div className="metric"><span>已启用</span><strong>{active}</strong><small>可供收货和移库选择</small></div>
        <div className="metric"><span>占用件数</span><strong>{locations.reduce((sum,row)=>sum+row.occupied,0)}</strong><small>当前库位内登记实物</small></div>
        <div className="metric"><span>隔离及确认样库位</span><strong>{locations.filter(row=>row.zone==="quarantine"||row.zone==="reference").length}</strong><small>按用途分区存放</small></div>
      </div>
      <div className="ops-columns">
        <Panel title="批量生成库位">
          <p className="muted">按仓区、货架、层号和格位范围生成。已有编码将跳过。</p>
          <Form label="生成并添加库位" run={async f=>{
            const created=await request(api,"POST",{prefix:text(f,"prefix").toUpperCase(),zone:text(f,"zone"),rack:Number(text(f,"rack")),
              level:Number(text(f,"level")),start:Number(text(f,"start")),end:Number(text(f,"end")),capacity:Number(text(f,"capacity")),notes:text(f,"notes")});
            setResult(created);reload();
          }}>
            <div className="location-fields">
              <Field label="仓区编码（单个英文字母）" name="prefix"/>
              <Select label="仓区用途" name="zone" choices={zoneChoices}/>
              <Field label="货架号" name="rack" type="number" min={1} max={99}/>
              <Field label="层号" name="level" type="number" min={1} max={99}/>
              <Field label="起始格位" name="start" type="number" min={1} max={99}/>
              <Field label="结束格位" name="end" type="number" min={1} max={99}/>
              <Field label="每格容量（件）" name="capacity" type="number" min={1} max={999}/>
              <Field label="备注" name="notes" required={false}/>
            </div>
          </Form>
          {result&&<p className="notice" role="status">新增 {result.added.length} 个库位，跳过 {result.skipped.length} 个已有编码。</p>}
        </Panel>
        <Panel title="编码与操作规则">
          <div className="location-example"><strong className="code">A-04-02-03</strong><small>A 区 · 04 架 · 02 层 · 03 格</small></div>
          <ul className="location-rules"><li>已存在的编号保留原档案。</li><li>已占用的库位须先清空，才能停用。</li><li>收货、移位与退回入库均检查启用状态与容量。</li></ul>
        </Panel>
      </div>
      <Panel title="库位档案">
        <div className="form inline-form">
          <label>按库位码筛选<input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <label>启用状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部</option><option value="active">启用</option><option value="inactive">停用</option></select></label>
        </div>
        <Table headers={["库位编码","用途","占用件数","容量上限","状态","备注","操作"]} rows={visible.map(location=>[
          <strong className="code">{location.code}</strong>,zones[location.zone]??location.zone,location.occupied,
          location.capacity??"未设定",<Tag>{location.active?"已启用":"已停用"}</Tag>,location.notes||"—",
          <Action disabled={location.active&&location.occupied>0} run={async()=>{
            if(location.active&&!window.confirm("停用库位 "+location.code+"？"))return;
            await request(api+"/"+location.id+"/state","POST",{active:!location.active});reload();
          }}>{location.active?(location.occupied?"占用中":"停用"):"启用"}</Action>,
        ])} empty="没有符合条件的库位。"/>
      </Panel>
    </>}
  </>;
}

export function OverdueDisposalDesk() {
  const disposals=useLoad("/staff/disposals");
  const d=disposals.data;
  const prodEnabled=Boolean(d?.production_execution_switch?.enabled);
  return <Panel title="逾期与违禁件双人审批处置台">
    <p className="muted">保管期届满或违禁隔离实物须立项生成快照哈希（list_hash），经独立审批人复核（禁止自审），并在正式法律/协议生产开关开启后方可执行处置。</p>
    {disposals.error&&<ErrorBlock error={disposals.error}/>}
    {d&&<>
      <div className="row" style={{justifyContent:"space-between",marginBottom:12}}>
        <div>
          <strong>生产处置执行门禁：</strong> <Tag>{prodEnabled?"已开启":"默认关闭（仅预演与审批）"}</Tag>
          <span className="muted"> · 逾期在库 {d.overdue_items.length} 件 · 违禁/隔离 {d.restricted_items.length} 件</span>
        </div>
        <Action run={async()=>{
          const legal=window.prompt("请输入正式法律与客户协议条款版本号（如 TOS-2026-V2）","TOS-2026-V2");
          if(!legal)return;
          await request("/staff/admin/disposal-execution-switch","POST",{
            enabled:!prodEnabled,
            legal_basis_version:legal,
            reason:"Updated production disposal switch from PAGE-M05",
          });
          disposals.reload();
        }}>{prodEnabled?"关闭生产处置执行开关":"开启生产处置执行开关"}</Action>
      </div>
      <div className="ops-columns">
        <div>
          <Form label="创建逾期/隔离处置审批单" run={async f=>{
            const ids=text(f,"item_ids").split(",").map(s=>s.trim()).filter(Boolean);
            await request("/staff/disposals","POST",{
              org_id:text(f,"org_id"),
              item_ids:ids,
              reason:text(f,"reason"),
              legal_basis_version:text(f,"legal_basis_version")||"TOS-2026-V2",
            });
            disposals.reload();
          }}>
            <Field label="客户组织 ID (org_id)" name="org_id"/>
            <Field label="待处置实物 ID 列表（逗号分隔）" name="item_ids"/>
            <Field label="适用协议/政策版本" name="legal_basis_version" required={false}/>
            <Field label="立项说明与通知取证摘要" name="reason"/>
          </Form>
        </div>
        <div>
          <Table headers={["处置单","状态","实物数 / 清单哈希","政策快照","双人复核与执行"]} rows={(d.cases??[]).map((c:Row)=>{
            const auth=c.authorization_snapshot??{};
            const pol=c.policy_snapshot??{};
            return [
              <strong className="code">{c.id.slice(0,8)}</strong>,
              <Tag>{c.state}</Tag>,
              <span>{(c.items??[]).length} 件 · <span className="code">{(auth.list_hash??"").slice(0,10)}</span></span>,
              <span>{pol.legal_basis_version??"未配置"}</span>,
              <div className="row" style={{gap:6,flexWrap:"wrap"}}>
                {c.state==="pending_approval"&&<Action run={async()=>{
                  await request(`/staff/disposals/${c.id}/approve`,"POST",{
                    revision:c.revision,
                    list_hash:auth.list_hash,
                    reason:"Independent dual-control approval verified",
                  });
                  disposals.reload();
                }}>独立审批通过</Action>}
                {c.state==="approved"&&<Action run={async()=>{
                  const method=window.prompt("处置方式 (destroy / liquidate / donate)","destroy");
                  if(!method)return;
                  await request(`/staff/disposals/${c.id}/execute`,"POST",{
                    revision:c.revision,
                    method,
                    witness_note:"Dual-person physical disposal completed",
                  });
                  disposals.reload();
                }}>登记执行归档</Action>}
              </div>,
            ];
          })} empty="暂无处置审批单。"/>
        </div>
      </div>
    </>}
  </Panel>;
}

export function StocktakeReviewAndIncidentPanel() {
  const stocktakes=useLoad("/staff/stocktakes");
  const incidents=useLoad("/staff/incidents");
  return <div className="ops-columns">
    <Panel title="盘点差异复核">
      <p className="muted">盘点提交的缺失/错位差异须由独立主管或管理员复核，禁止盘点创建人自审。</p>
      {stocktakes.error&&<ErrorBlock error={stocktakes.error}/>}
      <Table headers={["盘点单","范围","状态","总数/匹配/差异","快照时间","独立复核"]} rows={(stocktakes.data?.rows??[]).map((st:Row)=>{
        const items:Row[]=st.items??[];
        const matched=items.filter(i=>i.state==="matched"||i.state==="adjusted").length;
        const disc=items.filter(i=>i.state==="investigating").length;
        return [
          <strong className="code">{st.id.slice(0,8)}</strong>,
          st.scope?.zone?`仓区: ${st.scope.zone}`:"全仓",
          <Tag>{st.state}</Tag>,
          `${items.length} / ${matched} / ${disc}`,
          stamp(st.snapshot_at),
          st.state==="submitted"?<Action run={async()=>{
            await request(`/staff/stocktakes/${st.id}/approve`,"POST",{decision:"approve",reason:"Supervisor reviewed stocktake discrepancy"});
            stocktakes.reload();
          }}>批准差异结案</Action>:"—",
        ];
      })} empty="暂无盘点记录。"/>
    </Panel>
    <Panel title="库内丢损与事故赔偿">
      <p className="muted">服务费退回受原支付单可退余额约束，货值赔付独立立项审批并登记打款凭证。非财务/超管角色隐藏具体赔付金额。</p>
      {incidents.error&&<ErrorBlock error={incidents.error}/>}
      <Form label="登记库内异常事故" run={async f=>{
        await request("/staff/incidents","POST",{
          item_id:text(f,"item_id"),
          kind:text(f,"kind"),
          summary_en:text(f,"summary_en"),
        });
        incidents.reload();
      }}>
        <div className="grid two">
          <Field label="关联实物 ID" name="item_id"/>
          <Select label="事故类型" name="kind" choices={[
            {id:"loss",label:"库内缺失 (loss)"},
            {id:"damage",label:"库内破损 (damage)"},
            {id:"wrong_inspection",label:"质检重大差错 (wrong_inspection)"},
          ]}/>
        </div>
        <Field label="事故说明与取证摘要 (English)" name="summary_en"/>
      </Form>
      <Table headers={["事故工单","实物/订单","类型","状态","服务费退回 / 货值赔付","审批与结案操作"]} rows={(incidents.data?.rows??[]).map((inc:Row)=>[
        <strong className="code">{inc.ticket_no}</strong>,
        <span>{inc.item_code??"—"} / {inc.order_no??"—"}</span>,
        inc.resolution?.kind??"—",
        <Tag>{inc.state}</Tag>,
        inc.resolution?.financial_restricted
          ?<span className="muted">仅财务/超管可见</span>
          :<span>{usd(inc.resolution?.service_refund_cents??0)} / {usd(inc.resolution?.compensation_cents??0)} {inc.payment_proof?"(已打款)":"(未打款)"}</span>,
        <div className="row" style={{gap:6,flexWrap:"wrap"}}>
          {(inc.state==="open"||inc.state==="customer_rejected")&&<Action run={async()=>{
            const srv=window.prompt("服务费退回金额（美分，0 表示不退服务费）","0");
            const comp=window.prompt("货值协商赔付金额（美分，独立于平台收费）","2000");
            if(srv===null||comp===null)return;
            await request(`/staff/incidents/${inc.id}/propose`,"POST",{
              service_refund_cents:Number(srv||0),
              compensation_cents:Number(comp||0),
              currency:"USD",
              summary_en:"Proposed compensation solution",
            });
            incidents.reload();
          }}>提交方案</Action>}
          {inc.state==="proposed"&&<Action run={async()=>{
            await request(`/staff/incidents/${inc.id}/approve`,"POST",{reason:"Approved by independent reviewer"});
            incidents.reload();
          }}>独立审批</Action>}
          {inc.state==="awaiting_payout"&&<Action run={async()=>{
            const proof=window.prompt("登记打款凭证编号（入账后标记已赔付）","PAYOUT-PROOF-001");
            if(!proof)return;
            await request(`/staff/incidents/${inc.id}/resolve`,"POST",{
              payout_reference:proof,
              payout_method:"bank_transfer",
              paid_amount_cents:Number(inc.resolution?.compensation_cents??0),
              note:"Compensation payout completed",
            });
            incidents.reload();
          }}>登记打款结案</Action>}
        </div>,
      ])} empty="暂无库内事故单。"/>
    </Panel>
  </div>;
}

export function StorageMove({path="/wh/storage"}:{path?:string}) {
  const {data,error,reload}=useLoad(path==="/wh/stocktakes"?null:"/staff/storage");
  const [code,setCode]=useState("");
  const [receipt,setReceipt]=useState("");
  useEffect(()=>setCode(new URLSearchParams(location.search).get("item")??""),[]);
  const found=useLoad(code?"/staff/items/by-code?"+new URLSearchParams({code}):null);
  const item=found.data?.item;
  if(path==="/wh/stocktakes") {
    return <>
      <div className="page-head row">
        <div><p className="eyebrow">WAREHOUSE / STOCKTAKES</p><h1>库存盘点</h1>
          <p className="muted">按仓区创建盘点任务，不用人工直接修改库存事实。</p></div>
        <Link className="button" href="/wh/storage">库位移转</Link>
      </div>
      <StocktakeWorkspace/>
    </>;
  }
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / STORAGE</p><h1>样品库位移转</h1>
      <p className="muted">逐件扫码，记录原位置、目标位置和操作人。</p></div>
      <div className="head-actions"><Link className="button sm" href="/wh/samples">样品建档</Link><Link className="button sm" href="/admin/storage/locations">管理库位</Link></div></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    <div className="ops-columns">
      <Panel title="01 / 扫描实物码">
        <div onChange={()=>{setCode("");setReceipt("");}}>
          <Form label="查询实物" run={async f=>{setCode(text(f,"item"));setReceipt("");found.reload();}}>
            <Field label="实物编号" name="item"/>
          </Form>
        </div>
        {code&&!item&&!found.error&&<p role="status">正在读取实物…</p>}
        {found.error&&<ErrorBlock error={found.error}/>}
        {item&&!found.error&&<dl className="location-facts">
          <div><dt>实物编号</dt><dd className="code">{item.code}</dd></div>
          <div><dt>原位置（系统记录）</dt><dd className="code">{item.location??"尚未登记"}</dd></div>
          <div><dt>实收包裹</dt><dd className="code">{item.package_code}</dd></div>
        </dl>}
      </Panel>
      <Panel title="02 / 目标库位与确认">
        {!item&&!found.error&&<Empty>请先查询实物编号。</Empty>}
        {item&&!item.movable&&<Empty>此实物当前不处于可移位的在库状态。</Empty>}
        {item?.movable&&data&&!found.error&&<Form key={item.id+"-"+item.revision} label="确认移位" run={async f=>{
          const target=data.locations.find((row:Row)=>row.code===text(f,"target")&&row.code!==item.location);
          if(!target)throw new Error("请输入不同于原位置的已启用库位码。");
          if(!checked(f,"confirmed"))throw new Error("请核对实际位置。");
          await request("/staff/storage/move","POST",{item_id:item.id,revision:item.revision,location_id:target.id});
          setReceipt(item.code+" 已移至 "+target.code+"。");found.reload();reload();
        }}>
          <label>目标库位码（可扫描）<input name="target" list="active-location-codes" required/></label>
          <datalist id="active-location-codes">{data.locations.filter((row:Row)=>row.code!==item.location).map((row:Row)=>
            <option key={row.id} value={row.code}>{zones[row.zone]}</option>)}</datalist>
          <label className="check"><input name="confirmed" type="checkbox" required/>已核对实物及实际目标位置</label>
        </Form>}
        {receipt&&<p className="notice" role="status">{receipt}</p>}
      </Panel>
    </div>
    <Panel title="最近移位记录">
      {!data&&!error&&<p role="status">正在读取移位记录…</p>}
      {data&&<Table headers={["实物码","原位置","目标位置","操作员","时间"]} rows={data.moves.map((row:Row)=>[
        <span className="code">{row.code}</span>,row.origin??"—",row.destination??"—",row.operator,stamp(row.created_at),
      ])} empty="暂无移位记录。"/>}
    </Panel>
  </>;
}

function StocktakeWorkspace() {
  const {data,error,reload}=useLoad("/staff/stocktakes");
  const [selectedId,setSelectedId]=useState("");
  const rows:Row[]=data?.rows??[];
  const active=rows.find(r=>r.id===selectedId)??rows[0];
  const activeItems:Row[]=active?.items??[];
  return <Panel title="盘点任务列表与扫码作业">
    <p className="muted">按仓区或全仓创建盘点快照；盘点期间并发移库/出库自动提示重盘，缺失/错位实物冻结出库直至寻回或事故结案。</p>
    {error&&<ErrorBlock error={error}/>}
    <div className="ops-columns">
      <div>
        <Form label="创建盘点任务" run={async f=>{
          const zoneVal=text(f,"zone");
          const res=await request("/staff/stocktakes","POST",{
            ...(zoneVal?{zone:zoneVal}:{}),
            note:text(f,"note"),
          });
          setSelectedId(res.id);
          reload();
        }}>
          <Select label="仓区范围（留空为全仓在库实物）" name="zone" required={false} choices={zoneChoices}/>
          <Field label="盘点备注" name="note" required={false}/>
        </Form>
      </div>
      <div>
        {active?<div className="stack">
          <div className="row" style={{justifyContent:"space-between"}}>
            <div>
              <strong className="code">{active.id.slice(0,8)}</strong> · <Tag>{active.state}</Tag>
              <p className="muted">快照时间：{stamp(active.snapshot_at)} · 总数 {activeItems.length} / 匹配 {activeItems.filter(i=>i.state==="matched"||i.state==="adjusted").length} / 差异 {activeItems.filter(i=>i.state==="investigating").length}</p>
            </div>
            {rows.length>1&&<select value={active.id} onChange={e=>setSelectedId(e.target.value)}>
              {rows.map(r=><option key={r.id} value={r.id}>{r.id.slice(0,8)} ({r.state})</option>)}
            </select>}
          </div>
          {active.state==="in_progress"&&<Form label="录入盘点结果" run={async f=>{
            const raw=text(f,"item_code");
            const loc=text(f,"actual_location");
            await request(`/staff/stocktakes/${active.id}/scan`,"POST",{
              ...(raw.length===36?{item_id:raw}:{item_code:raw}),
              status:text(f,"status"),
              ...(loc?{actual_location:loc}:{}),
              note:text(f,"note"),
            });
            reload();
          }}>
            <div className="grid two">
              <Field label="实物编号或 ID" name="item_code"/>
              <Select label="盘点结果" name="status" choices={[
                {id:"matched",label:"账实相符 (matched)"},
                {id:"missing",label:"缺失冻结 (missing)"},
                {id:"relocated",label:"错位 (relocated)"},
                {id:"found",label:"寻回解冻 (found)"},
              ]}/>
            </div>
            <div className="grid two">
              <Field label="实盘库位 ID（错位/寻回时填写）" name="actual_location" required={false}/>
              <Field label="差异说明" name="note" required={false}/>
            </div>
          </Form>}
          {active.state==="in_progress"&&<Action run={async()=>{
            await request(`/staff/stocktakes/${active.id}/submit`,"POST",{reason:"Submitted from H14"});
            reload();
          }}>提交盘点结果（有差异自动转主管复核）</Action>}
          <Table headers={["实物编号","快照库位","实盘库位","盘点状态","备注"]} rows={activeItems.map((it:Row)=>[
            <span className="code">{it.item_code}</span>,
            <span className="code">{it.expected_location_code??"—"}</span>,
            <span className="code">{it.actual_location_code??"—"}</span>,
            <Tag>{it.state}</Tag>,
            it.adjustment_reason||"—",
          ])} empty="该盘点范围下无在库实物。"/>
        </div>:<Empty>尚无盘点任务，请先在左侧创建。</Empty>}
      </div>
    </div>
  </Panel>;
}
