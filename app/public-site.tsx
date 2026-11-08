"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { legalPages, servicePages } from "../packages/core/portal-routes";
import { PlatformIcon } from "./chrome";
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

function PackageCard({ offer }: { offer: CatalogOffer }) {
  const isUnit = offer.rules.unit_cents != null;
  const cents = offer.rules.unit_cents ?? offer.rules.package_cents ?? 0;
  const qtyText =
    offer.rules.minimum === offer.rules.maximum
      ? `${offer.rules.minimum} ${offer.rules.minimum === 1 ? "item" : "items"}`
      : `${offer.rules.minimum}–${offer.rules.maximum} items`;
  const checks = offer.content?.checks ?? [];

  return (
    <article className="pub-package-card">
      <div>
        <div className="row flexwrap" style={{ gap: 8, marginBottom: 6 }}>
          <span className="tag blue">{subcategoryLabel(offer.content?.subcategory)}</span>
          <span className="pub-sku-ref" title="Internal catalog SKU reference">
            Ref: {offer.sku_code}
          </span>
          {offer.rules.demo && (
            <span className="tag yellow" title="Active pre-launch / demo catalog schedule">
              Pre-launch / Demo Rate
            </span>
          )}
        </div>
        <h3>{offer.title.en}</h3>
        <div className="pub-package-meta">
          <span><strong>Quantity:</strong> {qtyText}</span>
          <span aria-hidden="true">·</span>
          <span><strong>Est. Turnaround:</strong> {offer.rules.business_days} business days after receipt &amp; ID</span>
          <span aria-hidden="true">·</span>
          <span><strong>Checkpoints:</strong> {checks.length} defined checks</span>
        </div>
        {checks.length > 0 && (
          <details className="pub-package-checks">
            <summary>Preview {checks.length} template checkpoints</summary>
            <div className="pub-chip-row">
              {checks.map((c) => (
                <span className="pub-chip" key={c.key}>
                  {c.label}{c.unit ? ` (${c.unit})` : ""}
                </span>
              ))}
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
          <figure className="pub-page-hero-media" style={{ margin: 0 }}>
            <img
              src="/marketing/qcw-02-tshirt-chest-measurement.webp"
              alt="Inspector measuring chest width across a flat-laid cotton T-shirt using a metric tape"
              width={1200}
              height={900}
              loading="eager"
            />
            <span className="pub-media-badge">Illustrative Photography</span>
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
        <div className="tablewrap">
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
                <td>Check 1 prototype or 10–100+ small-batch units individually before international freight</td>
                <td>Evaluate 2 or 3 candidate samples from different suppliers or batches side by side</td>
                <td>Verify a new pre-production or restock piece against an approved reference held in our vault</td>
              </tr>
              <tr>
                <td><strong>Eligible Quantity</strong></td>
                <td><strong>1–100 items</strong> online (101–300 via manual staff quote)</td>
                <td><strong>2 or 3 comparable items</strong> per comparison group</td>
                <td><strong>1 incoming item</strong> per line matched to 1 retained Golden Sample</td>
              </tr>
              <tr>
                <td><strong>Billing Basis</strong></td>
                <td>Per physical item ({summarizeRate(inspOffers, "/ item")})</td>
                <td>Per 2- or 3-item group ({summarizeRate(compOffers, "/ group")})</td>
                <td>Per incoming match ({summarizeRate(refOffers, "/ match")})</td>
              </tr>
              <tr>
                <td><strong>Key Evidence Output</strong></td>
                <td>Per-item ID, flat measurements, seam checks &amp; coordinate defect annotations</td>
                <td>Group overhead frame + side-by-side measurement &amp; weight delta table</td>
                <td>Paired Reference-vs-Incoming photos + dimensional &amp; visual variance log</td>
              </tr>
              <tr>
                <td><strong>Post-Report Item Routing</strong></td>
                <td colSpan={3}>
                  Return specific items to seller, retain as Golden Sample, store temporarily, or consolidate &amp; forward to your China freight forwarder
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Product Inspection */}
      <section className="pub-service-detail" id="product-inspection" aria-labelledby="svc-inspection-title">
        <div>
          <p className="pub-eyebrow">02 · SERVICE 01 — PIECE-BY-PIECE VERIFICATION</p>
          <h2 id="svc-inspection-title" className="pub-h2">Product Inspection (1 to 100+ Items)</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            Designed for single prototypes as well as small-batch inventory runs (such as 15, 40, or 80 garments) where every unit matters and factory-floor AQL random sampling leaves too much risk.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>Ideal Scenarios</span>
              <strong>First sample check, boutique capsule drops, TikTok/Shopify small-batch stock</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>1–100 items self-serve · 101+ items via manual capacity quote</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Inspection Method</span>
              <strong>Traceable barcode per piece, unstrained flat tape measure + 2-pass re-checks, zone visual scan</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Evaluates each item independently against its checklist rather than grouping items into a comparison set</strong>
            </div>
          </div>
          <p className="small muted" style={{ marginBottom: 14 }}>
            <strong>Scope boundary:</strong> Checks cover the commissioned visual and dimensional checkpoints on the physical items received—not destructive fabric testing, wash shrinkage, or legal compliance certification.
          </p>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href="/services/inspection">
              Explore Product Inspection →
            </Link>
            <Link className="button sm" href="/orders/new">
              Order Piece-by-Piece Inspection
            </Link>
          </div>
        </div>
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box">
            <img
              src="/marketing/qcw-04-leggings-waist-measurement.webp"
              alt="Flat-lay waist width measurement on charcoal athletic leggings using a metric tape"
              width={1200}
              height={900}
              loading="lazy"
            />
            <span className="pub-media-badge">Illustrative Photography · Subcategory Check</span>
          </figure>
        </div>
      </section>

      {/* 3. Sample Comparison */}
      <section className="pub-service-detail reverse" id="sample-comparison" aria-labelledby="svc-compare-title">
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/qcw-07-three-supplier-samples.webp"
              alt="Three unbranded cotton T-shirt samples from different suppliers photographed side by side under uniform studio lighting"
              width={1350}
              height={900}
              loading="lazy"
            />
            <span className="pub-media-badge">Illustrative Photography · 3-Sample Set</span>
          </figure>
        </div>
        <div>
          <p className="pub-eyebrow">03 · SERVICE 02 — SUPPLIER &amp; BATCH SELECTION</p>
          <h2 id="svc-compare-title" className="pub-h2">Sample Comparison (2 or 3 Comparable Items)</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            Supplier photos on 1688 and Alibaba rarely show true fabric weight, collar rib recovery, or sizing consistency. Send samples from 2 or 3 shortlisted factories and compare them on the exact same table under identical lighting.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>Ideal Scenarios</span>
              <strong>Shortlisting 2–3 factories before placing bulk deposits or private-label orders</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>2 or 3 items of the same apparel category per comparison group</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Inspection Method</span>
              <strong>Unified measurement landmarks, digital garment mass, and synchronized group + detail photos</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Delivers a unified side-by-side matrix &amp; group frame; we document facts while you choose the winner</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href="/services/compare">
              Explore Sample Comparison →
            </Link>
            <Link className="button sm" href="/report-guide">
              See Comparison Report Sample
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
            Prevent silent material swaps or grading drift on repeat orders. Retain an approved garment in our tamper-evident reference cabinet (<span className="code">REF_SAFE</span>) and benchmark incoming pre-production or restock pieces directly against it.
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>How Setup Works</span>
              <strong>Request Golden Sample conversion online → warehouse seals item into REF_SAFE</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Item Quantity</span>
              <strong>1 incoming sample matched against 1 active retained reference per line</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Inspection Method</span>
              <strong>Direct physical side-by-side placement, delta measurement log, shade &amp; seam comparison</strong>
            </div>
            <div className="pub-meta-cell">
              <span>How It Differs</span>
              <strong>Requires an active sealed Golden Sample in your QCWarehouse account prior to checkout</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href="/services/reference">
              Explore Golden Sample Matching →
            </Link>
            <Link className="button sm" href="/orders/new">
              Configure Reference Match
            </Link>
          </div>
        </div>
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/qcw-08-golden-sample-matching.webp"
              alt="Approved navy Golden Sample laid next to a newly received production sample for visual and dimensional comparison"
              width={1350}
              height={900}
              loading="lazy"
            />
            <span className="pub-media-badge">Illustrative Photography · Reference vs Incoming</span>
          </figure>
          <figure className="pub-photo-box">
            <img
              src="/marketing/qcw-15-golden-sample-storage.webp"
              alt="Folded reference garment sealed inside a protective archival bag in dedicated Golden Sample cabinet storage"
              width={1200}
              height={900}
              loading="lazy"
            />
            <span className="pub-media-badge">Illustrative Photography · Protected REF_SAFE Storage</span>
          </figure>
        </div>
      </section>

      {/* 5. Inspection Evidence, Deliverables & Explicit Boundaries */}
      <section className="pub-block" aria-labelledby="deliverables-boundaries-title">
        <div className="pub-section-head" style={{ marginBottom: 18 }}>
          <div>
            <p className="pub-eyebrow">05 · DELIVERABLES &amp; SERVICE BOUNDARIES</p>
            <h2 id="deliverables-boundaries-title">What You Receive—and What We Never Claim</h2>
            <p className="pub-lead" style={{ fontSize: 14.5 }}>
              Honest scope boundaries protect commercial buyers from false assumptions. Every report clearly separates observed physical facts from testing that requires accredited laboratories or on-site factory audits.
            </p>
          </div>
        </div>
        <div className="pub-boundary-grid">
          <div className="pub-boundary-box included">
            <h3 style={{ color: "#0b816b" }}>Included in QCWarehouse Reports</h3>
            <ul className="pub-check-list">
              <li><b className="mark-ok">✓</b><span>Parcel arrival verification, carton condition notes, and unique barcode ID per garment</span></li>
              <li><b className="mark-ok">✓</b><span>Mandatory garment overview, care-label, and metric tape-in-frame measurement photos</span></li>
              <li><b className="mark-ok">✓</b><span>Recorded flat dimensions (0.1 cm precision) with automatic two-pass re-measurement logs</span></li>
              <li><b className="mark-ok">✓</b><span>Non-destructive UI red bounding boxes and English reviewer translations on observed defects</span></li>
              <li><b className="mark-ok">✓</b><span>Immutable versioned online report + matching downloadable PDF + post-report routing controls</span></li>
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
    eyebrow: "SERVICE DETAIL · PIECE-BY-PIECE INSPECTION",
    title: "Product Inspection in China (1 to 100+ Items)",
    lead: "Send single prototypes or small-batch apparel orders to our China receiving center. Every physical garment gets its own barcode ID, approved template measurements, workmanship check, and documented photo proof.",
    image: "/marketing/qcw-02-tshirt-chest-measurement.webp",
    imageAlt: "Overhead metric tape chest width measurement on a light gray cotton T-shirt",
    idealFor: "Single pre-order samples, capsule drops (10–100 pcs), high-ASP garments where defective returns abroad destroy margin.",
    quantities: "1–100 items self-serve online · 101–300 items via manual staff capacity quote.",
    method: "Individual item check-in, unstrained flat-lay metric tape measurements (0.1 cm precision + two-pass re-checks), digital garment weight, and zone-by-zone visual workmanship scan.",
    distinction: "Unlike Sample Comparison, each item is evaluated individually rather than grouped into a 2–3 supplier comparison matrix.",
  },
  compare: {
    eyebrow: "SERVICE DETAIL · SIDE-BY-SIDE EVALUATION",
    title: "Supplier Sample Comparison Service (2–3 Items)",
    lead: "Evaluating multiple 1688, Alibaba, or direct factories? Ship 2 or 3 comparable apparel samples to our studio so we can measure, weigh, and photograph them together under identical conditions.",
    image: "/marketing/qcw-07-three-supplier-samples.webp",
    imageAlt: "Three unbranded cotton T-shirt samples arranged side by side for visual and dimensional comparison",
    idealFor: "Founders and buyers choosing between 2–3 candidate manufacturers before placing bulk deposits or custom label runs.",
    quantities: "2 or 3 comparable items from the same product category per comparison package.",
    method: "Synchronized overhead group photography, identical flat-lay tape placement across every sample, digital gram weight comparison, and collar/seam macro documentation.",
    distinction: "Priced per 2- or 3-item comparison group with a unified delta table. We record objective physical differences; you make the commercial supplier selection.",
  },
  reference_match: {
    eyebrow: "SERVICE DETAIL · BENCHMARK CONSISTENCY",
    title: "Golden Sample & Reference Matching in China",
    lead: "Keep your approved Golden Sample sealed in QCWarehouse’s REF_SAFE storage and benchmark new pre-production or reorder samples directly against your physical standard.",
    image: "/marketing/qcw-08-golden-sample-matching.webp",
    imageAlt: "Approved navy reference garment placed beside an incoming sample for side-by-side comparison",
    idealFor: "Repeat SKU reorders, new factory transitions, and pre-production approval against a signed-off prototype.",
    quantities: "1 incoming sample compared against 1 active retained Golden Sample per order line.",
    method: "Controlled retrieval of your sealed Golden Sample, side-by-side flat measurement delta check, visual shade/rib/stitching comparison, and resealing into REF_SAFE.",
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
          <figure className="pub-page-hero-media" style={{ margin: 0 }}>
            <img src={cfg.image} alt={cfg.imageAlt} width={1350} height={900} loading="eager" />
            <span className="pub-media-badge">Illustrative Photography</span>
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

export function PublicCategories() {
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");

  const findSubOffer = (sub?: string) =>
    inspOffers.find((o) => (o.content?.subcategory ?? "general") === (sub ?? "general")) ?? inspOffers[0];

  const topsOffer = findSubOffer("tops");
  const bottomsOffer = findSubOffer("bottoms");
  const braOffer = findSubOffer("sports_bra");
  const generalOffer = findSubOffer("general");

  const apparelSubtracks = [
    {
      title: "Tops, T-Shirts, Hoodies & Knitwear",
      badge: "Dedicated Subcategory Template",
      examples: "Crewneck tees, oversized hoodies, polo shirts, sweaters, zip jackets",
      checks: "Front body length (HPS), chest width (1/2), across shoulder, sleeve length, hem sweep, collar rib symmetry, garment weight & seam workmanship",
      offer: topsOffer,
    },
    {
      title: "Leggings, Pants, Joggers & Shorts",
      badge: "Dedicated Subcategory Template",
      examples: "Activewear leggings, woven trousers, denim, sweatpants, athletic shorts",
      checks: "Relaxed waistband (1/2), hip width, front rise, back rise, thigh width, inseam length, leg opening, crotch gusset & flatlock seam check",
      offer: bottomsOffer,
    },
    {
      title: "Sports Bras & Intimate Activewear",
      badge: "Dedicated Subcategory Template",
      examples: "Medium/high-support sports bras, crop tanks, moulded-cup bralettes",
      checks: "Underband flat width, bust width, strap length symmetry, center-front height, removable pad/lining check, elastic band stitching & weight",
      offer: braOffer,
    },
    {
      title: "General Apparel & Mixed Garments",
      badge: "Core Apparel Template",
      examples: "Dresses, skirts, light outerwear, scarves, or standard visual + flat-width checks",
      checks: "Visible condition across key zones, flat garment width, care/size label transcription, mandatory front/back/detail evidence photos",
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
        <div>
          <p className="pub-eyebrow">SUPPORTED MERCHANDISE · WHAT CAN YOU INSPECT TODAY?</p>
          <h1>What Products Can You Inspect Today?</h1>
          <p style={{ marginBottom: 0 }}>
            <strong>Apparel is open for orders today.</strong> Rather than claiming we inspect every product on earth with a generic checklist, QCWarehouse opens categories only when dedicated measurement tools, lighting setups, and garment-specific templates are ready on our floor.
          </p>
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
        <div className="pub-apparel-top">
          <div>
            <div className="row flexwrap" style={{ gap: 8, marginBottom: 10 }}>
              <span className="tag green">OPEN FOR ORDERS TODAY</span>
              <span className="tag blue">{offers.length || 9} Active Packages</span>
            </div>
            <h2 id="apparel-live-heading" className="pub-h2">
              Apparel, Knitwear &amp; Activewear
            </h2>
            <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 16 }}>
              Available across all three services—<strong>Product Inspection</strong> (1–100+ items), <strong>Sample Comparison</strong> (2–3 items), and <strong>Golden Sample Matching</strong>. Select the garment track below that matches your SKU to launch an order with the right measurement template pre-selected.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link
                className="button primary"
                href={generalOffer ? `/orders/new?offer=${generalOffer.offer_id}` : "/orders/new"}
              >
                Start Apparel Inspection →
              </Link>
              <Link className="button" href="/catalog#packages">
                Compare All Apparel Packages
              </Link>
            </div>
          </div>
          <figure className="pub-photo-box ratio-1-1" style={{ maxWidth: 300, justifySelf: "center", width: "100%" }}>
            <img
              src="/marketing/qcw-14-apparel-category-cover.webp"
              alt="Studio flat-lay of unbranded cotton T-shirt, charcoal sports leggings, and folded knitwear"
              width={1080}
              height={1080}
              loading="eager"
            />
            <span className="pub-media-badge">Illustrative Photography</span>
          </figure>
        </div>

        <div className="pub-subcat-grid">
          {apparelSubtracks.map((track) => {
            const cents = track.offer?.rules.unit_cents;
            return (
              <article className="pub-subcat-card" key={track.title}>
                <div className="row between flexwrap" style={{ gap: 8 }}>
                  <span className="tag blue">{track.badge}</span>
                  {cents != null && (
                    <span className="mono" style={{ fontWeight: 800, color: "#163d94", fontSize: 13 }}>
                      {usd(cents)} / item
                    </span>
                  )}
                </div>
                <h3>{track.title}</h3>
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
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Secondary Compact Section: Planned & Restricted Categories (Zero purchase buttons, zero fake product imagery) */}
      <section className="pub-block" aria-labelledby="future-categories-heading">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">PLANNED &amp; RESTRICTED CATEGORIES</p>
            <h2 id="future-categories-heading" style={{ fontSize: "1.4rem" }}>
              Categories Not Yet Open for Online Checkout
            </h2>
            <p className="pub-lead" style={{ fontSize: 14 }}>
              To make sure every measurement and report is reliable, we do not accept orders for categories whose specialized gauges, handling fixtures, or safety requirements are not active at our facility. Do not ship non-apparel parcels without prior written confirmation.
            </p>
          </div>
          <Link className="button sm" href="/legal/restricted-items">
            Read Restricted Items Policy →
          </Link>
        </div>

        <div className="pub-future-grid">
          {PLANNED_AND_RESTRICTED.map((item) => (
            <div className="pub-future-card" key={item.name}>
              <div className="row between" style={{ gap: 8 }}>
                <strong style={{ color: "#13263f", fontSize: 14 }}>{item.name}</strong>
                <span className={`tag ${item.tone}`}>{item.status}</span>
              </div>
              <p className="small muted" style={{ margin: 0, lineHeight: 1.55 }}>{item.note}</p>
              {item.status === "Planned" && (
                <div style={{ marginTop: "auto", paddingTop: 6 }}>
                  <Link className="button sm" href={`/contact?topic=category&item=${encodeURIComponent(item.name)}`}>
                    Request Launch Notification
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/* ==========================================================================
   PAGE 04 — HOW IT WORKS (/how-it-works)
   ========================================================================== */
const JOURNEY_STEPS = [
  {
    num: "01",
    owner: "You (Buyer)",
    title: "Create Your Inspection Order & Receive Your Parcel Code",
    body: "Sign up to get QCWarehouse’s China receiving center address and your permanent personal receiving code. Select Product Inspection, Sample Comparison, or Golden Sample Matching, specify item quantities, and attach optional size charts or tolerances.",
    photo: null,
    photoAlt: "",
  },
  {
    num: "02",
    owner: "You + Your Chinese Suppliers",
    title: "Purchase Directly from Sellers & Ship Domestic Parcels",
    body: "Buy directly from your chosen factories, Alibaba, 1688, or Taobao sellers—QCWarehouse never acts as a middleman or takes supplier commissions. Paste your receiving address + code at checkout and submit each seller’s domestic courier tracking number in your workspace. Multiple suppliers can ship separate parcels.",
    photo: null,
    photoAlt: "",
  },
  {
    num: "03",
    owner: "QCWarehouse Intake Desk",
    title: "Physical Parcel Arrival & Condition Check-In",
    body: "When domestic couriers drop off parcels, our intake desk scans the carrier waybill, photographs exterior carton damage or moisture if present, and matches the parcel to your account. Note: a courier ‘Delivered’ scan is not final warehouse receipt until physical unboxing and count verification are completed.",
    photo: "/marketing/qcw-10-parcel-receiving-scanning.webp",
    photoAlt: "Intake operator scanning an arriving cardboard parcel on a clean receiving table",
  },
  {
    num: "04",
    owner: "QCWarehouse Sample Registry",
    title: "Item-by-Item Identification & Protected Staging",
    body: "Each garment is unboxed, counted against your expected quantity, assigned a unique traceable sample barcode, and placed in clean numbered staging bins. Quantity mismatches or uncommissioned parcels are flagged with photo evidence before inspection begins.",
    photo: "/marketing/qcw-11-sample-storage.webp",
    photoAlt: "Organized apparel sample shelving bays with individually bagged garments",
  },
  {
    num: "05",
    owner: "QCWarehouse Inspection Studio",
    title: "Bench Measurement, Visual Check & Studio Photography",
    body: "Under neutral studio lighting, inspectors execute your category’s approved checklist—capturing front/back views, metric tape-in-frame measurements (with automatic two-pass re-checks on anomalies), digital scale weight, and macro close-ups of stitching or surface defects.",
    photo: "/marketing/qcw-12-photo-workstation.webp",
    photoAlt: "Overhead camera and diffused studio lights above a flat-lay apparel inspection table",
  },
  {
    num: "06",
    owner: "QCWarehouse Independent QA Review",
    title: "QA Verification & Immutable English Report Publication",
    body: "A separate reviewer verifies measurement logs, checks non-destructive red defect bounding boxes, translates bench notes into clear commercial English, and publishes a locked versioned report (online + downloadable PDF).",
    photo: null,
    photoAlt: "",
  },
  {
    num: "07",
    owner: "Your Instruction → QCWarehouse Dispatch",
    title: "Decide Per Item: Return to Seller, Store, or Forward",
    body: "After reviewing the evidence, issue item-by-item handling instructions: seal an approved piece as a Golden Sample, pay domestic postage to return defective items to the seller’s designated address, or consolidate approved items to your freight forwarder in China.",
    photo: "/marketing/qcw-13-sorting-and-packing.webp",
    photoAlt: "Operator folding and separating individually bagged inspected garments for outbound dispatch",
  },
] as const;

const OPERATIONAL_RULES = [
  {
    title: "1. You purchase directly from sellers",
    body: "We do not source suppliers, place orders on marketplaces, pay factories, or negotiate prices. Keeping QCWarehouse 100% independent ensures unbiased reporting.",
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
        <div className="pub-page-hero-grid">
          <div>
            <p className="pub-eyebrow">PHYSICAL FULFILLMENT &amp; CUSTODY WORKFLOW</p>
            <h1>How QCWarehouse Works—Step by Step</h1>
            <p>
              Follow the physical journey from ordering samples with your Chinese supplier to parcel check-in, piece-by-piece studio inspection, report review, and outbound item routing.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Create an Inspection →
              </Link>
              <Link className="button" href="/report-guide">
                See Sample Report Deliverable
              </Link>
            </div>
          </div>
          <figure className="pub-page-hero-media" style={{ margin: 0 }}>
            <img
              src="/marketing/qcw-12-photo-workstation.webp"
              alt="Apparel inspection photography workstation with overhead camera and neutral lighting"
              width={1350}
              height={900}
              loading="eager"
            />
            <span className="pub-media-badge">Illustrative Photography</span>
          </figure>
        </div>
      </section>

      {/* 7-Step Visual Physical Flow */}
      <ol className="pub-journey" aria-label="Seven-stage inspection workflow">
        {JOURNEY_STEPS.map((st) => (
          <li
            key={st.num}
            className={`pub-journey-step${st.photo ? "" : " no-photo"}`}
          >
            <span className="pub-journey-badge">{st.num}</span>
            <div>
              <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{st.owner}</p>
              <h2 style={{ fontSize: "1.18rem", margin: "0 0 6px" }}>{st.title}</h2>
              <p style={{ margin: 0, fontSize: 13.8, lineHeight: 1.6, color: "#4a5e76" }}>{st.body}</p>
            </div>
            {st.photo && (
              <figure className="pub-photo-box ratio-3-2">
                <img src={st.photo} alt={st.photoAlt} width={1350} height={900} loading="lazy" />
                <span className="pub-media-badge">Illustrative Photography</span>
              </figure>
            )}
          </li>
        ))}
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
        <div className="tablewrap">
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
            ? `Matches 1 incoming item against 1 active Golden Sample stored in REF_SAFE (${activeOffer.rules.business_days} business days).`
            : `Server quotes Reference Matching at 1 incoming item per order line (${safeQty} lines = ${usd(pkg * safeQty)}). For 20+ restock units without individual reference pairs, consider Product Inspection.`;
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
        <div>
          <p className="pub-eyebrow">TRANSPARENT COMMERCIAL PRICING · USD</p>
          <h1>How Much Will I Pay, What Is Included, and What Costs Extra?</h1>
          <p style={{ marginBottom: 0 }}>
            QCWarehouse charges a clear, upfront fee for physical inspection or sample comparison—with zero subscription fees and zero supplier commissions. Post-inspection domestic courier shipping and extended storage are billed separately only when you request them.
          </p>
        </div>
      </section>

      {hasDemoRates && (
        <div className="line-note warning" style={{ marginBottom: 22 }} role="status">
          <strong>Catalog rate status:</strong> The active catalog in this environment carries <code>pre-launch / demo</code> schedule flags. All prices below are read live from <code>/api/v1/catalog</code>, and real checkout always locks a server-verified quote snapshot valid for 30 minutes before payment.
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
              <Link className="button primary sm" href="/orders/new">Configure</Link>
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
              <Link className="button primary sm" href="/orders/new">Configure</Link>
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
              Priced per single incoming sample matched against an active Golden Sample already sealed in your QCWarehouse account (<span className="code">REF_SAFE</span>). Includes Reference-vs-Incoming side-by-side photos and resealing.
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href="/services/reference">Service scope →</Link>
              <Link className="button primary sm" href="/orders/new">Configure</Link>
            </div>
          </div>
        </section>
      </div>

      {/* Interactive Server-Consistent Fee Calculator */}
      <section className="pub-surface-box pub-block" id="calculator" aria-labelledby="calc-heading">
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
        <div className="tablewrap">
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
                <td>Continued climate-organized bin custody or sealed <span className="code">REF_SAFE</span> Golden Sample retention</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Complete Live SKU Schedule Table */}
      <section className="card pub-block" aria-labelledby="full-schedule-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>COMPLETE PUBLISHED RATE SCHEDULE</p>
            <h2 id="full-schedule-heading">All Active Apparel Packages</h2>
          </div>
        </div>
        <div className="tablewrap">
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
                      <div className="small muted mono">Ref: {o.sku_code}</div>
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
      </section>
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
