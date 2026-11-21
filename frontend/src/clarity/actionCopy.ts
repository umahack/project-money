import { isClarityActionKey, type ClarityActionKey } from './actionContext';
import type { ActionableInsight } from './contracts';

/**
 * Fixed, plain-language copy for every action key the server may attach to an
 * `ActionableInsight`. It mirrors the wording in `backend/src/domain/insights.js`.
 *
 * The server's text is shown when it is already plain language. When it is not (an
 * action key, a record ID, or another internal identifier leaked into the text), the
 * text from this table is shown instead, so a person never reads a raw identifier
 * such as `contribute_to_goal` or `recordId`.
 */
interface ActionCopy {
  label: string;
  effect: string;
  observation: string;
}

export const ACTION_COPY: Readonly<Record<ClarityActionKey, ActionCopy>> = Object.freeze({
  review_bills: {
    label: 'Review monthly bills',
    effect: 'Reducing a bill reduces the current-month shortfall.',
    observation: 'Current-month bills exceed salary.',
  },
  address_needs_budget_excess: {
    label: 'Review Needs spending',
    effect: 'Reducing or correctly reclassifying spending reduces the Needs budget excess.',
    observation: 'Needs spending exceeds its current-month budget.',
  },
  address_wants_budget_excess: {
    label: 'Review Wants spending',
    effect: 'Reducing or correctly reclassifying spending reduces the Wants budget excess.',
    observation: 'Wants spending exceeds its current-month budget.',
  },
  revise_goal_target: {
    label: 'Revise goal target',
    effect: 'Setting a new target amount or date restores a current contribution plan.',
    observation: 'A goal is overdue and still has a funding gap.',
  },
  contribute_to_goal: {
    label: 'Contribute to goal',
    effect: 'Recording a contribution reduces the goal funding gap.',
    observation: 'A goal still has a funding gap.',
  },
  settle_trip_balance: {
    label: 'Settle trip balance',
    effect: 'Recording the proposed settlement clears the current trip balance.',
    observation: 'A trip has an unsettled balance.',
  },
});

/** The only variant of a fixed effect: bills that equal pay leave no shortfall to reduce. */
const BILLS_EQUAL_EFFECT = 'Reducing a bill makes part of the current-month salary available to spend or save.';

const GENERIC_COPY: ActionCopy = {
  label: 'Review this item',
  effect: 'Reviewing it keeps your plan accurate.',
  observation: 'This item needs your attention.',
};

/** Text between curly or straight double quotes is something the user typed, such as a goal name. */
const USER_TEXT = /“[^”]*”|"[^"]*"/g;
const INTERNAL_IDENTIFIER = [
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/, // snake_case, such as contribute_to_goal
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, // CONSTANT_CASE
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/, // camelCase, such as recordId
  /\b[a-z][a-z-]*:[a-z0-9_-]+(?::[a-z0-9_-]+)+\b/, // record references, such as action:goal:7
  /\b(?:record|goal|trip|expense|bill|action|user)\s*(?:id|key|type)\b\s*[:=#]?\s*\d*/i, // "recordId 7", "action key"
  /(?:^|\s)(?:id|ids)\s*[:=#]\s*\d+/i, // "id: 7"
  /\bundefined\b|\bnull\b|\[object /i,
];

/** True when the text contains no internal identifier outside of text the user typed. */
export function isPlainLanguage(text: string | undefined | null): text is string {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  const outsideUserText = text.replace(USER_TEXT, ' ');
  return !INTERNAL_IDENTIFIER.some((pattern) => pattern.test(outsideUserText));
}

function copyFor(insight: ActionableInsight): ActionCopy {
  return isClarityActionKey(insight.actionKey) ? ACTION_COPY[insight.actionKey] : GENERIC_COPY;
}

/** Server text when it is plain language, otherwise the fixed copy. */
export function plainOr(text: string | undefined | null, fixed: string): string {
  return isPlainLanguage(text) ? text : fixed;
}

export function actionLabelText(insight: ActionableInsight): string {
  return plainOr(insight.actionLabel, copyFor(insight).label);
}

export function actionEffectText(insight: ActionableInsight): string {
  const copy = copyFor(insight);
  const fixed = insight.actionKey === 'review_bills' && insight.conditionCode === 'bills_equal_salary'
    ? BILLS_EQUAL_EFFECT
    : copy.effect;
  return plainOr(insight.expectedEffect, fixed);
}

export function actionObservationText(insight: ActionableInsight): string {
  return plainOr(insight.observation, copyFor(insight).observation);
}
