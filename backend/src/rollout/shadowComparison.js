import { operationalLogger } from '../observability/operationalLog.js';

const PLAN_COMPARISONS = Object.freeze([
  ['PLAN_INCOME_MISMATCH', (canonical, legacy) => canonical.incomeMinor === legacy.incomeMinor],
  ['PLAN_FIXED_TOTAL_MISMATCH', (canonical, legacy) => canonical.fixedMinor === legacy.fixedMinor],
  ['PLAN_DISPOSABLE_MISMATCH', (canonical, legacy) => canonical.disposableMinor === legacy.disposableMinor],
  ['PLAN_NEEDS_BUDGET_MISMATCH', (canonical, legacy) => canonical.needsMinor === legacy.needsMinor],
  ['PLAN_WANTS_BUDGET_MISMATCH', (canonical, legacy) => canonical.wantsMinor === legacy.wantsMinor],
  ['PLAN_SAVINGS_TARGET_MISMATCH', (canonical, legacy) => canonical.savingsMinor === legacy.savingsMinor],
  ['PLAN_SPENDING_TOTAL_MISMATCH', (canonical, legacy) => canonical.spentMinor === legacy.spentMinor],
  ['PLAN_CATEGORY_TOTALS_MISMATCH', (canonical, legacy) => canonical.categories === legacy.categories],
]);

const MISMATCH_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function toMinor(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function canonicalAmount(value) {
  return Number.isSafeInteger(value?.amountMinor) ? value.amountMinor : null;
}

function serializedCategories(entries) {
  return JSON.stringify(entries
    .map(([category, amountMinor]) => [String(category), amountMinor])
    .toSorted(([left], [right]) => left.localeCompare(right, 'en-IN')));
}

function canonicalPlanShape(snapshot) {
  const monthly = snapshot?.outcomes?.monthlyPlan;
  const spending = snapshot?.outcomes?.spending;
  const categoryTotals = spending?.value?.categoryTotals;
  if (monthly?.status !== 'available' || spending?.status !== 'available' || !Array.isArray(categoryTotals)) {
    return null;
  }

  return {
    incomeMinor: canonicalAmount(monthly.value?.salary),
    fixedMinor: canonicalAmount(monthly.value?.activeBillsTotal),
    disposableMinor: canonicalAmount(monthly.value?.disposableIncome),
    needsMinor: canonicalAmount(monthly.value?.needsBudget),
    wantsMinor: canonicalAmount(monthly.value?.wantsBudget),
    savingsMinor: canonicalAmount(monthly.value?.savingsTarget),
    spentMinor: canonicalAmount(spending.value?.totalSpending),
    categories: serializedCategories(categoryTotals.map((entry) => [
      entry?.category,
      canonicalAmount(entry?.total),
    ])),
  };
}

function legacyPlanShape(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const categories = plan.byCategory && typeof plan.byCategory === 'object'
    ? Object.entries(plan.byCategory).map(([category, amount]) => [category, toMinor(amount)])
    : [];

  return {
    incomeMinor: toMinor(plan.income),
    fixedMinor: toMinor(plan.emiTotal),
    disposableMinor: toMinor(plan.afterFixed),
    needsMinor: toMinor(plan.breakdown?.needs),
    wantsMinor: toMinor(plan.breakdown?.wants),
    savingsMinor: toMinor(plan.breakdown?.save),
    spentMinor: toMinor(plan.spentThisMonth),
    categories: serializedCategories(categories),
  };
}

export function planMismatchCodes(canonicalSnapshot, legacyPlan) {
  const canonical = canonicalPlanShape(canonicalSnapshot);
  const legacy = legacyPlanShape(legacyPlan);
  if (!canonical) return Object.freeze(['PLAN_CANONICAL_UNAVAILABLE']);
  if (!legacy) return Object.freeze(['PLAN_LEGACY_UNAVAILABLE']);

  return Object.freeze(PLAN_COMPARISONS.flatMap(([code, matches]) => (
    matches(canonical, legacy) ? [] : [code]
  )));
}

/**
 * Shadow logs contain an allowlisted mismatch code and no compared values,
 * identifiers, request data, or record contents. Without an injected `log`
 * function each code is written as a `SHADOW_MISMATCH` operational event; an
 * injected function receives the fixed `[clarity-shadow] code=...` line.
 */
export function logShadowMismatchCodes(codes, log) {
  if (!Array.isArray(codes)) throw new TypeError('codes must be an array.');
  if (log !== undefined && typeof log !== 'function') throw new TypeError('log must be a function.');

  for (const code of codes) {
    if (typeof code !== 'string' || !MISMATCH_CODE_PATTERN.test(code)) {
      throw new TypeError('Mismatch codes must contain uppercase letters, digits, and underscores only.');
    }
    if (log) log(`[clarity-shadow] code=${code}`);
    else operationalLogger.warn({ event: 'SHADOW_MISMATCH', code });
  }
}
