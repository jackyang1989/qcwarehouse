"use client";

import Link from "next/link";
import { ScopeReview } from "./scope-review";
import { ReportShares } from "./report-sharing";
import { RecentUpdates } from "./notifications";
import { PlatformIcon } from "./chrome";
import { CategoryTiles } from "./category-coverage";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { customerDestination, legalPages, orderSections, type OrderSection, servicePages } from "../packages/core/portal-routes";
import { Action, checked, Empty, ErrorBlock, Field, Form, Panel, Photo, request, RequestError, Select, stamp, Table, Tabs, Tag, text, useLoad, usd, type Row } from "./ui";

const acknowledged={scope_notice:"I understand which checks are included.",samples_not_batch:"These samples do not represent an entire production batch.",seller_refund_is_mine:"I handle any refund request directly with my seller.",no_certification:"The report is an inspection record and does not provide certification.",restricted_items:"My items comply with the restricted items policy."};
const states:Record<string,string>={checked_in:"Received at warehouse",draft:"Draft",awaiting_payment:"Awaiting payment",awaiting_samples:"Awaiting items",queued:"Ready for inspection",inspecting:"Inspection underway",qa_review:"Under review",report_ready:"Report ready",action_pending:"Awaiting disposition",cancelled:"Cancelled",closed:"Closed",on_hold:"On hold"};
const label=(state:string)=>states[state]??state.replaceAll("_"," ");
const orderNext:Record<string,string>={
  draft:"Review the inspection scope and calculate a quote.",
  awaiting_payment:"Review or resume the inspection payment.",
  awaiting_samples:"Add the seller’s tracking number. Inspection starts after all commissioned items are received and identified.",
  queued:"The items are ready and the order is waiting for an inspector.",
  inspecting:"The warehouse is checking the commissioned items.",
  qa_review:"The report is undergoing independent review.",
  report_ready:"Review the published report, then choose what happens to each item.",
  action_pending:"Review your warehouse items and outstanding handling instructions.",
  on_hold:"Review any open support cases for this order.",
  cancelled:"Inspection has ended. Any items still held by the warehouse remain available for handling instructions.",
};

const serviceDetails={
  inspection:{title:"Product inspection",description:"Commission a check for each item you send, from one piece to a larger group. The selected template determines the checks and evidence."},
  compare:{title:"Side-by-side sample comparison",description:"Compare two or three items of the same kind against the selected checks. Each item keeps its own results and evidence."},
  reference_match:{title:"Reference sample comparison",description:"Compare a new item with an eligible reference sample already stored in your account. The reference must be available for the selected service."},
};
export function Catalog({path}:{path:string}) {
  const {data,error,reload}=useLoad("/catalog");
  const [category,setCategory]=useState<string>();
  const requestedCategory=useSearchParams().get("category")??"";
  const service=servicePages[path as keyof typeof servicePages];
  const info=service?serviceDetails[service]:null;
  const offers:Row[]=(data?.offers??[]).filter((offer:Row)=>!service||offer.service===service);
  const categories=new Map<string,string>(offers.map(o=>[o.category_id,o.category.en]));
  const activeCategory=category??requestedCategory;
  const selected=categories.has(activeCategory)?activeCategory:"";
  const isCategories=path==="/categories",isPricing=path==="/pricing";
  return <><section className="page-head public-masthead"><p className="eyebrow">{isCategories?"Category coverage":isPricing?"Pricing":"Service catalogue"}</p>
    <h1>{info?.title??(isCategories?"Product categories":isPricing?"Inspection pricing":"Inspection services")}</h1>
    <p className="muted">{info?.description??"Select a product category to see the available services and quantity ranges."}</p>
    {info&&<div className="actions"><Link className="button" href="/report-guide">Explore Sample Report →</Link></div>}</section>
    {isCategories&&<div className="catalog-coverage"><CategoryTiles offers={offers.map(offer=>({category_id:offer.category_id,category:offer.category}))}/></div>}
    {path==="/catalog"&&<div className="land-services catalog-coverage">
      {Object.entries(servicePages).map(([href,code])=><Link className="land-svc" href={href} key={href}><span className="symbol"><PlatformIcon name={code==="compare"?"compare":code==="inspection"?"inspection":"packages"}/></span>
        <h3>{serviceDetails[code].title}</h3><p>{serviceDetails[code].description}</p><span className="go">View service →</span></Link>)}
    </div>}
    <Tabs path={path} links={[["/catalog","All services"],...Object.entries(servicePages).map(([href,code]):[string,string]=>[href,serviceDetails[code].title])]}/>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Try again</button></>}
    {!data&&!error&&<p role="status">Loading services…</p>}
    {categories.size>0&&<div className="catalog-filter"><h2>Product category</h2><div className="actions" aria-label="Product categories">{[...categories].map(([id,name])=>
      <button type="button" className={selected===id?"primary":""} aria-pressed={selected===id} key={id} onClick={()=>setCategory(id)}>{name}</button>)}</div></div>}
    {categories.size>0&&!selected&&<p className="muted">Select a category to see available checks and pricing.</p>}
    {selected&&<section className="catalog-offers" aria-label={categories.get(selected)+" offers"}>
      {offers.filter(o=>o.category_id===selected).map((o:Row)=><article className="catalog-offer" key={o.offer_id}>
        <div><p className="eyebrow">{o.sku_code}</p><h2>{o.title.en}</h2>
          <p>{o.rules.minimum===o.rules.maximum?o.rules.minimum:o.rules.minimum+"–"+o.rules.maximum} items · {o.rules.business_days} business days after all items are received and identified</p>
          {o.rules.demo&&<p className="muted small">Development catalogue and prices</p>}
        </div>
        <div className="catalog-price"><div><strong>{usd(o.rules.unit_cents??o.rules.package_cents)}</strong><small>{o.rules.unit_cents!=null?"per item":"per group"}</small></div>
          <Link className="button primary" href={"/orders/new?offer="+o.offer_id}>Choose service</Link>
        </div>
      </article>)}
    </section>}
    {data&&offers.length===0&&<Empty>No matching services are available for purchase yet.</Empty>}
    <div className="catalog-support"><div><h2>Need a different scope?</h2><p className="muted">Tell us the category, quantity and checks you need.</p></div><Link className="button" href="/contact">Request a custom inspection →</Link></div></>;
}
const legalTitles:Record<string,string>={terms:"Terms of service",privacy:"Privacy notice",restricted_items:"Restricted items",report_notice:"Report notice"};
function PolicyLinks({policies}:{policies:Row[]}) {
  return <ul>{policies.map(t=>{
    const page=Object.entries(legalPages).find(([,kind])=>kind===t.kind)?.[0];
    return page&&<li key={t.kind}><Link href={page+"?"+new URLSearchParams({version:t.version})}
      target="_blank" rel="noreferrer">{legalTitles[t.kind]} · {t.version} <span className="muted">(new tab)</span></Link></li>;
  })}</ul>;
}
export function Legal({path}:{path:string}) {
  const kind=legalPages[path as keyof typeof legalPages];
  const query=useSearchParams();
  const versions=query.getAll("version");
  const suffix=versions.length?"?"+new URLSearchParams(versions.map(v=>["version",v])):"";
  const {data,error,reload}=useLoad("/public/terms"+(kind?"/"+kind+suffix:""));
  const terms:Row[]=data?.terms??[];
  return <><div className="page-head public-masthead"><p className="eyebrow">Policies</p><h1>{kind?legalTitles[kind]:"Terms & privacy"}</h1></div>
    <Tabs path={path} links={Object.entries(legalPages).map(([href,key]):[string,string]=>[href,legalTitles[key]])}/>
    {kind&&versions.length>0&&<p><Link href={path}>View the current version</Link></p>}
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Try again</button></>}
    {!data&&!error&&<p role="status">Loading policies…</p>}
    {data&&terms.length===0&&<Empty>No current version is available.</Empty>}
    {terms.map(t=><Panel key={t.id} title={legalTitles[t.kind]}>
      <p className="muted">Version {t.version} · Effective <time dateTime={t.effective_at}>{t.effective_at.slice(0,10)} UTC</time></p>
      <div className="policy-content">{t.content_md}</div>
    </Panel>)}</>;
}
const customerSteps=[
  ["Get your receiving address","Create an account and copy the shared warehouse address with your personal receiving code."],
  ["Buy directly from the seller","Use the warehouse address at the seller’s checkout. You pay the seller and keep their purchase record."],
  ["Register the waybill and commission your checks","Add the original seller tracking number. Choose an available service for your category. Inspection timing starts when all commissioned items have been received and identified."],
  ["Review your report","Read the recorded checks and evidence for the items in your inspection."],
  ["Choose where each item goes","Provide a forwarding address or the seller’s approved return address. You arrange the seller return and pay the quoted shipping. The warehouse records the actual outbound tracking number after handover."],
];
export function HowItWorks() {
  return <><div className="page-head public-masthead"><p className="eyebrow">From purchase to dispatch</p><h1>How it works</h1><p className="muted">Follow your items from the seller’s shipment through inspection and warehouse handling.</p></div>
    <ol className="process-detail">{customerSteps.map(([title,body],index)=><li className="panel" key={title}><span className="symbol">{String(index+1).padStart(2,"0")}</span><div><h2>{title}</h2><p className="muted">{body}</p></div></li>)}</ol>
    <div className="actions"><Link className="button primary" href="/catalog">Find an inspection service</Link><Link href="/faq">Read frequently asked questions</Link></div></>;
}
const wizardCategoryCatalog=[
  {key:"apparel",name:"Apparel",icon:"♧",fallbackState:"ACTIVE"},
  {key:"footwear",name:"Footwear",icon:"◈",fallbackState:"PLANNED"},
  {key:"bags",name:"Bags & Accessories",icon:"▢",fallbackState:"PLANNED"},
  {key:"home",name:"Home & Lifestyle",icon:"⌂",fallbackState:"PLANNED"},
  {key:"electronics",name:"Electronics",icon:"▤",fallbackState:"RESTRICTED"},
] as const;

const wizardServiceCards=[
  {service:"compare",title:"Sample Comparison",desc:"Compare supplier samples under the same criteria.",icon:"≍",badge:"Recommended for supplier selection"},
  {service:"inspection",title:"Product Inspection",desc:"Check individual physical items, measurements and visible defects.",icon:"⌕",badge:"For one or many items"},
  {service:"reference_match",title:"Golden Sample Matching",desc:"Compare new items against a customer-approved reference.",icon:"▧",badge:"Consistency against reference"},
] as const;

const wizardCheckDefs=[
  ["visual","Visual appearance & packaging","Document visible condition of sample and packaging"],
  ["measure","Dimensions & size measurements","Tape-measure photos with units and method"],
  ["seams","Seams & visible workmanship","Stitching, loose thread and observable finishing"],
  ["labels","Tags & accessories","Check attached labels and included parts"],
  ["closeups","Additional detail photographs","Optional evidence capture, subject to scope"],
] as const;

