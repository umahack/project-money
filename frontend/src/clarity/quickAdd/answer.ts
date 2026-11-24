/**
 * Entry_Answer builder for Quick Add.
 *
 * Pure module. `buildEntryAnswer(envelope, entry, today)` reads the clarity mutation response of a confirmed expense
 * create, update, or delete and returns a structured model of message KEYS plus references to server money values. A
 * formatter in the UI task turns the keys and values into text. This module renders nothing.
 *
 * Money rule: the browser never adds, subtracts, multiplies, or divides money. Every `MoneyValue` in the model is one of
 *   - an object taken from the response (`outcomes.todayAllowance.value`, `monthlyPlan.value`, `spending.value`), returned
 *     by identity, or
 *   - the integer paise of a server field that the response carries as a plain number (`mutation.record.amountMinor`,
 *     `exceededBudgetActions[].excessMinor`), wrapped as `{ currency: 'INR', amountMinor }` with the number unchanged.
 * The only operations on money are comparisons with zero that choose a state (over today, negative remaining) and
 * equality of ids and dates. "Over today's allowance by X" uses the server's `overToday`. "{bucket} budget exceeded by X"
 * uses the server's `excessMinor`. A negative `remainingSpendable` is passed through as the server sent it, and the
 * `answer.month.overBudget` line is displayed as its magnitude by the formatter (sign handling for display only).
 *
 * Requirements: 9.1 to 9.14, 9.17, 9.19, 9.20, 16.7, 16.17.
 */
import { buildActionRoute } from '../actionContext';
import type {
  FinancialSnapshot,
  MoneyValue,
  MutationEnvelope,
  Outcome,
  OutcomeStatus,
  SpendingOutcomeValue,
  TodayAllowanceValue,
} from '../contracts';
import type { EntryWarning } from './warning';

/** Operation key of the expense delete (the Undo) in `mutation.operation`. */
export const EXPENSE_DELETE_OPERATION = 'expense.delete';

/** Every message key the answer can contain. The formatter owns the wording. */
export type AnswerMessageKey =
  | 'answer.saved'
  | 'answer.removed'
  | 'answer.entry.date'
  | 'answer.today.spent'
  | 'answer.today.left'
  | 'answer.today.over'
  | 'answer.today.zeroAllowance'
  | 'answer.today.excluded.notCounted'
  | 'answer.today.excluded.monthIncludes'
  | 'answer.today.excluded.allowanceAfter'
  | 'answer.today.excluded.allowanceChanged'
  | 'answer.today.exclusionUnconfirmed'
  | 'answer.bucket.status'
  | 'answer.bucket.exceeded'
  | 'answer.month.remaining'
  /** Display the magnitude of the signed `remainingSpendable` value. Present only when the server value is negative. */
  | 'answer.month.overBudget'
  | 'answer.month.countsTowardOther'
  | 'answer.missingInput'
  | 'answer.invalidInput'
  | 'answer.effect.unavailable';

export type AnswerParamValue = string | number | readonly string[];

export interface AnswerLine {
  key: AnswerMessageKey;
  /** Server money values by role. Present only when the value exists in the response. */
  money?: Readonly<Record<string, MoneyValue>>;
  /** `entered_fact` for the saved amount, `calculated_result` for every value the server calculated (Requirement 9.17). */
  classification?: 'entered_fact' | 'calculated_result';
  params?: Readonly<Record<string, AnswerParamValue>>;
}

export type AnswerStatus = 'available' | 'missing_input' | 'invalid_input' | 'calculation_failed';

/**
 * - `shown`: the Today values are in the answer.
 * - `not_applicable`: the entry's month is not the Current_Month, so the Home values are not touched.
 * - `not_provided`: the server returned no `todayAllowance` outcome (Requirement 16.7). The monthly answer stands alone.
 * - `unavailable`: the outcome is not available, or its values are not for `today`.
 */
export type AnswerTodayState = 'shown' | 'not_applicable' | 'not_provided' | 'unavailable';

export type AnswerExclusionReason = 'unconfirmed' | 'large' | 'bill' | 'over_today';

