"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const topics=[
  ["Services",[
    ["service-scope","What does QC Warehouse do?","We receive the products you buy from sellers, inspect each commissioned item and deliver a report with evidence. You can also order a side-by-side comparison."],
    ["sourcing","Are you a sourcing agent?","You buy directly from the seller. Our work begins with receiving and checking the physical items."],
    ["subscription","Do I need a subscription?","Standard inspection is ordered and priced per commission."],
    ["supported-products","Which products do you check?","The service catalogue lists the product categories and checks currently available."],
    ["sample-count","How many items can I send?","Compare two or three samples in a comparison service. With standard inspection, commission the actual quantity you need checked, from one item to several dozen."],
  ]],
  ["Receiving and turnaround",[
    ["receiving-address","How do I send items to the warehouse?","After signing up, copy the warehouse address with your personal receiving code into the seller’s shipping details. Add the seller’s tracking number to your workspace once it ships."],
    ["missing-receiving-code","What if the parcel has no receiving code?","Add the original seller tracking number to your workspace. A parcel may be held for identification until the warehouse verifies ownership."],
    ["turnaround","How long does a report take?","Your quote shows the estimated turnaround for the selected service and quantity."],
    ["timing-start","When does inspection timing start?","The turnaround starts after the warehouse receives and identifies all commissioned items, subject to the accepted quote."],
    ["arrival-damage","What happens if items arrive damaged?","The warehouse records observed parcel or item damage and its supporting evidence for review."],
  ]],
  ["Checks and reports",[
    ["measurements","What do you measure?","Measurements, units and methods depend on the selected category and service. The report records results and supporting evidence."],
    ["fabric-testing","Do you test fabric composition or GSM?","Apparel checks can record garment weight when included in the checklist. Fabric composition and GSM require separate testing."],
    ["color","Do you provide instrument color values?","The standard service records visual observations under the specified lighting conditions."],
    ["certification","Is the report a lab test or certification?","The report records physical checks on the items received. Laboratory tests and certification require separate qualified providers."],
    ["bulk-order","Does the report cover my bulk order?","The report applies to the actual items inspected. Use a separate sampling plan for any production batch."],
    ["supplier-choice","Will you rank suppliers for me?","You decide using the recorded measurements, photos and observations."],
    ["tolerances","Can I give you tolerances?","When the service supports customer-specified limits, the report records the supplied limits and the observed result."],
  ]],
  ["Storage and shipping",[
    ["after-inspection","What happens to items after inspection?","Choose a handling instruction for each item. Options include storage, forwarding or returning the item to the seller."],
    ["seller-returns","How do I return an item to the seller?","Request the return with your seller and provide their return address. You pay the quoted return shipping fee. The warehouse records the actual tracking number after handover."],
    ["storage-period","How long can I store items?","Review the storage deadline shown for each item and the current terms before choosing an extension."],
    ["forwarding","Can you send my items to a freight forwarder?","Provide the forwarder’s address and required member code. Approve and pay the shipping quote before the warehouse hands over the parcel."],
    ["restricted-items","Which items are restricted?","Read the current Restricted items policy before arranging a delivery."],
  ]],
  ["Billing and support",[
    ["refunds","Can I request a refund?","Inspection fee refunds depend on your order progress and the applicable terms. Ask the seller directly about refunds for the merchandise you purchased."],
    ["payment","Who processes my payment?","Stripe processes card payments. The receipt and current terms identify the seller of record."],
    ["contact","How do I contact support?","Sign in and open a support case. Include the relevant inspection order or tracking number so the team can locate the record."],
  ]],
] as const;

export function FAQ() {
  const [query,setQuery]=useState("");
  useEffect(()=>{
    const reveal=()=>{
      const item=document.getElementById(location.hash.slice(1));
      if(item instanceof HTMLDetailsElement) {
        item.open=true;
        item.scrollIntoView({block:"start"});
      }
    };
    reveal();
    window.addEventListener("hashchange",reveal);
    return ()=>window.removeEventListener("hashchange",reveal);
  },[]);
  const term=query.trim().toLowerCase();
  const groups=topics.map(([title,items])=>({title,items:items.filter(([,question,answer])=>
    question.toLowerCase().includes(term)||answer.toLowerCase().includes(term))})).filter(group=>group.items.length);
  return <div className="faq">
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>Frequently Asked Questions</b></div>
    <div className="page-head">
      <div>
        <p className="eyebrow">QCWAREHOUSE / INSPECTION</p>
        <h1>Frequently Asked Questions</h1>
        <p className="muted">Search by subject, and expand each answer.</p>
      </div>
      <div className="head-actions">
        <Link className="button primary" href="/contact">Ask a question</Link>
      </div>
    </div>
    <div className="card">
      <div className="selectbar">
        <div className="search"><input type="search" aria-label="Search FAQ" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search shipping, inspection, reports, payments…"/></div>
        {query&&<button type="button" className="button sm" onClick={()=>setQuery("")}>Clear</button>}
      </div>
      {groups.length===0&&<p role="status" className="notice">No matching questions. Try a different search or open a <Link href="/support">support case</Link>.</p>}
      {groups.map(({title,items})=><section className="faq-group" key={title}>
        {items.map(([id,question,answer])=><details className="faq-item" key={id} id={id}>
          <summary>{question} <span className="tag gray" style={{marginLeft:8}}>{title}</span></summary><p>{answer}</p>
          <a className="button sm" style={{marginTop:6}} href={"#"+id}>Copy direct link</a>
        </details>)}
      </section>)}
    </div>
    <div className="actions"><Link className="button" href="/catalog">Browse services</Link><Link className="button" href="/legal/restricted-items">Restricted items</Link><Link className="button" href="/legal/terms">Terms of service</Link><Link className="button" href="/support">Open a support case</Link></div>
  </div>;
}
