// Pure helpers for the Goals page in the clarity branch.
//
// Nothing here calculates a financial outcome. Funding gaps, contribution
// months, required contributions, feasibility, and revisions are the server's
// and are only read from the snapshot. This file holds field checks for what
// the user types (the accepted bounds of Requirement 6.1 to 6.4), conversion of
// saved rows, and the plain words for corrections.
import type { FinancialSnapshot, GoalOutcomeValue, MutationMetadata, Outcome } from '../../clarity/contracts';
import type { MutationFailure } from '../../clarity/mutationStatusStore';
import { parseMinor, type FieldProblem } from '../../clarity/planInputs';
import type { ConfirmedState } from '../../clarity/purposeRegistry';
import { inr } from '../../money';

/** A goal as `GET /api/finance/goals` returns it. Amounts are rupees. */
export interface GoalRow {
  id: number;
  name: string;
  target_amount: number;
  saved_amount: number;
  target_date: string | null;
  created_at?: string;
  updated_at?: string;
}

/** The entered facts of one saved goal. Amounts are whole paise, or null when the stored value is not a whole paisa. */
export interface GoalView {
  id: number;
  name: string;
  targetMinor: number | null;
  savedMinor: number | null;
  targetDate: string | null;
}

export type GoalField = 'name' | 'target' | 'saved' | 'date';
export type GoalProblemKey = GoalField | 'form';

const toMinor = (rupees: unknown): number | null => {
  const value = Number(rupees);
  if (!Number.isFinite(value)) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor : null;
};