export function NewOrder() {
  const {data,error}=useLoad("/catalog");
  const refs=useLoad("/me/reference-samples");
  const receiving=useLoad("/me/receiving-address");
  const terms=useLoad("/public/terms");
  const providers=useLoad("/auth/providers");

  const [step,setStep]=useState(0);
  const [categoryKey,setCategoryKey]=useState<string>("apparel");
  const [serviceKind,setServiceKind]=useState<"inspection"|"compare"|"reference_match">("inspection");
  const [selectedOfferId,setSelectedOfferId]=useState("");
  const [templateVariant,setTemplateVariant]=useState("basic");
  const [qty,setQty]=useState(3);
  const [itemName,setItemName]=useState("Heavyweight Cotton Hoodie");
  const [supplierRef,setSupplierRef]=useState("SUP-CN-08");
  const [baseSku,setBaseSku]=useState("SKU-101");
  const [baseColor,setBaseColor]=useState("Black");
  const [baseSize,setBaseSize]=useState("M");
  const [productLink,setProductLink]=useState("");
  const [toleranceMm,setToleranceMm]=useState("15");
  const [referenceId,setReferenceId]=useState("");
  const [sizeMismatchConfirmed,setSizeMismatchConfirmed]=useState(false);
  const [itemRows,setItemRows]=useState<{sku:string;size:string;color:string}[]>([]);
  const [showAllItems,setShowAllItems]=useState(false);
  const [selectedChecks,setSelectedChecks]=useState<string[]>(["visual","measure","seams","labels"]);
  const [notes,setNotes]=useState("");
  const [attachmentId,setAttachmentId]=useState<string>();
  const [attachmentName,setAttachmentName]=useState<string>();
  const [extraLines,setExtraLines]=useState<Row[]>([]);
  const [consents,setConsents]=useState<Record<string,boolean>>({
    scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true,
  });
  const [draftOrder,setDraftOrder]=useState<Row>();
  const [serverQuote,setServerQuote]=useState<Row>();
  const [submittedCharge,setSubmittedCharge]=useState<Row>();
  const [busyMessage,setBusyMessage]=useState("");
  const [wizardError,setWizardError]=useState("");

  const offers:Row[]=data?.offers??[];

  useEffect(()=>{
    const requestedOffer=new URLSearchParams(location.search).get("offer")??"";
    if(requestedOffer && offers.length>0) {
      const matched=offers.find(x=>x.offer_id===requestedOffer);
      if(matched) {
        setSelectedOfferId(matched.offer_id);
        setServiceKind(matched.service);
        setQty(matched.service==="compare"?matched.rules.minimum:Math.max(1,matched.rules.minimum));
      }
    }
  },[offers.length]);

  useEffect(()=>{
    window.dispatchEvent(new CustomEvent("qcw:wizard-step",{detail:step}));
  },[step]);

  useEffect(()=>{
    function onGo(e:Event) {
      const target=(e as CustomEvent<number>).detail;
      if(typeof target==="number" && target>=0 && target<=5) setStep(target);
    }
    window.addEventListener("qcw:wizard-go",onGo);
    return ()=>window.removeEventListener("qcw:wizard-go",onGo);
  },[]);

  // Match prototype category key to real backend category_id
  function resolveCategoryId(key:string):string|undefined {
    const match=offers.find(o=>{
      const en=String(o.category?.en??"").toLowerCase();
      return key==="apparel"?en.includes("apparel"):
        key==="footwear"?en.includes("footwear"):
        key==="bags"?en.includes("bag"):
        key==="home"?en.includes("home"):
        key==="electronics"?en.includes("electronic"):false;
    });
    return match?.category_id;
  }

  const activeCategoryId=resolveCategoryId(categoryKey)??offers[0]?.category_id??"";
  const categoryOffers=offers.filter(o=>o.category_id===activeCategoryId);
  const serviceOffers=categoryOffers.filter(o=>o.service===serviceKind);

  // Pick the active offer for the chosen service & quantity
  const activeOffer=serviceOffers.find(o=>o.offer_id===selectedOfferId)
    ?? (serviceKind==="compare"?(serviceOffers.find(o=>qty>=o.rules.minimum&&qty<=o.rules.maximum)??serviceOffers[0]):serviceOffers[0])
    ?? categoryOffers[0];

  const minQty=activeOffer?.rules.minimum??(serviceKind==="compare"?2:1);
  const maxQty=activeOffer?(activeOffer.service==="inspection"?300:activeOffer.rules.maximum):(serviceKind==="compare"?3:60);
  const clampedQty=Math.max(minQty,Math.min(maxQty,Number(qty)||minQty));

  function updateItemRow(index:number,field:"sku"|"size"|"color",value:string) {
    setItemRows(prev=>{
      const next=[...prev];
      while(next.length<clampedQty) {
        const idx=next.length;
        next.push({sku:`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`,size:baseSize||"M",color:baseColor||"Black"});
      }
      next[index]={...(next[index]??{sku:baseSku,size:baseSize,color:baseColor}),[field]:value};
      return next;
    });
  }

  function buildCurrentLine():Row|null {
    if(!activeOffer) return null;
    const items=Array.from({length:clampedQty},(_,idx)=>{
      const custom=itemRows[idx];
      const rowSku=custom?.sku?.trim()||`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
      const rowSize=custom?.size?.trim()||baseSize.trim();
      const rowColor=custom?.color?.trim()||baseColor.trim();
      return {
        position:idx+1,
        sample_code:rowSku.slice(0,40),
        name:(itemName.trim()||activeOffer.title.en).slice(0,120),
        ...(rowSize?{size_label:rowSize}:{}),
        ...(rowColor?{color_declared:rowColor}:{}),
        ...(toleranceMm&&Number(toleranceMm)>0?{tolerances:{dimension_mm:Number(toleranceMm)}}:{}),
        ...(attachmentId?{attachment_ids:[attachmentId]}:{}),
      };
    });
    const distinctSizes=new Set(items.map(i=>i.size_label).filter(Boolean));
    return {
      category_id:activeOffer.category_id,
      offer_id:activeOffer.offer_id,
      quantity:clampedQty,
      title:activeOffer.title.en,
      options:{
        ...(activeOffer.service==="reference_match"&&referenceId?{reference_id:referenceId}:{}),
        ...(sizeMismatchConfirmed||distinctSizes.size>1?{size_mismatch_confirmed:true}:{}),
      },
      attributes:{
        name:(itemName.trim()||activeOffer.title.en).slice(0,120),
        ...(supplierRef.trim()?{supplier_ref:supplierRef.trim()}:{}),
        ...(productLink.trim()?{product_url:productLink.trim()}:{}),
        ...(baseSize.trim()?{size_label:baseSize.trim()}:{}),
        ...(baseColor.trim()?{color_declared:baseColor.trim()}:{}),
        ...(toleranceMm&&Number(toleranceMm)>0?{tolerances:{dimension_mm:Number(toleranceMm)}}:{}),
        ...(attachmentId?{attachment_ids:[attachmentId]}:{}),
      },
      items,
    };
  }

  const currentLine=buildCurrentLine();
  const allLines=extraLines.length>0?(currentLine?[...extraLines,currentLine]:extraLines):(currentLine?[currentLine]:[]);
  const totalItems=allLines.reduce((sum,l)=>sum+(Number(l.quantity)||0),0);

  // Live estimated fee from real catalog offer rules (overridden by serverQuote once calculated)
  const estimatedCents=allLines.reduce((sum,line)=>{
    const off=offers.find(o=>o.offer_id===line.offer_id);
    if(!off) return sum;
    if(off.rules.unit_cents!=null) return sum + off.rules.unit_cents * line.quantity;
    return sum + (off.rules.package_cents??0);
  },0);
  const displayCents=serverQuote?.amount_cents??estimatedCents;

  async function syncDraftAndQuote() {
    if(!allLines.length) throw new Error("Configure at least one inspection service.");
    setWizardError("");
    setBusyMessage("Saving draft & calculating official server quote…");
    try {
      const payloadLines=allLines.map(({title,...rest})=>rest);
      const combinedNotes=[
        notes.trim(),
        supplierRef.trim()?`Supplier: ${supplierRef.trim()}`:"",
        templateVariant!=="basic"?`Template: ${templateVariant}`:"",
      ].filter(Boolean).join(" | ").slice(0,500);
      let orderRecord:Row=draftOrder!;
      if(!draftOrder) {
        const created=await request("/orders","POST",{
          lines:payloadLines,
          ...(combinedNotes?{customer_notes:combinedNotes}:{}),
        });
        orderRecord=await request("/orders/"+created.order_id);
      } else if(draftOrder.state==="draft") {
        await request("/orders/"+draftOrder.id,"PATCH",{
          revision:draftOrder.revision,
          lines:payloadLines,
          ...(combinedNotes?{customer_notes:combinedNotes}:{}),
        });
        orderRecord=await request("/orders/"+draftOrder.id);
      }
      setDraftOrder(orderRecord);
      if(orderRecord.state==="draft") {
        const q=await request("/orders/"+orderRecord.id+"/quotes","POST",{revision:orderRecord.revision});
        setServerQuote(q);
      }
      return orderRecord;
    } catch(e) {
      const msg=e instanceof Error?e.message:"Could not calculate server quote.";
      setWizardError(msg);
      throw e;
    } finally {
      setBusyMessage("");
    }
  }

  async function goToNextStep() {
    setWizardError("");
    if(step===0) {
      if(!resolveCategoryId(categoryKey)) {
        setWizardError("Please choose an available product category (Apparel).");
        return;
      }
      setStep(1);
    } else if(step===1) {
      if(serviceKind==="reference_match" && !referenceId) {
        const firstActive=(refs.data?.items??[]).find((r:Row)=>r.state==="active"&&new Date(r.expires_at)>new Date());
        if(firstActive) setReferenceId(firstActive.reference_id);
      }
      setStep(2);
    } else if(step===2) {
      if(!itemName.trim()) {
        setWizardError("Please enter a product name or style.");
        return;
      }
      setStep(3);
    } else if(step===3) {
      setStep(4);
      if(!serverQuote) {
        try { await syncDraftAndQuote(); } catch { /* error shown in wizardError */ }
      }
    } else if(step===4) {
      const allChecked=Object.keys(acknowledged).every(k=>consents[k]);
      if(!allChecked) {
        setWizardError("Please confirm the inspection scope and terms disclosures before continuing to payment.");
        return;
      }
      if(!serverQuote || !draftOrder) {
        try { await syncDraftAndQuote(); } catch { return; }
      }
      setStep(5);
    }
  }

  async function submitAndSimulatePayment() {
    setWizardError("");
    setBusyMessage("Submitting order & confirming payment…");
    try {
      let ord:Row=draftOrder!;
      let quote:Row=serverQuote!;
      if(!draftOrder || !serverQuote) {
        ord=await syncDraftAndQuote();
        quote=await request("/orders/"+ord.id+"/quotes","POST",{revision:ord.revision});
        setServerQuote(quote);
      }
      const quoteRev=quote.revision;
      let chargeId=submittedCharge?.charge_item_id;
      if(ord.state==="draft") {
        const termIds=(terms.data?.terms??[]).map((t:Row)=>t.id);
        const accepted=await request("/orders/"+ord.id+"/submit","POST",{
          revision:ord.revision,
          quote_id:quote.id,
          terms_version_ids:termIds,
          acknowledgements:consents,
        });
        chargeId=accepted.charge.charge_item_id;
        setSubmittedCharge(accepted.charge);
        ord=await request("/orders/"+ord.id);
        setDraftOrder(ord);
      }
      if(chargeId) {
        const checkout=await request("/charges/"+chargeId+"/checkout","POST",{quote_revision:quoteRev});
        if(checkout.checkout_url) {
          const demoMatch=String(checkout.checkout_url).match(/\/checkout\/demo\/([a-f0-9-]{36})/i);
          if(demoMatch && providers.data?.demo) {
            await request("/checkout/demo/"+demoMatch[1],"POST",{});
            location.assign("/orders/"+ord.public_no);
            return;
          }
          location.assign(checkout.checkout_url);
          return;
        }
      }
      location.assign("/orders/"+ord.public_no);
    } catch(e) {
      setWizardError(e instanceof Error?e.message:"Payment submission failed.");
    } finally {
      setBusyMessage("");
    }
  }

  const stepLabels=["Select Inspection","Configure","Sample Details","Scope","Review","Payment"];
  const serviceLabel=serviceKind==="inspection"?"Product Inspection":serviceKind==="compare"?"Sample Comparison":"Reference Matching";
  const visibleRowLimit=Math.min(clampedQty,showAllItems?60:5);
  const activeRefs=(refs.data?.items??[]).filter((r:Row)=>r.state==="active"&&new Date(r.expires_at)>new Date());
  const allConsentsChecked=Object.keys(acknowledged).every(k=>consents[k]);

  return <>
    <div className="page-head">
      <div>
        <div className="eyebrow">CUSTOMER PORTAL</div>
        <h1>Create an Inspection</h1>
        <p>Choose a category, service, item list and evidence scope. Review before paying.</p>
      </div>
      <div className="head-actions">
        {draftOrder&&<Link className="button sm" href={"/orders/"+draftOrder.public_no}>Open Draft ({draftOrder.public_no})</Link>}
        <Link className="button sm" href="/orders">View My Orders</Link>
      </div>
    </div>

    {error&&<ErrorBlock error={error}/>}
    {wizardError&&<ErrorBlock error={wizardError}/>}
    {busyMessage&&<div className="notice" role="status">{busyMessage}</div>}

    <div className="wizard-shell">
      <div className="wizard-content">
        <div className="steps" role="navigation" aria-label="Inspection setup">
          {stepLabels.map((name,idx)=><button
            key={name}
            type="button"
            className={`step ${idx===step?"on":idx<step?"done":""}`}
            onClick={()=>{setWizardError("");setStep(idx);}}
          >
            <span className="n">{idx<step?"✓":idx+1}</span>
            <span>{name}</span>
          </button>)}
        </div>

        {step===0&&<>
          <Panel
            title="01   Product Category"
            subtitle="Category-specific checks and services are loaded automatically."
            badge={<Tag tone="green">Apparel · Active</Tag>}
          >
            <div className="wizard-categories" role="radiogroup" aria-label="Product Category">
              {wizardCategoryCatalog.map(cat=>{
                const catId=resolveCategoryId(cat.key);
                const isAvailable=Boolean(catId);
                const isSelected=categoryKey===cat.key;
                return <button
                  key={cat.key}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={!isAvailable}
                  className={`option-card ${isSelected?"selected":""} ${!isAvailable?"disabled":""}`}
                  onClick={()=>{
                    if(!isAvailable) return;
                    setCategoryKey(cat.key);
                    setServerQuote(undefined);
                  }}
                >
                  <span className="icon" aria-hidden="true">{cat.icon}</span>
                  <strong>{cat.name}</strong>
                  <p>{isAvailable?"Available now":cat.fallbackState==="PLANNED"?"Planned / not yet available":"Restricted"}</p>
                </button>;
              })}
            </div>
            <div className="wizard-note">
              Apparel is currently available. Other categories cannot be purchased until operational approval and documented checks are in place.
            </div>
          </Panel>

          <Panel
            title="02   Inspection Service"
            subtitle="Select one. Its checklist will follow your approved product category."
          >
            <div className="wizard-services" role="radiogroup" aria-label="Inspection Service">
              {wizardServiceCards.map(card=>{
                const matchingOffers=categoryOffers.filter(o=>o.service===card.service);
                const firstOffer=matchingOffers[0];
                const priceText=firstOffer
                  ?(firstOffer.rules.unit_cents!=null?`${usd(firstOffer.rules.unit_cents)} / item`:`${usd(firstOffer.rules.package_cents)} / set`)
                  :"Available";
                const isSelected=serviceKind===card.service;
                return <button
                  key={card.service}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`option-card ${isSelected?"selected":""}`}
                  onClick={()=>{
                    setServiceKind(card.service);
                    if(firstOffer) {
                      setSelectedOfferId(firstOffer.offer_id);
                      setQty(card.service==="compare"?Math.max(2,firstOffer.rules.minimum):card.service==="reference_match"?1:Math.max(1,qty));
                    }
                    setServerQuote(undefined);
                  }}
                >
                  <span className="icon" aria-hidden="true">{card.icon}</span>
                  <strong>{card.title}</strong>
                  <p>{card.desc}</p>
                  <span className="price-pill">{card.badge} · {priceText}</span>
                </button>;
              })}
            </div>
            <div className="wizard-note">
              Visual observations and measurements only where approved; laboratory certification and batch quality guarantees are not included.
            </div>
          </Panel>
        </>}

        {step===1&&<>
          <Panel
            title="03   Configure Your Service"
            subtitle="Choose the applicable approved inspection template and item count."
            badge={<Tag tone="green">Apparel · Available</Tag>}
          >
            <div className="fields">
              <div className="field">
                <label>Inspection template
                  <select value={templateVariant} onChange={e=>setTemplateVariant(e.target.value)}>
                    <option value="basic">Apparel Basic Visual v1 ({activeOffer?.title.en??"Standard"})</option>
                    <option value="tops">Tops &amp; Outerwear v1</option>
                    <option value="leggings">Trousers &amp; Leggings v1</option>
                    <option value="sports">Activewear &amp; Knitwear v1</option>
                  </select>
                </label>
              </div>
              <div className="field">
                <label>Items / samples
                  <input
                    type="number"
                    min={minQty}
                    max={maxQty}
                    value={clampedQty}
                    onChange={e=>{
                      const val=Math.max(minQty,Math.min(maxQty,Number(e.target.value)||minQty));
                      setQty(val);
                      if(serviceKind==="compare") {
                        const match=serviceOffers.find(o=>val>=o.rules.minimum&&val<=o.rules.maximum);
                        if(match) setSelectedOfferId(match.offer_id);
                      }
                      setServerQuote(undefined);
                    }}
                  />
                </label>
              </div>
            </div>

            {serviceOffers.length>1&&<div className="field" style={{marginTop:12}}>
              <label>Service package tier
                <select value={activeOffer?.offer_id??""} onChange={e=>{
                  const off=serviceOffers.find(o=>o.offer_id===e.target.value);
                  setSelectedOfferId(e.target.value);
                  if(off) setQty(Math.max(off.rules.minimum,Math.min(off.rules.maximum,clampedQty)));
                  setServerQuote(undefined);
                }}>
                  {serviceOffers.map(o=><option key={o.offer_id} value={o.offer_id}>
                    {o.title.en} ({o.sku_code} · {usd(o.rules.unit_cents??o.rules.package_cents)})
                  </option>)}
                </select>
              </label>
            </div>}

            {serviceKind==="reference_match"&&<div className="field" style={{marginTop:12}}>
              <label>Active reference sample
                <select value={referenceId} onChange={e=>setReferenceId(e.target.value)}>
                  <option value="">— Select an active reference sample —</option>
                  {activeRefs.map((r:Row)=><option key={r.reference_id} value={r.reference_id}>
                    {(r.code??r.item_id)} · Valid until {stamp(r.expires_at)}
                  </option>)}
                </select>
              </label>
              {activeRefs.length===0&&<p className="small muted" style={{marginTop:6}}>No active reference samples reserved yet. Reserve a stored item in Warehouse Items first, or switch to Product Inspection / Sample Comparison.</p>}
            </div>}

            <div className="actions" style={{marginTop:14}}>
              <span className="small muted">Quick quantity presets:</span>
              {(serviceKind==="compare"?[2,3]:serviceKind==="reference_match"?[1]:[1,5,30]).map(n=><button
                key={n}
                type="button"
                className={`button sm ${clampedQty===n?"primary":""}`}
                onClick={()=>{
                  setQty(n);
                  if(serviceKind==="compare") {
                    const match=serviceOffers.find(o=>n>=o.rules.minimum&&n<=o.rules.maximum);
                    if(match) setSelectedOfferId(match.offer_id);
                  }
                  setServerQuote(undefined);
                }}
              >{n} {n===1?"item":serviceKind==="compare"?"samples":"items"}</button>)}
            </div>

            <div className="sep"/>
            <div className="row between flexwrap">
              <div>
                <div className="label">SELECTED SERVICE</div>
                <strong>{serviceLabel} · {activeOffer?.sku_code??"APPAREL"}</strong>
                <p className="small muted" style={{margin:"6px 0 0"}}>
                  The service, template and price are recorded separately in each order snapshot. Turnaround: {activeOffer?.rules.business_days??2} business days after all items are received and identified.
                </p>
              </div>
              <Tag tone="green">Apparel · Available</Tag>
            </div>
          </Panel>
          <div className="line-note warning">
            Final payable pricing comes from the approved server-side price version snapshot calculated in Step 05.
          </div>
        </>}

        {step===2&&<Panel
          title="03   Product & Sample Details"
          subtitle="Dynamic attributes come from the approved category schema."
        >
          <div className="fields">
            <div className="field">
              <label>Product name
                <input value={itemName} onChange={e=>{setItemName(e.target.value);setServerQuote(undefined);}} placeholder="Product title" required/>
              </label>
            </div>
            <div className="field">
              <label>Supplier reference
                <input value={supplierRef} onChange={e=>setSupplierRef(e.target.value)} placeholder="Supplier code (optional)"/>
              </label>
            </div>
            <div className="field">
              <label>Item code / SKU
                <input value={baseSku} onChange={e=>setBaseSku(e.target.value)} placeholder="SKU-101"/>
              </label>
            </div>
            <div className="field">
              <label>Color / Variant
                <input value={baseColor} onChange={e=>setBaseColor(e.target.value)} placeholder="Black"/>
              </label>
            </div>
            <div className="field">
              <label>Size (apparel template)
                <input value={baseSize} onChange={e=>setBaseSize(e.target.value)} placeholder="M"/>
              </label>
            </div>
            <div className="field">
              <label>Number of items / samples
                <input
                  type="number"
                  min={minQty}
                  max={maxQty}
                  value={clampedQty}
                  onChange={e=>{setQty(Math.max(minQty,Math.min(maxQty,Number(e.target.value)||minQty)));setServerQuote(undefined);}}
                />
              </label>
            </div>
          </div>

          <div className="fields" style={{marginTop:14}}>
            <div className="field">
              <label>Product reference link (optional)
                <input type="url" value={productLink} onChange={e=>setProductLink(e.target.value)} placeholder="https://supplier.example/item"/>
              </label>
            </div>
            <div className="field">
              <label>Size chart or reference photo (optional)
                <input type="file" accept="image/*" onChange={async e=>{
                  const file=e.target.files?.[0];
                  if(!file) return;
                  try {
                    setBusyMessage("Uploading reference image…");
                    const uploadForm=new FormData();
                    uploadForm.set("photo",file);
                    const uploaded=await request("/me/media","POST",uploadForm);
                    setAttachmentId(uploaded.id);
                    setAttachmentName(file.name);
                  } catch(err) {
                    setWizardError(err instanceof Error?err.message:"Photo upload failed.");
                  } finally {
                    setBusyMessage("");
                  }
                }}/>
              </label>
              {attachmentName&&<small className="ok">Attached: {attachmentName}</small>}
            </div>
          </div>

          <div className="sep"/>

          <div className="row between flexwrap">
            <h3 style={{margin:0}}>Item-level mapping ({clampedQty} {clampedQty===1?"item":"items"})</h3>
            <div className="actions" style={{margin:0}}>
              {(serviceKind==="compare"?[2,3]:[1,5,30]).map(n=><button
                key={n}
                type="button"
                className={`button sm ${clampedQty===n?"primary":""}`}
                onClick={()=>{setQty(n);setServerQuote(undefined);}}
              >{n} {n===1?"item":"items"}</button>)}
            </div>
          </div>
          <p className="small muted" style={{marginTop:4}}>
            {serviceKind==="inspection"
              ?"Each item is checked independently; no automatic side-by-side comparison is created."
              :"Samples may arrive in separate parcels. Comparison starts only when all required compatible samples have been identified."}
          </p>

          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>Item SKU</th><th>Size</th><th>Color</th></tr>
              </thead>
              <tbody>
                {Array.from({length:visibleRowLimit},(_,idx)=>{
                  const row=itemRows[idx];
                  const defaultRowSku=`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
                  return <tr key={idx}>
                    <td className="mono">{String(idx+1).padStart(2,"0")}</td>
                    <td>
                      <input
                        className="input"
                        style={{minWidth:110}}
                        aria-label={`Item ${idx+1} SKU`}
                        value={row?.sku??defaultRowSku}
                        onChange={e=>updateItemRow(idx,"sku",e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{minWidth:80}}
                        aria-label={`Item ${idx+1} size`}
                        value={row?.size??baseSize}
                        onChange={e=>updateItemRow(idx,"size",e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{minWidth:90}}
                        aria-label={`Item ${idx+1} color`}
                        value={row?.color??baseColor}
                        onChange={e=>updateItemRow(idx,"color",e.target.value)}
                      />
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          {clampedQty>5&&<button type="button" className="button sm" onClick={()=>setShowAllItems(v=>!v)}>
            {showAllItems?"Show first five":`Edit all ${clampedQty} items`}
          </button>}

          {serviceKind==="compare"&&<label className="checkrow" style={{marginTop:12}}>
            <input type="checkbox" checked={sizeMismatchConfirmed} onChange={e=>setSizeMismatchConfirmed(e.target.checked)}/>
            <span>I understand comparing items of different sizes affects measurement difference interpretation.</span>
          </label>}

          <div className="sep"/>
          <div className="row between flexwrap">
            <span className="small muted">Need multiple services in a single order? Add this service line to queue another.</span>
            <button type="button" className="button sm" onClick={()=>{
              const built=buildCurrentLine();
              if(!built) return;
              setExtraLines(prev=>[...prev,built]);
              setServerQuote(undefined);
            }}>+ Add service line to order ({allLines.length} configured)</button>
          </div>
          {extraLines.length>0&&<ul className="draft-lines">
            {extraLines.map((line,idx)=><li key={idx}>
              <div>
                <strong>{line.title}</strong>
                <small>{line.attributes.name} · {line.quantity} {line.quantity===1?"item":"items"}{line.attributes.size_label?` · Size ${line.attributes.size_label}`:""}</small>
              </div>
              <button type="button" className="button sm" onClick={()=>{setExtraLines(xs=>xs.filter((_,i)=>i!==idx));setServerQuote(undefined);}}>Remove</button>
            </li>)}
          </ul>}
        </Panel>}

        {step===3&&<Panel
          title="04   Inspection Scope"
          subtitle="The selected template controls supported and required checks."
        >
          <div className="checklist">
            {wizardCheckDefs.map(([code,title,desc])=><label key={code} className="checkrow">
              <input
                type="checkbox"
                checked={selectedChecks.includes(code)}
                onChange={e=>setSelectedChecks(prev=>e.target.checked?[...prev,code]:prev.filter(x=>x!==code))}
              />
              <span>
                <strong>{title}</strong>
                <div className="small muted">{desc}</div>
              </span>
            </label>)}
          </div>

          <div className="fields" style={{marginTop:16}}>
            <div className="field">
              <label>Measurement tolerance in mm (optional)
                <input type="number" min={1} max={100} value={toleranceMm} onChange={e=>setToleranceMm(e.target.value)} placeholder="15"/>
              </label>
            </div>
            <div className="field">
              <label>Template version
                <input value={`Apparel Basic Visual v1 (${activeOffer?.sku_code??"APPAREL"})`} readOnly/>
              </label>
            </div>
          </div>

          <div className="field" style={{marginTop:14}}>
            <label>Special instructions
              <textarea value={notes} maxLength={500} onChange={e=>setNotes(e.target.value)} placeholder="Any product-specific concerns, key seams or collar labels to photograph…"/>
            </label>
          </div>

          <div className="sep"/>
          <div className="line-note">
            Laboratory fiber analysis, dye color ΔE, electrical safety, regulatory certification and untested batch conformity are excluded. Measurements require approved methods and recorded tools.
          </div>
        </Panel>}

        {step===4&&<Panel
          title="05   Review Your Quote"
          subtitle="Server price rules are authoritative; verify your official server quote and terms before payment."
          badge={serverQuote?<Tag tone="green">Quote rev {serverQuote.revision}</Tag>:<Tag tone="yellow">Calculating</Tag>}
        >
          <div className="grid cols2">
            <dl className="def"><dt>Product category</dt><dd>Apparel</dd></dl>
            <dl className="def"><dt>Service</dt><dd>{serviceLabel}</dd></dl>
            <dl className="def"><dt>Items / samples</dt><dd>{totalItems}</dd></dl>
            <dl className="def"><dt>Template</dt><dd>Apparel Basic Visual v1 ({activeOffer?.sku_code})</dd></dl>
          </div>

          <div className="sep"/>
          <div className="row between">
            <div>
              <strong>Inspection service fee · {serverQuote?"official server quote":"catalog estimate"}</strong>
              {serverQuote?.expires_at&&<div className="small muted">Quote valid through {stamp(serverQuote.expires_at)}</div>}
            </div>
            <h2 style={{margin:0,fontFamily:"var(--mono)"}}>{usd(displayCents)}</h2>
          </div>
          <div className="row between muted small" style={{marginTop:8}}>
            <span>Domestic forwarding / future storage charges</span>
            <span>Quoted separately</span>
          </div>

          <div className="actions" style={{marginTop:12}}>
            <button type="button" className="button sm" onClick={()=>{syncDraftAndQuote().catch(()=>{});}}>
              {serverQuote?"Recalculate Server Quote":"Calculate Official Server Quote"}
            </button>
          </div>

          <div className="sep"/>
          {terms.data?.terms&&<div style={{marginBottom:12}}>
            <div className="label" style={{marginBottom:6}}>APPLICABLE PLATFORM POLICIES</div>
            <PolicyLinks policies={terms.data.terms}/>
          </div>}

          <div className="checklist">
            <label className="checkrow" style={{background:"#f3f7fe"}}>
              <input
                type="checkbox"
                checked={allConsentsChecked}
                onChange={e=>{
                  const checkedVal=e.target.checked;
                  setConsents(Object.fromEntries(Object.keys(acknowledged).map(k=>[k,checkedVal])));
                }}
              />
              <span>
                <strong>I understand this is a sample-level observational service, not a laboratory certificate or full-batch guarantee, and accept all required disclosures below.</strong>
              </span>
            </label>
            {Object.entries(acknowledged).map(([k,textLabel])=><label key={k} className="checkrow">
              <input
                type="checkbox"
                checked={Boolean(consents[k])}
                onChange={e=>setConsents(prev=>({...prev,[k]:e.target.checked}))}
              />
              <span>{textLabel}</span>
            </label>)}
          </div>

          <div className="line-note warning" style={{marginTop:14}}>
            Quote expires and service eligibility can change before a production order is submitted. Historical confirmed quotes retain their own immutable price snapshot.
          </div>
        </Panel>}

        {step===5&&<Panel
          title="06   Pay & Send Your Samples"
          subtitle="Submit your order and confirm payment to unlock sample receiving instructions."
          badge={<Tag tone="blue">{draftOrder?.public_no??"Ready"}</Tag>}
        >
          <div className="grid cols2">
            <dl className="def"><dt>Order item</dt><dd>Apparel / {serviceLabel}</dd></dl>
            <dl className="def"><dt>Service fee</dt><dd className="mono">{usd(displayCents)}</dd></dl>
            <dl className="def"><dt>Receiving code</dt><dd><span className="mono">{receiving.data?.receiving_code??"QCW-PERMANENT"}</span></dd></dl>
            <dl className="def"><dt>Order status</dt><dd>{draftOrder?label(draftOrder.state):"Draft ready for submission"}</dd></dl>
          </div>

          <div className="sep"/>
          <div className="line-note warning">
            <strong>Server-verified payment confirmation:</strong> The production system confirms a provider-signed Stripe webhook callback; in local development mode, clicking the button below executes the server-side demo payment confirmation and transitions your order directly to <span className="mono">awaiting_samples</span>.
          </div>

          <div className="actions" style={{marginTop:16}}>
            <button type="button" className="button primary" onClick={submitAndSimulatePayment}>
              Simulate payment confirmation &amp; create order →
            </button>
            {draftOrder&&<Link className="button sm" href={"/orders/"+draftOrder.public_no}>Open Order {draftOrder.public_no}</Link>}
            <Link className="button sm" href="/account">View receiving address</Link>
          </div>
        </Panel>}

        <div className="wizard-controls">
          <button
            type="button"
            className="button"
            disabled={step===0}
            onClick={()=>{setWizardError("");setStep(s=>Math.max(0,s-1));}}
          >← Previous</button>
          {step<5?(
            <button
              type="button"
              className="button primary"
              disabled={!resolveCategoryId(categoryKey)||(step===4&&!allConsentsChecked)}
              onClick={goToNextStep}
            >{step===4?"Continue to Payment →":"Continue →"}</button>
          ):(
            <Link className="button sm" href={draftOrder?"/orders/"+draftOrder.public_no:"/orders"}>Save Draft &amp; Exit</Link>
          )}
        </div>
      </div>

      <aside className="wizard-side">
        <section className="card">
          <div className="card-head">
            <div>
              <h3>Order Summary</h3>
              <p>Synchronized with your current selections.</p>
            </div>
            <Tag tone={serverQuote?"green":"yellow"}>{draftOrder?draftOrder.public_no:"DRAFT"}</Tag>
          </div>
          <div className="sep"/>
          <div className="mini-kv">
            <div><div className="k">Category</div><div className="v">{wizardCategoryCatalog.find(c=>c.key===categoryKey)?.name??"Apparel"}</div></div>
            <div><div className="k">Service</div><div className="v">{serviceKind==="inspection"?"Individual":serviceKind==="compare"?"Comparison":"Reference"}</div></div>
            <div><div className="k">Items</div><div className="v">{totalItems}</div></div>
            <div><div className="k">Location</div><div className="v">China</div></div>
          </div>
          <div className="sep"/>
          <div className="display-quote">
            <div className="label">{serverQuote?"SERVER QUOTE":"ESTIMATED SERVICE FEE"}</div>
            <div className="big">{displayCents!=null?usd(displayCents):"Unavailable"}</div>
            <div className="small muted">Excludes shipping, storage, taxes and other unapproved fees.</div>
          </div>
          <div className="sep"/>
          <div className="row between">
            <button type="button" className="button sm" onClick={()=>{
              setStep(0);
              setExtraLines([]);
              setItemRows([]);
              setServerQuote(undefined);
              setDraftOrder(undefined);
              setWizardError("");
            }}>Reset draft</button>
            <button type="button" className="button sm" onClick={async()=>{
              const ord=await syncDraftAndQuote();
              if(ord?.public_no) location.assign("/orders/"+ord.public_no);
            }}>Save &amp; Open Order</button>
          </div>
        </section>

        <section className="card">
          <strong>Evidence-based inspections</strong>
          <p className="small" style={{margin:"8px 0 0"}}>
            All checks attach results to the exact physical sample, template version and measurement method.
          </p>
        </section>
      </aside>
    </div>
  </>;
}
export function OrderView({number,section}:{number:string;section?:OrderSection}) {
  const lookup=useLoad("/orders/by-number/"+number);
  const id=lookup.data?.id;
  const detail=useLoad(id?"/orders/"+id:null),terms=useLoad("/public/terms");
  const payment=useLoad(id&&(!section||section==="payment")?"/orders/"+id+"/payment":null);
  const receiving=useLoad(section==="parcels"?"/me/receiving-address":null);
  const carriers=useLoad(section==="parcels"?"/carriers":null);
  const base="/orders/"+number;
  const sectionLinks:[string,string][]=[[base,"Overview"],...Object.entries(orderSections).map(([key,title]):[string,string]=>[base+"/"+key,title])];
  const [calculatedQuote,setQuote]=useState<Row>();
  const [checkoutNotice,setCheckoutNotice]=useState<{text:string;error?:boolean;expired?:boolean}>();
  const [openedCase,setOpenedCase]=useState<string>();
  const o=detail.data;
  const quote=o?.manual_quote?.id?o.manual_quote:calculatedQuote;
  const paymentState=payment.data?.state;
  const refreshPayment=()=>{detail.reload();payment.reload();};
  useEffect(()=>{
    if(paymentState!=="processing"&&!(checkoutNotice&&!checkoutNotice.error&&o?.state==="awaiting_payment"))return;
    const timer=setInterval(()=>{detail.reload();payment.reload();},15000);
    return ()=>clearInterval(timer);
  },[paymentState,checkoutNotice,o?.state,detail.reload,payment.reload]);
  async function continuePayment(chargeId:string,quoteRevision:number) {
    setCheckoutNotice(undefined);
    try {
      const result=await request("/charges/"+chargeId+"/checkout","POST",{quote_revision:quoteRevision});
      if(result.checkout_url) location.assign(result.checkout_url);
      else if(result.state==="processing") setCheckoutNotice({text:"Payment is processing. Refresh this order for the confirmed status."});
    } catch(error) {
      setCheckoutNotice({text:error instanceof Error?error.message:"Checkout could not start.",error:true,
        expired:error instanceof RequestError&&error.code==="QUOTE_EXPIRED"});
    } finally {
      refreshPayment();
    }
  }
  return <><div className="page-head row"><div><Link href="/orders">← Inspection orders</Link><h1 className="order-number">{number}</h1></div>{o&&<Tag>{label(o.state)}</Tag>}</div>
    {(lookup.error||detail.error)&&<ErrorBlock error={lookup.error||detail.error}/>}
    {!o&&!lookup.error&&!detail.error&&<p role="status">Loading inspection order…</p>}
    {o&&<>
      <Tabs path={section?base+"/"+section:base} links={sectionLinks}/>
      {o.state==="on_hold"&&<div className="notice" role="status"><strong>This order is currently on hold</strong>{o.hold_reason?`: ${o.hold_reason}`:""}.{paymentState==="paid"?" Your payment is recorded and will be applied when the hold is lifted.":""}</div>}
      {section==="parcels"&&<Panel title="Register seller tracking for this order">
        {receiving.error||carriers.error?<ErrorBlock error={receiving.error||carriers.error}/>:!receiving.data?<p role="status">Loading the receiving address…</p>:
          <InboundParcelForm address={receiving.data.warehouse_address} carriers={carriers.data?.carriers??[]} orderId={o.id} onSave={detail.reload}/>}
      </Panel>}
      {(section==="dispositions"||section==="storage")&&<OrderHandling order={o} storage={section==="storage"} onSave={detail.reload}/>}
      {!section&&orderNext[o.state]&&<div className="order-next"><div><span className="eyebrow">NEXT STEP</span><p>{orderNext[o.state]}</p></div>
        {o.state==="awaiting_samples"&&<Link className="button" href={base+"/parcels"}>Register seller tracking</Link>}
        {["report_ready","action_pending","cancelled"].includes(o.state)&&<Link className="button" href={base+"/dispositions"}>Open item instructions</Link>}
      </div>}
      {(section==="payment"||!section&&o.state==="awaiting_payment")&&<Panel title="Inspection payment">
        {payment.error?<ErrorBlock error={payment.error}/>:!payment.data?<p role="status">Loading the current charge…</p>:<>
          {payment.data.charge&&<p><strong>{usd(payment.data.charge.amount_cents)}</strong> · Quote {payment.data.charge.quote_revision}</p>}
          {paymentState==="open"&&!checkoutNotice?.expired&&<Action primary run={()=>continuePayment(payment.data!.charge.id,payment.data!.charge.quote_revision)}>Resume payment</Action>}
          {paymentState==="processing"&&<p role="status">Payment is processing. We will update the order after confirmation.</p>}
          {(paymentState==="expired"||checkoutNotice?.expired)&&<p>The quote has expired. Review a new quote for this order.</p>}
          {paymentState==="paid"&&<p><Tag>Payment confirmed</Tag></p>}
          {paymentState==="not_due"&&<p>{o.state==="draft"?"Calculate and accept a quote to create the inspection charge.":"There is no payable inspection charge for this order."}</p>}
        </>}
        {checkoutNotice&&(checkoutNotice.error?<ErrorBlock error={checkoutNotice.text}/>:<p role="status">{checkoutNotice.text}</p>)}
        <div className="actions"><button type="button" onClick={refreshPayment}>Refresh payment status</button>
          <Link href={payment.data?.charge?"/account/billing#charge-"+payment.data.charge.id:"/account/billing"}>Open billing</Link></div>
      </Panel>}
      {(!section||section==="payment")&&<Panel title="Inspection scope">
      {o.customer_notes&&<p className="muted">Notes: {o.customer_notes}</p>}
      {o.sla_due_at&&<p className="muted small">Inspection SLA target · {stamp(o.sla_due_at)}</p>}
      <Table headers={["Service","Position","Warehouse item","Custody"]} rows={o.items.map((i:Row)=>[i.title.en,i.position??i.quantity,i.code??"Awaiting assignment",i.custody_state?label(i.custody_state):"—"])}/>
      {o.state==="draft"&&Array.isArray(o.lines)&&o.lines.length>0&&<details className="card">
        <summary>Draft item declarations ({o.lines.reduce((n:number,l:Row)=>n+(l.quantity??0),0)} items)</summary>
        {o.lines.map((l:Row)=><div key={l.id}>
          <p><strong>{l.title?.en??l.sku_code}</strong> · {l.quantity} {l.quantity===1?"item":"items"}</p>
          <Table headers={["Sample code","Size","Color","Tolerance"]} rows={(Array.isArray(l.draft_items)?l.draft_items:[]).map((item:Row,idx:number)=>[
            <span className="code">{item.sample_code??`P-${idx+1}`}</span>,
            item.size_label??l.attributes?.size_label??"—",
            item.color_declared??l.attributes?.color_declared??"—",
            item.tolerances?.dimension_mm?`±${item.tolerances.dimension_mm} mm`:l.attributes?.tolerances?.dimension_mm?`±${l.attributes.tolerances.dimension_mm} mm`:"—",
          ])}/>
        </div>)}
      </details>}
      {o.report_version&&<Link className="button primary" href={"/orders/"+number+"/report"}>Open inspection report</Link>}
      {(o.state==="draft"||o.state==="awaiting_payment"&&(paymentState==="expired"||checkoutNotice?.expired))&&
        <div className="actions"><Action primary run={async()=>setQuote(await request("/orders/"+id+"/quotes","POST",{revision:o.revision}))}>{o.state==="draft"?"Calculate quote":"Review a new quote"}</Action></div>}
      {o.state==="draft"&&<details className="card"><summary>Need a manual quote?</summary>
        {o.manual_quote?<p>Quote request · {o.manual_quote.state}</p>:<Form label="Request manual quote" run={async f=>{
          await request("/orders/"+id+"/manual-quote-request","POST",{revision:o.revision,reason:text(f,"reason")});detail.reload();
        }}><Field label="Describe your requirements" name="reason"/></Form>}
      </details>}
      {quote&&["draft","awaiting_payment"].includes(o.state)&&<><hr className="divider"/><h3>{usd(quote.amount_cents)} · expires {stamp(quote.expires_at)}</h3>
        <Table headers={["Quantity","Line amount","Business days"]} rows={quote.line_snapshot.map((l:Row)=>[l.quantity,usd(l.amount_cents),l.business_days])}/>
        {terms.error?<><ErrorBlock error={terms.error}/><button type="button" onClick={terms.reload}>Retry loading policies</button></>:
          !terms.data?<p role="status">Loading policies…</p>:terms.data.terms.length!==4?<Empty>Current policies are unavailable. Please try again later.</Empty>:
          <Form label={quote.amount_cents===0?"Accept no-charge quote":"Accept quote and pay"} run={async f=>{
          const acknowledgements=Object.fromEntries(Object.keys(acknowledged).map(k=>[k,checked(f,k)]));
          const accepted=await request("/orders/"+id+"/submit","POST",{revision:o.revision,quote_id:quote.id,
            terms_version_ids:terms.data?.terms.map((t:Row)=>t.id)??[],acknowledgements});
          setQuote(undefined);
          await continuePayment(accepted.charge.charge_item_id,quote.revision);
        }}>
          <PolicyLinks policies={terms.data.terms}/>
          {Object.entries(acknowledged).map(([k,v])=><label key={k} className="check"><input required type="checkbox" name={k}/>{v}</label>)}
        </Form>}</>}
    </Panel>}
    {(!section||section==="payment")&&o.consents.length>0&&<Panel title="Policies accepted for this order">
      {o.consents.map((consent:Row)=><details key={consent.id} className="card">
        <summary>Accepted {stamp(consent.created_at)}</summary><PolicyLinks policies={consent.policies}/>
      </details>)}
    </Panel>}
    {(!section||section==="parcels")&&<Panel title="Inbound parcels">
      <Table headers={["Seller tracking number","Carrier status","Warehouse intake"]} rows={o.parcels.map((p:Row)=>[
        <Link className="code" href={"/parcels/"+p.id}>{p.tracking_norm}</Link>,
        label(p.transport_state),p.warehouse_state?label(p.warehouse_state):"Awaiting physical receipt",
      ])} empty="No seller waybills are linked to this order."/>
      <div className="actions"><Link href="/account">View your warehouse address</Link><Link href={section?"/parcels":base+"/parcels"}>{section?"Open all parcels":"Manage linked parcels"}</Link></div>
    </Panel>}
    {!section&&<ScopeReview key={o.revision} orderId={id} onSave={detail.reload}/>}
    {!section&&<Panel title="Order support">
      <Table headers={["Case","Subject","Status"]} rows={o.cases.map((c:Row)=>[<Link className="code" href={base+"/cases/"+c.id}>{c.public_no}</Link>,c.subject,label(c.state)])} empty="No support cases are linked to this order."/>
      <details className="card"><summary>Open a support case for this order</summary>
        <Form key={openedCase} label="Submit support case" run={async f=>{
          const result=await request("/me/cases","POST",{order_id:id,category:text(f,"category"),subject:text(f,"subject"),message:text(f,"message")});
          setOpenedCase(result.public_no);
          detail.reload();
        }}>
          <Select name="category" label="Issue" choices={[
            {id:"receipt_mismatch",label:"Received items do not match"},
            {id:"measurement_dispute",label:"Question about inspection results"},
            {id:"return_info_incomplete",label:"Return or forwarding information"},
            {id:"damage_or_loss",label:"Item damage or loss"},
            {id:"payment_refund",label:"Payment or refund"},
          ]}/>
          <Field name="subject" label="Subject"/>
          <label>Describe the issue<textarea name="message" required maxLength={2000}/></label>
        </Form>
        {openedCase&&<p role="status">Case <strong className="code">{openedCase}</strong> is open.</p>}
      </details>
      {id&&<OrderAfterSalesAndRefundPanel orderId={id} orderState={o.state} onSaved={detail.reload}/>}
    </Panel>}
    {!section&&!["closed","cancelled","report_ready","action_pending"].includes(o.state)&&<Panel title="Order changes"><Action run={async()=>{
      if(!window.confirm("Cancel this inspection? Warehouse items remain available for disposition."))return;
      await request("/orders/"+id+"/cancel","POST",{revision:o.revision});detail.reload();
    }}>Cancel inspection</Action></Panel>}
    </>}
  </>;
}
function OrderAfterSalesAndRefundPanel({orderId,orderState,onSaved}:{orderId:string;orderState:string;onSaved:()=>void}) {
  const preview=useLoad(!["draft","awaiting_payment"].includes(orderState)?`/orders/${orderId}/refund-preview`:null);
  const [ticketNo,setTicketNo]=useState<string>();
  const stage=preview.data?.stage;
  return <details className="card"><summary>After-sales, re-inspection &amp; stage refund policy (§10.3)</summary>
    {stage&&<p className="muted small">
      Current stage: <strong>{label(stage.stage)}</strong> · Standard refund rate: <strong>{stage.refund_rate_pct}%</strong> · Paid: {usd(stage.paid_cents)} · Refunded: {usd(stage.already_refunded_cents)} · Standard refundable: <strong>{usd(stage.recommended_refund_cents)}</strong> ({stage.policy_summary})
    </p>}
    <Form key={ticketNo} label="Submit after-sales request" run={async f=>{
      const res=await request(`/orders/${orderId}/after-sales`,"POST",{
        resolution_type:text(f,"resolution_type"),
        reason:text(f,"reason"),
      });
      setTicketNo(res.ticket_no);
      preview.reload();
      onSaved();
    }}>
      <Select name="resolution_type" label="Requested resolution" choices={[
        {id:"re_inspect",label:"Request re-inspection of physical samples"},
        {id:"service_refund",label:"Request inspection service fee refund"},
      ]}/>
      <Field name="reason" label="Reason and details"/>
    </Form>
    {ticketNo&&<p className="notice" role="status">After-sales case <strong className="code">{ticketNo}</strong> submitted.</p>}
  </details>;
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
export function ReportView({number,version}:{number:string;version?:number}) {
  const l=useLoad("/orders/by-number/"+number),id=l.data?.id;
  const base=id?"/orders/"+id+"/report":null;
  const r=useLoad(base&&version?base+"/versions/"+version:base);
  const viewer=useRef<HTMLDialogElement>(null);
  const [photo,setPhoto]=useState<{id:string;label:string}>();
  const [disputeTicket,setDisputeTicket]=useState<string>();
  const reportPath="/orders/"+number+"/report";
  const report=r.data;
  function showPhoto(id:string,label:string) {
    setPhoto({id,label});
    viewer.current?.showModal();
  }
  const allCheckpoints:Row[]=report?.snapshot?.sections?.flatMap((s:Row)=>s.results??[])??[];
  return <>
    <div className="page-head"><Link href={"/orders/"+number}>← Order {number}</Link>
      <p className="eyebrow report-eyebrow">INSPECTION / EVIDENCE RECORD</p><h1 className="order-number">{report?.snapshot.report_no??"Inspection report"}</h1>
      {report&&<p className="muted">Version {report.version} · Published {stamp(report.published_at)}</p>}
    </div>
    {(l.error||r.error)&&<ErrorBlock error={l.error||r.error}/>}
    {!report&&!l.error&&!r.error&&<p role="status">Loading report evidence…</p>}
    {report&&<>
      {report.state==="superseded"&&<div className="notice">This is a historical report. <Link href={reportPath}>View the latest published version</Link>.</div>}
      <div className="actions">
        <Action primary run={async()=>{
          const {url}=await request(base+"/versions/"+report.version+"/pdf");
          location.assign(url);
        }}>Download version {report.version} PDF</Action>
        <Link className="button" href={"/orders/"+number+"/dispositions"}>Choose item handling →</Link>
      </div>
      <Panel title="Published versions">
        <Table headers={["Version","Status","Published","Revision reason"]} rows={report.versions.map((v:Row)=>[
          <Link aria-current={v.version===report.version?"page":undefined} href={reportPath+"/versions/"+v.version}>Version {v.version}</Link>,
          v.state==="superseded"?"Historical":"Current",stamp(v.published_at),v.amend_reason??"—",
        ])}/>
      </Panel>
      {id&&<ReportShares key={report.version} orderId={id} version={report.version}/>}
      {report.snapshot.sections.map((s:Row)=><Panel key={s.task_id} title={s.title}>
        {s.summary&&<p className="muted small">Expected items: {s.summary.expected_count} · Inspected: {s.summary.checked_count} · Observed issues: {s.summary.issue_count}</p>}
        <ReportSection section={s} results={s.results} grouped={["compare","reference_match"].includes(s.service)} showPhoto={showPhoto}/>
      </Panel>)}
      <Panel title="Scope &amp; what we do not inspect">
        <p className="muted">{report.snapshot.scope_notice??"Findings apply only to the physical samples received and the checks listed in this report."}</p>
        {Array.isArray(report.snapshot.not_inspected)&&report.snapshot.not_inspected.length>0&&<ul>
          {report.snapshot.not_inspected.map((line:string,idx:number)=><li key={idx}>{line}</li>)}
        </ul>}
      </Panel>
      {id&&allCheckpoints.length>0&&<Panel title="Question or dispute a checkpoint in this report">
        <Form key={disputeTicket} label="Submit report dispute" run={async f=>{
          const target=text(f,"checkpoint");
          const [item_code,item_key]=target.split("::");
          const res=await request("/orders/"+id+"/report/disputes","POST",{
            version:report.version,
            item_code,
            item_key,
            subject:text(f,"subject")||undefined,
            message:text(f,"message"),
          });
          setDisputeTicket(res.public_no);
        }}>
          <Select name="checkpoint" label="Checkpoint" choices={allCheckpoints.map((c:Row)=>({
            id:`${c.item}::${c.item_key}`,
            label:`${c.item} · ${c.label} (${c.status})`,
          }))}/>
          <Field name="subject" label="Summary (optional)" required={false}/>
          <label>Details of your question or dispute<textarea name="message" required maxLength={2000}/></label>
        </Form>
        {disputeTicket&&<p className="notice" role="status">Report dispute case <strong className="code">{disputeTicket}</strong> is open and linked to version {report.version}.</p>}
      </Panel>}
    </>}
    <dialog ref={viewer} className="evidence-dialog" aria-labelledby="report-evidence-title" onClose={()=>setPhoto(undefined)}>
      <div className="row"><h2 id="report-evidence-title">{photo?.label??"Report evidence"}</h2><form method="dialog"><button type="submit">Close</button></form></div>
      {photo&&<>
        <img src={"/api/v1/media/"+photo.id} alt={photo.label}/>
        <a href={"/api/v1/media/"+photo.id} target="_blank" rel="noreferrer">Open original photo</a>
      </>}
    </dialog>
  </>;
}
function ReportSection({section,results,grouped,showPhoto}:{section:Row;results:Row[];grouped:boolean;showPhoto:(id:string,label:string)=>void}) {
  const result=(x:Row)=>{
    const base=[x.typed_value!=null?String(x.typed_value):label(x.status.toLowerCase()),x.unit,x.reason].filter(Boolean).join(" · ");
    const circ=typeof x.derived_circumference==="number"?` (Circumference: ${x.derived_circumference} cm)`:"";
    const tol=typeof x.within_tolerance==="boolean"?` · ${x.within_tolerance?"Within stated tolerance":"Outside stated tolerance"}`:"";
    return base+circ+tol;
  };
  const evidence=(x:Row)=>x.evidence_ids.map((m:string)=><button className="evidence-open" type="button" key={m}
    aria-label={`View ${x.label} evidence for ${x.item}`} onClick={()=>showPhoto(m,x.label+" · "+x.item)}>
    <img className="thumb" src={"/api/v1/media/"+m} alt="" loading="lazy"/></button>);
  if(!grouped) return <Table headers={["Item","Check","Result","Method","Evidence"]}
    rows={results.map(x=>[x.item,x.label,result(x),x.method,evidence(x)])}/>;
  const items=[...new Set(results.map(x=>String(x.item)))];
  const checks=new Map<string,Row>();
  for(const x of results) checks.set(x.item_key,x);
  const diffMap=new Map<string,Row>((section.comparison?.diffs??[]).map((d:Row)=>[d.point_code,d]));
  return <div className="report-comparison">
    <Table headers={["Check",...items,"Diff (max - min)"]} rows={[...checks.values()].map(check=>{
      const d=diffMap.get(check.item_key);
      const diffLabel=d?`${d.display_diff}${d.max_minus_min!=null&&d.unit?" "+d.unit:""}`:"—";
      return [
        <div>{check.label}<small className="muted"><br/>{check.method}</small></div>,
        ...items.map(item=>{
          const x=results.find(r=>r.item===item&&r.item_key===check.item_key);
          return x?<div>{result(x)}<div>{evidence(x)}</div></div>:"—";
        }),
        <span className="code">{diffLabel}</span>,
      ];
    })}/>
  </div>;
}
export function TrackView({kind,id,embedded=false}:{kind:"parcels"|"shipments";id:string;embedded?:boolean}) {
  const path=kind==="parcels"?"/me/parcels/":"/shipments/";
  const {data,error,reload}=useLoad(path+id+"/tracking?locale=en");
  const canVerify=kind==="parcels"&&data?.allowed_actions.includes("verify_tracking");
  const canCorrect=kind==="parcels"&&Boolean(data&&!data.warehouse_state);
  const verificationPath=path+id+"/tracking-verification";
  const verification=useLoad(canVerify||canCorrect?verificationPath:null),carriers=useLoad(canVerify||canCorrect?"/carriers":null);
  const [refreshError,setRefreshError]=useState<string|null>(null);
  useEffect(()=>{const timer=setInterval(reload,60000);return ()=>clearInterval(timer);},[reload]);
  return <>{!embedded&&<div className="page-head"><p className="eyebrow">Warehouse / Tracking</p><h1>Tracking details</h1><p className="muted">Follow carrier events and the warehouse’s own handling status.</p></div>}{error&&<ErrorBlock error={error}/>}{refreshError&&<ErrorBlock error={refreshError}/>}
    {!data&&!error&&<p role="status">Loading carrier tracking…</p>}
    {data&&<Panel title={data.carrier??"Carrier pending"}><p className="code">{data.tracking_no}</p>
      <div className="actions"><Tag>{label(data.transport_state)}</Tag><Tag>{label(data.sync_state)}</Tag>
      {data.warehouse_state&&<Tag>Warehouse · {label(data.warehouse_state)}</Tag>}
      <button onClick={async()=>{
        setRefreshError(null);
        if(data.allowed_actions.includes("refresh_tracking")) {
          try { await request(path+id+"/tracking/refresh","POST",{}); }
          catch(e){ setRefreshError(e instanceof Error?e.message:String(e)); }
        }
        reload();
      }}>Refresh status</button></div>
      {data.direction==="inbound"&&data.transport_state==="delivered"&&!data.warehouse_state&&<p className="notice" role="status"><strong>Delivered by carrier · Warehouse check-in pending.</strong> Physical receipt is confirmed only after warehouse check-in.</p>}
      {data.direction==="outbound_forward"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to domestic freight forwarder.</strong> International forwarding is managed by your forwarder.</p>}
      {data.direction==="outbound_return"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to seller.</strong> Seller refund depends on your seller platform confirmation.</p>}
      {(data.translation_status==="updating"||data.translation_status==="pending")&&<p className="muted small" role="status">English details are being updated{data.latest_event_at?` · Latest carrier event ${stamp(data.latest_event_at)}`:""}.</p>}
      {(data.sync_state==="needs_verification"||data.sync_state==="needs_carrier")&&<p className="notice" role="status">Verification needed — confirm the carrier or shipping label phone number to continue tracking.</p>}
      {data.sync_state==="no_record"&&<p className="muted small" role="status">No carrier events reported yet — the carrier may not have scanned the parcel yet.</p>}
      {(data.sync_state==="delayed"||data.sync_state==="provider_error")&&<p className="muted small" role="status">Carrier updates are temporarily delayed — showing the last known snapshot from {stamp(data.last_success_at)}.</p>}
      {data.sync_state==="unsupported"&&<p className="muted small" role="status">Automatic tracking is not supported for this carrier; warehouse check-in and handover updates will still appear here.</p>}
      {data.next_allowed_at&&!data.allowed_actions.includes("refresh_tracking")&&<p className="muted small">Next manual refresh available at {stamp(data.next_allowed_at)}.</p>}
      {canVerify&&verification.data&&<Form label="Verify carrier tracking" run={async f=>{
        const phone=text(f,"phone");
        await request(verificationPath,"POST",{revision:verification.data?.revision,carrier_code:verification.data?.carrier_code??text(f,"carrier_code"),...(phone?{phone}:{})});
        verification.reload();reload();
      }}>
        {!verification.data.carrier_code&&<Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>}
        <Field name="phone" label="Phone used on this shipping label, if required by the carrier" required={false} type="tel"/>
      </Form>}
      {canCorrect&&verification.data&&<details className="top-gap"><summary>Correct tracking number or carrier before check-in</summary>
        <Form label="Save corrected tracking" run={async f=>{
          await request(path+id+"/correct","POST",{
            revision:verification.data?.revision,
            carrier_code:text(f,"carrier_code")||verification.data?.carrier_code,
            tracking_no:text(f,"tracking_no"),
            reason:text(f,"reason"),
          });
          verification.reload();reload();
        }}>
          <Select name="carrier_code" label="Carrier" value={verification.data.carrier_code??""} choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>
          <Field name="tracking_no" label="Corrected tracking number" value={data.tracking_no}/>
          <Field name="reason" label="Reason for correction"/>
        </Form>
      </details>}
      <p className="muted small">Carrier data updated {stamp(data.last_success_at)}</p>
      {data.events.length?<ol className="timeline">{data.events.map((e:Row)=><li key={e.id}><small>{stamp(e.occurred_at)}</small><br/>{e.text}</li>)}</ol>:<Empty>English carrier events will appear when verified tracking data is available.</Empty>}
    </Panel>}
  </>;
}
export function CustomerDesk({path}:{path:string}) {
  const {data,error,reload}=useLoad("/me/desk"),carriers=useLoad("/carriers");
  const [next,setNext]=useState<string|null>(null);
  const [parcelOrder,setParcelOrder]=useState<string|null>(null);
  const [orderQuery,setOrderQuery]=useState("");
  const [orderState,setOrderState]=useState("");
  useEffect(()=>{
    const params=new URLSearchParams(location.search);
    setNext(customerDestination(params.get("next")));
    setParcelOrder(params.get("order"));
  },[path]);
  const [batchIds,setBatchIds]=useState<string[]>([]);
  useEffect(()=>{
    if(!data||(path!=="/support"&&path!=="/account/billing"))return;
    const id=location.hash.slice(1);
    if(/^(case|quote|charge)-[a-f0-9-]{36}$/.test(id))document.getElementById(id)?.scrollIntoView({block:"start"});
  },[data,path]);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>Loading your account…</p>;
  const addr=data.profile.warehouse_address;
  const isHome=path==="/account",isSecurity=path==="/account/security",isItems=path==="/items",isParcels=path==="/parcels",isBills=path==="/account/billing",isOrders=path==="/orders",isHelp=path==="/support";
  const orders:Row[]=data.orders;
  const visibleOrders=isHome?orders.slice(0,5):orders.filter(order=>
    order.public_no.toLowerCase().includes(orderQuery.trim().toLowerCase())&&(!orderState||order.state===orderState));
  return <>
    {data.email_delivery?.banner_message&&<div className="notice" role="alert"><strong>{data.email_delivery.banner_message}</strong>{data.email_delivery.masked_email?` (${data.email_delivery.masked_email})`:""}. Important updates remain available in your account notifications and action centre. <Link href="/account/security">Update email in account security →</Link></div>}
    {isHome&&<>
      <div className="page-head row">
        <div><p className="eyebrow">CUSTOMER PORTAL</p><h1>My Account &amp; Receiving Address</h1><p className="muted">Manage your permanent China warehouse receiving code, incoming deliveries, inspection reports and item instructions.</p></div>
        <div className="head-actions"><Link className="button sm" href="/account/security">Sign-in &amp; security</Link><Link className="button primary sm" href="/orders/new">+ Create Inspection</Link></div>
      </div>
      <div className="metric-strip" aria-label="Account summary">
        <Link className="metric" href="/orders"><span>Inspection Orders</span><strong>{orders.length}</strong><small>{orders.filter(o=>o.state==="draft").length} drafts · {orders.filter(o=>["report_ready","action_pending"].includes(o.state)).length} ready</small></Link>
        <Link className="metric" href="/parcels"><span>Inbound Parcels</span><strong>{data.advices.length}</strong><small>Registered seller waybills</small></Link>
        <Link className="metric" href="/items"><span>Warehouse Items</span><strong>{data.items.length}</strong><small>{(data.references??[]).filter((r:Row)=>r.state==="active"&&!r.expired).length} active reference samples</small></Link>
        <Link className="metric" href="/account/billing"><span>Open Quotes &amp; Bills</span><strong>{data.quotes.length+data.bills.filter((b:Row)=>b.state==="open").length}</strong><small>Shipping, storage &amp; inspection</small></Link>
      </div>
      <div className="ops-columns">
        <Panel title="China Warehouse Receiving Address" subtitle="Include your permanent receiving code on every seller shipping label." badge={<Tag tone="green">Active</Tag>}>
          <div className="receiving-code"><span className="eyebrow">PERMANENT PERSONAL RECEIVING CODE</span><strong className="code">{data.profile.receiving_code}</strong></div>
          {addr?<>
            <div className="grid cols2" style={{marginBottom:12}}>
              <dl className="def"><dt>Recipient &amp; Phone</dt><dd>{addr.recipient} ({data.profile.receiving_code}) · {addr.phone}</dd></dl>
              <dl className="def"><dt>Warehouse Code</dt><dd className="mono">{addr.code??"CN-GD-01"}</dd></dl>
              <dl className="def"><dt>Chinese Shipping Address (For Domestic Sellers)</dt><dd>{addr.address_zh}（收件码：{data.profile.receiving_code}）</dd></dl>
              <dl className="def"><dt>English Reference Address</dt><dd>{addr.address_en}</dd></dl>
            </div>
            <div className="actions">
              <Action primary run={()=>navigator.clipboard.writeText([`${addr.recipient} (${data.profile.receiving_code})`,addr.phone,`${addr.address_zh}（收件码：${data.profile.receiving_code}）`].join("\n"))}>Copy Chinese shipping address</Action>
              <Link className="button sm" href="/parcels">Register seller tracking →</Link>
            </div>
          </>:<Empty>The warehouse address is awaiting configuration.</Empty>}
          {next&&<Link className="button primary" href={next}>Continue to your selected page</Link>}
        </Panel>
        <RecentUpdates notices={data.notices} onRead={reload}/>
      </div>
    </>}
    {isSecurity&&<AccountSecurity receivingCode={data.profile.receiving_code}/>}
    {isOrders&&<div className="page-head row"><div><p className="eyebrow">CLIENT WORKSPACE</p><h1>Inspection orders</h1><p className="muted">Review your orders or continue an existing draft.</p></div>
      <Link className="button primary" href="/orders/new">New inspection <span aria-hidden="true">→</span></Link></div>}
    {isOrders&&<div className="metric-strip" aria-label="Orders summary">
      {[
        ["Orders shown",orders.length],
        ["Drafts",orders.filter(order=>order.state==="draft").length],
        ["Checks in progress",orders.filter(order=>["queued","inspecting","qa_review"].includes(order.state)).length],
        ["Ready to review",orders.filter(order=>["report_ready","action_pending"].includes(order.state)).length],
      ].map(([name,value])=><div className="metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}
    </div>}
    {(isHome||isOrders)&&<Panel title={isHome?"Recent orders":"Your orders"}>
      {isOrders&&<div className="form inline-form">
        <label>Order number<input type="search" value={orderQuery} onChange={event=>setOrderQuery(event.target.value)} placeholder="Find an order…"/></label>
        <label>Status<select value={orderState} onChange={event=>setOrderState(event.target.value)}><option value="">All statuses</option>
          {[...new Set(orders.map(order=>String(order.state)))].map(state=><option key={state} value={state}>{label(state)}</option>)}
        </select></label>
        <Link className="button" href="/actions">Action required</Link>
      </div>}
      {visibleOrders.length?<Table headers={["Order","Status","Quote","Created"]} rows={visibleOrders.map(o=>[
        <Link className="code" href={"/orders/"+o.public_no}>{o.public_no}</Link>,<Tag>{label(o.state)}</Tag>,o.price_cents===null?"—":usd(o.price_cents),stamp(o.created_at)
      ])}/>:<Empty>{orders.length?"No orders match your filters.":"Your orders will appear here."}</Empty>}
      {isHome&&orders.length>0&&<Link href="/orders">View all orders →</Link>}
    </Panel>}
    {isParcels&&<><div className="page-head"><p className="eyebrow">Warehouse deliveries</p><h1>Parcels</h1><p className="muted">Register the seller’s tracking number and follow incoming and outbound shipments.</p></div><Panel title="Register seller tracking">
      <InboundParcelForm address={addr} carriers={carriers.data?.carriers??[]} orders={data.orders} preferredOrder={parcelOrder} onSave={reload}/>
      <Table headers={["Inbound tracking","Linked orders","Warehouse status","Carrier status"]} rows={data.advices.map((a:Row)=>[
        <Link href={"/parcels/"+a.id}>{a.tracking_norm}</Link>,
        (a.order_numbers??[]).length?a.order_numbers.map((no:string)=><Link key={no} className="code" href={"/orders/"+no}>{no}</Link>):"—",
        label(a.warehouse_state??"awaiting_warehouse"),
        label(a.transport_state)
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
    {isItems&&<><div className="page-head"><p className="eyebrow">Inventory &amp; handling</p><h1>Warehouse items</h1><p className="muted">Review uncommissioned items, commissioned items and active reference samples, or submit handling instructions.</p></div>
    <div className="metric-strip" aria-label="Items summary">
      {[
        ["Warehouse items",data.items.length],
        ["Uncommissioned",data.items.filter((w:Row)=>!w.order_line_id).length],
        ["Commissioned",data.items.filter((w:Row)=>!!w.order_line_id).length],
        ["Active reference samples",(data.references??[]).filter((r:Row)=>r.state==="active"&&!r.expired).length],
      ].map(([name,value])=><div className="metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}
    </div>
    <Panel title="Your items">
      <Table headers={["Item","Package","Scope","Custody","Storage through","Reference status","Instructions"]} rows={data.items.map((w:Row)=>[
        <div><span className="code">{w.code}</span>{w.components?.length>0&&<small className="muted"><br/>Components: {w.components.map((c:Row)=>c.code).join(", ")}</small>}</div>,
        <span className="code">{w.package_code??"—"}</span>,
        w.order_no?<Link className="code" href={"/orders/"+w.order_no}>{w.order_no}</Link>:"Uncommissioned",
        w.identity_state==="quarantined"?"Quarantined":label(w.custody_state),stamp(w.storage_until),
        w.reference_sample?`${w.reference_sample.state==="active"?(w.reference_sample.expired?"Expired":"Active"):"Released"}${w.reference_sample.in_use?" · In comparison":""}`:"—",
        w.instructions.map((i:string)=><label key={i} className="small"><input type="checkbox" checked={batchIds.includes(i)} onChange={e=>setBatchIds(xs=>e.target.checked?[...xs,i]:xs.filter(x=>x!==i))}/> Select for shipping</label>)
      ])}/>
      {!data.items.length&&<Empty>Items will appear after physical warehouse intake and ownership verification.</Empty>}
      {!!batchIds.length&&<Action primary run={async()=>{const b=await request("/dispatch-batches","POST",{disposition_ids:batchIds});await request("/dispatch-batches/"+b.batch_id+"/confirm","POST",{revision:b.revision});setBatchIds([]);reload();}}>Confirm selected items for quoting</Action>}
      {data.batches.map((b:Row)=><div key={b.id} className="notice"><Action run={async()=>{await request("/dispatch-batches/"+b.id+"/confirm","POST",{revision:b.revision});reload();}}>Confirm draft batch</Action></div>)}
    </Panel>
    <Panel title="Reference samples">
      <Table headers={["Item","Revision","Status","Valid through",""]} rows={(data.references??[]).map((r:Row)=>[
        <span className="code">{r.code??r.item_id}</span>,`v${r.revision??1}`,
        <Tag>{r.in_use?"Locked in comparison":r.state==="active"&&r.expired?"Expired":label(r.state)}</Tag>,
        stamp(r.expires_at),
        r.state==="active"&&!r.in_use?<Action run={async()=>{
          const t=await request("/public/terms");
          const termsId=t.terms?.find((x:Row)=>x.kind==="terms")?.id;
          if(!termsId) throw new Error("Service terms are unavailable.");
          await request("/me/reference-samples/"+r.reference_id+"/release","POST",{terms_version_id:termsId,reason:"Customer released reference sample"});
          reload();
        }}>Release reference</Action>:r.in_use?<small>In active comparison</small>:null,
      ])} empty="No reference samples reserved yet. Use the instruction form below to reserve a stored item as a reference sample."/>
    </Panel>
    <Panel title="Request handling for an item">
      <p className="muted">Uncommissioned items can be returned directly to the seller or forwarded to your shipping agent without creating an inspection order.</p>
      <ItemInstructionForm items={data.items.filter((w:Row)=>["stored","received"].includes(w.custody_state)&&w.identity_state!=="quarantined")} onSave={reload}/>
    </Panel></>}
    {isBills&&<><div className="page-head"><p className="eyebrow">Account services</p><h1>Billing</h1><p className="muted">Review shipping quotes, charges and refunds for your inspections.</p></div><Panel title="Quotes awaiting your approval">
      {data.quotes.map((quote:Row)=><FulfillmentQuote key={quote.id} quote={quote} onUpdate={reload}/>)}
      {!data.quotes.length&&<Empty>No new quotes.</Empty>}
    </Panel><Panel title="Charges and refunds">
      <Table headers={["Purpose","Order / Batch","Charge","Refunded","State","Receipt / Attempt",""]} rows={data.bills.map((b:Row)=>[
        <span id={"charge-"+b.charge_item_id}>{label(b.purpose)}</span>,
        (b.order_numbers??[]).length?b.order_numbers.map((no:string)=><Link key={no} className="code" href={"/orders/"+no}>{no}</Link>):b.batch_id?<span className="code">{b.batch_id.slice(0,8)}</span>:"—",
        usd(b.amount_cents),
        usd(b.refunded_cents),
        <Tag>{label(b.state)}</Tag>,
        b.paid_ref?<span className="code">{b.paid_ref}</span>:b.latest_attempt_state?label(b.latest_attempt_state):"—",
        b.state==="open"?<Action run={()=>goCheckout(b.charge_item_id,b.quote_revision)}>Pay</Action>:null
      ])}/>
    </Panel></>}
    {isHelp&&<><div className="page-head"><p className="eyebrow">Account services</p><h1>Support</h1><p className="muted">Open a case or check the warehouse team’s reply.</p></div><Panel title="Open a case"><Form label="Send case" run={async f=>{await request("/me/cases","POST",{subject:text(f,"subject"),message:text(f,"message")});reload();}}>
      <Field name="subject" label="Subject"/><label>Message<textarea name="message" required/></label>
      </Form><Table headers={["Case","Subject","Status"]} rows={data.tickets.map((t:Row)=>[<Link className="code" href={"/support/cases/"+t.id}>{t.public_no}</Link>,t.subject,label(t.state)])}/></Panel></>}
  </>;
}

function AccountSecurity({receivingCode}:{receivingCode:string}) {
  const identities=useLoad("/me/identities");
  const sessions=useLoad("/me/sessions");
  const [reauthChallenge,setReauthChallenge]=useState<{challenge_id:string;demo_code?:string}>();
  const [emailChange,setEmailChange]=useState<{
    new_email:string;current_challenge_id:string;current_demo_code?:string;new_challenge_id:string;new_demo_code?:string;
  }>();
  const refreshAll=()=>{identities.reload();sessions.reload();};
  const info=identities.data;
  const activeIdentities:Row[]=info?.identities??[];
  const emails:Row[]=info?.emails??[];
  const primaryEmail=emails.find(e=>e.is_primary)?.original_email??"—";
  return <>
    <div className="page-head row">
      <div><Link href="/account">← Account overview</Link><p className="eyebrow">CLIENT WORKSPACE / SECURITY</p>
        <h1>Sign-in methods &amp; security</h1>
        <p className="muted">Manage linked sign-in methods, primary contact email, active device sessions, and account status. Your permanent receiving code <span className="code">{receivingCode}</span> never changes.</p>
      </div>
      {info?.reauthenticated?<Tag>Reauthenticated</Tag>:<Tag>Standard session</Tag>}
    </div>
    {(identities.error||sessions.error)&&<ErrorBlock error={identities.error||sessions.error}/>}
    {info?.status==="restricted"&&<div className="notice" role="alert"><strong>Account restricted:</strong> New orders, payments, and outbound instructions are temporarily paused while your existing orders and support cases remain accessible.</div>}
    <Panel title="Recent verification for sensitive changes">
      <p className="muted">Linking or removing sign-in methods, changing your primary email, revoking other sessions, or closing your account requires verification within the last 10 minutes.</p>
      {info?.reauthenticated?<p className="notice" role="status">Your session is verified for sensitive security actions.</p>:
        reauthChallenge?<div className="code-step">
          {reauthChallenge.demo_code&&<p>Test code: <strong className="code">{reauthChallenge.demo_code}</strong></p>}
          <Form key={reauthChallenge.challenge_id} label="Confirm verification code" run={async f=>{
            await request("/auth/reauth/verify","POST",{challenge_id:reauthChallenge.challenge_id,code:text(f,"code")});
            setReauthChallenge(undefined);refreshAll();
          }}>
            <Field name="code" label="6-digit verification code"/>
          </Form>
        </div>:
        <Action primary run={async()=>{
          setReauthChallenge(await request("/auth/reauth/start","POST",{}));
        }}>Send verification code to {primaryEmail}</Action>}
    </Panel>
    <Panel title="Linked sign-in methods">
      <Table headers={["Provider","Identifier","Linked","Last used",""]} rows={activeIdentities.map(i=>[
        i.provider==="email_otp"?"Email verification code":i.provider==="google"?"Google":"Microsoft",
        <span className="code">{i.email??i.issuer}</span>,
        stamp(i.linked_at),
        stamp(i.last_authenticated_at),
        activeIdentities.length>1?<Action run={async()=>{
          await request("/me/identities/"+i.id,"DELETE",{});refreshAll();
        }}>Remove</Action>:<small className="muted">Last sign-in method</small>
      ])} empty="No active sign-in methods found."/>
      <div className="actions">
        {(["google","microsoft"] as const).filter(p=>!activeIdentities.some(i=>i.provider===p)).map(provider=>
          <Action key={provider} run={async()=>{
            const res=await request("/me/identities/"+provider+"/link","POST",{});
            if(res.redirect_url) location.assign(res.redirect_url);
            else refreshAll();
          }}>Link {provider==="google"?"Google":"Microsoft"}</Action>)}
      </div>
    </Panel>
    <Panel title="Primary contact &amp; sign-in email">
      <p>Current primary email: <strong>{primaryEmail}</strong></p>
      {emailChange?<div className="code-step">
        <p>Verify both your current email (<strong>{primaryEmail}</strong>) and new email (<strong>{emailChange.new_email}</strong>).</p>
        {(emailChange.current_demo_code||emailChange.new_demo_code)&&<p className="small">
          Current code: <span className="code">{emailChange.current_demo_code}</span> · New code: <span className="code">{emailChange.new_demo_code}</span>
        </p>}
        <Form key={emailChange.new_challenge_id} label="Confirm email change" run={async f=>{
          await request("/me/email-change/confirm","POST",{
            current_challenge_id:emailChange.current_challenge_id,
            current_code:text(f,"current_code"),
            new_challenge_id:emailChange.new_challenge_id,
            new_code:text(f,"new_code"),
          });
          setEmailChange(undefined);refreshAll();
        }}>
          <Field name="current_code" label="Code sent to current email"/>
          <Field name="new_code" label="Code sent to new email"/>
        </Form>
        <button type="button" onClick={()=>setEmailChange(undefined)}>Cancel email change</button>
      </div>:<Form label="Send verification codes" run={async f=>{
        const newEmail=text(f,"new_email");
        const res=await request("/me/email-change/request","POST",{new_email:newEmail});
        setEmailChange({new_email:newEmail,...res});
      }}>
        <Field name="new_email" label="New primary email address" type="email"/>
      </Form>}
    </Panel>
    <Panel title="Active device sessions">
      <Table headers={["Session","Created","Last active","Expires",""]} rows={(sessions.data?.sessions??[]).map((s:Row)=>[
        s.current?<strong>Current device</strong>:"Signed-in device",
        stamp(s.created_at),stamp(s.last_seen_at),stamp(s.expires_at),
        !s.current?<Action run={async()=>{await request("/me/sessions/"+s.id,"DELETE",{});sessions.reload();}}>Revoke</Action>:null
      ])} empty="No active sessions."/>
      {(sessions.data?.sessions??[]).some((s:Row)=>!s.current)&&<Action run={async()=>{
        await request("/me/sessions/revoke-others","POST",{});sessions.reload();
      }}>Sign out all other devices</Action>}
    </Panel>
    <Panel title="Privacy, data export &amp; retention policy (PAGE-C16)">
      <p className="muted">Download a machine-readable archive of your account, orders, items, charges, and consent records, or submit a formal privacy request.</p>
      <div className="actions">
        <a className="button" href="/api/v1/me/privacy/export" target="_blank" rel="noreferrer">Download personal data JSON</a>
        <Action run={async()=>{
          await request("/me/privacy/requests","POST",{kind:"export",note:"Customer requested personal data archive"});
          refreshAll();
        }}>Request formal data export</Action>
        <Action run={async()=>{
          await request("/me/privacy/requests","POST",{kind:"deletion",note:"Customer requested account deletion review"});
          refreshAll();
        }}>Request data deletion review</Action>
      </div>
    </Panel>
    <Panel title="Close account">
      <p className="muted">You can close your account when there are no active orders, stored warehouse items, or unpaid charges. Historical audit and financial records are retained per policy.</p>
      <Action run={async()=>{
        await request("/me/account/close","POST",{});
        location.assign("/login");
      }}>Close my account</Action>
    </Panel>
  </>;
}

function FulfillmentQuote({quote,onUpdate}:{quote:Row;onUpdate?:()=>void}) {
  const shipping=quote.purpose==="dispatch";
  const {snapshot}=quote;
  const purpose=shipping?({return_to_seller:"Return to seller",to_forwarder:"Send to freight forwarder",to_domestic_address:"Domestic delivery"} as Record<string,string>)[quote.action]:"Extend storage";
  return <article id={"quote-"+quote.id} className="card fulfillment-quote">
    <div className="row"><div><h3>{purpose}</h3><small>Quote {quote.revision} · expires {stamp(quote.expires_at)}</small></div>
      <strong>{usd(quote.amount_cents)}</strong></div>
    {shipping?<>
      <p><strong>Destination</strong> · {snapshot.destination.recipient} · {snapshot.destination.address}
        {snapshot.destination.member_code&&<> · Member {snapshot.destination.member_code}</>}</p>
      <Table headers={["Parcel","Warehouse item codes","Weight","Shipping"]} rows={snapshot.parcels.map((parcel:Row,i:number)=>[
        i+1,<span className="code">{parcel.item_ids.map((id:string)=>quote.item_codes?.[id]??id).join(", ")}</span>,
        parcel.weight_g+" g",usd(parcel.amount_cents),
      ])}/>
      <p>Handling · {usd(snapshot.handling_cents)}</p>
    </>:<p>{snapshot.days} additional days · <span className="code">{Object.values(quote.item_codes).join(", ")}</span></p>}
    {(quote.state===undefined||quote.state==="open")&&<Action primary run={async()=>{
      const charge=await request("/quotes/"+quote.id+"/accept","POST",{revision:quote.revision});
      try {await goCheckout(charge.charge_item_id,quote.revision);} finally {onUpdate?.();}
    }}>Accept and pay</Action>}
    {quote.state==="accepted"&&quote.charge_id&&<Action primary run={()=>goCheckout(quote.charge_id,quote.revision)}>Resume payment</Action>}
    {quote.state==="processing"&&<p role="status">Payment is processing.</p>}
    {quote.state==="paid"&&<Tag>Payment confirmed</Tag>}
    {quote.state==="expired"&&<p className="notice">This quote has expired. Review the latest quote from your order when the warehouse issues it.</p>}
    {quote.state==="inactive"&&<Empty>This quote is closed.</Empty>}
  </article>;
}

const actionTitles:Record<string,string>={
  draft:"Continue inspection draft",awaiting_payment:"Review inspection payment",awaiting_samples:"Register seller tracking",
  return_to_seller:"Review seller return quote",to_forwarder:"Review forwarding quote",to_domestic_address:"Review domestic shipping quote",
  retain:"Review storage extension",needs_carrier:"Confirm parcel carrier",needs_verification:"Verify parcel tracking",waiting_customer:"Review support case",
  dispatch:"Review shipping payment",storage:"Review storage payment",
  bounced:"We couldn't deliver email to this address",complained:"We couldn't deliver email to this address",
  reference_expired:"Update expired reference sample",reference_conflict:"Resolve reference sample in use before shipping",
  storage_expiring:"Storage expiring soon — choose handling or extend",storage_expired:"Storage expired — choose handling or extend",
};
export function CustomerActions() {
  const {data,error,reload}=useLoad("/actions");
  return <>
    <div className="page-head row"><div><p className="eyebrow">CLIENT WORKSPACE / ACTIONS</p><h1>Action required</h1>
      <p className="muted">Continue work that needs your input. Quotes with deadlines are shown first.</p></div>
      <button type="button" onClick={reload}>Refresh actions</button></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading actions…</p>}
    {data&&!error&&<Panel title="Your next actions"><Table headers={["Action","Reference","Due",""]} rows={data.rows.map((row:Row)=>{
      const href=row.kind==="order"?"/orders/"+row.reference+(row.state==="awaiting_payment"?"/payment":row.state==="awaiting_samples"?"/parcels":""):row.kind==="parcel"?"/parcels/"+row.id:
        row.kind==="quote"||row.kind==="charge"?"/account/billing#"+row.kind+"-"+row.id:
        row.kind==="scope"?"/orders/"+row.reference+"#scope-"+row.id:
        row.kind==="reference"||row.kind==="storage"?"/items":
        row.kind==="email"?"/account":"/support/cases/"+row.id;
      return [row.kind==="scope"?"Review inspection scope":actionTitles[row.state],row.reference?<span className="code">{row.reference}</span>:"—",stamp(row.due_at),<Link href={href}>Open</Link>];
    })} empty="You’re all caught up. New actions will appear here when an order, parcel, quote or case needs your input."/></Panel>}
  </>;
}

function InboundParcelForm({address,carriers,orderId,orders=[],preferredOrder,onSave}:{
  address:Row|null;carriers:Row[];orderId?:string;orders?:Row[];preferredOrder?:string|null;onSave:()=>void;
}) {
  const [saved,setSaved]=useState<string>();
  if(!address)return <Empty>The warehouse address is awaiting configuration.</Empty>;
  return <>
    <Form key={saved} label="Add inbound parcel" run={async f=>{
      const carrier=text(f,"carrier"),order=orderId??text(f,"order");
      const tracking=text(f,"tracking");
      await request("/me/parcels","POST",{address_id:address.id,tracking_no:tracking,
        ...(carrier?{carrier_code:carrier}:{}),order_ids:order?[order]:[]});
      setSaved(tracking);onSave();
    }}><Field name="tracking" label="Seller’s tracking number"/>
      <Select name="carrier" label="Carrier" required={false} choices={carriers.map(c=>({id:c.code,label:c.labels.en}))}/>
      {!orderId&&<Select key={preferredOrder} name="order" label="Associate an order (optional)" required={false}
        value={orders.some(o=>o.id===preferredOrder)?preferredOrder??undefined:undefined}
        choices={orders.map(o=>({id:o.id,label:o.public_no}))}/>}
    </Form>
    {saved&&<p className="notice" role="status">Registered seller tracking <strong className="code">{saved}</strong>.</p>}
  </>;
}

function ItemInstructionForm({items,orderId,storage=false,onSave}:{
  items:Row[];orderId?:string;storage?:boolean;onSave:()=>void;
}) {
  const terms=useLoad("/public/terms");
  const [action,setAction]=useState(storage?"retain":"return_to_seller");
  const [saved,setSaved]=useState<string>();
  const currentAction=storage?"retain":action;
  const needsDestination=!["retain","reserve_reference"].includes(currentAction);
  const termsId=terms.data?.terms.find((t:Row)=>t.kind==="terms")?.id;
  if(!items.length)return <Empty>No items are available for a new instruction.</Empty>;
  if(terms.error)return <ErrorBlock error={terms.error}/>;
  if(!termsId)return <p role="status">Waiting for the current service terms.</p>;
  return <>
    <Form key={saved} label={storage?"Request storage extension":"Save handling instruction"} run={async f=>{
      const itemId=text(f,"item");
      const item=items.find(row=>row.item_id===itemId);
      if(!item||!checked(f,"agree"))throw new Error("Confirm the selected item and instruction.");
      const destination=needsDestination?{recipient:text(f,"recipient"),phone:text(f,"phone"),address:text(f,"address"),
        ...(currentAction==="to_forwarder"?{member_code:text(f,"member_code")}:{})}:undefined;
      const deadline=text(f,"deadline");
      const retainDays=currentAction==="retain"?Number(text(f,"days")||30):undefined;
      const result=await request(orderId?"/orders/"+orderId+"/dispositions":"/me/items/"+itemId+"/dispositions","POST",{
        ...(orderId?{item_id:itemId}:{}),action:currentAction,terms_version_id:termsId,...(destination?{destination}:{}),
        ...(retainDays?{days:retainDays}:{}),
        ...(currentAction==="return_to_seller"?{return_info:{requested_from_seller:true,customer_pays_shipping:true,
          ...(deadline?{deadline:new Date(deadline).toISOString()}:{})}}:{}),
      });
      setSaved(result.id);onSave();
    }}>
      <Select name="item" label="Item" choices={items.map(item=>({id:item.item_id,label:item.code}))}/>
      {!storage&&<label>Requested action<select value={action} onChange={e=>setAction(e.target.value)}>
        <option value="return_to_seller">Return to seller</option><option value="to_forwarder">Send to freight forwarder</option>
        <option value="to_domestic_address">Send to a domestic address</option><option value="retain">Extend storage</option>
        <option value="reserve_reference">Reserve as reference sample (90 days)</option></select></label>}
      {currentAction==="retain"&&<Field name="days" label="Additional storage days" type="number" value={30}/>}
      {needsDestination&&<><Field name="recipient" label="Recipient"/><Field name="phone" label="Destination phone"/>
        <label>{currentAction==="return_to_seller"?"Return address supplied by your seller":"Destination address"}<textarea name="address" required/></label></>}
      {currentAction==="to_forwarder"&&<Field name="member_code" label="Forwarder member code"/>}
      {currentAction==="return_to_seller"&&<Field name="deadline" label="Seller’s return deadline (your local time)" type="datetime-local" required={false}/>}
      <label className="check"><input name="agree" required type="checkbox"/>{currentAction==="return_to_seller"?
        "I have arranged the return with my seller and will pay the return shipping fee.":"I authorize this request subject to the current terms and quote."}</label>
    </Form>
    {saved&&<p className="notice" role="status">Your instruction was recorded.</p>}
  </>;
}

function OrderHandling({order,storage,onSave}:{order:Row;storage:boolean;onSave:()=>void}) {
  const [selected,setSelected]=useState<string[]>([]);
  const items:Row[]=order.items.filter((item:Row)=>item.item_id);
  const allowed=["report_ready","action_pending","cancelled","closed"].includes(order.state);
  const eligible=allowed?items.filter(item=>!item.instruction&&["stored","received"].includes(item.custody_state)):[];
  const awaiting=items.filter(item=>item.instruction?.awaiting_batch);
  const selection=selected.filter(id=>awaiting.some(item=>item.instruction.id===id));
  return <>
    <Panel title={storage?"Storage by item":"Instructions by item"}>
      <Table headers={["Item","Warehouse status","Storage through","Paid through","Active instruction"]} rows={items.map(item=>[
        <span className="code">{item.code}</span>,label(item.custody_state),stamp(item.storage_until),stamp(item.paid_storage_until),
        item.instruction?<><Tag>{label(item.instruction.action)}</Tag>{!storage&&item.instruction.awaiting_batch&&
          <label className="small"><input type="checkbox" checked={selection.includes(item.instruction.id)} onChange={e=>
            setSelected(current=>e.target.checked?[...current,item.instruction.id]:current.filter(id=>id!==item.instruction.id))}/> Select for shipping</label>}
          {item.instruction.state==="requested"&&<Action run={async()=>{
            await request("/me/dispositions/"+item.instruction.id+"/cancel","POST",{});onSave();
          }}>Cancel</Action>}</>:"—",
      ])} empty="No warehouse items are linked to this inspection."/>
      {!storage&&selection.length>0&&<Action primary run={async()=>{
        const batch=await request("/dispatch-batches","POST",{disposition_ids:selection});
        setSelected([]);onSave();
        await request("/dispatch-batches/"+batch.batch_id+"/confirm","POST",{revision:batch.revision});
        onSave();
      }}>Confirm selected items for quoting</Action>}
      <p><Link href={storage?"/orders/"+order.public_no+"/dispositions":"/account/billing"}>{storage?"Review other handling options":"Open shipping and storage quotes"}</Link></p>
      {!storage&&<p className="muted">Use the account’s warehouse items page to combine eligible items across your orders or recover a draft batch.</p>}
    </Panel>
    <Panel title={storage?"Storage quotes":"Shipping and storage quotes"}>
      <Table headers={["Action","Quote version","Amount","Status","Expires"]} rows={order.quotes.filter((q:Row)=>!storage||q.purpose==="storage").map((q:Row)=>[
        label(q.action),<Link href={"/orders/"+order.public_no+"/quotes/"+q.id}>Version {q.revision}</Link>,usd(q.amount_cents),
        <Tag>{label(q.state)}</Tag>,stamp(q.expires_at),
      ])} empty="No fulfillment quotes are linked to this inspection."/>
    </Panel>
    <Panel title={storage?"Request more storage time":"Give the warehouse an instruction"}>
      {!allowed?<Empty>Item handling becomes available after the inspection is complete or cancelled.</Empty>:
        <ItemInstructionForm key={String(storage)} items={eligible} orderId={order.id} storage={storage} onSave={onSave}/>}
    </Panel>
    {!storage&&<Panel title="Parcels handed over to a carrier">
      <Table headers={["Handling","Actual tracking number","Warehouse handover"]} rows={order.shipments.map((shipment:Row)=>[
        label(shipment.action),<Link className="code" href={"/orders/"+order.public_no+"/shipments/"+shipment.id}>{shipment.tracking_norm}</Link>,stamp(shipment.shipped_at),
      ])} empty="The warehouse has not handed over any parcels linked to this order."/>
    </Panel>}
  </>;
}

export function OrderFulfillment({order,id,kind}:{order:string;id:string;kind:"quotes"|"shipments"}) {
  const lookup=useLoad("/orders/by-number/"+order);
  const record=useLoad(lookup.data?"/orders/"+lookup.data.id+"/"+kind+"/"+id:null);
  const data=record.data;
  const error=lookup.error||record.error;
  const destination=data?.destination_snapshot;
  return <>
    <div className="page-head"><Link href={"/orders/"+order+"/dispositions"}>← Order item instructions</Link>
      <p className="eyebrow report-eyebrow">CLIENT WORKSPACE / FULFILLMENT</p>
      <h1>{kind==="quotes"?"Fulfillment quote":"Shipment details"}</h1><p className="code">{order}</p></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading the order record…</p>}
    {data&&kind==="quotes"&&<FulfillmentQuote quote={data} onUpdate={record.reload}/>}
    {data&&kind==="shipments"&&<>
      <Panel title="Warehouse handover">
        <dl className="location-facts">
          <div><dt>Handling</dt><dd>{label(data.action)}</dd></div>
          <div><dt>Tracking number</dt><dd className="code">{data.tracking_norm}</dd></div>
          <div><dt>Handed to carrier</dt><dd>{stamp(data.shipped_at)}</dd></div>
          <div><dt>Recorded weight</dt><dd>{data.weight_g} g</dd></div>
          <div><dt>Destination</dt><dd>{destination.recipient} · {destination.address}{destination.member_code?" · "+destination.member_code:""}</dd></div>
        </dl>
        <Table headers={["Item code","Returned to warehouse"]} rows={(data.items??[]).map((item:Row)=>[
          <span className="code">{item.code}</span>,stamp(item.returned_at),
        ])}/>
      </Panel>
      <TrackView kind="shipments" id={id} embedded/>
    </>}
  </>;
}
