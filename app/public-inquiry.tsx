"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Empty, ErrorBlock, Form, Panel, request, text, useLoad } from "./ui";

type Receipt = { public_no: string; case_id?: string };

const INQUIRY_TOPICS = [
  { id: "general", label: "General Questions", tag: "GENERAL" },
  { id: "scope", label: "Inspection Scope & Checkpoints", tag: "INSPECTION SCOPE" },
  { id: "quote", label: "Quantity / Custom Quotation (100+ Items)", tag: "CUSTOM QUOTATION" },
  { id: "category", label: "Category Availability", tag: "CATEGORY AVAILABILITY" },
  { id: "existing", label: "Existing Order Support", tag: "EXISTING ORDER" },
] as const;

export function PublicInquiry() {
  const searchParams = useSearchParams();
  const { data, error, reload } = useLoad("/public/inquiry-categories");
  const [receipt, setReceipt] = useState<Receipt>();
  const [topic, setTopic] = useState<string>("general");
  const [sampleCount, setSampleCount] = useState<string>("1");
  const submission = useRef<{ payload: string; key: string }>(null);

  useEffect(() => {
    const paramTopic = searchParams.get("topic");
    if (paramTopic && INQUIRY_TOPICS.some((t) => t.id === paramTopic)) {
      setTopic(paramTopic);
    }
    const paramQty = searchParams.get("qty");
    if (paramQty && Number(paramQty) >= 1) {
      setSampleCount(String(Math.floor(Number(paramQty))));
    } else if (paramTopic === "quote") {
      setSampleCount("120");
    }
  }, [searchParams]);

  const requestedItem = searchParams.get("item");
  const selectedTopicObj = INQUIRY_TOPICS.find((t) => t.id === topic) ?? INQUIRY_TOPICS[0];

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">QCWarehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>Contact &amp; Commercial Inquiries</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">COMMERCIAL INQUIRY &amp; SUPPORT DESK</p>
            <h1>Contact QCWarehouse Inspection Support</h1>
            <p style={{ marginBottom: 18 }}>
              Ask pre-order questions about apparel checkpoints, request custom batch pricing for 100+ items, inquire about planned product categories, or connect with support regarding an active order.
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                Start Self-Serve Order →
              </Link>
              <Link className="button" href="/faq">
                Browse Buyer FAQ
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>Response Target</span>
              <strong>Within 1 Business Day</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Self-Serve Online</span>
              <strong>1–100 Units Instant Quote</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Custom Batch Desk</span>
              <strong>101–300+ Units Scheduled</strong>
            </div>
            <div className="pub-meta-cell">
              <span>Operating Hub</span>
              <strong>China Receiving Studio</strong>
            </div>
          </div>
        </div>
      </section>

      {/* Topic Selector */}
      <div className="pub-filter-pills" role="group" aria-label="Select inquiry topic">
        {INQUIRY_TOPICS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`pub-filter-pill${topic === t.id ? " active" : ""}`}
            onClick={() => setTopic(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {topic === "existing" && (
        <div className="line-note" style={{ marginBottom: 18 }}>
          <strong>Have an active QCWarehouse account?</strong> Signing in and opening a ticket from{" "}
          <Link href="/support"><strong>Customer Support</strong></Link> or{" "}
          <Link href="/orders"><strong>My Orders</strong></Link> attaches your order ID (<span className="code">QW-…</span>) and parcel records automatically for faster resolution. You may also submit the form below if you cannot access your account.
        </div>
      )}

      <div className="detail-layout">
        <div>
          {receipt ? (
            <Panel title="Inquiry Logged in Support Queue">
              <p role="status">
                Your inquiry has been recorded under ticket reference{" "}
                <strong className="code">{receipt.public_no}</strong>.
              </p>
              <p>
                Keep this reference number for follow-up. Our operations desk reviews scope and custom-quantity inquiries in English and Chinese business hours.
              </p>
              <div className="actions" style={{ marginTop: 14 }}>
                {receipt.case_id && (
                  <Link className="button primary sm" href={"/support/cases/" + receipt.case_id}>
                    Open Support Case →
                  </Link>
                )}
                <button type="button" className="button sm" onClick={() => setReceipt(undefined)}>
                  Send another inquiry
                </button>
                <Link className="button sm" href="/catalog">
                  Browse Services
                </Link>
              </div>
            </Panel>
          ) : (
            <Panel title={`Submit Inquiry — ${selectedTopicObj.label}`}>
              {error && (
                <>
                  <ErrorBlock error={error} />
                  <button type="button" className="button sm" onClick={reload}>
                    Retry loading form
                  </button>
                </>
              )}
              {!data && !error && <p role="status" className="muted">Loading inquiry form…</p>}
              {data &&
                !error &&
                (data.categories.length ? (
                  <Form
                    label="Submit Commercial Inquiry"
                    run={async (f) => {
                      const rawCompany = text(f, "company").trim();
                      const rawOrderRef = text(f, "order_ref").trim();
                      const rawBody = text(f, "description").trim();
                      const metaParts = [`[${selectedTopicObj.tag}]`];
                      if (rawCompany) metaParts.push(`Brand/Company: ${rawCompany}`);
                      if (rawOrderRef) metaParts.push(`Order/Waybill: ${rawOrderRef}`);
                      const header = metaParts.join(" · ");
                      const combined = `${header}\n${rawBody}`.slice(0, 1000);
                      const qtyNum = Math.max(1, Math.floor(Number(text(f, "sample_count")) || 1));

                      const payload = {
                        email: text(f, "email").toLowerCase(),
                        category_id: text(f, "category_id"),
                        sample_count: qtyNum,
                        description: combined,
                      };
                      const serialized = JSON.stringify(payload);
                      if (submission.current?.payload !== serialized) {
                        submission.current = { payload: serialized, key: crypto.randomUUID() };
                      }
                      setReceipt(await request("/public/inquiries", "POST", payload, submission.current.key));
                    }}
                  >
                    <div className="fields">
                      <label>
                        Business email
                        <input
                          name="email"
                          type="email"
                          placeholder="you@brand.com"
                          required
                          maxLength={254}
                          autoComplete="email"
                        />
                      </label>
                      <label>
                        Closest product category
                        <select name="category_id" required defaultValue={data.categories[0]?.id ?? ""}>
                          {data.categories.map((c: { id: string; label: string }) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Estimated item quantity
                        <input
                          name="sample_count"
                          type="number"
                          min={1}
                          max={100000}
                          step={1}
                          required
                          value={sampleCount}
                          onChange={(e) => setSampleCount(e.target.value)}
                        />
                      </label>
                      <label>
                        Brand / store name (optional)
                        <input name="company" type="text" maxLength={120} placeholder="Your company or Shopify store" />
                      </label>
                    </div>

                    {topic === "existing" && (
                      <label style={{ marginTop: 12 }}>
                        Order number or domestic tracking number (optional)
                        <input name="order_ref" type="text" maxLength={80} placeholder="e.g. QW-… or SF123456789" />
                      </label>
                    )}

                    <label style={{ marginTop: 14 }}>
                      How can our inspection team help?
                      <textarea
                        name="description"
                        required
                        maxLength={900}
                        defaultValue={
                          requestedItem
                            ? `Inquiring about category readiness and inspection feasibility for: ${requestedItem}. `
                            : ""
                        }
                        placeholder={
                          topic === "quote"
                            ? "Describe your garment types, total quantity, target delivery window, and whether you need piece-by-piece checks…"
                            : topic === "scope"
                            ? "Tell us the garment construction, specific measurements, or defects you want documented…"
                            : "Share your product type, approximate sample or batch size, and questions…"
                        }
                      />
                    </label>
                    <small>
                      Submitted inquiries create a real tracked support ticket in QCWarehouse (up to 900 characters). Do not include passwords or payment card numbers.
                    </small>
                  </Form>
                ) : (
                  <Empty>Public inquiry categories are currently unavailable.</Empty>
                ))}
            </Panel>
          )}
        </div>

        <aside style={{ display: "grid", gap: 16 }}>
          <Panel title="What We Can Confirm Before You Order">
            <ul className="pub-check-list" style={{ marginTop: 0 }}>
              <li><b className="mark-ok">✓</b><span>Which apparel template fits your garment construction</span></li>
              <li><b className="mark-ok">✓</b><span>Studio bench capacity &amp; turnaround for 101–300+ item runs</span></li>
              <li><b className="mark-ok">✓</b><span>Whether a specialized checkpoint can be observed non-destructively</span></li>
              <li><b className="mark-no">—</b><span>We cannot source suppliers, pay sellers, perform lab chemical tests, or negotiate seller refunds</span></li>
            </ul>
          </Panel>

          <Panel title="Self-Serve Shortcuts">
            <p className="small muted">
              Ready to inspect standard Apparel (1–100 items or 2–3 sample comparison)? You can start immediately without waiting for a manual quote.
            </p>
            <div className="actions" style={{ marginTop: 10 }}>
              <Link className="button primary sm" href="/orders/new">Start Inspection →</Link>
              <Link className="button sm" href="/pricing">Fee Estimator</Link>
              <Link className="button sm" href="/faq">Read FAQ</Link>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
