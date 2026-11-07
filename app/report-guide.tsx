import Link from "next/link";

export function ApparelIllustration({kind="shirt"}:{kind?:"shirt"|"bag"|"shoe"}) {
  return <svg viewBox="0 0 120 120" width="84" height="84" fill="none" stroke="#6c8dad" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==="shirt"?<path d="M37 16 18 29 7 52l25 14 7-14v52h53V52l7 14 25-14-13-23-21-13c-12 17-28 17-43 0Z"/>:
     kind==="bag"?<path d="M27 48h68l7 53H20l7-53Zm17 0V37a17 17 0 0 1 34 0v11"/>:
     <path d="M11 79c25-3 38-31 54-46 18 27 24 27 45 37v20H11Z"/>}
  </svg>;
}

export function PhotoCardPlaceholder({title,label="ILLUSTRATIVE"}:{title:string;label?:string}) {
  return <div className="photo">
    <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
      <rect x="9" y="13" width="46" height="38" rx="4" fill="none" stroke="currentColor" strokeWidth="2"/>
      <circle cx="24" cy="26" r="5" fill="none" stroke="currentColor" strokeWidth="2"/>
      <path d="M13 44 29 31l8 8 7-6 8 11" fill="none" stroke="currentColor" strokeWidth="2"/>
    </svg>
    <span className="demo-mark">{label}</span>
    <b>{title}</b>
  </div>;
}

export function EvidenceIllustration() {
  return <figure className="evidence-figure">
    <div className="evidence-head"><span>INSPECTION / REPORT STRUCTURE</span><span>ILLUSTRATION</span></div>
    <div className="evidence-body">
      <div className="evidence-diagram" aria-hidden="true">
        <svg viewBox="0 0 360 250" fill="none">
          <defs><pattern id="measurement-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M18 0H0v18" stroke="#344764" strokeWidth="1"/></pattern></defs>
          <path d="M0 0H360V250H0z" fill="url(#measurement-grid)"/>
          <path d="M72 41h216v167H72z" stroke="#415779" strokeDasharray="4 5"/>
          <path d="m153 56-42 17-27 43 41 23 13-20v71h84v-71l13 20 41-23-27-43-42-17c-5 14-13 19-27 19s-22-5-27-19Z" fill="#1e3658" stroke="#b9cdf2" strokeWidth="1.6" strokeLinejoin="round"/>
          <path d="M137 119h86M180 83v103M128 113v12M232 113v12M132 119h-7m103 0h7" stroke="#81a8fc" strokeWidth="1.25" strokeDasharray="4 3"/>
          <circle cx="180" cy="119" r="3.5" fill="#cbdcff"/>
          <path d="M180 119h104l20-20h31" stroke="#a2bfff"/>
          <rect x="300" y="76" width="37" height="22" rx="2" fill="#b6cbfa"/>
          <text x="309" y="91" fill="#132642" fontSize="11" fontFamily="monospace">A01</text>
          <path d="M72 228h216M72 221v14M108 224v8M144 224v8M180 221v14M216 224v8M252 224v8M288 221v14" stroke="#8097ba"/>
        </svg>
      </div>
      <dl className="evidence-fields">
        <div><dt>CHECKPOINT</dt><dd>Chest width</dd></div>
        <div><dt>METHOD</dt><dd>Measured flat</dd></div>
        <div><dt>EVIDENCE</dt><dd>Measurement photo</dd></div>
      </dl>
    </div>
    <figcaption>Apparel example <span aria-hidden="true">/</span> The checklist follows the selected service and category.</figcaption>
  </figure>;
}

