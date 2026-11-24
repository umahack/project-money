import { useId, useRef, type ReactNode } from 'react';
import { FALLBACK_ACTIONS } from '../../clarity/actionContext';
import type {
  MoneyValue,
  Outcome,
  OutcomeKind,
  TodayAllowanceOutcome,
  TodayAllowanceValue,
  TodayAllowanceZeroReason,
} from '../../clarity/contracts';
import { formatInr } from '../../clarity/quickAdd/amount';
import { ActionLink } from '../clarity/ActionLink';
import { useFocusRescue } from '../clarity/focus';
import { StatusBadge } from '../clarity/labels';
import { OutcomeCard, type OutcomeRetry } from '../clarity/OutcomeCard';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { formatIsoDate, correctiveActionFor } from './homeSummary';
import './todayHeadline.css';
/** The card title. It is also the name of the region, the explanation control, and the retry control. */
export const TODAY_HEADLINE_TITLE = "Today's allowance";
/** Retry request for a re-read of the whole snapshot (region error and the unavailable states). */
export const SNAPSHOT_RETRY: OutcomeRetry = Object.freeze({ action: 'refresh', scopeKey: 'snapshot:today' });
type ApplicableValue = Extract<TodayAllowanceValue, { applicable: true }>;
export interface TodayHeadlineProps {
  /**
   * `snapshot.outcomes.todayAllowance`. Absent (undefined or null) once a snapshot has loaded means the server
   * predates the field, and the headline shows the unavailable state (Requirement 16.7).
   */
  outcome?: TodayAllowanceOutcome | null;
  /** A snapshot, even an older one, has been loaded. False while the first read is pending or failed. */
  hasSnapshot: boolean;
  /** A read is running. With a snapshot, the last confirmed values stay and "Refreshing" is shown. */
  loading?: boolean;
  /** The latest read failed. Without a snapshot this is the region error; with one it is "Refresh failed". */
  error?: unknown;
  /**
   * The Asia/Kolkata date today, from `useKolkataToday()`. When it differs from the date of the values, the
   * values are marked stale (Requirement 11.14). It is compared as text, never calculated.
   */
  today?: string;
  /** The outcome's own retry is running. */
  retrying?: boolean;
  /** The one retry. It re-reads the snapshot, so no input is requested again. */
  onRetry?: (retry: OutcomeRetry) => void | Promise<void>;
  headingLevel?: 2 | 3 | 4;
}
/** Formats a server money value. Returns null for anything that is not a safe integer number of paise in INR. */
function money(value: MoneyValue | null | undefined): string | null {
  if (!value || value.currency !== 'INR' || !Number.isSafeInteger(value.amountMinor)) return null;
  return formatInr(value.amountMinor);
}
/**
 * `89` becomes `8.9`, `1000` becomes `100`, `100` becomes `10`, `5` becomes `0.5`. The server calculates the
 * share as tenths of a percent, so this only places the decimal point in the digits. Returns null for a value
 * that is not a whole number from 0 through 1000.
 */
