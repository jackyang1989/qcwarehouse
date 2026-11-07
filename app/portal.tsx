"use client";

import Link from "next/link";
import { Catalog, CustomerActions, CustomerDesk, DemoCheckout, HowItWorks, Legal, NewOrder, OrderFulfillment, OrderView, ReportView, TrackView } from "./customer";
import { AdminDesk, LogisticsConfiguration, LogisticsDesk, StaffOrder, TaskView, WarehouseDesk, WarehouseDispatchBatch, WarehouseItemView, WarehousePackageView, WarehouseScan } from "./staff";
import { Action, request, Tag } from "./ui";
import { Brand, PublicHeader, QuickSwitch, SiteFooter, switchDemoPortal, WorkspaceNavigation } from "./chrome";
import { FAQ } from "./faq";
import { PublicInquiry } from "./public-inquiry";
import { ReportGuide } from "./report-guide";
import { StorageLocations, StorageMove } from "./storage-desk";
import { CustomerCase, StaffTicket, StaffTicketQueue } from "./ticket-desk";
import { ReportDesk, StaffReport } from "./report-desk";
import { OperationsDesk } from "./operations-desk";
import { PublishedReports } from "./report-sharing";
import { AuditDesk } from "./audit-desk";
import { NotificationInbox } from "./notifications";

import { canOpenStaffPage, customerDestination, customerTabs, staffHome, staffTabs, withDestination, type PortalRoute } from "../packages/core/portal-routes";

import type { Actor } from "../packages/core/common";

