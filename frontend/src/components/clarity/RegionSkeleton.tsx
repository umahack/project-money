import './clarity.css';

const LINE_WIDTHS = ['62%', '88%', '74%', '48%', '81%', '66%'] as const;

export interface RegionSkeletonProps {
  /** Region name used in the visible loading text, for example "Monthly summary". */
  label: string;
  /** Reserved height so content does not shift when it arrives. */
  minHeight?: number;
  lines?: number;
}

/**
 * Size-stable placeholder for one region that has not loaded yet (Requirement 10.14).
 * The shimmer is decorative; "Loading …" text carries the status.
 */
export function RegionSkeleton({ label, minHeight = 160, lines = 3 }: RegionSkeletonProps) {
  const count = Math.max(1, Math.min(lines, LINE_WIDTHS.length));
  return (
    <div className="clarity-skeleton" role="status" style={{ minHeight }} data-testid="region-skeleton">
      <p className="clarity-skeleton-text muted small">Loading {label}…</p>
      <div aria-hidden="true" className="clarity-skeleton-lines">
        {LINE_WIDTHS.slice(0, count).map((width, index) => (
          <span key={index} className="skeleton clarity-skeleton-line" style={{ width }} />
        ))}
      </div>
    </div>
  );
}
