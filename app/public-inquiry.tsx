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
    <div className="page-head public-masthead"><p className="eyebrow">SERVICES / CUSTOM INSPECTIONS</p><h1>Request a custom inspection</h1>
      <p className="muted">Tell us what needs checking when the standard services do not cover your request.</p></div>
    <div className="ops-columns">
      {receipt?<Panel title="Inquiry received">
        <p role="status">Your reference is <strong className="code">{receipt.public_no}</strong>.</p>
        <p>Keep this reference for follow-up.</p>
        {receipt.case_id&&<Link href={"/support/cases/"+receipt.case_id}>Open your support case →</Link>}
      </Panel>:<Panel title="Inspection requirements">
        {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
        {!data&&!error&&<p role="status">Loading product categories…</p>}
        {data&&!error&&(data.categories.length?<Form label="Submit inquiry" run={async f=>{
          const payload={email:text(f,"email").toLowerCase(),category_id:text(f,"category_id"),
            sample_count:Number(text(f,"sample_count")),description:text(f,"description")};
          const serialized=JSON.stringify(payload);
          if(submission.current?.payload!==serialized)submission.current={payload:serialized,key:crypto.randomUUID()};
          setReceipt(await request("/public/inquiries","POST",payload,submission.current.key));
        }}>
          <label>Contact email<input name="email" type="email" required maxLength={254} autoComplete="email"/></label>
          <Select name="category_id" label="Product category" choices={data.categories}/>
          <Field name="sample_count" label="Number of items" type="number" min={1} max={2147483647} step={1}/>
          <label>What should we check?<textarea name="description" required maxLength={1000}/></label>
          <small>Up to 1,000 characters. Leave out payment details and passwords.</small>
        </Form>:<Empty>Custom inspection categories are currently unavailable.</Empty>)}
      </Panel>}
      <Panel title="Already have an order?">
        <p>Open your workspace to view order updates and create a support case for an existing inspection.</p>
        <div className="actions"><Link className="button" href="/actions">View action center</Link>
          <Link className="button" href="/catalog">Browse standard services</Link></div>
      </Panel>
    </div>
  </>;
}