export function formatPermille(permille: number | null | undefined): string | null {
  if (typeof permille !== 'number' || !Number.isInteger(permille) || permille < 0 || permille > 1000) return null;
  const digits = String(permille);
  const whole = digits.length > 1 ? digits.slice(0, -1) : '0';
  const tenth = digits.slice(-1);
  return tenth === '0' ? whole : `${whole}.${tenth}`;
}
interface HeadlineModel {
  date: string;
  allowance: string;
  spent: string;
  left: string;
  over: string;
  isOver: boolean;
  isZero: boolean;
  /** `8.9` for the label "8.9% of today's allowance used". Null when the server sent no share. */
  percent: string | null;
  zeroReason: TodayAllowanceZeroReason | null;
  usedBeyondBudget: string | null;
  excluded: { count: number; total: string } | null;
}
/** Reads the server's values into text. Returns null when a required value is malformed. */
function readModel(value: ApplicableValue): HeadlineModel | null {
  const allowance = money(value.todayAllowance);
  const spent = money(value.todaySpent);
  const left = money(value.leftToday);
  const over = money(value.overToday);
  if (allowance === null || spent === null || left === null || over === null) return null;
  const isOver = value.overToday.amountMinor > 0;
  const isZero = value.todayAllowance.amountMinor === 0;
  const excludedTotal = money(value.excludedToday?.total);
  const excludedCount = value.excludedToday?.count;
  return {
    date: value.date,
    allowance,
    spent,
    left,
    over,
    isOver,
    isZero,
    // No percentage while the allowance is zero (Requirement 11.7).
    percent: isZero ? null : formatPermille(isOver ? 1000 : value.usedPermille),
    zeroReason: isZero ? value.zeroReason : null,
    usedBeyondBudget: money(value.usedBeyondBudget),
    excluded: excludedTotal !== null && Number.isSafeInteger(excludedCount) && (excludedCount as number) > 0
      ? { count: excludedCount as number, total: excludedTotal }
      : null,
  };
}
/** Text equivalent of the headline, used for the card's live announcement. It changes only when a value changes. */
function summaryOf(model: HeadlineModel): string {
  const lead = `You can spend ${model.allowance} today`;
  if (model.isOver) return `${lead}. Over today's allowance by ${model.over}`;
  if (model.isZero) return lead;
  return `${lead}. ${model.left} left today`;
}
function ZeroReason({ model }: { model: HeadlineModel }) {
  switch (model.zeroReason) {
    case 'month_budget_used':
      return (
        <div className="today-headline-reason">
          <p>
            This month's spendable budget was already used before today
            {model.usedBeyondBudget !== null ? `, by ${model.usedBeyondBudget}` : ''}.
          </p>
          <ActionLink
            to={FALLBACK_ACTIONS.spendingRecord.to}
            label="Review this month's expenses"
            showDisclaimer={false}
          />
        </div>
      );
    case 'no_spendable_budget':
      return (
        <div className="today-headline-reason">
          <p>Your bills use all of your pay this month.</p>
          <ActionLink to={FALLBACK_ACTIONS.planAddBills.to} label="Review monthly bills" showDisclaimer={false} />
        </div>
      );
    case 'below_minimum_unit':
      return (
        <div className="today-headline-reason">
          <p>What is left is less than ₹0.01 a day.</p>
        </div>
      );
    default:
      return null;
  }
}
function HeadlineValue({ model }: { model: HeadlineModel }) {
  const state = model.isOver ? 'over' : model.isZero ? 'zero' : 'available';
  const showLeft = model.isOver || !model.isZero;
  return (
    <div className="today-headline" data-state={state}>
      <div className="today-headline-row">
        <p className="today-headline-main">
          You can spend{' '}
          <span className="mono today-headline-amount" data-classification="calculated_result">{model.allowance}</span>{' '}
          today
        </p>
        {showLeft && (
          <p className={`today-headline-left${model.isOver ? ' today-headline-over' : ''}`}>
            {model.isOver ? (
              <>
                <span aria-hidden="true" className="today-headline-glyph">!</span>
                Over today's allowance by{' '}
                <span className="mono today-headline-left-amount" data-classification="calculated_result">{model.over}</span>
              </>
            ) : (
              <>
                <span className="mono today-headline-left-amount" data-classification="calculated_result">{model.left}</span>{' '}
                left today
              </>
            )}
          </p>
        )}
      </div>
      <p className="today-headline-spent">
        Spent today{' '}
        <span className="mono" data-classification="calculated_result">{model.spent}</span>
        {' on '}
        <time dateTime={model.date}>{formatIsoDate(model.date)}</time>
        <span className="small muted today-headline-basis"> Calculated from your confirmed expenses.</span>
      </p>
      {model.percent !== null && (
        <div className="today-headline-progress">
          {/* The bar is decorative. The text below carries the same meaning (Requirement 11.5). */}
          <div className="today-headline-track" aria-hidden="true">
            <span
              className={`today-headline-fill${model.isOver ? ' today-headline-fill-over' : ''}`}
              style={{ width: `${model.percent}%` }}
            />
          </div>
          <p className="today-headline-percent small">{model.percent}% of today's allowance used</p>
        </div>
      )}
      {model.zeroReason !== null && <ZeroReason model={model} />}
      {model.excluded && (
        <p className="today-headline-excluded small">
          {model.excluded.count} {model.excluded.count === 1 ? 'expense' : 'expenses'} not counted today ({model.excluded.total})
        </p>
      )}
    </div>
  );
}
type UnavailableReason = 'no_field' | 'not_current_month';
const UNAVAILABLE_TEXT: Readonly<Record<UnavailableReason, string>> = Object.freeze({
  no_field: 'What you can spend today is not available from the server right now. You can still save expenses, and your monthly answer still works.',
  not_current_month: "Today's allowance is shown for the current month only. Refresh to load this month.",
});
interface UnavailableProps {
  reason: UnavailableReason;
  headingLevel: 2 | 3 | 4;
  retrying: boolean;
  onRetry?: (retry: OutcomeRetry) => void | Promise<void>;
}
/** The server sent no usable Today values. One retry re-reads the snapshot. Saves and the monthly answer are unaffected. */
function Unavailable({ reason, headingLevel, retrying, onRetry }: UnavailableProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const rescue = useFocusRescue(rootRef);
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="card clarity-outcome clarity-outcome-calculation_failed"
      data-state="unavailable"
      data-reason={reason}
    >
      <header className="clarity-outcome-header">
        <Heading id={titleId} className="clarity-outcome-title">{TODAY_HEADLINE_TITLE}</Heading>
      </header>
      <p className="clarity-outcome-badges"><StatusBadge status="calculation_failed" /></p>
      <p className="clarity-state clarity-tone-danger">
        <strong>Temporarily unavailable.</strong> {UNAVAILABLE_TEXT[reason]}
      </p>
      {onRetry && (
        <div className="clarity-retry-row">
          <button
            type="button"
            className="btn sm ghost clarity-retry"
            aria-disabled={retrying || undefined}
            aria-label={`${retrying ? 'Retrying…' : 'Refresh'} ${TODAY_HEADLINE_TITLE}`}
            onClick={() => {
              if (retrying) return;
              rescue.arm();
              void onRetry(SNAPSHOT_RETRY);
            }}
          >
            {retrying ? 'Retrying…' : 'Refresh'}
          </button>
        </div>
      )}
    </section>
  );
}
/**
 * `OutcomeCard` is typed for the four existing outcome kinds. The Today outcome has its own kind string
 * (`today_allowance`), which the shared label tables do not list yet, so the card falls back to a plain
 * rendering of it. This is the only place the types are bridged.
 */
