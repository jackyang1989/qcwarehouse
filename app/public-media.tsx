import type { ReactNode } from "react";

export type PendingAssetRatio = "16-10" | "16-9" | "4-3" | "3-2" | "1-1";

export function StudioAssetPending({
  slotId,
  filename,
  title,
  brief,
  dimensions,
  ratio = "3-2",
  statusLabel = "ASSET_PENDING",
  subBadge = "Studio Shoot Scheduled",
  overlay,
  compact = false,
}: {
  slotId: string;
  filename: string;
  title: string;
  brief: string;
  dimensions?: string;
  ratio?: PendingAssetRatio;
  statusLabel?: string;
  subBadge?: string;
  overlay?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`pub-asset-pending ratio-${ratio}${compact ? " compact" : ""}`}
      role="img"
      aria-label={`${statusLabel}: ${title} (${filename})`}
    >
      <div className="pub-asset-pending-grid" aria-hidden="true" />
      <div className="pub-asset-pending-head">
        <span className="pub-asset-pending-pill">{statusLabel} · {slotId}</span>
        {dimensions && <span className="pub-asset-pending-dims">{dimensions}</span>}
      </div>
      <div className="pub-asset-pending-body">
        <div className="pub-asset-pending-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
            <circle cx="12" cy="13.5" r="3.5" />
          </svg>
        </div>
        <strong className="pub-asset-pending-title">{title}</strong>
        <p className="pub-asset-pending-brief">{brief}</p>
        <div className="pub-asset-pending-foot">
          <code>{filename}</code>
          <span>{subBadge}</span>
        </div>
      </div>
      {overlay}
    </div>
  );
}
