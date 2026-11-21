import { randomUUID, timingSafeEqual } from 'node:crypto';
import db from '../db/index.js';
import { legacyNumberToPaise, parseDecimalToPaise } from '../domain/money.js';
import {
  calculateTripOutcome,
  LEGACY_SETTLEMENT_PREFIX,
} from '../domain/trips.js';
import { FinancialRepository } from '../repositories/financialRepository.js';
import { assertPositiveId, toSafeInteger } from '../repositories/repositorySupport.js';
import { createMutationRequestFingerprint } from './financialMutation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY_PATTERN = /^[A-Za-z0-9 &/+()-]{1,24}$/;
const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Entertainment',
  'Bills',
  'Health',
  'Travel',
  'Education',
  'Other',
]);
const TIME_ZONE = 'Asia/Kolkata';

function tripError(code, message, httpStatus, details = {}, cause) {
  return new TripServiceError({ code, message, httpStatus, details, cause });
}

export class TripServiceError extends Error {
  constructor({ code, message, httpStatus, details = {}, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TripServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.statusCode = httpStatus;
    Object.assign(this, details);
  }
}

function normalizeId(value, field) {
  try {
    return assertPositiveId(Number(value), field);
  } catch (error) {
    throw tripError('INVALID_TRIP_IDENTIFIER', `${field} is invalid.`, 400, { field }, error);
  }
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw tripError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be a UUID.',
      400,
      { field: 'idempotencyKey' }
    );
  }
  return value.toLowerCase();
}

function normalizeExpectedTripVersion(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw tripError(
      'INVALID_EXPECTED_TRIP_VERSION',
      'Expected trip version must be a non-negative safe integer.',
      400,
      { field: 'expectedTripVersion' }
    );
  }
  return normalized;
}

function normalizeAmountMinor(value) {
  try {
    const amountMinor = typeof value === 'number'
      ? legacyNumberToPaise(value, { label: 'amount' })
      : parseDecimalToPaise(value, { label: 'amount' });
    if (amountMinor <= 0) throw new RangeError('amount must be greater than zero.');
    return amountMinor;
  } catch (error) {
    throw tripError(
      'INVALID_TRIP_AMOUNT',
      'Amount must be greater than zero and contain at most two decimal places.',
      422,
      {
        field: 'amount',
        constraint: 'a positive amount with at most two decimal places',
      },
      error
    );
  }
}

function normalizeMemberName(value, field = 'name') {
  if (typeof value !== 'string') {
    throw tripError('INVALID_TRIP_MEMBER', 'Member name is required.', 400, { field });
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 40) {
    throw tripError(
      'INVALID_TRIP_MEMBER',
      'Member name must contain between 1 and 40 characters.',
      400,
      { field }
    );
  }
  return normalized;
}

function normalizeDescription(value) {
  if (typeof value !== 'string') {
    throw tripError('INVALID_TRIP_DESCRIPTION', 'Description is required.', 400, {
      field: 'description',
    });
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw tripError(
      'INVALID_TRIP_DESCRIPTION',
      'Description must contain between 1 and 100 characters.',
      400,
      { field: 'description' }
    );
  }
  return normalized;
}

function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw tripError('INVALID_MEMBER_EMAIL', 'Member email is invalid.', 400, { field: 'email' });
  }
  return value.toLowerCase();
}

function normalizeSplit(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw tripError('INCOMPLETE_SPLIT', 'Split required', 400, {
      field: 'split',
      constraint: 'at least one trip member with a positive share',
    });
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw tripError('INVALID_SPLIT_ENTRY', 'Each split entry must identify a member.', 422, {
        field: `split[${index}]`,
      });
    }
    const name = normalizeMemberName(entry.name, `split[${index}].name`);
    const share = Number(entry.share);
    if (!Number.isFinite(share) || share < 0) {
      throw tripError('INVALID_SPLIT_SHARE', 'Split shares must be non-negative numbers.', 422, {
        field: `split[${index}].share`,
        constraint: 'a non-negative finite number',
      });
    }
    return { name, share };
  });
}

