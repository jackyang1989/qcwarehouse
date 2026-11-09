"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { legalPages, servicePages } from "../packages/core/portal-routes";
import { Empty, ErrorBlock, Panel, Tabs, usd, useLoad } from "./ui";

export type CatalogCheck = {
  key: string;
  label: string;
  zh?: string;
  type: "boolean" | "number" | "text";
  unit?: string;
  method: string;
  required?: boolean;
  evidence?: boolean;
};

export type CatalogOffer = {
  offer_id: string;
  sku_code: string;
  service: "inspection" | "compare" | "reference_match";
  title: { en: string; "zh-CN"?: string };
  category_id: string;
  category: { en: string; "zh-CN"?: string };
  template_version_id: string;
  content: {
    subcategory?: string;
    checks: CatalogCheck[];
    parts?: Array<string | { code: string; label: string }>;
  };
  rules: {
    minimum: number;
    maximum: number;
    unit_cents?: number;
    package_cents?: number;
    business_days: number;
    demo?: boolean;
  };
};

const SUBCATEGORY_LABELS: Record<string, string> = {
  general: "General Apparel Template",
  tops: "Tops, T-Shirts & Knitwear Template",
  bottoms: "Bottoms, Pants & Leggings Template",
  sports_bra: "Sports Bra & Activewear Template",
};

function subcategoryLabel(sub?: string): string {
  if (!sub) return SUBCATEGORY_LABELS.general;
  return SUBCATEGORY_LABELS[sub] ?? sub;
}

function summarizeRate(pool: CatalogOffer[], suffix: string): string {
  const vals = pool
    .map((o) => Number(o.rules.unit_cents ?? o.rules.package_cents ?? 0))
    .filter((n) => n > 0);
  if (!vals.length) return "Quote on request";
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? `${usd(lo)} ${suffix}` : `${usd(lo)}–${usd(hi)} ${suffix}`;
}

function packageSummary(offer: CatalogOffer): { useCase: string; coreScope: string; billingBasis: string } {
  const sub = offer.content?.subcategory ?? "general";
  const checkCount = offer.content?.checks?.length ?? 0;
  if (offer.service === "compare") {
    const n = offer.rules.minimum;
    const subText =
      sub === "tops"
        ? "T-shirts, hoodies, knitwear, and upper-body tops"
        : sub === "bottoms"
          ? "leggings, trousers, joggers, and shorts"
          : "apparel styles";
    return {
      useCase: `Side-by-side comparison of ${n} candidate supplier samples for ${subText}.`,
      coreScope: `Synchronized group photo, ${checkCount}-point measurement delta table & workmanship notes`,
      billingBasis: `Fixed ${n}-item comparison set · Est. ${offer.rules.business_days} business days`,
    };
  }
  if (offer.service === "reference_match") {
    return {
      useCase: "Benchmark 1 incoming pre-production or restock sample against 1 sealed Golden Sample in your account.",
      coreScope: `Paired Reference-vs-Incoming photos, ${checkCount}-point dimensional & shade drift check`,
      billingBasis: `Billed per incoming item match · Est. ${offer.rules.business_days} business days`,
    };
  }
  const useCaseBySub: Record<string, string> = {
    general: "Individual sample evaluation (1–3 pcs) or small-batch screening (10–100 pcs) for dresses, outerwear, and mixed apparel.",
    tops: "Individual sample evaluation or small-batch screening (1–100 pcs) for T-shirts, hoodies, polos, sweaters, and knitwear.",
    bottoms: "Individual sample evaluation or small-batch screening (1–100 pcs) for leggings, pants, denim, joggers, and shorts.",
    sports_bra: "Individual sample evaluation or small-batch screening (1–100 pcs) for sports bras, crop tanks, and activewear tops.",
  };
  const scopeBySub: Record<string, string> = {
    general: `${checkCount} checkpoints · Flat width, workmanship, label check & mandatory angle photos`,
    tops: `${checkCount} checkpoints · HPS length, 1/2 chest, shoulder, sleeve, collar rib & seam scan`,
    bottoms: `${checkCount} checkpoints · Waist, hip, front/back rise, inseam, outseam, leg opening & gusset`,
    sports_bra: `${checkCount} checkpoints · Underband, bust width, strap symmetry, lining/pad & seam scan`,
  };
  return {
    useCase: useCaseBySub[sub] ?? useCaseBySub.general,
    coreScope: scopeBySub[sub] ?? `${checkCount} template checkpoints + mandatory studio photos`,
    billingBasis: `Billed per physical item (1–${offer.rules.maximum} items online) · Est. ${offer.rules.business_days} business days`,
  };
}

function PackageCard({ offer }: { offer: CatalogOffer }) {
  const isUnit = offer.rules.unit_cents != null;
  const cents = offer.rules.unit_cents ?? offer.rules.package_cents ?? 0;
  const checks = offer.content?.checks ?? [];
  const { useCase, coreScope, billingBasis } = packageSummary(offer);

  return (
    <article className="pub-package-card">
      <div>
        <div className="row flexwrap" style={{ gap: 8, marginBottom: 6 }}>
          <span className="tag blue">{subcategoryLabel(offer.content?.subcategory)}</span>
          {offer.rules.demo && (
            <span className="tag yellow" title="Active pre-launch / demo catalog schedule">
              Pre-launch / Demo Rate
            </span>
          )}
        </div>
        <h3>{offer.title.en}</h3>
        <p className="pub-package-usecase">{useCase}</p>
        <div className="pub-package-meta">
          <span className="pub-package-scope-pill">{coreScope}</span>
          <span aria-hidden="true">·</span>
          <span><strong>Billing:</strong> {billingBasis}</span>
        </div>
        {checks.length > 0 && (
          <details className="pub-package-checks">
            <summary>View {checks.length} detailed checkpoints</summary>
            <div className="pub-chip-row">
              {checks.map((c) => (
                <span className="pub-chip" key={c.key}>
                  {c.label}{c.unit ? ` (${c.unit})` : ""}
                </span>
              ))}
              <span className="pub-sku-ref" title="Catalog SKU code">SKU: {offer.sku_code}</span>
            </div>
          </details>
        )}
      </div>
      <div className="pub-package-right">
        <div className="pub-package-price">
          <strong>{usd(cents)}</strong>
          <small>{isUnit ? "per physical item" : offer.service === "reference_match" ? "per incoming item match" : "per comparison set"}</small>
        </div>
        <Link className="button primary" href={`/orders/new?offer=${offer.offer_id}`}>
          Select Package →
        </Link>
      </div>
    </article>
  );
}

/* ==========================================================================
   ROUTER FOR /catalog, /services/*, /categories, /pricing
   ========================================================================== */
export function PublicCatalogRouter({ path }: { path: string }) {
  if (path === "/categories") return <PublicCategories />;
  if (path === "/pricing") return <PublicPricing />;
  if (path in servicePages) {
    const code = servicePages[path as keyof typeof servicePages];
    return <PublicServiceDetail path={path} serviceCode={code} />;
  }
  return <PublicServicesOverview />;
}

/* ==========================================================================
   PAGE 02 — SERVICES OVERVIEW (/catalog)
   ========================================================================== */
