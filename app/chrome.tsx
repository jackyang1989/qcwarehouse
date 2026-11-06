import Link from "next/link";
import type { ReactNode } from "react";

export function Brand() {
  return <Link className="wordmark" href="/" aria-label="QCWarehouse home">
    <span className="mark" aria-hidden="true"><PlatformIcon name="packages"/></span>
    <span>QCWarehouse</span>
  </Link>;
}

export function PublicHeader({accountHref,accountAction,staff,path="/"}:{
  accountHref?:string;accountAction?:ReactNode;staff?:boolean;path?:string;
}) {
  return <header className="top">
    <div className="workspace-brand"><Brand/><span className="workspace-context">Inspection Platform</span></div>
    <nav className="public-nav" aria-label="Primary">
      {[
        ["/catalog","Services"],["/categories","Product Categories"],["/how-it-works","How It Works"],
        ["/report-guide","Reports"],["/pricing","Pricing"],
      ].map(([href,label])=><Link key={href} href={href} aria-current={path===href||href==="/catalog"&&path.startsWith("/services/")?"page":undefined}>{label}</Link>)}
    </nav>
    <div className="public-header-actions">
      <Link className="button" href={accountHref??"/login"}>{staff?"员工工作区":accountHref?"My account":"Sign in"}</Link>
      {accountAction}
      {!staff&&<Link className="button primary" href="/orders/new">Start inspection</Link>}
    </div>
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer"><Brand/><p>Independent Product Inspection &amp; Sample Comparison in China</p>
    <nav aria-label="Footer"><Link href="/faq">FAQ</Link><Link href="/contact">Contact</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link><Link href="/staff/login" prefetch={false}>Staff sign-in</Link></nav>
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
  "/account/billing":"finance","/support":"support","/actions":"orders","/wh":"overview","/wh/intake":"packages","/wh/inspection":"inspection",
  "/wh/dispatch":"dispatch","/wh/logistics":"dispatch","/admin":"overview","/admin/orders":"orders","/admin/finance":"finance",
  "/admin/settings":"settings","/admin/logistics":"dispatch","/admin/integrations/logistics":"settings",
  "/wh/storage":"packages","/wh/scan":"inspection","/admin/storage/locations":"packages",
  "/admin/tickets":"support","/admin/audit":"reports","/admin/operations":"settings","/wh/review":"reports","/account/notifications":"support",
};

export function PlatformIcon({name}:{name:string}) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]??iconPaths.orders}/></svg>;
}

const navigationSections = {
  customer: [
    ["Workspace",["/account","/orders","/orders/new","/actions"]],
    ["Warehouse & reports",["/parcels","/items","/reports"]],
    ["Account services",["/account/billing","/account/notifications","/support"]],
  ],
  warehouse: [
    ["日常作业",["/wh","/wh/scan","/wh/intake","/wh/storage"]],
    ["质检与履约",["/wh/inspection","/wh/review","/wh/dispatch","/wh/logistics"]],
  ],
  admin: [
    ["运营与财务",["/admin","/admin/orders","/admin/tickets","/admin/finance"]],
    ["履约与配置",["/admin/settings","/admin/storage/locations","/admin/logistics","/admin/integrations/logistics"]],
    ["平台治理",["/admin/operations","/admin/audit"]],
  ],
} satisfies Record<string,[string,string[]][]>;

export function WorkspaceNavigation({area,title,links,path}:{area:keyof typeof navigationSections;title:string;links:[string,string][];path:string}) {
  const current=links.find(([href])=>href===path)?.[0]
    ?? links.filter(([href])=>href!=="/wh"&&href!=="/admin"&&path.startsWith(href+"/")).sort(([left],[right])=>right.length-left.length)[0]?.[0]
    ?? (path.startsWith("/wh/task/")?"/wh/inspection":path.startsWith("/shipments/")?"/parcels":undefined);
  const grouped = navigationSections[area].map(([name,paths])=>[name,paths.flatMap(href=>links.filter(([url])=>url===href))] as const);
  const otherLinks = links.filter(([href])=>!grouped.some(([,group])=>group.some(([url])=>url===href)));
  return <aside className="workspace-sidebar">
    <div className="workspace-sidebar-title">
      <p className="eyebrow">QCWarehouse</p>
      <strong>{title}</strong>
      <p>{area==="customer"?"Your inspections, receiving address, items and reports.":area==="warehouse"?"收货、实物库位、质检证据与包裹交接。":"订单履约、运营配置与审计记录。"}</p>
    </div>
    <nav className="workspace-nav" aria-label={title}>
      {[...grouped,[area==="customer"?"More":"其他",otherLinks] as const].filter(([,group])=>group.length>0).map(([name,group])=><div className="workspace-nav-group" key={name}>
        <p>{name}</p>
        {group.map(([href,label])=><Link key={href} href={href} aria-current={href===current?"page":undefined}>
          <PlatformIcon name={navIcons[href]??"orders"}/><span>{label}</span>
        </Link>)}
      </div>)}
    </nav>
  </aside>;
}
