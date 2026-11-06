"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

export type Row=Record<string,any>;
export class RequestError extends Error {
  constructor(message:string,public code?:string) { super(message); }
}
export async function request(path:string,method="GET",body?:unknown,idempotencyKey?:string) {
  const form=body instanceof FormData;
  const r=await fetch("/api/v1"+path,{method,cache:"no-store",headers:method==="GET"?{}:{
    ...(!form?{"content-type":"application/json"}:{}),"Idempotency-Key":idempotencyKey??crypto.randomUUID(),
  },...(body!==undefined?{body:form?body:JSON.stringify(body)}:{})});
  const data=await r.json();
  if(!r.ok) throw new RequestError(data.error?.message??"Request failed.",data.error?.code);
  return data;
}
export async function upload(file:FormDataEntryValue|null,kind:string):Promise<string> {
  if(!(file instanceof File) || !file.size) throw new Error("请选择照片 / Choose a photo.");
  const data=new FormData();
  data.set("photo",file);data.set("kind",kind);
  return (await request("/staff/media","POST",data)).id;
}
export const usd=(c:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(c/100);
export const stamp=(t?:string)=>t?new Date(t).toLocaleString():"—";
export const text=(f:FormData,k:string)=>String(f.get(k)??"").trim();
export const checked=(f:FormData,k:string)=>f.get(k)==="on";
export function useLoad(path:string|null) {
  const [result,setResult]=useState<{path:string;data?:Row;error:string}>();
  const [version,tick]=useState(0);
  useEffect(()=>{
    if(!path)return;
    let active=true;
    request(path).then(data=>{if(active)setResult({path,data,error:""});}).catch(e=>{
      if(active)setResult(previous=>({path,data:previous?.path===path?previous.data:undefined,error:e.message}));
    });
    return ()=>{active=false;};
  },[path,version]);
  const reload=useCallback(()=>tick(x=>x+1),[]);
  const current=result?.path===path?result:undefined;
  return {data:current?.data,error:current?.error??"",reload};
}
export function Action({children,run,primary=false,disabled=false}:{children:ReactNode;run:()=>Promise<unknown>;primary?:boolean;disabled?:boolean}) {
  const [busy,set]=useState(false),[error,err]=useState("");
  return <span><button className={primary?"primary":""} type="button" disabled={busy||disabled} onClick={async()=>{
    set(true);err("");try {await run();}catch(e){err(e instanceof Error?e.message:"Failed");}finally{set(false);}
  }}>{busy?"…":children}</button>{error&&<span className="notice error" role="alert">{error}</span>}</span>;
}
export function Form({children,run,label,inline=false}:{children:ReactNode;run:(f:FormData)=>Promise<unknown>;label:string;inline?:boolean}) {
  const [busy,set]=useState(false),[error,err]=useState("");
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields=new FormData(e.currentTarget);
    set(true);err("");try {await run(fields);}catch(e){err(e instanceof Error?e.message:"Failed");}finally{set(false);}
  }
  return <form className={"form "+(inline?"inline-form":"")} onSubmit={submit}><fieldset disabled={busy} style={{display:"contents"}}>
    {children}<button type="submit" className="primary" disabled={busy}>{busy?"…":label}</button></fieldset>
    {error&&<div className="notice error" role="alert">{error}</div>}</form>;
}
export function Field({label,name,type="text",value,required=true,min,max,step}:{label:string;name:string;type?:string;value?:string|number;required?:boolean;min?:number;max?:number;step?:number|string}) {
  return <label>{label}<input name={name} type={type} defaultValue={value} required={required} min={min} max={max} step={step}/></label>;
}
export function Select({name,label,choices,required=true,value}:{name:string;label:string;choices:{id:string;label:string}[];required?:boolean;value?:string}) {
  return <label>{label}<select name={name} required={required} defaultValue={value??""}>
    <option value="">{required?"— Select / 选择 —":"—"}</option>{choices.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>;
}
export function Photo({name="photo",label="照片 / Photo"}:{name?:string;label?:string}) {
  return <label>{label}<input type="file" accept="image/jpeg,image/png,image/webp,image/heic" name={name} required/></label>;
}
export function Panel({title,children,id}:{title:string;children:ReactNode;id?:string}) {return <section id={id} className="panel"><h2>{title}</h2>{children}</section>;}
export function Empty({children}:{children:ReactNode}) {return <p className="muted">{children}</p>;}
export function Tag({children}:{children:ReactNode}) {return <span className="tag">{children}</span>;}
export function ErrorBlock({error}:{error:string}) {return <div className="notice error" role="alert">{error}</div>;}
export function Tabs({links,path}:{links:[string,string][];path:string}) {return <nav className="tabs">{links.map(([to,label])=><Link aria-current={to===path?"page":undefined} href={to} key={to}>{label}</Link>)}</nav>;}
export function Table({headers,rows,empty}:{headers:string[];rows:ReactNode[][];empty?:string}) {
  if(!rows.length)return empty?<Empty>{empty}</Empty>:null;
  return <div className="table-wrap" tabIndex={0}><table><thead><tr>{headers.map((h,i)=><th scope="col" key={i}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r,i)=><tr key={i}>{r.map((cell,n)=><td key={n}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
export function NextAction({title,children}:{title:string;children:ReactNode}) {
  return <div className="notice"><h3>{title}</h3>{children}</div>;
}
