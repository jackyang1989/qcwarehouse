"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

export function Brand() {
  return <Link className="wordmark" href="/" aria-label="QCWarehouse home">
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 38 38" fill="none">
        <path d="M19 3 33 11v16L19 35 5 27V11L19 3Z" fill="#e9effd" stroke="#2e50a2" strokeWidth="2.3"/>
        <path d="M5 11l14 8 14-8M19 19v16" stroke="#2e50a2" strokeWidth="2.2"/>
        <path d="m13 15 6-3.5 6 3.5v7L19 25.5 13 22v-7Z" fill="#2b63d9"/>
      </svg>
    </span>
    <span>QCWarehouse</span>
  </Link>;
}

export function QuickSwitch({active}:{active:"public"|"customer"|"warehouse"|"admin"}) {
  return <div className="quick-switch" role="navigation" aria-label="Portal switcher">
    <Link href="/" className={active==="public"?"on":""}>Website</Link>
    <Link href="/orders" className={active==="customer"?"on":""}>Customer</Link>
    <Link href="/wh" className={active==="warehouse"?"on":""}>Warehouse</Link>
    <Link href="/admin" className={active==="admin"?"on":""}>Admin</Link>
  </div>;
}

export function PublicHeader({accountHref,accountAction,staff,path="/"}:{
  accountHref?:string;accountAction?:ReactNode;staff?:boolean;path?:string;
}) {
  return <header className="top">
    <div className="workspace-brand"><Brand/><span className="workspace-context">INSPECTION PLATFORM</span></div>
    <nav className="public-nav" aria-label="Primary">
      {[
        ["/catalog","Services"],["/categories","Product Categories"],["/how-it-works","How It Works"],
        ["/report-guide","Reports"],["/pricing","Pricing"],
      ].map(([href,label])=><Link key={href} href={href} aria-current={path===href||href==="/catalog"&&path.startsWith("/services/")?"page":undefined}>{label}</Link>)}
    </nav>
    <div className="public-header-actions">
      <QuickSwitch active="public"/>
      <Link className="button sm" href={accountHref??"/login"}>{staff?"员工工作区":accountHref?"My Workspace":"Sign In"}</Link>
      {accountAction}
      {!staff&&<Link className="button primary sm" href="/orders/new">Start Inspection</Link>}
    </div>
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div><strong>QCWarehouse</strong> · Independent Product Inspection &amp; Sample Comparison in China</div>
    <nav aria-label="Footer">
      <Link href="/faq">FAQ</Link>
      <Link href="/contact">Contact</Link>
      <Link href="/legal/terms">Terms</Link>
      <Link href="/legal/privacy">Privacy</Link>
      <Link href="/staff/login" prefetch={false}>Staff sign-in</Link>
    </nav>
  </footer>;
}

const iconPaths:Record<string,string>={
  add:"M4 4h16v16H4z M8 12h8 M12 8v8",
  overview:"M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  orders:"M6 3h9l4 4v14H5V3h1 M14 3v5h5 M8 12h8 M8 16h8",
  packages:"M12 3 3 8v8l9 5 9-5V8l-9-5Z M3 8l9 5 9-5 M12 13v8 M7.5 5.5l9 5",
  inspection:"M3 9V4h5 M16 4h5v5 M21 15v5h-5 M8 20H3v-5 M3 12h18",
  dispatch:"M3 6h11v11H3z M14 10h4l3 3v4h-7 M7 17v2 M18 17v2",
  finance:"M3 5h18v14H3z M3 9h18 M6 14h5 M15 14h3",
  settings:"M4 6h16 M4 12h16 M4 18h16 M9 4v4 M15 10v4 M8 16v4",
  reports:"M5 3h14v18H5z M8 16l3-4 2 2 3-5",
  compare:"M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4",
  scan:"M4 4h5M4 4v5M20 4h-5m5 0v5M4 20v-5m0 5h5m11 0h-5m5 0v-5M8 12h8",
  support:"M4 5h16v11H9l-5 4V5Z M8 9h8 M8 12h5",
};
const navIcons:Record<string,string>={
  "/account":"overview","/orders":"orders","/orders/new":"add","/parcels":"packages","/items":"packages","/reports":"reports",
  "/account/billing":"finance","/support":"support","/actions":"orders","/wh":"overview","/wh/scan":"scan","/wh/intake":"packages","/wh/inspection":"inspection",
  "/wh/dispatch":"dispatch","/wh/logistics":"dispatch","/admin":"overview","/admin/orders":"orders","/admin/finance":"finance",
  "/admin/settings":"settings","/admin/logistics":"dispatch","/admin/integrations/logistics":"settings",
  "/wh/storage":"packages","/admin/storage/locations":"packages",
  "/admin/tickets":"support","/admin/audit":"reports","/admin/operations":"settings","/wh/review":"reports","/account/notifications":"support",
};

export function PlatformIcon({name}:{name:string}) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]??iconPaths.orders}/></svg>;
}