export type AnswerAction =
  /** Re-read the snapshot. Resubmits nothing. */
  | { key: 'recalculate'; scopeKey: string | null }
  /** Link to the existing Plan pay form. */
  | { key: 'open_plan_pay_form'; route: string }
  /** Change the entry to "not counted against today" through the expense update operation. */
  | { key: 'exclude_from_today'; recordId: number; reasons: readonly AnswerExclusionReason[] };

export interface AnswerSavedEntry {
  /** The confirmed expense id, or null when the response carries no record. */
  recordId: number | null;
  /** The server-confirmed amount, or null when the response carries no usable record. */
  amount: MoneyValue | null;
  category: string;
  note: string | null;
  spentOn: string;
  /** Where `spentOn` falls against Today. */
  dateRelation: 'today' | 'past' | 'future';
}

export interface EntryAnswerModel {
  /** `removed` is the answer after Undo: the same builder on the delete response, labelled "Entry removed". */
  mode: 'saved' | 'removed';
  titleKey: 'answer.saved' | 'answer.removed';
  /** The snapshot's data version. A newer version replaces the answer. An older one never does (Requirement 9.15). */
  dataVersion: number;
  /** The snapshot month, which is the entry's month. */
  month: string;
  scope: 'current_month' | 'other_month';
  /** False for an entry in another month: the Home headline and the Current_Month values stay as they were. */
  countsTowardCurrentMonth: boolean;
  status: AnswerStatus;
  today: AnswerTodayState;
  /** The treatment the server applied to the entry's category, or null when unknown (always null after Undo). */
  bucket: 'needs' | 'wants' | null;
  saved: AnswerSavedEntry | null;
  /** The existing explanation control for Today_Allowance, or null when no Today value is shown (Requirement 9.17). */
  explanation: { outcomeId: string; dataVersion: number } | null;
  lines: readonly AnswerLine[];
  actions: readonly AnswerAction[];
}

/** What the answer needs to know about the submitted entry. Dates and amounts come from the server record. */
export interface AnswerEntryInput {
  category?: string;
  /** `YYYY-MM-DD` the User saw in the preview. Used only when the response carries no record. */
  spentOn?: string;
  note?: string;
  /** The create request asked for the Allowance_Exclusion. */
  exclusionRequested?: boolean;
  /** The Entry_Warning shown when the entry was submitted. */
  warning?: EntryWarning | null;
}

/** Any outcome of the snapshot, including the `today_allowance` kind that `OutcomeKind` leaves out. */
type AnyOutcome = Omit<Outcome<unknown>, 'kind'> & { kind: string };

const FAILED_STATUSES: ReadonlySet<OutcomeStatus> = new Set(['calculation_failed', 'refresh_failed', 'stale']);

function isMoney(value: unknown): value is MoneyValue {
  if (typeof value !== 'object' || value === null) return false;
  const { amountMinor } = value as { amountMinor?: unknown };
  return Number.isSafeInteger(amountMinor);
}

/** The server integer paise as a MoneyValue, unchanged. Null when it is not a safe integer. */
function wrapServerMinor(minor: unknown): MoneyValue | null {
  return typeof minor === 'number' && Number.isSafeInteger(minor) ? { currency: 'INR', amountMinor: minor } : null;
}

function isIsoDate(text: unknown): text is string {
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text);
}

function isPresentString(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0;
}

/** Keeps the line only when every named money value exists. Never invents one. */
function moneyLine(
  key: AnswerMessageKey,
  money: Record<string, MoneyValue | null | undefined>,
  extra: Pick<AnswerLine, 'params' | 'classification'> = { classification: 'calculated_result' },
): AnswerLine | null {
  const present: Record<string, MoneyValue> = {};
  for (const [role, value] of Object.entries(money)) {
    if (!isMoney(value)) return null;
    present[role] = value;
  }
  return { key, money: present, ...extra };
}

function pushLine(lines: AnswerLine[], line: AnswerLine | null): void {
  if (line !== null) lines.push(line);
}

function usableOutcome<T>(outcome: Outcome<T> | undefined): T | null {
  return outcome !== undefined && outcome.status === 'available' && outcome.value !== undefined ? outcome.value : null;
}

