import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { transaction } from "../packages/db";
import { actorForSession } from "../packages/core/auth";
import { isDemo } from "../packages/core/common";
import { catalog } from "../packages/core/orders";
import { staffHome } from "../packages/core/portal-routes";
import { PlatformIcon, PublicFooter, PublicHeader } from "./chrome";
import { homeJsonLd, metadataForPath } from "./public-seo";
import { SampleReportPreview } from "./report-guide";

export const metadata: Metadata = metadataForPath("/", true);

type LiveOffer = {
  offer_id: string;
  sku_code: string;
  service: string;
  title: { en: string };
  category: { en: string };
  content?: { subcategory?: string };
  rules: {
    minimum: number;
    maximum: number;
    unit_cents?: number;
    package_cents?: number;
    business_days: number;
    demo?: boolean;
  };
};

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function summarizeRate(pool: LiveOffer[], unitSuffix: string): string {
  const amounts = pool
    .map((o) => Number(o.rules.unit_cents ?? o.rules.package_cents ?? 0))
    .filter((n) => n > 0);
  if (!amounts.length) return "See live quote";
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  return lo === hi ? `${formatUsd(lo)} ${unitSuffix}` : `${formatUsd(lo)}–${formatUsd(hi)} ${unitSuffix}`;
}

const TRUST_CAPABILITIES = [
  [
    "packages",
    "China Receiving Center",
    "Buy directly from Chinese suppliers and ship parcels to your dedicated receiving code.",
  ],
  [
    "scan",
    "Individual Sample & Small-Batch Inspection",
    "Inspect 1–3 prototype samples in detail or screen 10–100+ small-batch items piece by piece.",
  ],
  [
    "reports",
    "Measurements, Photos & Documented Findings",
    "Flat-lay measurements, seam details, and defect bounding boxes linked to item IDs.",
  ],
  [
    "dispatch",
    "Return, Store, or Forward",
    "Decide per item after reading the report—return defects to sellers or forward good stock.",
  ],
] as const;

type BuyerScenario = {
  tag: string;
  title: string;
  body: string;
  wide: boolean;
  image?: string;
  imageAlt?: string;
};

const BUYER_SCENARIOS: BuyerScenario[] = [
  {
    tag: "Supplier Selection",
    title: "Compare supplier samples before choosing a factory",
    body: "Receive one synchronized comparison report with side-by-side overhead photos, a landmark measurement delta table, and weight and workmanship notes across 2 or 3 candidate factories.",
    wide: false,
    image: "/marketing/home-supplier-comparison.webp",
    imageAlt:
      "Three supplier crewneck T-shirt samples in oatmeal, slate, and olive laid side by side on a white inspection bench with a digital gram scale and yellow measuring tape",
  },
  {
    tag: "Small-Batch QC",
    title: "Inspect small-batch orders item by item",
    body: "Every unit receives its own traceable sample ID, flat-lay metric tape photos, workmanship check, and coordinate-tagged defect record—so you can separate clean stock from returnable defects.",
    wide: false,
    image: "/marketing/home-small-batch-inspection.webp",
    imageAlt:
      "Overhead view of a small-batch garment inspection station with folded T-shirts, opened courier polybags, and a white-gloved inspector measuring a sample",
  },
  {
    tag: "Restock Consistency",
    title: "Match new items against approved reference samples",
    body: "Seal your approved Golden Sample in our China vault and receive paired Reference-vs-Incoming photos plus exact dimensional and shade variance records on every reorder.",
    wide: false,
    image: "/marketing/home-reference-comparison.webp",
    imageAlt:
      "Approved reference navy sweatshirt emerging from a protective polybag on the left compared against an incoming restock sweatshirt measured by a white-gloved inspector",
  },
];

