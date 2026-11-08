"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InspectionSpecPanel, type SpecFrameTone, type SpecIconKind } from "./public-media";

export function ApparelIllustration({ kind = "shirt" }: { kind?: "shirt" | "bag" | "shoe" }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width="84"
      height="84"
      fill="none"
      stroke="#6c8dad"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "shirt" ? (
        <path d="M37 16 18 29 7 52l25 14 7-14v52h53V52l7 14 25-14-13-23-21-13c-12 17-28 17-43 0Z" />
      ) : kind === "bag" ? (
        <path d="M27 48h68l7 53H20l7-53Zm17 0V37a17 17 0 0 1 34 0v11" />
      ) : (
        <path d="M11 79c25-3 38-31 54-46 18 27 24 27 45 37v20H11Z" />
      )}
    </svg>
  );
}

export function PhotoCardPlaceholder({ title, label = "ILLUSTRATIVE" }: { title: string; label?: string }) {
  return (
    <div className="photo">
      <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
        <rect x="9" y="13" width="46" height="38" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="24" cy="26" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M13 44 29 31l8 8 7-6 8 11" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="demo-mark">{label}</span>
      <b>{title}</b>
    </div>
  );
}

export function EvidenceIllustration() {
  return (
    <figure className="evidence-figure">
      <div className="evidence-head">
        <span>INSPECTION / REPORT STRUCTURE</span>
        <span>ILLUSTRATION</span>
      </div>
      <div className="evidence-body">
        <div className="evidence-diagram" aria-hidden="true">
          <svg viewBox="0 0 360 250" fill="none">
            <defs>
              <pattern id="measurement-grid" width="18" height="18" patternUnits="userSpaceOnUse">
                <path d="M18 0H0v18" stroke="#344764" strokeWidth="1" />
              </pattern>
            </defs>
            <path d="M0 0H360V250H0z" fill="url(#measurement-grid)" />
            <path d="M72 41h216v167H72z" stroke="#415779" strokeDasharray="4 5" />
            <path
              d="m153 56-42 17-27 43 41 23 13-20v71h84v-71l13 20 41-23-27-43-42-17c-5 14-13 19-27 19s-22-5-27-19Z"
              fill="#1e3658"
              stroke="#b9cdf2"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M137 119h86M180 83v103M128 113v12M232 113v12M132 119h-7m103 0h7" stroke="#81a8fc" strokeWidth="1.25" strokeDasharray="4 3" />
            <circle cx="180" cy="119" r="3.5" fill="#cbdcff" />
            <path d="M180 119h104l20-20h31" stroke="#a2bfff" />
            <rect x="300" y="76" width="37" height="22" rx="2" fill="#b6cbfa" />
            <text x="309" y="91" fill="#132642" fontSize="11" fontFamily="monospace">A01</text>
            <path d="M72 228h216M72 221v14M108 224v8M144 224v8M180 221v14M216 224v8M252 224v8M288 221v14" stroke="#8097ba" />
          </svg>
        </div>
        <dl className="evidence-fields">
          <div><dt>CHECKPOINT</dt><dd>Chest width (1/2)</dd></div>
          <div><dt>METHOD</dt><dd>Laid flat, unstrained</dd></div>
          <div><dt>EVIDENCE</dt><dd>Metric tape photo + log</dd></div>
        </dl>
      </div>
      <figcaption>
        Apparel template example <span aria-hidden="true">/</span> Checkpoints follow the approved category version.
      </figcaption>
    </figure>
  );
}

