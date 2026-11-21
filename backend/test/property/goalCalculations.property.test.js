import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  GOAL_FEASIBILITY,
  GOAL_STATUSES,
  calculateGoal,
  validateGoalDraft,
} from '../../src/domain/goals.js';

const NUM_RUNS = 150;
const MAX_GENERATED_TARGET_MINOR = Number.MAX_SAFE_INTEGER;

function formatPart(value) {
  return String(value).padStart(2, '0');
}

function referenceIsLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function referenceDaysInMonth(year, month) {
  if (month === 2) return referenceIsLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatCalendarDate({ year, month, day }) {
  return `${year}-${formatPart(month)}-${formatPart(day)}`;
}

function referenceAddMonths({ year, month }, monthOffset) {
  const zeroBasedMonth = year * 12 + month - 1 + monthOffset;
  return {
    year: Math.floor(zeroBasedMonth / 12),
    month: (zeroBasedMonth % 12) + 1,
  };
}

function referencePreviousDate({ year, month, day }) {
  if (day > 1) return { year, month, day: day - 1 };
  if (month > 1) {
    const previousMonth = month - 1;
    return {
      year,
      month: previousMonth,
      day: referenceDaysInMonth(year, previousMonth),
    };
  }
  return { year: year - 1, month: 12, day: 31 };
}

function referenceMonthlyOpportunities(current, target) {
  return (target.year - current.year) * 12 + target.month - current.month + 1;
}

function referenceCeilingDivision(dividend, divisor) {
  return Number(
    (BigInt(dividend) + BigInt(divisor) - 1n) / BigInt(divisor)
  );
}

function boundaryIntegerArbitrary(min, max) {
  if (min === max) return fc.constant(min);
  return fc.oneof(
    fc.constant(min),
    fc.constant(max),
    fc.integer({ min, max })
  );
}

const goalNameArbitrary = fc
  .tuple(
    fc.constantFrom('', ' ', '\t', '\n '),
    fc.array(fc.constantFrom('a', 'Z', '0', '-', '_', '₹', '目'), { maxLength: 24 }),
    fc.constantFrom('G', 'Goal', 'लक्ष्य', '目標'),
    fc.constantFrom('', ' ', '\t', ' \n')
  )
  .map(([prefixWhitespace, characters, requiredText, suffixWhitespace]) => (
    `${prefixWhitespace}${characters.join('')}${requiredText}${suffixWhitespace}`
  ));

const localCalendarArbitrary = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ year, month }) => boundaryIntegerArbitrary(
    1,
    referenceDaysInMonth(year, month)
  ).map((day) => ({ year, month, day })));

const targetAmountArbitrary = fc.oneof(
  fc.constant(1),
  fc.constant(MAX_GENERATED_TARGET_MINOR),
  fc.integer({ min: 1, max: 1_000_000_000_000 })
);

const futureMonthOffsetArbitrary = fc.oneof(
  fc.constant(0),
  fc.constant(1),
  fc.constant(11),
  fc.constant(12),
  fc.constant(120),
  fc.integer({ min: 0, max: 120 })
);

const goalScenarioArbitrary = localCalendarArbitrary.chain((localCalendar) => fc
  .tuple(goalNameArbitrary, targetAmountArbitrary, futureMonthOffsetArbitrary)
  .chain(([name, targetAmountMinor, monthOffset]) => {
    const targetMonth = referenceAddMonths(localCalendar, monthOffset);
    const minimumTargetDay = monthOffset === 0 ? localCalendar.day : 1;
    const maximumTargetDay = referenceDaysInMonth(targetMonth.year, targetMonth.month);

    return fc.tuple(
      boundaryIntegerArbitrary(minimumTargetDay, maximumTargetDay),
      boundaryIntegerArbitrary(0, targetAmountMinor - 1)
    ).map(([targetDay, savedAmountMinor]) => ({
      name,
      targetAmountMinor,
      savedAmountMinor,
      localCalendar,
      targetCalendar: { ...targetMonth, day: targetDay },
    }));
  }));