export function toGoalView(row: GoalRow): GoalView {
  return {
    id: row.id,
    name: row.name,
    targetMinor: toMinor(row.target_amount),
    savedMinor: toMinor(row.saved_amount),
    targetDate: typeof row.target_date === 'string' && row.target_date ? row.target_date : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The confirmed record a goal mutation returns (`mutation.record`), or null when it has an unexpected shape. */
export function goalFromRecord(record: MutationMetadata['record'] | unknown): GoalView | null {
  if (!isRecord(record) || !Number.isSafeInteger(record.id) || typeof record.name !== 'string') return null;
  const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
  return {
    id: record.id as number,
    name: record.name,
    targetMinor: minor(record.targetAmountMinor),
    savedMinor: minor(record.savedAmountMinor),
    targetDate: typeof record.targetDate === 'string' && record.targetDate ? record.targetDate : null,
  };
}

/* ------------------------------ snapshot reads ----------------------------- */

const GOAL_OUTCOME_ID = /^goal:[1-9]\d*$/;

export function findGoalOutcome(snapshot: FinancialSnapshot | undefined, goalId: number): Outcome<GoalOutcomeValue> | undefined {
  return snapshot?.outcomes.goals.find((outcome) => outcome.id === `goal:${goalId}`);
}

/** A failed read of all goals is one outcome that is not tied to a goal. */
export function findAggregateGoalOutcome(snapshot: FinancialSnapshot | undefined): Outcome<GoalOutcomeValue> | undefined {
  return snapshot?.outcomes.goals.find((outcome) => !GOAL_OUTCOME_ID.test(outcome.id));
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The current local date the server used. The browser's date is only a fallback before the first snapshot. */
export function todayFor(snapshot: FinancialSnapshot | undefined): string {
  const asOf = snapshot?.period.asOfDate;
  return asOf && isCalendarDate(asOf) ? asOf : localDate();
}

export function displayDate(iso: string): string {
  const match = DATE_PATTERN.exec(iso);
  if (!match) return iso;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * What the user has already confirmed, for the benefit preview. Values are the
 * server's: the featured urgent goal when it has a confirmed outcome, otherwise
 * the first goal with one. A goal with no available outcome counts as existing,
 * with its outcomes shown as not available yet.
 */
export function goalConfirmedState(snapshot: FinancialSnapshot | undefined): ConfirmedState {
  if (!snapshot || snapshot.outcomes.goals.length === 0) return {};
  const available = snapshot.outcomes.goals.filter((outcome) => outcome.status === 'available' && outcome.value);
  const urgentId = snapshot.highlights?.urgentGoal?.goalId;
  const chosen = available.find((outcome) => outcome.value?.goalId === urgentId) ?? available[0];
  const value = chosen?.value;
  if (!value) return { goal: { outcomes: {} } };
  return {
    goal: {
      outcomes: {
        goal_funding_gap: value.fundingGap,
        required_goal_contribution: value.requiredContribution,
        goal_feasibility: { kind: 'feasibility', value: value.feasibility },
      },
    },
  };
}

/** Which entered values the server says are invalid for this goal, in a fixed order. */
export function invalidGoalFields(outcome: Outcome<GoalOutcomeValue> | undefined): GoalField[] {
  const byName: Record<string, GoalField> = { name: 'name', targetAmountMinor: 'target', savedAmountMinor: 'saved', targetDate: 'date' };
  const found = new Set<GoalField>();
  for (const item of outcome?.invalid ?? []) {
    const field = byName[item.input.split('.').pop() ?? ''];
    if (field) found.add(field);
  }
  return (['name', 'target', 'saved', 'date'] as const).filter((field) => found.has(field));
}

/** The correction prompt for a goal the server cannot calculate. The stored goal is never rewritten. */
export function correctionPrompt(field: GoalField, today: string): string {
  switch (field) {
    case 'date':
      return `This goal has no valid target date. Choose a target date on or after ${displayDate(today)} to see what it needs each month.`;
    case 'saved':
      return 'The saved amount is above the target amount. Correct the saved amount so it is from ₹0 up to the target, or raise the target.';
    case 'target':
      return 'The target amount must be above ₹0. Enter the amount you want to reach.';
    case 'name':
      return 'This goal needs a name with at least one character.';
  }
}

/* ------------------------------ field checks ------------------------------ */

export const FIELD_LABEL: Readonly<Record<GoalField, string>> = Object.freeze({
  name: 'Goal name',
  target: 'Target amount',
  saved: 'Saved so far',
  date: 'Target date',
});

export interface GoalDraftText {
  name: string;
  target: string;
  saved: string;
  date: string;
}

type Checked<T> = { value: T; problem?: undefined } | { value?: undefined; problem: FieldProblem };

function checkName(text: string): Checked<string> {
  const name = text.trim();
  if (name.length < 1 || name.length > 60) {
    return { problem: { field: FIELD_LABEL.name, reason: 'must have between 1 and 60 characters.', correction: 'Enter a short name, for example Laptop upgrade.' } };
  }
  return { value: name };
}

function checkTarget(text: string): Checked<number> {
  const minor = parseMinor(text, { allowZero: false });
  if (minor === null) {
    return { problem: { field: FIELD_LABEL.target, reason: 'must be an amount above 0.', correction: 'Enter an amount such as 60000 or 60,000.50, with at most 2 decimals.' } };
  }
  return { value: minor };
}

function checkSaved(text: string): Checked<number> {
  const minor = text.trim() === '' ? 0 : parseMinor(text, { allowZero: true });
  if (minor === null) {
    return { problem: { field: FIELD_LABEL.saved, reason: 'is not an accepted amount.', correction: 'Enter 0, or an amount up to the target amount, with at most 2 decimals.' } };
  }
  return { value: minor };
}

function checkDate(text: string, today: string): Checked<string> {
  const date = text.trim();
  if (date === '') {
    return { problem: { field: FIELD_LABEL.date, reason: 'is required.', correction: `Choose a date on or after ${displayDate(today)}.` } };
  }
  if (!isCalendarDate(date)) {
    return { problem: { field: FIELD_LABEL.date, reason: 'is not a valid date.', correction: `Choose a date on or after ${displayDate(today)}.` } };
  }
  if (date < today) {
    return { problem: { field: FIELD_LABEL.date, reason: 'is before today.', correction: `Choose ${displayDate(today)} or a later date.` } };
  }
  return { value: date };
}

function exceedsTarget(savedMinor: number, targetMinor: number): FieldProblem | null {
  return savedMinor > targetMinor
    ? {
        field: FIELD_LABEL.saved,
        reason: 'is more than the target amount.',
        correction: `Enter an amount from ₹0 up to ${inr(targetMinor / 100)}, or raise the target.`,
      }
    : null;
}

export interface NewGoalValues {
  name: string;
  targetAmountMinor: number;
  savedAmountMinor: number;
  targetDate: string;
}

/** Checks a new goal against the accepted bounds. Every message names the field and the accepted bound. */
export function validateNewGoal(
  draft: GoalDraftText,
  today: string,
): { errors: Partial<Record<GoalField, FieldProblem>>; values: NewGoalValues | null } {
  const errors: Partial<Record<GoalField, FieldProblem>> = {};
  const name = checkName(draft.name);
  const target = checkTarget(draft.target);
  const saved = checkSaved(draft.saved);
  const date = checkDate(draft.date, today);
  if (name.problem) errors.name = name.problem;
  if (target.problem) errors.target = target.problem;
  if (saved.problem) errors.saved = saved.problem;
  else if (target.value !== undefined && saved.value !== undefined) {
    const over = exceedsTarget(saved.value, target.value);
    if (over) errors.saved = over;
  }
  if (date.problem) errors.date = date.problem;
  if (Object.keys(errors).length > 0 || name.value === undefined || target.value === undefined || saved.value === undefined || date.value === undefined) {
    return { errors, values: null };
  }
  return {
    errors,
    values: { name: name.value, targetAmountMinor: target.value, savedAmountMinor: saved.value, targetDate: date.value },
  };
}

/**
 * Checks a correction to a saved goal. Only changed fields are checked and sent,
 * so a goal that is already outside the bounds can be corrected one field at a
 * time and nothing the user did not touch is rewritten. The saved-versus-target
 * relation is checked when either amount changed, as the server does.
 */
export function validateGoalEdit(
  draft: GoalDraftText,
  original: GoalView,
  today: string,
): { errors: Partial<Record<GoalField, FieldProblem>>; body: Record<string, unknown> | null; unchanged: boolean } {
  const errors: Partial<Record<GoalField, FieldProblem>> = {};
  const body: Record<string, unknown> = {};

  const name = draft.name.trim();
  if (name !== original.name) {
    const checked = checkName(draft.name);
    if (checked.problem) errors.name = checked.problem;
    else body.name = checked.value;
  }

  const targetText = draft.target.replace(/[₹,\s]/g, '');
  const originalTarget = original.targetMinor === null ? '' : String(original.targetMinor / 100);
  let targetMinor = original.targetMinor;
  if (targetText !== originalTarget) {
    const checked = checkTarget(draft.target);
    if (checked.problem) errors.target = checked.problem;
    else if (checked.value !== original.targetMinor) {
      body.targetAmountMinor = checked.value;
      targetMinor = checked.value;
    }
  }

  const savedText = draft.saved.replace(/[₹,\s]/g, '');
  const originalSaved = original.savedMinor === null ? '' : String(original.savedMinor / 100);
  let savedMinor = original.savedMinor;
  if (savedText !== originalSaved && !(savedText === '' && original.savedMinor === 0)) {
    const checked = checkSaved(draft.saved);
    if (checked.problem) errors.saved = checked.problem;
    else if (checked.value !== original.savedMinor) {
      body.savedAmountMinor = checked.value;
      savedMinor = checked.value;
    }
  }
  if (!errors.target && !errors.saved && ('targetAmountMinor' in body || 'savedAmountMinor' in body)
    && targetMinor !== null && savedMinor !== null) {
    const over = exceedsTarget(savedMinor, targetMinor);
    if (over) errors.saved = over;
  }

  const date = draft.date.trim();
  if (date !== (original.targetDate ?? '')) {
    const checked = checkDate(draft.date, today);
    if (checked.problem) errors.date = checked.problem;
    else body.targetDate = checked.value;
  }

  const unchanged = Object.keys(errors).length === 0 && Object.keys(body).length === 0;
  return { errors, body: Object.keys(errors).length === 0 && !unchanged ? body : null, unchanged };
}

export const CONTRIBUTION_FIELD = 'Contribution';

export const CONTRIBUTION_FORMAT_PROBLEM: FieldProblem = {
  field: CONTRIBUTION_FIELD,
  reason: 'is not an accepted amount.',
  correction: 'Enter an amount such as 500 or 1,250.50, with at most 2 decimals. Negative amounts are not accepted; to fix a wrong saved amount, choose Edit.',
};

/** Whole paise for the contribution text, or null when the text is not a plain amount. The range itself is the server's to check. */
export function parseContribution(text: string): number | null {
  return parseMinor(text, { allowZero: true });
}

/* ------------------------------ server answers ----------------------------- */

const SERVER_FIELD: Readonly<Record<string, GoalField | 'contribution'>> = Object.freeze({
  name: 'name',
  targetAmountMinor: 'target',
  savedAmountMinor: 'saved',
  targetDate: 'date',
  contributionMinor: 'contribution',
});

export interface ServerProblem {
  key: GoalProblemKey | 'contribution';
  problem: FieldProblem;
}

function bounds(constraint: MutationFailure['constraint']): { min: number; max: number } | null {
  if (!isRecord(constraint)) return null;
  const { minMinor, maxMinor } = constraint;
  return Number.isSafeInteger(minMinor) && Number.isSafeInteger(maxMinor)
    ? { min: minMinor as number, max: maxMinor as number }
    : null;
}

/**
 * A rejected value, worded for the field it belongs to. Returns null when the
 * failure is not a validation answer, so it stays a failed change with a retry.
 * A contribution outside the range names the server's accepted range.
 */
export function describeServerProblem(error: MutationFailure): ServerProblem | null {
  if (error.status !== 422) return null;
  if (error.code === 'GOAL_REQUIRES_CORRECTION') {
    return {
      key: 'form',
      problem: {
        field: 'This goal',
        reason: 'needs a correction before you can add to it.',
        correction: 'Choose Correct this goal, fix the value, then add your contribution.',
      },
    };
  }
  const key = error.field ? SERVER_FIELD[error.field] : undefined;
  if (!key) return null;
  if (key === 'contribution') {
    const range = bounds(error.constraint);
    if (range && range.max <= 0) {
      return {
        key,
        problem: {
          field: CONTRIBUTION_FIELD,
          reason: 'cannot be added because this goal is already fully funded.',
          correction: 'No contribution is accepted for a funded goal.',
        },
      };
    }
    return {
      key,
      problem: {
        field: CONTRIBUTION_FIELD,
        reason: 'is outside the accepted range.',
        correction: range
          ? `Enter an amount from ${inr(range.min / 100)} to ${inr(range.max / 100)}.`
          : error.message,
      },
    };
  }
  return { key, problem: { field: FIELD_LABEL[key], reason: 'was not accepted.', correction: error.message } };
}