function asCardOutcome(outcome: TodayAllowanceOutcome): Outcome<TodayAllowanceValue> {
  return { ...outcome, kind: outcome.kind as unknown as OutcomeKind };
}
function CorrectiveAction({ outcome }: { outcome: TodayAllowanceOutcome }): ReactNode {
  const action = correctiveActionFor(asCardOutcome(outcome));
  if (outcome.status === 'missing_input') {
    const needsPay = (outcome.missing ?? []).some(({ input }) => input === 'salary' || input.startsWith('salary:'));
    const target = action ?? FALLBACK_ACTIONS.planSetPay;
    return (
      <>
        <p className="today-headline-needed">
          {needsPay || !action
            ? "Add this month's pay to see what you can spend today."
            : 'Add the missing input to see what you can spend today.'}
        </p>
        <ActionLink to={target.to} label={target.label} variant="primary" showDisclaimer={false} />
      </>
    );
  }
  if (outcome.status === 'invalid_input') {
    return (
      <>
        <p className="today-headline-needed">Until this is corrected, what you can spend today is not shown.</p>
        {action && <ActionLink to={action.to} label={action.label} variant="primary" showDisclaimer={false} />}
      </>
    );
  }
  return null;
}
/**
 * The first Home outcome: "You can spend ₹X today".
 *
 * It renders only what the server calculated in `outcomes.todayAllowance`. Money is formatted from integer
 * paise and never added, subtracted, or divided here. The progress share is the server's `usedPermille`, with
 * the decimal point placed by text. Loading, a failed read, and a refresh stay inside this one region, so they
 * never hide the rest of Home (Requirements 11.11, 11.12).
 *
 * The card keeps one stable key (`outcome.id`), so an open "How this was calculated" stays open while the
 * values update (Requirement 11.16).
 */
export function TodayHeadline({
  outcome,
  hasSnapshot,
  loading = false,
  error,
  today,
  retrying = false,
  onRetry,
  headingLevel = 2,
}: TodayHeadlineProps) {
  const retrySnapshot = onRetry ? () => { void onRetry(SNAPSHOT_RETRY); } : undefined;
  let body: ReactNode = null;
  if (hasSnapshot) {
    if (!outcome) {
      body = <Unavailable reason="no_field" headingLevel={headingLevel} retrying={retrying} onRetry={onRetry} />;
    } else {
      const hasValue = outcome.value !== undefined
        && (outcome.status === 'available' || outcome.status === 'stale' || outcome.status === 'refresh_failed');
      const value = hasValue ? outcome.value : undefined;
      if (value && !value.applicable) {
        body = <Unavailable reason="not_current_month" headingLevel={headingLevel} retrying={retrying} onRetry={onRetry} />;
      } else {
        const model = value?.applicable ? readModel(value) : null;
        if (hasValue && !model) {
          body = <Unavailable reason="no_field" headingLevel={headingLevel} retrying={retrying} onRetry={onRetry} />;
        } else {
          // The values are for a date that is no longer today: mark them stale until the re-read returns.
          const dateIsOld = !!model && !!today && model.date !== today && outcome.status === 'available';
          const shown: TodayAllowanceOutcome = dateIsOld
            ? {
                ...outcome,
                status: 'stale',
                stale: { sourcePeriod: formatIsoDate(model.date), requestedPeriod: formatIsoDate(today) },
              }
            : outcome;
          body = (
            <OutcomeCard<TodayAllowanceValue>
              key={outcome.id}
              outcome={asCardOutcome(shown)}
              title={TODAY_HEADLINE_TITLE}
              headingLevel={headingLevel}
              retrying={retrying}
              onRetry={onRetry}
              correctiveAction={<CorrectiveAction outcome={outcome} />}
              valueSummary={model ? summaryOf(model) : undefined}
              renderValue={() => (model ? <HeadlineValue model={model} /> : null)}
              className="today-headline-card"
            />
          );
        }
      }
    }
  }
  return (
    <div className="today-headline-region" data-testid="today-headline">
      <RegionBoundary
        regionKey="today"
        label={TODAY_HEADLINE_TITLE}
        hasData={hasSnapshot}
        loading={loading}
        error={error}
        onRetry={retrySnapshot}
        minHeight={176}
        skeletonLines={2}
      >
        {body}
      </RegionBoundary>
    </div>
  );
}
