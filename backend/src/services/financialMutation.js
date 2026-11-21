import { createHmac, timingSafeEqual } from 'node:crypto';
import db from '../db/index.js';
import {
  createAuthorizedSourceAccess,
  createCalculationFailedOutcome,
  VALUE_CLASSIFICATIONS,
} from '../domain/outcomes.js';
import { assertMonth, assertPositiveId, toSafeInteger } from '../repositories/repositorySupport.js';
import clarityService from './clarityService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_-]*:[^\s]{1,100}$/i;
const OUTCOME_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const MINIMUM_HMAC_KEY_BYTES = 32;
const FINANCIAL_CLARITY_TIME_ZONE = 'Asia/Kolkata';
const FINGERPRINT_DOMAIN = 'project-money.financial-mutation.request.v1';

const OWNED_RECORD_TABLES = Object.freeze({
  salary: 'salary_entries',
  bill: 'emis',
  expense: 'expense_log',
  goal: 'savings_goals',
  category_treatment: 'expense_category_treatments',
});

function mutationError(code, message, httpStatus, details = {}, cause) {
  return new FinancialMutationError({ code, message, httpStatus, details, cause });
}

export class FinancialMutationError extends Error {
  constructor({ code, message, httpStatus, details = {}, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FinancialMutationError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.statusCode = httpStatus;
    Object.assign(this, details);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function canonicalJson(value, path = '$', ancestors = new Set()) {
  if (value === null) return 'null';

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must not contain a non-finite number.`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains an unsupported value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain a circular reference.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path} must not contain sparse arrays.`);
        }
      }
      return `[${value.map((entry, index) => canonicalJson(
        entry,
        `${path}[${index}]`,
        ancestors
      )).join(',')}]`;
    }

    assertPlainObject(value, path);
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`, ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeMutationRequest({
  userId,
  operation,
  command,
  expectedRecordVersion,
}) {
  assertPositiveId(userId, 'userId');
  if (typeof operation !== 'string' || !OPERATION_PATTERN.test(operation)) {
    throw new TypeError('operation must use a namespaced lower-case operation key.');
  }
  assertPlainObject(command, 'command');
  if (
    expectedRecordVersion !== undefined
    && (!Number.isSafeInteger(expectedRecordVersion) || expectedRecordVersion < 0)
  ) {
    throw new TypeError('expectedRecordVersion must be a non-negative safe integer.');
  }

  return canonicalJson({
    command,
    domain: FINGERPRINT_DOMAIN,
    expectedRecordVersion: expectedRecordVersion ?? null,
    operation,
    userId,
  });
}

function normalizeFingerprintKey(key) {
  const keyBuffer = Buffer.isBuffer(key)
    ? Buffer.from(key)
    : typeof key === 'string'
      ? Buffer.from(key, 'utf8')
      : null;
  if (!keyBuffer || keyBuffer.byteLength < MINIMUM_HMAC_KEY_BYTES) {
    throw mutationError(
      'FINANCIAL_MUTATION_NOT_CONFIGURED',
      'Financial mutations are not configured.',
      500
    );
  }
  return keyBuffer;
}

function defaultFingerprintKeyProvider() {
  return process.env.FINANCIAL_MUTATION_HMAC_KEY;
}

export function createMutationRequestFingerprint({
  fingerprintKey,
  userId,
  operation,
  command,
  expectedRecordVersion,
}) {
  const canonicalRequest = canonicalizeMutationRequest({
    userId,
    operation,
    command,
    expectedRecordVersion,
  });
  const key = normalizeFingerprintKey(fingerprintKey);
  try {
    return createHmac('sha256', key).update(canonicalRequest, 'utf8').digest('hex');
  } finally {
    key.fill(0);
  }
}

function fingerprintsMatch(left, right) {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || !/^[0-9a-f]{64}$/i.test(left)
    || !/^[0-9a-f]{64}$/i.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw mutationError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be a UUID.',
      400,
      { field: 'idempotencyKey' }
    );
  }
  return value.toLowerCase();
}

function normalizeOperation(value) {
  if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) {
    throw mutationError(
      'INVALID_FINANCIAL_OPERATION',
      'Financial operation is invalid.',
      400,
      { field: 'operation' }
    );
  }
  return value;
}

function normalizeExpectedRecordVersion(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw mutationError(
      'INVALID_EXPECTED_RECORD_VERSION',
      'Expected record version must be a non-negative safe integer.',
      400,
      { field: 'expectedRecordVersion' }
    );
  }
  return value;
}

function normalizeCommand(command) {
  try {
    assertPlainObject(command, 'command');
    return JSON.parse(canonicalJson(command));
  } catch (error) {
    throw mutationError(
      'INVALID_MUTATION_COMMAND',
      'Financial mutation command must be a JSON-compatible object.',
      400,
      { field: 'command' },
      error
    );
  }
}

function normalizeHandlers(operationHandlers) {
  const entries = operationHandlers instanceof Map
    ? [...operationHandlers.entries()]
    : Object.entries(assertPlainObject(operationHandlers, 'operationHandlers'));
  const handlers = new Map();

  for (const [operation, handler] of entries) {
    if (typeof operation !== 'string' || !OPERATION_PATTERN.test(operation)) {
      throw new TypeError('Every operation handler key must be a namespaced operation key.');
    }
    assertPlainObject(handler, `operationHandlers.${operation}`);
    if (typeof handler.getContext !== 'function' || typeof handler.prepare !== 'function') {
      throw new TypeError(
        `operationHandlers.${operation} must provide getContext() and prepare().`
      );
    }
    handlers.set(operation, handler);
  }
  return handlers;
}

function normalizeAffectedOutcomes(value, month) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Mutation context must identify at least one affected outcome.');
  }
  const keys = new Set();
  return value.map((outcome, index) => {
    assertPlainObject(outcome, `affectedOutcomes[${index}]`);
    if (typeof outcome.key !== 'string' || !OUTCOME_KEY_PATTERN.test(outcome.key)) {
      throw new TypeError(`affectedOutcomes[${index}].key is invalid.`);
    }
    if (keys.has(outcome.key)) {
      throw new TypeError('Affected outcome keys must be unique.');
    }
    keys.add(outcome.key);
    if (typeof outcome.id !== 'string' || outcome.id.trim() === '') {
      throw new TypeError(`affectedOutcomes[${index}].id is required.`);
    }
    if (typeof outcome.kind !== 'string' || outcome.kind.trim() === '') {
      throw new TypeError(`affectedOutcomes[${index}].kind is required.`);
    }
    return {
      key: outcome.key,
      id: outcome.id,
      kind: outcome.kind,
      retryScopeKey: outcome.retryScopeKey ?? `outcome:${outcome.id}`,
      month,
    };
  });
}

async function normalizeMutationContext(handler, input) {
  const rawContext = await handler.getContext(input);
  assertPlainObject(rawContext, 'mutation context');
  const snapshotMonth = assertMonth(rawContext.snapshotMonth, 'snapshotMonth');
  if (
    typeof rawContext.scopeKey !== 'string'
    || !SCOPE_KEY_PATTERN.test(rawContext.scopeKey)
  ) {
    throw new TypeError('Mutation context scopeKey is invalid.');
  }
  return {
    scopeKey: rawContext.scopeKey,
    snapshotMonth,
    affectedOutcomes: normalizeAffectedOutcomes(
      rawContext.affectedOutcomes,
      snapshotMonth
    ),
  };
}

function normalizeStatement(statement, label) {
  if (typeof statement === 'string' && statement.trim() !== '') return statement;
  if (Array.isArray(statement)) {
    if (
      statement.length >= 1
      && statement.length <= 2
      && typeof statement[0] === 'string'
      && statement[0].trim() !== ''
    ) {
      return statement;
    }
  }
  if (
    statement
    && typeof statement === 'object'
    && !Array.isArray(statement)
    && typeof statement.sql === 'string'
    && statement.sql.trim() !== ''
  ) {
    return statement;
  }
  throw new TypeError(`${label} must be a parameterized database statement.`);
}

function normalizePlan(plan) {
  assertPlainObject(plan, 'mutation plan');
  if (!['create', 'update', 'delete'].includes(plan.action)) {
    throw new TypeError('Mutation plan action must be create, update, or delete.');
  }
  if (
    typeof plan.recordType !== 'string'
    || !RECORD_TYPE_PATTERN.test(plan.recordType)
    || !Object.hasOwn(OWNED_RECORD_TABLES, plan.recordType)
  ) {
    throw new TypeError('Mutation plan recordType is not supported.');
  }
  const recordId = plan.recordId == null
    ? null
    : assertPositiveId(plan.recordId, 'recordId');
  if (plan.action !== 'create' && recordId === null) {
    throw new TypeError('Update and delete mutation plans require recordId.');
  }
  const linkedStatements = plan.linkedStatements ?? [];
  if (!Array.isArray(linkedStatements)) {
    throw new TypeError('Mutation plan linkedStatements must be an array.');
  }
  const status = plan.status ?? (plan.action === 'delete' ? 'reversed' : 'confirmed');
  if (!['confirmed', 'reversed'].includes(status)) {
    throw new TypeError('Mutation plan status must be confirmed or reversed.');
  }
  if (plan.result !== undefined) canonicalJson(plan.result, 'mutation plan result');

  return {
    action: plan.action,
    recordType: plan.recordType,
    recordId,
    sourceStatement: normalizeStatement(plan.sourceStatement, 'sourceStatement'),
    linkedStatements: linkedStatements.map((statement, index) => (
      normalizeStatement(statement, `linkedStatements[${index}]`)
    )),
    status,
    result: plan.result === undefined ? undefined : structuredClone(plan.result),
  };
}

function normalizeReceipt(row) {
  if (!row) return null;
  return {
    changeId: toSafeInteger(row.id, 'change id'),
    userId: toSafeInteger(row.user_id, 'change user id'),
    idempotencyKey: row.idempotency_key,
    requestFingerprintHmac: row.request_fingerprint_hmac,
    operation: row.operation,
    recordType: row.record_type,
    recordId: row.record_id == null ? null : toSafeInteger(row.record_id, 'record id'),
    recordVersion: toSafeInteger(row.record_version, 'record version'),
    status: row.status,
    occurredAt: row.occurred_at,
  };
}

function nextMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  if (year === 9999 && monthNumber === 12) {
    throw new RangeError('snapshotMonth must have a representable following month.');
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonthNumber).padStart(2, '0')}`;
}