function recordOf(envelope: MutationEnvelope): Record<string, unknown> | null {
  const record = envelope.mutation?.record;
  return typeof record === 'object' && record !== null ? record : null;
}

function dateRelation(spentOn: string, today: string): AnswerSavedEntry['dateRelation'] {
  if (spentOn === today) return 'today';
  return spentOn < today ? 'past' : 'future';
}

function bucketAmounts(spending: SpendingOutcomeValue, bucket: 'needs' | 'wants'): { spent: MoneyValue; budget: MoneyValue } {
  return bucket === 'needs'
    ? { spent: spending.needsSpent, budget: spending.needsBudget }
    : { spent: spending.wantsSpent, budget: spending.wantsBudget };
}

/**
 * Build the Entry_Answer for one confirmed expense mutation.
 *
 * @param envelope The clarity mutation response (`mutation` plus the snapshot of the entry's month).
 * @param entry What the User submitted. Used for the exclusion request and the warning, and as a fallback for text.
 * @param today The Kolkata date, `YYYY-MM-DD`.
 */
export function buildEntryAnswer(envelope: MutationEnvelope, entry: AnswerEntryInput, today: string): EntryAnswerModel {
  const snapshot: FinancialSnapshot | undefined = envelope?.clarity;
  const removed = envelope?.mutation?.operation === EXPENSE_DELETE_OPERATION;
  const mode: EntryAnswerModel['mode'] = removed ? 'removed' : 'saved';
  const titleKey = removed ? 'answer.removed' : 'answer.saved';
  const record = removed ? null : recordOf(envelope);

  const month = snapshot?.period?.month ?? '';
  const currentMonth = isIsoDate(today) ? today.slice(0, 7) : '';
  const isCurrent = month !== '' && month === currentMonth;
  const scope: EntryAnswerModel['scope'] = isCurrent ? 'current_month' : 'other_month';
  const dataVersion = Number.isSafeInteger(snapshot?.dataVersion) ? (snapshot as FinancialSnapshot).dataVersion : 0;

  const lines: AnswerLine[] = [];
  const actions: AnswerAction[] = [];

  // The saved entry. Amount, category, note, and date come from the confirmed record.
  const recordId = typeof record?.id === 'number' && Number.isSafeInteger(record.id) ? record.id : null;
  const spentOn = isIsoDate(record?.spentOn) ? record.spentOn : isIsoDate(entry?.spentOn) ? entry.spentOn : null;
  const category = isPresentString(record?.category) ? record.category : (entry?.category ?? '');
  const note = typeof record?.note === 'string' && record.note !== '' ? record.note : (entry?.note || null);
  let saved: AnswerSavedEntry | null = null;
  if (!removed && spentOn !== null) {
    saved = {
      recordId,
      amount: wrapServerMinor(record?.amountMinor),
      category,
      note,
      spentOn,
      dateRelation: isIsoDate(today) ? dateRelation(spentOn, today) : 'past',
    };
  }
  const datedToday = saved !== null && saved.dateRelation === 'today' && isCurrent;

  if (removed) {
    lines.push({ key: 'answer.removed', params: { category } });
  } else {
    const line: AnswerLine = { key: 'answer.saved', params: { category, note: note ?? '' } };
    if (saved?.amount) {
      line.money = { amount: saved.amount };
      line.classification = 'entered_fact';
    }
    lines.push(line);
    if (saved !== null && saved.dateRelation !== 'today') {
      lines.push({ key: 'answer.entry.date', params: { date: saved.spentOn, relation: saved.dateRelation } });
    }
  }

  if (!snapshot || typeof snapshot !== 'object' || !snapshot.outcomes) {
    // A committed write with no readable snapshot: saved, effect unavailable, one recalculate action.
    lines.push({ key: 'answer.effect.unavailable', params: { month } });
    actions.push({ key: 'recalculate', scopeKey: null });
    return {
      mode,
      titleKey,
      dataVersion,
      month,
      scope,
      countsTowardCurrentMonth: isCurrent,
      status: 'calculation_failed',
      today: isCurrent ? 'unavailable' : 'not_applicable',
      bucket: null,
      saved,
      explanation: null,
      lines,
      actions,
    };
  }

  const { monthlyPlan, spending, todayAllowance } = snapshot.outcomes;
  const todayOutcome = isCurrent ? todayAllowance : undefined;

  // The status of the answer. Missing and invalid inputs come from the plan, then from the other outcomes.
  const considered: Array<AnyOutcome | undefined> = [monthlyPlan, spending, todayOutcome];
  let status: AnswerStatus = 'available';
  const missingOutcome = considered.find((outcome) => outcome?.status === 'missing_input');
  const invalidOutcome = considered.find((outcome) => outcome?.status === 'invalid_input');
  const failedOutcome = considered.find((outcome) => outcome !== undefined && FAILED_STATUSES.has(outcome.status));
  if (missingOutcome) {
    status = 'missing_input';
  } else if (invalidOutcome) {
    status = 'invalid_input';
  } else if (
    failedOutcome
    || monthlyPlan === undefined
    || spending === undefined
    || considered.some((outcome) => outcome !== undefined && outcome.status !== 'available')
  ) {
    status = 'calculation_failed';
  }

  const plan = usableOutcome(monthlyPlan);
  const spendingValue = usableOutcome(spending);
  const todayValue: TodayAllowanceValue | null = usableOutcome(todayOutcome as Outcome<TodayAllowanceValue> | undefined);

  // Today values (Requirements 9.3 to 9.5, 9.19). Only for the Current_Month, only when the server date is Today.
  let todayState: AnswerTodayState;
  let explanation: EntryAnswerModel['explanation'] = null;
  let todayShown: Extract<TodayAllowanceValue, { applicable: true }> | null = null;
  if (!isCurrent) {
    todayState = 'not_applicable';
  } else if (todayOutcome === undefined) {
    todayState = 'not_provided';
  } else if (todayValue !== null && todayValue.applicable === true && todayValue.date === today) {
    todayState = 'shown';
    todayShown = todayValue;
  } else {
    todayState = 'unavailable';
  }

  const excludedConfirmed = record?.excludeFromDailyAllowance === true && datedToday;
  const exclusionRequested = entry?.exclusionRequested === true;
  const exclusionUnconfirmed = !removed && exclusionRequested && !excludedConfirmed && datedToday;

  if (todayShown !== null) {
    pushLine(lines, moneyLine('answer.today.spent', {
      todaySpent: todayShown.todaySpent,
      todayAllowance: todayShown.todayAllowance,
    }));
    if (isMoney(todayShown.overToday) && todayShown.overToday.amountMinor > 0) {
      pushLine(lines, moneyLine('answer.today.over', { overToday: todayShown.overToday }));
    } else {
      pushLine(lines, moneyLine('answer.today.left', { leftToday: todayShown.leftToday }));
    }
    if (todayShown.zeroReason !== null) {
      const zeroLine: AnswerLine = {
        key: 'answer.today.zeroAllowance',
        params: { reason: todayShown.zeroReason },
      };
      if (todayShown.zeroReason === 'month_budget_used' && isMoney(todayShown.usedBeyondBudget)) {
        zeroLine.money = { usedBeyondBudget: todayShown.usedBeyondBudget };
        zeroLine.classification = 'calculated_result';
      }
      lines.push(zeroLine);
    }
    const ref = todayOutcome?.explanationRef;
    explanation = {
      outcomeId: ref?.outcomeId ?? (todayOutcome as AnyOutcome).id,
      dataVersion: ref?.dataVersion ?? todayOutcome?.dataVersion ?? dataVersion,
    };
  }

  // The exclusion statements (Requirements 9.19, 16.17).
  if (excludedConfirmed) {
    lines.push({ key: 'answer.today.excluded.notCounted' });
    lines.push({ key: 'answer.today.excluded.monthIncludes' });
    if (todayShown !== null) {
      pushLine(lines, moneyLine('answer.today.excluded.allowanceAfter', { todayAllowance: todayShown.todayAllowance }));
      lines.push({ key: 'answer.today.excluded.allowanceChanged' });
    }
  } else if (exclusionUnconfirmed) {
    lines.push({ key: 'answer.today.exclusionUnconfirmed' });
  }

  // Bucket status (Requirements 9.8 to 9.10).
  let bucket: EntryAnswerModel['bucket'] = null;
  if (spendingValue !== null) {
    const treatment = recordId === null
      ? undefined
      : spendingValue.appliedTreatments?.find((applied) => applied.expenseId === recordId);
    if (treatment && (treatment.treatment === 'needs' || treatment.treatment === 'wants')) {
      bucket = treatment.treatment;
      pushLine(lines, moneyLine('answer.bucket.status', bucketAmounts(spendingValue, bucket), {
        classification: 'calculated_result',
        params: { bucket, source: treatment.source },
      }));
    }
    const exceeded = [...(spendingValue.exceededBudgetActions ?? [])].filter(
      (action) => action.bucket === 'needs' || action.bucket === 'wants',
    );
    // The entry's own bucket first, then the other one, each in the server's order.
    exceeded.sort((a, b) => Number(b.bucket === bucket) - Number(a.bucket === bucket));
    for (const action of exceeded) {
      pushLine(lines, moneyLine('answer.bucket.exceeded', { excess: wrapServerMinor(action.excessMinor) }, {
        classification: 'calculated_result',
        params: { bucket: action.bucket },
      }));
    }
  }

  // Month status (Requirements 9.6, 9.7, 9.11).
  const remaining = plan?.remainingSpendable ?? spendingValue?.remainingSpendable ?? null;
  if (!isCurrent) {
    lines.push({ key: 'answer.month.countsTowardOther', params: { month, currentMonth } });
    if (remaining !== null) {
      pushLine(lines, moneyLine('answer.month.remaining', { remainingSpendable: remaining }, {
        classification: 'calculated_result',
        params: { month },
      }));
    }
  }
  if (remaining !== null && isMoney(remaining) && remaining.amountMinor < 0) {
    pushLine(lines, moneyLine('answer.month.overBudget', { remainingSpendable: remaining }, {
      classification: 'calculated_result',
      params: { month },
    }));
  }

  // Saved-but-unavailable states (Requirements 9.12 to 9.14).
  if (status === 'missing_input') {
    const input = missingOutcome?.missing?.[0]?.input ?? 'salary';
    lines.push({ key: 'answer.missingInput', params: { month, input } });
    if (input === 'salary') {
      const route = buildActionRoute({ page: 'plan', anchor: 'pay-form' });
      if (route !== null) actions.push({ key: 'open_plan_pay_form', route });
    }
  } else if (status === 'invalid_input') {
    const issue = invalidOutcome?.invalid?.[0];
    lines.push({
      key: 'answer.invalidInput',
      params: {
        month,
        input: issue?.input ?? '',
        constraint: issue?.constraint ?? '',
        affects: issue?.affects ?? [],
      },
    });
  } else if (status === 'calculation_failed') {
    lines.push({ key: 'answer.effect.unavailable', params: { month } });
    actions.push({ key: 'recalculate', scopeKey: failedOutcome?.retry?.scopeKey ?? null });
  }

  // The offer to change the entry to "not counted against today" (Requirements 9.20, 16.17).
  if (!removed && datedToday && !excludedConfirmed && recordId !== null) {
    const reasons: AnswerExclusionReason[] = [];
    if (exclusionUnconfirmed) reasons.push('unconfirmed');
    if (entry?.warning?.kind === 'warn') {
      if (entry.warning.large) reasons.push('large');
      if (entry.warning.bill !== undefined) reasons.push('bill');
    }
    if (todayShown !== null && isMoney(todayShown.overToday) && todayShown.overToday.amountMinor > 0) {
      reasons.push('over_today');
    }
    if (reasons.length > 0) actions.push({ key: 'exclude_from_today', recordId, reasons });
  }

  return {
    mode,
    titleKey,
    dataVersion,
    month,
    scope,
    countsTowardCurrentMonth: isCurrent,
    status,
    today: todayState,
    bucket,
    saved,
    explanation,
    lines,
    actions,
  };
}
