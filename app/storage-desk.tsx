"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Action, checked, CodeButton, Empty, ErrorBlock, Field, Form, MediaButton, ModalDrawer, Panel, Photo, request, Select, StaffObjectDrawer, type StaffObjectTarget, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";

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
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [switchOpen,setSwitchOpen]=useState(false);
  const [execCase,setExecCase]=useState<Row|null>(null);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const d=disposals.data;
  const prodEnabled=Boolean(d?.production_execution_switch?.enabled);
  const candidates:Row[]=d?.candidate_items??[];
  const activeCaseItemIds=new Set<string>(
    (d?.cases??[]).filter((c:Row)=>c.state!=="cancelled").flatMap((c:Row)=>c.item_ids??[])
  );
  const firstSelected=candidates.find(c=>selectedIds.includes(c.id));
  const lockedOrgKey=firstSelected?(firstSelected.org_id??"__unassigned__"):null;
  const toggleCandidate=(item:Row)=>{
    setSelectedIds(prev=>prev.includes(item.id)?prev.filter(x=>x!==item.id):[...prev,item.id]);
  };
  return <Panel title="逾期与违禁件双人审批处置台">
    <p className="muted">保管期届满或违禁隔离实物须立项生成快照哈希（list_hash），经独立审批人复核（禁止自审），并在正式法律/协议生产开关开启后方可执行处置。</p>
    {disposals.error&&<ErrorBlock error={disposals.error}/>}
    {d&&<>
      <div className="row" style={{justifyContent:"space-between",marginBottom:12}}>
        <div>
          <strong>生产处置执行门禁：</strong> <Tag>{prodEnabled?"已开启":"默认关闭（仅预演与审批）"}</Tag>
          <span className="muted"> · 逾期在库 {d.overdue_items.length} 件 · 违禁/隔离 {d.restricted_items.length} 件</span>
        </div>
        <button type="button" className="button sm" onClick={()=>setSwitchOpen(true)}>
          {prodEnabled?"关闭生产处置执行开关":"开启生产处置执行开关"}
        </button>
      </div>
      <div className="ops-columns">
        <div>
          <h3 style={{marginTop:0}}>01 / 勾选逾期或隔离实物立项 ({selectedIds.length} 件已选)</h3>
          <Table
            headers={["选择","实物编码","来源包裹 / 客户","原因与保管截止","库位"]}
            rows={candidates.map((it:Row)=>{
              const inCase=activeCaseItemIds.has(it.id);
              const itemOrgKey=it.org_id??"__unassigned__";
              const orgMismatch=Boolean(lockedOrgKey && lockedOrgKey!==itemOrgKey && !selectedIds.includes(it.id));
              return [
                <input
                  key={it.id}
                  type="checkbox"
                  checked={selectedIds.includes(it.id)}
                  disabled={inCase||orgMismatch}
                  title={inCase?"已在处置单中":orgMismatch?"同一处置单仅限同一客户组织实物":"选择此实物"}
                  onChange={()=>toggleCandidate(it)}
                />,
                <CodeButton key="code" code={it.code} onClick={()=>setDrawer({kind:"item",ref:it.code})}/>,
                <div key="pkg" className="cell-stack">
                  <span>{it.package_code?<CodeButton code={it.package_code} onClick={()=>setDrawer({kind:"package",ref:it.package_code})}/>:"—"}</span>
                  <small>{it.receiving_code??"未绑定客户"}</small>
                </div>,
                <div key="due" className="cell-stack">
                  <div className="actions">
                    {it.quarantined&&<Tag tone="red">隔离件</Tag>}
                    {it.overdue&&<Tag tone="yellow">保管逾期</Tag>}
                    {inCase&&<Tag tone="outline">已立项</Tag>}
                  </div>
                  <small>截止：{stamp(it.storage_until,true)}</small>
                </div>,
                it.location_code??"—",
              ];
            })}
            empty="当前没有逾期或违禁隔离的在库实物。"
          />
          {selectedIds.length>0&&<div style={{marginTop:12}}>
            <Form label={`为已选 ${selectedIds.length} 件实物创建处置审批单`} run={async f=>{
              await request("/staff/disposals","POST",{
                ...(firstSelected?.org_id?{org_id:firstSelected.org_id}:{}),
                item_ids:selectedIds,
                reason:text(f,"reason"),
                legal_basis_version:text(f,"legal_basis_version")||"TOS-2026-V2",
                customer_authorized:checked(f,"customer_authorized"),
              });
              setSelectedIds([]);
              disposals.reload();
            }}>
              <div className="fields">
                <Field label="适用协议/政策版本" name="legal_basis_version" value="TOS-2026-V2" required={false}/>
                <Field label="立项说明与通知取证摘要" name="reason"/>
              </div>
              <label className="check"><input type="checkbox" name="customer_authorized"/> 已确认客户书面弃货授权或届满催告留证完备</label>
            </Form>
          </div>}
        </div>
        <div>
          <h3 style={{marginTop:0}}>02 / 处置审批单与双人复核 ({(d.cases??[]).length})</h3>
          <Table headers={["处置单 / 客户","状态","实物清单 / 哈希","政策版本","双人复核与执行"]} rows={(d.cases??[]).map((c:Row)=>{
            const auth=c.authorization_snapshot??{};
            const pol=c.policy_snapshot??{};
            const codes:string[]=c.item_codes??[];
            const count=codes.length||(c.item_ids??[]).length;
            const execMediaIds:string[]=c.execution_evidence?.media_ids??[];
            return [
              <div key={c.id} className="cell-stack">
                <strong className="code">#{c.id.slice(0,8)}</strong>
                <small>{c.receiving_code??"未归属组织"}</small>
              </div>,
              <Tag key="st">{c.state}</Tag>,
              <div key="items" className="cell-stack">
                <div className="actions">
                  <span>{count} 件</span>
                  {codes.slice(0,3).map(cd=><CodeButton key={cd} code={cd} onClick={()=>setDrawer({kind:"item",ref:cd})}/>)}
                  {codes.length>3&&<small className="muted">+{codes.length-3}</small>}
                </div>
                <small className="code">Hash: {(auth.list_hash??pol.list_hash??"").slice(0,12)}</small>
              </div>,
              <span key="pol">{pol.legal_basis_version??pol.legal_basis??"TOS-2026-V2"}</span>,
              <div key="act" className="actions">
                {c.state==="pending_approval"&&<Action sm run={async()=>{
                  await request(`/staff/disposals/${c.id}/approve`,"POST",{
                    revision:c.revision,
                    list_hash:auth.list_hash??pol.list_hash,
                    reason:"Independent dual-control approval verified",
                  });
                  disposals.reload();
                }}>独立审批通过</Action>}
                {c.state==="approved"&&<button type="button" className="button sm primary" onClick={()=>setExecCase(c)}>登记执行归档</button>}
                {execMediaIds.length>0&&<MediaButton ids={execMediaIds} label={`执行照片 (${execMediaIds.length})`}/>}
              </div>,
            ];
          })} empty="暂无处置审批单。"/>
        </div>
      </div>
    </>}
    <ModalDrawer
      open={switchOpen}
      onClose={()=>setSwitchOpen(false)}
      centered
      title={prodEnabled?"关闭生产处置执行门禁":"开启生产处置执行门禁"}
      subtitle="物理销毁/变卖属于不可逆高危操作，须核验正式协议条款版本与留痕原因。"
    >
      <Form label={prodEnabled?"确认关闭执行开关":"确认开启执行开关"} run={async f=>{
        await request("/staff/admin/disposal-execution-switch","POST",{
          enabled:!prodEnabled,
          legal_basis_version:text(f,"legal_basis_version")||"TOS-2026-V2",
          reason:text(f,"reason"),
        });
        setSwitchOpen(false);
        disposals.reload();
      }}>
        <Field label="正式法律与客户协议条款版本号" name="legal_basis_version" value="TOS-2026-V2"/>
        <Field label="门禁变更审计原因" name="reason" value={prodEnabled?"临时关闭生产物理处置执行开关":"法务条款与通知留证已就绪，开启生产物理处置执行"}/>
      </Form>
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(execCase)}
      onClose={()=>setExecCase(null)}
      centered
      title={execCase?`执行物理处置归档 · #${String(execCase.id).slice(0,8)}`:""}
      subtitle="请核对实物清单无误后选择处置方式，可同步上传现场销毁/交接照片。"
    >
      {execCase&&<Form label="确认完成物理处置并归档" run={async f=>{
        const file=f.get("photo");
        const mediaIds:string[]=[];
        if(file instanceof File && file.size>0) mediaIds.push(await upload(file,"attachment"));
        await request(`/staff/disposals/${execCase.id}/execute`,"POST",{
          revision:execCase.revision,
          method:text(f,"method")||"destroy",
          witness_note:text(f,"witness_note"),
          execution_note:text(f,"witness_note"),
          ...(mediaIds.length?{media_ids:mediaIds}:{}),
        });
        setExecCase(null);
        disposals.reload();
      }}>
        <Select label="物理处置方式" name="method" value="destroy" choices={[
          {id:"destroy",label:"集中销毁 (destroy)"},
          {id:"liquidate",label:"合规变卖折抵 (liquidate)"},
          {id:"donate",label:"公益捐赠 (donate)"},
        ]}/>
        <Field label="双人现场见证与执行记录" name="witness_note" value="仓库主管与复核人双人现场核对清单并完成处置"/>
        <Field label="现场处置证据照片（可选）" name="photo" type="file" required={false}/>
      </Form>}
    </ModalDrawer>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </Panel>;
}

