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
  name,mode="date",defaultValue="",required=false,ariaLabelledBy,onValueChange,
}:{
  name:string;mode?:"date"|"datetime";defaultValue?:string;required?:boolean;ariaLabelledBy?:string;onValueChange?:(v:string)=>void;
}) {
  const zh=useIsStaffLocale();
  const [val,setValState]=useState(String(defaultValue??""));
  const setVal=(next:string)=>{setValState(next);onValueChange?.(next);};
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

export function CodeButton({code,onClick,title}:{code:ReactNode;onClick:()=>void;title?:string}) {
  return <button type="button" className="code-btn" title={title} onClick={onClick}>{code}</button>;
}

export function ModalDrawer({
  open,onClose,title,subtitle,centered=false,footer,children,
}:{
  open:boolean;onClose:()=>void;title:ReactNode;subtitle?:ReactNode;centered?:boolean;footer?:ReactNode;children:ReactNode;
}) {
  const zh=useIsStaffLocale();
  useEffect(()=>{
    if(!open)return;
    const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};
    document.addEventListener("keydown",onKey);
    return ()=>document.removeEventListener("keydown",onKey);
  },[open,onClose]);
  if(!open)return null;
  return <div className={"drawer-backdrop"+(centered?" centered":"")} role="dialog" aria-modal="true" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="drawer-panel">
      <div className="drawer-head">
        <div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>
        <button type="button" className="button sm" onClick={onClose}>{zh?"关闭":"Close"}</button>
      </div>
      <div className="drawer-body">{children}</div>
      {footer&&<div className="drawer-foot">{footer}</div>}
    </div>
  </div>;
}

export function MediaLightbox({
  ids,labels,initialIndex=0,onClose,
}:{
  ids:string[];labels?:string[];initialIndex?:number;onClose:()=>void;
}) {
  const zh=useIsStaffLocale();
  const [idx,setIdx]=useState(()=>Math.min(Math.max(0,initialIndex),Math.max(0,ids.length-1)));
  const [zoomed,setZoomed]=useState(false);
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==="Escape")onClose();
      if(e.key==="ArrowLeft")setIdx(i=>(i>0?i-1:ids.length-1));
      if(e.key==="ArrowRight")setIdx(i=>(i+1<ids.length?i+1:0));
    };
    document.addEventListener("keydown",onKey);
    return ()=>document.removeEventListener("keydown",onKey);
  },[ids.length,onClose]);
  if(!ids.length)return null;
  const currentId=ids[idx]??ids[0];
  const currentLabel=labels?.[idx]??(zh?`证据照 ${idx+1}/${ids.length}`:`Photo ${idx+1} of ${ids.length}`);
  return <div className="lightbox-backdrop" role="dialog" aria-modal="true" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="lightbox-bar">
      <div><strong>{currentLabel}</strong> <span className="muted" style={{color:"#cbd5e1"}}>({idx+1} / {ids.length})</span></div>
      <div className="actions">
        <button type="button" className="button sm" onClick={()=>setZoomed(z=>!z)}>{zoomed?(zh?"适应窗口 (1x)":"Fit (1x)"):(zh?"放大查看 (2x)":"Zoom (2x)")}</button>
        <a className="button sm" href={`/api/v1/media/${currentId}`} target="_blank" rel="noreferrer">{zh?"新窗口原图":"Open original"}</a>
        <button type="button" className="button sm primary" onClick={onClose}>{zh?"关闭":"Close"}</button>
      </div>
    </div>
    <div className="lightbox-stage" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
      <img
        className={"lightbox-img"+(zoomed?" zoomed":"")}
        src={`/api/v1/media/${currentId}`}
        alt={currentLabel}
        onClick={()=>setZoomed(z=>!z)}
      />
    </div>
    <div className="lightbox-bar">
      <div className="actions">
        {ids.length>1&&<>
          <button type="button" className="button sm" onClick={()=>{setZoomed(false);setIdx(i=>(i>0?i-1:ids.length-1));}}>{zh?"← 上一张":"← Previous"}</button>
          <button type="button" className="button sm" onClick={()=>{setZoomed(false);setIdx(i=>(i+1<ids.length?i+1:0));}}>{zh?"下一张 →":"Next →"}</button>
        </>}
      </div>
      <span style={{fontSize:12,color:"#cbd5e1"}}>{zh?"提示：点击图片可切换缩放，支持键盘 ← → 与 Esc":"Tip: Click image to toggle zoom; use ← → and Esc keys"}</span>
    </div>
  </div>;
}