export function Portal({path,target,route,actor:a}:{path:string;target:string;route:PortalRoute;actor:Actor|null}) {
  const isStaff=route.area==="warehouse"||route.area==="admin";
  const publicPage=route.area==="public";
  const warehouseLinks=a?.kind==="staff"?staffTabs("warehouse",a.roles):[];
  const adminLinks=a?.kind==="staff"?staffTabs("admin",a.roles):[];
  const links=route.area==="warehouse"?warehouseLinks:route.area==="admin"?adminLinks:a?.kind==="customer"?customerTabs:[];
  let content;
  if(route.view==="catalog") content=<Catalog path={path}/>;
  else if(route.view==="how-it-works") content=<HowItWorks/>;
  else if(route.view==="faq") content=<FAQ/>;
  else if(route.view==="public-inquiry") content=<PublicInquiry/>;
  else if(route.view==="report-guide") content=<ReportGuide/>;
  else if(route.view==="legal") content=<Legal path={path}/>;
  else if(!a) content=null;
  else if(isStaff && a.kind!=="staff") content=<section className="panel narrow"><h1>需要员工权限</h1><p>请使用已分配权限的员工账号登录，或在本地演示环境下直接切换角色。</p>
    <div className="actions">
      <button type="button" className="button primary" onClick={()=>void switchDemoPortal(target,"admin@qcw.test")}>
        一键切换为{route.area==="warehouse"?"仓库":"管理后台"}演示账号
      </button>
      <Link className="button" href={withDestination("/staff/login",target)}>前往员工登录</Link>
    </div></section>;
  else if(isStaff&&!canOpenStaffPage(path,route,a.roles)) content=<section className="panel"><h1>当前账号无权访问</h1>
    <p>请联系管理员确认当前岗位的权限，或切换至对应岗位演示账号。</p>
    <div className="actions">
      <button type="button" className="button primary" onClick={()=>void switchDemoPortal(target,"admin@qcw.test")}>
        切换为全权限演示员工账号
      </button>
      {staffHome(a.roles)&&<Link className="button" href={staffHome(a.roles)!}>返回工作区</Link>}
    </div></section>;
  else if(route.view==="logistics") content=<LogisticsDesk/>;
  else if(route.view==="logistics-configuration") content=<LogisticsConfiguration/>;
  else if(route.view==="warehouse-scan") content=<WarehouseScan/>;
  else if(route.view==="warehouse-item") content=<WarehouseItemView code={route.id}/>;
  else if(route.view==="warehouse-package") content=<WarehousePackageView code={route.id}/>;
  else if(route.view==="dispatch-batch") content=<WarehouseDispatchBatch key={route.id} id={route.id}/>;
  else if(route.view==="report-desk") content=<ReportDesk/>;
  else if(route.view==="staff-report") content=<StaffReport key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="operations") content=<OperationsDesk/>;
  else if(path==="/admin/audit") content=<AuditDesk/>;
  else if(route.view==="storage-move") content=<StorageMove path={path}/>;
  else if(route.view==="storage-locations") content=<StorageLocations warehouseLinks={warehouseLinks}/>;
  else if(route.view==="admin") content=<AdminDesk path={path} actor={a}/>;
  else if(route.view==="staff-tickets") content=<StaffTicketQueue/>;
  else if(route.view==="staff-ticket") content=<StaffTicket key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="staff-order") content=<StaffOrder key={route.id} number={route.id}/>;
  else if(route.view==="task") content=<TaskView id={route.id} actor={a}/>;
  else if(route.view==="warehouse") content=<WarehouseDesk path={path} actor={a}/>;
  else if(a.kind!=="customer") content=<section className="panel narrow"><h1>Customer account required</h1>
    <p>Use your customer account to open the customer workspace.</p>
    <div className="actions">
      <button type="button" className="button primary" onClick={()=>void switchDemoPortal(customerDestination(target)??"/orders","customer@qcw.test")}>
        One-click switch to Demo Customer
      </button>
      <Link className="button" href={withDestination("/login",customerDestination(target))}>Sign in as a customer</Link>
    </div></section>;
  else if(route.view==="new-order") content=<NewOrder/>;
  else if(route.view==="customer-actions") content=<CustomerActions/>;
  else if(route.view==="customer-case") content=<CustomerCase key={route.recordId??route.id} id={route.recordId??route.id} order={route.recordId?route.id:undefined}/>;
  else if((route.view==="order-quote"||route.view==="order-shipment")&&route.recordId) content=<OrderFulfillment key={route.recordId} order={route.id} id={route.recordId} kind={route.view==="order-quote"?"quotes":"shipments"}/>;
  else if(route.view==="report") content=<ReportView key={route.id} number={route.id} version={route.version}/>;
  else if(path==="/reports") content=<PublishedReports/>;
  else if(path==="/account/notifications") content=<NotificationInbox/>;
  else if(route.view==="order") content=<OrderView key={route.id} number={route.id} section={route.section}/>;
  else if(route.view==="demo") content=<DemoCheckout id={route.id}/>;
  else if(route.view==="parcel"||route.view==="shipment") content=<TrackView kind={route.view==="parcel"?"parcels":"shipments"} id={route.id}/>;
  else content=<CustomerDesk path={path}/>;
  const locale=isStaff?"zh-CN":"en";
  const signOut=a?<Action run={async()=>{await request("/auth/logout","POST",{});location.assign(a.kind==="staff"?"/staff/login":"/login");}}>{a.kind==="staff"?"退出登录":"Sign out"}</Action>:undefined;
  const homeLink=a?.kind==="customer"?"/account":a?staffHome(a.roles):undefined;
  if(publicPage||!a||links.length===0) return <>
    <PublicHeader path={path} accountHref={homeLink} staff={a?.kind==="staff"} accountAction={signOut} actor={a}/>
    <main className={`public-shell view-${route.view}`} id="main-content" lang={locale}>{content}</main>
    <SiteFooter/>
  </>;

  const section=route.area==="admin"?"运营总览":route.area==="warehouse"?"仓库总览":"Workspace";
  const currentLink=links.find(([href])=>href===path);
  const parentLink=links.filter(([href])=>href!=="/wh"&&href!=="/admin"&&path.startsWith(href+"/")).sort(([left],[right])=>right.length-left.length)[0];
  const topLinks:[string,string][]=route.area==="warehouse"?[
    ["/wh/scan","扫码查询"],["/wh/inspection","检查队列"],["/wh/review","报告复核"],["/wh/dispatch","出库管理"],
  ]:route.area==="admin"?[
    ["/admin/orders","订单管理"],["/admin/finance","财务"],["/admin/logistics","物流监控"],["/admin/templates","模板配置"],["/admin/storage/locations","库位管理"],
  ]:[
    ["/catalog","Services"],["/categories","Product Categories"],["/how-it-works","How It Works"],["/report-guide","Reports"],["/pricing","Pricing"],
  ];

  return <div className={`workspace workspace-${route.area}`} lang={locale}>
    <a className="skip-link" href="#main-content">{isStaff?"跳至主要内容":"Skip to main content"}</a>
    <header className="workspace-top">
      <div className="workspace-brand"><Brand/><span className="workspace-context">INSPECTION PLATFORM</span></div>
      <span className="topspacer"/>
      <nav className="topnav" aria-label={isStaff?"快捷导航":"Platform navigation"}>
        {topLinks.map(([href,label])=><Link key={href} href={href} aria-current={path===href?"page":undefined}>{label}</Link>)}
      </nav>
      <div className="header-right">
        <QuickSwitch active={route.area as "customer"|"warehouse"|"admin"} actor={a}/>
        <Tag tone="outline">{isStaff?"内部演示":"Customer preview"}</Tag>
        {signOut}
      </div>
    </header>
    <div className={`workspace-layout ${path==="/orders/new"?"wizard-layout":""}`}>
      <WorkspaceNavigation area={route.area as "admin"|"warehouse"|"customer"} title={section} links={links} path={path}/>
      <main className={`workspace-main view-${route.view}`} id="main-content" tabIndex={-1}>
        <nav className="breadcrumb" aria-label={isStaff?"当前位置":"Breadcrumb"}>
          <Link href="/">{isStaff?"QCWarehouse":"QCWarehouse"}</Link><span aria-hidden="true">›</span>
          {links[0][0]===path?<strong>{section}</strong>:<><Link href={links[0][0]}>{section}</Link>
            {(currentLink||parentLink)&&<><span aria-hidden="true">›</span>{currentLink?<strong>{currentLink[1]}</strong>:<Link href={parentLink[0]}>{parentLink[1]}</Link>}</>}
          </>}
        </nav>
        {content}
        <SiteFooter/>
      </main>
    </div>
  </div>;
}
