"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Empty, ErrorBlock, Field, Form, Panel, request, Select, text, useLoad } from "./ui";

type Receipt={public_no:string;case_id?:string};

export function PublicInquiry() {
  const {data,error,reload}=useLoad("/public/inquiry-categories");
  const [receipt,setReceipt]=useState<Receipt>();
  const submission=useRef<{payload:string;key:string}>(null);
  return <>
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>Contact Inspection Support</b></div>
    <div className="page-head">
      <div>
        <p className="eyebrow">QCWAREHOUSE / INSPECTION</p>
        <h1>Contact Inspection Support</h1>
        <p className="muted">Ask about a service scope, an unavailable product category or custom item quantities.</p>
      </div>
    </div>
    <div className="detail-layout">
      <div>
        {receipt?<Panel title="Inquiry received">
          <p role="status">Your reference is <strong className="code">{receipt.public_no}</strong>.</p>
          <p>Keep this reference for follow-up.</p>
          {receipt.case_id&&<Link href={"/support/cases/"+receipt.case_id}>Open your support case →</Link>}
        </Panel>:<Panel title="Inspection requirements">
          {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
          {!data&&!error&&<p role="status">Loading product categories…</p>}
          {data&&!error&&(data.categories.length?<Form label="Submit enquiry" run={async f=>{
            const payload={email:text(f,"email").toLowerCase(),category_id:text(f,"category_id"),
              sample_count:Number(text(f,"sample_count")),description:text(f,"description")};
            const serialized=JSON.stringify(payload);
            if(submission.current?.payload!==serialized)submission.current={payload:serialized,key:crypto.randomUUID()};
            setReceipt(await request("/public/inquiries","POST",payload,submission.current.key));
          }}>
            <div className="fields">
              <label>Contact email<input name="email" type="email" placeholder="you@company.com" required maxLength={254} autoComplete="email"/></label>
              <Select name="category_id" label="Product category" choices={data.categories}/>
              <Field name="sample_count" label="Estimated sample quantity" type="number" min={1} max={2147483647} step={1}/>
              <label>Company / brand (optional)<input name="company" type="text" placeholder="Your company"/></label>
            </div>
            <label style={{marginTop:14}}>What would you like checked?<textarea name="description" placeholder="Tell us the product type and your questions…" required maxLength={1000}/></label>
            <small>Up to 1,000 characters. Leave out payment details and passwords.</small>
          </Form>:<Empty>Custom inspection categories are currently unavailable.</Empty>)}
        </Panel>}
      </div>
      <aside>
        <Panel title="Independent product inspection">
          <p>We can confirm scope feasibility and direct you to the right inspection service. We cannot purchase goods or negotiate supplier refunds.</p>
          <div className="sep"/>
          <div className="actions"><Link className="button sm" href="/actions">View action center</Link>
            <Link className="button sm" href="/catalog">Browse standard services</Link></div>
        </Panel>
      </aside>
    </div>
  </>;
}