export function MediaButton({
  ids,labels,label,sm=true,
}:{
  ids:string[];labels?:string[];label?:ReactNode;sm?:boolean;
}) {
  const zh=useIsStaffLocale();
  const [openIdx,setOpenIdx]=useState<number|null>(null);
  if(!ids?.length)return null;
  const defaultLabel=ids.length===1?(zh?"查看照片":"View photo"):(zh?`查看照片 (${ids.length})`:`Photos (${ids.length})`);
  return <>
    <button type="button" className={"button"+(sm?" sm":"")} onClick={()=>setOpenIdx(0)}>{label??defaultLabel}</button>
    {openIdx!==null&&<MediaLightbox ids={ids} labels={labels} initialIndex={openIdx} onClose={()=>setOpenIdx(null)}/>}
  </>;
}

export type StaffObjectTarget={kind:"tracking"|"package"|"item"|"batch";ref:string};

export function StaffObjectDrawer({
  target,onClose,onNavigateTarget,
}:{
  target:StaffObjectTarget|null;onClose:()=>void;onNavigateTarget?:(next:StaffObjectTarget)=>void;
}) {
  const [current,setCurrent]=useState<StaffObjectTarget|null>(target);
  useEffect(()=>{setCurrent(target);},[target?.kind,target?.ref]);
  const switchTo=(next:StaffObjectTarget)=>{
    setCurrent(next);
    onNavigateTarget?.(next);
  };
  const path=current?`/staff/object-summary?kind=${encodeURIComponent(current.kind)}&ref=${encodeURIComponent(current.ref)}`:null;
  const view=useLoad(path);
  if(!current)return null;
  const d=view.data;
  const titleMap={
    tracking:`物流单号速览 · ${current.ref}`,
    package:`包裹详情速览 · ${current.ref}`,
    item:`库内实物速览 · ${current.ref}`,
    batch:`出库批次速览 · #${current.ref.slice(0,8)}`,
  };
  return <ModalDrawer
    open={Boolean(current)}
    onClose={onClose}
    title={titleMap[current.kind]}
    subtitle="点击关联单号可在当前抽屉内直接穿透查看上下游对象"
    footer={<div className="actions">
      {current.kind==="tracking"&&<Link className="button sm" href="/admin/logistics" onClick={onClose}>前往物流监控台 →</Link>}
      {current.kind==="package"&&d?.parcel?.code&&<Link className="button sm" href={`/wh/packages/${d.parcel.code}`} onClick={onClose}>打开完整包裹工作台 →</Link>}
      {current.kind==="item"&&d?.item?.code&&<Link className="button sm" href={`/wh/samples/${d.item.code}`} onClick={onClose}>打开完整样品工作台 →</Link>}
      {current.kind==="batch"&&d?.batch?.id&&<Link className="button sm" href={`/wh/dispatch/${d.batch.id}`} onClick={onClose}>打开完整出库作业页 →</Link>}
    </div>}
  >
    {view.error&&<ErrorBlock error={view.error}/>}
    {!d&&!view.error&&<Empty>正在加载关联详情…</Empty>}
    {d?.kind==="tracking"&&(()=>{
      const t=d.tracker;
      const evs=Array.isArray(t.events_zh)?t.events_zh:[];
      return <>
        <div className="panel" style={{margin:0}}>
          <div className="row">
            <div><strong className="code">{t.tracking_norm}</strong> <span className="muted">({t.carrier_code??"承运商待识别"})</span></div>
            <div className="actions"><Tag>{t.direction==="inbound"?"入仓运单":"出库运单"}</Tag><Tag>{t.transport_state}</Tag><Tag tone="outline">{t.sync_state}</Tag></div>
          </div>
          <div className="grid cols2" style={{marginTop:10}}>
            <div><small className="muted">客户专属码</small><div><strong>{t.receiving_code??"未绑定客户"}</strong></div></div>
            <div><small className="muted">最近同步 / 最新节点</small><div>{stamp(t.last_success_at??t.latest_event_at,true)}</div></div>
            <div><small className="muted">关联包裹</small><div>{t.package_code?<CodeButton code={t.package_code} onClick={()=>switchTo({kind:"package",ref:t.package_code})}/>:"尚未登记实收"}</div></div>
            <div><small className="muted">关联订单 / 出库批次</small><div className="actions">
              {(t.order_numbers??[]).map((no:string)=><Link key={no} className="code-btn" href={`/admin/orders/${no}`} onClick={onClose}>{no}</Link>)}
              {t.batch_id&&<CodeButton code={`批次 #${String(t.batch_id).slice(0,8)}`} onClick={()=>switchTo({kind:"batch",ref:t.batch_id})}/>}
              {!(t.order_numbers?.length)&&!t.batch_id&&<span className="muted">—</span>}
            </div></div>
          </div>
          {t.media_ids?.length>0&&<div className="actions" style={{marginTop:10}}>
            <MediaButton ids={t.media_ids} label={`查看实收/交接照片 (${t.media_ids.length})`}/>
          </div>}
        </div>
        <div className="panel" style={{margin:0}}>
          <div className="row"><h3>中文原始物流轨迹</h3><span className="muted">英文已发布节点：{t.published_en_count??0}/{t.event_count??evs.length}</span></div>
          {evs.length?<ul className="timeline" style={{marginTop:10}}>
            {evs.map((e:Row,idx:number)=><li key={idx}>
              <div><strong>{e.status||e.stage||"轨迹更新"}</strong> <span className="muted">{e.location??""}</span></div>
              <div>{e.description||e.context||e.text||"—"}</div>
              <small className="muted">{e.time||e.at||stamp(e.timestamp,true)}</small>
            </li>)}
          </ul>:<Empty>暂无承运商轨迹快照（待首次同步或承运商揽收）。</Empty>}
        </div>
      </>;
    })()}
    {d?.kind==="package"&&(()=>{
      const p=d.parcel;
      return <>
        <div className="panel" style={{margin:0}}>
          <div className="row">
            <div><strong className="code">{p.code}</strong> <span className="muted">客户码：{p.receiving_code??"未识别"}</span></div>
            <Tag>{p.state}</Tag>
          </div>
          <div className="grid cols2" style={{marginTop:10}}>
            <div><small className="muted">来源物流单号</small><div>{p.tracking_norm?<CodeButton code={p.tracking_norm} onClick={()=>switchTo({kind:"tracking",ref:p.tracking_norm})}/>:"—"}</div></div>
            <div><small className="muted">实收时间 / 重量</small><div>{stamp(p.received_at,true)} · {p.weight_g?`${p.weight_g} g`:"未称重"}</div></div>
            <div><small className="muted">当前库位 / 拆包件数</small><div>{p.location_code??"—"} · {p.received_quantity??0} 件</div></div>
            <div><small className="muted">关联订单</small><div className="actions">
              {(p.order_numbers??[]).length?(p.order_numbers as string[]).map(no=><Link key={no} className="code-btn" href={`/admin/orders/${no}`} onClick={onClose}>{no}</Link>):"—"}
            </div></div>
          </div>
          {p.media_ids?.length>0&&<div className="actions" style={{marginTop:10}}>
            <MediaButton ids={p.media_ids} label={`查看外箱/拆包照片 (${p.media_ids.length})`}/>
          </div>}
        </div>
        <div className="panel" style={{margin:0}}>
          <h3>包裹内拆出实物 ({(d.items??[]).length})</h3>
          <Table
            headers={["实物编码","订单","核身","保管状态","库位"]}
            rows={(d.items??[]).map((it:Row)=>[
              <CodeButton key={it.id} code={it.code} onClick={()=>switchTo({kind:"item",ref:it.code})}/>,
              it.order_no?<Link className="code-btn" href={`/admin/orders/${it.order_no}`} onClick={onClose}>{it.order_no}</Link>:"—",
              <Tag key="id">{it.identity_state}</Tag>,
              <Tag key="cs">{it.custody_state}</Tag>,
              it.location??"—",
            ])}
            empty="该包裹尚未拆包生成逐件条码。"
          />
        </div>
      </>;
    })()}
    {d?.kind==="item"&&(()=>{
      const it=d.item;
      return <>
        <div className="panel" style={{margin:0}}>
          <div className="row">
            <div><strong className="code">{it.code}</strong> <span className="muted">({it.receiving_code??"未绑定客户"})</span></div>
            <div className="actions"><Tag>{it.identity_state}</Tag><Tag>{it.custody_state}</Tag></div>
          </div>
          <div className="grid cols2" style={{marginTop:10}}>
            <div><small className="muted">来源包裹 / 入仓运单</small><div className="actions">
              {it.package_code&&<CodeButton code={it.package_code} onClick={()=>switchTo({kind:"package",ref:it.package_code})}/>}
              {it.inbound_tracking_norm&&<CodeButton code={it.inbound_tracking_norm} onClick={()=>switchTo({kind:"tracking",ref:it.inbound_tracking_norm})}/>}
            </div></div>
            <div><small className="muted">当前库位 / 免费保管至</small><div>{it.location??"已出库/无库位"} · {stamp(it.storage_until,true)}</div></div>
            <div><small className="muted">绑定质检单</small><div>{it.order_no?<Link className="code-btn" href={`/admin/orders/${it.order_no}`} onClick={onClose}>{it.order_no} (#{it.expected_position??"-"})</Link>:"未委托实物"}</div></div>
            <div><small className="muted">当前处置 / 出库批次</small><div className="actions">
              {it.active_disposition?<Tag>{it.active_disposition.action} · {it.active_disposition.state}</Tag>:<span className="muted">无进行中处置</span>}
              {it.active_batch_id&&<CodeButton code={`批次 #${String(it.active_batch_id).slice(0,8)}`} onClick={()=>switchTo({kind:"batch",ref:it.active_batch_id})}/>}
            </div></div>
          </div>
          {it.media_ids?.length>0&&<div className="actions" style={{marginTop:10}}>
            <MediaButton ids={it.media_ids} label={`查看实物标签/证据照 (${it.media_ids.length})`}/>
          </div>}
        </div>
        <div className="panel" style={{margin:0}}>
          <h3>库位流转记录</h3>
          <Table
            headers={["时间","动作","原库位","目标库位"]}
            rows={(d.events??[]).map((ev:Row)=>[stamp(ev.created_at,true),ev.action,ev.from_location??"—",ev.to_location??"—"])}
            empty="暂无库位移动记录。"
          />
        </div>
      </>;
    })()}
    {d?.kind==="batch"&&(()=>{
      const b=d.batch;
      const dest=b.destination_snapshot??{};
      return <>
        <div className="panel" style={{margin:0}}>
          <div className="row">
            <div><strong className="code">批次 #{String(b.id).slice(0,8)}</strong> <span className="muted">({b.receiving_code??"—"})</span></div>
            <div className="actions"><Tag>{b.action}</Tag><Tag>{b.state}</Tag></div>
          </div>
          <div className="grid cols2" style={{marginTop:10}}>
            <div><small className="muted">收件人 / 电话</small><div>{dest.recipient??"—"} · {dest.phone??"—"}</div></div>
            <div><small className="muted">最新运费报价</small><div>{b.amount_cents!=null?`${usd(b.amount_cents)} (至 ${stamp(b.expires_at,true)})`:"待称重报价"}</div></div>
            <div style={{gridColumn:"1 / -1"}}><small className="muted">收件地址</small><div>{dest.address??"—"} {dest.member_code?`(进仓码: ${dest.member_code})`:""}</div></div>
          </div>
          <div className="actions" style={{marginTop:10}}>
            <small className="muted">批次内实物：</small>
            {(b.items??[]).map((it:Row)=><CodeButton key={it.id} code={it.code} onClick={()=>switchTo({kind:"item",ref:it.code})}/>)}
          </div>
        </div>
        <div className="panel" style={{margin:0}}>
          <h3>拆包运单与出库交接 ({(d.shipments??[]).length})</h3>
          <Table
            headers={["运单号","承运商","重量","状态","交接时间"]}
            rows={(d.shipments??[]).map((s:Row)=>[
              s.tracking_norm?<CodeButton key={s.id} code={s.tracking_norm} onClick={()=>switchTo({kind:"tracking",ref:s.tracking_norm})}/>:"待填单交接",
              s.carrier_code??"—",
              s.weight_g?`${s.weight_g} g`:"—",
              <Tag key="st">{s.state}</Tag>,
              stamp(s.shipped_at,true),
            ])}
            empty="尚未打包生成出库运单。"
          />
        </div>
      </>;
    })()}
  </ModalDrawer>;
}
