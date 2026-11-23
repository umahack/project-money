import {
  MONEY_FORMAT_METADATA,
  assertSafePaise,
  createRoundingMetadata,
} from './money.js';

export const OUTCOME_STATUSES = Object.freeze({
  AVAILABLE: 'available',
  MISSING_INPUT: 'missing_input',
  INVALID_INPUT: 'invalid_input',
  STALE: 'stale',
  REFRESH_FAILED: 'refresh_failed',
  CALCULATION_FAILED: 'calculation_failed',
});

export const VALUE_CLASSIFICATIONS = Object.freeze({
  ENTERED_FACT: 'entered_fact',
  CALCULATED_RESULT: 'calculated_result',
  RECOMMENDATION: 'recommendation',
});

export const RETRY_ACTIONS = Object.freeze({
  REFRESH: 'refresh',
  RECALCULATE: 'recalculate',
});

export const PUBLIC_TRIP_OUTCOME_TYPE = 'public_trip_outcome';

const FINANCIAL_CLARITY_TIME_ZONE = 'Asia/Kolkata';
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([12]\d|3[01]|0[1-9])$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const OUTCOME_STATUS_VALUES = new Set(Object.values(OUTCOME_STATUSES));
const CLASSIFICATION_VALUES = new Set(Object.values(VALUE_CLASSIFICATIONS));
const SOURCE_TYPES = new Set([
  'salary',
  'bill',
  'expense',
  'category_treatment',
  'goal',
  'trip_expense',
  'trip_settlement',
]);
const CALCULATION_OPERATIONS = new Set([
  'sum',
  'subtract',
  'maximum',
  'multiply_ratio',
  'divide',
  'round_half_up',
  'ceil',
  'remainder_adjustment',
]);
const DEPENDENCY_STATUSES = new Set([
  OUTCOME_STATUSES.AVAILABLE,
  OUTCOME_STATUSES.MISSING_INPUT,
  OUTCOME_STATUSES.INVALID_INPUT,
  OUTCOME_STATUSES.STALE,
  OUTCOME_STATUSES.REFRESH_FAILED,
]);
const PRIVATE_SOURCE_ACCESS = new WeakSet();

/**
 * @typedef {object} AuthorizedSourceAccess
 * @property {'authenticated_authorized'} access
 * @property {string|number} principalId
 * @property {string} resourceScope
 */

/**
 * @typedef {object} OutcomePeriod
 * @property {string=} month
 * @property {string} start
 * @property {string} endExclusive
 * @property {'Asia/Kolkata'} timeZone
 */

/**
 * @typedef {object} OutcomeDependency
 * @property {string} input
 * @property {'available'|'missing_input'|'invalid_input'|'stale'|'refresh_failed'} status
 * @property {string=} constraint
 * @property {string=} sourcePeriod
 * @property {string=} requestedPeriod
 * @property {Array<object>=} sourceRefs
 */

/**
 * Create an opaque capability for private source-value shaping. Authentication
 * and record authorization remain service/route responsibilities; requiring
 * both assertions here prevents public serializers from accidentally using the
 * generic private outcome contract.
 *
 * @returns {AuthorizedSourceAccess}
 */
export function createAuthorizedSourceAccess({
  authenticated,
  authorized,
  principalId,
  resourceScope,
}) {
  if (authenticated !== true || authorized !== true) {
    throw new Error('Private financial source values require authenticated, authorized access.');
  }
  if (
    (typeof principalId !== 'string' && !Number.isSafeInteger(principalId))
    || String(principalId).trim() === ''
  ) {
    throw new TypeError('principalId must identify the authenticated principal.');
  }
  assertNonEmptyString(resourceScope, 'resourceScope');

  const capability = Object.freeze({
    access: 'authenticated_authorized',
    principalId,
    resourceScope,
  });
  PRIVATE_SOURCE_ACCESS.add(capability);
  return capability;
}

