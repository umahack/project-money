import { calculateExpenseSummary } from '../domain/expenses.js';
import { calculateGoal } from '../domain/goals.js';
import {
  FINANCIAL_CLARITY_TIME_ZONE,
  calculateMonthlyPlan,
} from '../domain/monthlyPlan.js';
import { calculateTripOutcome } from '../domain/trips.js';
import {
  buildActionSummary,
  selectHighestUrgencyGoal,
  selectNearestTripSettlement,
} from '../domain/insights.js';
import {
  OUTCOME_STATUSES,
  VALUE_CLASSIFICATIONS,
  createAuthorizedSourceAccess,
  createAvailableOutcome,
  createCalculationExplanation,
  createCalculationFailedOutcome,
  createDependentOutcome,
  createInvalidOutcome,
} from '../domain/outcomes.js';
import { createRoundingMetadata, sumPaise } from '../domain/money.js';
import { reportCalculationFailures } from '../observability/operationalLog.js';
import { assertMonth, assertPositiveId } from '../repositories/repositorySupport.js';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
let defaultRepositoryPromise;

function loadDefaultRepository() {
  defaultRepositoryPromise ??= import('../repositories/financialRepository.js')
    .then(({ default: repository }) => repository);
  return defaultRepositoryPromise;
}

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function.`);
  return value;
}

function assertRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('repository must be an object.');
  }
  for (const method of [
    'loadPeriod',
    'loadGoals',
    'listAccessibleTrips',
    'loadAccessibleTripLedger',
    'getDataVersion',
  ]) {
    assertFunction(repository[method], `repository.${method}`);
  }
  return repository;
}

function assertNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date.');
  }
  return now;
}

function assertTimeZone(timeZone) {
  if (timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
    throw new RangeError(`timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
  }
  return timeZone;
}

function assertExpectedVersion(expectedVersion) {
  if (
    expectedVersion !== undefined
    && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    throw new TypeError('expectedVersion must be a non-negative safe integer when provided.');
  }
  return expectedVersion;
}

