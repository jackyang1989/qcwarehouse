"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

export type Row=Record<string,any>;
export class RequestError extends Error {
  constructor(message:string,public code?:string) { super(message); }
}
function browserCookie(key:string) {
  if(typeof document==="undefined") return "";
  return document.cookie.split(";").map(s=>s.trim()).find(s=>s.startsWith(key+"="))?.slice(key.length+1)??"";
}
export async function request(path:string,method="GET",body?:unknown,idempotencyKey?:string) {
  const form=body instanceof FormData;
  const csrf=browserCookie("qcw_csrf");
  const r=await fetch("/api/v1"+path,{method,cache:"no-store",headers:method==="GET"?{}:{
    ...(!form?{"content-type":"application/json"}:{}),"Idempotency-Key":idempotencyKey??crypto.randomUUID(),
    ...(csrf?{"X-CSRF-Token":csrf}:{}),
  },...(body!==undefined?{body:form?body:JSON.stringify(body)}:{})});
  const data=await r.json();
  if(!r.ok) throw new RequestError(data.error?.message??"Request failed.",data.error?.code);
  return data;
}
async function compressImageClient(file:File):Promise<{bytes:ArrayBuffer;mime:string}> {
  if(typeof window!=="undefined" && typeof createImageBitmap==="function" && file.type!=="image/heic") {
    try {
      const bitmap=await createImageBitmap(file);
      const maxSide=Math.max(bitmap.width,bitmap.height);
      const scale=maxSide>2400?2400/maxSide:1;
      const width=Math.max(1,Math.round(bitmap.width*scale));
      const height=Math.max(1,Math.round(bitmap.height*scale));
      const canvas=document.createElement("canvas");
      canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext("2d");
      if(ctx) {
        ctx.drawImage(bitmap,0,0,width,height);
        bitmap.close();
        const blob=await new Promise<Blob|null>(res=>canvas.toBlob(res,"image/jpeg",0.85));
        if(blob) return {bytes:await blob.arrayBuffer(),mime:"image/jpeg"};
      }
      bitmap.close();
    } catch {
      // Fallback to raw file bytes if client-side canvas decode fails
    }
  }
  return {bytes:await file.arrayBuffer(),mime:(["image/jpeg","image/png","image/webp","image/heic"].includes(file.type)?file.type:"image/jpeg")};
}
async function sha256Hex(buffer:ArrayBuffer):Promise<string> {
  const digest=await crypto.subtle.digest("SHA-256",buffer);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
async function withUploadRetry<T>(fn:()=>Promise<T>,attempts=3):Promise<T> {
  let lastError:unknown;
  for(let i=0;i<attempts;i++) {
    try {
      return await fn();
    } catch(err) {
      lastError=err;
      if(err instanceof RequestError && err.code && !["SERVER_ERROR"].includes(err.code)) throw err;
      if(i+1<attempts) await new Promise(r=>setTimeout(r,300*(2**i)));
    }
  }
  throw lastError;
}
export async function upload(file:FormDataEntryValue|null,kind:string,scope?:Record<string,string>):Promise<string> {
  if(!(file instanceof File) || !file.size) {
    const zh=typeof location!=="undefined"&&isStaffPath(location.pathname);
    throw new Error(zh?"请选择照片。":"Please choose a photo.");
  }
  const {bytes,mime}=await compressImageClient(file);
  const sha256=await sha256Hex(bytes);
  const ticket=await withUploadRetry(()=>request("/media/upload-url","POST",{
    kind,mime,size_bytes:bytes.byteLength,sha256,...(scope??{}),
  }));
  const csrf=browserCookie("qcw_csrf");
  await withUploadRetry(async()=>{
    const putPath=new URL(ticket.upload_url,location.origin);
    const res=await fetch(putPath.pathname+putPath.search,{
      method:"PUT",
      headers:{"content-type":mime,...(csrf?{"X-CSRF-Token":csrf}:{})},
      body:bytes,
    });
    if(!res.ok) {
      const err=await res.json().catch(()=>({}));
      throw new RequestError(err.error?.message??"Upload PUT failed.",err.error?.code);
    }
  });
  const completedIdempotency=crypto.randomUUID();
  await withUploadRetry(()=>request(`/media/${ticket.media_id}/complete`,"POST",{},completedIdempotency));
  return ticket.media_id;
}
function isStaffPath(p?:string|null) {
  return Boolean(p&&(p.startsWith("/wh")||p.startsWith("/admin")||p.startsWith("/staff")));
}
function useIsStaffLocale() {
  const pathname=usePathname();
  return isStaffPath(pathname);
}
export const usd=(c:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(c/100);
export const stamp=(t?:string,zhOverride?:boolean)=>{
  if(!t)return "—";
  const d=new Date(t);
  if(Number.isNaN(d.getTime()))return "—";
  const zh=zhOverride??(typeof location!=="undefined"&&isStaffPath(location.pathname));
  return new Intl.DateTimeFormat(zh?"zh-CN":"en-US",{
    year:"numeric",month:zh?"2-digit":"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,
  }).format(d);
};
export const text=(f:FormData,k:string)=>String(f.get(k)??"").trim();
export const checked=(f:FormData,k:string)=>f.get(k)==="on";

const MONTHS_EN=["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT_EN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS_EN=["Su","Mo","Tu","We","Th","Fr","Sa"];
const WEEKDAYS_ZH=["日","一","二","三","四","五","六"];
const padNum=(n:number)=>String(n).padStart(2,"0");
const toYmd=(y:number,mZero:number,d:number)=>`${y}-${padNum(mZero+1)}-${padNum(d)}`;

export function DateInput({
  name,mode="date",defaultValue="",required=false,ariaLabelledBy,
}:{
  name:string;mode?:"date"|"datetime";defaultValue?:string;required?:boolean;ariaLabelledBy?:string;
}) {
  const zh=useIsStaffLocale();
  const [val,setVal]=useState(String(defaultValue??""));
  const [open,setOpen]=useState(false);
  const [dropUp,setDropUp]=useState(false);
  const parsedYmd=/^\d{4}-\d{2}-\d{2}/.test(val)?val.slice(0,10):"";
  const [hour,setHour]=useState(()=>val.length>=16?val.slice(11,13):"18");
  const [minute,setMinute]=useState(()=>val.length>=16?val.slice(14,16):"00");
  const [view,setView]=useState<{y:number;m:number}>(()=>{
    if(parsedYmd)return {y:Number(parsedYmd.slice(0,4)),m:Number(parsedYmd.slice(5,7))-1};
    const now=new Date();
    return {y:now.getFullYear(),m:now.getMonth()};
  });
  const wrapRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    if(!open)return;
    function onDocDown(e:MouseEvent) {
      if(wrapRef.current&&!wrapRef.current.contains(e.target as Node))setOpen(false);
    }
    function onKey(e:KeyboardEvent) {
      if(e.key==="Escape")setOpen(false);
    }
    document.addEventListener("mousedown",onDocDown);
    document.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("mousedown",onDocDown);
      document.removeEventListener("keydown",onKey);
    };
  },[open]);

  const formatDisplay=()=>{
    if(!parsedYmd) {
      if(zh)return mode==="datetime"?"选择日期与时间":"选择日期";
      return mode==="datetime"?"Select date & time (YYYY-MM-DD HH:mm)":"Select date (YYYY-MM-DD)";
    }
    const y=Number(parsedYmd.slice(0,4)),m=Number(parsedYmd.slice(5,7)),d=Number(parsedYmd.slice(8,10));
    const t=`${hour}:${minute}`;
    if(zh)return mode==="datetime"?`${parsedYmd} ${t}`:parsedYmd;
    return `${MONTHS_SHORT_EN[m-1]??parsedYmd} ${d}, ${y}`+(mode==="datetime"?`, ${t}`:"");
  };

  const buildDays=()=>{
    const firstDow=new Date(view.y,view.m,1).getDay();
    const daysInMonth=new Date(view.y,view.m+1,0).getDate();
    const prevDays=new Date(view.y,view.m,0).getDate();
    const cells:{ymd:string;day:number;inMonth:boolean}[]=[];
    for(let i=firstDow-1;i>=0;i--) {
      const dt=new Date(view.y,view.m-1,prevDays-i);
      cells.push({ymd:toYmd(dt.getFullYear(),dt.getMonth(),dt.getDate()),day:dt.getDate(),inMonth:false});
    }
    for(let d=1;d<=daysInMonth;d++) {
      cells.push({ymd:toYmd(view.y,view.m,d),day:d,inMonth:true});
    }
    while(cells.length%7!==0) {
      const nextIdx=cells.length-(firstDow+daysInMonth)+1;
      const dt=new Date(view.y,view.m+1,nextIdx);
      cells.push({ymd:toYmd(dt.getFullYear(),dt.getMonth(),dt.getDate()),day:dt.getDate(),inMonth:false});
    }
    return cells;
  };

  const now=new Date();
  const todayYmd=toYmd(now.getFullYear(),now.getMonth(),now.getDate());

  const selectDate=(ymd:string,closeAfter=mode==="date")=>{
    setVal(mode==="datetime"?`${ymd}T${hour}:${minute}`:ymd);
    setView({y:Number(ymd.slice(0,4)),m:Number(ymd.slice(5,7))-1});
    if(closeAfter)setOpen(false);
  };

  return <div className="date-picker" ref={wrapRef}>
    <input type="hidden" name={name} value={val}/>
    {required&&<input
      tabIndex={-1}
      aria-hidden="true"
      className="date-picker-required"
      value={val}
      onChange={()=>{}}
      required
    />}
    <button
      type="button"
      className={"date-trigger"+(open?" open":"")}
      aria-labelledby={ariaLabelledBy}
      aria-expanded={open}
      onClick={()=>{
        if(!open) {
          if(parsedYmd)setView({y:Number(parsedYmd.slice(0,4)),m:Number(parsedYmd.slice(5,7))-1});
          const rect=wrapRef.current?.getBoundingClientRect();
          if(rect&&typeof window!=="undefined") {
            const needed=mode==="datetime"?385:320;
            const spaceBelow=window.innerHeight-rect.bottom;
            setDropUp(spaceBelow<needed&&rect.top>spaceBelow);
          }
        }
        setOpen(o=>!o);
      }}
    >
      <span className={parsedYmd?"":"placeholder"}>{formatDisplay()}</span>
      <span className="date-trigger-icons">
        {parsedYmd&&!required&&<span
          role="button"
          tabIndex={0}
          aria-label={zh?"清除日期":"Clear date"}
          className="date-clear"
          onClick={e=>{e.stopPropagation();setVal("");}}
          onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();setVal("");}}}
        >×</span>}
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
        </svg>
      </span>
    </button>
    {open&&<div className={"date-popover"+(dropUp?" drop-up":"")} role="dialog" aria-label={zh?"选择日期":"Choose date"}>
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label={zh?"上个月":"Previous month"} onClick={()=>setView(v=>v.m===0?{y:v.y-1,m:11}:{y:v.y,m:v.m-1})}>‹</button>
        <strong>{zh?`${view.y}年 ${view.m+1}月`:`${MONTHS_EN[view.m]} ${view.y}`}</strong>
        <button type="button" className="cal-nav" aria-label={zh?"下个月":"Next month"} onClick={()=>setView(v=>v.m===11?{y:v.y+1,m:0}:{y:v.y,m:v.m+1})}>›</button>
      </div>
      <div className="cal-weekdays">{(zh?WEEKDAYS_ZH:WEEKDAYS_EN).map(w=><span key={w}>{w}</span>)}</div>
      <div className="cal-days">
        {buildDays().map(cell=><button
          key={cell.ymd}
          type="button"
          className={["cal-day",!cell.inMonth?"muted-day":"",cell.ymd===todayYmd?"today":"",cell.ymd===parsedYmd?"selected":""].filter(Boolean).join(" ")}
          onClick={()=>selectDate(cell.ymd)}
        >{cell.day}</button>)}
      </div>
      {mode==="datetime"&&<div className="cal-time">
        <span>{zh?"时间":"Time"}</span>
        <div className="cal-time-selects">
          <select aria-label={zh?"小时":"Hour"} value={hour} onChange={e=>{
            const h=e.target.value;setHour(h);
            const base=parsedYmd||todayYmd;
            setVal(`${base}T${h}:${minute}`);
          }}>{Array.from({length:24},(_,i)=>padNum(i)).map(h=><option key={h} value={h}>{h}</option>)}</select>
          <span>:</span>
          <select aria-label={zh?"分钟":"Minute"} value={minute} onChange={e=>{
            const m=e.target.value;setMinute(m);
            const base=parsedYmd||todayYmd;
            setVal(`${base}T${hour}:${m}`);
          }}>{Array.from({length:60},(_,i)=>padNum(i)).map(m=><option key={m} value={m}>{m}</option>)}</select>
        </div>
      </div>}
      <div className="cal-foot">
        <div className="row" style={{gap:6}}>
          <button type="button" className="button sm" onClick={()=>selectDate(todayYmd,mode==="date")}>{zh?"今天":"Today"}</button>
          {!required&&<button type="button" className="button sm ghost" onClick={()=>{setVal("");setOpen(false);}}>{zh?"清除":"Clear"}</button>}
        </div>
        {mode==="datetime"&&<button type="button" className="button sm primary" onClick={()=>{
          if(!parsedYmd)setVal(`${todayYmd}T${hour}:${minute}`);
          setOpen(false);
        }}>{zh?"确定":"Done"}</button>}
      </div>
    </div>}
  </div>;
}

