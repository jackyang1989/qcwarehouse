"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { request } from "./ui";
import type { Actor } from "../packages/core/common";

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

export async function switchDemoPortal(targetHref:string, demoEmail:string) {
  try {
    await request("/auth/demo/switch","POST",{email:demoEmail});
  } catch {
    // Fall back to normal navigation when not in local demo mode
  }
  location.assign(targetHref);
}

export function QuickSwitch({active,actor}:{active:"public"|"customer"|"warehouse"|"admin";actor?:Actor|null}) {
  const canCustomer = actor?.kind==="customer";
  const canWarehouse = actor?.kind==="staff" && actor.roles.some(r=>["receiver","warehouse_admin","inspector","reviewer","super_admin"].includes(r));
  const canAdmin = actor?.kind==="staff" && actor.roles.some(r=>["super_admin","finance","support","template_admin"].includes(r));

  return <div className="quick-switch" role="navigation" aria-label="Portal switcher">
    <Link href="/" className={active==="public"?"on":""}>Website</Link>
    <Link
      href="/orders"
      className={active==="customer"?"on":""}
      onClick={canCustomer?undefined:(e=>{e.preventDefault();void switchDemoPortal("/orders","customer@qcw.test");})}
    >Customer</Link>
    <Link
      href="/wh"
      className={active==="warehouse"?"on":""}
      onClick={canWarehouse?undefined:(e=>{e.preventDefault();void switchDemoPortal("/wh","admin@qcw.test");})}
    >Warehouse</Link>
    <Link
      href="/admin"
      className={active==="admin"?"on":""}
      onClick={canAdmin?undefined:(e=>{e.preventDefault();void switchDemoPortal("/admin","admin@qcw.test");})}
    >Admin</Link>
  </div>;
}

const publicNavLinks: [string, string][] = [
  ["/catalog", "Services"],
  ["/categories", "Categories"],
  ["/how-it-works", "How It Works"],
  ["/report-guide", "Sample Reports"],
  ["/pricing", "Pricing"],
  ["/faq", "FAQ"],
];

export function PublicHeader({accountHref,accountAction,staff,path="/",actor}:{
  accountHref?:string;accountAction?:ReactNode;staff?:boolean;path?:string;actor?:Actor|null;demo?:boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const isActive = (href: string) =>
    path === href || (href === "/catalog" && path.startsWith("/services/"));

  const isCustomer = actor?.kind === "customer" || (!staff && Boolean(accountHref));
  const customerHref = isCustomer ? (accountHref ?? "/account") : "/login";
  const customerLabel = isCustomer ? "My Workspace" : "Sign In";

  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="top public-top">
      <div className="public-top-inner">
        <div className="workspace-brand">
          <Brand/>
          <span className="workspace-context">CHINA INSPECTION STUDIO</span>
        </div>
        <nav className="public-nav" aria-label="Primary">
          {publicNavLinks.map(([href,label])=>(
            <Link key={href} href={href} aria-current={isActive(href)?"page":undefined}>{label}</Link>
          ))}
        </nav>
        <div className="public-header-actions">
          <Link className="button sm public-signin-btn" href={customerHref}>
            {customerLabel}
          </Link>
          {isCustomer && accountAction}
          <Link className="button primary sm public-cta-btn" href="/orders/new">
            Start Inspection
          </Link>
          <button
            type="button"
            className="public-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="public-mobile-drawer"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setMenuOpen(v => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18"/> : <path d="M4 7h16M4 12h16M4 17h16"/>}
            </svg>
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="public-mobile-drawer" id="public-mobile-drawer">
          <nav aria-label="Mobile Primary">
            {publicNavLinks.map(([href,label])=>(
              <Link
                key={href}
                href={href}
                aria-current={isActive(href)?"page":undefined}
                onClick={() => setMenuOpen(false)}
              >
                {label}
              </Link>
            ))}
            <Link href="/contact" onClick={() => setMenuOpen(false)}>Contact Support</Link>
          </nav>
          <div className="public-mobile-actions">
            <Link className="button full" href={customerHref} onClick={() => setMenuOpen(false)}>
              {customerLabel}
            </Link>
            <Link className="button primary full" href="/orders/new" onClick={() => setMenuOpen(false)}>
              Start Inspection
            </Link>
          </div>
        </div>
      )}
    </header>
  </>;
}

