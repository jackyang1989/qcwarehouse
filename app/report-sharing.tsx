"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Action, checked, Empty, ErrorBlock, Form, Panel, request, Select, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

export function PublishedReports() {
  const search=useSearchParams(),params=new URLSearchParams();
  for(const name of ["reference","version"]) {
    const value=search.get(name)?.trim();
    if(value)params.set(name,value);
  }
  const query=params.toString();
  const {data,error,reload}=useLoad("/me/reports"+(query?"?"+query:""));
  return <>
    <div className="page-head"><p className="eyebrow">CLIENT WORKSPACE / INSPECTION RECORDS</p><h1>Reports</h1>
      <p className="muted">Find a published report or open a specific historical version.</p></div>
    <Panel title="Published inspections">
      <form action="/reports" method="get" className="form inline-form" key={query}>
        <label>Order or report number<input name="reference" defaultValue={params.get("reference")??""} maxLength={68}/></label>
        <label>Version<input name="version" type="number" min={1} step={1} max={2147483647} defaultValue={params.get("version")??""}/></label>
        <button className="primary" type="submit">Find reports</button>
        {query&&<Link href="/reports">Clear filters</Link>}
      </form>
      {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Try again</button></>}
      {!data&&!error&&<p role="status">Loading published reports…</p>}
      {data&&!error&&<Table headers={["Report","Order","Version","Published","Revision reason"]} rows={data.rows.map((row:Row)=>[
        <Link className="code" href={"/orders/"+row.order_number+"/report/versions/"+row.version}>{row.report_number}</Link>,
        row.order_number,<><span>v{row.version} </span><Tag>{row.is_current?"Current":"Historical"}</Tag></>,
        stamp(row.published_at),row.amend_reason??"—",
      ])} empty="No matching published reports."/>}
    </Panel>
  </>;
}

export function ReportShares({orderId,version}:{orderId:string;version:number}) {
  const path="/orders/"+orderId+"/report/versions/"+version+"/shares";
  const {data,error,reload}=useLoad(path);
  const pending=useRef<{days:number;key:string}>(null);
  const [created,setCreated]=useState<{id:string;url:string}>();
  return <Panel title={"Sharing · Version "+version}>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry loading links</button></>}
    {!data&&!error&&<p role="status">Loading sharing settings…</p>}
    {data&&!error&&<>
      {data.enabled?<Form label="Create read-only link" run={async fields=>{
        if(!checked(fields,"confirm"))throw new Error("Confirm what the link will share.");
        const days=Number(text(fields,"days"));
        if(pending.current?.days!==days)pending.current={days,key:crypto.randomUUID()};
        const share=await request(path,"POST",{days},pending.current.key);
        pending.current=null;
        setCreated(share);reload();
      }}>
        <Select name="days" label="Link expires in" value="7" choices={[1,7,30].map(days=>({id:String(days),label:days+" day"+(days===1?"":"s")}))}/>
        <label className="check"><input type="checkbox" name="confirm" required/>Anyone with the link can see this version’s inspection results and evidence photos.</label>
      </Form>:<Empty>New share links are currently unavailable.</Empty>}
      {created&&<div className="notice">
        <label>Copy your new link<input readOnly value={created.url} onFocus={e=>e.currentTarget.select()}/></label>
        <Action run={async()=>navigator.clipboard.writeText(created.url)}>Copy link</Action>
      </div>}
      <Table headers={["Created","Expires","Status",""]} rows={data.shares.map((s:Row)=>[
        stamp(s.created_at),stamp(s.expires_at),({active:"Active",revoked:"Revoked",expired:"Expired"} as Row)[s.state],
        s.state==="active"&&<Action run={async()=>{
          if(!window.confirm("Revoke access for everyone using this link?"))return;
          await request("/me/report-shares/"+s.id,"DELETE",{});
          if(created?.id===s.id)setCreated(undefined);
          reload();
        }}>Revoke link</Action>,
      ])} empty="No links have been created for this version."/>
    </>}
  </Panel>;
}

export function SharedReport({token}:{token:string}) {
  const path="/public/report-shares/"+token;
  const {data,error,reload}=useLoad(path);
  const labels:Record<string,string>={RECORDED:"Recorded",OBSERVED_ISSUE:"Issue observed",NOT_OBSERVED:"Not observed",
    NOT_TESTED:"Not tested",NOT_APPLICABLE:"Not applicable",BLOCKED:"Blocked"};
  return <main id="main-content" className="shell public-shell">
    <div className="page-head"><p className="eyebrow">QC WAREHOUSE / SHARED INSPECTION</p>
      <h1>{data&&!error?data.report_number:"Shared inspection report"}</h1>
      {data&&!error&&<p>Order {data.order_number} · Version {data.version} · Published {stamp(data.published_at)}</p>}
    </div>
    {error&&<><ErrorBlock error="This shared report is unavailable."/><button type="button" onClick={reload}>Try again</button></>}
    {!data&&!error&&<p role="status">Loading shared report…</p>}
    {data&&!error&&data.sections.map((section:Row,s:number)=><Panel title={section.title} key={s}>
      <Table headers={["Item","Check","Result","Evidence"]} rows={section.results.map((result:Row,r:number)=>[
        result.item,result.label,[labels[result.status]??result.status,result.value,result.unit].filter(v=>v!==null&&v!==undefined).map(String).join(" · "),
        <div className="actions">{Array.from({length:result.photo_count},(_,p)=><a key={p} className="evidence-open"
          href={"/api/v1"+path+"/photos/"+s+"/"+r+"/"+p} target="_blank" rel="noreferrer">
          <img className="thumb" src={"/api/v1"+path+"/photos/"+s+"/"+r+"/"+p} alt={result.label+" evidence "+(p+1)} loading="lazy"/>
        </a>)}</div>,
      ])}/>
    </Panel>)}
  </main>;
}
