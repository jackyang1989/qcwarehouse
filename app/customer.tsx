"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, Photo, request, Select, stamp, Table, Tag, text, useLoad, usd, type Row } from "./ui";

const acknowledged={scope_notice:"I understand which checks are included.",samples_not_batch:"These samples do not represent an entire production batch.",seller_refund_is_mine:"I handle any refund request directly with my seller.",no_certification:"The report is an inspection record and does not provide certification.",restricted_items:"My items comply with the restricted items policy."};
const states:Record<string,string>={draft:"Draft",awaiting_payment:"Awaiting payment",awaiting_samples:"Awaiting items",queued:"Ready for inspection",inspecting:"Inspection underway",qa_review:"Under review",report_ready:"Report ready",action_pending:"Awaiting disposition",cancelled:"Cancelled",closed:"Closed",on_hold:"On hold"};
const label=(state:string)=>states[state]??state.replaceAll("_"," ");

export function Login({staff=false}:{staff?:boolean}) {
  const {data}=useLoad("/auth/providers");
  const [challenge,setChallenge]=useState<Row>(),[email,setEmail]=useState("");
  const [query,setQuery]=useState<URLSearchParams>();
  useEffect(()=>setQuery(new URLSearchParams(location.search)),[]);
  async function after(v:Row) {
    if(v.kind==="staff") {
      const {actor}=await request("/me");
      const admin=actor.roles.some((r:string)=>["super_admin","support","finance","template_admin"].includes(r));
      const warehouse=actor.roles.some((r:string)=>["receiver","warehouse_admin","inspector","reviewer"].includes(r));
      location.assign(admin && !(staff && warehouse && !location.pathname.startsWith("/admin"))?"/admin":"/wh");
      return;
    }
    location.assign(v.state==="onboarding"?"/onboarding":"/account");
  }
  return <div className="narrow panel"><p className="eyebrow">{staff?"QCW STAFF":"QCW CUSTOMER ACCOUNT"}</p><h1>{staff?"员工登录":"Sign in or register"}</h1>
    {query?.get("oauth")&&<ErrorBlock error={query.get("oauth")==="link_required"?"This identity needs linking from your existing account.":"Provider sign-in was not completed. Try again or use email."}/>}
    {query?.has("verify")&&<div className="notice">Verify your email address to finish connecting your Microsoft or Google account.</div>}
    {!staff&&<div className="actions">
      {data?.google&&<a className="button" href="/api/v1/auth/google/start">Continue with Google</a>}
      {data?.microsoft&&<a className="button" href="/api/v1/auth/microsoft/start">Continue with Microsoft</a>}
    </div>}
    {staff&&!data?.demo?<Form label="登录" run={async f=>after(await request("/staff/auth/login","POST",{email:text(f,"email"),password:text(f,"password"),otp:text(f,"otp")}))}>
      <Field label="邮箱" name="email" type="email"/><Field label="密码" name="password" type="password"/><Field label="验证器动态码" name="otp"/>
    </Form>:!challenge?<Form label={staff?"获取验证码":"Email me a verification code"} run={async f=>{
      const e=text(f,"email");setEmail(e);setChallenge(await request("/auth/otp/request","POST",{email:e}));
    }}><Field label={staff?"员工邮箱":"Email address"} name="email" type="email" value={email}/></Form>:
      <><p>{email}</p>{challenge.demo_code&&<div className="notice">Local verification code <strong className="code">{challenge.demo_code}</strong></div>}
      <Form label={staff?"验证并登录":"Verify email"} run={async f=>after(await request("/auth/otp/verify","POST",{challenge_id:challenge.challenge_id,code:text(f,"code")}))}>
        <Field label="Verification code / 验证码" name="code" value={challenge.demo_code}/></Form>
      <button type="button" onClick={()=>setChallenge(undefined)}>Change email</button></>}
    {data?.demo&&<p className="small muted">{staff?"测试员工邮箱：receiving、inspector、reviewer、admin，后缀 @qcw.test。":"Local demo: use an email ending in @qcw.test."}</p>}
  </div>;
}
export function Onboarding() {
  const {data,error}=useLoad("/public/terms");
  const terms=data?.terms.filter((t:Row)=>["terms","privacy"].includes(t.kind))??[];
  return <div className="narrow panel"><h1>Activate your receiving address</h1><p>Review the account terms to get your permanent receiving code.</p>
    {error&&<ErrorBlock error={error}/>}
    {terms.length===2&&<Form label="Create my account" run={async f=>{
      if(!checked(f,"accept")) throw new Error("Accept both policies to continue.");
      await request("/auth/registration/complete","POST",{terms_version_ids:terms.map((t:Row)=>t.id)});
      location.assign("/account");
    }}>
      {terms.map((t:Row)=><details key={t.id}><summary>{t.kind==="terms"?"Terms of service":"Privacy notice"} · {t.version}</summary><p>{t.content_md}</p></details>)}
      <label className="check"><input type="checkbox" name="accept" required/> I accept the terms of service and privacy notice.</label>
    </Form>}
  </div>;
}
export function Catalog() {
  const {data,error}=useLoad("/catalog");
  const [category,setCategory]=useState("");
  const offers:Row[]=data?.offers??[];
  const categories=new Map<string,string>(offers.map(o=>[o.category_id,o.category.en]));
  return <><div className="page-head"><p className="eyebrow">SERVICE CATALOGUE</p><h1>Choose your inspection</h1><p className="muted">Select a product category to see the available services and quantity ranges.</p></div>
    {error&&<ErrorBlock error={error}/>}
    {categories.size>0&&<div className="actions" aria-label="Product categories">{[...categories].map(([id,name])=>
      <button type="button" className={category===id?"primary":""} aria-pressed={category===id} key={id} onClick={()=>setCategory(id)}>{name}</button>)}</div>}
    <div className="grid">{offers.filter(o=>o.category_id===category).map((o:Row)=><article className="card" key={o.offer_id}>
      <Tag>{o.category.en}</Tag><h2>{o.title.en}</h2><p>{o.rules.minimum}–{o.rules.maximum} items · {o.rules.business_days} business days after intake</p>
      <p><strong>{usd(o.rules.unit_cents??o.rules.package_cents)}</strong> {o.rules.unit_cents?"per item":"per group"}</p>
      {o.rules.demo&&<p className="muted small">Development catalogue and prices</p>}
      <Link className="button primary" href={"/orders/new?offer="+o.offer_id}>Choose service</Link>
    </article>)}</div>{data?.offers.length===0&&<Empty>No services are available for purchase yet.</Empty>}</>;
}
export function Legal() {
  const {data,error}=useLoad("/public/terms");
  return <><h1>Terms & privacy</h1>{error&&<ErrorBlock error={error}/>}
    {data?.terms.map((t:Row)=><Panel key={t.id} title={label(t.kind)}><small>{t.version}</small><p>{t.content_md}</p></Panel>)}</>;
}
export function NewOrder() {
  const {data,error}=useLoad("/catalog"),refs=useLoad("/me/reference-samples");
  const [lines,setLines]=useState<Row[]>([]);
  const [selected,setSelected]=useState("");
  useEffect(()=>setSelected(new URLSearchParams(location.search).get("offer")??""),[]);
  const offer=data?.offers.find((x:Row)=>x.offer_id===selected);
  return <><h1>New inspection</h1><p className="muted">Add each service and quantity, then request a versioned quote.</p>
    {error&&<ErrorBlock error={error}/>}
    <Panel title="Service selection">
      <Form label="Add service" run={async f=>{
        if(!offer)throw new Error("Choose a service.");
        const quantity=Number(f.get("quantity"));
        if(quantity<offer.rules.minimum||quantity>(offer.service==="inspection"?300:offer.rules.maximum))throw new Error("Choose a quantity within the offer range.");
        setLines(x=>[...x,{category_id:offer.category_id,offer_id:offer.offer_id,quantity,title:offer.title.en,
          options:offer.service==="reference_match"?{reference_id:text(f,"reference_id")}:{},
          attributes:{name:text(f,"item_name")}}]);
      }}>
        <label>Category and service<select value={selected} onChange={e=>setSelected(e.target.value)} required><option value="">Choose a service</option>
          {data?.offers.map((o:Row)=><option key={o.offer_id} value={o.offer_id}>{o.category.en} · {o.title.en}</option>)}</select></label>
        {offer&&<Field key={offer.offer_id} label="Actual number of items" name="quantity" type="number" min={offer.rules.minimum} max={offer.service==="inspection"?300:offer.rules.maximum} value={offer.rules.minimum}/>}
        <Field label="Product name or style" name="item_name"/>
        {offer?.service==="reference_match"&&<Select name="reference_id" label="Active reference sample" choices={(refs.data?.items??[]).filter((r:Row)=>r.state==="active").map((r:Row)=>({id:r.reference_id,label:r.item_id+" · "+stamp(r.expires_at)}))}/>}
      </Form>
      {lines.length>0&&<><Table headers={["Service","Quantity",""]} rows={lines.map((l,i)=>[l.title,l.quantity,<button type="button" onClick={()=>setLines(xs=>xs.filter((_,n)=>n!==i))}>Remove</button>])}/>
      <Action primary run={async()=>{const r=await request("/orders","POST",{lines:lines.map(({title,...l})=>l)});location.assign("/orders/"+r.public_no);}}>Save draft and continue</Action></>}
    </Panel></>;
}
export function OrderView({number}:{number:string}) {
  const lookup=useLoad("/orders/by-number/"+number);
  const id=lookup.data?.id;
  const detail=useLoad(id?"/orders/"+id:null),terms=useLoad("/public/terms");
  const [calculatedQuote,setQuote]=useState<Row>();
  const o=detail.data;
  const quote=o?.manual_quote?.id?o.manual_quote:calculatedQuote;
  return <><h1>{number}</h1>{(lookup.error||detail.error)&&<ErrorBlock error={lookup.error||detail.error}/>}
    {o&&<><p><Tag>{label(o.state)}</Tag></p><Panel title="Inspection scope">
      <Table headers={["Service","Position","Warehouse item","Custody"]} rows={o.items.map((i:Row)=>[i.title.en,i.position??i.quantity,i.code??"Awaiting assignment",i.custody_state??"—"])}/>
      {o.report_version&&<Link className="button primary" href={"/orders/"+number+"/report"}>Open inspection report</Link>}
      {["draft","awaiting_payment"].includes(o.state)&&<div className="actions"><Action primary run={async()=>setQuote(await request("/orders/"+id+"/quotes","POST",{revision:o.revision}))}>Calculate quote</Action><Link href="/account/billing">Open billing</Link></div>}
      {o.state==="draft"&&<details className="card"><summary>Need a manual quote?</summary>
        {o.manual_quote?<p>Quote request · {o.manual_quote.state}</p>:<Form label="Request manual quote" run={async f=>{
          await request("/orders/"+id+"/manual-quote-request","POST",{revision:o.revision,reason:text(f,"reason")});detail.reload();
        }}><Field label="Describe your requirements" name="reason"/></Form>}
      </details>}
      {quote&&<><hr className="divider"/><h3>{usd(quote.amount_cents)} · expires {stamp(quote.expires_at)}</h3>
        <Table headers={["Quantity","Line amount","Business days"]} rows={quote.line_snapshot.map((l:Row)=>[l.quantity,usd(l.amount_cents),l.business_days])}/>
        <Form label={quote.amount_cents===0?"Accept no-charge quote":"Accept quote and pay"} run={async f=>{
          const acknowledgements=Object.fromEntries(Object.keys(acknowledged).map(k=>[k,checked(f,k)]));
          const accepted=await request("/orders/"+id+"/submit","POST",{revision:o.revision,quote_id:quote.id,
            terms_version_ids:terms.data?.terms.map((t:Row)=>t.id)??[],acknowledgements});
          await goCheckout(accepted.charge.charge_item_id,quote.revision);
        }}>
          <Link href="/legal" target="_blank">Read the current terms and notices</Link>
          {Object.entries(acknowledged).map(([k,v])=><label key={k} className="check"><input required type="checkbox" name={k}/>{v}</label>)}
        </Form></>}
    </Panel>
    {!["closed","cancelled","report_ready","action_pending"].includes(o.state)&&<Panel title="Order changes"><Action run={async()=>{
      if(!window.confirm("Cancel this inspection? Warehouse items remain available for disposition."))return;
      await request("/orders/"+id+"/cancel","POST",{revision:o.revision});detail.reload();
    }}>Cancel inspection</Action></Panel>}
    </>}
  </>;
}
async function goCheckout(id:string,revision:number) {
  const c=await request("/charges/"+id+"/checkout","POST",{quote_revision:revision});
  if(c.checkout_url)location.assign(c.checkout_url);
  else location.assign("/account/billing");
}
export function DemoCheckout({id}:{id:string}) {
  const {data}=useLoad("/auth/providers");
  return <div className="narrow panel"><h1>Development checkout</h1>
    {data?.demo?<><p>Confirm a simulated transaction for the local workflow.</p>
      <Action primary run={async()=>{await request("/checkout/demo/"+id,"POST",{});location.assign("/account/billing");}}>Confirm test payment</Action></>:<p>Checkout unavailable.</p>}
  </div>;
}
export function ReportView({number}:{number:string}) {
  const l=useLoad("/orders/by-number/"+number),id=l.data?.id;
  const r=useLoad(id?"/orders/"+id+"/report":null);
  return <><p className="eyebrow">INSPECTION EVIDENCE</p><h1>{r.data?.snapshot.report_no??"Inspection report"}</h1>
    {(l.error||r.error)&&<ErrorBlock error={l.error||r.error}/>}
    {r.data&&<><div className="actions"><Tag>Version {r.data.version}</Tag><Action run={async()=>{
      const {url}=await request("/orders/"+id+"/report/versions/"+r.data?.version+"/pdf");
      location.assign(url);
    }}>Download PDF</Action></div>
      {r.data.snapshot.sections.map((s:Row)=><Panel key={s.task_id} title={s.title}>
        <ReportSection results={s.results} grouped={["compare","reference_match"].includes(s.service)}/>
      </Panel>)}</>}
  </>;
}
function ReportSection({results,grouped}:{results:Row[];grouped:boolean}) {
  const result=(x:Row)=>[x.typed_value!=null?String(x.typed_value):label(x.status.toLowerCase()),x.unit,x.reason].filter(Boolean).join(" · ");
  const evidence=(x:Row)=>x.evidence_ids.map((m:string)=><a key={m} href={"/api/v1/media/"+m} target="_blank" rel="noreferrer">
    <img className="thumb" src={"/api/v1/media/"+m} alt={x.label+" evidence"}/></a>);
  if(!grouped) return <Table headers={["Item","Check","Result","Method","Evidence"]}
    rows={results.map(x=>[x.item,x.label,result(x),x.method,evidence(x)])}/>;
  const items=[...new Set(results.map(x=>String(x.item)))];
  const checks=new Map<string,Row>();
  for(const x of results) checks.set(x.item_key,x);
  return <Table headers={["Check",...items]} rows={[...checks.values()].map(check=>[
    <div>{check.label}<small className="muted"><br/>{check.method}</small></div>,
    ...items.map(item=>{
      const x=results.find(r=>r.item===item&&r.item_key===check.item_key);
      return x?<div>{result(x)}<div>{evidence(x)}</div></div>:"—";
    })
  ])}/>;
}
export function TrackView({kind,id}:{kind:"parcels"|"shipments";id:string}) {
  const path=kind==="parcels"?"/me/parcels/":"/shipments/";
  const {data,error,reload}=useLoad(path+id+"/tracking?locale=en");
  const canVerify=kind==="parcels"&&data?.allowed_actions.includes("verify_tracking");
  const verificationPath=path+id+"/tracking-verification";
  const verification=useLoad(canVerify?verificationPath:null),carriers=useLoad(canVerify?"/carriers":null);
  useEffect(()=>{const timer=setInterval(reload,60000);return ()=>clearInterval(timer);},[reload]);
  return <><h1>Tracking details</h1>{error&&<ErrorBlock error={error}/>}
    {data&&<Panel title={data.carrier??"Carrier pending"}><p className="code">{data.tracking_no}</p>
      <div className="actions"><Tag>{label(data.transport_state)}</Tag><Tag>{label(data.sync_state)}</Tag>
      {data.warehouse_state&&<Tag>Warehouse · {label(data.warehouse_state)}</Tag>}<button onClick={reload}>Refresh status</button></div>
      {canVerify&&verification.data&&<Form label="Verify carrier tracking" run={async f=>{
        const phone=text(f,"phone");
        await request(verificationPath,"POST",{revision:verification.data?.revision,carrier_code:verification.data?.carrier_code??text(f,"carrier_code"),...(phone?{phone}:{})});
        verification.reload();reload();
      }}>
        {!verification.data.carrier_code&&<Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>}
        <Field name="phone" label="Phone used on this shipping label, if required by the carrier" required={false} type="tel"/>
      </Form>}
      <p className="muted small">Carrier data updated {stamp(data.last_success_at)}</p>
      {data.events.length?<ol className="timeline">{data.events.map((e:Row)=><li key={e.id}><small>{stamp(e.occurred_at)}</small><br/>{e.text}</li>)}</ol>:<Empty>English carrier events will appear when verified tracking data is available.</Empty>}
    </Panel>}
  </>;
}
export function CustomerDesk({path}:{path:string}) {
  const {data,error,reload}=useLoad("/me/desk"),carriers=useLoad("/carriers"),terms=useLoad("/public/terms");
  const [batchIds,setBatchIds]=useState<string[]>([]);
  const [action,setAction]=useState("return_to_seller");
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>Loading your account…</p>;
  const addr=data.profile.warehouse_address;
  const isHome=path==="/account",isItems=path==="/items",isParcels=path==="/parcels",isBills=path==="/account/billing",isReports=path==="/reports",isOrders=path==="/orders",isHelp=path==="/support";
  return <>
    {isHome&&<><h1>Your workspace</h1><Panel title="Receiving address">
      <p><Tag>Personal receiving code</Tag> <strong className="code">{data.profile.receiving_code}</strong></p>
      {addr?<><p>{addr.recipient} · {addr.phone}<br/>{addr.address_zh}<br/>{addr.address_en}</p>
        <Action run={()=>navigator.clipboard.writeText([addr.recipient,addr.phone,addr.address_zh].join("\n"))}>Copy Chinese shipping address</Action></>:<Empty>The warehouse address is awaiting configuration.</Empty>}
    </Panel><Panel title="Recent updates">{data.notices.length?<Table headers={["Update","Received"]} rows={data.notices.map((x:Row)=>[x.template.replaceAll("."," · "),stamp(x.created_at)])}/>:<Empty>No updates yet.</Empty>}</Panel></>}
    {(isHome||isOrders)&&<Panel title="Inspection orders"><div className="actions"><Link className="button primary" href="/orders/new">New inspection</Link></div>
      {data.orders.length?<Table headers={["Order","Status","Quote","Created"]} rows={data.orders.map((o:Row)=>[
        <Link href={"/orders/"+o.public_no}>{o.public_no}</Link>,<Tag>{label(o.state)}</Tag>,o.price_cents===null?"—":usd(o.price_cents),stamp(o.created_at)
      ])}/>:<Empty>Your orders will appear here.</Empty>}</Panel>}
    {isParcels&&<><h1>Parcels</h1><Panel title="Register seller tracking">
      {addr?<Form label="Add inbound parcel" run={async f=>{
        const carrier=text(f,"carrier"),order=text(f,"order");
        await request("/me/parcels","POST",{address_id:addr.id,tracking_no:text(f,"tracking"),...(carrier?{carrier_code:carrier}:{}),order_ids:order?[order]:[]});reload();
      }}><Field name="tracking" label="Seller’s tracking number"/><Select name="carrier" label="Carrier" required={false} choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>
      <Select name="order" label="Associate an order (optional)" required={false} choices={data.orders.map((o:Row)=>({id:o.id,label:o.public_no}))}/></Form>:<Empty>The warehouse address is awaiting configuration.</Empty>}
      <Table headers={["Inbound tracking","Warehouse status","Carrier status"]} rows={data.advices.map((a:Row)=>[
        <Link href={"/parcels/"+a.id}>{a.tracking_norm}</Link>,label(a.warehouse_state??"awaiting_warehouse"),label(a.transport_state)
      ])}/>
    </Panel><Panel title="Claim a parcel already at the warehouse">
      <p className="muted">Upload the seller’s shipment proof. The warehouse reviews ownership before parcel details become visible.</p>
      <Form label="Request ownership review" run={async f=>{await request("/me/intake-claims","POST",f);reload();}}>
        <Field name="tracking_no" label="Seller’s tracking number"/>
        <Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>
        <Photo label="Seller shipment proof"/>
      </Form>
      <Table headers={["Claim","Review status"]} rows={data.tickets.filter((t:Row)=>t.public_no.startsWith("CLAIM-")).map((t:Row)=>[t.public_no,t.decision??t.state])}/>
    </Panel><Panel title="Outbound parcels">
      <Table headers={["Tracking number","Destination type","Warehouse handover"]} rows={data.shipments.map((s:Row)=>[
        <Link href={"/shipments/"+s.id}>{s.tracking_norm}</Link>,label(s.action),stamp(s.shipped_at)
      ])}/>
    </Panel></>}
    {isItems&&<><h1>Warehouse items</h1><Panel title="Your items">
      <Table headers={["Item","Custody","Storage through","Instructions"]} rows={data.items.map((w:Row)=>[
        w.code,label(w.custody_state),stamp(w.storage_until),w.instructions.map((i:string)=><label key={i} className="small"><input type="checkbox" checked={batchIds.includes(i)} onChange={e=>setBatchIds(xs=>e.target.checked?[...xs,i]:xs.filter(x=>x!==i))}/> Select for shipping</label>)
      ])}/>
      {!data.items.length&&<Empty>Items will appear after physical warehouse intake and ownership verification.</Empty>}
      {!!batchIds.length&&<Action primary run={async()=>{const b=await request("/dispatch-batches","POST",{disposition_ids:batchIds});await request("/dispatch-batches/"+b.batch_id+"/confirm","POST",{revision:b.revision});setBatchIds([]);reload();}}>Confirm selected items for quoting</Action>}
      {data.batches.map((b:Row)=><div key={b.id} className="notice"><Action run={async()=>{await request("/dispatch-batches/"+b.id+"/confirm","POST",{revision:b.revision});reload();}}>Confirm draft batch</Action></div>)}
    </Panel><Panel title="Request handling for an item">
      <Form label="Save handling instruction" run={async f=>{
        const id=text(f,"item"),termsId=terms.data?.terms.find((t:Row)=>t.kind==="terms")?.id;
        if(!checked(f,"agree"))throw new Error("Confirm the selected instruction.");
        const destination=action==="retain"?undefined:{recipient:text(f,"recipient"),phone:text(f,"phone"),address:text(f,"address"),
          ...(action==="to_forwarder"?{member_code:text(f,"member_code")}:{})};
        await request("/me/items/"+id+"/dispositions","POST",{action,terms_version_id:termsId,...(destination?{destination}:{}),
          ...(action==="return_to_seller"?{return_info:{requested_from_seller:true,customer_pays_shipping:true}}:{})});
        reload();
      }}>
        <Select name="item" label="Item" choices={data.items.filter((w:Row)=>["stored","received"].includes(w.custody_state)).map((w:Row)=>({id:w.item_id,label:w.code}))}/>
        <label>Requested action<select value={action} onChange={e=>setAction(e.target.value)}>
          <option value="return_to_seller">Return to seller</option><option value="to_forwarder">Send to freight forwarder</option>
          <option value="to_domestic_address">Send to a domestic address</option><option value="retain">Extend storage</option></select></label>
        {action!=="retain"&&<><Field name="recipient" label="Recipient"/><Field name="phone" label="Destination phone"/>
          <label>{action==="return_to_seller"?"Return address supplied by your seller":"Destination address"}<textarea name="address" required/></label></>}
        {action==="to_forwarder"&&<Field name="member_code" label="Forwarder member code"/>}
        <label className="check"><input name="agree" required type="checkbox"/>{action==="return_to_seller"?"I have arranged the return with my seller and will pay the return shipping fee.":"I authorize this request subject to the current terms and quote."}</label>
      </Form>
    </Panel></>}
    {isBills&&<><h1>Billing</h1><Panel title="Quotes awaiting your approval">
      <Table headers={["Purpose","Amount","Expires",""]} rows={data.quotes.map((q:Row)=>[label(q.purpose),usd(q.amount_cents),stamp(q.expires_at),
        <Action primary run={async()=>{const c=await request("/quotes/"+q.id+"/accept","POST",{revision:q.revision});await goCheckout(c.charge_item_id,q.revision);}}>Accept and pay</Action>
      ])}/>{!data.quotes.length&&<Empty>No new quotes.</Empty>}
    </Panel><Panel title="Charges and refunds">
      <Table headers={["Purpose","Charge","Refunded","State",""]} rows={data.bills.map((b:Row)=>[label(b.purpose),usd(b.amount_cents),usd(b.refunded_cents),<Tag>{label(b.state)}</Tag>,
        b.state==="open"?<Action run={()=>goCheckout(b.charge_item_id,b.quote_revision)}>Pay</Action>:null
      ])}/>
    </Panel></>}
    {isReports&&<><h1>Reports</h1><Panel title="Published inspections"><Table headers={["Report","Order","Version"]} rows={data.reports.map((r:Row)=>[
      <Link href={"/orders/"+r.order_no+"/report"}>{r.public_no}</Link>,r.order_no,r.published_version])}/></Panel></>}
    {isHelp&&<><h1>Support</h1><Panel title="Open a case"><Form label="Send case" run={async f=>{await request("/me/cases","POST",{subject:text(f,"subject"),message:text(f,"message")});reload();}}>
      <Field name="subject" label="Subject"/><label>Message<textarea name="message" required/></label>
      </Form><Table headers={["Case","Subject","Status"]} rows={data.tickets.map((t:Row)=>[t.public_no,t.subject,label(t.state)])}/></Panel></>}
  </>;
}
