"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Action, Empty, ErrorBlock, Panel, request, stamp, Table, useLoad, type Row } from "./ui";

const noticeTitles:Record<string,string>={
  "ticket.reply":"Support has replied to your case",
  "report.published":"Your inspection report is ready",
  "report.amended":"An updated report has been published",
  "payment.confirmed":"Payment confirmed",
  "package.received":"The warehouse received your parcel",
  "order.ready":"Your items are ready for inspection",
  "order.identity_mismatch":"Action required: Sample identity mismatch detected",
  "order.cancelled":"Inspection cancelled",
  "dispatch.quoted":"Your shipping quote is ready",
  "quote.offered":"A manual inspection quote is ready",
  "shipment.handed_over":"Your parcel has been handed to the carrier",
  "shipment.return_received":"Returned items have been received at the warehouse",
  "tracking.exception_opened":"Carrier reported a delivery exception",
  "email.delivery_failed":"We couldn't deliver email to this address",
};
function UpdatesTable({notices,onRead}:{notices:Row[];onRead:()=>void}) {
  return <>
    {notices.length?<Table headers={["Update","Received","Status",""]} rows={notices.map(notice=>{
      const href=notice.case_id?"/support/cases/"+notice.case_id:
        notice.report_version&&notice.order_number?"/orders/"+notice.order_number+"/report/versions/"+notice.report_version:
        notice.order_number?"/orders/"+notice.order_number:
        notice.shipment_id?"/shipments/"+notice.shipment_id:
        notice.advice_id?"/parcels/"+notice.advice_id:
        notice.charge_id?"/account/billing#charge-"+notice.charge_id:
        notice.template==="email.delivery_failed"?"/account":
        notice.template==="payment.confirmed"||notice.template==="dispatch.quoted"?"/account/billing":null;
      return [noticeTitles[notice.template]??"Account update",stamp(notice.created_at),notice.read_at?"Read":"Unread",
        <div className="actions">{href&&<Link href={href}>Open</Link>}
          {!notice.read_at&&<Action run={async()=>{
            await request("/me/notifications/"+notice.id+"/read","POST",{});onRead();
          }}>Mark as read</Action>}
        </div>];
    })}/>:<Empty>No updates yet.</Empty>}
  </>;
}
export function RecentUpdates({notices,onRead}:{notices:Row[];onRead:()=>void}) {
  return <Panel title="Recent updates"><UpdatesTable notices={notices} onRead={onRead}/>
    <Link href="/account/notifications">View notification history →</Link>
  </Panel>;
}
export function NotificationInbox() {
  const search=useSearchParams(),params=new URLSearchParams();
  const unread=search.get("unread")==="1",before=search.get("before");
  if(unread)params.set("unread","1");
  if(before)params.set("before",before);
  const {data,error,reload}=useLoad("/me/notifications"+(params.size?"?"+params:""));
  const first=unread?"/account/notifications?unread=1":"/account/notifications";
  const next=new URLSearchParams(params);
  if(data?.next_before)next.set("before",data.next_before);
  return <>
    <div className="page-head"><Link href="/account">← Account</Link><p className="eyebrow report-eyebrow">CLIENT WORKSPACE</p>
      <h1>Notifications</h1><p className="muted">Find updates about reports, payments, parcels, and support cases.</p></div>
    <Panel title={unread?"Unread updates":"All updates"}>
      <div className="actions"><Link href="/account/notifications" aria-current={!unread?"page":undefined}>All</Link>
        <Link href="/account/notifications?unread=1" aria-current={unread?"page":undefined}>Unread</Link>
        <button type="button" onClick={reload}>Refresh</button></div>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">Loading updates…</p>}
      {data&&!error&&<UpdatesTable notices={data.rows} onRead={reload}/>}
      <div className="actions">{before&&<Link href={first}>Back to first page</Link>}
        {!error&&data?.next_before&&<Link href={"/account/notifications?"+next}>Older updates →</Link>}</div>
    </Panel>
  </>;
}
