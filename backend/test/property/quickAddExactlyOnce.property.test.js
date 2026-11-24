import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  BUILT_IN_CATEGORIES,
  permutationArb,
  saveScenarioArb,
} from '../helpers/quickAddGenerators.js';

/*
 * Feature: quick-add-daily-answer, Property 19: Quick Add saves exactly once under replay and concurrency
 *
 * Validates: Requirements 7.9, 7.14, 7.15, 17.11, 17.12
 *
 * The property runs the real FinancialMutationService with the real expense.create and expense.update operation
 * handlers on an isolated file database. Distinct create commands start concurrently. Once their receipts have
 * committed, generated replays and conflicting key reuses start while the original responses are still pending.
 * Snapshot delivery follows a generated permutation, so response order cannot affect the reference ledger.
 * The reference model below is independent of the mutation service and compares source rows, receipts, data and
 * record versions, exclusion storage, change identity, and replay snapshots. Counterexamples are redacted by
 * propertyReport.js. Set PM_PROPERTY_TRACE=1 to print the underlying assertion while debugging.
 */

const NOW = new Date('2026-01-15T06:30:00.000Z');
const TODAY = '2026-01-15';
const RUNS = 100;
const MAX_ENTRIES = 4;
const FIRST_USER_ID = 919_000;
const FINGERPRINT_KEY = 'quick-add-property-fingerprint-key-2026';
const EXCLUSION_MODES = Object.freeze(['omitted', 'false', 'true']);
const CONFLICT_VARIANTS = Object.freeze(['body', 'command', 'record']);
const SAVE_CATEGORIES = Object.freeze(
  BUILT_IN_CATEGORIES.filter((category) => category !== 'Rent' && category !== 'Utilities'),
);

let testDatabase;
let db;
let FinancialRepository;
let ClarityService;
let createExpenseMutationService;
let normalizeExpenseCreateCommand;
let normalizeExpenseUpdateCommand;
let nextUserId = FIRST_USER_ID;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  ({
    createExpenseMutationService,
    normalizeExpenseCreateCommand,
    normalizeExpenseUpdateCommand,
  } = await import('../../src/services/expenseMutations.js'));
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

/* ------------------------------------------------------ generated commands */

function validDistinctUuid(debugKey, index) {
  const uuid = debugKey.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
  assert.ok(uuid, 'the shared save generator supplies a UUID');
  return `${uuid.slice(0, -12)}${String(index + 1).padStart(12, '0')}`.toLowerCase();
}

function scenarioArb() {
  return saveScenarioArb({
    today: TODAY,
    maxEntries: MAX_ENTRIES,
    categories: SAVE_CATEGORIES,
  })
    .chain((base) => fc.array(fc.constantFrom(...EXCLUSION_MODES), {
      minLength: base.entries.length,
      maxLength: base.entries.length,
    }).chain((exclusionModes) => {
      let generatedConflict = 0;
      const generatedCommands = base.sends.map((command) => {
        if (command.kind !== 'conflict') return { ...command };
        const variant = CONFLICT_VARIANTS[generatedConflict % CONFLICT_VARIANTS.length];
        generatedConflict += 1;
        return { ...command, variant };
      });
      const commands = [
        ...generatedCommands,
        { entry: 0, kind: 'replay' },
        ...CONFLICT_VARIANTS.map((variant, index) => ({
          entry: index % base.entries.length,
          kind: 'conflict',
          variant,
        })),
      ];
      return fc.tuple(permutationArb(commands.length), permutationArb(commands.length))
        .map(([sendOrder, responseOrder]) => ({
          entries: base.entries.map((entry, index) => {
            const { excludeFromDailyAllowance: _generatedMark, ...fields } = entry;
            return {
              ...fields,
              idempotencyKey: validDistinctUuid(entry.idempotencyKey, index),
              exclusionMode: exclusionModes[index],
            };
          }),
          commands,
          sendOrder,
          responseOrder,
        }));
    }));
}