function assertValidActiveGoal({ goal, localCalendar, targetCalendar }) {
  const localDate = formatCalendarDate(localCalendar);
  const validation = validateGoalDraft({ draft: goal, localDate });
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);

  const result = calculateGoal({ goal, localDate });
  const expectedGapMinor = goal.targetAmountMinor - goal.savedAmountMinor;
  const expectedOpportunities = referenceMonthlyOpportunities(
    localCalendar,
    targetCalendar
  );
  const expectedRequiredContributionMinor = referenceCeilingDivision(
    expectedGapMinor,
    expectedOpportunities
  );
  const expectedRoundingDirection = expectedGapMinor % expectedOpportunities === 0
    ? 'exact'
    : 'up';

  assert.equal(result.status, GOAL_STATUSES.ACTIVE);
  assert.equal(result.fundingGapMinor, expectedGapMinor);
  assert.equal(result.contributionOpportunities, expectedOpportunities);
  assert.equal(
    result.requiredContributionMinor,
    expectedRequiredContributionMinor
  );
  assert.deepEqual(result.rounding.requiredContribution, {
    precisionMinor: 1,
    direction: expectedRoundingDirection,
    adjustmentMinor: 0,
  });
}

// Feature: financial-clarity-experience, Property 8: Goal gap, opportunities, and required contribution are valid
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.19, 6.20**
test('Property 8: goal gap, opportunities, and required contribution are valid', () => {
  fc.assert(
    fc.property(goalScenarioArbitrary, (scenario) => {
      const {
        name,
        targetAmountMinor,
        savedAmountMinor,
        localCalendar,
        targetCalendar,
      } = scenario;
      const localDate = formatCalendarDate(localCalendar);
      const targetDate = formatCalendarDate(targetCalendar);
      const activeGoal = {
        id: 8,
        name,
        targetAmountMinor,
        savedAmountMinor,
        targetDate,
      };

      assertValidActiveGoal({ activeGoal, goal: activeGoal, localCalendar, targetCalendar });

      const dueTodayGoal = { ...activeGoal, targetDate: localDate };
      assertValidActiveGoal({
        goal: dueTodayGoal,
        localCalendar,
        targetCalendar: localCalendar,
      });

      const zeroSavedGoal = { ...activeGoal, savedAmountMinor: 0 };
      assertValidActiveGoal({
        goal: zeroSavedGoal,
        localCalendar,
        targetCalendar,
      });

      const fundedGoal = { ...activeGoal, savedAmountMinor: targetAmountMinor };
      const fundedValidation = validateGoalDraft({ draft: fundedGoal, localDate });
      assert.equal(fundedValidation.valid, true);
      assert.deepEqual(fundedValidation.errors, []);

      const funded = calculateGoal({ goal: fundedGoal, localDate });
      assert.equal(funded.status, GOAL_STATUSES.FUNDED);
      assert.equal(funded.fundingGapMinor, 0);
      assert.equal(
        funded.contributionOpportunities,
        referenceMonthlyOpportunities(localCalendar, targetCalendar)
      );
      assert.equal(funded.requiredContributionMinor, 0);
      assert.equal(funded.feasibility, GOAL_FEASIBILITY.FUNDED);

      const overdueTarget = referencePreviousDate(localCalendar);
      const overdue = calculateGoal({
        goal: {
          ...activeGoal,
          targetDate: formatCalendarDate(overdueTarget),
        },
        localDate,
      });
      assert.equal(overdue.status, GOAL_STATUSES.OVERDUE);
      assert.equal(
        overdue.fundingGapMinor,
        targetAmountMinor - savedAmountMinor
      );
      assert.equal(overdue.contributionOpportunities, 0);
      assert.equal(overdue.requiredContributionMinor, null);
      assert.equal(overdue.feasibility, GOAL_FEASIBILITY.OVERDUE);
      assert.deepEqual(overdue.revisionRequest, {
        fields: ['targetAmountMinor', 'targetDate'],
        action: 'revise_target_amount_or_date',
      });
    }),
    { numRuns: NUM_RUNS }
  );
});