function requirePrivateSourceAccess(sourceAccess) {
  if (!sourceAccess || !PRIVATE_SOURCE_ACCESS.has(sourceAccess)) {
    throw new Error('An authorized source access capability is required.');
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertDataVersion(dataVersion) {
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) {
    throw new TypeError('dataVersion must be a non-negative safe integer.');
  }
  return dataVersion;
}

function assertTripVersion(tripVersion) {
  if (!Number.isSafeInteger(tripVersion) || tripVersion < 0) {
    throw new TypeError('tripVersion must be a non-negative safe integer.');
  }
  return tripVersion;
}

function normalizeClassification(classification) {
  if (!CLASSIFICATION_VALUES.has(classification)) {
    throw new TypeError(
      'classification must be entered_fact, calculated_result, or recommendation.'
    );
  }
  return classification;
}

function normalizePeriod(period) {
  assertPlainObject(period, 'period');
  if (period.timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
    throw new TypeError(`period.timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
  }
  if (!ISO_DATE_PATTERN.test(period.start)) {
    throw new TypeError('period.start must use YYYY-MM-DD format.');
  }
  if (!ISO_DATE_PATTERN.test(period.endExclusive)) {
    throw new TypeError('period.endExclusive must use YYYY-MM-DD format.');
  }
  if (period.start >= period.endExclusive) {
    throw new RangeError('period.start must be before period.endExclusive.');
  }
  if (period.month !== undefined && !MONTH_PATTERN.test(period.month)) {
    throw new TypeError('period.month must use YYYY-MM format when provided.');
  }

  return {
    ...(period.month === undefined ? {} : { month: period.month }),
    start: period.start,
    endExclusive: period.endExclusive,
    timeZone: period.timeZone,
    ...copyKnownPeriodContext(period),
  };
}

function copyKnownPeriodContext(period) {
  const context = {};
  if (period.asOfDate !== undefined) {
    if (!ISO_DATE_PATTERN.test(period.asOfDate)) {
      throw new TypeError('period.asOfDate must use YYYY-MM-DD format when provided.');
    }
    context.asOfDate = period.asOfDate;
  }
  if (period.daysRemainingInclusive !== undefined) {
    if (!Number.isSafeInteger(period.daysRemainingInclusive) || period.daysRemainingInclusive < 0) {
      throw new TypeError('period.daysRemainingInclusive must be a non-negative safe integer.');
    }
    context.daysRemainingInclusive = period.daysRemainingInclusive;
  }
  return context;
}

function normalizeMoneyValue(value, label, { allowNegative = true } = {}) {
  assertPlainObject(value, label);
  if (value.currency !== 'INR') {
    throw new TypeError(`${label}.currency must be INR.`);
  }
  return {
    currency: 'INR',
    amountMinor: assertSafePaise(value.amountMinor, {
      allowNegative,
      label: `${label}.amountMinor`,
    }),
  };
}

function normalizeSourceValue(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeMoneyValue(value, label);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${label} must be an INR money value, string, boolean, or finite number.`);
}

function sortAndRenumber(items, label) {
  const withPositions = items.map((item, index) => {
    const order = item.order ?? index + 1;
    if (!Number.isSafeInteger(order) || order <= 0) {
      throw new TypeError(`${label}[${index}].order must be a positive safe integer.`);
    }
    return { item, order, index };
  });
  const seen = new Set();
  for (const { order } of withPositions) {
    if (seen.has(order)) throw new TypeError(`${label} orders must be unique.`);
    seen.add(order);
  }
  return withPositions
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ item }, index) => ({ item, order: index + 1 }));
}

