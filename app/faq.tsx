"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type FaqEntry = {
  id: string;
  question: string;
  answer: string;
};

type FaqCategory = {
  key: string;
  title: string;
  items: FaqEntry[];
};

const FAQ_CATEGORIES: FaqCategory[] = [
  {
    key: "suppliers-receiving",
    title: "Suppliers & Receiving",
    items: [
      {
        id: "multi-supplier",
        question: "Can I send items from multiple Chinese suppliers?",
        answer:
          "Yes. You purchase directly from any combination of 1688, Alibaba, Taobao, or direct factories in China and have each seller ship domestically to your QCWarehouse receiving address with your personal receiving code. Register each seller’s carrier tracking number in your workspace so our intake team can match split parcels accurately.",
      },
      {
        id: "sourcing",
        question: "Are you a sourcing or purchasing agent?",
        answer:
          "No. You purchase merchandise directly from your suppliers. We don't source or sell products, pay sellers, or negotiate merchandise prices—staying independent from your suppliers ensures our inspection reports remain objective.",
      },
      {
        id: "receiving-address",
        question: "How do I send items to the QCWarehouse China receiving center?",
        answer:
          "Create a free account to receive our China warehouse address and your permanent personal receiving code. Paste both into your supplier’s shipping details, then add the domestic courier tracking number to your order in QCWarehouse.",
      },
      {
        id: "missing-receiving-code",
        question: "What happens if a seller forgets to write my receiving code on the label?",
        answer:
          "Add the seller’s original carrier tracking number in your workspace as soon as the parcel ships. Uncoded or mismatched parcels are held securely in quarantine until ownership is verified—never opened to other accounts.",
      },
      {
        id: "arrival-damage",
        question: "What happens if a parcel arrives damaged?",
        answer:
          "Our intake desk photographs visible outer-carton crushing, tearing, or moisture at arrival and logs an intake exception linked to the carrier waybill before unboxing, giving you timestamped evidence to review with your seller.",
      },
      {
        id: "short-shipment",
        question: "What if fewer items arrive than expected?",
        answer:
          "Every unboxed item is counted and tagged individually against your declared order quantity. If a parcel contains fewer or more units than declared, the system flags a quantity discrepancy with intake photos and pauses affected lines until you confirm how to proceed.",
      },
    ],
  },
  {
    key: "services-scope",
    title: "Services & Scope",
    items: [
      {
        id: "service-scope",
        question: "What is the difference between Product Inspection and Sample Comparison?",
        answer:
          "Product Inspection checks 1 to 100+ items individually (priced per physical item), giving each piece its own checklist record—ideal for prototypes or small-batch inventory. Sample Comparison evaluates 2 or 3 comparable items together as one set (priced per group) under identical camera framing and flat measurement landmarks so you can compare candidate suppliers or batches side by side.",
      },
      {
        id: "piece-by-piece-batch",
        question: "Can you inspect 30 or 50 items individually, and how does that differ from a 1–3 item sample check?",
        answer:
          "Yes. Standard Product Inspection supports 1 to 100 items self-serve online, assigning every single unit its own barcode ID, measurements, and defect log—whether you are evaluating 1–3 prototype samples in detail or screening 10–100 small-batch stock garments before export. Orders of 101 to 300 items are supported via a manual staff capacity quote.",
      },
      {
        id: "golden-sample",
        question: "Can you compare new items with my approved sample?",
        answer:
          "Yes—through Golden Sample / Reference Matching. After an item has been inspected in QCWarehouse, you can request its conversion into a Golden Sample; our staff seals it inside secure reference sample storage. Future incoming samples can then be ordered under Reference Matching for direct physical side-by-side comparison.",
      },
      {
        id: "measurements",
        question: "What exactly do you measure and check?",
        answer:
          "Checkpoints follow the published template for your chosen category—for example, Tops & Knitwear records HPS length, flat chest width, shoulder, sleeve, hem, garment weight, label details, and zone workmanship. Measurements use calibrated metric tapes (0.1 cm precision) with automatic two-pass re-checks when readings exceed variance thresholds.",
      },
      {
        id: "guarantee-boundaries",
        question: "Do you guarantee that the items meet my specifications or are 100% defect-free?",
        answer:
          "No. QCWarehouse is an independent physical inspection service, not the manufacturer or an accredited laboratory. We document observable workmanship and flat measurements on the commissioned items received, and clearly state what was not tested (such as chemical fiber composition, wash shrinkage, safety certification, authenticity, or unreceived factory bulk stock).",
      },
      {
        id: "certification",
        question: "Is a QCWarehouse report a laboratory test or compliance certificate?",
        answer:
          "No. Reports document non-destructive physical observations and dimensional checks at our receiving studio. Chemical composition, GSM cut-swatch tests, flammability, CPSIA/REACH compliance, and formal certifications require accredited third-party laboratories.",
      },
    ],
  },
  {
    key: "reports-pricing",
    title: "Reports, Pricing & Turnaround",
    items: [
      {
        id: "before-deciding",
        question: "Can I see photos and measurements before deciding where items go?",
        answer:
          "Yes—that is the core purpose of QCWarehouse. We publish your online English report and matching downloadable PDF (complete with metric tape photos, re-measurement logs, and red defect bounding boxes) first. You review the evidence and only then submit item-by-item return, storage, or forwarding instructions.",
      },
      {
        id: "fee-included",
        question: "What is included in the inspection fee?",
        answer:
          "The inspection or comparison fee covers parcel arrival check-in, individual barcode tagging, execution of all checkpoints in the selected template, mandatory overview/measurement/defect photography, independent QA review, a reviewed English inspection report + PDF, and the initial post-report decision custody window. Outbound domestic postage and extended storage are separate.",
      },
      {
        id: "turnaround",
        question: "How long does inspection take?",
        answer:
          "Active standard apparel packages estimate 3 business days. Turnaround timing starts only after all commissioned items for the order have physically arrived at our China facility, passed ownership/count check-in, and order payment is confirmed.",
      },
      {
        id: "payment",
        question: "How do billing and refunds work?",
        answer:
          "Orders are priced per commission (no monthly subscription) and processed in USD via Stripe. Inspection fee refund eligibility depends on whether physical warehouse work has started under our Terms of Service. Refunds for the merchandise itself must be requested directly from the seller you bought from.",
      },
    ],
  },
  {
    key: "routing-returns",
    title: "Returns, Storage & Forwarding",
    items: [
      {
        id: "after-inspection",
        question: "What happens to items after inspection?",
        answer:
          "Every inspected item stays tagged in organized staging until you issue an instruction in your workspace: Return to Seller (domestic China), Forward to your designated Freight Forwarder in China, Store for later consolidation, or Convert an approved item into a sealed Golden Sample.",
      },
      {
        id: "seller-returns",
        question: "Can you return defective items to the seller?",
        answer:
          "Yes. First request return approval from your Chinese seller and obtain their domestic return address and recipient phone number. Submit those details in QCWarehouse, approve and pay the domestic return courier quote, and our team will pack the selected items, hand them to the courier, and record the outbound tracking number. Note that courier dispatch does not guarantee the seller will issue a merchandise refund.",
      },
      {
        id: "forwarding",
        question: "Do you arrange international shipping or customs clearance?",
        answer:
          "QCWarehouse dispatches domestically within mainland China to your chosen international freight forwarder or consolidator warehouse (including your forwarder suite/member code) after you approve the domestic shipping quote. International air/sea linehaul and destination customs clearance are handled by your freight forwarder.",
      },
      {
        id: "restricted-items",
        question: "Which products are restricted from delivery to QCWarehouse?",
        answer:
          "Hazardous materials, batteries/electronics, liquids, cosmetics, food, pressurized containers, counterfeit branded goods, and unapproved product categories must not be shipped to our facility. Review the Restricted Items Policy before ordering from suppliers.",
      },
      {
        id: "refunds",
        question: "How do I get support for an active inspection order?",
        answer:
          "Sign in to your customer workspace and open a support case directly from the order or support desk, including your order number (QW-…) or carrier waybill so our operations team can inspect the exact chain-of-custody record.",
      },
    ],
  },
];

function buildFaqJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_CATEGORIES.flatMap((cat) =>
      cat.items.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      }))
    ),
  };
}

export function FAQ() {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");

  useEffect(() => {
    const reveal = () => {
      const hashId = location.hash.slice(1);
      if (!hashId) return;
      const item = document.getElementById(hashId);
      if (item instanceof HTMLDetailsElement) {
        item.open = true;
        item.scrollIntoView({ block: "start" });
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);

  const term = query.trim().toLowerCase();
  const groups = FAQ_CATEGORIES.filter((cat) => activeCat === "all" || cat.key === activeCat)
    .map((cat) => ({
      ...cat,
      items: cat.items.filter(
        (item) =>
          !term ||
          item.question.toLowerCase().includes(term) ||
          item.answer.toLowerCase().includes(term)
      ),
    }))
    .filter((cat) => cat.items.length > 0);

  return (
    <div className="faq">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(buildFaqJsonLd()) }}
      />

      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>FAQ &amp; Buyer Help Center</strong>
      </div>

      <section className="pub-page-hero">
        <div className="row between flexwrap" style={{ gap: 16 }}>
          <div>
            <p className="pub-eyebrow">BUYER HELP CENTER · DECISION &amp; OPERATIONS FAQ</p>
            <h1 style={{ marginBottom: 8 }}>Frequently Asked Questions</h1>
            <p style={{ marginBottom: 0 }}>
              Clear, policy-accurate answers on shipping from multiple Chinese suppliers, 1–100+ item piece-by-piece checks, sample comparisons, scope boundaries, seller returns, and freight-forwarder handoff.
            </p>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary" href="/contact">
              Ask a Question →
            </Link>
            <Link className="button" href="/orders/new">
              Start Inspection
            </Link>
          </div>
        </div>
      </section>

      <div className="pub-filter-pills" role="tablist" aria-label="FAQ topic categories">
        <button
          type="button"
          className={`pub-filter-pill${activeCat === "all" ? " active" : ""}`}
          onClick={() => setActiveCat("all")}
        >
          All Topics ({FAQ_CATEGORIES.reduce((n, c) => n + c.items.length, 0)})
        </button>
        {FAQ_CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            className={`pub-filter-pill${activeCat === cat.key ? " active" : ""}`}
            onClick={() => setActiveCat(cat.key)}
          >
            {cat.title} ({cat.items.length})
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="selectbar" style={{ marginBottom: 14 }}>
          <div className="search">
            <input
              type="search"
              aria-label="Search FAQ"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search e.g. multiple suppliers, 50 items, return to seller, forwarder, Golden Sample…"
            />
          </div>
          {query && (
            <button type="button" className="button sm" onClick={() => setQuery("")}>
              Clear search
            </button>
          )}
        </div>

        {groups.length === 0 && (
          <p role="status" className="notice">
            No matching questions found. Try clearing your filter or{" "}
            <Link href="/contact">send our inspection desk a direct inquiry</Link>.
          </p>
        )}

        {groups.map((group) => (
          <section className="faq-group" key={group.key} style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: "1.08rem", margin: "10px 0 8px", color: "#15325c" }}>
              {group.title}
            </h2>
            {group.items.map((item) => (
              <details className="faq-item" key={item.id} id={item.id}>
                <summary>
                  <span>{item.question}</span>
                  <span className="tag gray" style={{ flexShrink: 0 }}>{group.title}</span>
                </summary>
                <p style={{ fontSize: 13.5, lineHeight: 1.62, color: "#344861" }}>{item.answer}</p>
                <a className="button sm" style={{ marginTop: 4 }} href={`#${item.id}`}>
                  Direct link
                </a>
              </details>
            ))}
          </section>
        ))}
      </div>

      <div className="actions">
        <Link className="button primary" href="/catalog">Explore Services &amp; Packages</Link>
        <Link className="button" href="/pricing">Estimate Inspection Fee</Link>
        <Link className="button" href="/legal/restricted-items">Restricted Items Policy</Link>
        <Link className="button" href="/legal/terms">Terms of Service</Link>
      </div>
    </div>
  );
}
