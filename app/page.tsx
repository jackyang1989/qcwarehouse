import Link from "next/link";

export default function Home() {
  return <>
    <header className="top"><Link className="wordmark" href="/"><span className="mark">QC</span> Warehouse</Link>
      <nav><Link href="/catalog">Services</Link><a href="#process">How it works</a><Link href="/login">Sign in</Link></nav></header>
    <main className="landing">
      <section className="hero">
        <div><p className="eyebrow">PRODUCT INSPECTION & SAMPLE COMPARISON</p>
          <h1>Know what you’re<br/>shipping.</h1>
          <p className="hero-copy">Send purchases to your personal warehouse address. Get item-by-item observations, measurements, and photos before deciding what ships next.</p>
          <div className="actions"><Link className="button primary" href="/login">Start an inspection <span aria-hidden>→</span></Link><Link className="button" href="/catalog">Explore services</Link></div>
        </div>
        <div className="hero-board" aria-label="Illustration of the warehouse workflow">
          <div className="board-head"><span className="mark">QC</span><span>WAREHOUSE WORKFLOW</span></div>
          {["Parcel received","Items inspected","Report published","Your next move"].map((label,i)=><div className="board-row" key={label}><span>0{i+1}</span><strong>{label}</strong><span aria-hidden>↗</span></div>)}
        </div>
      </section>
      <section id="process" className="steps"><div><p className="eyebrow">01 / RECEIVE</p><h2>Use your receiving code</h2><p>Register, copy your warehouse address, and add the seller’s tracking number.</p></div>
        <div><p className="eyebrow">02 / INSPECT</p><h2>Check the actual items</h2><p>Commission an inspection for one item or many. Choose comparison when you want a side-by-side report.</p></div>
        <div><p className="eyebrow">03 / DECIDE</p><h2>Choose where it goes</h2><p>Review the report and request storage, forwarding, or a return to the seller using the return address you obtained.</p></div></section>
    </main>
    <footer><span>QC Warehouse</span><div><Link href="/legal">Terms & privacy</Link><Link href="/wh">仓库工作台</Link><Link href="/admin">管理后台</Link></div></footer>
  </>;
}
