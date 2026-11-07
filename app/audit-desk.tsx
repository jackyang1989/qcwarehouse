"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Empty, ErrorBlock, Field, Panel, stamp, Table, type Row, useLoad } from "./ui";

const actorLabels:Record<string,string>={customer:"客户",staff:"员工",system:"系统"};
const fields=[
  ["actor_id","操作人 ID"],["action","动作编码"],["entity_type","对象类型"],["entity_id","对象 ID"],
] as const;
function AuditValues({values}:{values:Record<string,string|number|boolean>}) {
  const entries=Object.entries(values);
  return entries.length?<dl className="location-facts">
    {entries.map(([key,value])=><div key={key}><dt>{key==="reason"?"原因":key}</dt><dd>{String(value)}</dd></div>)}
  </dl>:<Empty>无附加字段。</Empty>;
}
export function AuditDesk() {
  const search=useSearchParams(),params=new URLSearchParams();
  for(const name of [...fields.map(([key])=>key),"actor_type","from","to","before_id"]) {
    const value=search.get(name)?.trim();
    if(value)params.set(name,value);
  }
  const query=params.toString();
  const {data,error,reload}=useLoad("/staff/audit"+(query?"?"+query:""));
  const next=new URLSearchParams(params),first=new URLSearchParams(params);
  if(data?.next_before_id)next.set("before_id",data.next_before_id);
  first.delete("before_id");
  return <>
    <div className="page-head"><p className="eyebrow">OPERATIONS / AUDIT TRAIL</p><h1>审计记录</h1>
      <p className="muted">查看业务动作、操作者和已记录的变更依据。</p></div>
    <Panel title="筛选记录">
      <form className="form" action="/admin/audit" method="get" key={query}>
        <div className="inline-form">{fields.map(([name,label])=><label key={name}>{label}
          <input name={name} maxLength={64} defaultValue={params.get(name)??""}/></label>)}</div>
        <div className="inline-form">
          <label>操作者类型<select name="actor_type" defaultValue={params.get("actor_type")??""}>
            <option value="">全部</option>{Object.entries(actorLabels).map(([type,label])=><option value={type} key={type}>{label}</option>)}
          </select></label>
          <Field name="from" label="日期从（UTC）" type="date" required={false} value={params.get("from")??""}/>
          <Field name="to" label="日期至（UTC）" type="date" required={false} value={params.get("to")??""}/>
          <button type="submit" className="button primary">查审计</button><Link className="button" href="/admin/audit">清除筛选</Link>
        </div>
      </form>
    </Panel>
    <Panel title="历史操作">
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在查询记录…</p>}
      {data&&!error&&<Table headers={["时间","动作","操作者","对象","记录内容"]} rows={data.rows.map((event:Row)=>[
        stamp(event.at),<span className="code">{event.action}</span>,<>{actorLabels[event.actor_type]}<br/>{event.actor_id??"—"}</>,
        <>{event.entity_type}<br/>{event.entity_id??"—"}</>,
        <details><summary>查看记录 #{event.id}</summary><h3>变更前</h3><AuditValues values={event.before}/>
          <h3>变更后</h3><AuditValues values={event.after}/></details>,
      ])} empty="没有符合条件的审计记录。"/>}
      <div className="actions"><button type="button" onClick={reload}>刷新</button>
        {params.has("before_id")&&<Link className="button" href={"/admin/audit"+(first.size?"?"+first:"")}>返回首批</Link>}
        {!error&&data?.next_before_id&&<Link className="button" href={"/admin/audit?"+next}>下一批 →</Link>}
      </div>
    </Panel>
  </>;
}
