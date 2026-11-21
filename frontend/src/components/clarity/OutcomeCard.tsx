import { createElement, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getToken } from '../../api';
import type { ActionableInsight, Outcome, OutcomeStatus } from '../../clarity/contracts';
import { ActionLink } from './ActionLink';
import { CalculationExplanationPanel } from './CalculationExplanationPanel';
import { useFocusRescue } from './focus';
import {
  CLASSIFICATION_LABEL,
  INFORMATIONAL_DISCLAIMER,
  OUTCOME_KIND_LABEL,
  STATUS_PRESENTATION,
  formatPeriod,
  formatPeriodKey,
  formatSourceValue,
  humanizeKey,
  joinList,
} from './format';
import { ClassificationBadge, StatusBadge } from './labels';
import { ScopedMutationStatus } from './ScopedMutationStatus';
import './clarity.css';

export interface OutcomeRetry {
  action: 'recalculate' | 'refresh';
  scopeKey: string;
}

export interface OutcomeCardProps<T> {
  outcome: Outcome<T>;
  /** Plain title, for example "Remaining spendable". */
  title: string;
  headingLevel?: 2 | 3 | 4;
  /** Renders the value when the outcome has one. Use `ClassifiedValue` for each labelled component. */
  renderValue?: (value: T, outcome: Outcome<T>) => ReactNode;
  /** Text equivalent of the value. Used when `renderValue` is absent and in live announcements. */
  valueSummary?: string;
  /** A refresh for this outcome is running; shows "Refreshing" text and keeps the last values. */
  refreshing?: boolean;
  /** The single retry for this outcome is running. */
  retrying?: boolean;
  /** Runs the one scoped retry offered for stale, refresh-failed, and calculation-failed states. */
  onRetry?: (retry: OutcomeRetry) => void | Promise<void>;
  /** Where to fix a missing or invalid input, typically an `ActionLink`. */
  correctiveAction?: ReactNode;
  /** Record scopes whose pending, success, and failure text belongs beside this outcome. */
  dependentScopeKeys?: readonly string[];
  /** Ranked actions that apply to this outcome. */
  actions?: readonly ActionableInsight[];
  /**
   * The outcome comes from the signed-in user's own data. Explanations are
   * offered only then, and only while a session token exists.
   */
  ownerData?: boolean;
  defaultExplanationOpen?: boolean;
  className?: string;
}

const RETRYABLE: ReadonlySet<OutcomeStatus> = new Set(['stale', 'refresh_failed', 'calculation_failed']);
const VALUE_VISIBLE: ReadonlySet<OutcomeStatus> = new Set(['available', 'stale', 'refresh_failed']);

function defaultRetry(outcome: Outcome<unknown>): OutcomeRetry {
  if (outcome.retry) return outcome.retry;
  return {
    action: outcome.status === 'calculation_failed' ? 'recalculate' : 'refresh',
    scopeKey: `outcome:${outcome.id}`,
  };
}

function retryLabel(status: OutcomeStatus, action: OutcomeRetry['action']): string {
  if (action === 'recalculate') return 'Recalculate';
  return status === 'refresh_failed' ? 'Retry refresh' : 'Refresh';
}

function kindList(kinds: readonly (keyof typeof OUTCOME_KIND_LABEL)[]): string {
  return joinList(kinds.map((kind) => OUTCOME_KIND_LABEL[kind] ?? humanizeKey(kind).toLowerCase()));
}