function explanationMonth(outcomeId, now, timeZone) {
  if (typeof outcomeId !== 'string' || outcomeId.trim() !== outcomeId) {
    throw new TypeError('outcomeId must identify a supported outcome.');
  }

  const periodOutcome = /^(?:monthly-plan|spending|trip-summary):(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(
    outcomeId
  );
  if (periodOutcome) return assertMonth(periodOutcome[1], 'outcome month');

  const recordOutcome = /^(?:goal|trip):([1-9]\d*)$/.exec(outcomeId);
  if (recordOutcome && Number.isSafeInteger(Number(recordOutcome[1]))) {
    return localDateForInstant(now, timeZone).slice(0, 7);
  }

  throw new TypeError('outcomeId must identify a supported outcome.');
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, monthNumber) {
  if (monthNumber === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

function nextMonth(month) {
  const match = MONTH_PATTERN.exec(month);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year === 9999 && monthNumber === 12) {
    throw new RangeError('month must have a representable following month.');
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonthNumber).padStart(2, '0')}`;
}

function localDateForInstant(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function buildPeriod(month, now, timeZone) {
  const currentLocalDate = localDateForInstant(now, timeZone);
  const currentMonth = currentLocalDate.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = daysInMonth(year, monthNumber);
  const asOfDate = month === currentMonth
    ? currentLocalDate
    : month < currentMonth
      ? `${month}-${String(lastDay).padStart(2, '0')}`
      : `${month}-01`;
  const asOfDay = Number(asOfDate.slice(8, 10));

  return {
    month,
    timeZone,
    start: `${month}-01`,
    endExclusive: `${nextMonth(month)}-01`,
    asOfDate,
    daysRemainingInclusive: lastDay - asOfDay + 1,
  };
}

function requireConfirmedRecord(value, label) {
  if (
    !value
    || value.status !== 'confirmed'
    || typeof value.empty !== 'boolean'
    || (value.empty ? value.record !== null : !value.record)
  ) {
    throw new TypeError(`${label} must be a confirmed repository record.`);
  }
  return value;
}

function requireConfirmedCollection(value, label) {
  if (
    !value
    || value.status !== 'confirmed'
    || typeof value.empty !== 'boolean'
    || !Array.isArray(value.records)
    || value.empty !== (value.records.length === 0)
  ) {
    throw new TypeError(`${label} must be a confirmed repository collection.`);
  }
  return value;
}

function requirePeriodLoad(value, month) {
  if (!value || value.status !== 'confirmed' || value.month !== month) {
    throw new TypeError('loadPeriod must return the requested confirmed period.');
  }
  return {
    ...value,
    salary: requireConfirmedRecord(value.salary, 'period.salary'),
    bills: requireConfirmedCollection(value.bills, 'period.bills'),
    expenses: requireConfirmedCollection(value.expenses, 'period.expenses'),
    categoryTreatments: requireConfirmedCollection(
      value.categoryTreatments,
      'period.categoryTreatments'
    ),
  };
}

function requireTripLedger(value, tripId) {
  if (!value || value.status !== 'confirmed' || value.trip?.id !== tripId) {
    throw new TypeError('loadAccessibleTripLedger must return the requested confirmed trip.');
  }
  return {
    ...value,
    members: requireConfirmedCollection(value.members, 'trip.members'),
    expenses: requireConfirmedCollection(value.expenses, 'trip.expenses'),
  };
}

function loadAndValidate(load, validate) {
  return Promise.resolve().then(load).then(validate);
}

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function recordTimestamp(record) {
  return record.confirmedAt ?? record.updatedAt ?? record.createdAt;
}

function sourceRef({ sourceType, record, field, label, value, period }) {
  return {
    ref: `${sourceType}:${record.id}:${field}`,
    sourceType,
    recordId: record.id,
    field,
    label,
    value,
    ...(recordTimestamp(record) === undefined
      ? {}
      : { confirmedAt: recordTimestamp(record) }),
    ...(period === undefined ? {} : { period }),
  };
}

function validMoneySource({ sourceType, record, field, label, period }) {
  const amountMinor = record[field];
  if (!Number.isSafeInteger(amountMinor)) return null;
  return sourceRef({
    sourceType,
    record,
    field,
    label,
    value: money(amountMinor),
    period,
  });
}

function periodSourceRefs(periodData, month) {
  if (!periodData) return [];
  const refs = [];
  const salary = periodData.salary.record;
  if (salary) {
    const ref = validMoneySource({
      sourceType: 'salary',
      record: salary,
      field: 'amountMinor',
      label: `Salary for ${month}`,
      period: { month },
    });
    if (ref) refs.push(ref);
  }
  for (const bill of periodData.bills.records) {
    const ref = validMoneySource({
      sourceType: 'bill',
      record: bill,
      field: 'amountMinor',
      label: bill.label || `Bill ${bill.id}`,
      period: {
        month,
        effectiveFromMonth: bill.effectiveFromMonth ?? null,
        effectiveToMonth: bill.effectiveToMonth ?? null,
      },
    });
    if (ref) refs.push(ref);
  }
  for (const expense of periodData.expenses.records) {
    const ref = validMoneySource({
      sourceType: 'expense',
      record: expense,
      field: 'amountMinor',
      label: `Expense ${expense.id}`,
      period: { month },
    });
    if (ref) refs.push(ref);
  }
  for (const treatment of periodData.categoryTreatments.records) {
    refs.push(sourceRef({
      sourceType: 'category_treatment',
      record: treatment,
      field: 'treatment',
      label: `${treatment.category} category treatment`,
      value: treatment.treatment,
      period: { month },
    }));
  }
  return refs;
}

function goalSourceRefs(goal) {
  const refs = [];
  const target = validMoneySource({
    sourceType: 'goal',
    record: goal,
    field: 'targetAmountMinor',
    label: `${goal.name || `Goal ${goal.id}`} target amount`,
  });
  const saved = validMoneySource({
    sourceType: 'goal',
    record: goal,
    field: 'savedAmountMinor',
    label: `${goal.name || `Goal ${goal.id}`} saved amount`,
  });
  if (target) refs.push(target);
  if (saved) refs.push(saved);
  if (typeof goal.targetDate === 'string') {
    refs.push(sourceRef({
      sourceType: 'goal',
      record: goal,
      field: 'targetDate',
      label: `${goal.name || `Goal ${goal.id}`} target date`,
      value: goal.targetDate,
    }));
  }
  return refs;
}

function tripSourceRefs(ledger) {
  return ledger.expenses.records.flatMap((record) => {
    const amount = validMoneySource({
      sourceType: record.description?.startsWith('SETTLEMENT:')
        ? 'trip_settlement'
        : 'trip_expense',
      record,
      field: 'amountMinor',
      label: `Trip record ${record.id}`,
    });
    return amount ? [amount] : [];
  });
}

function deduplicateSources(sourceRefs) {
  const byRef = new Map();
  for (const source of sourceRefs) {
    if (!byRef.has(source.ref)) byRef.set(source.ref, source);
  }
  return [...byRef.values()].map((source, index) => ({
    ...source,
    order: index + 1,
  }));
}

function firstNormalizationIssue(records, inputPrefix) {
  for (const record of records) {
    const issue = record.normalizationIssues?.[0];
    if (issue) {
      return {
        status: OUTCOME_STATUSES.INVALID_INPUT,
        input: `${inputPrefix}:${record.id}.${issue.field}`,
        constraint: 'a value representable as a safe integer number of paise',
      };
    }
  }
  return null;
}

function monthlyDependencies(periodData, periodRefs) {
  const salary = periodData.salary.record;
  const salaryRefs = periodRefs.filter(({ sourceType }) => sourceType === 'salary');
  const billRefs = periodRefs.filter(({ sourceType }) => sourceType === 'bill');
  const expenseRefs = periodRefs.filter(({ sourceType }) => sourceType === 'expense');
  const treatmentRefs = periodRefs.filter(
    ({ sourceType }) => sourceType === 'category_treatment'
  );
  const salaryIssue = salary ? firstNormalizationIssue([salary], 'salary') : null;
  const billIssue = firstNormalizationIssue(periodData.bills.records, 'bill');
  const expenseIssue = firstNormalizationIssue(periodData.expenses.records, 'expense');

  return [
    salaryIssue ?? (salary
      ? { status: OUTCOME_STATUSES.AVAILABLE, input: 'salary', sourceRefs: salaryRefs }
      : {
          status: OUTCOME_STATUSES.MISSING_INPUT,
          input: 'salary',
          unlocks: ['monthly_plan', 'spending'],
        }),
    billIssue ?? {
      status: OUTCOME_STATUSES.AVAILABLE,
      input: 'bills',
      sourceRefs: billRefs,
    },
    expenseIssue ?? {
      status: OUTCOME_STATUSES.AVAILABLE,
      input: 'expenses',
      sourceRefs: expenseRefs,
    },
    {
      status: OUTCOME_STATUSES.AVAILABLE,
      input: 'category_treatments',
      sourceRefs: treatmentRefs,
    },
  ];
}

function monthlyValue(result) {
  return {
    salary: money(result.salaryMinor),
    activeBillsTotal: money(result.activeBillsTotalMinor),
    shortfall: money(result.shortfallMinor),
    disposableIncome: money(result.disposableIncomeMinor),
    needsBudget: money(result.needsBudgetMinor),
    wantsBudget: money(result.wantsBudgetMinor),
    savingsTarget: money(result.savingsTargetMinor),
    spendableBudget: money(result.spendableBudgetMinor),
    needsSpent: money(result.needsSpentMinor),
    wantsSpent: money(result.wantsSpentMinor),
    remainingSpendable: money(result.remainingSpendableMinor),
    dailySpendingGuide: money(result.dailySpendingGuideMinor),
    projectedSavings: money(result.projectedSavingsMinor),
  };
}

function spendingValue(plan, summary) {
  const projectedSavingsDifferenceMinor = sumPaise([
    summary.projectedSavingsMinor,
    -plan.savingsTargetMinor,
  ], { label: 'projected savings difference' });
  return {
    month: summary.month,
    categoryTotals: summary.categoryTotals.map((total) => ({
      month: total.month,
      category: total.category,
      total: money(total.totalMinor),
      expenseIds: [...total.expenseIds],
    })),
    appliedTreatments: structuredClone(summary.appliedTreatments),
    needsBudget: money(plan.needsBudgetMinor),
    wantsBudget: money(plan.wantsBudgetMinor),
    needsSpent: money(summary.needsSpentMinor),
    wantsSpent: money(summary.wantsSpentMinor),
    totalSpending: money(summary.totalSpendingMinor),
    spendableBudget: money(summary.spendableBudgetMinor),
    remainingSpendable: money(summary.remainingSpendableMinor),
    dailySpendingGuide: money(plan.dailySpendingGuideMinor),
    savingsTarget: money(plan.savingsTargetMinor),
    projectedSavings: money(summary.projectedSavingsMinor),
    projectedSavingsDifference: money(projectedSavingsDifferenceMinor),
    exceededBudgetActions: structuredClone(summary.exceededBucketActions),
  };
}

function goalIssue(goal) {
  const normalized = firstNormalizationIssue([goal], 'goal');
  if (normalized) return normalized;
  if (typeof goal.name !== 'string' || goal.name.normalize('NFKC').trim() === '') {
    return {
      status: OUTCOME_STATUSES.INVALID_INPUT,
      input: `goal:${goal.id}.name`,
      constraint: 'at least one non-whitespace character',
    };
  }
  if (!Number.isSafeInteger(goal.targetAmountMinor) || goal.targetAmountMinor <= 0) {
    return {
      status: OUTCOME_STATUSES.INVALID_INPUT,
      input: `goal:${goal.id}.targetAmountMinor`,
      constraint: 'a positive safe integer number of paise',
    };
  }
  if (
    !Number.isSafeInteger(goal.savedAmountMinor)
    || goal.savedAmountMinor < 0
    || goal.savedAmountMinor > goal.targetAmountMinor
  ) {
    return {
      status: OUTCOME_STATUSES.INVALID_INPUT,
      input: `goal:${goal.id}.savedAmountMinor`,
      constraint: `from 0 through ${goal.targetAmountMinor} paise, inclusive`,
    };
  }
  const match = typeof goal.targetDate === 'string' ? DATE_PATTERN.exec(goal.targetDate) : null;
  if (!match || Number(match[3]) > daysInMonth(Number(match[1]), Number(match[2]))) {
    return {
      status: OUTCOME_STATUSES.INVALID_INPUT,
      input: `goal:${goal.id}.targetDate`,
      constraint: 'a valid YYYY-MM-DD calendar date',
    };
  }
  return null;
}

function goalValue(result) {
  return {
    goalId: result.goalId,
    status: result.status,
    fundingGap: money(result.fundingGapMinor),
    contributionOpportunities: result.contributionOpportunities,
    requiredContribution: result.requiredContributionMinor === null
      ? null
      : money(result.requiredContributionMinor),
    feasibility: result.feasibility,
    capacityDifference: result.capacityDifferenceMinor === null
      ? null
      : money(result.capacityDifferenceMinor),
    missingPlanInput: result.missingPlanInput,
    ...(result.revision
      ? { revision: { targetAmount: money(result.revision.targetAmountMinor) } }
      : {}),
    ...(result.revisionRequest ? { revisionRequest: structuredClone(result.revisionRequest) } : {}),
  };
}

function goalOperations(goal, result, refs) {
  const targetRef = refs.find(({ field }) => field === 'targetAmountMinor')?.ref;
  const savedRef = refs.find(({ field }) => field === 'savedAmountMinor')?.ref;
  const operations = [{
    order: 1,
    stage: 'funding_gap',
    operation: 'subtract',
    operandRefs: [targetRef, savedRef].filter(Boolean),
    result: money(result.fundingGapMinor),
    explanationKey: 'goal.funding_gap',
  }];
  if (result.requiredContributionMinor !== null) {
    operations.push({
      order: operations.length + 1,
      stage: 'required_contribution',
      operation: 'ceil',
      operandRefs: ['result:funding_gap', 'result:contribution_opportunities'],
      divisor: result.contributionOpportunities,
      result: money(result.requiredContributionMinor),
      explanationKey: 'goal.required_contribution',
    });
  }
  if (result.capacityDifferenceMinor !== null) {
    operations.push({
      order: operations.length + 1,
      stage: 'feasibility',
      operation: 'subtract',
      operandRefs: ['result:savings_target', 'result:required_contribution'],
      result: money(result.capacityDifferenceMinor),
      explanationKey: 'goal.feasibility_difference',
    });
  }
  return operations;
}

function minorToDecimalString(amountMinor) {
  if (!Number.isSafeInteger(amountMinor)) return null;
  const major = Math.floor(amountMinor / 100);
  const minor = String(amountMinor % 100).padStart(2, '0');
  return `${major}.${minor}`;
}

function calculatorTripRecords(records) {
  return records.map((record) => ({
    ...record,
    amount: minorToDecimalString(record.amountMinor),
  }));
}

function tripValue(result) {
  return {
    tripId: result.value.tripId,
    tripVersion: result.value.tripVersion,
    allocations: result.value.allocations.flatMap((allocation) => (
      allocation.allocations.map((share) => ({
        expenseId: allocation.expenseId,
        memberId: share.memberId,
        amount: money(share.amountMinor),
        roundingAdjustmentMinor: share.roundingAdjustmentMinor,
      }))
    )),
    balances: result.value.balances.map(({ memberId, amountMinor, label }) => ({
      memberId,
      amountMinor,
      label,
    })),
    settlements: result.value.settlements.map(({ fromMemberId, toMemberId, amountMinor }) => ({
      fromMemberId,
      toMemberId,
      amount: money(amountMinor),
    })),
  };
}

function tripRounding(result) {
  const adjustmentMinor = sumPaise(
    result.value.explanation.roundingAdjustments.map((entry) => entry.adjustmentMinor),
    { label: 'trip rounding adjustments' }
  );
  return createRoundingMetadata({
    direction: result.value.explanation.roundingAdjustments.length === 0 ? 'exact' : 'half_up',
    adjustmentMinor,
    adjustmentTarget: 'tripAllocations',
  });
}

function isoInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function earliestTripRecordInstant(records) {
  return records
    .map((record) => isoInstant(recordTimestamp(record)))
    .filter(Boolean)
    .toSorted()[0] ?? null;
}

function failedOutcome({ sourceAccess, id, kind, period, dataVersion, sourceRefs = [] }) {
  return createCalculationFailedOutcome({
    sourceAccess,
    id,
    kind,
    classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
    period,
    dataVersion,
    sourceRefs: deduplicateSources(sourceRefs),
    retryScopeKey: `outcome:${id}`,
  });
}

export class ClarityService {
  #repository;
  #calculateMonthlyPlan;
  #calculateExpenseSummary;
  #calculateGoal;
  #calculateTripOutcome;
  #buildActionSummary;

  constructor({
    repository = null,
    monthlyPlanCalculator = calculateMonthlyPlan,
    expenseSummaryCalculator = calculateExpenseSummary,
    goalCalculator = calculateGoal,
    tripOutcomeCalculator = calculateTripOutcome,
    actionSummaryBuilder = buildActionSummary,
  } = {}) {
    this.#repository = repository === null ? null : assertRepository(repository);
    this.#calculateMonthlyPlan = assertFunction(
      monthlyPlanCalculator,
      'monthlyPlanCalculator'
    );
    this.#calculateExpenseSummary = assertFunction(
      expenseSummaryCalculator,
      'expenseSummaryCalculator'
    );
    this.#calculateGoal = assertFunction(goalCalculator, 'goalCalculator');
    this.#calculateTripOutcome = assertFunction(
      tripOutcomeCalculator,
      'tripOutcomeCalculator'
    );
    this.#buildActionSummary = assertFunction(actionSummaryBuilder, 'actionSummaryBuilder');
  }

  async getSnapshot(input) {
    const { snapshot } = await this.#buildSnapshot(input);
    return snapshot;
  }

  async getExplanation({
    userId,
    outcomeId,
    expectedVersion,
    now,
    timeZone = FINANCIAL_CLARITY_TIME_ZONE,
  }) {
    assertPositiveId(userId, 'userId');
    const generationTime = assertNow(now);
    const configuredTimeZone = assertTimeZone(timeZone);
    const requestedVersion = assertExpectedVersion(expectedVersion);
    const month = explanationMonth(outcomeId, generationTime, configuredTimeZone);
    const { snapshot, explanations } = await this.#buildSnapshot({
      userId,
      month,
      now: generationTime,
      timeZone: configuredTimeZone,
    });
    const explanation = explanations.get(outcomeId);
    if (!explanation) return null;

    if (requestedVersion !== undefined && requestedVersion > snapshot.dataVersion) {
      return {
        versionUnavailable: true,
        currentVersion: snapshot.dataVersion,
      };
    }

    return {
      explanation,
      ...(requestedVersion !== undefined && requestedVersion < snapshot.dataVersion
        ? { supersededByVersion: snapshot.dataVersion }
        : {}),
    };
  }

  async #buildSnapshot({
    userId,
    month,
    now,
    timeZone = FINANCIAL_CLARITY_TIME_ZONE,
  }) {
    assertPositiveId(userId, 'userId');
    const requestedMonth = assertMonth(month);
    const generationTime = assertNow(now);
    const configuredTimeZone = assertTimeZone(timeZone);
    const period = buildPeriod(requestedMonth, generationTime, configuredTimeZone);
    const sourceAccess = createAuthorizedSourceAccess({
      authenticated: true,
      authorized: true,
      principalId: userId,
      resourceScope: `user:${userId}:month:${requestedMonth}`,
    });
    const explanations = new Map();

    const repository = this.#repository ?? assertRepository(await loadDefaultRepository());
    const [versionLoad, periodLoad, goalsLoad, tripsLoad] = await Promise.allSettled([
      loadAndValidate(
        () => repository.getDataVersion(userId),
        (version) => {
          if (!Number.isSafeInteger(version) || version < 0) {
            throw new TypeError('getDataVersion must return a non-negative safe integer.');
          }
          return version;
        }
      ),
      loadAndValidate(
        () => repository.loadPeriod({ userId, month: requestedMonth }),
        (loaded) => requirePeriodLoad(loaded, requestedMonth)
      ),
      loadAndValidate(
        () => repository.loadGoals(userId),
        (loaded) => requireConfirmedCollection(loaded, 'goals')
      ),
      loadAndValidate(
        () => repository.listAccessibleTrips(userId),
        (loaded) => requireConfirmedCollection(loaded, 'trips')
      ),
    ]);

    if (versionLoad.status === 'rejected') {
      throw new Error('Unable to load the financial data version.', { cause: versionLoad.reason });
    }
    const dataVersion = versionLoad.value;
    const periodData = periodLoad.status === 'fulfilled' ? periodLoad.value : null;
    const confirmedGoals = goalsLoad.status === 'fulfilled' ? goalsLoad.value.records : [];
    const accessibleTrips = tripsLoad.status === 'fulfilled' ? tripsLoad.value.records : [];

    const tripLedgerLoads = tripsLoad.status === 'fulfilled'
      ? await Promise.allSettled(accessibleTrips.map((trip) => loadAndValidate(
          () => repository.loadAccessibleTripLedger({ userId, tripId: trip.id }),
          (loaded) => requireTripLedger(loaded, trip.id)
        )))
      : [];
    const confirmedTripLedgers = tripLedgerLoads.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));

    const exactPeriodRefs = periodSourceRefs(periodData, requestedMonth);
    const factSources = deduplicateSources([
      ...exactPeriodRefs,
      ...confirmedGoals.flatMap(goalSourceRefs),
      ...confirmedTripLedgers.flatMap(tripSourceRefs),
    ]);

    let rawMonthlyPlan = null;
    let monthlyPlanOutcome;
    let spendingOutcome;
    if (!periodData) {
      monthlyPlanOutcome = failedOutcome({
        sourceAccess,
        id: `monthly-plan:${requestedMonth}`,
        kind: 'monthly_plan',
        period,
        dataVersion,
      });
      spendingOutcome = failedOutcome({
        sourceAccess,
        id: `spending:${requestedMonth}`,
        kind: 'spending',
        period,
        dataVersion,
      });
    } else {
      const dependencies = monthlyDependencies(periodData, exactPeriodRefs);
      const monthlyResolution = createDependentOutcome({
        sourceAccess,
        id: `monthly-plan:${requestedMonth}`,
        kind: 'monthly_plan',
        classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
        period,
        dataVersion,
        dependencies,
        retryScopeKey: `outcome:monthly-plan:${requestedMonth}`,
        calculate: () => {
          const result = this.#calculateMonthlyPlan({
            month: requestedMonth,
            localDate: period.asOfDate,
            timeZone: configuredTimeZone,
            salaryEntries: periodData.salary.record ? [periodData.salary.record] : [],
            bills: periodData.bills.records,
            expenses: periodData.expenses.records,
            categoryTreatments: periodData.categoryTreatments.records,
          });
          const value = monthlyValue(result);
          rawMonthlyPlan = result;
          return {
            value,
            sourceRefs: result.sourceRefs,
            operations: result.operations,
            rounding: result.rounding,
          };
        },
      });
      monthlyPlanOutcome = monthlyResolution.outcome;
      if (monthlyResolution.explanation) {
        explanations.set(monthlyPlanOutcome.id, monthlyResolution.explanation);
      }

      const spendingResolution = createDependentOutcome({
        sourceAccess,
        id: `spending:${requestedMonth}`,
        kind: 'spending',
        classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
        period,
        dataVersion,
        dependencies,
        retryScopeKey: `outcome:spending:${requestedMonth}`,
        calculate: () => {
          const plan = rawMonthlyPlan ?? this.#calculateMonthlyPlan({
            month: requestedMonth,
            localDate: period.asOfDate,
            timeZone: configuredTimeZone,
            salaryEntries: periodData.salary.record ? [periodData.salary.record] : [],
            bills: periodData.bills.records,
            expenses: periodData.expenses.records,
            categoryTreatments: periodData.categoryTreatments.records,
          });
          const summary = this.#calculateExpenseSummary({
            month: requestedMonth,
            expenses: periodData.expenses.records,
            categoryTreatments: periodData.categoryTreatments.records,
            needsBudgetMinor: plan.needsBudgetMinor,
            wantsBudgetMinor: plan.wantsBudgetMinor,
            salaryMinor: plan.salaryMinor,
            activeBillsTotalMinor: plan.activeBillsTotalMinor,
          });
          return {
            value: spendingValue(plan, summary),
            sourceRefs: plan.sourceRefs,
            operations: plan.operations,
            rounding: plan.rounding.dailySpendingGuide,
          };
        },
      });
      spendingOutcome = spendingResolution.outcome;
      if (spendingResolution.explanation) {
        explanations.set(spendingOutcome.id, spendingResolution.explanation);
      }
    }

    const goalRankingInputs = [];
    let goalOutcomes;
    if (goalsLoad.status === 'rejected') {
      goalOutcomes = [failedOutcome({
        sourceAccess,
        id: `goals:${requestedMonth}`,
        kind: 'goal',
        period,
        dataVersion,
      })];
    } else {
      goalOutcomes = confirmedGoals.map((goal) => {
        const refs = goalSourceRefs(goal);
        const issue = goalIssue(goal);
        let rawGoal = null;
        const resolution = createDependentOutcome({
          sourceAccess,
          id: `goal:${goal.id}`,
          kind: 'goal',
          classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
          period,
          dataVersion,
          dependencies: [issue ?? {
            status: OUTCOME_STATUSES.AVAILABLE,
            input: `goal:${goal.id}`,
            sourceRefs: refs,
          }],
          retryScopeKey: `outcome:goal:${goal.id}`,
          calculate: () => {
            const result = this.#calculateGoal({
              goal,
              localDate: period.asOfDate,
              savingsTargetMinor: rawMonthlyPlan?.savingsTargetMinor ?? null,
              missingPlanInputs: ['salary'],
            });
            const value = goalValue(result);
            const rounding = result.rounding.requiredContribution
              ?? createRoundingMetadata();
            rawGoal = result;
            return {
              value,
              sourceRefs: deduplicateSources([
                ...refs,
                ...(rawMonthlyPlan
                  ? rawMonthlyPlan.sourceRefs.filter(({ sourceType }) => (
                      sourceType === 'salary' || sourceType === 'bill'
                    ))
                  : []),
              ]),
              operations: goalOperations(goal, result, refs),
              rounding,
            };
          },
        });
        if (resolution.explanation) {
          explanations.set(resolution.outcome.id, resolution.explanation);
        }
        if (resolution.outcome.status === OUTCOME_STATUSES.AVAILABLE && rawGoal) {
          goalRankingInputs.push({
            goalId: goal.id,
            name: goal.name,
            targetDate: goal.targetDate,
            fundingGapMinor: rawGoal.fundingGapMinor,
            status: rawGoal.status,
          });
        }
        return resolution.outcome;
      });
    }

    const tripRankingInputs = [];
    let tripSummaryOutcome;
    if (tripsLoad.status === 'rejected') {
      tripSummaryOutcome = failedOutcome({
        sourceAccess,
        id: `trip-summary:${requestedMonth}`,
        kind: 'trip_summary',
        period,
        dataVersion,
      });
    } else {
      const tripItems = accessibleTrips.map((trip, index) => {
        const ledgerLoad = tripLedgerLoads[index];
        if (ledgerLoad.status === 'rejected') {
          return failedOutcome({
            sourceAccess,
            id: `trip:${trip.id}`,
            kind: 'trip',
            period,
            dataVersion,
          });
        }

        const ledger = ledgerLoad.value;
        const confirmedRefs = tripSourceRefs(ledger);
        let result;
        try {
          result = this.#calculateTripOutcome({
            tripId: trip.id,
            tripVersion: trip.tripVersion,
            members: ledger.members.records,
            expenses: calculatorTripRecords(ledger.expenses.records),
          });
        } catch {
          return failedOutcome({
            sourceAccess,
            id: `trip:${trip.id}`,
            kind: 'trip',
            period,
            dataVersion,
            sourceRefs: confirmedRefs,
          });
        }

        if (result.status !== 'available') {
          const invalid = result.invalid?.[0] ?? {
            field: 'trip',
            constraint: 'complete valid trip records',
          };
          return createInvalidOutcome({
            sourceAccess,
            id: `trip:${trip.id}`,
            kind: 'trip',
            classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
            period,
            dataVersion,
            sourceRefs: deduplicateSources(confirmedRefs),
            invalid: [{
              input: `trip:${trip.id}.${invalid.field}`,
              constraint: invalid.constraint,
              affects: ['trip'],
            }],
          });
        }

        const value = tripValue(result);
        const rounding = tripRounding(result);
        const item = createAvailableOutcome({
          sourceAccess,
          id: `trip:${trip.id}`,
          kind: 'trip',
          classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
          period,
          dataVersion,
          value,
          sourceRefs: result.value.explanation.sourceRefs,
          rounding,
        });
        explanations.set(item.id, createCalculationExplanation({
          sourceAccess,
          outcome: item,
          operations: result.value.explanation.operations,
          rounding,
        }));
        const userMember = ledger.members.records.find((member) => member.userId === userId);
        const userBalance = userMember
          ? result.value.balances.find(({ memberId }) => memberId === userMember.id)
          : null;
        const earliestUnsettledAt = earliestTripRecordInstant(ledger.expenses.records);
        if (userBalance?.amountMinor !== 0 && earliestUnsettledAt) {
          tripRankingInputs.push({
            tripId: trip.id,
            name: trip.name,
            userBalanceMinor: userBalance.amountMinor,
            earliestUnsettledAt,
          });
        }
        return item;
      });
      const availableTripValues = tripItems.flatMap((item) => (
        item.status === OUTCOME_STATUSES.AVAILABLE ? [item.value] : []
      ));
      const aggregateSources = deduplicateSources(
        tripItems.flatMap((item) => item.sourceRefs)
      );
      const tripSummaryBase = createAvailableOutcome({
        sourceAccess,
        id: `trip-summary:${requestedMonth}`,
        kind: 'trip_summary',
        classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
        period,
        dataVersion,
        value: availableTripValues,
        sourceRefs: aggregateSources,
        rounding: createRoundingMetadata(),
      });
      tripSummaryOutcome = {
        ...tripSummaryBase,
        items: tripItems,
      };
      const aggregateOperations = tripItems
        .flatMap((item) => explanations.get(item.id)?.operations ?? [])
        .map((operation, index) => ({ ...operation, order: index + 1 }));
      explanations.set(tripSummaryBase.id, createCalculationExplanation({
        sourceAccess,
        outcome: tripSummaryBase,
        operations: aggregateOperations,
      }));
    }

    let actions = [];
    try {
      actions = this.#buildActionSummary({
        monthlyPlan: rawMonthlyPlan,
        spending: spendingOutcome.status === OUTCOME_STATUSES.AVAILABLE
          ? {
              needsBudgetMinor: spendingOutcome.value.needsBudget.amountMinor,
              needsSpentMinor: spendingOutcome.value.needsSpent.amountMinor,
              wantsBudgetMinor: spendingOutcome.value.wantsBudget.amountMinor,
              wantsSpentMinor: spendingOutcome.value.wantsSpent.amountMinor,
            }
          : null,
        goals: goalRankingInputs,
        trips: tripRankingInputs,
      }).actions;
    } catch {
      actions = [];
    }

    // The Home summary features one goal and one trip. They are chosen here, with
    // the same comparators as the actions, so they do not depend on the three-action cap.
    const highlights = { urgentGoal: null, nearestTripSettlement: null };
    try {
      const goal = selectHighestUrgencyGoal(goalRankingInputs);
      if (goal) {
        highlights.urgentGoal = {
          goalId: goal.goalId,
          name: goal.name,
          status: goal.status,
          targetDate: goal.targetDate,
          fundingGap: money(goal.fundingGapMinor),
        };
      }
      const trip = selectNearestTripSettlement(tripRankingInputs);
      if (trip) {
        highlights.nearestTripSettlement = {
          tripId: trip.tripId,
          name: trip.name,
          userBalance: { currency: 'INR', amountMinor: trip.userBalanceMinor },
          label: trip.userBalanceMinor > 0 ? 'receivable' : 'owed',
        };
      }
    } catch {
      highlights.urgentGoal = null;
      highlights.nearestTripSettlement = null;
    }

    const snapshot = {
      dataVersion,
      currency: 'INR',
      precisionMinor: 1,
      period,
      generatedAt: generationTime.toISOString(),
      highlights,
      facts: factSources.map((source) => ({
        classification: VALUE_CLASSIFICATIONS.ENTERED_FACT,
        source: { ...source, classification: VALUE_CLASSIFICATIONS.ENTERED_FACT },
      })),
      outcomes: {
        monthlyPlan: monthlyPlanOutcome,
        spending: spendingOutcome,
        goals: goalOutcomes,
        tripSummary: tripSummaryOutcome,
      },
      actions,
    };
    // Contained failures are reported by outcome family and record ID only.
    reportCalculationFailures(snapshot);
    return { snapshot, explanations };
  }
}

const clarityService = new ClarityService();
export default clarityService;
