import { hasStaffAccess, staffAccess } from "./staff-access";

export const customerTabs:[string,string][]=[
  ["/account","Account"],["/orders","Orders"],["/orders/new","New inspection"],["/parcels","Parcels"],["/items","Items"],
  ["/reports","Reports"],["/account/billing","Billing"],["/support","Support"],
  ["/actions","Action required"],["/account/notifications","Notifications"],
];
const warehouseOverview=[...staffAccess.intake,...staffAccess.inspection];
const warehouseTabs=[
  ["/wh","概览",warehouseOverview],["/wh/intake","收货",staffAccess.intake],
  ["/wh/storage","库位移转",staffAccess.intake],
  ["/wh/scan","扫码查询",staffAccess.intake],
  ["/wh/inspection","质检与复核",staffAccess.inspection],["/wh/dispatch","出库",staffAccess.dispatch],
  ["/wh/review","报告与修订",staffAccess.reportEditing],
  ["/wh/logistics","物流",staffAccess.tracking],
] as const;
const adminTabs=[
  ["/admin","概览",staffAccess.administration],["/admin/orders","订单及工单",staffAccess.orders],
  ["/admin/tickets","客户工单",staffAccess.orders],
  ["/admin/finance","财务",staffAccess.finance],["/admin/settings","仓址及模板",staffAccess.templates],
  ["/admin/storage/locations","库位管理",staffAccess.locations],
  ["/admin/logistics","物流监控",staffAccess.tracking],
  ["/admin/integrations/logistics","物流接入",staffAccess.trackingConfiguration],
  ["/admin/operations","后台作业",["super_admin"]],
  ["/admin/audit","审计记录",["super_admin"]],
] as const;

export function staffTabs(area:"admin"|"warehouse",roles:readonly string[]):[string,string][] {
  return (area==="admin"?adminTabs:warehouseTabs)
    .filter(([, , allowed])=>hasStaffAccess(roles,allowed)).map(([path,label])=>[path,label]);
}

export function canOpenStaffPage(path:string,route:PortalRoute,roles:readonly string[]) {
  if(route.area!=="admin"&&route.area!=="warehouse") return false;
  if(route.view==="task") return hasStaffAccess(roles,staffAccess.inspection);
  if(route.view==="dispatch-batch") return hasStaffAccess(roles,staffAccess.dispatch);
  if(route.view==="staff-report") return hasStaffAccess(roles,staffAccess.reportEditing);
  if(route.view==="staff-ticket"||route.view==="staff-order") return hasStaffAccess(roles,staffAccess.orders);
  if(route.view==="warehouse-package"||route.view==="warehouse-item") return hasStaffAccess(roles,staffAccess.intake);
  if(["/admin/catalog","/admin/categories","/admin/templates"].includes(path)) return hasStaffAccess(roles,staffAccess.templates);
  return staffTabs(route.area,roles).some(([link])=>link===path);
}

export const servicePages = {
  "/services/inspection":"inspection",
  "/services/compare":"compare",
  "/services/reference":"reference_match",
} as const;
export const legalPages = {
  "/legal/terms":"terms",
  "/legal/privacy":"privacy",
  "/legal/restricted-items":"restricted_items",
  "/legal/report-notice":"report_notice",
} as const;

type Area = "public" | "customer" | "warehouse" | "admin";
type StaticView = "catalog" | "how-it-works" | "faq" | "report-guide" | "public-inquiry" | "legal" | "login" | "onboarding" | "account-recovery" | "staff-login" | "customer" | "customer-actions" | "warehouse" | "admin" | "staff-tickets" | "logistics" | "logistics-configuration" | "storage-move" | "storage-locations" | "warehouse-scan" | "report-desk" | "operations";
type DetailView = "order" | "report" | "parcel" | "shipment" | "task" | "demo" | "warehouse-package" | "warehouse-item" | "customer-case" | "staff-ticket" | "staff-order" | "order-quote" | "order-shipment" | "dispatch-batch" | "staff-report";
export const orderSections={
  payment:"Payment",parcels:"Parcels",dispositions:"Item instructions",storage:"Storage",
} as const;
export type OrderSection=keyof typeof orderSections;
export type PortalRoute =
  | {area:Area;view:StaticView}
  | {area:Area;view:DetailView;id:string;version?:number;section?:OrderSection;recordId?:string}
  | {area:"customer";view:"new-order"};

