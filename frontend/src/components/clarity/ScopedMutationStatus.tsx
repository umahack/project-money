import { useRef } from 'react';
import { useMutationRunner, useMutationStatus } from '../../clarity/MutationStatusProvider';
import { useFocusRescue } from './focus';
import './clarity.css';

export interface ScopedMutationStatusProps {
  /** Record scope to report, for example `goal:17` or `salary:2026-11`. */
  scopeKey: string;
  /** Id for the status node so the control can reference it with `aria-describedby`. */
  id?: string;
  /**
   * Resends the failed change. Defaults to the runner's retry. A page passes its
   * own when it must finish a retried change the way it finishes a first attempt.
   */
  onRetry?: (scopeKey: string) => unknown;
  /** Extra class names for layout beside the control. The status takes no space while idle. */
  className?: string;
}

/**
 * Pending, success, and failure text for one record scope, with a retry beside
 * the failed change (Requirements 10.1, 10.4, 10.7, 10.10, 10.13).
 *
 * Every state is written as text ("pending", "done", "failed") so it does not
 * rely on color. Pending and success are announced politely; a failure is
 * announced assertively. Neither moves keyboard focus. Retry resends the
 * original command with its original Idempotency-Key.
 */
export function ScopedMutationStatus({ scopeKey, id, className = '', onRetry }: ScopedMutationStatusProps) {
  const status = useMutationStatus(scopeKey);
  const runner = useMutationRunner();
  const rootRef = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue(rootRef);

  const polite = status && status.phase !== 'error'
    ? (
      <>
        <span aria-hidden="true" className="clarity-glyph">{status.phase === 'pending' ? '…' : '✓'}</span>
        <span>
          {status.label}: {status.phase === 'pending' ? 'pending' : status.replayed ? 'done (already saved)' : 'done'}
        </span>
      </>
    )
    : null;

  const failure = status?.phase === 'error' ? status : null;

  return (
    <div
      ref={rootRef}
      id={id}
      tabIndex={-1}
      className={`clarity-mutation clarity-mutation-${status?.phase ?? 'idle'} ${className}`.trim()}
      data-scope={scopeKey}
    >
      <p className="clarity-mutation-line small" role="status">{polite}</p>
      <div role="alert" className="clarity-mutation-failure">
        {failure && (
          <p className="clarity-mutation-line small">
            <span aria-hidden="true" className="clarity-glyph">✕</span>
            <span>
              <strong>{failure.label}: failed.</strong> {failure.error.message} Your last confirmed values are unchanged.
            </span>
          </p>
        )}
      </div>
      {failure && (
        <div className="clarity-mutation-actions">
          <button
            type="button"
            className="btn sm ghost clarity-retry"
            aria-label={`Retry ${failure.label}`}
            onClick={() => {
              rescue.arm();
              void (onRetry ? onRetry(scopeKey) : runner.retry(scopeKey));
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn sm ghost"
            aria-label={`Dismiss failed ${failure.label}`}
            onClick={() => {
              rescue.arm();
              runner.dismiss(scopeKey);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {status?.phase === 'success' && (
        <div className="clarity-mutation-actions">
          <button
            type="button"
            className="btn sm ghost"
            aria-label={`Dismiss ${status.label} message`}
            onClick={() => {
              rescue.arm();
              runner.dismiss(scopeKey);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