export function StocktakeReviewAndIncidentPanel() {
  const stocktakes=useLoad("/staff/stocktakes");
  const incidents=useLoad("/staff/incidents");
  const [reviewSt,setReviewSt]=useState<Row|null>(null);
  const [proposeInc,setProposeInc]=useState<Row|null>(null);
  const [srvUsd,setSrvUsd]=useState("0.00");
  const [compUsd,setCompUsd]=useState("20.00");
  const [payoutInc,setPayoutInc]=useState<Row|null>(null);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const eligibleItems:Row[]=incidents.data?.eligible_items??[];
  return <div className="ops-columns">
    <Panel title="盘点差异复核">
      <p className="muted">盘点提交的缺失/错位差异须由独立主管或管理员复核，禁止盘点创建人自审。</p>
      {stocktakes.error&&<ErrorBlock error={stocktakes.error}/>}
      <Table headers={["盘点单","范围","状态","总数/匹配/差异","快照时间","独立复核"]} rows={(stocktakes.data?.rows??[]).map((st:Row)=>{
        const items:Row[]=st.items??[];
        const matched=items.filter(i=>i.state==="matched"||i.state==="adjusted").length;
        const disc=items.filter(i=>i.state==="investigating").length;
        return [
          <strong key={st.id} className="code">#{st.id.slice(0,8)}</strong>,
          st.scope?.zone?`仓区: ${zones[st.scope.zone]??st.scope.zone}`:"全仓",
          <Tag key="st">{st.state}</Tag>,
          `${items.length} / ${matched} / ${disc}`,
          stamp(st.snapshot_at,true),
          st.state==="submitted"
            ?<button type="button" className="button sm primary" onClick={()=>setReviewSt(st)}>复核差异 ({disc})</button>
            :"—",
        ];
      })} empty="暂无盘点记录。"/>
    </Panel>
    <Panel title="库内丢损与事故赔偿">
      <p className="muted">服务费退回受原支付单可退余额约束，货值赔付独立立项审批并登记打款凭证。非财务/超管角色隐藏具体赔付金额。</p>
      {incidents.error&&<ErrorBlock error={incidents.error}/>}
      <Form label="登记库内异常事故" run={async f=>{
        const file=f.get("evidence_photo");
        const evidenceIds:string[]=[];
        if(file instanceof File && file.size>0) evidenceIds.push(await upload(file,"attachment"));
        await request("/staff/incidents","POST",{
          item_code:text(f,"item_code").toUpperCase(),
          kind:text(f,"kind"),
          summary_en:text(f,"summary_en"),
          ...(text(f,"internal_note")?{internal_note:text(f,"internal_note")}:{}),
          ...(evidenceIds.length?{evidence_ids:evidenceIds}:{}),
        });
        incidents.reload();
      }}>
        <div className="fields">
          <label>关联实物编码（支持扫码或搜索）
            <input name="item_code" list="incident-eligible-items" placeholder="例如 S-1001" required/>
          </label>
          <datalist id="incident-eligible-items">
            {eligibleItems.map(it=><option key={it.id} value={it.code}>{`${it.receiving_code??"—"} · ${it.order_no??"未委托"} · ${it.custody_state}`}</option>)}
          </datalist>
          <Select label="事故类型" name="kind" choices={[
            {id:"loss",label:"库内缺失 (loss)"},
            {id:"damage",label:"库内破损 (damage)"},
            {id:"wrong_inspection",label:"质检重大差错 (wrong_inspection)"},
          ]}/>
        </div>
        <div className="fields">
          <Field label="对客英文说明与取证摘要 (English)" name="summary_en"/>
          <Field label="内部交接备注（仅员工可见，可选）" name="internal_note" required={false}/>
        </div>
        <Field label="现场破损/异常证据照片（可选）" name="evidence_photo" type="file" required={false}/>
      </Form>
      <Table headers={["事故工单","实物 / 订单","类型","状态","服务费退回 / 货值赔付","凭证与结案操作"]} rows={(incidents.data?.rows??[]).map((inc:Row)=>{
        const evIds:string[]=inc.evidence?.media_ids??[];
        const proofIds:string[]=inc.payment_proof?.proof_media_ids??[];
        return [
          <strong key={inc.id} className="code">{inc.ticket_no}</strong>,
          <div key="item" className="cell-stack">
            <span>{inc.item_code?<CodeButton code={inc.item_code} onClick={()=>setDrawer({kind:"item",ref:inc.item_code})}/>:"—"}</span>
            <small>{inc.order_no?<Link href={`/admin/orders/${inc.order_no}`}>{inc.order_no}</Link>:"未关联质检单"}</small>
          </div>,
          inc.resolution?.kind??"—",
          <Tag key="st">{inc.state}</Tag>,
          inc.resolution?.financial_restricted
            ?<span key="fin" className="muted">仅财务/超管可见</span>
            :<div key="fin" className="cell-stack">
              <strong>退服务费 {usd(inc.resolution?.service_refund_cents??0)} · 赔货值 {usd(inc.resolution?.compensation_cents??0)}</strong>
              <small>{inc.payment_proof?`已打款 (${inc.payment_proof.payout_reference??"已核销"})`:"待确认/待打款"}</small>
            </div>,
          <div key="act" className="actions">
            {evIds.length>0&&<MediaButton ids={evIds} label={`事故照 (${evIds.length})`}/>}
            {proofIds.length>0&&<MediaButton ids={proofIds} label={`打款水单 (${proofIds.length})`}/>}
            {(inc.state==="open"||inc.state==="customer_rejected")&&<button type="button" className="button sm primary" onClick={()=>{
              setSrvUsd(((Number(inc.resolution?.service_refund_cents??0))/100).toFixed(2));
              setCompUsd(((Number(inc.resolution?.compensation_cents??2000))/100).toFixed(2));
              setProposeInc(inc);
            }}>拟定赔偿方案</button>}
            {inc.state==="proposed"&&<Action sm primary run={async()=>{
              await request(`/staff/incidents/${inc.id}/approve`,"POST",{reason:"Approved by independent reviewer"});
              incidents.reload();
            }}>独立审批</Action>}
            {inc.state==="awaiting_payout"&&<button type="button" className="button sm primary" onClick={()=>setPayoutInc(inc)}>登记打款结案</button>}
          </div>,
        ];
      })} empty="暂无库内事故单。"/>
    </Panel>
    <ModalDrawer
      open={Boolean(reviewSt)}
      onClose={()=>setReviewSt(null)}
      centered
      title={reviewSt?`复核盘点差异 · #${String(reviewSt.id).slice(0,8)}`:""}
      subtitle="可批准差异生成库存调整记录，或退回仓库要求现场二次复盘。"
    >
      {reviewSt&&<Form label="提交复核决定" run={async f=>{
        await request(`/staff/stocktakes/${reviewSt.id}/approve`,"POST",{
          decision:text(f,"decision"),
          reason:text(f,"reason"),
        });
        setReviewSt(null);
        stocktakes.reload();
      }}>
        <Select label="复核决定" name="decision" value="approve" choices={[
          {id:"approve",label:"批准差异调账并结案 (approve)"},
          {id:"recount",label:"退回要求现场重新复盘 (recount)"},
        ]}/>
        <Field label="复核意见与依据" name="reason" value="主管核对监控与库位记录后确认盘点结果"/>
      </Form>}
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(proposeInc)}
      onClose={()=>setProposeInc(null)}
      centered
      title={proposeInc?`拟定事故赔偿方案 · ${proposeInc.ticket_no}`:""}
      subtitle="直接输入美元（USD）金额，系统自动换算为美分并校验原单可退服务费上限。"
    >
      {proposeInc&&<Form label="提交赔偿方案待独立审批" run={async f=>{
        const srvCents=Math.round(Number(srvUsd||"0")*100);
        const compCents=Math.round(Number(compUsd||"0")*100);
        await request(`/staff/incidents/${proposeInc.id}/propose`,"POST",{
          service_refund_cents:srvCents,
          compensation_cents:compCents,
          currency:"USD",
          summary_en:text(f,"summary_en"),
          ...(text(f,"internal_note")?{internal_note:text(f,"internal_note")}:{}),
        });
        setProposeInc(null);
        incidents.reload();
      }}>
        <div className="fields">
          <label>服务费退回金额 (USD)
            <input type="number" min={0} step="0.01" value={srvUsd} onChange={e=>setSrvUsd(e.target.value)} required/>
          </label>
          <label>货值协商赔付金额 (USD)
            <input type="number" min={0} step="0.01" value={compUsd} onChange={e=>setCompUsd(e.target.value)} required/>
          </label>
        </div>
        <p className="notice" style={{margin:0}}>
          折算预览：退还平台服务费 <strong>{usd(Math.round(Number(srvUsd||"0")*100))}</strong> + 独立货值赔付 <strong>{usd(Math.round(Number(compUsd||"0")*100))}</strong>
        </p>
        <Field label="对客赔偿方案说明 (English)" name="summary_en" value={proposeInc.resolution?.proposal_summary_en||"We sincerely apologize for the warehouse incident and propose the above resolution."}/>
        <Field label="内部审批备注（可选）" name="internal_note" required={false}/>
      </Form>}
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(payoutInc)}
      onClose={()=>setPayoutInc(null)}
      centered
      title={payoutInc?`登记赔付打款凭证 · ${payoutInc.ticket_no}`:""}
      subtitle={payoutInc?`客户已同意方案，核定应赔付货值：${usd(Number(payoutInc.resolution?.compensation_cents??0))}`:""}
    >
      {payoutInc&&<Form label="确认打款入账并结案" run={async f=>{
        const file=f.get("proof_photo");
        const proofIds:string[]=[];
        if(file instanceof File && file.size>0) proofIds.push(await upload(file,"attachment"));
        await request(`/staff/incidents/${payoutInc.id}/resolve`,"POST",{
          payout_reference:text(f,"payout_reference"),
          payout_method:text(f,"payout_method")||"bank_transfer",
          paid_amount_cents:Number(payoutInc.resolution?.compensation_cents??0),
          currency:"USD",
          ...(proofIds.length?{proof_media_ids:proofIds}:{}),
          ...(text(f,"note")?{note:text(f,"note")}:{}),
        });
        setPayoutInc(null);
        incidents.reload();
      }}>
        <div className="fields">
          <Field label="外部打款流水号 / 凭证编号" name="payout_reference"/>
          <Select label="打款渠道" name="payout_method" value="bank_transfer" choices={[
            {id:"bank_transfer",label:"银行转账 (Bank Transfer)"},
            {id:"wire",label:"跨境电汇 (Wire)"},
            {id:"paypal",label:"PayPal 企业付款"},
            {id:"other",label:"其他约定渠道"},
          ]}/>
        </div>
        <Field label="打款水单截图（可选）" name="proof_photo" type="file" required={false}/>
        <Field label="财务核销备注（可选）" name="note" value="已按客户确认金额完成打款核销" required={false}/>
      </Form>}
    </ModalDrawer>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
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
