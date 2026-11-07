import Link from "next/link";
import { cookies } from "next/headers";
import { actorForSession } from "../packages/core/auth";
import { isDemo } from "../packages/core/common";
import { staffHome } from "../packages/core/portal-routes";
import { PlatformIcon, PublicHeader, SiteFooter } from "./chrome";
import { CategoryCoverage } from "./category-coverage";
import { SampleReportPreview } from "./report-guide";

const capabilities = [
  ["packages","China Receiving Center","Send items from your chosen suppliers"],
  ["inspection","Category-Based Procedures","Approved templates for each product type"],
  ["reports","Structured Evidence","Measurements, photos and observations"],
  ["dispatch","Flexible Item Handling","Store, forward or return on instruction"],
];
const services = [
  ["inspection","Product Inspection","Document appearance, applicable measurements and visible workmanship, item by item.","/services/inspection"],
  ["compare","Sample Comparison","Compare similar samples using consistent criteria and side-by-side evidence.","/services/compare"],
  ["packages","Golden Sample Matching","Compare new items with an approved reference, with measurable differences documented.","/services/reference"],
];
const steps = [
  ["orders","Create an order","Choose the category, service and inspection scope."],
  ["packages","Send your items","Use your personal receiving address and register the seller’s waybill."],
  ["scan","Receive & identify","We register the parcel and assign a traceable ID to each item."],
  ["inspection","Inspect & record","We follow the approved checklist and attach evidence."],
  ["reports","Review & handle","Read the report and decide where each item goes next."],
];

export default async function Home() {
  const actor=await actorForSession((await cookies()).get("session")?.value);
  const accountHref=actor?.kind==="customer"?"/account":actor?staffHome(actor.roles):undefined;
  return <>
    <PublicHeader accountHref={accountHref} staff={actor?.kind==="staff"} actor={actor} demo={isDemo()}/>
    <main className="marketing" id="main-content">
      <section className="marketing-hero" aria-labelledby="home-title">
        <div className="hero-inner">
          <p className="hero-kicker">Independent product inspection in China</p>
          <h1 id="home-title">Product Inspection &amp;<br/> Sample Comparison<br/> in China</h1>
          <p>Receive, inspect and compare physical product samples before international shipping. Review measurements, observations and photos for the items you send.</p>
          <div className="hero-buttons"><Link className="button primary" href="/orders/new">Start an Inspection →</Link><Link className="button hero-secondary" href="/report-guide">Explore Sample Report</Link></div>
          <ul className="hero-trust">{["Evidence-based checks","Per-item traceability","Independent reporting"].map(value=><li key={value}><span aria-hidden="true">✓</span>{value}</li>)}</ul>
        </div>
      </section>
      <ul className="infra-strip">{capabilities.map(([icon,title,description])=><li className="infra-item" key={title}>
        <span className="symbol"><PlatformIcon name={icon}/></span><div><strong>{title}</strong><small>{description}</small></div>
      </li>)}</ul>
      <section className="land-section" aria-labelledby="home-services">
        <div className="land-heading"><div><p className="eyebrow">What we do</p><h2 id="home-services">Inspection services built around real samples</h2><p>The approved inspection template for your product category defines the checks we can perform.</p></div><Link className="button" href="/catalog">All services →</Link></div>
        <div className="land-services">{services.map(([icon,title,description,href])=><Link className="land-svc" key={href} href={href}><span className="symbol"><PlatformIcon name={icon}/></span><h3>{title}</h3><p>{description}</p><span className="go">View service →</span></Link>)}</div>
      </section>
      <section className="land-section" aria-labelledby="home-process">
        <div className="land-heading"><div><p className="eyebrow">How it works</p><h2 id="home-process">A traceable process, from arrival to report</h2><p>Your items remain yours throughout the inspection and warehouse handling.</p></div><Link className="button" href="/how-it-works">Process details →</Link></div>
        <ol className="land-process">{steps.map(([icon,title,description],index)=><li className="land-step" key={title}><span className="step-index"><PlatformIcon name={icon}/>{String(index+1).padStart(2,"0")}</span><h3>{title}</h3><p>{description}</p></li>)}</ol>
      </section>
      <section className="land-section" aria-labelledby="home-categories">
        <div className="land-heading"><div><p className="eyebrow">Category coverage</p><h2 id="home-categories">One platform. Category-specific inspection.</h2><p>Apparel is the launch category. Further categories require validated equipment, procedures and operating approval.</p></div><Link className="button" href="/categories">Category details →</Link></div>
        <CategoryCoverage/>
      </section>
      <section className="land-section" aria-labelledby="home-report">
        <div className="land-heading"><div><p className="eyebrow">The deliverable</p><h2 id="home-report">Reports you can actually use</h2><p>Review what was checked, how it was measured and which observations have photos.</p></div></div>
        <div className="land-report"><SampleReportPreview/>
          <div><h3>Every finding connected to evidence.</h3><p>Review results by item and report version. The report describes the scope and lists checks that were outside it.</p>
            <ul className="proof-list">{["Traceable item IDs and reference numbers","Photos and recorded visible defects","Measurements with the method and unit","Scope, limitations and checks outside scope"].map(item=><li key={item}>{item}</li>)}</ul>
            <Link className="button primary" href="/report-guide">View Sample Report →</Link>
          </div>
        </div>
      </section>
      <section className="land-cta"><div className="inner"><div><h2>Inspect before you ship.<br/> Compare before you commit.</h2><p>Start with the products you already purchase from China.</p></div><Link className="button primary" href="/orders/new">Create an Inspection →</Link></div></section>
    </main>
    <SiteFooter/>
  </>;
}