function normalizeSourceRefs(sourceRefs, sourceAccess) {
  requirePrivateSourceAccess(sourceAccess);
  if (!Array.isArray(sourceRefs)) {
    throw new TypeError('sourceRefs must be an array.');
  }

  const refs = sortAndRenumber(sourceRefs, 'sourceRefs').map(({ item, order }, index) => {
    assertPlainObject(item, `sourceRefs[${index}]`);
    if (!SOURCE_TYPES.has(item.sourceType)) {
      throw new TypeError(`sourceRefs[${index}].sourceType is not supported.`);
    }
    if (!Number.isSafeInteger(item.recordId) || item.recordId <= 0) {
      throw new TypeError(`sourceRefs[${index}].recordId must be a positive safe integer.`);
    }
    assertNonEmptyString(item.field, `sourceRefs[${index}].field`);
    assertNonEmptyString(item.label, `sourceRefs[${index}].label`);
    const ref = item.ref ?? `${item.sourceType}:${item.recordId}:${item.field}`;
    assertNonEmptyString(ref, `sourceRefs[${index}].ref`);

    return {
      order,
      ref,
      sourceType: item.sourceType,
      recordId: item.recordId,
      field: item.field,
      label: item.label,
      value: normalizeSourceValue(item.value, `sourceRefs[${index}].value`),
      classification: VALUE_CLASSIFICATIONS.ENTERED_FACT,
      ...(item.confirmedAt === undefined
        ? {}
        : { confirmedAt: assertNonEmptyString(item.confirmedAt, `sourceRefs[${index}].confirmedAt`) }),
      ...(item.period === undefined
        ? {}
        : { period: structuredClone(assertPlainObject(item.period, `sourceRefs[${index}].period`)) }),
    };
  });

  const seenRefs = new Set();
  for (const source of refs) {
    if (seenRefs.has(source.ref)) throw new TypeError('sourceRefs refs must be unique.');
    seenRefs.add(source.ref);
  }
  return refs;
}

function normalizeRounding(rounding) {
  if (rounding === undefined || rounding === null) {
    return createRoundingMetadata();
  }
  assertPlainObject(rounding, 'rounding');
  return createRoundingMetadata({
    direction: rounding.direction,
    adjustmentMinor: rounding.adjustmentMinor,
    adjustmentTarget: rounding.adjustmentTarget,
  });
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError('operations must be an array.');
  }

  return sortAndRenumber(operations, 'operations').map(({ item, order }, index) => {
    assertPlainObject(item, `operations[${index}]`);
    if (!CALCULATION_OPERATIONS.has(item.operation)) {
      throw new TypeError(`operations[${index}].operation is not supported.`);
    }
    if (!Array.isArray(item.operandRefs) || item.operandRefs.some((ref) => (
      typeof ref !== 'string' || ref.trim() === ''
    ))) {
      throw new TypeError(`operations[${index}].operandRefs must contain strings.`);
    }
    assertNonEmptyString(item.explanationKey, `operations[${index}].explanationKey`);
    if (!Object.hasOwn(item, 'result')) {
      throw new TypeError(`operations[${index}].result is required.`);
    }

    const normalized = structuredClone(item);
    normalized.order = order;
    normalized.resultClassification = VALUE_CLASSIFICATIONS.CALCULATED_RESULT;
    if (normalized.intermediateResults !== undefined) {
      assertPlainObject(normalized.intermediateResults, `operations[${index}].intermediateResults`);
      normalized.intermediateResultClassifications = Object.fromEntries(
        Object.keys(normalized.intermediateResults).map((name) => [
          name,
          VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
        ])
      );
    }
    return normalized;
  });
}

function normalizeRetry(action, scopeKey) {
  if (!Object.values(RETRY_ACTIONS).includes(action)) {
    throw new TypeError('retry action must be refresh or recalculate.');
  }
  return {
    action,
    scopeKey: assertNonEmptyString(scopeKey, 'retry.scopeKey'),
  };
}

function normalizeMissing(missing, kind) {
  if (!Array.isArray(missing) || missing.length === 0) {
    throw new TypeError('missing must identify at least one input.');
  }
  const issue = assertPlainObject(missing[0], 'missing[0]');
  const unlocks = issue.unlocks ?? [kind];
  if (!Array.isArray(unlocks) || unlocks.length === 0) {
    throw new TypeError('missing[0].unlocks must identify at least one outcome kind.');
  }
  return [{
    input: assertNonEmptyString(issue.input, 'missing[0].input'),
    unlocks: unlocks.map((entry, index) => assertNonEmptyString(
      entry,
      `missing[0].unlocks[${index}]`
    )),
  }];
}

function normalizeInvalid(invalid, kind) {
  if (!Array.isArray(invalid) || invalid.length === 0) {
    throw new TypeError('invalid must identify at least one input.');
  }
  const issue = assertPlainObject(invalid[0], 'invalid[0]');
  const affects = issue.affects ?? [kind];
  if (!Array.isArray(affects) || affects.length === 0) {
    throw new TypeError('invalid[0].affects must identify at least one outcome kind.');
  }
  return [{
    input: assertNonEmptyString(issue.input, 'invalid[0].input'),
    constraint: assertNonEmptyString(issue.constraint, 'invalid[0].constraint'),
    affects: affects.map((entry, index) => assertNonEmptyString(
      entry,
      `invalid[0].affects[${index}]`
    )),
  }];
}

