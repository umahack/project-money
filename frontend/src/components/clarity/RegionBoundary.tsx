import { useRef, type ReactNode } from 'react';
import { useFocusRescue } from './focus';
import { RegionSkeleton } from './RegionSkeleton';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import './clarity.css';

export interface RegionBoundaryProps {
  /** Stable key for the region, such as `summary`, `expense-list`, or `trip-balances`. */
  regionKey: string;
  /** Plain name used in loading and error text, for example "Monthly summary". */
  label: string;
  /** True once this region has a confirmed value to show (even a stale one). */
  hasData: boolean;
  /** A request for this region is running. */
  loading?: boolean;
  /** The latest request for this region failed. Text only; never rendered as markup. */
  error?: unknown;
  /** Called by the single retry action inside the region. */
  onRetry?: () => void;
  /** Reserved height for the loading and error states. */
  minHeight?: number;
  skeletonLines?: number;
  children: ReactNode;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '';
}

/**
 * One independently keyed page region. It replaces page-level loading and error
 * branches so a pending or failed region never hides navigation or the regions
 * that did load (Requirements 10.14 and 10.15).
 *
 * - No data yet and loading: a size-stable skeleton.
 * - No data and failed: an error with one retry, inside this region only.
 * - Data and refreshing: the last confirmed values with "Refreshing" text.
 * - Data and the refresh failed: the last confirmed values with "Refresh failed" and one retry.
 */
export function RegionBoundary({
  regionKey,
  label,
  hasData,
  loading = false,
  error,
  onRetry,
  minHeight = 160,
  skeletonLines,
  children,
}: RegionBoundaryProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue(rootRef);
  const failed = error !== undefined && error !== null && error !== false;

  const retry = onRetry && (
    <button
      type="button"
      className="btn sm ghost clarity-retry"
      aria-label={`Retry loading ${label}`}
      onClick={() => {
        rescue.arm();
        onRetry();
      }}
    >
      Retry
    </button>
  );
  const detail = errorText(error);

  let body: ReactNode;
  let busy = false;
  if (!hasData && failed) {
    body = (
      <div className="clarity-region-error" role="alert" style={{ minHeight }}>
        <p>
          <span aria-hidden="true" className="clarity-glyph">✕</span>
          <strong>{label} could not load.</strong> {detail || 'Your other sections are unaffected.'}
        </p>
        {retry}
      </div>
    );
  } else if (!hasData) {
    busy = true;
    body = <RegionSkeleton label={label} minHeight={minHeight} lines={skeletonLines} />;
  } else {
    busy = loading && !failed;
    body = (
      <>
        {failed ? (
          <div className="clarity-region-note clarity-tone-warn" role="status">
            <p>
              <span aria-hidden="true" className="clarity-glyph">↻</span>
              <strong>Refresh failed.</strong> Showing the last confirmed values for {label}. {detail}
            </p>
            {retry}
          </div>
        ) : loading ? (
          <p className="clarity-region-note clarity-tone-info small" role="status">
            <span aria-hidden="true" className="clarity-glyph">↻</span>
            Refreshing {label}…
          </p>
        ) : null}
        {/* A render error in the region's content stays in this region. */}
        <RenderErrorBoundary
          scope="region"
          label={label}
          resetKeys={[regionKey]}
          onRetry={onRetry}
          onBeforeRetry={rescue.arm}
          focusAfterRetry={() => rootRef.current}
        >
          {children}
        </RenderErrorBoundary>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      tabIndex={-1}
      className="clarity-region"
      data-region={regionKey}
    >
      {body}
    </div>
  );
}