function daysInMonth(year, monthNumber) {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
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
  return {
    month,
    timeZone,
    start: `${month}-01`,
    endExclusive: `${nextMonth(month)}-01`,
    asOfDate,
    daysRemainingInclusive: lastDay - Number(asOfDate.slice(8, 10)) + 1,
  };
}

function buildCalculationFailureSnapshot({
  userId,
  context,
  dataVersion,
  now,
  timeZone,
}) {
  const period = buildPeriod(context.snapshotMonth, now, timeZone);
  const sourceAccess = createAuthorizedSourceAccess({
    authenticated: true,
    authorized: true,
    principalId: userId,
    resourceScope: `user:${userId}:month:${context.snapshotMonth}`,
  });
  const outcomes = Object.fromEntries(context.affectedOutcomes.map((outcome) => [
    outcome.key,
    createCalculationFailedOutcome({
      sourceAccess,
      id: outcome.id,
      kind: outcome.kind,
      classification: VALUE_CLASSIFICATIONS.CALCULATED_RESULT,
      period,
      dataVersion,
      sourceRefs: [],
      retryScopeKey: outcome.retryScopeKey,
    }),
  ]));
  return {
    dataVersion,
    currency: 'INR',
    precisionMinor: 1,
    period,
    generatedAt: now.toISOString(),
    facts: [],
    outcomes,
    actions: [],
    partial: true,
  };
}