function requestBody(entry) {
  const body = {
    amountMinor: entry.amountMinor,
    category: entry.category,
    note: entry.note,
    spentOn: entry.spentOn,
    expectedRecordVersion: 0,
  };
  if (entry.exclusionMode === 'true') body.excludeFromDailyAllowance = true;
  if (entry.exclusionMode === 'false') body.excludeFromDailyAllowance = false;
  return body;
}

function createInput(userId, entry, body = requestBody(entry)) {
  const { command, expectedRecordVersion } = normalizeExpenseCreateCommand(body, NOW);
  return {
    userId,
    idempotencyKey: entry.idempotencyKey,
    operation: 'expense.create',
    command,
    expectedRecordVersion,
  };
}

function differentCategory(category) {
  const position = BUILT_IN_CATEGORIES.indexOf(category);
  return BUILT_IN_CATEGORIES[(position + 1) % BUILT_IN_CATEGORIES.length];
}

/* --------------------------------------------------------- snapshot order */

class SnapshotGate {
  constructor(delegate) {
    this.delegate = delegate;
    this.pending = new Map();
    this.captured = new Set();
    this.tokenWaiters = new Map();
    this.open = false;
  }

  capture(token, args) {
    if (this.open) return this.delegate.getSnapshot(args);
    assert.equal(this.captured.has(token), false, 'one snapshot request per command');
    this.captured.add(token);
    const promise = new Promise((resolve, reject) => {
      this.pending.set(token, { args, resolve, reject });
    });
    this.#notify();
    return promise;
  }

  #notify() {
    for (const [token, waiters] of this.tokenWaiters) {
      if (!this.captured.has(token)) continue;
      this.tokenWaiters.delete(token);
      for (const waiter of waiters) waiter();
    }
  }

  waitForToken(token) {
    if (this.captured.has(token)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.tokenWaiters.get(token) ?? [];
      waiters.push(resolve);
      this.tokenWaiters.set(token, waiters);
    });
  }

  has(token) {
    return this.pending.has(token);
  }

  release(token) {
    const held = this.pending.get(token);
    assert.ok(held, 'the response is held by the snapshot gate');
    this.pending.delete(token);
    Promise.resolve()
      .then(() => this.delegate.getSnapshot(held.args))
      .then(held.resolve, held.reject);
  }

  releaseAll() {
    this.open = true;
    for (const token of [...this.pending.keys()]) this.release(token);
  }
}

/* -------------------------------------------------------------- database */

async function createUser() {
  const id = nextUserId;
  nextUserId += 1;
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, `quick-add-property-${id}@example.test`, `Property User ${id}`, 'test-password-hash');
  return id;
}

async function seedStartingExpense(userId) {
  const result = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on, exclude_from_daily_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, '2025-12', 'Other', 777.77, 'Starting ledger row', '2025-12-31', null);
  return {
    id: Number(result.lastInsertRowid),
    month: '2025-12',
    category: 'Other',
    amountMinor: 77_777,
    note: 'Starting ledger row',
    spentOn: '2025-12-31',
    exclusionStored: null,
  };
}

async function receiptFor(userId, idempotencyKey) {
  return db.prepare(
    `SELECT id, record_id
       FROM financial_record_changes
      WHERE user_id = ? AND idempotency_key = ?`
  ).get(userId, idempotencyKey);
}

async function readState(userId) {
  const [ledgerRows, receiptRows, versionRow] = await Promise.all([
    db.prepare(
      `SELECT id, month, category, amount, note, spent_on, exclude_from_daily_allowance
         FROM expense_log
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId),
    db.prepare(
      `SELECT id, idempotency_key, operation, record_type, record_id, record_version, status
         FROM financial_record_changes
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId),
    db.prepare('SELECT data_version FROM user_financial_state WHERE user_id = ?').get(userId),
  ]);
  return {
    ledger: ledgerRows.map((row) => ({
      id: Number(row.id),
      month: row.month,
      category: row.category,
      amountMinor: Math.round(Number(row.amount) * 100),
      note: row.note ?? null,
      spentOn: row.spent_on,
      exclusionStored: row.exclude_from_daily_allowance === null
        ? null
        : Number(row.exclude_from_daily_allowance),
    })),
    receipts: receiptRows.map((row) => ({
      changeId: Number(row.id),
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      recordType: row.record_type,
      recordId: Number(row.record_id),
      recordVersion: Number(row.record_version),
      status: row.status,
    })),
    dataVersion: versionRow ? Number(versionRow.data_version) : 0,
  };
}