function createPrivateBase({
  sourceAccess,
  id,
  kind,
  status,
  classification,
  period,
  dataVersion,
  sourceRefs = [],
  rounding,
  explainable = false,
}) {
  requirePrivateSourceAccess(sourceAccess);
  assertNonEmptyString(id, 'id');
  assertNonEmptyString(kind, 'kind');
  if (!OUTCOME_STATUS_VALUES.has(status)) {
    throw new TypeError('status is not a supported outcome status.');
  }

  const normalized = {
    id,
    kind,
    status,
    classification: normalizeClassification(classification),
    period: normalizePeriod(period),
    dataVersion: assertDataVersion(dataVersion),
    sourceRefs: normalizeSourceRefs(sourceRefs, sourceAccess),
  };
  if (rounding !== undefined) normalized.rounding = normalizeRounding(rounding);
  if (explainable) {
    normalized.explanationRef = { outcomeId: id, dataVersion };
  }
  return normalized;
}

export function createAvailableOutcome(input) {
  if (!Object.hasOwn(input, 'value')) {
    throw new TypeError('available outcomes require a value.');
  }
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.AVAILABLE,
    rounding: normalizeRounding(input.rounding),
    explainable: true,
  });
  return { ...base, value: structuredClone(input.value) };
}

export function createMissingOutcome(input) {
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.MISSING_INPUT,
  });
  return { ...base, missing: normalizeMissing(input.missing, base.kind) };
}

export function createInvalidOutcome(input) {
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.INVALID_INPUT,
  });
  return { ...base, invalid: normalizeInvalid(input.invalid, base.kind) };
}

export function createStaleOutcome(input) {
  if (!Object.hasOwn(input, 'value')) {
    throw new TypeError('stale outcomes require the last confirmed value.');
  }
  const stale = assertPlainObject(input.stale, 'stale');
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.STALE,
    rounding: normalizeRounding(input.rounding),
    explainable: true,
  });
  return {
    ...base,
    value: structuredClone(input.value),
    stale: {
      sourcePeriod: assertNonEmptyString(stale.sourcePeriod, 'stale.sourcePeriod'),
      requestedPeriod: assertNonEmptyString(stale.requestedPeriod, 'stale.requestedPeriod'),
    },
    retry: normalizeRetry(RETRY_ACTIONS.REFRESH, input.retryScopeKey),
  };
}

export function createRefreshFailedOutcome(input) {
  if (!Object.hasOwn(input, 'value')) {
    throw new TypeError('refresh-failed outcomes require the last confirmed value.');
  }
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.REFRESH_FAILED,
    rounding: normalizeRounding(input.rounding),
    explainable: true,
  });
  return {
    ...base,
    value: structuredClone(input.value),
    refreshFailure: {
      code: 'REFRESH_FAILED',
      ...(input.attemptedAt === undefined
        ? {}
        : { attemptedAt: assertNonEmptyString(input.attemptedAt, 'attemptedAt') }),
    },
    retry: normalizeRetry(RETRY_ACTIONS.REFRESH, input.retryScopeKey),
  };
}

export function createCalculationFailedOutcome(input) {
  const base = createPrivateBase({
    ...input,
    status: OUTCOME_STATUSES.CALCULATION_FAILED,
  });
  return {
    ...base,
    confirmedInputsRetained: true,
    failure: {
      code: 'CALCULATION_FAILED',
      temporarilyUnavailable: true,
    },
    retry: normalizeRetry(RETRY_ACTIONS.RECALCULATE, input.retryScopeKey),
  };
}

/**
 * Generate one version-coherent private explanation from an outcome. Source
 * references come from the outcome itself, so an explanation cannot combine a
 * current result with source values from another confirmed version.
 */
