import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clarityApi } from '../../api';
import type {
  CalculationExplanation,
  CalculationStep,
  ExplanationResponse,
  RoundingMetadata,
  SourceRef,
} from '../../clarity/contracts';
import { queryKeys } from '../../clarity/queryClient';
import {
  explanationText,
  formatDateRange,
  formatMoney,
  formatPaise,
  formatPeriod,
  formatPeriodKey,
  formatSignedPaise,
  formatSourceValue,
  humanizeKey,
  isMoneyValue,
  operationLabel,
} from './format';
import { ClassificationBadge, StatusBadge } from './labels';
import './clarity.css';

const ROUNDING_DIRECTION: Readonly<Record<RoundingMetadata['direction'], string>> = Object.freeze({
  half_up: 'to the nearest paisa, halves round up',
  up: 'up to the next paisa',
  exact: 'none needed, the result is exact',
});

const MAX_DEPTH = 3;

/** Renders an unknown result as plain text rows. Never interprets values as markup. */
function ResultValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (isMoneyValue(value)) return <span className="mono">{formatMoney(value)}</span>;
  if (value === null || value === undefined) return <span>—</span>;
  if (typeof value === 'number') return <span className="mono">{String(value)}</span>;
  if (typeof value === 'string' || typeof value === 'boolean') return <span>{formatSourceValue(value)}</span>;
  if (depth >= MAX_DEPTH) return <span>…</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>None</span>;
    return (
      <ul className="clarity-plain-list">
        {value.map((item, index) => <li key={index}><ResultValue value={item} depth={depth + 1} /></li>)}
      </ul>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <dl className="clarity-result-grid">
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd><ResultValue value={item} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function operandLabel(ref: string, sources: ReadonlyMap<string, SourceRef>): string {
  const source = sources.get(ref);
  return source ? `${source.label} (${formatSourceValue(source.value)})` : humanizeKey(ref);
}

function Rounding({ rounding, currency }: { rounding: RoundingMetadata; currency: string }) {
  return (
    <dl className="clarity-result-grid">
      <div><dt>Currency</dt><dd>{currency}</dd></div>
      <div><dt>Precision</dt><dd>1 paisa ({formatPaise(1)})</dd></div>
      <div><dt>Rounding direction</dt><dd>{ROUNDING_DIRECTION[rounding.direction]}</dd></div>
      <div>
        <dt>Rounding adjustment</dt>
        <dd>
          {formatSignedPaise(rounding.adjustmentMinor)}
          {rounding.adjustmentTarget ? ` applied to ${humanizeKey(rounding.adjustmentTarget).toLowerCase()}` : ''}
        </dd>
      </div>
    </dl>
  );
}

function Operation({ step, sources }: { step: CalculationStep; sources: ReadonlyMap<string, SourceRef> }) {
  return (
    <li className="clarity-operation">
      <p className="clarity-operation-title">
        <strong>{operationLabel(step.operation)}.</strong> {explanationText(step.explanationKey)}
      </p>
      {step.operandRefs.length > 0 && (
        <p className="small muted">
          Using: {step.operandRefs.map((ref) => operandLabel(ref, sources)).join('; ')}
          {step.divisor !== undefined ? `; divisor ${step.divisor}` : ''}
        </p>
      )}
      <p className="small">
        Result: <span className="mono">{isMoneyValue(step.result) ? formatMoney(step.result) : String(step.result)}</span>{' '}
        <ClassificationBadge classification={step.resultClassification ?? 'calculated_result'} />
      </p>
      {step.intermediateResults && Object.keys(step.intermediateResults).length > 0 && (
        <ul className="clarity-plain-list small">
          {Object.entries(step.intermediateResults).map(([name, value]) => (
            <li key={name}>
              {humanizeKey(name)}:{' '}
              <span className="mono">{isMoneyValue(value) ? formatMoney(value) : String(value)}</span>{' '}
              <ClassificationBadge classification={step.intermediateResultClassifications?.[name] ?? 'calculated_result'} />
            </li>
          ))}
        </ul>
      )}
      {step.rounding && (
        <p className="small muted">
          Rounding: {ROUNDING_DIRECTION[step.rounding.direction]}; {formatSignedPaise(step.rounding.adjustmentMinor)}.
        </p>
      )}
    </li>
  );
}

function ExplanationBody({ explanation }: { explanation: CalculationExplanation }) {
  const sourceList = [...explanation.sourceRefs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const sources = new Map<string, SourceRef>();
  for (const source of sourceList) if (source.ref) sources.set(source.ref, source);
  const operations = [...explanation.operations].sort((a, b) => a.order - b.order);

  return (
    <div className="clarity-explanation-body">
      <p className="small">
        <StatusBadge status={explanation.status} />{' '}
        <ClassificationBadge classification={explanation.classification} />{' '}
        Period: <strong>{formatPeriod(explanation.period)}</strong>
        {explanation.period.month ? ` (${formatDateRange(explanation.period)})` : ''}. Data version {explanation.dataVersion}.
      </p>
      {explanation.stale && (
        <p className="small clarity-tone-warn">
          Stale: this shows {formatPeriodKey(explanation.stale.sourcePeriod)}, but {formatPeriodKey(explanation.stale.requestedPeriod)} was requested.
        </p>
      )}

      <p className="clarity-subheading">Values you entered</p>
      {sourceList.length === 0 ? (
        <p className="small muted">No entered values were used.</p>
      ) : (
        <ul className="clarity-plain-list">
          {sourceList.map((source, index) => (
            <li key={source.ref ?? `${source.sourceType}:${source.recordId}:${source.field}:${index}`}>
              {source.label}: <span className="mono">{formatSourceValue(source.value)}</span>{' '}
              <ClassificationBadge classification="entered_fact" />
              {source.period && (source.period.month || source.period.start) ? (
                <span className="small muted"> · {source.period.month ? formatPeriodKey(source.period.month) : formatDateRange({ start: source.period.start ?? '', endExclusive: source.period.endExclusive ?? source.period.start ?? '' })}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="clarity-subheading">Steps, in order</p>
      {operations.length === 0 ? (
        <p className="small muted">No calculation steps were needed.</p>
      ) : (
        <ol className="clarity-operations">
          {operations.map((step) => <Operation key={step.order} step={step} sources={sources} />)}
        </ol>
      )}

      <p className="clarity-subheading">Rounding and precision</p>
      <Rounding rounding={explanation.rounding} currency={explanation.currency} />

      {explanation.result && (
        <>
          <p className="clarity-subheading">Result</p>
          <p className="small"><ClassificationBadge classification={explanation.result.classification} /></p>
          <ResultValue value={explanation.result.value} />
        </>
      )}
    </div>
  );
}

export interface CalculationExplanationPanelProps {
  outcomeId: string;
  /** Version of the outcome currently on screen. A change updates this panel in place. */
  dataVersion: number;
  /** Outcome title for the accessible name and announcements. */
  title: string;
  id?: string;
  /** Called when the server reports a newer version than the one requested. */
  onSuperseded?: (version: number) => void;
}

/**
 * Fetches and renders source values, ordered operations, rounding, and freshness
 * for one outcome version. Mount it only for the authenticated owner's data; the
 * request is authenticated and scoped to the signed-in user on the server.
 *
 * When `dataVersion` changes while the panel stays mounted, the previous
 * explanation stays on screen with "Updating" text and is replaced in place when
 * the new version arrives, so an open disclosure never closes (Requirements 9.10 and 9.12).
 */
export function CalculationExplanationPanel({
  outcomeId,
  dataVersion,
  title,
  id,
  onSuperseded,
}: CalculationExplanationPanelProps) {
  const query = useQuery({
    queryKey: queryKeys.explanation(outcomeId, dataVersion),
    queryFn: () => clarityApi.get<ExplanationResponse>(
      `/finance/explanations/${encodeURIComponent(outcomeId)}?version=${dataVersion}`,
    ),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const data = query.data;
  const shownVersion = data?.explanation.dataVersion;
  const updating = query.isPlaceholderData || (query.isFetching && shownVersion !== undefined && shownVersion !== dataVersion);

  const [announcement, setAnnouncement] = useState('');
  const lastShown = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (shownVersion === undefined || query.isPlaceholderData) return;
    if (lastShown.current !== undefined && lastShown.current !== shownVersion) {
      setAnnouncement(`The calculation for ${title} was updated to the latest confirmed data.`);
    }
    lastShown.current = shownVersion;
  }, [shownVersion, query.isPlaceholderData, title]);

  const superseded = data?.supersededByVersion;
  useEffect(() => {
    if (superseded !== undefined && superseded > dataVersion) onSuperseded?.(superseded);
  }, [superseded, dataVersion, onSuperseded]);

  let content: ReactNode;
  if (data) {
    content = <ExplanationBody explanation={data.explanation} />;
  } else if (query.isError) {
    content = (
      <div className="clarity-region-error">
        <p>
          <span aria-hidden="true" className="clarity-glyph">✕</span>
          <strong>The calculation could not be loaded.</strong> {query.error instanceof Error ? query.error.message : ''}
        </p>
        <button
          type="button"
          className="btn sm ghost clarity-retry"
          aria-label={`Retry loading the calculation for ${title}`}
          onClick={() => { void query.refetch(); }}
        >
          Retry
        </button>
      </div>
    );
  } else {
    content = <p className="small muted" role="status">Loading the calculation…</p>;
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={`How ${title} was calculated`}
      aria-busy={query.isPending || updating || undefined}
      className="clarity-explanation"
    >
      {updating && <p className="small clarity-tone-info" role="status">Updating to the latest confirmed data…</p>}
      {superseded !== undefined && superseded > dataVersion && (
        <p className="small clarity-tone-warn">
          Newer data (version {superseded}) exists. This explanation will update when the page refreshes.
        </p>
      )}
      {content}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