function localDate(now, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeSpentOn(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw tripError('INVALID_PERSONAL_EXPENSE_DATE', 'Pick a valid date in the last decade.', 400, {
      field: 'spentOn',
    });
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isCalendarDate = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
  const currentYear = Number(localDate(now).slice(0, 4));
  if (!isCalendarDate || year < currentYear - 10 || year > currentYear + 1) {
    throw tripError('INVALID_PERSONAL_EXPENSE_DATE', 'Pick a valid date in the last decade.', 400, {
      field: 'spentOn',
    });
  }
  return value;
}

function normalizeCategory(value) {
  if (typeof value !== 'string') {
    throw tripError('INVALID_PERSONAL_EXPENSE_CATEGORY', 'Expense category is required.', 400, {
      field: 'category',
    });
  }
  const category = value.trim();
  if (!CATEGORY_PATTERN.test(category)) {
    throw tripError('INVALID_PERSONAL_EXPENSE_CATEGORY', 'Expense category is invalid.', 400, {
      field: 'category',
    });
  }
  return category;
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

function linkedUserIds(ledger) {
  return [...new Set([
    ledger.trip.ownerUserId,
    ...ledger.members.records.map(({ userId }) => userId).filter((userId) => userId !== null),
  ])].sort((left, right) => left - right);
}

function financialVersionStatements(userIds) {
  return userIds.map((userId) => ({
    sql: `INSERT INTO user_financial_state (user_id, data_version)
          VALUES (?, 1)
          ON CONFLICT(user_id) DO UPDATE SET
            data_version = user_financial_state.data_version + 1,
            updated_at = CURRENT_TIMESTAMP`,
    args: [userId],
  }));
}

function legacyExpenseCandidate({ id, payer, description, amountMinor, split, now }) {
  return {
    id,
    payer,
    description,
    amount: amountMinor / 100,
    split,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function calculatorExpenses(records) {
  return records.map((record) => ({
    ...record,
    amount: Number.isSafeInteger(record.amountMinor) ? record.amountMinor / 100 : Number.NaN,
    split: record.splitStatus === 'confirmed' ? record.split : null,
  }));
}

function mutationView(receipt, { scopeKey, replayed }) {
  return {
    changeId: receipt.changeId,
    idempotencyKey: receipt.idempotencyKey,
    scopeKey,
    operation: receipt.operation,
    recordType: receipt.recordType,
    recordId: receipt.recordId,
    recordVersion: receipt.recordVersion,
    status: receipt.status,
    occurredAt: receipt.occurredAt,
    replayed,
  };
}

export class TripService {
  #database;
  #repository;
  #fingerprintKey;
  #clock;

  constructor({
    database = db,
    repository,
    fingerprintKey = null,
    clock = () => new Date(),
  } = {}) {
    if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function') {
      throw new TypeError('A database adapter with prepare() and batch() is required.');
    }
    if (repository && typeof repository.loadAccessibleTripLedger !== 'function') {
      throw new TypeError('repository.loadAccessibleTripLedger() is required.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#database = database;
    this.#repository = repository ?? new FinancialRepository(database);
    this.#fingerprintKey = fingerprintKey;
    this.#clock = clock;
  }

  async #loadLedger(userId, tripId) {
    const ledger = await this.#repository.loadAccessibleTripLedger({ userId, tripId });
    if (!ledger) throw tripError('TRIP_NOT_FOUND', 'Not found', 404);
    return ledger;
  }

  #now() {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('clock must return a valid Date.');
    }
    return new Date(now);
  }

  #fingerprint({ userId, operation, command, expectedTripVersion }) {
    return createMutationRequestFingerprint({
      fingerprintKey: this.#fingerprintKey ?? process.env.FINANCIAL_MUTATION_HMAC_KEY,
      userId,
      operation,
      command,
      expectedRecordVersion: expectedTripVersion,
    });
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

  #assertReplay(receipt, requestFingerprint) {
    if (!fingerprintsMatch(receipt.requestFingerprintHmac, requestFingerprint)) {
      throw tripError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was already used for a different trip command.',
        409,
        { field: 'idempotencyKey' }
      );
    }
  }

  async #recordVersion(userId, recordType, recordId) {
    const row = await this.#database.prepare(
      `SELECT COALESCE(MAX(record_version), 0) AS record_version
         FROM financial_record_changes
        WHERE user_id = ? AND record_type = ? AND record_id = ?`
    ).get(userId, recordType, recordId);
    return toSafeInteger(row?.record_version ?? 0, 'record version');
  }

  async #dataVersion(userId) {
    const value = await this.#repository.getDataVersion(userId);
    if (value === null) throw tripError('USER_NOT_FOUND', 'Authenticated user was not found.', 401);
    return value;
  }

  #tripOutcome(ledger, lastConfirmed = null) {
    return calculateTripOutcome({
      tripId: ledger.trip.id,
      tripVersion: ledger.trip.tripVersion,
      members: ledger.members.records,
      expenses: calculatorExpenses(ledger.expenses.records),
      lastConfirmed,
    });
  }

  async #confirmedResponse({ userId, tripId, receipt, scopeKey, replayed, legacy = {} }) {
    const ledger = await this.#loadLedger(userId, tripId);
    return {
      ...legacy,
      tripVersion: ledger.trip.tripVersion,
      dataVersion: await this.#dataVersion(userId),
      mutation: mutationView(receipt, { scopeKey, replayed }),
      tripOutcome: this.#tripOutcome(ledger),
    };
  }

  async #afterBatchFailure({ userId, idempotencyKey, requestFingerprint, error }) {
    const racedReceipt = await this.#loadReceipt(userId, idempotencyKey);
    if (racedReceipt) {
      this.#assertReplay(racedReceipt, requestFingerprint);
      return racedReceipt;
    }
    const message = String(error?.message ?? '');
    if (/trip_members\.trip_id, trip_members\.name|UNIQUE constraint failed: trip_members/i.test(message)) {
      throw tripError('TRIP_MEMBER_EXISTS', 'Member with that name exists', 409, {}, error);
    }
    if (/trip_expense_personal_links/i.test(message)) {
      throw tripError('PERSONAL_LINK_EXISTS', 'This trip expense is already included.', 409, {}, error);
    }
    throw tripError('TRIP_MUTATION_FAILED', 'Trip change could not be saved.', 500, {}, error);
  }

  #assertExpectedTripVersion(ledger, expectedTripVersion) {
    if (
      expectedTripVersion !== undefined
      && ledger.trip.tripVersion !== expectedTripVersion
    ) {
      throw tripError(
        'TRIP_VERSION_CONFLICT',
        'Trip changed since it was last confirmed.',
        409,
        { currentTripVersion: ledger.trip.tripVersion }
      );
    }
  }

  async addMember({
    userId,
    tripId,
    name,
    email,
    idempotencyKey = randomUUID(),
    expectedTripVersion,
  }) {
    const normalizedUserId = normalizeId(userId, 'userId');
    const normalizedTripId = normalizeId(tripId, 'tripId');
    const key = normalizeIdempotencyKey(idempotencyKey);
    const command = {
      tripId: normalizedTripId,
      name: normalizeMemberName(name),
      email: normalizeEmail(email),
    };
    const expectedVersion = normalizeExpectedTripVersion(expectedTripVersion);
    const fingerprint = this.#fingerprint({
      userId: normalizedUserId,
      operation: 'trip.member.create',
      command,
      expectedTripVersion: expectedVersion,
    });
    const existingReceipt = await this.#loadReceipt(normalizedUserId, key);
    if (existingReceipt) {
      this.#assertReplay(existingReceipt, fingerprint);
      return this.#confirmedResponse({
        userId: normalizedUserId,
        tripId: normalizedTripId,
        receipt: existingReceipt,
        scopeKey: `trip-member:${existingReceipt.recordId}`,
        replayed: true,
        legacy: { id: existingReceipt.recordId },
      });
    }

    const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
    if (ledger.role !== 'owner') throw tripError('TRIP_NOT_FOUND', 'Not found', 404);
    this.#assertExpectedTripVersion(ledger, expectedVersion);
    const statements = [
      {
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, 'trip.member.create', 'trip_member', NULL, 1, 'confirmed')`,
        args: [normalizedUserId, key, fingerprint],
      },
      {
        sql: 'INSERT INTO trip_members (trip_id, name, email) VALUES (?, ?, ?)',
        args: [normalizedTripId, command.name, command.email],
      },
      {
        sql: `UPDATE financial_record_changes
                 SET record_id = last_insert_rowid()
               WHERE user_id = ? AND idempotency_key = ?`,
        args: [normalizedUserId, key],
      },
      {
        sql: `UPDATE trips
                SET trip_version = trip_version + 1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND user_id = ?`,
        args: [normalizedTripId, normalizedUserId],
      },
      ...financialVersionStatements(linkedUserIds(ledger)),
    ];

    try {
      await this.#database.batch(statements);
    } catch (error) {
      const racedReceipt = await this.#afterBatchFailure({
        userId: normalizedUserId,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        error,
      });
      return this.#confirmedResponse({
        userId: normalizedUserId,
        tripId: normalizedTripId,
        receipt: racedReceipt,
        scopeKey: `trip-member:${racedReceipt.recordId}`,
        replayed: true,
        legacy: { id: racedReceipt.recordId },
      });
    }

    const receipt = await this.#loadReceipt(normalizedUserId, key);
    return this.#confirmedResponse({
      userId: normalizedUserId,
      tripId: normalizedTripId,
      receipt,
      scopeKey: `trip-member:${receipt.recordId}`,
      replayed: false,
      legacy: { id: receipt.recordId },
    });
  }

  async addExpense({
    userId,
    tripId,
    payer,
    description,
    amount,
    split,
    idempotencyKey = randomUUID(),
    expectedTripVersion,
  }) {
    const normalizedUserId = normalizeId(userId, 'userId');
    const normalizedTripId = normalizeId(tripId, 'tripId');
    const key = normalizeIdempotencyKey(idempotencyKey);
    const command = {
      tripId: normalizedTripId,
      payer: normalizeMemberName(payer, 'payer'),
      description: normalizeDescription(description),
      amountMinor: normalizeAmountMinor(amount),
      split: normalizeSplit(split),
    };
    const expectedVersion = normalizeExpectedTripVersion(expectedTripVersion);
    const fingerprint = this.#fingerprint({
      userId: normalizedUserId,
      operation: 'trip.expense.create',
      command,
      expectedTripVersion: expectedVersion,
    });
    const existingReceipt = await this.#loadReceipt(normalizedUserId, key);
    if (existingReceipt) {
      this.#assertReplay(existingReceipt, fingerprint);
      return this.#confirmedResponse({
        userId: normalizedUserId,
        tripId: normalizedTripId,
        receipt: existingReceipt,
        scopeKey: `trip-expense:${existingReceipt.recordId}`,
        replayed: true,
        legacy: { id: existingReceipt.recordId },
      });
    }

    const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
    this.#assertExpectedTripVersion(ledger, expectedVersion);
    const payerMember = ledger.members.records.find(({ name }) => name === command.payer);
    if (!payerMember) {
      throw tripError('PAYER_NOT_TRIP_MEMBER', 'Payer must be a trip member.', 400, {
        field: 'payer',
      });
    }
    const isSettlement = command.description.startsWith(LEGACY_SETTLEMENT_PREFIX);
    const callerMembers = ledger.members.records.filter(({ userId: memberUserId }) => (
      memberUserId === normalizedUserId
    ));
    if (
      isSettlement
      && ledger.role !== 'owner'
      && (callerMembers.length !== 1 || callerMembers[0].id !== payerMember.id)
    ) {
      throw tripError(
        'SETTLEMENT_PAYER_NOT_AUTHORIZED',
        'Only the payer or the trip owner can mark a settlement.',
        403
      );
    }

    const candidateId = Math.max(0, ...ledger.expenses.records.map(({ id }) => id)) + 1;
    if (!Number.isSafeInteger(candidateId)) {
      throw tripError('TRIP_EXPENSE_ID_EXHAUSTED', 'Trip expense identifier is unavailable.', 409);
    }
    const confirmedBefore = this.#tripOutcome(ledger);
    const candidateOutcome = calculateTripOutcome({
      tripId: normalizedTripId,
      tripVersion: ledger.trip.tripVersion + 1,
      members: ledger.members.records,
      expenses: [
        ...calculatorExpenses(ledger.expenses.records),
        legacyExpenseCandidate({
          id: candidateId,
          payer: command.payer,
          description: command.description,
          amountMinor: command.amountMinor,
          split: command.split,
          now: this.#now(),
        }),
      ],
      lastConfirmed: confirmedBefore.status === 'available' ? confirmedBefore : null,
    });
    if (candidateOutcome.status !== 'available') {
      const issue = candidateOutcome.invalid?.[0] ?? {};
      throw tripError(
        issue.code ?? 'INVALID_TRIP_EXPENSE',
        issue.message ?? 'Trip expense is invalid.',
        422,
        {
          field: issue.field,
          constraint: issue.constraint,
          tripOutcome: candidateOutcome,
        }
      );
    }

    const statements = [
      {
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, 'trip.expense.create', 'trip_expense', NULL, 1, 'confirmed')`,
        args: [normalizedUserId, key, fingerprint],
      },
      {
        sql: `INSERT INTO trip_expenses
          (trip_id, payer, description, amount, split_json, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        args: [
          normalizedTripId,
          command.payer,
          command.description,
          command.amountMinor / 100,
          JSON.stringify(command.split),
        ],
      },
      {
        sql: `UPDATE financial_record_changes
                 SET record_id = last_insert_rowid()
               WHERE user_id = ? AND idempotency_key = ?`,
        args: [normalizedUserId, key],
      },
      {
        sql: `UPDATE trips
                SET trip_version = trip_version + 1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [normalizedTripId],
      },
      ...financialVersionStatements(linkedUserIds(ledger)),
    ];

    try {
      await this.#database.batch(statements);
    } catch (error) {
      const racedReceipt = await this.#afterBatchFailure({
        userId: normalizedUserId,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        error,
      });
      return this.#confirmedResponse({
        userId: normalizedUserId,
        tripId: normalizedTripId,
        receipt: racedReceipt,
        scopeKey: `trip-expense:${racedReceipt.recordId}`,
        replayed: true,
        legacy: { id: racedReceipt.recordId },
      });
    }

    const receipt = await this.#loadReceipt(normalizedUserId, key);
    return this.#confirmedResponse({
      userId: normalizedUserId,
      tripId: normalizedTripId,
      receipt,
      scopeKey: `trip-expense:${receipt.recordId}`,
      replayed: false,
      legacy: { id: receipt.recordId },
    });
  }

  async #assertAllowedCategory(userId, category) {
    const rows = await this.#database.prepare(
      'SELECT name FROM user_categories WHERE user_id = ? ORDER BY id'
    ).all(userId);
    const allowed = new Set([...DEFAULT_EXPENSE_CATEGORIES, ...rows.map(({ name }) => name)]);
    if (!allowed.has(category)) {
      throw tripError(
        'UNKNOWN_PERSONAL_EXPENSE_CATEGORY',
        'Unknown category — add it in Settings first.',
        400,
        { field: 'category' }
      );
    }
  }

  async #loadPersonalLink(userId, tripId, tripExpenseId) {
    return this.#database.prepare(
      `SELECT link.id, link.expense_log_id, link.included_amount_minor,
              expense.month, expense.category, expense.amount, expense.spent_on
         FROM trip_expense_personal_links link
         JOIN expense_log expense
           ON expense.id = link.expense_log_id AND expense.user_id = link.user_id
        WHERE link.user_id = ? AND link.trip_id = ? AND link.trip_expense_id = ?`
    ).get(userId, tripId, tripExpenseId);
  }

  #eligiblePersonalShare({ ledger, userId, tripExpenseId }) {
    const callerMembers = ledger.members.records.filter(({ userId: memberUserId }) => (
      memberUserId === userId
    ));
    if (callerMembers.length !== 1) {
      throw tripError(
        'PERSONAL_MEMBER_LINK_REQUIRED',
        'Your account must be linked to exactly one trip member before including a personal share.',
        403
      );
    }
    const outcome = this.#tripOutcome(ledger);
    if (outcome.status !== 'available') {
      throw tripError(
        'TRIP_OUTCOME_UNAVAILABLE',
        'The personal share is unavailable until the trip split is valid.',
        422,
        { tripOutcome: outcome }
      );
    }
    const sharedExpense = outcome.value.sharedExpenses.find(({ id }) => id === tripExpenseId);
    const allocation = outcome.value.allocations.find(({ expenseId }) => expenseId === tripExpenseId);
    if (!sharedExpense || !allocation) {
      throw tripError(
        'PERSONAL_LINK_NOT_ELIGIBLE',
        'Only a shared trip expense can be included in personal spending.',
        422
      );
    }
    const share = allocation.allocations.find(({ memberId }) => memberId === callerMembers[0].id);
    if (!share || share.amountMinor <= 0) {
      throw tripError(
        'PERSONAL_LINK_NOT_ELIGIBLE',
        'This trip expense does not allocate a positive personal share to your linked member.',
        422
      );
    }
    const source = ledger.expenses.records.find(({ id }) => id === tripExpenseId);
    return {
      amountMinor: share.amountMinor,
      source,
      member: callerMembers[0],
      tripOutcome: outcome,
    };
  }

  async #commitNoopReceipt({
    userId,
    idempotencyKey,
    fingerprint,
    operation,
    tripExpenseId,
    status,
  }) {
    const recordVersion = await this.#recordVersion(
      userId,
      'trip_personal_link',
      tripExpenseId
    ) + 1;
    try {
      await this.#database.batch([{
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, ?, 'trip_personal_link', ?, ?, ?)`,
        args: [
          userId,
          idempotencyKey,
          fingerprint,
          operation,
          tripExpenseId,
          recordVersion,
          status,
        ],
      }]);
    } catch (error) {
      return this.#afterBatchFailure({
        userId,
        idempotencyKey,
        requestFingerprint: fingerprint,
        error,
      });
    }
    return this.#loadReceipt(userId, idempotencyKey);
  }

  async includePersonalExpense({
    userId,
    tripId,
    tripExpenseId,
    category,
    spentOn,
    idempotencyKey,
  }) {
    const normalizedUserId = normalizeId(userId, 'userId');
    const normalizedTripId = normalizeId(tripId, 'tripId');
    const normalizedExpenseId = normalizeId(tripExpenseId, 'tripExpenseId');
    const key = normalizeIdempotencyKey(idempotencyKey);
    const now = this.#now();
    const command = {
      tripId: normalizedTripId,
      tripExpenseId: normalizedExpenseId,
      category: normalizeCategory(category),
      spentOn: normalizeSpentOn(spentOn, now),
    };
    await this.#assertAllowedCategory(normalizedUserId, command.category);
    const fingerprint = this.#fingerprint({
      userId: normalizedUserId,
      operation: 'trip.personal_link.include',
      command,
    });
    const existingReceipt = await this.#loadReceipt(normalizedUserId, key);
    if (existingReceipt) {
      this.#assertReplay(existingReceipt, fingerprint);
      const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
      return {
        ok: true,
        id: (await this.#loadPersonalLink(
          normalizedUserId,
          normalizedTripId,
          normalizedExpenseId
        ))?.expense_log_id ?? null,
        month: command.spentOn.slice(0, 7),
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(existingReceipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: this.#tripOutcome(ledger),
      };
    }

    const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
    const eligible = this.#eligiblePersonalShare({
      ledger,
      userId: normalizedUserId,
      tripExpenseId: normalizedExpenseId,
    });
    const existingLink = await this.#loadPersonalLink(
      normalizedUserId,
      normalizedTripId,
      normalizedExpenseId
    );
    if (existingLink) {
      if (
        existingLink.category !== command.category
        || existingLink.spent_on !== command.spentOn
        || Number(existingLink.included_amount_minor) !== eligible.amountMinor
      ) {
        throw tripError(
          'PERSONAL_LINK_EXISTS',
          'This trip expense is already included with different personal expense details.',
          409
        );
      }
      const receipt = await this.#commitNoopReceipt({
        userId: normalizedUserId,
        idempotencyKey: key,
        fingerprint,
        operation: 'trip.personal_link.include',
        tripExpenseId: normalizedExpenseId,
        status: 'confirmed',
      });
      return {
        ok: true,
        id: toSafeInteger(existingLink.expense_log_id, 'personal expense id'),
        month: existingLink.month,
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(receipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: eligible.tripOutcome,
      };
    }

    const recordVersion = await this.#recordVersion(
      normalizedUserId,
      'trip_personal_link',
      normalizedExpenseId
    ) + 1;
    const note = `Trip share: ${eligible.source.description}`.slice(0, 120);
    const statements = [
      {
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, 'trip.personal_link.include', 'trip_personal_link', ?, ?, 'confirmed')`,
        args: [
          normalizedUserId,
          key,
          fingerprint,
          normalizedExpenseId,
          recordVersion,
        ],
      },
      {
        sql: `INSERT INTO expense_log
          (user_id, month, category, amount, note, spent_on, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        args: [
          normalizedUserId,
          command.spentOn.slice(0, 7),
          command.category,
          eligible.amountMinor / 100,
          note,
          command.spentOn,
        ],
      },
      {
        sql: `INSERT INTO trip_expense_personal_links
          (user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
          VALUES (?, ?, ?, last_insert_rowid(), ?)`,
        args: [
          normalizedUserId,
          normalizedTripId,
          normalizedExpenseId,
          eligible.amountMinor,
        ],
      },
      ...financialVersionStatements([normalizedUserId]),
    ];

    try {
      const results = await this.#database.batch(statements);
      const receipt = await this.#loadReceipt(normalizedUserId, key);
      return {
        ok: true,
        id: toSafeInteger(results[1].lastInsertRowid, 'personal expense id'),
        month: command.spentOn.slice(0, 7),
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(receipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: false,
        }),
        tripOutcome: eligible.tripOutcome,
      };
    } catch (error) {
      const racedReceipt = await this.#afterBatchFailure({
        userId: normalizedUserId,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        error,
      });
      const link = await this.#loadPersonalLink(
        normalizedUserId,
        normalizedTripId,
        normalizedExpenseId
      );
      return {
        ok: true,
        id: link ? toSafeInteger(link.expense_log_id, 'personal expense id') : null,
        month: command.spentOn.slice(0, 7),
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(racedReceipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: eligible.tripOutcome,
      };
    }
  }

  async removePersonalExpense({ userId, tripId, tripExpenseId, idempotencyKey }) {
    const normalizedUserId = normalizeId(userId, 'userId');
    const normalizedTripId = normalizeId(tripId, 'tripId');
    const normalizedExpenseId = normalizeId(tripExpenseId, 'tripExpenseId');
    const key = normalizeIdempotencyKey(idempotencyKey);
    const command = {
      tripId: normalizedTripId,
      tripExpenseId: normalizedExpenseId,
    };
    const fingerprint = this.#fingerprint({
      userId: normalizedUserId,
      operation: 'trip.personal_link.remove',
      command,
    });
    const existingReceipt = await this.#loadReceipt(normalizedUserId, key);
    if (existingReceipt) {
      this.#assertReplay(existingReceipt, fingerprint);
      const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
      return {
        ok: true,
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(existingReceipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: this.#tripOutcome(ledger),
      };
    }

    const ledger = await this.#loadLedger(normalizedUserId, normalizedTripId);
    // Fail closed unless this user is the one linked to exactly one member.
    const callerMembers = ledger.members.records.filter(({ userId: memberUserId }) => (
      memberUserId === normalizedUserId
    ));
    if (callerMembers.length !== 1) {
      throw tripError(
        'PERSONAL_MEMBER_LINK_REQUIRED',
        'Your account must be linked to exactly one trip member before withdrawing a personal share.',
        403
      );
    }
    const link = await this.#loadPersonalLink(
      normalizedUserId,
      normalizedTripId,
      normalizedExpenseId
    );
    if (!link) {
      const receipt = await this.#commitNoopReceipt({
        userId: normalizedUserId,
        idempotencyKey: key,
        fingerprint,
        operation: 'trip.personal_link.remove',
        tripExpenseId: normalizedExpenseId,
        status: 'reversed',
      });
      return {
        ok: true,
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(receipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: this.#tripOutcome(ledger),
      };
    }

    const recordVersion = await this.#recordVersion(
      normalizedUserId,
      'trip_personal_link',
      normalizedExpenseId
    ) + 1;
    const statements = [
      {
        sql: `INSERT INTO financial_record_changes
          (user_id, idempotency_key, request_fingerprint_hmac, operation,
           record_type, record_id, record_version, status)
          VALUES (?, ?, ?, 'trip.personal_link.remove', 'trip_personal_link', ?, ?, 'reversed')`,
        args: [
          normalizedUserId,
          key,
          fingerprint,
          normalizedExpenseId,
          recordVersion,
        ],
      },
      {
        sql: `DELETE FROM trip_expense_personal_links
              WHERE id = ? AND user_id = ? AND trip_id = ? AND trip_expense_id = ?`,
        args: [link.id, normalizedUserId, normalizedTripId, normalizedExpenseId],
      },
      {
        sql: 'DELETE FROM expense_log WHERE id = ? AND user_id = ?',
        args: [link.expense_log_id, normalizedUserId],
      },
      ...financialVersionStatements([normalizedUserId]),
    ];

    try {
      await this.#database.batch(statements);
    } catch (error) {
      const racedReceipt = await this.#afterBatchFailure({
        userId: normalizedUserId,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        error,
      });
      return {
        ok: true,
        tripVersion: ledger.trip.tripVersion,
        dataVersion: await this.#dataVersion(normalizedUserId),
        mutation: mutationView(racedReceipt, {
          scopeKey: `trip-personal-link:${normalizedExpenseId}`,
          replayed: true,
        }),
        tripOutcome: this.#tripOutcome(ledger),
      };
    }

    const receipt = await this.#loadReceipt(normalizedUserId, key);
    return {
      ok: true,
      tripVersion: ledger.trip.tripVersion,
      dataVersion: await this.#dataVersion(normalizedUserId),
      mutation: mutationView(receipt, {
        scopeKey: `trip-personal-link:${normalizedExpenseId}`,
        replayed: false,
      }),
      tripOutcome: this.#tripOutcome(ledger),
    };
  }
}

const tripService = new TripService();
export default tripService;