function StateExplanation<T>({ outcome }: { outcome: Outcome<T> }): ReactNode {
  switch (outcome.status) {
    case 'missing_input': {
      const items = outcome.missing ?? [];
      return (
        <div className="clarity-state clarity-tone-info">
          <p><strong>Not available yet.</strong></p>
          {items.length === 0 ? <p>A required input is missing.</p> : (
            <ul className="clarity-plain-list">
              {items.map((item) => (
                <li key={item.input}>Add <strong>{humanizeKey(item.input).toLowerCase()}</strong> to unlock your {kindList(item.unlocks)}.</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'invalid_input': {
      const items = outcome.invalid ?? [];
      return (
        <div className="clarity-state clarity-tone-danger">
          <p><strong>Not available until an input is corrected.</strong></p>
          {items.length === 0 ? <p>An input is invalid.</p> : (
            <ul className="clarity-plain-list">
              {items.map((item) => (
                <li key={item.input}>
                  <strong>{humanizeKey(item.input)}</strong> must be: {item.constraint}. This affects your {kindList(item.affects)}.
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'stale':
      return (
        <p className="clarity-state clarity-tone-warn">
          <strong>Stale.</strong>{' '}
          {outcome.stale
            ? `Showing ${formatPeriodKey(outcome.stale.sourcePeriod)}; ${formatPeriodKey(outcome.stale.requestedPeriod)} was requested.`
            : 'These values may be out of date.'}
        </p>
      );
    case 'refresh_failed':
      return (
        <p className="clarity-state clarity-tone-warn">
          <strong>Refresh failed.</strong> Showing your last confirmed values.
        </p>
      );
    case 'calculation_failed':
      return (
        <p className="clarity-state clarity-tone-danger">
          <strong>Temporarily unavailable.</strong> The calculation did not finish. Your entered values are saved, so you do not need to enter them again.
        </p>
      );
    default:
      return null;
  }
}

/**
 * One financial outcome: its label (entered fact, calculated result, or
 * recommendation), period, value, status, and a keyboard-operable explanation.
 *
 * Updates are applied in place. Give the card a stable key (`outcome.id`) so the
 * open explanation, focus, and scroll position survive a new data version.
 */
export function OutcomeCard<T>({
  outcome,
  title,
  headingLevel = 2,
  renderValue,
  valueSummary,
  refreshing = false,
  retrying = false,
  onRetry,
  correctiveAction,
  dependentScopeKeys,
  actions,
  ownerData = true,
  defaultExplanationOpen = false,
  className = '',
}: OutcomeCardProps<T>) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const panelId = `${baseId}-explanation`;
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rescue = useFocusRescue(rootRef);
  const [open, setOpen] = useState(defaultExplanationOpen);

  const status = outcome.status;
  const presentation = STATUS_PRESENTATION[status];
  const period = formatPeriod(outcome.period);

  // Live announcement: empty on first render, then the changed outcome and value. The data version is
  // left out on purpose: the server stamps every outcome with each new version, so including it would
  // announce cards whose status and value did not change.
  const announcementKey = [outcome.id, status, valueSummary ?? ''].join('|');
  const previousKey = useRef(announcementKey);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (previousKey.current === announcementKey) return;
    previousKey.current = announcementKey;
    setAnnouncement(
      `${title}. ${valueSummary ? `${valueSummary}. ` : ''}${CLASSIFICATION_LABEL[outcome.classification]} for ${period}. Status: ${presentation.label}.`,
    );
  }, [announcementKey, title, valueSummary, outcome.classification, period, presentation.label]);

  const explanationVersion = outcome.explanationRef?.dataVersion ?? outcome.dataVersion;
  const explainable = ownerData
    && !!getToken()
    && !!outcome.explanationRef
    && explanationVersion !== undefined;

  const retry = RETRYABLE.has(status) && onRetry ? defaultRetry(outcome) : null;
  const showValue = VALUE_VISIBLE.has(status) && outcome.value !== undefined;

  // Escape collapses the disclosure from the toggle or from inside the panel and returns focus to the toggle.
  const onDisclosureKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    toggleRef.current?.focus();
  };

  let valueNode: ReactNode = null;
  if (showValue) {
    valueNode = renderValue
      ? renderValue(outcome.value as T, outcome)
      : valueSummary ? <p className="clarity-value-summary mono">{valueSummary}</p> : null;
  }

  return (
    <article
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`card clarity-outcome clarity-outcome-${status} ${className}`.trim()}
      data-outcome-id={outcome.id}
      data-status={status}
      data-version={outcome.dataVersion}
    >
      <header className="clarity-outcome-header">
        {createElement(headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'h4', { id: titleId, className: 'clarity-outcome-title' }, title)}
        <div className="clarity-outcome-badges">
          <ClassificationBadge classification={outcome.classification} />
          <StatusBadge status={status} />
        </div>
      </header>
      <p className="clarity-period small muted">Period: {period}</p>
      {refreshing && <p className="clarity-refreshing small clarity-tone-info">Refreshing…</p>}

      <StateExplanation outcome={outcome} />
      {valueNode}

      {status === 'calculation_failed' && outcome.sourceRefs.length > 0 && (
        <div className="clarity-kept-facts">
          <p className="small"><strong>Your entered values (kept):</strong></p>
          <ul className="clarity-plain-list small">
            {outcome.sourceRefs.map((source, index) => (
              <li key={source.ref ?? `${source.sourceType}:${source.recordId}:${source.field}:${index}`}>
                {source.label}: <span className="mono">{formatSourceValue(source.value)}</span>{' '}
                <ClassificationBadge classification="entered_fact" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {(status === 'missing_input' || status === 'invalid_input') && correctiveAction && (
        <div className="clarity-corrective">{correctiveAction}</div>
      )}

      {retry && (
        <div className="clarity-retry-row">
          <button
            type="button"
            className="btn sm ghost clarity-retry"
            aria-disabled={retrying || undefined}
            aria-label={`${retrying ? 'Retrying…' : retryLabel(status, retry.action)} ${title}`}
            onClick={() => {
              if (retrying) return;
              rescue.arm();
              void onRetry?.(retry);
            }}
          >
            {retrying ? 'Retrying…' : retryLabel(status, retry.action)}
          </button>
        </div>
      )}

      {outcome.classification === 'recommendation' && (
        <p className="clarity-disclaimer small muted">{INFORMATIONAL_DISCLAIMER}</p>
      )}

      {actions && actions.length > 0 && (
        <ul className="clarity-plain-list clarity-actions">
          {actions.map((action) => (
            <li key={action.id}><ActionLink insight={action} /></li>
          ))}
        </ul>
      )}

      {dependentScopeKeys?.map((scopeKey) => <ScopedMutationStatus key={scopeKey} scopeKey={scopeKey} />)}

      {explainable && (
        <div className="clarity-explain" onKeyDown={onDisclosureKeyDown}>
          <button
            ref={toggleRef}
            type="button"
            className="btn sm ghost clarity-disclosure"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`How this was calculated for ${title}`}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" className="clarity-chevron">{open ? '▾' : '▸'}</span>
            How this was calculated
          </button>
          <div id={panelId} hidden={!open}>
            {open && outcome.explanationRef && explanationVersion !== undefined && (
              <CalculationExplanationPanel
                outcomeId={outcome.explanationRef.outcomeId}
                dataVersion={explanationVersion}
                title={title}
              />
            )}
          </div>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </article>
  );
}
