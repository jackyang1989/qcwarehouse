export type SpecFrameTone = "slate" | "blue" | "amber" | "navy";

export type SpecIconKind =
  | "compare"
  | "barcode"
  | "reference"
  | "defect"
  | "packing"
  | "intake"
  | "bench"
  | "garment"
  | "storage"
  | "report";

function SpecIcon({ kind }: { kind: SpecIconKind }) {
  switch (kind) {
    case "compare":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h16m-4-4 4 4-4 4" />
          <path d="M20 17H4m4-4-4 4 4 4" />
        </svg>
      );
    case "barcode":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
          <path d="M7 9v6M11 9v6M14 9v6M17 9v6" />
        </svg>
      );
    case "reference":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2 19 6v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4Z" />
          <path d="m9.5 12.5 1.8 1.8 3.7-4" />
        </svg>
      );
    case "defect":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5M11 8v3M11 14h.01" />
        </svg>
      );
    case "packing":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8l9-5 9 5v8l-9 5-9-5V8Z" />
          <path d="M3 8l9 5 9-5M12 13v8" />
        </svg>
      );
    case "intake":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 20h8M12 14V8m-3 3 3-3 3 3" />
        </svg>
      );
    case "garment":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4 4 7l2 4 3-1v10h6V10l3 1 2-4-4-3c-1 1.6-2.3 2.4-4 2.4S9 5.6 8 4Z" />
        </svg>
      );
    case "storage":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M4 12h16M10 8h4M10 16h4" />
        </svg>
      );
    case "report":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3h9l4 4v14H6V3Z" />
          <path d="M15 3v4h4M9 12h6M9 16h6" />
        </svg>
      );
    case "bench":
    default:
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7h18v6H3zM6 13v7M18 13v7M7 10h2M12 10h2M17 10h1" />
        </svg>
      );
  }
}

export function InspectionSpecPanel({
  slotId,
  eyebrow,
  title,
  summary,
  highlights,
  icon = "bench",
  tone = "slate",
  compact = false,
  footerNote,
}: {
  slotId: string;
  eyebrow: string;
  title: string;
  summary: string;
  highlights?: readonly string[];
  icon?: SpecIconKind;
  tone?: SpecFrameTone;
  compact?: boolean;
  footerNote?: string;
}) {
  return (
    <div
      className={`pub-spec-panel tone-${tone}${compact ? " compact" : ""}`}
      data-asset-slot={slotId}
    >
      <div className="pub-spec-head">
        <span className="pub-spec-eyebrow">{eyebrow}</span>
        <span className="pub-spec-icon" aria-hidden="true">
          <SpecIcon kind={icon} />
        </span>
      </div>
      <strong className="pub-spec-title">{title}</strong>
      <p className="pub-spec-summary">{summary}</p>
      {highlights && highlights.length > 0 && (
        <ul className="pub-spec-chips" aria-label="Protocol checkpoints">
          {highlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {footerNote && <div className="pub-spec-foot">{footerNote}</div>}
    </div>
  );
}
