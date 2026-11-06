import Link from "next/link";

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
    <div className="report-ribbon"><strong>▤ &nbsp; QCWarehouse</strong><span>Inspection report · Sample data</span></div>
    <dl className="proof-data">
      <div><dt>Order / Report</dt><dd>QW-DEMO-204<br/>Version 02</dd></div>
      <div><dt>Service</dt><dd>Sample comparison<br/>3 comparable items</dd></div>
      <div><dt>Scope</dt><dd>Apparel / visual<br/>Measured &amp; observed</dd></div>
    </dl>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Illustrative sample measurements">
      <table><thead><tr>{["Measurement","Sample A","Sample B","Sample C"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody><tr><th scope="row">Body length</th><td>72.0 cm</td><td>72.5 cm</td><td>71.8 cm</td></tr>
        <tr><th scope="row">Chest (flat)</th><td>55.0 cm</td><td>56.0 cm</td><td>54.8 cm</td></tr>
        <tr><th scope="row">Visible seam note</th><td>No issue recorded</td><td>See photo B-04</td><td>No issue recorded</td></tr></tbody></table>
    </div>
    <figcaption>Illustrative data only. Values and photo references are examples.</figcaption>
  </figure>;
}

export function ReportGuide() {
  return <>
    <div className="page-head public-masthead"><p className="eyebrow">DELIVERABLE / REPORT GUIDE</p><h1>Read an inspection report</h1>
      <p className="muted">The illustration explains report structure. Published reports contain the actual checks and evidence for the commissioned items.</p></div>
    <div className="report-guide"><SampleReportPreview/>
      <dl className="report-guide-fields">
        <div><dt>01 / Scope and item identification</dt><dd>Confirm the item identifier and check which methods were included in the selected service.</dd></div>
        <div><dt>02 / Measurements and observations</dt><dd>Read values with their units and methods. A missing measurement carries an explanation.</dd></div>
        <div><dt>03 / Linked evidence</dt><dd>Check the photos associated with a measurement or observation. Comparison reports bring the same checkpoint together across samples.</dd></div>
        <div><dt>04 / Next instruction</dt><dd>After reviewing the report, give the warehouse a handling instruction for each item.</dd></div>
      </dl>
    </div>
    <div className="report-guide-diagram"><EvidenceIllustration/></div>
    <div className="actions"><Link className="button primary" href="/catalog">Choose an inspection service</Link><Link href="/faq#measurements">Read the measurement FAQ</Link></div>
  </>;
}