export function SampleReportPreview() {
  return (
    <figure className="report-artifact">
      <div className="report-ribbon">
        <strong>▤ &nbsp; QCWarehouse · Sample Excerpt</strong>
        <span>DEMONSTRATION DATA</span>
      </div>
      <dl className="proof-data">
        <div>
          <dt>Order / Report</dt>
          <dd>QW-DEMO-204<br />Version 02 · Reviewed</dd>
        </div>
        <div>
          <dt>Commissioned Service</dt>
          <dd>Sample Comparison<br />3 Cotton Crewneck Tops (L)</dd>
        </div>
        <div>
          <dt>Bench Conditions</dt>
          <dd>Laid flat · Unstrained<br />Metric tape · 0.1 cm</dd>
        </div>
      </dl>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Demonstration measurement and defect excerpt">
        <table style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th scope="col">Checkpoint</th>
              <th scope="col">Target (±Tol)</th>
              <th scope="col">Sample A</th>
              <th scope="col">Sample B</th>
              <th scope="col">Sample C</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Chest width (1/2)</th>
              <td>55.0 (±1.0 cm)</td>
              <td>55.1 cm</td>
              <td><strong>56.6 cm ▲</strong></td>
              <td>54.9 cm</td>
            </tr>
            <tr>
              <th scope="row">Front length (HPS)</th>
              <td>72.0 (±1.0 cm)</td>
              <td>72.0 cm</td>
              <td>71.4 cm</td>
              <td>72.2 cm</td>
            </tr>
            <tr>
              <th scope="row">Garment mass</th>
              <td>Ref ~235 g</td>
              <td>238 g</td>
              <td>214 g</td>
              <td>241 g</td>
            </tr>
            <tr>
              <th scope="row">Workmanship</th>
              <td>No visible defect</td>
              <td>Clean</td>
              <td><strong>2 notes (B-DEF-01/02)</strong></td>
              <td>Clean</td>
            </tr>
          </tbody>
        </table>
      </div>
      <figcaption style={{ marginTop: 12 }}>
        <strong>Demonstration / Illustrative example only:</strong> Item codes, measurements (such as the 55.1 cm chest example), and supplier rows illustrate report structure only—never audited physical inspection results. Excludes chemical lab testing, shrinkage, and bulk AQL claims.
      </figcaption>
    </figure>
  );
}

type LightboxItem = {
  code: string;
  title: string;
  caption: string;
  span2?: boolean;
  src?: string;
  alt?: string;
  specCard?: {
    slotId: string;
    eyebrow: string;
    title: string;
    summary: string;
    highlights: readonly string[];
    icon: SpecIconKind;
    tone: SpecFrameTone;
  };
};

const DEMO_SAMPLES = [
  {
    code: "S-DEMO-204A",
    alias: "Illustrative Supplier A (Guangzhou)",
    parcel: "Demo Parcel #1",
    size: "Labeled L",
    weight: "238 g (example)",
    outcome: "Within illustrative spec · Retained as example Golden Sample",
    tone: "green",
  },
  {
    code: "S-DEMO-204B",
    alias: "Illustrative Supplier B (Dongguan)",
    parcel: "Demo Parcel #2",
    size: "Labeled L",
    weight: "214 g (example)",
    outcome: "Example out-of-tolerance chest (+1.6 cm) · 2 annotated defect demos",
    tone: "red",
  },
  {
    code: "S-DEMO-204C",
    alias: "Illustrative Supplier C (Ningbo)",
    parcel: "Demo Parcel #3",
    size: "Labeled L",
    weight: "241 g (example)",
    outcome: "Within illustrative spec · Routed to example forwarder",
    tone: "blue",
  },
] as const;

const MEASUREMENT_ROWS = [
  {
    point: "Chest Width (1/2, Pit-to-Pit)",
    method: "Laid flat unstrained, 2.5 cm below armhole seam",
    target: "55.0 cm",
    tol: "±1.0 cm",
    a: "55.1 cm",
    b: "56.6 cm",
    bFlag: true,
    c: "54.9 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 56.7 cm, Read 2 = 56.5 cm → Final 56.6 cm",
  },
  {
    point: "Front Body Length (HPS to Hem)",
    method: "High Point Shoulder vertically to bottom hem edge",
    target: "72.0 cm",
    tol: "±1.0 cm",
    a: "72.0 cm",
    b: "71.4 cm",
    bFlag: false,
    c: "72.2 cm",
    recheck: "Example Read 1 & Read 2 within 0.2 cm variance limit",
  },
  {
    point: "Across Shoulder (Seam to Seam)",
    method: "Straight line between left and right shoulder points",
    target: "48.0 cm",
    tol: "±0.8 cm",
    a: "48.0 cm",
    b: "48.9 cm",
    bFlag: true,
    c: "48.1 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 48.9 cm, Read 2 = 48.9 cm → Final 48.9 cm",
  },
  {
    point: "Sleeve Length (Shoulder Seam to Cuff)",
    method: "Outer fold from shoulder crown to sleeve opening",
    target: "22.0 cm",
    tol: "±0.8 cm",
    a: "22.1 cm",
    b: "21.8 cm",
    bFlag: false,
    c: "22.0 cm",
    recheck: "Single-pass format example recorded to 0.1 cm precision",
  },
  {
    point: "Bottom Hem Opening (1/2 Flat)",
    method: "Horizontal edge-to-edge along bottom sweep",
    target: "55.0 cm",
    tol: "±1.0 cm",
    a: "55.0 cm",
    b: "56.2 cm",
    bFlag: true,
    c: "54.8 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 56.2 cm, Read 2 = 56.2 cm → Final 56.2 cm",
  },
  {
    point: "Unit Garment Mass",
    method: "Calibrated bench digital scale (1 g resolution, unpackaged)",
    target: "Ref ~235 g",
    tol: "Observation",
    a: "238 g",
    b: "214 g",
    bFlag: false,
    c: "241 g",
    recheck: "Unpackaged scale check format · 22 °C indoor studio",
  },
] as const;

