// Fixed plain-language labels for the server's fixed data-use notice keys.
// The server sends stable keys; this file turns them into reader-facing text.
// Unknown keys fall back to a readable form of the key, rendered as plain text.

import type { DataUseNoticeContent } from './settings';

function humanize(key: string): string {
  const text = key.replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

function lookup(table: Readonly<Record<string, string>>, key: string): string {
  return (Object.hasOwn(table, key) ? table[key] : undefined) ?? humanize(key);
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  salary: 'Salary',
  bills: 'Bills',
  expenses: 'Expenses',
  goals: 'Savings goals',
  trips: 'Trips',
  journey_state: 'Guided journey progress',
  change_receipts: 'Change receipts',
  sharing_settings: 'Sharing settings',
  product_analytics: 'Product Analytics (optional)',
  // Notice version 2, shown only while the server's Quick Add flag is on.
  category_memory: 'Remembered category choices',
};

export interface OutcomeLabel {
  label: string;
  /** Plain-language definition shown at the first point of use (Requirement 12.10). */
  definition: string;
}

const OUTCOME_LABELS: Readonly<Record<string, OutcomeLabel>> = {
  disposable_income: { label: 'Disposable income', definition: 'the pay left after your monthly bills' },
  needs_budget: { label: 'Needs budget', definition: 'the part of that money set aside for essentials' },
  wants_budget: { label: 'Wants budget', definition: 'the part set aside for things you choose but could skip' },
  savings_target: { label: 'Savings target', definition: 'the part set aside to save' },
  spendable_budget: { label: 'Spendable budget', definition: 'what you can spend this month, needs plus wants' },
  daily_spending_guide: { label: 'Daily spending guide', definition: 'what is left to spend, divided by the days left this month' },
  projected_savings: { label: 'Projected savings', definition: 'what you are on track to save this month' },
  goal_feasibility: { label: 'Goal feasibility', definition: 'whether a goal fits inside your savings target' },
  category_total: { label: 'Category total', definition: 'what you spent in one spending category this month' },
  remaining_spendable_budget: { label: 'Remaining spendable budget', definition: 'your spendable budget minus what you have spent' },
  goal_funding_gap: { label: 'Goal funding gap', definition: 'the amount still needed to reach a goal' },
  required_goal_contribution: { label: 'Required goal contribution', definition: 'the amount to add each month to reach a goal on time' },
  member_balance: { label: 'Trip member balance', definition: 'what each trip member owes or is owed' },
  trip_settlement: { label: 'Trip settlement', definition: 'the payments that clear every trip balance' },
  first_meaningful_outcome: { label: 'First personal result', definition: 'the first result calculated from your own entries' },
  confirmed_financial_change: { label: 'Confirmed change record', definition: 'a record that a saved edit was applied once' },
  public_trip_view: { label: 'Public trip view', definition: 'the trip fields visible to people with a public link you create' },
  aggregate_product_clarity_metrics: { label: 'Combined product metrics', definition: 'counts that show whether the product is clear, without your values' },
  // Notice version 2 (Quick Add).
  category_suggestion: { label: 'Category suggestion', definition: 'the category Quick Add proposes for a note you have typed before' },
  today_allowance: { label: 'Today\'s allowance', definition: 'what you can spend today, leaving out any expense you mark as not counted in the daily allowance' },
};

const ACCESS_ROLE_LABELS: Readonly<Record<string, string>> = {
  account_user: 'You, the account owner',
  authorized_administrators: 'Authorized Project Money administrators, where admin tools allow it',
  service_operators_and_processors: 'Service operators and hosting providers that run Project Money',
  accepted_trip_members_for_shared_trip_fields: 'Accepted trip members, for shared trip fields only',
  confirmed_public_link_viewers_for_disclosed_trip_fields:
    'People with a public trip link you confirmed, for the disclosed trip fields only',
  authorized_product_analytics_operators_and_processors: 'Authorized analytics operators and providers',
};

const SHARING_LABELS: Readonly<Record<string, string>> = {
  private: 'Private to you',
  private_until_separate_public_sharing_confirmation:
    'Private until you separately confirm a public link',
  public_trip_sharing_disabled_by_default: 'Public trip sharing stays off until you confirm it',
  disabled_by_default_and_not_public: 'Off by default and never public',
  disabled: 'Off until you confirm a public link',
};

const RETENTION_LABELS: Readonly<Record<string, string>> = {
  until_account_deletion: 'Kept until you delete your account',
  until_account_deletion_or_private_trip_removal: 'Kept until you delete your account or remove the trip',
  until_account_deletion_or_sharing_revocation: 'Kept until you delete your account or revoke sharing',
  until_account_deletion_or_the_published_operational_retention_period:
    'Kept until you delete your account or the published retention period ends',
};

const PROHIBITED_FIELD_LABELS: Readonly<Record<string, string>> = {
  financial_amounts: 'financial amounts',
  user_entered_names: 'names you type',
  free_text_notes: 'free-text notes',
  trip_member_identities: 'trip member identities',
  trip_names: 'trip names',
};

export const categoryLabel = (key: string): string => lookup(CATEGORY_LABELS, key);
export const accessRoleLabel = (key: string): string => lookup(ACCESS_ROLE_LABELS, key);
export const sharingLabel = (key: string): string => lookup(SHARING_LABELS, key);
export const retentionLabel = (key: string): string => lookup(RETENTION_LABELS, key);
export const prohibitedFieldLabel = (key: string): string => lookup(PROHIBITED_FIELD_LABELS, key).toLowerCase();

export function outcomeLabel(key: string): OutcomeLabel {
  return (Object.hasOwn(OUTCOME_LABELS, key) ? OUTCOME_LABELS[key] : undefined)
    ?? { label: humanize(key), definition: '' };
}

/** Short plain-language summary of a data-use notice, one sentence group per topic. */
export interface NoticeSummary {
  categoriesSentence: string;
  sharingSentence: string;
  retentionSentence: string;
  controlsSentence: string;
}

/**
 * Builds the short summary shown above the full notice. It uses only the notice's
 * own categories, sharing defaults, retention keys, and controls, run through the
 * same label lookups `DataUseNotice` uses, so it adds no claim the full notice lacks.
 */
export function summarizeNotice(notice: DataUseNoticeContent): NoticeSummary {
  const { categories, sharingDefaults, controls } = notice;

  const categoriesSentence = categories.length
    ? `What we keep: ${categories.map((category) => categoryLabel(category.key)).join(', ')}.`
    : '';

  const sharingParts = [
    `Your financial data: ${sharingLabel(sharingDefaults.financialData).toLowerCase()}.`,
    `Public trip links: ${sharingLabel(sharingDefaults.publicTripLinks).toLowerCase()}.`,
  ];
  if (sharingDefaults.publicTripConfirmationRequired) {
    sharingParts.push('A separate confirmation is required before any public trip link exists.');
  }

  const retentionLabels = [...new Set(categories.map((category) => retentionLabel(category.retention)))];
  const retentionSentence = retentionLabels.length ? `How long: ${retentionLabels.join('; ')}.` : '';

  const available: string[] = [];
  const unavailable: string[] = [];
  if (controls.correction.available) available.push('correct records'); else unavailable.push('Correction');
  if (controls.export.available) available.push('export your data'); else unavailable.push('Export');
  if (controls.deletion.available) available.push('delete your account and data'); else unavailable.push('Deletion');
  const analytics = controls.productAnalytics;
  const controlsParts: string[] = [];
  if (available.length) controlsParts.push(`Your controls: ${available.join(', ')}.`);
  if (unavailable.length) {
    controlsParts.push(`${unavailable.join(' and ')} ${unavailable.length > 1 ? 'are' : 'is'} not available right now.`);
  }
  controlsParts.push(
    analytics.available
      ? `Product Analytics is optional and ${analytics.enabledByDefault ? 'on' : 'off'} by default.${analytics.canDisable ? ' You can turn it off at any time.' : ''}`
      : 'Product Analytics is not available right now.',
  );

  return {
    categoriesSentence,
    sharingSentence: sharingParts.join(' '),
    retentionSentence,
    controlsSentence: controlsParts.join(' '),
  };
}