/* --------------------------------------------------------- reference model */

function referenceRecord(entry, recordId) {
  return {
    id: recordId,
    month: entry.spentOn.slice(0, 7),
    category: entry.category,
    amountMinor: entry.amountMinor,
    note: entry.note === '' ? null : entry.note,
    spentOn: entry.spentOn,
    exclusionStored: entry.exclusionMode === 'true' ? 1 : null,
  };
}

function trace(error) {
  if (process.env.PM_PROPERTY_TRACE === '1') console.error(`PM_PROPERTY_TRACE: ${error?.stack ?? error}`);
}

async function conflictInput(userId, entry, variant) {
  if (variant === 'body') {
    return createInput(userId, entry, {
      ...requestBody(entry),
      amountMinor: entry.amountMinor + 1,
    });
  }
  if (variant === 'command') {
    const input = createInput(userId, entry);
    return {
      ...input,
      command: { ...input.command, category: differentCategory(input.command.category) },
    };
  }
  const receipt = await receiptFor(userId, entry.idempotencyKey);
  assert.ok(receipt, 'the original key has a committed receipt before conflicting record reuse');
  const { command, expectedRecordVersion } = normalizeExpenseUpdateCommand({
    amountMinor: entry.amountMinor + 1,
    expectedRecordVersion: 0,
  }, Number(receipt.record_id), NOW);
  return {
    userId,
    idempotencyKey: entry.idempotencyKey,
    operation: 'expense.update',
    command,
    expectedRecordVersion,
  };
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

async function assertSnapshotsCaptured(tokens, requests, gate, label) {
  const states = await Promise.all(tokens.map((token) => Promise.race([
    gate.waitForToken(token).then(() => ({ kind: 'captured' })),
    requests.get(token).then((outcome) => ({ kind: 'settled', outcome })),
  ])));
  for (const state of states) {
    assert.equal(state.kind, 'captured', `${label} reaches snapshot assembly after committing`);
  }
}

async function runScenario(scenario) {
  const userId = await createUser();
  const startingRecord = await seedStartingExpense(userId);
  const repository = new FinancialRepository(db);
  const clarityService = new ClarityService({ repository });
  const gate = new SnapshotGate(clarityService);
  const requests = new Map();
  const outcomes = new Map();

  const launch = (token) => {
    const descriptor = scenario.commands[token];
    const entry = scenario.entries[descriptor.entry];
    const promise = settled((async () => {
      const input = descriptor.kind === 'conflict'
        ? await conflictInput(userId, entry, descriptor.variant)
        : createInput(userId, entry);
      const service = createExpenseMutationService({
        database: db,
        snapshotService: {
          getSnapshot(args) {
            return gate.capture(token, args);
          },
        },
        fingerprintKey: FINGERPRINT_KEY,
        clock: () => new Date(NOW),
      });
      return service.execute(input);
    })());
    requests.set(token, promise);
  };

  try {
    const firstTokens = scenario.sendOrder.filter((token) => scenario.commands[token].kind === 'first');
    for (const token of firstTokens) launch(token);
    await assertSnapshotsCaptured(firstTokens, requests, gate, 'each distinct-key save');

    const laterTokens = scenario.sendOrder.filter((token) => scenario.commands[token].kind !== 'first');
    for (const token of laterTokens) launch(token);
    const replayTokens = laterTokens.filter((token) => scenario.commands[token].kind === 'replay');
    await assertSnapshotsCaptured(replayTokens, requests, gate, 'each same-key replay');

    for (const token of scenario.responseOrder) {
      const descriptor = scenario.commands[token];
      if (gate.has(token)) {
        gate.release(token);
      } else if (descriptor.kind !== 'conflict') {
        await gate.waitForToken(token);
        gate.release(token);
      } else {
        const state = await Promise.race([
          requests.get(token).then(() => 'settled'),
          gate.waitForToken(token).then(() => 'captured'),
        ]);
        if (state === 'captured') gate.release(token);
      }
      outcomes.set(token, await requests.get(token));
    }

    const firstByEntry = new Map();
    for (const [token, descriptor] of scenario.commands.entries()) {
      const outcome = outcomes.get(token);
      assert.ok(outcome, 'every generated response is observed');
      if (descriptor.kind === 'conflict') {
        assert.equal(outcome.status, 'rejected', `conflicting ${descriptor.variant} reuse is refused`);
        assert.equal(outcome.reason?.code, 'IDEMPOTENCY_KEY_REUSED', `conflicting ${descriptor.variant} code`);
        assert.equal(outcome.reason?.httpStatus, 409, `conflicting ${descriptor.variant} status`);
        continue;
      }
      assert.equal(outcome.status, 'fulfilled', `${descriptor.kind} request succeeds`);
      if (descriptor.kind === 'first') firstByEntry.set(descriptor.entry, outcome.value);
    }

    assert.equal(firstByEntry.size, scenario.entries.length, 'every distinct key has one first result');
    for (const [token, descriptor] of scenario.commands.entries()) {
      if (descriptor.kind !== 'replay') continue;
      const replay = outcomes.get(token).value;
      const first = firstByEntry.get(descriptor.entry);
      assert.equal(replay.mutation.replayed, true, 'same-key replay is identified');
      assert.equal(replay.mutation.changeId, first.mutation.changeId, 'replay returns the same change');
      assert.equal(replay.mutation.recordId, first.mutation.recordId, 'replay returns the same record');
      assert.equal(replay.mutation.recordVersion, first.mutation.recordVersion, 'replay returns the same record version');
      assert.deepEqual(replay.clarity, first.clarity, 'replay returns the same committed snapshot');
    }

    const state = await readState(userId);
    const expectedLedger = [
      startingRecord,
      ...scenario.entries.map((entry, index) => {
        const result = firstByEntry.get(index);
        assert.equal(result.mutation.replayed, false, 'the first distinct-key save is not a replay');
        assert.equal(result.mutation.recordVersion, 1, 'a created expense starts at record version one');
        assert.equal(result.clarity.dataVersion, scenario.entries.length, 'every response snapshot has the final version');
        return referenceRecord(entry, result.mutation.recordId);
      }),
    ].sort((left, right) => left.id - right.id);
    assert.deepEqual(state.ledger, expectedLedger, 'the final expense ledger matches the independent model');

    const expectedReceipts = scenario.entries.map((entry, index) => {
      const result = firstByEntry.get(index);
      return {
        changeId: result.mutation.changeId,
        idempotencyKey: entry.idempotencyKey,
        operation: 'expense.create',
        recordType: 'expense',
        recordId: result.mutation.recordId,
        recordVersion: 1,
        status: 'confirmed',
      };
    }).sort((left, right) => left.changeId - right.changeId);
    assert.deepEqual(state.receipts, expectedReceipts, 'one receipt and change exist per accepted logical save');
    assert.equal(state.dataVersion, scenario.entries.length, 'only distinct accepted saves increment dataVersion');
    assert.equal(new Set(state.receipts.map(({ recordId }) => recordId)).size, scenario.entries.length, 'each logical save owns one source row');
    assert.equal(new Set(state.receipts.map(({ changeId }) => changeId)).size, scenario.entries.length, 'each logical save owns one change');
  } catch (error) {
    trace(error);
    throw error;
  } finally {
    gate.releaseAll();
    await Promise.all(requests.values());
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

/* ------------------------------------------ Property 19: exactly-once save */

test('Property 19: real expense saves are exactly once under replay, conflict, and concurrent response permutations', { timeout: 600_000 }, async () => {
  await assertProperty(
    fc.asyncProperty(scenarioArb(), runScenario),
    { numRuns: RUNS },
  );
});