export function createCalculationExplanation({
  sourceAccess,
  outcome,
  operations,
  rounding,
}) {
  requirePrivateSourceAccess(sourceAccess);
  assertPlainObject(outcome, 'outcome');
  if (
    outcome.status === OUTCOME_STATUSES.MISSING_INPUT
    || outcome.status === OUTCOME_STATUSES.INVALID_INPUT
  ) {
    throw new TypeError('Unavailable input outcomes do not have calculation explanations.');
  }

  const sourceRefs = normalizeSourceRefs(outcome.sourceRefs, sourceAccess);
  const normalizedOperations = normalizeOperations(operations);
  const explanation = {
    schemaVersion: 1,
    outcomeId: assertNonEmptyString(outcome.id, 'outcome.id'),
    kind: assertNonEmptyString(outcome.kind, 'outcome.kind'),
    status: outcome.status,
    dataVersion: assertDataVersion(outcome.dataVersion),
    classification: normalizeClassification(outcome.classification),
    period: normalizePeriod(outcome.period),
    currency: MONEY_FORMAT_METADATA.currency,
    precisionMinor: MONEY_FORMAT_METADATA.precisionMinor,
    precision: { ...MONEY_FORMAT_METADATA },
    sourceRefs,
    operations: normalizedOperations,
    rounding: normalizeRounding(rounding ?? outcome.rounding),
  };
  if (Object.hasOwn(outcome, 'value')) {
    explanation.result = {
      classification: outcome.classification,
      value: structuredClone(outcome.value),
    };
  }
  if (outcome.stale !== undefined) explanation.stale = structuredClone(outcome.stale);
  return explanation;
}

function normalizeDependencies(dependencies) {
  if (!Array.isArray(dependencies)) {
    throw new TypeError('dependencies must be an array.');
  }
  return dependencies.map((dependency, index) => {
    assertPlainObject(dependency, `dependencies[${index}]`);
    if (!DEPENDENCY_STATUSES.has(dependency.status)) {
      throw new TypeError(`dependencies[${index}].status is not supported.`);
    }
    return {
      ...structuredClone(dependency),
      input: assertNonEmptyString(dependency.input, `dependencies[${index}].input`),
    };
  });
}

function dependencySourceRefs(dependencies) {
  const result = [];
  const seen = new Set();
  for (const dependency of dependencies) {
    for (const source of dependency.sourceRefs ?? []) {
      const ref = source.ref ?? `${source.sourceType}:${source.recordId}:${source.field}`;
      if (!seen.has(ref)) {
        result.push({ ...source, order: result.length + 1 });
        seen.add(ref);
      }
    }
  }
  return result;
}

/**
 * Resolve one outcome independently from its ordered direct dependencies.
 * Only the first missing/invalid direct dependency is reported, and sibling
 * outcomes are not inspected or changed.
 */
export function createDependentOutcome({
  sourceAccess,
  id,
  kind,
  classification,
  period,
  dataVersion,
  dependencies = [],
  calculate,
  retryScopeKey = `outcome:${id}`,
}) {
  requirePrivateSourceAccess(sourceAccess);
  const normalizedDependencies = normalizeDependencies(dependencies);
  const confirmedSourceRefs = dependencySourceRefs(normalizedDependencies);
  const blocking = normalizedDependencies.find(({ status }) => (
    status === OUTCOME_STATUSES.MISSING_INPUT
    || status === OUTCOME_STATUSES.INVALID_INPUT
  ));
  const common = {
    sourceAccess,
    id,
    kind,
    classification,
    period,
    dataVersion,
    sourceRefs: confirmedSourceRefs,
  };

  if (blocking?.status === OUTCOME_STATUSES.MISSING_INPUT) {
    return {
      outcome: createMissingOutcome({
        ...common,
        missing: [{ input: blocking.input, unlocks: blocking.unlocks ?? [kind] }],
      }),
      explanation: null,
    };
  }
  if (blocking?.status === OUTCOME_STATUSES.INVALID_INPUT) {
    return {
      outcome: createInvalidOutcome({
        ...common,
        invalid: [{
          input: blocking.input,
          constraint: blocking.constraint,
          affects: blocking.affects ?? [kind],
        }],
      }),
      explanation: null,
    };
  }
  if (typeof calculate !== 'function') {
    throw new TypeError('calculate must be a function when dependencies are available.');
  }

  let calculated;
  try {
    calculated = assertPlainObject(calculate(), 'calculation result');
    if (!Object.hasOwn(calculated, 'value')) {
      throw new TypeError('calculation result.value is required.');
    }
  } catch {
    return {
      outcome: createCalculationFailedOutcome({
        ...common,
        retryScopeKey,
      }),
      explanation: null,
    };
  }

  const calculatedCommon = {
    ...common,
    sourceRefs: calculated.sourceRefs ?? confirmedSourceRefs,
    value: calculated.value,
    rounding: calculated.rounding,
  };
  const refreshFailed = normalizedDependencies.find(
    ({ status }) => status === OUTCOME_STATUSES.REFRESH_FAILED
  );
  const stale = normalizedDependencies.find(
    ({ status }) => status === OUTCOME_STATUSES.STALE
  );

  let outcome;
  if (refreshFailed) {
    outcome = createRefreshFailedOutcome({
      ...calculatedCommon,
      attemptedAt: refreshFailed.attemptedAt,
      retryScopeKey,
    });
  } else if (stale) {
    outcome = createStaleOutcome({
      ...calculatedCommon,
      stale: {
        sourcePeriod: stale.sourcePeriod,
        requestedPeriod: stale.requestedPeriod,
      },
      retryScopeKey,
    });
  } else {
    outcome = createAvailableOutcome(calculatedCommon);
  }

  return {
    outcome,
    explanation: createCalculationExplanation({
      sourceAccess,
      outcome,
      operations: calculated.operations ?? [],
      rounding: calculated.rounding,
    }),
  };
}

