"use client";

import Link from "next/link";
import { Catalog, CustomerDesk, DemoCheckout, Legal, Login, NewOrder, Onboarding, OrderView, ReportView, TrackView } from "./customer";
import { AdminDesk, LogisticsDesk, TaskView, WarehouseDesk } from "./staff";
import { Action, Tabs, request, useLoad } from "./ui";

const customer:[string,string][]=[["/account","Account"],["/orders","Orders"],["/parcels","Parcels"],["/items","Items"],["/reports","Reports"],["/account/billing","Billing"],["/support","Support"]];
const warehouse:[string,string][]=[["/wh","概览"],["/wh/intake","收货"],["/wh/inspection","质检与复核"],["/wh/dispatch","出库"],["/wh/logistics","物流"]];
const admin:[string,string][]=[["/admin","概览"],["/admin/orders","订单及工单"],["/admin/finance","财务"],["/admin/settings","仓址及模板"]];
export function Portal({path}:{path:string}) {
  const auth=useLoad("/me");
  const a=auth.data?.actor;
  const isStaff=path==="/wh"||path.startsWith("/wh/")||path==="/admin"||path.startsWith("/admin/")||path==="/staff/login";
  const isAdmin=path==="/admin"||path.startsWith("/admin/");
  const isCatalog=["/catalog","/categories","/pricing"].includes(path)||path.startsWith("/services/");
  const isLegal=path==="/legal"||path.startsWith("/legal/");
  const publicPage=isCatalog||isLegal||["/login","/signup","/onboarding","/staff/login"].includes(path);
  let content;
  if(isCatalog) content=<Catalog/>;
  else if(isLegal) content=<Legal/>;
  else if(path==="/onboarding") content=<Onboarding/>;
  else if(["/login","/signup"].includes(path)) content=<Login/>;
  else if(path==="/staff/login") content=<Login staff/>;
  else if(!a) content=auth.error?<Login staff={isStaff}/>:<p>Loading / 加载中…</p>;
  else if(isStaff && a.kind!=="staff") content=<p>请使用员工账号登录。</p>;
  else if(isStaff && path.includes("/logistics")) content=<LogisticsDesk/>;
  else if(isAdmin) content=<AdminDesk path={path} actor={a}/>;
  else if(isStaff && path.startsWith("/wh/task/")) content=<TaskView id={path.split("/")[3]} actor={a}/>;
  else if(isStaff) content=<WarehouseDesk path={path} actor={a}/>;
  else if(a.kind!=="customer") content=<p><Link href="/wh">打开仓库工作台</Link> · <Link href="/admin">打开管理后台</Link></p>;
  else if(path==="/orders/new") content=<NewOrder/>;
  else if(/^\/orders\/QW-[A-F0-9]+\/report$/.test(path)) content=<ReportView number={path.split("/")[2]}/>;
  else if(/^\/orders\/QW-[A-F0-9]+$/.test(path)) content=<OrderView number={path.split("/")[2]}/>;
  else if(path.startsWith("/checkout/demo/")) content=<DemoCheckout id={path.split("/")[3]}/>;
  else if(path.startsWith("/parcels/")||path.startsWith("/shipments/")) content=<TrackView kind={path.startsWith("/parcels/")?"parcels":"shipments"} id={path.split("/")[2]}/>;
  else if(customer.some(([href])=>href===path)) content=<CustomerDesk path={path}/>;
  else content=<><h1>Page not available</h1><Link href="/account">Back to account</Link></>;
  return <>
    <header className="top"><Link className="wordmark" href="/"><span className="mark">QC</span> Warehouse</Link><nav>
      {a?.kind==="staff"?<><Link href="/wh">仓库</Link><Link href="/admin">后台</Link></>:<><Link href="/catalog">Services</Link><Link href="/account">Account</Link></>}
      {a?<Action run={async()=>{await request("/auth/logout","POST",{});location.assign("/login");}}>{isStaff?"退出":"Sign out"}</Action>:<Link href="/login">Sign in</Link>}
    </nav></header>
    <main className="shell" lang={isStaff?"zh-CN":"en"}>
      {a&&!publicPage&&<Tabs links={isAdmin?admin:isStaff?warehouse:customer} path={path}/>}
      {content}
    </main>
  </>;
}