const PHOTO_EVIDENCE: LightboxItem[] = [
  {
    code: "FRM-01 · FRONT OVERVIEW",
    title: "S-DEMO-204A · Front Overview (Heather-Gray Crewneck, Size L)",
    caption: "Mandatory flat front frame linking Sample A to collar rib, cuffs, and printed care label records.",
    specCard: {
      slotId: "PH-19",
      eyebrow: "Mandatory Angle 01 · Front",
      title: "Full Garment Front Flat-Lay Overview Specification",
      summary: "Captured square to the bench under 5600K studio illumination to document collar rib, sleeve set, hem symmetry, and garment drape before tape placement.",
      highlights: ["90° Overhead Camera", "Untouched Raw File", "Linked to Sample ID"],
      icon: "garment",
      tone: "slate",
    },
  },
  {
    code: "FRM-02 · BACK OVERVIEW",
    title: "S-DEMO-204A · Back Overview & Half-Moon Yoke",
    caption: "Rear flat view captured on the identical garment, camera plane, and bench setup to confirm back jersey construction and hem finish.",
    specCard: {
      slotId: "PH-20",
      eyebrow: "Mandatory Angle 02 · Rear",
      title: "Full Garment Back Flat-Lay Overview Specification",
      summary: "Identical lighting and lens distance documenting back shoulder seam balance, neck yoke stitching, and lower rear jersey surface.",
      highlights: ["Matching Bench Scale", "Rear Seam Check", "Care/Size Label Cross-Check"],
      icon: "garment",
      tone: "slate",
    },
  },
  {
    code: "FRM-03 · CHEST TAPE PROOF",
    title: "S-DEMO-204A · Chest Width Tape Measurement (Illustrative Example)",
    src: "/marketing/report-sample-a-chest-measure.webp",
    alt: "Overhead illustrative studio photo showing a yellow metric tape measuring horizontal chest width across a heather-gray cotton crewneck T-shirt",
    caption: "Illustrative studio frame showing unstrained seam-to-seam chest measurement with readable metric endpoints across the gray tee.",
  },
  {
    code: "FRM-04 · HPS LENGTH PROOF",
    title: "S-DEMO-204A · Front Body Length HPS-to-Hem (Illustrative Example)",
    src: "/marketing/report-sample-a-body-length.webp",
    alt: "Overhead illustrative studio photo showing a yellow metric tape measuring front body length vertically from high point shoulder to bottom hem on a heather-gray cotton crewneck T-shirt",
    caption: "Illustrative vertical tape proof from High Point Shoulder (HPS) to bottom hem edge captured under the identical gray tee setup.",
  },
  {
    code: "FRM-05 · GROUP OVERHEAD (A / B / C)",
    title: "Side-by-Side Comparison Frame (Samples A, B & C)",
    caption: "Synchronized single-frame overhead comparison grouping all three candidate samples on one bench for direct visual comparison.",
    span2: true,
    specCard: {
      slotId: "PH-23",
      eyebrow: "Synchronized Comparison Frame",
      title: "Three Candidate Samples Aligned Side by Side on One Studio Table",
      summary: "Places Supplier A, Supplier B, and Supplier C samples in parallel under unified 5600K LED illumination so drape, collar rib recovery, shade consistency, and outline width can be evaluated in one view.",
      highlights: ["Unified Camera Plane", "Matched Garment Placement", "Zero Exposure Distortion", "Cross-Linked to Delta Table"],
      icon: "compare",
      tone: "blue",
    },
  },
];