export function SampleReportPreview() {
  return <figure className="report-artifact">
    <div className="report-ribbon"><strong>▤ &nbsp; QCWarehouse</strong><span>INSPECTION REPORT · SAMPLE DATA</span></div>
    <dl className="proof-data">
      <div><dt>Order / Report</dt><dd>QW-DEMO-204<br/>Version 02 (Published)</dd></div>
      <div><dt>Service</dt><dd>Sample Comparison<br/>3 comparable items</dd></div>
      <div><dt>Scope</dt><dd>Apparel / Visual<br/>Measured &amp; observed</dd></div>
    </dl>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Illustrative sample measurements">
      <table style={{minWidth:0}}><thead><tr>{["Measurement","Sample A","Sample B","Sample C"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>
        <tr><th scope="row">Body length</th><td>72.0 cm</td><td>72.5 cm</td><td>71.8 cm</td></tr>
        <tr><th scope="row">Chest (flat)</th><td>55.0 cm</td><td>56.0 cm</td><td>54.8 cm</td></tr>
        <tr><th scope="row">Visible seam note</th><td>No issue recorded</td><td>See photo B-04</td><td>No issue recorded</td></tr>
      </tbody></table>
    </div>
    <figcaption style={{marginTop:12}}>Demonstration report only. Supplier names, item codes, and photo references are desensitized examples. What we do not inspect: chemical composition, wash-shrinkage, destructive testing, brand authenticity certification, or unreceived production batches.</figcaption>
  </figure>;
}

export function ReportGuide() {
  return <>
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>Sample Inspection Report</b></div>
    <div className="page-head">
      <div>
        <div className="eyebrow">QCWAREHOUSE / INSPECTION</div>
        <h1>Sample Inspection Report</h1>
        <p>Explore the structure of an evidence-based comparison report. The content below is synthetic.</p>
      </div>
      <div className="head-actions">
        <Link className="button primary" href="/orders/new">Start Inspection</Link>
      </div>
    </div>
    <div className="line-note warning" style={{marginBottom:17}}>
      DEMO CONTENT — This sample contains synthetic values and illustrative placeholders, not verified customer product evidence.
    </div>
    <div className="report-print">
      <section className="card">
        <div className="row between flexwrap">
          <div>
            <div className="label">QCWarehouse · Inspection report</div>
            <h3 style={{margin:"6px 0 4px"}}>Apparel Sample Comparison</h3>
            <div className="small muted">Report RPT-102 · Version 2 · QW-7K2M8P4D</div>
          </div>
          <span className="tag yellow">DEMONSTRATION</span>
        </div>
        <div className="sep"/>
        <div className="grid cols3">
          {([
            ["S-003101","Reference A"],
            ["S-003102","Supplier B"],
            ["S-003103","Supplier C"],
          ] as const).map(([code,supplier])=><div className="data-sample" key={code}>
            <strong className="mono">{code}</strong>
            <div className="product-illustration" style={{margin:"9px 0",height:96}}>
              <ApparelIllustration kind="shirt"/>
            </div>
            <div className="small muted">{supplier}</div>
          </div>)}
        </div>
        <div className="grid cols4" style={{marginTop:14}}>
          <div className="def"><dt>Inspection date</dt><dd>2026-11-04 CST</dd></div>
          <div className="def"><dt>Category</dt><dd>Apparel / Tops</dd></div>
          <div className="def"><dt>Method</dt><dd>Visual &amp; tape measurement</dd></div>
          <div className="def"><dt>Evidence</dt><dd>8 illustrative frames</dd></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>Measurements &amp; comparative observations</h3>
            <p>Select a measurement value in a real implementation to see its linked measurement photo.</p>
          </div>
        </div>
        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Measurement / Method</th>
                <th>Sample A</th>
                <th>Sample B</th>
                <th>Sample C</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Length · lay flat</td><td>72.0</td><td>71.8</td><td>72.2</td><td>cm</td></tr>
              <tr><td>Chest · lay flat</td><td>56.0</td><td>55.8</td><td>56.1</td><td>cm</td></tr>
              <tr><td>Shoulder</td><td>48.0</td><td>48.0</td><td>48.1</td><td>cm</td></tr>
              <tr><td>Sleeve</td><td>22.0</td><td>21.9</td><td>22.0</td><td>cm</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{marginTop:10,marginBottom:0}}>
          Reference values and tolerances supplied by the buyer are required before making an acceptance judgment.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>Photo evidence</h3>
            <p>Illustrative placeholders only. No actual inspected item photo is included in this prototype.</p>
          </div>
        </div>
        <div className="photo-grid">
          {["Sample A — Front","Sample A — Back","Sample B — Detail","Sample C — Print","Seam close-up","Tape measurement"].map(label=>
            <PhotoCardPlaceholder key={label} title={label}/>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div><h3>Findings and limitations</h3></div>
        </div>
        <ul className="list">
          <li>✓ Slight visible stitch spacing differences were noted on Sample B.</li>
          <li>✓ Dimensions are recorded by sample, with stated measurement method.</li>
          <li>— Fabric fiber composition, color ΔE and laboratory durability were not tested.</li>
          <li>— This inspection does not certify any unobserved units or production batch.</li>
        </ul>
        <div className="line-note success" style={{marginTop:12}}>
          Report v2 has a revision history. A published report cannot be silently overwritten.
        </div>
      </section>
    </div>
    <div className="row flexwrap">
      <Link className="button sm" href="/reports">See full report workspace</Link>
      <Link className="button primary sm" href="/catalog">Choose an inspection service</Link>
      <Link className="button sm" href="/faq#measurements">Read the measurement FAQ</Link>
    </div>
  </>;
}
