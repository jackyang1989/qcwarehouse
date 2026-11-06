"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, request, Select, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

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

export function StorageMove() {
  const {data,error,reload}=useLoad("/staff/storage");
  const [code,setCode]=useState("");
  const [receipt,setReceipt]=useState("");
  useEffect(()=>setCode(new URLSearchParams(location.search).get("item")??""),[]);
  const found=useLoad(code?"/staff/items/by-code?"+new URLSearchParams({code}):null);
  const item=found.data?.item;
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / STORAGE</p><h1>实物库位移转</h1>
      <p className="muted">扫码核对原库位，再确认目标位置。系统记录每次移动的操作者。</p></div><Link className="button" href="/wh/intake">收货入库</Link></div>
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