const navigationSections = {
  customer: [
    ["Orders & Inspections",["/orders/new","/orders","/actions","/reports"]],
    ["Samples & Logistics",["/parcels","/items"]],
    ["Account",["/account","/account/billing","/account/notifications","/support"]],
  ],
  warehouse: [
    ["收货与库内",["/wh","/wh/scan","/wh/intake","/wh/storage"]],
    ["质检与出库",["/wh/inspection","/wh/review","/wh/dispatch","/wh/logistics"]],
  ],
  admin: [
    ["总览与订单",["/admin","/admin/orders","/admin/tickets","/admin/finance"]],
    ["目录与仓配",["/admin/settings","/admin/storage/locations","/admin/logistics","/admin/integrations/logistics"]],
    ["风控与系统",["/admin/operations","/admin/audit"]],
  ],
} satisfies Record<string,[string,string[]][]>;

const wizardSidebarSteps:[string,string][]=[
  ["Select Inspection","Product category & service"],
  ["Configure Service","Template & sample count"],
  ["Sample Details","Items & supplier info"],
  ["Inspection Scope","Checks & requirements"],
  ["Review & Terms","Verify details & quote"],
  ["Payment Preview","Confirm & send samples"],
];

export function WorkspaceNavigation({area,title,links,path}:{area:keyof typeof navigationSections;title:string;links:[string,string][];path:string}) {
  const [wizardStep,setWizardStep]=useState(0);
  useEffect(()=>{
    function onStep(e:Event) {
      const detail=(e as CustomEvent<number>).detail;
      if(typeof detail==="number") setWizardStep(detail);
    }
    window.addEventListener("qcw:wizard-step",onStep);
    return ()=>window.removeEventListener("qcw:wizard-step",onStep);
  },[]);

  if(area==="customer" && path==="/orders/new") {
    return <aside className="workspace-sidebar">
      <div className="wizard-left-head">
        <div className="eyebrow">INSPECTION WORKFLOW</div>
        <h2>Create an<br/>Inspection</h2>
        <p>A structured, traceable process from product arrival to inspection report.</p>
      </div>
      <div className="wizard-steps" role="list" aria-label="Inspection workflow steps">
        {wizardSidebarSteps.map(([name,sub],idx)=><button
          key={name}
          type="button"
          className={`wizard-step ${idx===wizardStep?"active":idx<wizardStep?"done":""}`}
          onClick={()=>window.dispatchEvent(new CustomEvent("qcw:wizard-go",{detail:idx}))}
        >
          <span className="stepno">{idx<wizardStep?"✓":String(idx+1).padStart(2,"0")}</span>
          <div><strong>{name}</strong><small>{sub}</small></div>
        </button>)}
      </div>
      <div className="sidebar-note">
        <b>Need assistance?</b>
        Not sure which inspection is right for your item? Review the scope or contact our team before committing.
      </div>
      <div style={{margin:"16px 10px 0"}}>
        <Link className="button sm" style={{width:"100%",background:"#1b314e",borderColor:"#335073",color:"#e8f1fc"}} href="/orders">← Back to My Orders</Link>
      </div>
    </aside>;
  }

  const current=links.find(([href])=>href===path)?.[0]
    ?? links.filter(([href])=>href!=="/wh"&&href!=="/admin"&&path.startsWith(href+"/")).sort(([left],[right])=>right.length-left.length)[0]?.[0]
    ?? (path.startsWith("/wh/task/")?"/wh/inspection":path.startsWith("/shipments/")?"/parcels":undefined);
  const grouped = navigationSections[area].map(([name,paths])=>[name,paths.flatMap(href=>links.filter(([url])=>url===href))] as const);
  const otherLinks = links.filter(([href])=>!grouped.some(([,group])=>group.some(([url])=>url===href)));
  const isStaff = area==="warehouse" || area==="admin";
  return <aside className="workspace-sidebar">
    <div className="workspace-sidebar-title">
      <p className="eyebrow">{isStaff?"OPERATIONS / INTERNAL":"CUSTOMER WORKSPACE"}</p>
      <strong>{area==="customer"?"My Workspace":area==="warehouse"?"仓库作业中心":"运营管理中心"}</strong>
      <p>{area==="customer"?"Your inspections, receiving address, samples and reports — organized in one place.":"统一实物、库位、检查证据和订单履约信息"}</p>
    </div>
    <nav className="workspace-nav" aria-label={title}>
      {[...grouped,[area==="customer"?"More":"其他",otherLinks] as const].filter(([,group])=>group.length>0).map(([name,group])=><div className="workspace-nav-group" key={name}>
        <p>{name}</p>
        {group.map(([href,label])=><Link key={href} href={href} aria-current={href===current?"page":undefined}>
          <PlatformIcon name={navIcons[href]??"orders"}/><span>{label}</span>
        </Link>)}
      </div>)}
    </nav>
    <div className="sidebar-note">
      <b>{isStaff?"作业与审计留痕":"Documented inspections"}</b>
      {isStaff?"所有收货、库位、质检证据与资金操作均实时记录服务端审计台账。":"Item IDs, photo evidence and published report versions stay traceable throughout the process."}
    </div>
  </aside>;
}