export class FinancialMutationService {
  #database;
  #snapshotService;
  #handlers;
  #fingerprintKey;
  #fingerprintKeyProvider;
  #clock;
  #timeZone;

  constructor({
    database = db,
    snapshotService = clarityService,
    operationHandlers = {},
    fingerprintKey = null,
    fingerprintKeyProvider = defaultFingerprintKeyProvider,
    clock = () => new Date(),
    timeZone = FINANCIAL_CLARITY_TIME_ZONE,
  } = {}) {
    if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function') {
      throw new TypeError('A database adapter with prepare() and batch() is required.');
    }
    if (!snapshotService || typeof snapshotService.getSnapshot !== 'function') {
      throw new TypeError('snapshotService.getSnapshot() is required.');
    }
    if (fingerprintKey !== null) {
      const validatedKey = normalizeFingerprintKey(fingerprintKey);
      validatedKey.fill(0);
    }
    if (typeof fingerprintKeyProvider !== 'function') {
      throw new TypeError('fingerprintKeyProvider must be a function.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    if (timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
      throw new RangeError(`timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
    }

    this.#database = database;
    this.#snapshotService = snapshotService;
    this.#handlers = normalizeHandlers(operationHandlers);
    this.#fingerprintKey = fingerprintKey === null ? null : Buffer.from(fingerprintKey);
    this.#fingerprintKeyProvider = fingerprintKeyProvider;
    this.#clock = clock;
    this.#timeZone = timeZone;
  }

  async #loadReceipt(userId, idempotencyKey) {
    const row = await this.#database.prepare(
      `SELECT id, user_id, idempotency_key, request_fingerprint_hmac, operation,
              record_type, record_id, record_version, status, occurred_at
         FROM financial_record_changes
        WHERE user_id = ? AND idempotency_key = ?`
    ).get(userId, idempotencyKey);
    return normalizeReceipt(row);
  }

  async #loadRecordVersion(userId, recordType, recordId) {
    if (recordId === null) return 0;
    const row = await this.#database.prepare(
      `SELECT COALESCE(MAX(record_version), 0) AS record_version
         FROM financial_record_changes
        WHERE user_id = ? AND record_type = ? AND record_id = ?`
    ).get(userId, recordType, recordId);
    return toSafeInteger(row?.record_version ?? 0, 'record version');
  }

  async #loadDataVersion(userId) {
    const row = await this.#database.prepare(
      'SELECT data_version FROM user_financial_state WHERE user_id = ?'
    ).get(userId);
    return toSafeInteger(row?.data_version ?? 0, 'data version');
  }

  async #validateOwnership(userId, plan) {
    if (plan.action === 'create') return;
    const table = OWNED_RECORD_TABLES[plan.recordType];
    const owned = await this.#database.prepare(
      `SELECT id FROM ${table} WHERE id = ? AND user_id = ?`
    ).get(plan.recordId, userId);
    if (!owned) {
      throw mutationError(
        'FINANCIAL_RECORD_NOT_FOUND',
        'Financial record was not found.',
        404
      );
    }
  }

  #fingerprint({ userId, operation, command, expectedRecordVersion }) {
    const configuredKey = this.#fingerprintKey ?? this.#fingerprintKeyProvider();
    return createMutationRequestFingerprint({
      fingerprintKey: configuredKey,
      userId,
      operation,
      command,
      expectedRecordVersion,
    });
  }

  async #calculateSnapshot({ userId, context, dataVersion, now }) {
    try {
      return await this.#snapshotService.getSnapshot({
        userId,
        month: context.snapshotMonth,
        now,
        timeZone: this.#timeZone,
      });
    } catch {
      return buildCalculationFailureSnapshot({
        userId,
        context,
        dataVersion,
        now,
        timeZone: this.#timeZone,
      });
    }
  }

  async #envelope({ receipt, context, replayed, planResult, now }) {
    const dataVersion = await this.#loadDataVersion(receipt.userId);
    const snapshot = await this.#calculateSnapshot({
      userId: receipt.userId,
      context,
      dataVersion,
      now,
    });
    return {
      schemaVersion: 1,
      mutation: {
        changeId: receipt.changeId,
        idempotencyKey: receipt.idempotencyKey,
        scopeKey: context.scopeKey,
        operation: receipt.operation,
        recordType: receipt.recordType,
        recordId: receipt.recordId,
        status: receipt.status,
        recordVersion: receipt.recordVersion,
        occurredAt: receipt.occurredAt,
        replayed,
        ...(planResult === undefined ? {} : { result: structuredClone(planResult) }),
      },
      clarity: snapshot,
    };
  }

  #assertMatchingReplay(receipt, requestFingerprint) {
    if (!fingerprintsMatch(receipt.requestFingerprintHmac, requestFingerprint)) {
      throw mutationError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was already used for a different financial command.',
        409,
        { field: 'idempotencyKey' }
      );
    }
  }

  async execute({
    userId,
    idempotencyKey,
    operation,
    command,
    expectedRecordVersion,
  }) {
    try {
      assertPositiveId(userId, 'userId');
    } catch (error) {
      throw mutationError('INVALID_USER_ID', 'User identifier is invalid.', 400, {}, error);
    }
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const normalizedOperation = normalizeOperation(operation);
    const normalizedVersion = normalizeExpectedRecordVersion(expectedRecordVersion);
    const normalizedCommand = normalizeCommand(command);
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('clock must return a valid Date.');
    }
    const requestFingerprint = this.#fingerprint({
      userId,
      operation: normalizedOperation,
      command: normalizedCommand,
      expectedRecordVersion: normalizedVersion,
    });

    const existingReceipt = await this.#loadReceipt(userId, normalizedKey);
    const handler = this.#handlers.get(normalizedOperation);
    if (existingReceipt) {
      this.#assertMatchingReplay(existingReceipt, requestFingerprint);
      if (!handler) {
        throw mutationError(
          'UNSUPPORTED_FINANCIAL_OPERATION',
          'Financial operation is not supported.',
          400
        );
      }
      const context = await normalizeMutationContext(handler, {
        userId,
        idempotencyKey: normalizedKey,
        operation: normalizedOperation,
        command: structuredClone(normalizedCommand),
        now: new Date(now),
        timeZone: this.#timeZone,
        receipt: existingReceipt,
      });
      return this.#envelope({
        receipt: existingReceipt,
        context,
        replayed: true,
        now,
      });
    }

    if (!handler) {
      throw mutationError(
        'UNSUPPORTED_FINANCIAL_OPERATION',
        'Financial operation is not supported.',
        400,
        { field: 'operation' }
      );
    }

    const handlerInput = {
      userId,
      idempotencyKey: normalizedKey,
      operation: normalizedOperation,
      command: structuredClone(normalizedCommand),
      now: new Date(now),
      timeZone: this.#timeZone,
      receipt: null,
    };
    const context = await normalizeMutationContext(handler, handlerInput);
    let plan;
    try {
      plan = normalizePlan(await handler.prepare({
        ...handlerInput,
        database: this.#database,
        context,
      }));
    } catch (error) {
      if (error instanceof FinancialMutationError) throw error;
      throw mutationError(
        'INVALID_MUTATION_PLAN',
        'Financial mutation could not be prepared.',
        500,
        {},
        error
      );
    }

    await this.#validateOwnership(userId, plan);
    const currentRecordVersion = await this.#loadRecordVersion(
      userId,
      plan.recordType,
      plan.recordId
    );
    if (
      normalizedVersion !== undefined
      && normalizedVersion !== currentRecordVersion
    ) {
      throw mutationError(
        'RECORD_VERSION_CONFLICT',
        'Financial record changed since it was last confirmed.',
        409,
        { currentRecordVersion }
      );
    }
    const recordVersion = currentRecordVersion + 1;
    if (!Number.isSafeInteger(recordVersion)) {
      throw mutationError(
        'RECORD_VERSION_EXHAUSTED',
        'Financial record version cannot be incremented.',
        409,
        { currentRecordVersion }
      );
    }

    const statements = [
      {
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          userId,
          normalizedKey,
          requestFingerprint,
          normalizedOperation,
          plan.recordType,
          plan.recordId,
          recordVersion,
          plan.status,
        ],
      },
      plan.sourceStatement,
    ];
    const generatedRecordId = plan.recordId === null;
    if (generatedRecordId) {
      statements.push({
        sql: `UPDATE financial_record_changes
                 SET record_id = last_insert_rowid()
               WHERE user_id = ? AND idempotency_key = ?`,
        args: [userId, normalizedKey],
      });
    }
    statements.push(...plan.linkedStatements, {
      sql: `INSERT INTO user_financial_state (user_id, data_version)
            VALUES (?, 1)
            ON CONFLICT(user_id) DO UPDATE SET
              data_version = user_financial_state.data_version + 1,
              updated_at = CURRENT_TIMESTAMP`,
      args: [userId],
    });

    try {
      await this.#database.batch(statements);
    } catch (error) {
      const racedReceipt = await this.#loadReceipt(userId, normalizedKey);
      if (racedReceipt) {
        this.#assertMatchingReplay(racedReceipt, requestFingerprint);
        const replayContext = await normalizeMutationContext(handler, {
          ...handlerInput,
          receipt: racedReceipt,
        });
        return this.#envelope({
          receipt: racedReceipt,
          context: replayContext,
          replayed: true,
          now,
        });
      }
      const latestRecordVersion = await this.#loadRecordVersion(
        userId,
        plan.recordType,
        plan.recordId
      );
      if (latestRecordVersion !== currentRecordVersion) {
        throw mutationError(
          'RECORD_VERSION_CONFLICT',
          'Financial record changed since it was last confirmed.',
          409,
          { currentRecordVersion: latestRecordVersion },
          error
        );
      }
      throw mutationError(
        'MUTATION_FAILED',
        'Financial mutation could not be saved.',
        500,
        {},
        error
      );
    }

    const receipt = await this.#loadReceipt(userId, normalizedKey);
    if (!receipt || receipt.recordId === null) {
      throw mutationError(
        'MUTATION_CONFIRMATION_FAILED',
        'Financial mutation was saved but could not be confirmed.',
        500
      );
    }
    const confirmedContext = await normalizeMutationContext(handler, {
      ...handlerInput,
      receipt,
    });
    return this.#envelope({
      receipt,
      context: confirmedContext,
      replayed: false,
      planResult: plan.result,
      now,
    });
  }
}

const financialMutationService = new FinancialMutationService();
export default financialMutationService;