export function FileInput({name="photo",accept="image/jpeg,image/png,image/webp,image/heic",required=false,capture}:{
  name?:string;accept?:string;required?:boolean;capture?:"user"|"environment";
}) {
  const zh=useIsStaffLocale();
  const [fileName,setFileName]=useState("");
  return <span className="file-picker">
    <span className="file-picker-btn">{zh?"选择文件":"Choose file"}</span>
    <span className="file-picker-name">{fileName||(zh?"未选择文件":"No file chosen")}</span>
    <input
      type="file"
      name={name}
      accept={accept}
      capture={capture}
      required={required}
      onChange={e=>setFileName(e.target.files?.[0]?.name??"")}
    />
  </span>;
}
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
export function Action({children,run,primary=false,disabled=false,sm=false}:{children:ReactNode;run:()=>Promise<unknown>;primary?:boolean;disabled?:boolean;sm?:boolean}) {
  const [busy,set]=useState(false),[error,err]=useState("");
  const cls=["button",primary?"primary":"",sm?"sm":""].filter(Boolean).join(" ");
  return <span className="action-wrap"><button className={cls} type="button" disabled={busy||disabled} onClick={async()=>{
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
  return <form className={"form"+(inline?" inline-form":"")} onSubmit={submit}><fieldset disabled={busy} style={{display:"contents"}}>
    {children}<button type="submit" className="button primary" disabled={busy}>{busy?"…":label}</button></fieldset>
    {error&&<div className="notice error" role="alert">{error}</div>}</form>;
}
export function Field({label,name,type="text",value,required=true,min,max,step}:{label:string;name:string;type?:string;value?:string|number;required?:boolean;min?:number;max?:number;step?:number|string}) {
  const labelId=useId();
  if(type==="date"||type==="datetime-local") {
    return <div className="field-label">
      <span id={labelId}>{label}</span>
      <DateInput name={name} mode={type==="datetime-local"?"datetime":"date"} defaultValue={value!==undefined?String(value):""} required={required} ariaLabelledBy={labelId}/>
    </div>;
  }
  if(type==="file") {
    return <label>{label}<FileInput name={name} required={required}/></label>;
  }
  return <label>{label}<input name={name} type={type} defaultValue={value} required={required} min={min} max={max} step={step}/></label>;
}
export function Select({name,label,choices,required=true,value}:{name:string;label:string;choices:{id:string;label:string}[];required?:boolean;value?:string}) {
  const zh=useIsStaffLocale();
  return <label>{label}<select name={name} required={required} defaultValue={value??""}>
    <option value="">{required?(zh?"— 请选择 —":"— Select —"):(zh?"— 全部 / 不限 —":"— Optional —")}</option>
    {choices.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}
  </select></label>;
}
export function Photo({name="photo",label}:{name?:string;label?:string}) {
  const zh=useIsStaffLocale();
  return <label>{label??(zh?"现场照片":"Photo evidence")}<FileInput name={name} accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" required/></label>;
}
export function Panel({title,subtitle,badge,children,id}:{title:ReactNode;subtitle?:ReactNode;badge?:ReactNode;children:ReactNode;id?:string}) {
  return <section id={id} className="panel">
    {(title||subtitle||badge)&&<div className="card-head"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>{badge}</div>}
    {children}
  </section>;
}
export function Empty({children}:{children:ReactNode}) {return <p className="muted">{children}</p>;}
export function Tag({children,tone}:{children:ReactNode;tone?:"green"|"yellow"|"blue"|"red"|"gray"|"outline"}) {
  const raw=typeof children==="string"?children.toLowerCase():"";
  const auto=tone??(/active|available|confirmed|ready|published|completed|approved|paid|delivered|已启用|已完成|已发布|已通过|正常/.test(raw)?"green":
    /draft|awaiting|pending|processing|open|review|quoting|待|草稿|处理中/.test(raw)?"yellow":
    /inspecting|queued|stored|received|in progress|comparison|质检中|在库|已收货/.test(raw)?"blue":
    /quarantine|cancelled|cancel|hold|restricted|expired|error|failed|dispute|隔离|已取消|冻结|异常|驳回/.test(raw)?"red":undefined);
  return <span className={`tag${auto?" "+auto:""}`}>{children}</span>;
}
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