const PROCESS_STAGES = [
  {
    step: "01",
    owner: "You (Buyer)",
    title: "Create Inspection",
    body: "Select your apparel category, service type, quantity, and optional target tolerances in your online workspace.",
  },
  {
    step: "02",
    owner: "You + Chinese Seller",
    title: "Send Products to Our China Receiving Center",
    body: "Purchase directly from your chosen suppliers, ship to our China address with your permanent receiving code, and log the seller’s tracking number.",
  },
  {
    step: "03",
    owner: "QCWarehouse Intake",
    title: "Receive & Identify Each Item",
    body: "We verify physical parcel arrival independently of carrier scans, check carton condition, and tag every garment with a unique sample ID.",
  },
  {
    step: "04",
    owner: "QCWarehouse Studio & QA",
    title: "Inspect, Compare & Review",
    body: "Inspectors follow the approved category checklist, record flat tape measurements and defect photos, and publish an independently reviewed English report.",
  },
  {
    step: "05",
    owner: "Your Instruction → QCWarehouse",
    title: "Return, Store or Forward",
    body: "Review the report online or by PDF, then issue item-by-item instructions to return to the seller, retain as a Golden Sample, or dispatch to your forwarder.",
  },
] as const;

export default async function Home() {
  const actor = await actorForSession((await cookies()).get("session")?.value);
  const accountHref = actor?.kind === "customer" ? "/account" : undefined;
  const offers = (await transaction(catalog).catch(() => [])) as LiveOffer[];

  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);

  const primaryInspOffer = inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0];
  const primaryCompOffer = compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0];
  const primaryRefOffer = refOffers[0];

  const inspRate = summarizeRate(inspOffers, "/ item");
  const compRate = summarizeRate(compOffers, "/ group");
  const refRate = summarizeRate(refOffers, "/ match");

  const coreServices = [
    {
      icon: "inspection",
      title: "Product Inspection",
      rate: inspRate,
      href: "/services/inspection",
      orderHref: primaryInspOffer ? `/orders/new?offer=${primaryInspOffer.offer_id}` : "/orders/new",
      positioning:
        "Piece-by-piece verification for prototype samples (1–3 pcs) and small-batch inventory (10–100+ pcs) at our China studio.",
      highlights: [
        "Unique barcode ID & mandatory angle photos per garment",
        "0.1 cm flat-lay tape measurements with two-pass re-checks",
        "Coordinate-boxed defect notes & English PDF report",
      ],
    },
    {
      icon: "compare",
      title: "Sample Comparison",
      rate: compRate,
      href: "/services/compare",
      orderHref: primaryCompOffer ? `/orders/new?offer=${primaryCompOffer.offer_id}` : "/orders/new",
      positioning:
        "Side-by-side evaluation of 2 or 3 comparable candidate samples from different suppliers under identical lighting.",
      highlights: [
        "Single-frame group photo & aligned detail shots",
        "Unified measurement delta table across identical landmarks",
        "Fabric weight, stitching & trim comparison before deposit",
      ],
    },
    {
      icon: "packages",
      title: "Golden Sample Matching",
      rate: refRate,
      href: "/services/reference",
      orderHref: primaryRefOffer ? `/orders/new?offer=${primaryRefOffer.offer_id}` : "/orders/new",
      positioning:
        "Physical benchmark verification of a new pre-production or restock piece against your sealed Golden Sample.",
      highlights: [
        "Paired Reference-vs-Incoming side-by-side studio photos",
        "Point-by-point dimensional, weight & shade drift log",
        "Tamper-evident resealing in our reference sample vault",
      ],
    },
  ] as const;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(homeJsonLd()) }}
      />
      <PublicHeader accountHref={accountHref} staff={actor?.kind === "staff"} actor={actor} demo={isDemo()} path="/" />

      <main className="marketing" id="main-content">
        {/* A. HERO */}
        <section className="pub-hero" aria-labelledby="home-title">
          <div className="pub-hero-bg" aria-hidden="true">
            <img
              src="/marketing/home-inspection-studio.webp"
              alt=""
              width={1920}
              height={1080}
              fetchPriority="high"
              loading="eager"
            />
          </div>
          <div className="pub-hero-inner">
            <p className="pub-hero-kicker">
              Independent Product Inspection in China
            </p>
            <h1 id="home-title">Inspect Before You Ship from China.</h1>
            <p className="pub-hero-sub">
              Know what arrived, what was checked, and what to do next — before paying for international shipping. We inspect supplier samples, check small-batch orders item by item, and document quality issues with measurements and photos so you can decide which items to return, store, or forward.
            </p>
            <div className="pub-hero-actions">
              <Link className="button primary" href="/orders/new">
                Start an Inspection →
              </Link>
              <Link className="button pub-btn-ghost" href="/report-guide">
                View Sample Report
              </Link>
            </div>
            <ul className="pub-hero-facts">
              <li><span aria-hidden="true">✓</span>Individual sample &amp; small-batch inspection</li>
              <li><span aria-hidden="true">✓</span>2–3 supplier sample comparison</li>
              <li><span aria-hidden="true">✓</span>Measurements, photos &amp; documented findings</li>
              <li><span aria-hidden="true">✓</span>Per-item return, storage, or forwarding</li>
            </ul>
          </div>
        </section>

        {/* TRUST STRIP */}
        <div className="pub-trust-bar">
          <ul className="pub-trust-grid">
            {TRUST_CAPABILITIES.map(([icon, title, desc]) => (
              <li className="pub-trust-item" key={title}>
                <span className="pub-trust-icon">
                  <PlatformIcon name={icon} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <small>{desc}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* B. WHAT WE HELP YOU DO */}
        <section className="pub-section" aria-labelledby="home-scenarios">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">BUILT FOR OVERSEAS E-COMMERCE &amp; SMALL-BATCH BUYERS</p>
                <h2 id="home-scenarios">What We Help You Do Before Goods Leave China</h2>
                <p className="pub-lead">
                  QCWarehouse is independent from your suppliers—we don&apos;t source or sell products, and we are not a 3PL warehouse or factory-floor AQL firm. Send the items you buy from Chinese sellers and get actionable evidence on every piece.
                </p>
              </div>
              <Link className="button" href="/how-it-works">
                See how receiving works →
              </Link>
            </div>

            <div className="pub-scenarios">
              {BUYER_SCENARIOS.map((item) => (
                <article
                  key={item.title}
                  className={`pub-scenario-card${item.wide ? " wide" : ""}`}
                >
                  {item.image && (
                    <div className="pub-scenario-media">
                      <img
                        src={item.image}
                        alt={item.imageAlt ?? item.title}
                        width={1350}
                        height={900}
                        loading="eager"
                      />
                    </div>
                  )}
                  <span className="pub-scenario-tag">{item.tag}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* C. CORE INSPECTION SERVICES */}
        <section className="pub-section alt-white" aria-labelledby="home-services">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">CORE INSPECTION SERVICES</p>
                <h2 id="home-services">Three Structured Ways to Verify Physical Merchandise</h2>
                <p className="pub-lead">
                  Every commission follows a versioned category checklist with documented measurement methods and clear scope boundaries—so you know both what was checked and what lies outside non-destructive visual inspection.
                </p>
              </div>
              <Link className="button" href="/catalog">
                Compare all services &amp; packages →
              </Link>
            </div>

            <div className="pub-service-pillars">
              {coreServices.map((svc) => (
                <article className="pub-pillar" key={svc.href}>
                  <div className="pub-pillar-body">
                    <div className="pub-pillar-top">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="pub-trust-icon">
                          <PlatformIcon name={svc.icon} />
                        </span>
                        <h3>{svc.title}</h3>
                      </div>
                      <span className="pub-price-chip">{svc.rate}</span>
                    </div>

                    <p className="pub-pillar-positioning">{svc.positioning}</p>

                    <ul className="pub-pillar-highlights">
                      {svc.highlights.map((pt) => (
                        <li key={pt}>{pt}</li>
                      ))}
                    </ul>

                    <div className="pub-pillar-foot">
                      <Link className="button sm" href={svc.href}>
                        Service details →
                      </Link>
                      <Link className="button primary sm" href={svc.orderHref}>
                        Start Order
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* D. REAL INSPECTION EVIDENCE */}
        <section className="pub-section" aria-labelledby="home-evidence">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">EVIDENCE-FIRST DELIVERABLES</p>
                <h2 id="home-evidence">Inspection Evidence You Can Verify at a Glance</h2>
                <p className="pub-lead">
                  Instead of vague pass/fail opinions, QCWarehouse links every observation to item barcodes, metric tape-in-frame photos, coordinate-marked defects, and published report versions.
                </p>
              </div>
              <Link className="button primary" href="/report-guide">
                Open Full Sample Report →
              </Link>
            </div>

            <div className="pub-evidence-layout">
              <div className="pub-evidence-mosaic stacked">
                <figure className="pub-evidence-card span-2">
                  <div className="pub-evidence-frame ratio-4-3">
                    <img
                      src="/marketing/home-seam-defect.webp"
                      alt="Macro close-up of a loose overlock seam stitch loop on a dark navy sweatshirt side seam"
                      width={1200}
                      height={900}
                      loading="eager"
                    />
                    <svg className="pub-bbox-svg" viewBox="0 0 1200 900" aria-hidden="true">
                      <rect
                        x="520"
                        y="275"
                        width="335"
                        height="255"
                        rx="8"
                        fill="rgba(220, 38, 38, 0.10)"
                        stroke="#dc2626"
                        strokeWidth="4"
                      />
                    </svg>
                  </div>
                  <figcaption>
                    <div>
                      <strong>Annotated Workmanship Documentation</strong>
                      <span>Coordinate boxes highlight localized seam, fabric, or surface flaws without ever editing original camera evidence.</span>
                    </div>
                  </figcaption>
                </figure>

                <figure className="pub-evidence-card span-2">
                  <div className="pub-evidence-frame">
                    <img
                      src="/marketing/home-sorting-dispatch.webp"
                      alt="Outbound sorting and dispatch bench with folded garments, export shipping carton, and digital parcel scale"
                      width={1350}
                      height={760}
                      loading="eager"
                    />
                  </div>
                  <figcaption>
                    <div>
                      <strong>Traceable Post-Inspection Sorting &amp; Packing</strong>
                      <span>Approved stock and seller-return pieces stay separated by individual sample barcode until your dispatch instructions are executed.</span>
                    </div>
                  </figcaption>
                </figure>
              </div>

              <div style={{ display: "grid", gap: 16 }}>
                <SampleReportPreview />
                <div className="pub-surface-box" style={{ padding: 20 }}>
                  <strong style={{ fontSize: 14, color: "#10223a" }}>What every published report documents:</strong>
                  <ul className="pub-check-list" style={{ marginTop: 4 }}>
                    <li><b className="mark-ok">✓</b><span>Garment front/back views, collar/care-label details, and parcel intake records</span></li>
                    <li><b className="mark-ok">✓</b><span>Flat dimensional measurements with unit, method, and re-measurement readings</span></li>
                    <li><b className="mark-ok">✓</b><span>Stitching, seam, and surface defect close-ups with coordinate callouts</span></li>
                    <li><b className="mark-ok">✓</b><span>Side-by-side comparison tables (for 2–3 sample comparison &amp; Golden Sample orders)</span></li>
                    <li><b className="mark-ok">✓</b><span>Explicit statement of uninspected items (no lab, chemical, wash, or factory-wide AQL claims)</span></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* E. HOW IT WORKS */}
        <section className="pub-section alt-navy" aria-labelledby="home-process">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">5-STAGE PHYSICAL CHAIN OF CUSTODY</p>
                <h2 id="home-process">How It Works—From Supplier Parcel to Item Routing</h2>
                <p className="pub-lead">
                  Clear operational ownership at every step. Your merchandise remains your property from arrival through outbound dispatch.
                </p>
              </div>
              <Link className="button pub-btn-ghost" href="/how-it-works">
                Full process &amp; rules →
              </Link>
            </div>

            <ol className="pub-steps-5">
              {PROCESS_STAGES.map((st) => (
                <li className="pub-step-card" key={st.step}>
                  <div className="pub-step-top">
                    <span className="pub-step-num">{st.step}</span>
                    <span className="pub-step-owner">{st.owner}</span>
                  </div>
                  <h3>{st.title}</h3>
                  <p>{st.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* F. CATEGORY COVERAGE & LIVE PRICING PREVIEW */}
        <section className="pub-section alt-white" aria-labelledby="home-pricing-preview">
          <div className="pub-container">
            <div className="pub-split-2">
              {/* Category Focus */}
              <div className="pub-surface-box">
                <div>
                  <p className="pub-eyebrow">CATEGORY COVERAGE</p>
                  <h2 className="pub-h2">Apparel Is Live Today—Built Around Subcategory Checklists</h2>
                  <p className="pub-lead" style={{ fontSize: 14 }}>
                    We open categories only after measurement methods, studio lighting, and inspection templates are validated. Today we inspect apparel across dedicated templates:
                  </p>
                </div>

                <div className="pub-rate-rows">
                  <div className="pub-rate-row">
                    <div>
                      <strong>Tops, T-Shirts, Hoodies &amp; Knitwear</strong>
                      <small>HPS length, chest width, shoulder, sleeve, hem, collar rib &amp; seams</small>
                    </div>
                    <span className="tag green">Active</span>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>Leggings, Pants, Shorts &amp; Bottoms</strong>
                      <small>Waistband, hip, front/back rise, thigh, inseam, outseam &amp; gusset</small>
                    </div>
                    <span className="tag green">Active</span>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>Sports Bras &amp; Intimate Activewear</strong>
                      <small>Underband, bust width, strap symmetry, cup lining &amp; elastic recovery visual check</small>
                    </div>
                    <span className="tag green">Active</span>
                  </div>
                </div>

                <p className="small muted" style={{ margin: 0 }}>
                  <strong>Planned &amp; restricted categories:</strong> Footwear, Bags &amp; Accessories, and Home Goods are planned for future rollout and cannot be ordered yet. Electronics and regulated children’s products are restricted.
                </p>

                <div className="row flexwrap" style={{ gap: 10, marginTop: "auto" }}>
                  <Link className="button" href="/categories">
                    Explore Supported Products →
                  </Link>
                  <Link className="button" href="/contact?topic=category">
                    Ask About Another Category
                  </Link>
                </div>
              </div>

              {/* Pricing Preview */}
              <div className="pub-surface-box" id="home-pricing-preview">
                <div>
                  <p className="pub-eyebrow">TRANSPARENT SERVICE PRICING</p>
                  <h2 className="pub-h2">Clear Inspection Fees—Separate from Shipping</h2>
                  <p className="pub-lead" style={{ fontSize: 14 }}>
                    Pay per commissioned item or comparison set based on our active server catalog. Domestic return or forwarding postage is quoted only after you review your report and select items.
                  </p>
                </div>

                {hasDemoRates && (
                  <div className="line-note warning" style={{ margin: 0, fontSize: 12 }}>
                    <strong>Catalog status note:</strong> Displayed rates reflect the active pre-launch / demo server schedule. Exact price snapshots are confirmed on your order quote before payment.
                  </div>
                )}

                <div className="pub-rate-rows">
                  <div className="pub-rate-row">
                    <div>
                      <strong>Piece-by-Piece Product Inspection</strong>
                      <small>1–100 items online · General &amp; subcategory apparel templates</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{inspRate}</b>
                      <span>101+ items: manual quote</span>
                    </div>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>Side-by-Side Sample Comparison</strong>
                      <small>2 or 3 comparable items evaluated together as one group</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{compRate}</b>
                      <span>2-item &amp; 3-item sets</span>
                    </div>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>Golden Sample Reference Matching</strong>
                      <small>Incoming sample compared against your retained reference</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{refRate}</b>
                      <span>per incoming sample</span>
                    </div>
                  </div>
                </div>

                <div className="row flexwrap" style={{ gap: 10, marginTop: "auto" }}>
                  <Link className="button primary" href="/pricing">
                    Open Fee Calculator &amp; Rate Table →
                  </Link>
                  <Link className="button" href="/catalog#packages">
                    View All Packages
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* G. FINAL CTA */}
        <section className="pub-section">
          <div className="pub-container">
            <div className="pub-cta-banner">
              <div>
                <p className="pub-eyebrow" style={{ color: "#93b8ff" }}>READY TO VERIFY YOUR NEXT SHIPMENT?</p>
                <h2>Know What Arrived in China Before Paying International Freight.</h2>
                <p>
                  Create your free QCWarehouse account to get your dedicated China receiving address and permanent parcel code, configure your first sample comparison or small-batch inspection, and see documented measurements and photos before committing inventory overseas.
                </p>
              </div>
              <div className="pub-cta-actions">
                <Link className="button primary" href="/orders/new">
                  Start an Inspection →
                </Link>
                <Link className="button pub-btn-ghost" href="/contact">
                  Ask About Custom Scope
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </>
  );
}