export function ReportGuide() {
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>Sample Inspection Report</strong>
      </div>

      {/* Page Masthead */}
      <section className="pub-page-hero">
        <div className="row between flexwrap" style={{ gap: 20, alignItems: "flex-end" }}>
          <div>
            <p className="pub-eyebrow">DELIVERABLE PREVIEW · REPORT STRUCTURE</p>
            <h1>Sample Inspection &amp; Comparison Report</h1>
            <p style={{ marginBottom: 16 }}>
              Inspect the exact structure, measurement traceability, non-destructive defect annotations, and scope boundaries you receive before deciding whether to return, store, or ship your items from China.
            </p>
            <div className="row flexwrap no-print" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Start Your Own Inspection →
              </Link>
              <button
                type="button"
                className="button"
                onClick={() => window.print()}
              >
                Print / Save Sample PDF Preview
              </button>
              <Link className="button" href="/catalog">
                Compare Services
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0, minWidth: "min(340px, 100%)" }}>
            <div className="def">
              <dt>Demo Garment Identity</dt>
              <dd>Heather-Gray Crewneck · Size L</dd>
            </div>
            <div className="def">
              <dt>Report Snapshot</dt>
              <dd>RPT-DEMO-204 · Immutable v2</dd>
            </div>
          </div>
        </div>
      </section>

      {/* Honest Demonstration Disclosure */}
      <div className="line-note warning" style={{ marginBottom: 22 }} role="note">
        <strong>Demonstration report — illustrative images and synthetic inspection data. Not an actual customer inspection.</strong> Sample IDs, parcel references, example readings (such as 55.1 cm chest width), supplier rows (Suppliers A/B/C), and illustrative photos demonstrate QCWarehouse’s report structure only; real client orders contain unaltered physical garment photographs and verified audit records.
      </div>

      {/* Full Printable Sample Report Sheet */}
      <article className="pub-report-sheet" aria-label="Sample Inspection Report Sheet">
        {/* 1. Report Summary Header */}
        <header className="pub-report-banner">
          <div>
            <div className="pub-eyebrow" style={{ color: "#93b8ff", marginBottom: 4 }}>
              QCWAREHOUSE · INDEPENDENT RECEIVING-CENTER REPORT
            </div>
            <h2>Apparel Sample Comparison &amp; Workmanship Report</h2>
            <p>
              Report <span className="code">RPT-DEMO-204</span> · Published Version <span className="code">v2</span> · Order <span className="code">QW-DEMO-204</span> · Category: <strong>Apparel / Tops &amp; Knitwear</strong>
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag yellow">DEMONSTRATION</span>
            <span className="tag blue">3 SAMPLES COMPARED</span>
          </div>
        </header>

        {/* Executive Summary */}
        <section className="pub-report-section" id="report-summary">
          <p className="pub-eyebrow">01 · REPORT SUMMARY</p>
          <h3>Executive Summary for Buyer Decision</h3>
          <p className="small muted" style={{ maxWidth: "82ch", marginBottom: 14 }}>
            Three unbranded heavyweight cotton crewneck T-shirt samples (labeled Size L) received from three separate domestic Chinese parcels were checked under identical bench lighting and flat-lay measurement rules against buyer-supplied reference specifications.
          </p>
          <div className="grid cols4">
            <div className="def">
              <dt>Commissioned Service</dt>
              <dd>Tops 3-Item Comparison</dd>
            </div>
            <div className="def">
              <dt>Bench Environment</dt>
              <dd>Indoor 22 °C · 5600K LED</dd>
            </div>
            <div className="def">
              <dt>Measurement Tool</dt>
              <dd>Calibrated Metric Tape (0.1 cm)</dd>
            </div>
            <div className="def">
              <dt>Recorded Evidence</dt>
              <dd>5 Core Frames + 2 Defect Boxes</dd>
            </div>
          </div>
        </section>

        {/* 2. Scope of Inspection */}
        <section className="pub-report-section" id="report-scope">
          <p className="pub-eyebrow">02 · SCOPE OF INSPECTION</p>
          <h3>Commissioned Checkpoints vs. Uninspected Scope</h3>
          <div className="pub-boundary-grid" style={{ marginTop: 12 }}>
            <div className="pub-boundary-box included">
              <strong style={{ color: "#0b816b" }}>Executed under Template v2 (Apparel — Tops)</strong>
              <ul className="pub-check-list">
                <li><b className="mark-ok">✓</b><span>Per-parcel arrival check-in and individual sample barcode assignment (<span className="code">S-DEMO-204A..C</span>).</span></li>
                <li><b className="mark-ok">✓</b><span>5 flat-lay dimensional measurements with automatic two-pass re-measurement when variance exceeds threshold.</span></li>
                <li><b className="mark-ok">✓</b><span>Unpackaged single-garment digital scale weight (1 g resolution).</span></li>
                <li><b className="mark-ok">✓</b><span>Visual workmanship check across collar, chest, shoulder tape, side seams, cuffs, hem, and care label.</span></li>
              </ul>
            </div>
            <div className="pub-boundary-box excluded">
              <strong style={{ color: "#b24046" }}>Explicitly Outside Commissioned Scope</strong>
              <ul className="pub-check-list">
                <li><b className="mark-no">—</b><span><strong>No laboratory or chemical testing:</strong> Fiber composition %, azo/formaldehyde tests, and cut-swatch GSM tests are not performed.</span></li>
                <li><b className="mark-no">—</b><span><strong>No wash or durability testing:</strong> Shrinkage after laundering, pilling, and colorfastness are outside non-destructive check scope.</span></li>
                <li><b className="mark-no">—</b><span><strong>No bulk factory AQL representation:</strong> Findings apply strictly to the 3 physical items received at our facility.</span></li>
                <li><b className="mark-no">—</b><span><strong>No brand authenticity or regulatory safety certification.</strong></span></li>
              </ul>
            </div>
          </div>
        </section>

        {/* 3. Sample Identification */}
        <section className="pub-report-section" id="sample-identification">
          <p className="pub-eyebrow">03 · SAMPLE IDENTIFICATION</p>
          <h3>Registered Physical Items &amp; Chain of Custody</h3>
          <div className="pub-sample-id-grid">
            {DEMO_SAMPLES.map((s) => (
              <div className="pub-sample-id-card" key={s.code}>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <strong className="code" style={{ fontSize: 14 }}>{s.code}</strong>
                  <span className={`tag ${s.tone}`}>{s.size}</span>
                </div>
                <p style={{ fontSize: 13, fontWeight: 700, color: "#152842", marginBottom: 4 }}>{s.alias}</p>
                <p className="small muted" style={{ marginBottom: 8 }}>
                  Inbound Waybill: <span className="code">{s.parcel}</span> · Mass: <strong>{s.weight}</strong>
                </p>
                <div className="small" style={{ color: s.tone === "red" ? "#9e2a30" : "#1d3b5c", fontWeight: 650 }}>
                  {s.outcome}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4. Measurement Comparison & Re-measurement Traceability */}
        <section className="pub-report-section" id="measurement-comparison">
          <p className="pub-eyebrow">04 · MEASUREMENT COMPARISON &amp; RE-MEASUREMENT LOG</p>
          <h3>Side-by-Side Flat Measurements &amp; Two-Pass Verification</h3>
          <p className="small muted" style={{ marginBottom: 12 }}>
            When an observed measurement deviates beyond the buyer’s supplied tolerance or shows inter-pass variance above 0.3 cm, QCWarehouse’s workbench requires a second independent tape reading and logs both raw readings in the published snapshot.
          </p>
          <div className="tablewrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Measurement Point &amp; Method</th>
                  <th>Buyer Target</th>
                  <th>Sample A</th>
                  <th>Sample B</th>
                  <th>Sample C</th>
                  <th>Traceability &amp; Re-Check Log</th>
                </tr>
              </thead>
              <tbody>
                {MEASUREMENT_ROWS.map((r) => (
                  <tr key={r.point}>
                    <td>
                      <strong>{r.point}</strong>
                      <div className="small muted">{r.method}</div>
                    </td>
                    <td className="mono">{r.target}<br /><small>{r.tol}</small></td>
                    <td className="mono">{r.a}</td>
                    <td className="mono" style={r.bFlag ? { color: "#b24046", fontWeight: 800, background: "#fff5f5" } : undefined}>
                      {r.b} {r.bFlag ? "▲" : ""}
                    </td>
                    <td className="mono">{r.c}</td>
                    <td className="small">{r.recheck}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 5. Original Photo Evidence */}
        <section className="pub-report-section" id="photo-evidence">
          <div className="row between flexwrap">
            <div>
              <p className="pub-eyebrow">05 · ORIGINAL PHOTO EVIDENCE</p>
              <h3>Mandatory Angle &amp; Tape-in-Frame Documentation</h3>
            </div>
            <span className="small muted no-print">Click any frame to inspect full-resolution details</span>
          </div>
          <div className="pub-evidence-gallery">
            {PHOTO_EVIDENCE.map((item) => (
              <figure className={`pub-evidence-card${item.span2 ? " span-2" : ""}`} key={item.code}>
                <button
                  type="button"
                  className="pub-zoom-trigger"
                  onClick={() => setLightbox(item)}
                  aria-label={`Inspect ${item.title}`}
                >
                  {item.src ? (
                    <div className="pub-evidence-frame">
                      <img src={item.src} alt={item.alt ?? item.title} width={1200} height={900} loading="eager" />
                    </div>
                  ) : (
                    item.specCard && (
                      <div className="pub-evidence-frame" style={{ background: "transparent" }}>
                        <InspectionSpecPanel {...item.specCard} compact />
                      </div>
                    )
                  )}
                </button>
                <figcaption>
                  <div>
                    <span className="code" style={{ fontSize: 11, color: "#1f56c8", fontWeight: 700 }}>{item.code}</span>
                    <strong>{item.title}</strong>
                    <span>{item.caption}</span>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* 6. Defect Annotations */}
        <section className="pub-report-section" id="defect-annotations">
          <div className="row between flexwrap">
            <div>
              <p className="pub-eyebrow">06 · DEFECT ANNOTATIONS (INTERACTIVE SCHEMA PREVIEW)</p>
              <h3>Illustrative Workmanship &amp; Surface Callout Format</h3>
              <p className="small muted" style={{ margin: 0 }}>
                Raw inspection photos remain unaltered in storage; reviewer-verified bounding coordinates and English defect labels render non-destructively in the UI layer. Entries below illustrate data schema only.
              </p>
            </div>
            <button
              type="button"
              className="button sm no-print"
              onClick={() => setShowAnnotations((v) => !v)}
              aria-pressed={showAnnotations}
            >
              {showAnnotations ? "Hide Coordinate Callouts" : "Show Coordinate Callouts"}
            </button>
          </div>

          <div className="pub-defect-grid">
            <figure className="pub-evidence-card" data-asset-slot="PH-24">
              <div className={`pub-callout-bar${showAnnotations ? "" : " is-muted"}`}>
                <span>{showAnnotations ? "COORDINATE OVERLAY ACTIVE · UI LAYER DEMO" : "RAW CAPTURE MODE · OVERLAY HIDDEN"}</span>
                <span className="code">B-DEF-01</span>
              </div>
              <div className="pub-defect-schema-card">
                <InspectionSpecPanel
                  slotId="PH-24"
                  eyebrow="Side-Seam Workmanship Record Format"
                  title="Sample B — Side-Seam Macro Schema"
                  summary="On inspected garments, reviewers attach bounding coordinates and bilingual issue notes onto the macro side-seam photograph without touching source pixels."
                  icon="defect"
                  tone={showAnnotations ? "amber" : "slate"}
                  compact
                />
                {showAnnotations && (
                  <div className="pub-defect-coords">
                    <div><span>Garment Zone</span><strong>Left Side Seam</strong></div>
                    <div><span>UI Coordinate Box</span><strong className="mono">x:0.74 y:0.36</strong></div>
                    <div><span>Example Dimension</span><strong>~14 mm thread loop</strong></div>
                  </div>
                )}
              </div>
              <figcaption>
                <div>
                  <span className="code" style={{ color: "#b24046", fontWeight: 800, fontSize: 11 }}>
                    ILLUSTRATIVE ENTRY · SIDE SEAM WORKMANSHIP
                  </span>
                  <strong>Example defect format: Unsecured ~14 mm overlock loop along side seam</strong>
                  <span>Example bench translation format (zh → EN): Reviewer verifies coordinate box + objective description without subjective pass/fail verdicts.</span>
                </div>
              </figcaption>
            </figure>

            <figure className="pub-evidence-card" data-asset-slot="PH-25">
              <div className={`pub-callout-bar${showAnnotations ? "" : " is-muted"}`}>
                <span>{showAnnotations ? "COORDINATE OVERLAY ACTIVE · UI LAYER DEMO" : "RAW CAPTURE MODE · OVERLAY HIDDEN"}</span>
                <span className="code">B-DEF-02</span>
              </div>
              <div className="pub-defect-schema-card">
                <InspectionSpecPanel
                  slotId="PH-25"
                  eyebrow="Surface Contamination Record Format"
                  title="Sample B — Front Jersey Mark Schema"
                  summary="Localized surface marks are isolated with coordinate boxes alongside objective millimeter dimensions so buyers can decide between seller return or spot-cleaning."
                  icon="defect"
                  tone={showAnnotations ? "amber" : "slate"}
                  compact
                />
                {showAnnotations && (
                  <div className="pub-defect-coords">
                    <div><span>Garment Zone</span><strong>Lower Front Panel</strong></div>
                    <div><span>UI Coordinate Box</span><strong className="mono">x:0.74 y:0.36</strong></div>
                    <div><span>Example Dimension</span><strong>~8 mm surface spot</strong></div>
                  </div>
                )}
              </div>
              <figcaption>
                <div>
                  <span className="code" style={{ color: "#b24046", fontWeight: 800, fontSize: 11 }}>
                    ILLUSTRATIVE ENTRY · FABRIC SURFACE
                  </span>
                  <strong>Example defect format: Localized ~8 mm brownish spot on lower front panel</strong>
                  <span>Original zh-CN field observation remains preserved on audit record while customer view displays reviewed English text.</span>
                </div>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* 7. Golden Sample Comparison Excerpt */}
        <section className="pub-report-section" id="golden-sample-comparison">
          <p className="pub-eyebrow">07 · GOLDEN SAMPLE MATCHING (FOLLOW-ON WORKFLOW)</p>
          <h3>How Approved Samples Become Your Retained Reference Benchmark</h3>
          <div className="pub-service-detail" style={{ margin: "14px 0 0", padding: 20, background: "#f8fafd" }}>
            <div>
              <p style={{ color: "#22364f", fontSize: 13.5, lineHeight: 1.6 }}>
                After reviewing a comparison or inspection report, you can instruct QCWarehouse to seal an approved item (for example, <span className="code">S-DEMO-204A</span>) inside dedicated tamper-sealed reference storage. When your supplier ships a restock or pre-production piece weeks later, you order <strong>Golden Sample Matching</strong> so our inspector lays the sealed reference next to the incoming garment and records any dimensional or shade drift.
              </p>
              <div className="row flexwrap no-print" style={{ gap: 8, marginTop: 12 }}>
                <Link className="button sm" href="/services/reference">
                  Explore Golden Sample Matching →
                </Link>
              </div>
            </div>
            <div className="pub-photo-box" style={{ background: "transparent", border: "0" }}>
              <InspectionSpecPanel
                slotId="PH-26"
                eyebrow="Restock Verification Protocol"
                title="Side-by-Side Retained Golden Sample vs. Incoming Unit"
                summary="Sealed reference garment is checked out from protected vault custody, aligned beside the incoming shipment item on the 5600K bench, measured for variance, and resealed after photo lock."
                highlights={["Vault Seal Log", "Dimensional Delta", "Shade & Rib Check"]}
                icon="reference"
                tone="amber"
                compact
              />
            </div>
          </div>
        </section>

        {/* 8. Findings, Buyer Routing & Limitations */}
        <section className="pub-report-section" id="findings-limitations">
          <p className="pub-eyebrow">08 · FINDINGS, ITEM ROUTING &amp; LIMITATIONS</p>
          <h3>Recorded Buyer Post-Inspection Instructions (Illustrative Example)</h3>
          <div className="tablewrap" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Sample ID</th>
                  <th>Illustrative Observation Entry</th>
                  <th>Example Post-Report Buyer Instruction</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono"><strong>S-DEMO-204A</strong></td>
                  <td>Illustrative measurements near target; 238 g example mass; clean seams.</td>
                  <td><span className="tag green">Convert to Golden Sample</span> · Sealed into protected reference storage.</td>
                </tr>
                <tr>
                  <td className="mono"><strong>S-DEMO-204B</strong></td>
                  <td>Illustrative chest +1.6 cm over spec; 214 g example weight; annotated issues (<span className="code">B-DEF-01/02</span>).</td>
                  <td><span className="tag red">Return to Seller</span> · Buyer arranges seller RMA &amp; domestic courier return quote.</td>
                </tr>
                <tr>
                  <td className="mono"><strong>S-DEMO-204C</strong></td>
                  <td>Illustrative dimensions near target; 241 g example weight; clean seams.</td>
                  <td><span className="tag blue">Forward to Freight Forwarder</span> · Consolidated to buyer’s China forwarder address.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Report limitation notice:</strong> QCWarehouse does not rank suppliers or make commercial pass/fail guarantees on unobserved bulk production. Merchandise refund eligibility for returned items remains subject to your purchase agreement with the seller.
          </p>
        </section>

        {/* 9. Report Version & Review Information */}
        <section className="pub-report-section" id="version-history">
          <p className="pub-eyebrow">09 · REPORT VERSION &amp; IMMUTABILITY RECORD</p>
          <h3>Published Revision Audit Trail</h3>
          <div className="grid cols3" style={{ marginTop: 12 }}>
            <div className="def">
              <dt>Published Snapshot</dt>
              <dd>Version 2 · Locked &amp; Immutable</dd>
            </div>
            <div className="def">
              <dt>Bench &amp; QA Sign-Off</dt>
              <dd>Inspector INS-04 → Reviewer REV-02</dd>
            </div>
            <div className="def">
              <dt>Revision Reason (v1 → v2)</dt>
              <dd>Added Sample B seam macro translation</dd>
            </div>
          </div>
          <div className="line-note success" style={{ marginTop: 12, marginBottom: 0 }}>
            Every published report version in QCWarehouse is stored as an immutable snapshot—online views and downloaded PDFs always render the exact same verified measurements, defect coordinates, and revision history without silent edits.
          </div>
        </section>

        {/* 10. Sample PDF Preview / Conversion Action */}
        <section className="pub-report-section no-print" id="pdf-download" style={{ background: "#f8fafd" }}>
          <div className="row between flexwrap" style={{ gap: 16 }}>
            <div>
              <p className="pub-eyebrow" style={{ marginBottom: 4 }}>10 · SAMPLE PDF &amp; NEXT STEP</p>
              <h3 style={{ marginBottom: 4 }}>Save a Print/PDF Copy or Commission Your Own Inspection</h3>
              <p className="small muted" style={{ margin: 0 }}>
                Real customer orders include one-click server-generated PDF downloads and optional revocable read-only share links for suppliers.
              </p>
            </div>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <button type="button" className="button" onClick={() => window.print()}>
                Print / Save Sample PDF
              </button>
              <Link className="button" href="/pricing">
                Estimate Inspection Fee
              </Link>
              <Link className="button primary" href="/orders/new">
                Start an Inspection →
              </Link>
            </div>
          </div>
        </section>
      </article>

      {/* Lightbox Modal for Evidence Inspection */}
      {lightbox && (
        <div
          className="lightbox-backdrop no-print"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.title}
          onClick={() => setLightbox(null)}
        >
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <div>
              <span className="code" style={{ color: "#93b8ff", fontSize: 12 }}>{lightbox.code}</span>
              <strong style={{ display: "block", fontSize: 15 }}>{lightbox.title}</strong>
            </div>
            <button type="button" className="button sm" onClick={() => setLightbox(null)}>
              Close Preview ✕
            </button>
          </div>
          <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
            {lightbox.src ? (
              <img className="lightbox-img" src={lightbox.src} alt={lightbox.alt ?? lightbox.title} />
            ) : (
              lightbox.specCard && (
                <div className="lightbox-pending-wrap">
                  <InspectionSpecPanel {...lightbox.specCard} />
                </div>
              )
            )}
          </div>
          <div style={{ textAlign: "center", fontSize: 12.5, color: "#cbd8ea" }} onClick={(e) => e.stopPropagation()}>
            {lightbox.caption}
          </div>
        </div>
      )}
    </>
  );
}