export function PublicServicesOverview() {
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);
  const primaryInspOffer = inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0];
  const primaryCompOffer = compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0];
  const primaryRefOffer = refOffers[0];
  const inspHref = primaryInspOffer ? `/orders/new?offer=${primaryInspOffer.offer_id}` : "/orders/new";
  const compHref = primaryCompOffer ? `/orders/new?offer=${primaryCompOffer.offer_id}` : "/orders/new";
  const refHref = primaryRefOffer ? `/orders/new?offer=${primaryRefOffer.offer_id}` : "/orders/new";

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>Inspection Services</strong>
      </div>

      {/* 1. Services Overview */}
      <section className="pub-page-hero">
        <div className="pub-page-hero-grid">
          <div>
            <p className="pub-eyebrow">01 · SERVICES OVERVIEW · CHINA RECEIVING CENTER</p>
            <h1>Independent Product Inspection &amp; Sample Comparison Services</h1>
            <p>
              Ship supplier samples or small-batch inventory from any Chinese seller to QCWarehouse. Choose piece-by-piece inspection, 2–3 supplier sample comparison, or Golden Sample matching—then decide how each physical item should be routed.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Start an Inspection →
              </Link>
              <a className="button" href="#packages">
                Browse Active Packages
              </a>
              <Link className="button" href="/report-guide">
                View Sample Report
              </Link>
            </div>
          </div>
          <figure className="pub-page-hero-media ratio-wide" style={{ margin: 0 }}>
            <img
              src="/brand/inspection-hero.webp"
              alt="QCWarehouse inspector wearing a navy uniform and white cotton gloves measuring a gray cotton top with a metric tape on an inspection table"
              width={1460}
              height={696}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      <Tabs
        path="/catalog"
        links={[
          ["/catalog", "All Services"],
          ["/services/inspection", "Product Inspection"],
          ["/services/compare", "Sample Comparison"],
          ["/services/reference", "Golden Sample Matching"],
        ]}
      />

      {/* Side-by-Side Service Comparison Matrix */}
      <section className="card pub-block" aria-labelledby="service-matrix-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>WHICH SERVICE FITS YOUR ORDER?</p>
            <h2 id="service-matrix-heading">Compare Our Three Core Services</h2>
            <p>Pick the workflow that matches your stage—shortlisting suppliers, checking small-batch inventory, or verifying a reorder.</p>
          </div>
        </div>
        <div className="tablewrap pub-compare-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Product Inspection</th>
                <th>Sample Comparison</th>
                <th>Golden Sample Matching</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Primary Use Case</strong></td>
                <td>Check 1 prototype or 10–100+ small-batch units individually before export</td>
                <td>Evaluate 2 or 3 candidate samples from different suppliers side by side</td>
                <td>Verify a new pre-production or restock piece against your retained Golden Sample</td>
              </tr>
              <tr>
                <td><strong>Eligible Quantity</strong></td>
                <td><strong>1–100 items</strong> online (101–300 via staff quote)</td>
                <td><strong>2 or 3 comparable items</strong> per group</td>
                <td><strong>1 incoming item</strong> per retained Golden Sample line</td>
              </tr>
              <tr>
                <td><strong>Billing Basis</strong></td>
                <td>Per physical item ({summarizeRate(inspOffers, "/ item")})</td>
                <td>Per 2- or 3-item group ({summarizeRate(compOffers, "/ group")})</td>
                <td>Per incoming match ({summarizeRate(refOffers, "/ match")})</td>
              </tr>
              <tr>
                <td><strong>Core Evidence</strong></td>
                <td>Unique item ID, 0.1 cm tape photos &amp; defect coordinate boxes</td>
                <td>Unified measurement delta table + single-frame group photo</td>
                <td>Paired Reference-vs-Incoming photos &amp; variance log</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-compare-mobile">
          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>Product Inspection</h3>
              <span className="pub-price-chip">{summarizeRate(inspOffers, "/ item")}</span>
            </div>
            <dl>
              <div>
                <dt>Primary Use Case</dt>
                <dd>Check 1 prototype or 10–100+ small-batch units individually before export</dd>
              </div>
              <div>
                <dt>Eligible Quantity</dt>
                <dd><strong>1–100 items</strong> online (101–300 via staff quote)</dd>
              </div>
              <div>
                <dt>Core Evidence</dt>
                <dd>Unique item ID, 0.1 cm tape photos &amp; defect coordinate boxes</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={inspHref}>Configure Product Inspection →</Link>
              <Link className="button sm" href="/services/inspection">Details</Link>
            </div>
          </article>

          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>Sample Comparison</h3>
              <span className="pub-price-chip">{summarizeRate(compOffers, "/ group")}</span>
            </div>
            <dl>
              <div>
                <dt>Primary Use Case</dt>
                <dd>Evaluate 2 or 3 candidate samples from different suppliers side by side</dd>
              </div>
              <div>
                <dt>Eligible Quantity</dt>
                <dd><strong>2 or 3 comparable items</strong> per group</dd>
              </div>
              <div>
                <dt>Core Evidence</dt>
                <dd>Unified measurement delta table + single-frame group photo</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={compHref}>Configure Sample Comparison →</Link>
              <Link className="button sm" href="/services/compare">Details</Link>
            </div>
          </article>

          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>Golden Sample Matching</h3>
              <span className="pub-price-chip">{summarizeRate(refOffers, "/ match")}</span>
            </div>
            <dl>
              <div>
                <dt>Primary Use Case</dt>
                <dd>Verify a new pre-production or restock piece against your retained Golden Sample</dd>
              </div>
              <div>
                <dt>Eligible Quantity</dt>
                <dd><strong>1 incoming item</strong> per retained Golden Sample line</dd>
              </div>
              <div>
                <dt>Core Evidence</dt>
                <dd>Paired Reference-vs-Incoming photos &amp; variance log</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={refHref}>Configure Golden Sample Matching →</Link>
              <Link className="button sm" href="/services/reference">Details</Link>
            </div>
          </article>
        </div>
        <details className="pub-details-drawer">
          <summary>Additional service rules: post-report routing, prerequisites &amp; tolerance handling</summary>
          <div className="pub-details-grid">
            <div>
              <strong>Post-Report Item Routing</strong>
              <p>Every inspected unit across all three services can be instructed individually after report publication: return specific items domestically to your seller, retain an approved unit as a sealed Golden Sample, store temporarily, or consolidate eligible stock to your freight forwarder.</p>
            </div>
            <div>
              <strong>Golden Sample Prerequisite</strong>
              <p>Golden Sample Matching requires an already-inspected unit converted and sealed in our protected reference storage before placing a matching line. Product Inspection and Sample Comparison have no prior inventory prerequisite.</p>
            </div>
            <div>
              <strong>Target Tolerance Rules</strong>
              <p>You may submit target dimensions and seller references when ordering. Any measurement reading deviating beyond stated thresholds automatically triggers an independent two-pass bench re-check recorded in your report snapshot.</p>
            </div>
          </div>
        </details>
      </section>

      {/* 2. Product Inspection */}
      <section className="pub-service-detail" id="product-inspection" aria-labelledby="svc-inspection-title">
        <div>
          <p className="pub-eyebrow">02 · SERVICE 01 — INDIVIDUAL SAMPLE &amp; SMALL-BATCH VERIFICATION</p>
          <h2 id="svc-inspection-title" className="pub-h2">Product Inspection (1 to 100+ Items)</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            Built for both <strong>detailed sample inspection (1–3 prototype units)</strong> and <strong>small-batch piece-by-piece screening (10, 30, 50, or 100 stock units)</strong> where random factory AQL sampling leaves defects undetected.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>Ideal Scenarios</span>
              <strong>1–3 sample prototype checks &amp; 10–100+ unit Shopify / TikTok small batches</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>1–100 items online · 101–300 via manual bench capacity quote</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Bench Method</span>
              <strong>Individual barcode ID, flat metric tape measurements + two-pass re-checks</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Checks every physical unit against its checklist rather than grouping suppliers</strong>
            </div>
          </div>
          <p className="small muted" style={{ marginBottom: 14 }}>
            <strong>Scope boundary:</strong> Covers non-destructive visual and dimensional checks on physical arrivals—not destructive lab fiber testing, wash shrinkage, or compliance certification.
          </p>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={inspHref}>
              Configure Product Inspection →
            </Link>
            <Link className="button sm" href="/services/inspection">
              Product Inspection Details
            </Link>
          </div>
        </div>
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-item-inspection.webp"
              alt="QCWarehouse inspector wearing white cotton gloves measuring a slate-blue cotton sweatshirt with a yellow metric tape beside a blank sample card"
              width={1350}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      {/* 3. Sample Comparison */}
      <section className="pub-service-detail reverse" id="sample-comparison" aria-labelledby="svc-compare-title">
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-three-samples.webp"
              alt="Overhead studio comparison showing three unbranded cotton T-shirts from separate factories inspected side by side with caliper and metric tape on a neutral table"
              width={1350}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
        <div>
          <p className="pub-eyebrow">03 · SERVICE 02 — SUPPLIER &amp; BATCH SELECTION</p>
          <h2 id="svc-compare-title" className="pub-h2">Sample Comparison (2 or 3 Comparable Items)</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            Marketplace photos rarely reveal true weight, rib recovery, or sizing drift. Send samples from 2 or 3 shortlisted sellers and evaluate them together on the same bench under identical lighting.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>Ideal Scenarios</span>
              <strong>Shortlisting 2–3 factories on 1688 or Alibaba before placing bulk orders</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>2 or 3 items of the same product category per comparison set</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Bench Method</span>
              <strong>Synchronized group overhead photo, matching landmarks &amp; digital gram mass</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Produces a single delta comparison matrix; we document facts while you choose</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={compHref}>
              Configure Sample Comparison →
            </Link>
            <Link className="button sm" href="/services/compare">
              Sample Comparison Details
            </Link>
          </div>
        </div>
      </section>

      {/* 4. Golden Sample Matching */}
      <section className="pub-service-detail" id="golden-sample-matching" aria-labelledby="svc-reference-title">
        <div>
          <p className="pub-eyebrow">04 · SERVICE 03 — REORDER &amp; PRE-PRODUCTION CONTROL</p>
          <h2 id="svc-reference-title" className="pub-h2">Golden Sample / Reference Matching</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            Catch silent fabric swaps or sizing changes on repeat shipments. Keep your approved Golden Sample sealed in our dedicated reference storage and benchmark incoming units directly against it.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>How Setup Works</span>
              <strong>Convert an inspected sample online → sealed in protected reference storage</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>1 incoming sample matched to 1 active retained Golden Sample per line</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Bench Method</span>
              <strong>Direct side-by-side placement, flat dimensional variance &amp; visual shade check</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Requires an active sealed Golden Sample already stored under your account</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={refHref}>
              Configure Golden Sample Matching →
            </Link>
            <Link className="button sm" href="/services/reference">
              Golden Sample Details
            </Link>
          </div>
        </div>
        <figure className="pub-photo-box ratio-3-2">
          <img
            src="/marketing/service-golden-matching.webp"
            alt="QCWarehouse inspector in white cotton gloves comparing two identical dark navy sweatshirts side by side next to a clear protective storage zip bag"
            width={1350}
            height={900}
            loading="eager"
          />
        </figure>

        <div className="pub-service-subrow">
          <div>
            <p className="pub-eyebrow">SECURE REFERENCE SAMPLE STORAGE &amp; CUSTODY</p>
            <h3 style={{ fontSize: "1.22rem", color: "#0f213a", margin: "0 0 10px" }}>
              Secure Reference Sample Storage Between Reorders
            </h3>
            <p className="pub-lead" style={{ fontSize: 14, marginBottom: 14 }}>
              After any inspection or comparison order, convert an approved unit into your retained Golden Sample. We seal it inside an individually barcoded protective bag in our lockable reference sample storage cabinet so future restock shipments are checked against the exact physical garment you signed off.
            </p>
            <div className="pub-meta-grid" style={{ margin: 0 }}>
              <div className="pub-meta-cell">
                <span>Golden Sample Retention</span>
                <strong>90-day active sealed reference window upon conversion</strong>
              </div>
              <div className="pub-meta-cell">
                <span>Extended Storage Rate</span>
                <strong>$0.25 / item / day ($7.50 per 30-day storage extension)</strong>
              </div>
              <div className="pub-meta-cell">
                <span>Chain of Custody</span>
                <strong>Tamper-evident seal + lockable reference cabinet tracking</strong>
              </div>
              <div className="pub-meta-cell">
                <span>Post-Match Handling</span>
                <strong>Automatically resealed &amp; returned to cabinet after each check</strong>
              </div>
            </div>
          </div>
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-reference-storage.webp"
              alt="Dedicated lockable steel reference sample storage cabinet with tamper-sealed clear garment sleeves and white-gloved custody handling"
              width={1200}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      {/* 5. Inspection Evidence, Deliverables & Explicit Boundaries */}
      <section className="pub-block" aria-labelledby="deliverables-boundaries-title">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">05 · DELIVERABLES &amp; SERVICE BOUNDARIES</p>
            <h2 id="deliverables-boundaries-title">What You Receive—and What We Never Claim</h2>
            <p className="pub-lead" style={{ fontSize: 14.5 }}>
              Every reviewed inspection report separates verified bench observations from laboratory testing or on-site factory audits—giving commercial buyers clean evidence before shipping from China.
            </p>
          </div>
          <Link className="button primary sm" href="/report-guide">
            Explore Full Sample Report →
          </Link>
        </div>

        <div className="pub-deliverables-preview">
          <div className="pub-deliverables-cards">
            <div className="pub-deliverable-mini">
              <span className="code">01 · TRACEABLE LOG</span>
              <strong>Arrival &amp; Individual Item IDs</strong>
              <p>Outer parcel condition notes plus unique barcodes tying every photo back to one piece.</p>
            </div>
            <div className="pub-deliverable-mini">
              <span className="code">02 · MEASUREMENTS &amp; PHOTOS</span>
              <strong>0.1 cm Readings &amp; Red-Box Overlays</strong>
              <p>Two-pass re-checks on variances plus coordinate overlays over untouched raw captures.</p>
            </div>
            <div className="pub-deliverable-mini">
              <span className="code">03 · REVIEWED INSPECTION REPORT</span>
              <strong>English QA Review, PDF &amp; Routing</strong>
              <p>Reviewed online inspection report (locked version) and matching PDF synced with item-by-item routing choices.</p>
            </div>
          </div>
          <Link className="button sm" href="/report-guide" style={{ flexShrink: 0 }}>
            View Live Walkthrough →
          </Link>
        </div>
        <div className="pub-boundary-grid">
          <div className="pub-boundary-box included">
            <h3 style={{ color: "#0b816b" }}>Included in QCWarehouse Reports</h3>
            <ul className="pub-check-list">
              <li><b className="mark-ok">✓</b><span>Parcel arrival verification, carton condition notes, and unique barcode ID per garment</span></li>
              <li><b className="mark-ok">✓</b><span>Mandatory garment overview, care-label, and metric tape-in-frame measurement photos</span></li>
              <li><b className="mark-ok">✓</b><span>Recorded flat dimensions (0.1 cm precision) with automatic two-pass re-measurement logs</span></li>
              <li><b className="mark-ok">✓</b><span>Non-destructive UI red bounding boxes and English reviewer translations on observed defects</span></li>
              <li><b className="mark-ok">✓</b><span>Reviewed online inspection report (locked version history) + matching PDF + post-report routing controls</span></li>
            </ul>
          </div>
          <div className="pub-boundary-box excluded">
            <h3 style={{ color: "#b24046" }}>Outside QCWarehouse Service Scope</h3>
            <ul className="pub-check-list">
              <li><b className="mark-no">✕</b><span><strong>No Laboratory or Chemical Testing:</strong> No fiber composition %, azo dyes, heavy metals, or destructive GSM cutting.</span></li>
              <li><b className="mark-no">✕</b><span><strong>No Full Product Safety or Regulatory Certification</strong> (CPSIA, REACH, CE, flammability).</span></li>
              <li><b className="mark-no">✕</b><span><strong>No Factory-Wide On-Site AQL Audits:</strong> Findings apply only to the physical units received at our China facility.</span></li>
              <li><b className="mark-no">✕</b><span><strong>No Brand Authenticity Verification</strong> and <strong>no guarantee of defect-free merchandise</strong>.</span></li>
              <li><b className="mark-no">✕</b><span><strong>No Customs Clearance or Seller Refund Guarantee:</strong> We execute domestic China dispatch; customs and seller refunds stay with your forwarder and supplier.</span></li>
            </ul>
          </div>
        </div>
      </section>

      {/* 6. Available Service Packages (Live Catalog) */}
      <section className="pub-block" id="packages" aria-labelledby="packages-heading">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">06 · ACTIVE APPAREL PACKAGES</p>
            <h2 id="packages-heading">Available Service Packages &amp; Templates</h2>
            <p className="pub-lead" style={{ fontSize: 14.5 }}>
              Pulled live from QCWarehouse’s published service catalog. Choose a general apparel package or a dedicated subcategory template with tailored measurement landmarks.
            </p>
          </div>
          <Link className="button" href="/pricing">
            Open Interactive Fee Calculator →
          </Link>
        </div>

        {hasDemoRates && (
          <div className="line-note warning" style={{ marginBottom: 18 }}>
            <strong>Active catalog notice:</strong> Current packages carry pre-launch / demo pricing metadata from the active server schedule. Confirmed order quotes lock your exact rate before payment.
          </div>
        )}

        {error && (
          <div className="card">
            <ErrorBlock error={error} />
            <button type="button" className="button sm" onClick={reload}>Retry loading catalog</button>
          </div>
        )}
        {!data && !error && <p role="status" className="muted">Loading published service packages…</p>}
        {data && offers.length === 0 && <Empty>No published packages are currently open for checkout. Contact support for custom scope.</Empty>}

        {inspOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>Piece-by-Piece Product Inspection Packages</h3>
              <span className="small muted">Priced per physical item · 1–100 items self-serve</span>
            </div>
            <div className="pub-package-list">
              {inspOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}

        {compOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>Side-by-Side Sample Comparison Packages</h3>
              <span className="small muted">Priced per comparison group · 2 or 3 comparable items</span>
            </div>
            <div className="pub-package-list">
              {compOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}

        {refOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>Golden Sample Reference Matching Packages</h3>
              <span className="small muted">Requires an active sealed reference sample in your account</span>
            </div>
            <div className="pub-package-list">
              {refOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}
      </section>

      {/* 7. Service FAQ & Final CTA */}
      <section className="card pub-block" aria-labelledby="services-faq-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>07 · COMMON SERVICE QUESTIONS</p>
            <h2 id="services-faq-heading">Choosing the Right Inspection Setup</h2>
          </div>
          <Link className="button sm" href="/faq">All FAQs →</Link>
        </div>
        <div className="faq-group">
          <details className="faq-item" open>
            <summary>Should I choose General Apparel Inspection or a Subcategory Template (Tops / Bottoms / Sports Bra)?</summary>
            <p>
              Choose a <strong>Subcategory Template</strong> whenever your items are T-shirts, hoodies, knitwear, leggings, pants, or sports bras—those templates include dedicated anatomical measurement points (such as HPS length, front/back rise, inseam, or underband width) and diagram guidance. Use <strong>General Apparel</strong> for mixed outerwear, dresses, or simpler visual + flat-width checks.
            </p>
          </details>
          <details className="faq-item">
            <summary>Can I combine defect returns and freight-forwarder shipping on the same inspection order?</summary>
            <p>
              Yes. Post-inspection handling is instructed item by item. If 38 units look right and 2 units have documented stains or sizing errors, you can instruct us to return the 2 defective units to your seller’s China return address and consolidate the 38 approved units to your freight forwarder.
            </p>
          </details>
          <details className="faq-item">
            <summary>What if I need to inspect more than 100 items or an unlisted garment type?</summary>
            <p>
              Draft orders between 101 and 300 items automatically route to a manual staff quote so our receiving center can confirm bench turnaround before you pay. For larger volumes or custom checkpoints, contact our team before shipping parcels.
            </p>
          </details>
        </div>
      </section>

      <div className="pub-cta-banner">
        <div>
          <h2>Ready to Inspect Samples or Small-Batch Stock in China?</h2>
          <p>Configure your scope in minutes, get your permanent China receiving code, or ask our team to confirm checkpoint feasibility before you order from your supplier.</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">Start an Inspection →</Link>
          <Link className="button pub-btn-ghost" href="/contact?topic=scope">Ask About Custom Scope</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   DEDICATED SERVICE DETAIL PAGES (/services/inspection | compare | reference)
   ========================================================================== */
const SERVICE_HERO_CONFIG = {
  inspection: {
    eyebrow: "SERVICE DETAIL · INDIVIDUAL SAMPLE & SMALL-BATCH INSPECTION",
    title: "Product Inspection in China (1 to 100+ Items)",
    lead: "Send 1–3 prototype samples for detailed evaluation or 10–100+ small-batch stock garments for piece-by-piece screening at our China receiving center. Every physical unit gets its own barcode ID, approved template measurements, workmanship check, and documented photo proof.",
    image: "/marketing/service-item-inspection.webp",
    imageAlt: "QCWarehouse inspector wearing white cotton gloves measuring a slate-blue cotton sweatshirt with a yellow metric tape and sample card",
    ratioClass: "",
    idealFor: "Detailed sample checks (1–3 prototypes) and small-batch inventory screening (10–100+ pcs) before international shipping.",
    quantities: "1–100 items self-serve online · 101–300 items via manual staff capacity quote.",
    method: "Individual item check-in, unstrained flat-lay metric tape measurements (0.1 cm precision + two-pass re-checks), digital garment weight, and zone-by-zone visual workmanship scan.",
    distinction: "Unlike Sample Comparison, each item is evaluated individually rather than grouped into a 2–3 supplier comparison matrix.",
  },
  compare: {
    eyebrow: "SERVICE DETAIL · SIDE-BY-SIDE EVALUATION",
    title: "Supplier Sample Comparison Service (2–3 Items)",
    lead: "Evaluating multiple 1688, Alibaba, or direct factories? Ship 2 or 3 comparable apparel samples to our studio so we can measure, weigh, and photograph them together under identical conditions.",
    image: "/marketing/service-three-samples.webp",
    imageAlt: "Overhead studio photo comparing three candidate factory T-shirt samples laid flat under neutral studio lighting beside a caliper and metric tape",
    ratioClass: "",
    idealFor: "Founders and buyers choosing between 2–3 candidate manufacturers before placing bulk deposits or custom label runs.",
    quantities: "2 or 3 comparable items from the same product category per comparison package.",
    method: "Synchronized overhead group photography, identical flat-lay tape placement across every sample, digital gram weight comparison, and collar/seam macro documentation.",
    distinction: "Priced per 2- or 3-item comparison group with a unified delta table. We record objective physical differences; you make the commercial supplier selection.",
  },
  reference_match: {
    eyebrow: "SERVICE DETAIL · BENCHMARK CONSISTENCY",
    title: "Golden Sample & Reference Matching in China",
    lead: "Keep your approved Golden Sample sealed in QCWarehouse’s secure reference sample storage and benchmark new pre-production or reorder samples directly against your physical standard.",
    image: "/marketing/service-golden-matching.webp",
    imageAlt: "Side-by-side comparison showing an approved navy Golden Sample beside a sealed clear storage sleeve and an incoming production sample",
    ratioClass: "",
    idealFor: "Repeat SKU reorders, new factory transitions, and pre-production approval against a signed-off prototype.",
    quantities: "1 incoming sample compared against 1 active retained Golden Sample per order line.",
    method: "Controlled retrieval of your sealed Golden Sample, side-by-side flat measurement delta check, visual shade/rib/stitching comparison, and resealing into storage.",
    distinction: "Requires an active Golden Sample already stored in your QCWarehouse account (converted from a prior inspected item).",
  },
} as const;

export function PublicServiceDetail({
  path,
  serviceCode,
}: {
  path: string;
  serviceCode: "inspection" | "compare" | "reference_match";
}) {
  const { data, error, reload } = useLoad("/catalog");
  const allOffers: CatalogOffer[] = data?.offers ?? [];
  const offers = allOffers.filter((o) => o.service === serviceCode);
  const cfg = SERVICE_HERO_CONFIG[serviceCode];
  const [selectedOfferId, setSelectedOfferId] = useState<string>("");

  useEffect(() => {
    if (offers.length && !offers.some((o) => o.offer_id === selectedOfferId)) {
      setSelectedOfferId(offers[0].offer_id);
    }
  }, [offers, selectedOfferId]);

  const previewOffer = offers.find((o) => o.offer_id === selectedOfferId) ?? offers[0];

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <Link href="/catalog">Services</Link>
        <span aria-hidden="true">›</span>
        <strong>{cfg.title}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-grid">
          <div>
            <p className="pub-eyebrow">{cfg.eyebrow}</p>
            <h1>{cfg.title}</h1>
            <p>{cfg.lead}</p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link
                className="button primary"
                href={previewOffer ? `/orders/new?offer=${previewOffer.offer_id}` : "/orders/new"}
              >
                Start This Service →
              </Link>
              <Link className="button" href="/report-guide">
                View Sample Report
              </Link>
              <Link className="button" href="/pricing">
                Estimate Fee
              </Link>
            </div>
          </div>
          <figure className={`pub-page-hero-media${cfg.ratioClass ? ` ${cfg.ratioClass}` : ""}`} style={{ margin: 0 }}>
            <img src={cfg.image} alt={cfg.imageAlt} width={1350} height={900} loading="eager" />
          </figure>
        </div>
      </section>

      <Tabs
        path={path}
        links={[
          ["/catalog", "All Services"],
          ["/services/inspection", "Product Inspection"],
          ["/services/compare", "Sample Comparison"],
          ["/services/reference", "Golden Sample Matching"],
        ]}
      />

      <div className="pub-split-2 pub-block">
        <section className="pub-surface-box">
          <p className="pub-eyebrow" style={{ marginBottom: 0 }}>OPERATING SPECIFICATION</p>
          <h2 className="pub-h2" style={{ fontSize: "1.35rem" }}>How This Service Operates</h2>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>Who It Is For</span>
              <strong>{cfg.idealFor}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Supported Quantity</span>
              <strong>{cfg.quantities}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Bench Method</span>
              <strong>{cfg.method}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>{cfg.distinction}</strong>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #e6edf6", paddingTop: 16, marginTop: 4, display: "grid", gap: 12 }}>
            <p className="pub-eyebrow" style={{ marginBottom: 0 }}>
              {serviceCode === "reference_match"
                ? "SECURE REFERENCE SAMPLE STORAGE & RESEALING"
                : "DELIVERABLES & POST-REPORT ROUTING"}
            </p>
            {serviceCode === "reference_match" ? (
              <>
                <figure className="pub-photo-box ratio-3-2">
                  <img
                    src="/marketing/service-reference-storage.webp"
                    alt="Dedicated lockable steel reference sample storage cabinet with tamper-sealed clear garment sleeves and white-gloved custody handling"
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                </figure>
                <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
                  Approved Golden Samples stay sealed inside tamper-evident protective sleeves in our lockable reference sample storage cabinet (90-day active Golden Sample retention window upon conversion; extended storage billed at $0.25 / item / day, i.e., $7.50 per 30 days). After each comparison, the reference unit is resealed and logged back into storage.
                </p>
              </>
            ) : (
              <ul className="pub-check-list" style={{ marginTop: 0 }}>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>Traceable Item Barcodes:</strong> Every arriving unit receives a unique sample ID linking its intake scan, flat tape readings, and photos.</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>Two-Pass Measurement Verification:</strong> Out-of-tolerance readings trigger an automatic second independent tape pass with both raw values logged.</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>Non-Destructive Defect Overlays:</strong> Reviewer-verified red coordinate boxes highlight defects in the web UI without altering original camera files.</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>Per-Item Post-Report Disposition:</strong> Choose per unit whether to return to the seller in China, retain as a Golden Sample, or forward to your freight forwarder.</span>
                </li>
              </ul>
            )}
          </div>
        </section>

        <section className="pub-surface-box">
          <p className="pub-eyebrow" style={{ marginBottom: 0 }}>LIVE TEMPLATE CHECKPOINTS</p>
          <h2 className="pub-h2" style={{ fontSize: "1.35rem" }}>Inspectable Checkpoints in Active Catalog</h2>
          {offers.length > 1 && (
            <div className="pub-filter-pills" style={{ marginBottom: 4 }}>
              {offers.map((o) => (
                <button
                  key={o.offer_id}
                  type="button"
                  className={`pub-filter-pill${previewOffer?.offer_id === o.offer_id ? " active" : ""}`}
                  onClick={() => setSelectedOfferId(o.offer_id)}
                >
                  {o.title.en}
                </button>
              ))}
            </div>
          )}
          {previewOffer ? (
            <div className="checklist">
              {previewOffer.content.checks.map((chk) => (
                <div className="checkrow" key={chk.key}>
                  <span className="tag blue">{chk.type === "number" ? chk.unit ?? "measure" : "visual"}</span>
                  <div>
                    <strong>{chk.label}</strong>
                    <div className="small muted">{chk.method}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Loading template checkpoints…</p>
          )}
        </section>
      </div>

      {/* Filtered Live Packages */}
      <section className="pub-block" aria-labelledby="detail-packages-title">
        <div className="pub-package-group-head">
          <h2 id="detail-packages-title">Available Packages for This Service</h2>
          <span className="small muted">Server-verified pricing &amp; turnaround</span>
        </div>
        {error && (
          <div className="card">
            <ErrorBlock error={error} />
            <button type="button" className="button sm" onClick={reload}>Retry</button>
          </div>
        )}
        <div className="pub-package-list">
          {offers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
        </div>
      </section>

      <div className="line-note" style={{ marginBottom: 24 }}>
        <strong>Scope reminder:</strong> QCWarehouse checks commissioned visual and dimensional items on the received samples only. Laboratory chemical/fiber testing, wash durability, brand authenticity, and factory-wide AQL certification are not included.
      </div>
    </>
  );
}

/* ==========================================================================
   PAGE 03 — PRODUCT CATEGORIES (/categories)
   ========================================================================== */
const PLANNED_AND_RESTRICTED = [
  {
    name: "Footwear",
    status: "Planned",
    tone: "yellow",
    note: "Awaiting outsole flexing, pair-symmetry gauge, and sizing-stick template sign-off. Not open for checkout yet.",
  },
  {
    name: "Bags & Soft Accessories",
    status: "Planned",
    tone: "yellow",
    note: "Hardware zipper-cycle, strap stitching, and structured gusset measurement templates are in preparation.",
  },
  {
    name: "Home & Textile Lifestyle",
    status: "Planned",
    tone: "yellow",
    note: "Flat soft-home goods will open after oversized bench surface and folding-return packaging SOPs are finalized.",
  },
  {
    name: "Electronics & Battery Devices",
    status: "Restricted",
    tone: "red",
    note: "Electrical safety, firmware, battery transport regulations, and functional load testing are outside QCWarehouse scope.",
  },
  {
    name: "Toys & Children’s Regulated Goods",
    status: "Restricted",
    tone: "red",
    note: "Requires accredited CPSIA / EN71 small-parts and chemical safety laboratories rather than visual receiving inspection.",
  },
  {
    name: "Hazardous, Pressurized & Perishable Goods",
    status: "Prohibited",
    tone: "red",
    note: "Liquids, cosmetics, food, aerosols, and counterfeit/infringing branded goods must not be shipped to our facility.",
  },
] as const;

type DiagramTrack = {
  id: "tops" | "bottoms" | "sports_bra";
  title: string;
  src: string;
  note: string;
};

const MEASUREMENT_DIAGRAMS: DiagramTrack[] = [
  {
    id: "tops",
    title: "Tops, T-Shirts, Hoodies & Knitwear",
    src: "/diagrams/tops.svg",
    note: "Landmark definitions for HPS front length, flat 1/2 chest width (2.5 cm below armhole), across shoulder, sleeve length, and hem.",
  },
  {
    id: "bottoms",
    title: "Leggings, Pants, Joggers & Shorts",
    src: "/diagrams/leggings.svg",
    note: "Landmark definitions for unstrained flat waistband (1/2), hip width, front rise, inseam, outseam, and leg opening.",
  },
  {
    id: "sports_bra",
    title: "Sports Bras & Intimate Activewear",
    src: "/diagrams/sports_bra.svg",
    note: "Landmark definitions for strap-to-hem vertical length, flat bust width, underband width, and side-seam height.",
  },
];

export function PublicCategories() {
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const [activeDiagram, setActiveDiagram] = useState<DiagramTrack | null>(null);

  useEffect(() => {
    if (!activeDiagram) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveDiagram(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeDiagram]);

  const findSubOffer = (sub?: string) =>
    inspOffers.find((o) => (o.content?.subcategory ?? "general") === (sub ?? "general")) ?? inspOffers[0];

  const topsOffer = findSubOffer("tops");
  const bottomsOffer = findSubOffer("bottoms");
  const braOffer = findSubOffer("sports_bra");
  const generalOffer = findSubOffer("general");

  const apparelSubtracks = [
    {
      title: "Tops, T-Shirts, Hoodies & Knitwear",
      examples: "Crewneck tees, oversized hoodies, polo shirts, sweaters, zip jackets",
      checks: "HPS length, chest width (1/2), shoulder, sleeve, hem sweep, collar rib & seams",
      image: "/marketing/category-tops-knitwear.webp",
      imageAlt: "Flat-lay inspection of a heather-gray crewneck T-shirt on a white studio bench",
      diagramId: "tops" as const,
      offer: topsOffer,
    },
    {
      title: "Leggings, Pants, Joggers & Shorts",
      examples: "Activewear leggings, woven trousers, denim, sweatpants, athletic shorts",
      checks: "Relaxed waistband, hip width, front/back rise, inseam, outseam, leg opening & gusset",
      image: "/marketing/category-bottoms-leggings.webp",
      imageAlt: "Flat-lay inspection of charcoal athletic leggings with waist and inseam measurement landmarks",
      diagramId: "bottoms" as const,
      offer: bottomsOffer,
    },
    {
      title: "Sports Bras & Intimate Activewear",
      examples: "Medium/high-support sports bras, crop tanks, moulded-cup bralettes",
      checks: "Underband width, bust width, strap symmetry, removable pad/lining check & seams",
      image: "/marketing/category-sports-bra.webp",
      imageAlt: "Flat-lay inspection of an athletic sports bra with underband, strap, and cup symmetry checks",
      diagramId: "sports_bra" as const,
      offer: braOffer,
    },
    {
      title: "General Apparel & Mixed Garments",
      examples: "Dresses, skirts, light outerwear, scarves, or standard visual + flat-width checks",
      checks: "Key workmanship zones, flat width, size/care label check & mandatory overview photos",
      image: "/marketing/category-general-apparel.webp",
      imageAlt:
        "Overhead flat-lay of general apparel including a sage-green woven dress, oatmeal midi skirt, and slate-navy lightweight jacket beside a yellow metric tape and L-square ruler",
      diagramId: null,
      offer: generalOffer,
    },
  ];

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>Product Categories</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">SUPPORTED MERCHANDISE · WHAT CAN YOU INSPECT TODAY?</p>
            <h1>What Products Can You Inspect Today?</h1>
            <p style={{ marginBottom: 18 }}>
              <strong>Apparel is open for orders today.</strong> Rather than claiming generic checks on every category, QCWarehouse launches a category only after dedicated templates, lighting, and flat-lay measurement benchmarks are active on our bench.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Start Apparel Inspection →
              </Link>
              <Link className="button" href="/report-guide">
                View Sample Apparel Report
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>Live Category</span>
              <strong>Apparel · 4 Template Tracks</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Measurement Standard</span>
              <strong>Flat-Lay Metric Tape (0.1 cm)</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Inspection Scope</span>
              <strong>1–100+ Units · 2–3 Sample Compare</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Roadmap Categories</span>
              <strong>Footwear, Bags &amp; Home Goods</strong>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>Retry</button>
        </div>
      )}

      {/* Primary Live Category: Apparel */}
      <section className="pub-apparel-spotlight" aria-labelledby="apparel-live-heading">
        <div className="pub-apparel-spotlight-head">
          <div>
            <div className="row flexwrap" style={{ gap: 8, marginBottom: 10 }}>
              <span className="tag green">OPEN FOR ORDERS TODAY</span>
              <span className="tag blue">{offers.length || 9} Active Apparel Packages</span>
            </div>
            <h2 id="apparel-live-heading" className="pub-h2">
              Apparel, Knitwear &amp; Activewear
            </h2>
            <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 16 }}>
              Available across Product Inspection (1–100+ items), Sample Comparison (2–3 items), and Golden Sample Matching. Select your garment type below to pre-select the matching checklist template.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link
                className="button primary"
                href={generalOffer ? `/orders/new?offer=${generalOffer.offer_id}` : "/orders/new"}
              >
                Start Apparel Inspection →
              </Link>
              <Link className="button" href="/catalog#packages">
                Compare Apparel Packages
              </Link>
              <button
                type="button"
                className="button"
                onClick={() => setActiveDiagram(MEASUREMENT_DIAGRAMS[0])}
              >
                View Measurement Diagrams
              </button>
            </div>
          </div>
        </div>

        <div className="pub-subcat-grid">
          {apparelSubtracks.map((track) => {
            const cents = track.offer?.rules.unit_cents;
            const diagramObj = track.diagramId
              ? MEASUREMENT_DIAGRAMS.find((d) => d.id === track.diagramId) ?? null
              : null;
            return (
              <article className="pub-subcat-card" key={track.title}>
                <div className="pub-subcat-media">
                  <img
                    src={track.image}
                    alt={track.imageAlt}
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                </div>
                <div className="row between flexwrap" style={{ gap: 8 }}>
                  <h3>{track.title}</h3>
                  {cents != null && (
                    <span className="pub-price-chip">{usd(cents)} / item</span>
                  )}
                </div>
                <p className="small" style={{ margin: 0, color: "#263b54" }}>
                  <strong>Typical items:</strong> {track.examples}
                </p>
                <p className="small muted" style={{ margin: 0 }}>
                  <strong>Key checks:</strong> {track.checks}
                </p>
                <div className="row flexwrap" style={{ gap: 8, marginTop: "auto", paddingTop: 6 }}>
                  <Link
                    className="button primary sm"
                    href={track.offer ? `/orders/new?offer=${track.offer.offer_id}` : "/orders/new"}
                  >
                    Inspect This Garment Type →
                  </Link>
                  {diagramObj && (
                    <button
                      type="button"
                      className="button sm"
                      onClick={() => setActiveDiagram(diagramObj)}
                    >
                      Measurement Diagram
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Secondary Downgraded Section: Planned & Restricted Categories */}
      <section className="pub-block pub-future-section" aria-labelledby="future-categories-heading">
        <div className="pub-section-head" style={{ marginBottom: 14 }}>
          <div>
            <p className="pub-eyebrow" style={{ color: "#64748b" }}>PLANNED &amp; RESTRICTED CATEGORIES</p>
            <h2 id="future-categories-heading" style={{ fontSize: "1.22rem", color: "#334155" }}>
              Categories Not Open for Checkout
            </h2>
            <p className="small muted" style={{ margin: 0, maxWidth: "70ch" }}>
              Do not ship non-apparel goods to QCWarehouse without written operational confirmation. Footwear, bags, and home goods remain offline while gauges and handling SOPs are finalized.
            </p>
          </div>
          <Link className="button sm" href="/legal/restricted-items">
            Restricted Items Policy →
          </Link>
        </div>

        <div className="pub-future-grid">
          {PLANNED_AND_RESTRICTED.map((item) => (
            <div className="pub-future-card downgraded" key={item.name}>
              <div className="row between" style={{ gap: 8 }}>
                <strong style={{ color: "#334155", fontSize: 13 }}>{item.name}</strong>
                <span className={`tag ${item.tone}`}>{item.status}</span>
              </div>
              <p className="small muted" style={{ margin: 0, lineHeight: 1.5, fontSize: 12 }}>{item.note}</p>
              {item.status === "Planned" && (
                <div style={{ marginTop: "auto", paddingTop: 4 }}>
                  <Link className="small" style={{ color: "#1d4ed8", fontWeight: 650 }} href={`/contact?topic=category&item=${encodeURIComponent(item.name)}`}>
                    Request waitlist notification →
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Interactive Measurement Diagram Reference Modal */}
      {activeDiagram && (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Measurement guide for ${activeDiagram.title}`}
          onClick={() => setActiveDiagram(null)}
        >
          <div className="pub-diagram-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pub-diagram-modal-head">
              <div>
                <p className="pub-eyebrow" style={{ marginBottom: 2 }}>MEASUREMENT LANDMARK REFERENCE</p>
                <strong style={{ fontSize: "1.05rem", color: "#102038" }}>{activeDiagram.title}</strong>
              </div>
              <button type="button" className="button sm" onClick={() => setActiveDiagram(null)}>
                Close Diagram ✕
              </button>
            </div>
            <div className="pub-filter-pills" style={{ marginBottom: 12 }}>
              {MEASUREMENT_DIAGRAMS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`pub-filter-pill${activeDiagram.id === d.id ? " active" : ""}`}
                  onClick={() => setActiveDiagram(d)}
                >
                  {d.title}
                </button>
              ))}
            </div>
            <div className="pub-diagram-stage">
              <img src={activeDiagram.src} alt={`${activeDiagram.title} measurement landmark diagram`} width={520} height={360} />
            </div>
            <p className="small muted" style={{ margin: "12px 0 0" }}>{activeDiagram.note}</p>
          </div>
        </div>
      )}
    </>
  );
}

/* ==========================================================================
   PAGE 04 — HOW IT WORKS (/how-it-works)
   ========================================================================== */
type JourneyStep = {
  num: string;
  owner: string;
  title: string;
  youDo: string;
  weDo: string;
  outcome: string;
  photo: string;
  photoAlt: string;
  uiCropTop?: boolean;
};

const JOURNEY_STEPS: JourneyStep[] = [
  {
    num: "01",
    owner: "Buyer Order & Setup",
    title: "Create Your Inspection Order & Get Your Receiving Code",
    youDo: "Choose Apparel Inspection, Sample Comparison, or Golden Sample Matching and set item quantity.",
    weDo: "Generate your permanent China parcel code alongside our receiving hub address and lock your service quote.",
    outcome: "Ready-to-paste shipping recipient details and a structured checklist awaiting supplier parcels.",
    photo: "/marketing/workflow-create-order-ui.webp",
    photoAlt: "Sanitized screenshot of the QCWarehouse Create an Inspection order interface showing service choices and estimated USD pricing",
    uiCropTop: true,
  },
  {
    num: "02",
    owner: "Direct Supplier Dispatch",
    title: "Buy Directly from Suppliers & Ship Domestic Parcels",
    youDo: "Order from 1688, Alibaba, or direct factories and paste your personal code into the recipient block, then enter tracking numbers.",
    weDo: "Accept separate domestic parcels from one or multiple Chinese sellers—we don't source or sell products.",
    outcome: "Every incoming parcel tracking number pre-linked cleanly to your open order.",
    photo: "/marketing/scenes/hiw-02-supplier-dispatch.svg",
    photoAlt: "Clean schematic showing three domestic supplier parcels routed with personal buyer receiving code to the QCWarehouse intake facility",
  },
  {
    num: "03",
    owner: "Inbound Verification",
    title: "Verify Physical Arrival & Inspect Outer Carton",
    youDo: "Wait for our physical check-in notice rather than relying solely on automated courier ‘Delivered’ alerts.",
    weDo: "Scan the domestic waybill at the dock, weigh incoming cartons, and photograph any exterior crushing or dampness.",
    outcome: "Timestamped arrival record confirming physical parcel custody inside the studio.",
    photo: "/marketing/workflow-parcel-receiving.webp",
    photoAlt: "Warehouse intake operator scanning a domestic courier parcel waybill with a handheld barcode scanner at the QCWarehouse receiving bench",
  },
  {
    num: "04",
    owner: "Item Tagging & Staging",
    title: "Unbox, Count & Assign Individual Sample IDs",
    youDo: "Confirm resolution only if an arriving parcel differs from expected count or arrived without a receiving code.",
    weDo: "Open parcels, match unit counts, attach a unique sample tag to every piece, and stage units in numbered bins.",
    outcome: "Full 1-to-1 physical traceability before measurements or photography begin.",
    photo: "/marketing/workflow-sample-registration.webp",
    photoAlt: "Unbagging and registering individual apparel samples on the intake bench with serialized barcode labels and grey sorting totes",
  },
  {
    num: "05",
    owner: "Bench Execution",
    title: "Measure Dimensions, Photograph & Inspect Workmanship",
    youDo: "Supply optional size tolerances or special focus zones up front so the bench enforces your criteria.",
    weDo: "Lay items flat under neutral lighting, shoot mandatory angles & metric tape photos, weigh units, and re-measure outliers.",
    outcome: "Unedited original bench photos and double-checked millimeter-grade data linked per barcode.",
    photo: "/marketing/workflow-inspection-station.webp",
    photoAlt: "Inspector in white cotton gloves measuring a dark navy sweatshirt on a daylight-calibrated studio table beneath softbox lighting and an overhead camera",
  },
  {
    num: "06",
    owner: "Independent QA Review",
    title: "QA Verification & Reviewed Inspection Report",
    youDo: "Receive instant workspace and email notification once the reviewed report version goes live.",
    weDo: "An independent QA reviewer verifies readings, checks defect coordinate boxes, translates bench notes into English, and locks the PDF.",
    outcome: "Reviewed English inspection report (locked version) and downloadable PDF ready for your buying decision.",
    photo: "/marketing/workflow-qa-review-ui.webp",
    photoAlt: "Sanitized screenshot of the QCWarehouse QA review workbench verifying measurements, Chinese field notes, and English translations",
    uiCropTop: true,
  },
  {
    num: "07",
    owner: "Post-Inspection Routing",
    title: "Choose Per Item: Return, Retain, or Forward Outbound",
    youDo: "Decide item by item: authorize domestic returns to sellers, convert an approved unit into a Golden Sample, or ship good stock to your forwarder.",
    weDo: "Pack approved items per your authorization, quote exact domestic courier postage, dispatch cartons, and upload return or outbound tracking numbers.",
    outcome: "Only approved merchandise leaves China while defects stay behind for domestic resolution.",
    photo: "/marketing/workflow-outbound-routing.webp",
    photoAlt: "Outbound sorting and packing bench with neatly folded garments in clear polybags, export carton, digital scale, and numbered disposition bins",
  },
];

const OPERATIONAL_RULES = [
  {
    title: "1. Independent from your suppliers",
    body: "We don't source or sell products, place orders on marketplaces, or pay factories. Staying independent from your suppliers ensures every report is objective.",
  },
  {
    title: "2. Multi-supplier & split shipments are welcome",
    body: "Comparing three factories or waiting on split parcels? Register each domestic tracking number; inspection turnaround begins once all commissioned items for the order are physically checked in.",
  },
  {
    title: "3. Courier ‘Delivered’ ≠ Verified Warehouse Check-In",
    body: "Domestic couriers often mark gate drop-offs as delivered. Official custody and turnaround timing start only after our staff scans, unboxes, and verifies item counts.",
  },
  {
    title: "4. Every finding is backed by item-linked proof",
    body: "Measurements include stated methods and tape photos; visible defects include close-up images and coordinate overlays tied to the exact sample ID.",
  },
  {
    title: "5. Autonomous item-by-item post-QC routing",
    body: "You never have to ship bad stock overseas just because it arrived in the same box. Split defective pieces for domestic seller return and forward the remaining items.",
  },
  {
    title: "6. Return dispatch does not guarantee seller refunds",
    body: "You arrange return approval and obtain the return address from your seller; QCWarehouse ships the parcel domestically and records the return waybill, while merchandise refunds remain between you and the seller.",
  },
] as const;

export function PublicHowItWorks() {
  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>How It Works</strong>
      </div>

      <section className="pub-page-hero">
        <div className="row between flexwrap" style={{ gap: 18 }}>
          <div>
            <p className="pub-eyebrow">PHYSICAL FULFILLMENT &amp; CUSTODY WORKFLOW</p>
            <h1>How QCWarehouse Works—Step by Step</h1>
            <p style={{ marginBottom: 0 }}>
              Follow all seven physical stages from creating an inspection commission and receiving your permanent parcel code to intake scanning, studio measurement, QA report lock, and item-by-item outbound dispatch.
            </p>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary" href="/orders/new">
              Create an Inspection →
            </Link>
            <Link className="button" href="/report-guide">
              See Sample Report
            </Link>
          </div>
        </div>
      </section>

      {/* 7-Step Visual Physical Flow */}
      <ol className="pub-journey" aria-label="Seven-stage inspection workflow">
        {JOURNEY_STEPS.map((st, idx) => {
          const reverseRow = idx % 2 === 1;
          const mediaEl = (
            <figure className={`pub-photo-box ratio-3-2${st.uiCropTop ? " ui-shot" : ""}`}>
              <img src={st.photo} alt={st.photoAlt} width={1350} height={900} loading="eager" />
            </figure>
          );

          const textEl = (
            <div className="pub-journey-content">
              <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{st.owner}</p>
              <h2 style={{ fontSize: "1.18rem", margin: "0 0 10px" }}>{st.title}</h2>
              <dl className="pub-step-triple">
                <div>
                  <dt>What you do</dt>
                  <dd>{st.youDo}</dd>
                </div>
                <div>
                  <dt>QCWarehouse does</dt>
                  <dd>{st.weDo}</dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{st.outcome}</dd>
                </div>
              </dl>
            </div>
          );

          return (
            <li key={st.num} className={`pub-journey-step${reverseRow ? " reverse" : ""}`}>
              <span className="pub-journey-badge">{st.num}</span>
              {reverseRow ? (
                <>
                  {mediaEl}
                  {textEl}
                </>
              ) : (
                <>
                  {textEl}
                  {mediaEl}
                </>
              )}
            </li>
          );
        })}
      </ol>

      {/* 6 Essential Operational Truths */}
      <section className="pub-block" aria-labelledby="ops-rules-heading">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">OPERATING BOUNDARIES &amp; EXPECTATIONS</p>
            <h2 id="ops-rules-heading">Six Practical Rules Before You Ship Parcels</h2>
          </div>
        </div>
        <div className="pub-rules-grid">
          {OPERATIONAL_RULES.map((rule) => (
            <article className="pub-rule-card" key={rule.title}>
              <h3>{rule.title}</h3>
              <p>{rule.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Simplified Secondary Responsibility Matrix */}
      <section className="card pub-block" aria-labelledby="resp-matrix-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>QUICK REFERENCE</p>
            <h2 id="resp-matrix-heading" style={{ fontSize: "1.2rem" }}>Role &amp; Responsibility Summary</h2>
          </div>
        </div>
        <div className="tablewrap pub-resp-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>Stage</th>
                <th>You (Buyer)</th>
                <th>Chinese Seller</th>
                <th>QCWarehouse</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Merchandise Purchase</strong></td>
                <td>Select supplier, pay for goods &amp; share receiving code</td>
                <td>Ship parcel domestically in China</td>
                <td>Not involved (independent third party)</td>
              </tr>
              <tr>
                <td><strong>Inbound Arrival</strong></td>
                <td>Register seller’s courier tracking number</td>
                <td>Provide accurate waybill &amp; packing count</td>
                <td>Verify physical receipt, carton state &amp; item IDs</td>
              </tr>
              <tr>
                <td><strong>Physical Inspection</strong></td>
                <td>Select template &amp; optional target specs</td>
                <td>—</td>
                <td>Execute checklist, photos, re-measurements &amp; QA review</td>
              </tr>
              <tr>
                <td><strong>Seller Returns</strong></td>
                <td>Agree return with seller, supply return address &amp; pay return postage</td>
                <td>Receive return &amp; process merchandise refund</td>
                <td>Pack authorized items, hand over to courier &amp; log waybill</td>
              </tr>
              <tr>
                <td><strong>Forwarding Abroad</strong></td>
                <td>Appoint freight forwarder &amp; approve domestic shipping quote</td>
                <td>—</td>
                <td>Consolidate eligible items &amp; ship to your China forwarder</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-resp-mobile">
          {[
            [
              "Merchandise Purchase",
              "Select supplier, pay for goods & share receiving code",
              "Ship parcel domestically in China",
              "Not involved (independent third party)",
            ],
            [
              "Inbound Arrival",
              "Register seller’s courier tracking number",
              "Provide accurate waybill & packing count",
              "Verify physical receipt, carton state & item IDs",
            ],
            [
              "Physical Inspection",
              "Select template & optional target specs",
              "—",
              "Execute checklist, photos, re-measurements & QA review",
            ],
            [
              "Seller Returns",
              "Agree return with seller, supply return address & pay return postage",
              "Receive return & process merchandise refund",
              "Pack authorized items, hand over to courier & log waybill",
            ],
            [
              "Forwarding Abroad",
              "Appoint freight forwarder & approve domestic shipping quote",
              "—",
              "Consolidate eligible items & ship to your China forwarder",
            ],
          ].map(([stage, buyer, seller, qcw]) => (
            <article className="pub-resp-mcard" key={stage}>
              <h3>{stage}</h3>
              <dl>
                <div><dt>You (Buyer)</dt><dd>{buyer}</dd></div>
                <div><dt>Chinese Seller</dt><dd>{seller}</dd></div>
                <div><dt>QCWarehouse</dt><dd>{qcw}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <div className="pub-cta-banner">
        <div>
          <h2>Get Your China Receiving Address &amp; Permanent Code Free</h2>
          <p>Sign up in under two minutes, view your dedicated warehouse address, and pay inspection fees only when you confirm an order scope.</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">Create Account &amp; Start →</Link>
          <Link className="button pub-btn-ghost" href="/faq">Read Buyer FAQ</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   PAGE 06 — PRICING & SERVER-CONSISTENT FEE CALCULATOR (/pricing)
   ========================================================================== */
export function PublicPricing() {
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);

  const [service, setService] = useState<"inspection" | "compare" | "reference_match">("inspection");
  const [offerId, setOfferId] = useState<string>("");
  const [qty, setQty] = useState<number>(10);

  const servicePool = offers.filter((o) => o.service === service);

  useEffect(() => {
    if (!servicePool.length) return;
    const currentValid = servicePool.some((o) => o.offer_id === offerId);
    if (!currentValid) {
      const preferred =
        service === "inspection"
          ? servicePool.find((o) => !o.content?.subcategory) ?? servicePool[0]
          : servicePool[0];
      setOfferId(preferred.offer_id);
      if (service === "compare") {
        setQty(preferred.rules.minimum);
      } else if (service === "reference_match") {
        setQty(1);
      } else if (qty < 1 || qty > 350) {
        setQty(10);
      }
    }
  }, [service, servicePool, offerId, qty]);

  const activeOffer = servicePool.find((o) => o.offer_id === offerId) ?? servicePool[0];

  function handleOfferChange(nextId: string) {
    setOfferId(nextId);
    const picked = servicePool.find((o) => o.offer_id === nextId);
    if (picked && picked.service === "compare") {
      setQty(picked.rules.minimum);
    } else if (picked && picked.service === "reference_match" && qty > 20) {
      setQty(1);
    }
  }

  // Exact server-equivalent calculation (mirrors packages/core/orders.ts lines 113–176)
  let calcHeadline = "Loading…";
  let calcSubnote = "";
  let calcUnitText = "";
  let isManualQuote = false;
  let isCustomInquiry = false;

  if (activeOffer) {
    const safeQty = Math.max(1, Math.floor(Number.isFinite(qty) ? qty : 1));
    if (service === "inspection") {
      const unit = activeOffer.rules.unit_cents ?? 0;
      calcUnitText = `${usd(unit)} × ${safeQty} ${safeQty === 1 ? "item" : "items"}`;
      if (safeQty > 300) {
        isCustomInquiry = true;
        calcHeadline = "Custom Quotation";
        calcSubnote = "Orders above 300 physical items exceed single-order online limits and are quoted as a scheduled batch.";
      } else if (safeQty > activeOffer.rules.maximum) {
        isManualQuote = true;
        calcHeadline = "Manual Staff Quote";
        calcSubnote = `Quantities of ${activeOffer.rules.maximum + 1}–300 items are saved as a draft order and reviewed by staff to confirm turnaround & bench capacity before payment.`;
      } else {
        calcHeadline = usd(unit * safeQty);
        calcSubnote = `Standard online checkout · Est. ${activeOffer.rules.business_days} business days after all ${safeQty} items are received & identified.`;
      }
    } else if (service === "compare") {
      const pkg = activeOffer.rules.package_cents ?? 0;
      const validSetSize = activeOffer.rules.minimum;
      calcUnitText = `Fixed ${validSetSize}-item comparison package`;
      calcHeadline = usd(pkg);
      calcSubnote = `Covers ${validSetSize} comparable items evaluated side by side in one report (${activeOffer.rules.business_days} business days). Need 4+ items checked individually? Switch to Product Inspection.`;
    } else {
      // reference_match: server rules minimum=1, maximum=1 per order line, up to 20 order lines per order
      const pkg = activeOffer.rules.package_cents ?? 0;
      if (safeQty > 20) {
        isCustomInquiry = true;
        calcUnitText = `${safeQty} incoming samples`;
        calcHeadline = "Custom Quotation";
        calcSubnote = "Each Reference Match line compares 1 incoming item against 1 retained Golden Sample (up to 20 lines per online order). Contact us for larger batch matching.";
      } else {
        calcUnitText =
          safeQty === 1
            ? `${usd(pkg)} × 1 incoming item line`
            : `${usd(pkg)} × ${safeQty} separate 1-item reference lines`;
        calcHeadline = usd(pkg * safeQty);
        calcSubnote =
          safeQty === 1
            ? `Matches 1 incoming item against 1 active Golden Sample held in protected reference storage (${activeOffer.rules.business_days} business days).`
            : `Quotes Reference Matching at 1 incoming item per order line (${safeQty} lines = ${usd(pkg * safeQty)}). For 20+ restock units without individual reference pairs, consider Product Inspection.`;
      }
    }
  } else if (data) {
    calcHeadline = "Quote on request";
    calcSubnote = "No active catalog offer found for this selection.";
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>Pricing &amp; Fee Estimator</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">TRANSPARENT COMMERCIAL PRICING · USD</p>
            <h1>How Much Will I Pay, What Is Included, and What Costs Extra?</h1>
            <p style={{ marginBottom: 18 }}>
              QCWarehouse charges a clear, upfront fee for physical inspection or sample comparison—with zero subscription fees. Because we don&apos;t source or sell products, our findings stay independent from your suppliers. Post-inspection domestic courier shipping and extended storage are billed separately only when you request them.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Start an Inspection →
              </Link>
              <a className="button" href="#pricing-calculator">
                Estimate Order Cost
              </a>
              <Link className="button" href="/report-guide">
                View Sample Report
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>Product Inspection</span>
              <strong>{summarizeRate(inspOffers, "/ item")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Sample Comparison</span>
              <strong>{summarizeRate(compOffers, "/ group")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Golden Sample Match</span>
              <strong>{summarizeRate(refOffers, "/ match")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Online Self-Service</span>
              <strong>1–100 Units Instant Quote</strong>
            </div>
          </div>
        </div>
      </section>

      {hasDemoRates && (
        <div className="line-note warning" style={{ marginBottom: 22 }} role="status">
          <strong>Pre-launch / demo rate notice:</strong> Displayed fees come from the active demonstration schedule rather than finalized production billing rates. At checkout, your exact confirmed quote locks before Stripe payment.
        </div>
      )}

      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>Retry</button>
        </div>
      )}

      {/* 3 Billing Models Overview */}
      <div className="pub-service-pillars pub-block">
        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>BILLED PER PHYSICAL ITEM</span>
            <div className="pub-pillar-top">
              <h3>Product Inspection</h3>
              <span className="pub-price-chip">{summarizeRate(inspOffers, "/ item")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              Commission the exact number of items you want checked—from 1 sample to 100 units online (101–300 via manual quote). General Apparel is {inspOffers.find((o) => !o.content?.subcategory) ? usd(inspOffers.find((o) => !o.content?.subcategory)!.rules.unit_cents!) : "quoted"}/item; dedicated Tops, Bottoms &amp; Sports Bra templates are {inspOffers.find((o) => o.content?.subcategory === "tops") ? usd(inspOffers.find((o) => o.content?.subcategory === "tops")!.rules.unit_cents!) : "quoted"}/item.
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href="/services/inspection">Service scope →</Link>
              <Link
                className="button primary sm"
                href={
                  (inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0])
                    ? `/orders/new?offer=${(inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0]).offer_id}`
                    : "/orders/new"
                }
              >
                Configure
              </Link>
            </div>
          </div>
        </section>

        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>BILLED PER COMPARISON SET</span>
            <div className="pub-pillar-top">
              <h3>Sample Comparison</h3>
              <span className="pub-price-chip">{summarizeRate(compOffers, "/ group")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              Fixed group fee covering 2 or 3 comparable items evaluated together on the same bench. Includes synchronized group photography, flat measurement delta table, and individual defect checks.
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href="/services/compare">Service scope →</Link>
              <Link
                className="button primary sm"
                href={
                  (compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0])
                    ? `/orders/new?offer=${(compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0]).offer_id}`
                    : "/orders/new"
                }
              >
                Configure
              </Link>
            </div>
          </div>
        </section>

        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>BILLED PER INCOMING MATCH</span>
            <div className="pub-pillar-top">
              <h3>Golden Sample Matching</h3>
              <span className="pub-price-chip">{summarizeRate(refOffers, "/ match")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              Priced per single incoming sample matched against an active Golden Sample already sealed in protected reference storage under your account. Includes Reference-vs-Incoming side-by-side photos and resealing.
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href="/services/reference">Service scope →</Link>
              <Link
                className="button primary sm"
                href={refOffers[0] ? `/orders/new?offer=${refOffers[0].offer_id}` : "/orders/new"}
              >
                Configure
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Interactive Server-Consistent Fee Calculator */}
      <section className="pub-surface-box pub-block" id="pricing-calculator" aria-labelledby="calc-heading">
        <div>
          <p className="pub-eyebrow">SERVER-CONSISTENT FEE ESTIMATOR</p>
          <h2 id="calc-heading" className="pub-h2">Estimate Your Exact Inspection Fee</h2>
          <p className="pub-lead" style={{ fontSize: 14 }}>
            Uses the same offer eligibility, unit/package billing rules, and manual-quote thresholds as QCWarehouse’s order checkout engine.
          </p>
        </div>

        <div className="pub-calc-grid">
          <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div className="field">
              <label htmlFor="calc-service">1. Choose Service Type</label>
              <select
                id="calc-service"
                value={service}
                onChange={(e) => setService(e.target.value as "inspection" | "compare" | "reference_match")}
              >
                <option value="inspection">Product Inspection (Piece-by-Piece · per item)</option>
                <option value="compare">Sample Comparison (2 or 3 items · per group)</option>
                <option value="reference_match">Golden Sample Matching (1 incoming item vs retained reference)</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="calc-offer">2. Select Approved Apparel Template / Package</label>
              <select
                id="calc-offer"
                value={activeOffer?.offer_id ?? ""}
                onChange={(e) => handleOfferChange(e.target.value)}
              >
                {servicePool.map((o) => {
                  const rate = usd(o.rules.unit_cents ?? o.rules.package_cents ?? 0);
                  const unit = o.rules.unit_cents != null ? "/ item" : o.service === "reference_match" ? "/ match" : "/ set";
                  return (
                    <option key={o.offer_id} value={o.offer_id}>
                      {o.title.en} — {rate} {unit}
                    </option>
                  );
                })}
              </select>
            </div>

            {service === "inspection" && (
              <div className="field">
                <label htmlFor="calc-qty">3. Number of Physical Items to Inspect Individually</label>
                <input
                  id="calc-qty"
                  type="number"
                  min={1}
                  max={500}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
                <div className="pub-qty-pills" role="group" aria-label="Quick quantity presets">
                  {[1, 5, 15, 30, 50, 100, 150].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`pub-qty-pill${qty === preset ? " active" : ""}`}
                      onClick={() => setQty(preset)}
                    >
                      {preset} {preset === 1 ? "item" : "items"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {service === "compare" && activeOffer && (
              <div className="field">
                <label>3. Comparison Group Size</label>
                <div className="line-note" style={{ margin: 0 }}>
                  This package compares exactly <strong>{activeOffer.rules.minimum} comparable items</strong> in a single side-by-side report. Choose a 2-item or 3-item package in Step 2 above.
                </div>
              </div>
            )}

            {service === "reference_match" && (
              <div className="field">
                <label htmlFor="calc-ref-qty">3. Incoming Samples to Benchmark Against Retained Reference(s)</label>
                <input
                  id="calc-ref-qty"
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
                <div className="pub-qty-pills" role="group" aria-label="Reference match sample count">
                  {[1, 2, 3, 5].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`pub-qty-pill${qty === preset ? " active" : ""}`}
                      onClick={() => setQty(preset)}
                    >
                      {preset} {preset === 1 ? "incoming sample" : "incoming samples"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pub-calc-result" aria-live="polite">
            <div>
              <div className="pub-eyebrow" style={{ color: "#93b8ff", marginBottom: 2 }}>
                ESTIMATED INSPECTION FEE (EXCL. SHIPPING)
              </div>
              <div className="pub-calc-amount">{calcHeadline}</div>
              <div style={{ fontSize: 13, color: "#bfd4ef", fontWeight: 650 }}>{calcUnitText}</div>
            </div>

            <div className="pub-calc-breakdown">
              <div>
                <span>Selected Template</span>
                <strong>{activeOffer?.title.en ?? "—"}</strong>
              </div>
              <div>
                <span>Included Checkpoints</span>
                <strong>{activeOffer ? `${activeOffer.content.checks.length} checks + mandatory photos` : "—"}</strong>
              </div>
              <div>
                <span>Outbound Shipping / Storage</span>
                <strong>Quoted later by actual parcel</strong>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#d5e4f7" }}>{calcSubnote}</p>

            <div>
              {isCustomInquiry ? (
                <Link className="button primary full" href={`/contact?topic=quote&qty=${qty}`}>
                  Request Custom Batch Quotation →
                </Link>
              ) : (
                <Link
                  className="button primary full"
                  href={activeOffer ? `/orders/new?offer=${activeOffer.offer_id}` : "/orders/new"}
                >
                  {isManualQuote ? "Create Draft & Request Staff Quote →" : "Continue With This Package →"}
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Complete Included vs Extra Cost Breakdown */}
      <section className="card pub-block" aria-labelledby="fee-separation-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>NO HIDDEN SURPRISES</p>
            <h2 id="fee-separation-heading">Inspection Fee vs. Shipping, Handling &amp; Storage</h2>
            <p>Understand exactly when each charge applies across your order lifecycle.</p>
          </div>
        </div>
        <div className="tablewrap pub-resp-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fee Category</th>
                <th>When It Is Charged</th>
                <th>How It Is Calculated</th>
                <th>What Is Covered</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>1. Inspection / Comparison Fee</strong></td>
                <td>At order confirmation (before bench work starts)</td>
                <td>Per item, per 2–3 item set, or per reference match from active catalog</td>
                <td>Parcel check-in, barcode tagging, approved template checks, measurement &amp; defect photos, QA review, online report + PDF, and initial post-report custody window</td>
              </tr>
              <tr>
                <td><strong>2. Domestic Return to Seller</strong></td>
                <td>Only if you instruct a seller return after report review</td>
                <td>Quoted per outbound parcel by weight &amp; destination province in China</td>
                <td>Packing authorized return items, domestic courier label, handover scan, and waybill tracking (excludes seller merchandise refund)</td>
              </tr>
              <tr>
                <td><strong>3. Forwarding to Your Freight Forwarder</strong></td>
                <td>Only when you request outbound dispatch in China</td>
                <td>Quoted per outbound carton; eligible items can be consolidated per parcel</td>
                <td>Consolidation of your selected items, outer carton weighing, and domestic delivery to your designated Chinese forwarder warehouse</td>
              </tr>
              <tr>
                <td><strong>4. Extended Storage / Golden Sample Custody</strong></td>
                <td>Only after the included free decision window expires</td>
                <td>Per-item policy schedule shown on each sample record before renewal</td>
                <td>Continued climate-organized bin custody or sealed reference vault Golden Sample retention</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-resp-mobile">
          {[
            [
              "1. Inspection / Comparison Fee",
              "At order confirmation (before bench work starts)",
              "Per item, per 2–3 item set, or per reference match from active catalog",
              "Parcel check-in, barcode tagging, approved template checks, measurement & defect photos, QA review, online report + PDF, and initial post-report custody window",
            ],
            [
              "2. Domestic Return to Seller",
              "Only if you instruct a seller return after report review",
              "Quoted per outbound parcel by weight & destination province in China",
              "Packing authorized return items, domestic courier label, handover scan, and waybill tracking (excludes seller merchandise refund)",
            ],
            [
              "3. Forwarding to Your Freight Forwarder",
              "Only when you request outbound dispatch in China",
              "Quoted per outbound carton; eligible items can be consolidated per parcel",
              "Consolidation of your selected items, outer carton weighing, and domestic delivery to your designated Chinese forwarder warehouse",
            ],
            [
              "4. Extended Storage / Golden Sample Custody",
              "Only after the included free decision window expires",
              "Per-item policy schedule shown on each sample record before renewal",
              "Continued climate-organized bin custody or sealed reference vault Golden Sample retention",
            ],
          ].map(([cat, when, calc, cover]) => (
            <article className="pub-resp-mcard" key={cat}>
              <h3>{cat}</h3>
              <dl>
                <div><dt>When It Is Charged</dt><dd>{when}</dd></div>
                <div><dt>How It Is Calculated</dt><dd>{calc}</dd></div>
                <div><dt>What Is Covered</dt><dd>{cover}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      {/* 5. Detailed Active Packages (Complete Template Schedule) */}
      <details className="card pub-block pub-schedule-drawer" id="full-schedule">
        <summary className="pub-schedule-summary">
          <div>
            <span className="pub-eyebrow" style={{ marginBottom: 2 }}>COMPLETE TEMPLATE SCHEDULE</span>
            <strong>Published Package &amp; Template Rate Directory ({offers.length} active offers)</strong>
          </div>
          <span className="button sm">Toggle Rate Schedule</span>
        </summary>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Package Name</th>
                <th>Service Type</th>
                <th>Template Track</th>
                <th>Online Quantity</th>
                <th>Turnaround</th>
                <th>Active Rate (USD)</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const cents = o.rules.unit_cents ?? o.rules.package_cents ?? 0;
                const unit = o.rules.unit_cents != null ? "/ item" : o.service === "reference_match" ? "/ match" : "/ set";
                const qtyRange =
                  o.rules.minimum === o.rules.maximum
                    ? `${o.rules.minimum}`
                    : `${o.rules.minimum}–${o.rules.maximum}`;
                return (
                  <tr key={o.offer_id}>
                    <td>
                      <strong>{o.title.en}</strong>
                      <div className="small muted mono">{o.sku_code}</div>
                    </td>
                    <td>
                      {o.service === "inspection"
                        ? "Product Inspection"
                        : o.service === "compare"
                        ? "Sample Comparison"
                        : "Golden Sample Match"}
                    </td>
                    <td>{subcategoryLabel(o.content?.subcategory)}</td>
                    <td className="mono">{qtyRange}</td>
                    <td>{o.rules.business_days} bus. days</td>
                    <td className="mono">
                      <strong>{usd(cents)}</strong> <span className="small muted">{unit}</span>
                    </td>
                    <td>
                      <Link className="button sm primary" href={`/orders/new?offer=${o.offer_id}`}>
                        Order
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      {/* 6. Pricing & Billing FAQ */}
      <section className="card pub-block" aria-labelledby="pricing-faq-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>PRICING &amp; BILLING FAQ</p>
            <h2 id="pricing-faq-heading">Common Cost &amp; Quotation Questions</h2>
          </div>
          <Link className="button sm" href="/faq">Full Buyer FAQ →</Link>
        </div>
        <div className="faq-group">
          <details className="faq-item" open>
            <summary>Why are inspection fees charged separately from domestic shipping and extended storage?</summary>
            <p>
              Until physical items arrive, are weighed, and you decide whether to return defects to a supplier or forward stock to a freight forwarder, final carton weight and destination do not exist. Keeping fees separate avoids inflated flat shipping markups.
            </p>
          </details>
          <details className="faq-item">
            <summary>How does pricing work for 1–3 prototype samples vs. 10–100 small-batch stock items?</summary>
            <p>
              Under the current active catalog, <strong>Product Inspection</strong> bills per physical item from 1 to 100 units online ({summarizeRate(inspOffers, "/ item")}) using the same approved template checklist. If you are comparing 2 or 3 candidate supplier prototypes side by side in one unified matrix, choose <strong>Sample Comparison</strong> ({summarizeRate(compOffers, "/ group")}). For 30–100+ unit stock batches requiring customized screening checkpoints, contact our team for a tailored batch scope.
            </p>
          </details>
          <details className="faq-item">
            <summary>What does the “Pre-launch / Demo Rate” catalog notice mean?</summary>
            <p>
              Displayed prices read live from the current catalog schedule carrying pre-launch / demo pricing flags. Whenever you place an order, QCWarehouse locks your verified service quote before Stripe checkout so fees never surprise you.
            </p>
          </details>
          <details className="faq-item">
            <summary>How are orders of 101–300 items billed?</summary>
            <p>
              Draft orders between 101 and 300 units save without payment first so our operations desk can confirm bench capacity and issue a manual quote before you pay.
            </p>
          </details>
        </div>
      </section>

      {/* 7. Final CTA Banner */}
      <div className="pub-cta-banner">
        <div>
          <h2>Ready to Lock Your Inspection Quote or Estimate a Custom Batch?</h2>
          <p>Select any active package above to configure your order online, or message our operations team if you are planning a multi-carton small-batch shipment.</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">Start an Inspection →</Link>
          <Link className="button pub-btn-ghost" href="/contact?topic=quote">Request Custom Batch Quote</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   LEGAL & POLICIES (/legal, /legal/terms, /legal/privacy, etc.)
   ========================================================================== */
const LEGAL_TITLES: Record<string, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
  restricted_items: "Restricted Items Policy",
  report_notice: "Inspection Report Limitations",
};

export function PublicLegal({ path }: { path: string }) {
  const kind = legalPages[path as keyof typeof legalPages];
  const query = useSearchParams();
  const versions = query.getAll("version");
  const suffix = versions.length ? "?" + new URLSearchParams(versions.map((v) => ["version", v])) : "";
  const { data, error, reload } = useLoad("/public/terms" + (kind ? "/" + kind + suffix : ""));
  const terms: Array<{ id: string; kind: string; version: string; effective_at: string; content_md: string }> =
    data?.terms ?? [];
  const title = kind ? LEGAL_TITLES[kind] : "Terms, Privacy & Inspection Policies";

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{title}</strong>
      </div>

      <section className="pub-page-hero" style={{ marginBottom: 20 }}>
        <div className="row between flexwrap" style={{ gap: 16 }}>
          <div>
            <p className="pub-eyebrow">QCWAREHOUSE · VERSIONED LEGAL &amp; OPERATING POLICIES</p>
            <h1 style={{ marginBottom: 8 }}>{title}</h1>
            <p style={{ marginBottom: 0 }}>
              Every customer order records the exact policy version accepted at checkout so historical terms and report scope notices remain auditable.
            </p>
          </div>
          <Link className="button sm" href="/orders/new">
            Start an Inspection →
          </Link>
        </div>
      </section>

      <Tabs
        path={path}
        links={[
          ["/legal", "All Policies"],
          ...Object.entries(legalPages).map(([href, key]): [string, string] => [href, LEGAL_TITLES[key]]),
        ]}
      />

      {kind && versions.length > 0 && (
        <p style={{ marginBottom: 14 }}>
          <Link href={path}>← View current active version</Link>
        </p>
      )}
      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>Try again</button>
        </div>
      )}
      {!data && !error && <p role="status" className="muted">Loading published policies…</p>}
      {data && terms.length === 0 && <Empty>No published policy version is available.</Empty>}
      {terms.map((t) => (
        <Panel
          key={t.id}
          title={LEGAL_TITLES[t.kind] ?? t.kind}
          badge={<span className="tag blue">Version {t.version}</span>}
        >
          <p className="muted small">
            Version {t.version} · Effective <time dateTime={t.effective_at}>{t.effective_at.slice(0, 10)} UTC</time>
          </p>
          <div className="policy-content">{t.content_md}</div>
        </Panel>
      ))}
    </>
  );
}