function normalizePublicBalance(balance, index) {
  assertPlainObject(balance, `balances[${index}]`);
  const memberKey = balance.memberKey;
  if ((typeof memberKey !== 'string' && !Number.isSafeInteger(memberKey)) || String(memberKey).trim() === '') {
    throw new TypeError(`balances[${index}].memberKey must be a public member key.`);
  }
  if (!['receivable', 'owed', 'settled'].includes(balance.label)) {
    throw new TypeError(`balances[${index}].label is not supported.`);
  }
  return {
    memberKey,
    amountMinor: assertSafePaise(balance.amountMinor, {
      label: `balances[${index}].amountMinor`,
    }),
    label: balance.label,
  };
}

function normalizePublicSettlement(settlement, index) {
  assertPlainObject(settlement, `settlements[${index}]`);
  const fromMemberKey = settlement.fromMemberKey;
  const toMemberKey = settlement.toMemberKey;
  if (
    (typeof fromMemberKey !== 'string' && !Number.isSafeInteger(fromMemberKey))
    || String(fromMemberKey).trim() === ''
  ) {
    throw new TypeError(`settlements[${index}].fromMemberKey must be a public member key.`);
  }
  if (
    (typeof toMemberKey !== 'string' && !Number.isSafeInteger(toMemberKey))
    || String(toMemberKey).trim() === ''
  ) {
    throw new TypeError(`settlements[${index}].toMemberKey must be a public member key.`);
  }
  return {
    fromMemberKey,
    toMemberKey,
    amountMinor: assertSafePaise(settlement.amountMinor, {
      allowNegative: false,
      label: `settlements[${index}].amountMinor`,
    }),
  };
}

/**
 * Create the deliberately smaller public-trip calculation type. It accepts no
 * generic source references, explanation operations, private outcome values,
 * user IDs, or record payloads. A later public-route serializer may combine
 * this calculation with its separately allowlisted public trip fields.
 */
export function createPublicTripOutcome({
  status = OUTCOME_STATUSES.AVAILABLE,
  tripVersion,
  balances = [],
  settlements = [],
}) {
  if (![OUTCOME_STATUSES.AVAILABLE, OUTCOME_STATUSES.INVALID_INPUT].includes(status)) {
    throw new TypeError('public trip status must be available or invalid_input.');
  }
  if (!Array.isArray(balances) || !Array.isArray(settlements)) {
    throw new TypeError('public trip balances and settlements must be arrays.');
  }

  return {
    schemaVersion: 1,
    type: PUBLIC_TRIP_OUTCOME_TYPE,
    status,
    tripVersion: assertTripVersion(tripVersion),
    balances: balances.map(normalizePublicBalance),
    settlements: settlements.map(normalizePublicSettlement),
  };
}