const fixed = new Map<string,PortalRoute>();
for(const [paths,route] of [
  [customerTabs.map(([path])=>path),{area:"customer",view:"customer"}],
  [warehouseTabs.map(([path])=>path),{area:"warehouse",view:"warehouse"}],
  [adminTabs.map(([path])=>path),{area:"admin",view:"admin"}],
  [["/catalog","/categories","/pricing",...Object.keys(servicePages)],{area:"public",view:"catalog"}],
  [["/legal",...Object.keys(legalPages)],{area:"public",view:"legal"}],
  [["/how-it-works"],{area:"public",view:"how-it-works"}],
  [["/faq"],{area:"public",view:"faq"}],
  [["/contact"],{area:"public",view:"public-inquiry"}],
  [["/report-guide"],{area:"public",view:"report-guide"}],
  [["/login","/signup"],{area:"public",view:"login"}],
  [["/onboarding"],{area:"public",view:"onboarding"}],
  [["/account/recovery"],{area:"public",view:"account-recovery"}],
  [["/staff/login"],{area:"public",view:"staff-login"}],
  [["/orders/new"],{area:"customer",view:"new-order"}],
  [["/account/notifications","/account/security"],{area:"customer",view:"customer"}],
  [["/actions"],{area:"customer",view:"customer-actions"}],
  [["/admin/tickets"],{area:"admin",view:"staff-tickets"}],
  [["/admin/operations"],{area:"admin",view:"operations"}],
  [["/admin/catalog","/admin/categories","/admin/templates"],{area:"admin",view:"admin"}],
  [["/wh/logistics"],{area:"warehouse",view:"logistics"}],
  [["/wh/storage"],{area:"warehouse",view:"storage-move"}],
  [["/wh/review"],{area:"warehouse",view:"report-desk"}],
  [["/wh/scan"],{area:"warehouse",view:"warehouse-scan"}],
  [["/admin/storage/locations"],{area:"admin",view:"storage-locations"}],
  [["/admin/logistics"],{area:"admin",view:"logistics"}],
  [["/admin/integrations/logistics"],{area:"admin",view:"logistics-configuration"}],
] satisfies [string[],PortalRoute][]) {
  for(const path of paths) fixed.set(path,route);
}

const publicNo = "(QW-[A-F0-9]+)";
const uuid = "([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})";
const details:{pattern:RegExp;area:Area;view:DetailView}[]=[
  {pattern:new RegExp("^/orders/"+publicNo+"(?:/("+Object.keys(orderSections).join("|")+"))?$"),area:"customer",view:"order"},
  {pattern:new RegExp("^/orders/"+publicNo+"/report(?:/versions/([1-9][0-9]{0,9}))?$"),area:"customer",view:"report"},
  {pattern:new RegExp("^/orders/"+publicNo+"/cases/"+uuid+"$"),area:"customer",view:"customer-case"},
  {pattern:new RegExp("^/orders/"+publicNo+"/quotes/"+uuid+"$"),area:"customer",view:"order-quote"},
  {pattern:new RegExp("^/orders/"+publicNo+"/shipments/"+uuid+"$"),area:"customer",view:"order-shipment"},
  {pattern:new RegExp("^/support/cases/"+uuid+"$"),area:"customer",view:"customer-case"},
  {pattern:new RegExp("^/admin/tickets/"+uuid+"$"),area:"admin",view:"staff-ticket"},
  {pattern:new RegExp("^/admin/orders/"+publicNo+"$"),area:"admin",view:"staff-order"},
  {pattern:new RegExp("^/parcels/"+uuid+"$"),area:"customer",view:"parcel"},
  {pattern:new RegExp("^/shipments/"+uuid+"$"),area:"customer",view:"shipment"},
  {pattern:new RegExp("^/wh/task/"+uuid+"$"),area:"warehouse",view:"task"},
  {pattern:new RegExp("^/wh/dispatch/"+uuid+"$"),area:"warehouse",view:"dispatch-batch"},
  {pattern:new RegExp("^/wh/review/"+uuid+"$"),area:"warehouse",view:"staff-report"},
  {pattern:/^\/wh\/packages\/(P-[A-Z0-9-]{1,64})$/,area:"warehouse",view:"warehouse-package"},
  {pattern:/^\/wh\/samples\/(S-[A-Za-z0-9-]{1,64})$/,area:"warehouse",view:"warehouse-item"},
  {pattern:new RegExp("^/checkout/demo/"+uuid+"$"),area:"customer",view:"demo"},
];

export function resolvePortalRoute(path:string):PortalRoute|undefined {
  const entry=fixed.get(path);
  if(entry) return entry;
  for(const {pattern,area,view} of details) {
    const match=pattern.exec(path);
    if(match) {
      if(!match[2]) return {area,view,id:match[1]};
      if(view==="customer-case"||view==="order-quote"||view==="order-shipment")return {area,view,id:match[1],recordId:match[2]};
      if(view==="order")return {area,view,id:match[1],section:match[2] as OrderSection};
      const version=Number(match[2]);
      if(version<=2147483647) return {area,view,id:match[1],version};
    }
  }
  return undefined;
}


const portalOrigin = "https://qcwarehouse.invalid";

function localPortalUrl(path:string|null|undefined) {
  if(!path?.startsWith("/")||path.startsWith("//")||path.includes("\\")||/[\u0000-\u001f\u007f]/.test(path)||path.length>2048) return null;
  const url=new URL(path,portalOrigin);
  return url.origin===portalOrigin?url:null;
}

export function customerDestination(path:string|null|undefined) {
  const url=localPortalUrl(path);
  const route=url&&resolvePortalRoute(url.pathname);
  if(!url||route?.area!=="customer"||route.view==="demo") return null;
  return url.pathname+url.search+url.hash;
}

export function staffDestination(path:string|null|undefined,roles:readonly string[]) {
  const url=localPortalUrl(path);
  const route=url&&resolvePortalRoute(url.pathname);
  return url&&route&&canOpenStaffPage(url.pathname,route,roles)?url.pathname+url.search+url.hash:null;
}

export function staffHome(roles:readonly string[],area:"warehouse"|"admin"="admin") {
  const links=staffTabs(area,roles);
  return links[0]?.[0]??staffTabs(area==="warehouse"?"admin":"warehouse",roles)[0]?.[0];
}

export function withDestination(path:string,next:string|null|undefined) {
  if(!next) return path;
  return path+(path.includes("?")?"&":"?")+new URLSearchParams({next});
}