export function PublicFooter() {
  return <footer className="public-footer">
    <div className="public-footer-inner">
      <div className="public-footer-grid">
        <div className="public-footer-brand">
          <Brand/>
          <p className="public-footer-lead">
            China-based independent product inspection, supplier sample comparison, and post-inspection item handling for international e-commerce brands and small-batch buyers.
          </p>
          <p className="public-footer-boundary">
            <strong>Service scope:</strong> QCWarehouse inspects and photographs physical samples at our China facility before international dispatch. Supplier sourcing, factory AQL audits, and laboratory certification sit outside our scope.
          </p>
        </div>
        <div className="public-footer-col">
          <h4>Services</h4>
          <ul>
            <li><Link href="/catalog">Services Overview</Link></li>
            <li><Link href="/services/inspection">Product Inspection</Link></li>
            <li><Link href="/services/compare">Sample Comparison</Link></li>
            <li><Link href="/services/reference">Golden Sample Matching</Link></li>
            <li><Link href="/categories">Product Categories</Link></li>
            <li><Link href="/pricing">Pricing &amp; Estimator</Link></li>
          </ul>
        </div>
        <div className="public-footer-col">
          <h4>Process &amp; Evidence</h4>
          <ul>
            <li><Link href="/how-it-works">How It Works</Link></li>
            <li><Link href="/report-guide">Sample Inspection Report</Link></li>
            <li><Link href="/faq">FAQ &amp; Help Center</Link></li>
            <li><Link href="/contact">Contact &amp; Custom Scope</Link></li>
          </ul>
        </div>
        <div className="public-footer-col">
          <h4>Account &amp; Policies</h4>
          <ul>
            <li><Link href="/login">Customer Sign In</Link></li>
            <li><Link href="/orders/new">Start an Inspection</Link></li>
            <li><Link href="/legal/terms">Terms of Service</Link></li>
            <li><Link href="/legal/privacy">Privacy Policy</Link></li>
            <li><Link href="/legal/restricted-items">Restricted Items</Link></li>
            <li><Link href="/legal/report-notice">Report Limitations</Link></li>
          </ul>
        </div>
      </div>
      <div className="public-footer-bottom">
        <span>© {new Date().getFullYear()} QCWarehouse · Independent Receiving-Center Inspection in China</span>
        <div className="public-footer-meta">
          <Link href="/legal">All Policies</Link>
          <span aria-hidden="true">·</span>
          <Link href="/contact">Commercial Inquiries</Link>
          <span aria-hidden="true">·</span>
          <Link href="/staff/login" prefetch={false}>Staff sign-in</Link>
        </div>
      </div>
    </div>
  </footer>;
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
  "/account/billing":"finance","/support":"support","/actions":"orders","/wh":"overview","/wh/scan":"scan","/wh/intake":"packages",
  "/wh/packages":"packages","/wh/samples":"packages","/wh/storage":"packages","/wh/inspection":"inspection","/wh/execute":"inspection",
  "/wh/sync":"settings","/wh/review":"reports","/wh/dispatch":"dispatch","/wh/stocktakes":"packages","/wh/logistics":"dispatch",
  "/admin":"overview","/admin/orders":"orders","/admin/tickets":"support","/admin/dispositions":"dispatch","/admin/refunds":"finance",
  "/admin/payments":"finance","/admin/finance":"finance","/admin/logistics":"dispatch","/admin/incidents":"packages",
  "/admin/catalog":"settings","/admin/templates":"reports","/admin/settings":"settings","/admin/storage/locations":"packages",
  "/admin/shipping-rates":"finance","/admin/config":"settings","/admin/legal":"orders","/admin/users":"overview",
  "/admin/audit":"reports","/admin/operations":"settings","/admin/integrations/logistics":"settings","/account/notifications":"support",
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
    ["运营作业",["/wh","/wh/scan","/wh/intake","/wh/packages","/wh/samples","/wh/storage","/wh/inspection","/wh/execute","/wh/sync","/wh/review","/wh/dispatch","/wh/logistics","/wh/stocktakes"]],
  ],
  admin: [
    ["运营管理",["/admin","/admin/orders","/admin/tickets","/admin/dispositions","/admin/refunds","/admin/payments","/admin/finance","/admin/logistics","/admin/incidents"]],
    ["平台配置",["/admin/catalog","/admin/templates","/admin/storage/locations","/admin/shipping-rates","/admin/config","/admin/legal","/admin/users","/admin/audit","/admin/operations","/admin/integrations/logistics"]],
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

export function WorkspaceNavigation({area,title,links,path,demo=false}:{area:keyof typeof navigationSections;title:string;links:[string,string][];path:string;demo?:boolean}) {
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
    ?? (path.startsWith("/wh/task/")?"/wh/execute":path.startsWith("/shipments/")?"/parcels":undefined);
  const grouped = navigationSections[area].map(([name,paths])=>[name,paths.flatMap(href=>links.filter(([url])=>url===href))] as const);
  const hasAdminCatalog = links.some(([url])=>url==="/admin/catalog");
  const otherLinks = area==="warehouse"
    ? []
    : links.filter(([href])=>!(area==="admin"&&hasAdminCatalog&&href==="/admin/settings") && !grouped.some(([,group])=>group.some(([url])=>url===href)));
  const isStaff = area==="warehouse" || area==="admin";
  return <aside className="workspace-sidebar">
    <div className="workspace-sidebar-title">
      <p className="eyebrow">{isStaff?"OPERATIONS / INTERNAL":"CUSTOMER WORKSPACE"}</p>
      <strong>{area==="customer"?"My Workspace":area==="warehouse"?"仓库作业中心":"运营管理中心"}</strong>
      <p>{area==="customer"?"Your inspections, receiving address, samples and reports — organized in one place.":"统一实物、检查、证据和订单履约信息"}</p>
    </div>
    <nav className="workspace-nav" aria-label={title}>
      {[...grouped,[area==="customer"?"More":"平台配置",otherLinks] as const].filter(([,group])=>group.length>0).map(([name,group])=><div className="workspace-nav-group" key={name}>
        <p>{name}</p>
        {group.map(([href,label])=><Link key={href} href={href} aria-current={href===current?"page":undefined}>
          <PlatformIcon name={navIcons[href]??"orders"}/><span>{label}</span>
        </Link>)}
      </div>)}
    </nav>
    <div className="sidebar-note">
      <b>{isStaff?(demo?"演示环境提醒":"作业与审计留痕"):"Documented inspections"}</b>
      {isStaff
        ?(demo?"所有操作均为本机模拟。实际资金、物流、客户资产和报告发布需要服务端授权。":"所有收货、库位、质检证据与资金操作均实时记录服务端审计台账。")
        :"Item IDs, photo evidence and published report versions stay traceable throughout the process."}
    </div>
  </aside>;
}
