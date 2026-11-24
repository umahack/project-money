import '../helpers/blockingStdout.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty } from '../helpers/propertyReport.js';
import {
  BUILT_IN_CATEGORIES,
  noteArb,
} from '../helpers/quickAddGenerators.js';

/*
 * Feature: quick-add-daily-answer, Property 20: Save then undo restores the ledger and server outcomes
 *
 * Validates: Requirements 8.2, 8.3, 8.4, 8.5, 8.13, 17.13, 18.21
 *
 * The property runs the real FinancialMutationService, expense handlers, ClarityService, and CategoryMemoryService
 * on an isolated file database. Its ledger model inserts, updates, and removes records by ID without calling any
 * production transition or calculation function. Each generated case exercises omitted, false, and true exclusion
 * inputs. One existing expense deliberately has the saved entry's amount, note, date, and category. Memory
 * compensation is driven here because the frontend undo action is not built yet; stable revisions restore the prior
 * semantic state, while a later memory revision is preserved. Data and record versions and receipts are monotonic,
 * so they are checked separately rather than treated as fields that undo removes.
 */

const NOW = new Date('2026-01-15T06:30:00.000Z');
const MONTH = '2026-01';
const TODAY = '2026-01-15';
const RUNS = 100;
const FIRST_USER_ID = 929_000;
const FINGERPRINT_KEY = 'quick-add-save-undo-property-fingerprint-key-2026';
const EXCLUSION_MODES = Object.freeze(['omitted', 'false', 'true']);
const MEMORY_MODES = Object.freeze(['none', 'stable', 'newer']);
// The expense service accepts only its own built-in list, which has no Rent or Utilities.
const SAVE_CATEGORIES = Object.freeze(
  BUILT_IN_CATEGORIES.filter((category) => category !== 'Rent' && category !== 'Utilities'),
);
const CURRENT_MONTH_DATES = Object.freeze([
  '2026-01-01',
  '2026-01-14',
  TODAY,
  '2026-01-16',
  '2026-01-31',
]);

let testDatabase;
let db;
let FinancialRepository;
let ClarityService;
let CategoryMemoryService;
let createExpenseMutationService;
let normalizeExpenseCreateCommand;
let normalizeExpenseUpdateCommand;
let normalizeExpenseDeleteCommand;
let nextUserId = FIRST_USER_ID;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ FinancialRepository } = await import('../../src/repositories/financialRepository.js'));
  ({ ClarityService } = await import('../../src/services/clarityService.js'));
  ({ CategoryMemoryService } = await import('../../src/services/categoryMemory.js'));
  ({
    createExpenseMutationService,
    normalizeExpenseCreateCommand,
    normalizeExpenseUpdateCommand,
    normalizeExpenseDeleteCommand,
  } = await import('../../src/services/expenseMutations.js'));
  await testDatabase.reset();
});

after(async () => {
  await testDatabase?.cleanup();
});

/* -------------------------------------------------------------- generators */

const startingExpenseArb = fc.record({
  amountMinor: fc.integer({ min: 1, max: 2_000_000 }),
  categoryIndex: fc.integer({ min: 0, max: SAVE_CATEGORIES.length - 1 }),
  note: noteArb({ maxWords: 3, tricky: true }),
  spentOn: fc.constantFrom(...CURRENT_MONTH_DATES),
  marked: fc.boolean(),
});

const auxiliaryMemoryArb = fc.array(fc.record({
  keyPart: fc.stringMatching(/^[a-z]{1,8}$/),
  categoryIndex: fc.integer({ min: 0, max: SAVE_CATEGORIES.length - 1 }),
}), { minLength: 0, maxLength: 3 });

function scenarioArb() {
  return fc.record({
    idempotencyBase: fc.uuid(),
    salaryMinor: fc.integer({ min: 100_000, max: 50_000_000 }),
    billAmountsMinor: fc.array(fc.integer({ min: 1, max: 10_000_000 }), {
      minLength: 0,
      maxLength: 2,
    }),
    startingExpenses: fc.array(startingExpenseArb, { minLength: 0, maxLength: 5 }),
    entryAmountMinor: fc.integer({ min: 1, max: 5_000_000 }),
    entryNoteKey: fc.stringMatching(/^[a-z]{1,12}$/),
    categoryIndex: fc.integer({ min: 0, max: SAVE_CATEGORIES.length - 1 }),
    duplicateMarked: fc.boolean(),
    targetMemoryExists: fc.boolean(),
    auxiliaryMemory: auxiliaryMemoryArb,
    categoryChangeOffset: fc.integer({ min: 0, max: 1 }),
    memoryModeOffset: fc.integer({ min: 0, max: MEMORY_MODES.length - 1 }),
  });
}

function categoryAt(start, offset = 0) {
  return SAVE_CATEGORIES[(start + offset) % SAVE_CATEGORIES.length];
}

function derivedUuid(base, index) {
  return `${base.slice(0, -12)}${index.toString(16).padStart(12, '0')}`.toLowerCase();
}

/* ------------------------------------------------------- independent models */

class LedgerModel {
  constructor(records = []) {
    this.records = new Map(records.map((record) => [record.id, structuredClone(record)]));
  }

  clone() {
    return new LedgerModel(this.rows());
  }

  insert(record) {
    assert.equal(this.records.has(record.id), false, 'created record ID is new to the model');
    this.records.set(record.id, structuredClone(record));
  }

  updateCategory(id, category) {
    const current = this.records.get(id);
    assert.ok(current, 'the model updates the created record by ID');
    this.records.set(id, { ...current, category });
  }

  remove(id) {
    assert.equal(this.records.delete(id), true, 'the model removes the created record by ID');
  }

  rows() {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.id - right.id);
  }
}

function memoryModelRows(model) {
  return [...model.entries()]
    .map(([noteKey, category]) => ({ noteKey, category }))
    .sort((left, right) => left.noteKey.localeCompare(right.noteKey));
}

function actualMemoryRows(entries) {
  return entries
    .map(({ noteKey, category }) => ({ noteKey, category }))
    .sort((left, right) => left.noteKey.localeCompare(right.noteKey));
}

/* -------------------------------------------------------------- database */

async function createUser() {
  const id = nextUserId;
  nextUserId += 1;
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, `quick-add-undo-${id}@example.test`, `Undo Property User ${id}`, 'test-password-hash');
  return id;
}

async function insertExpense(userId, spec) {
  const result = await db.prepare(
    `INSERT INTO expense_log
      (user_id, month, category, amount, note, spent_on,
       exclude_from_daily_allowance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    MONTH,
    spec.category,
    spec.amountMinor / 100,
    spec.note === '' ? null : spec.note,
    spec.spentOn,
    spec.marked ? 1 : null,
    `${spec.spentOn}T00:00:00.000Z`,
    `${spec.spentOn}T00:00:00.000Z`,
  );
  return {
    id: Number(result.lastInsertRowid),
    month: MONTH,
    category: spec.category,
    amountMinor: spec.amountMinor,
    note: spec.note === '' ? null : spec.note,
    spentOn: spec.spentOn,
    exclusionStored: spec.marked ? 1 : null,
  };
}

async function seedFinancialState(userId, scenario, entryCategory) {
  const stamp = '2026-01-01T00:00:00.000Z';
  await db.prepare(
    `INSERT INTO salary_entries (user_id, month, amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, MONTH, scenario.salaryMinor / 100, stamp, stamp);

  for (const [index, amountMinor] of scenario.billAmountsMinor.entries()) {
    await db.prepare(
      `INSERT INTO emis
        (user_id, label, amount, category, active, effective_from_month,
         effective_to_month, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(userId, `Property bill ${index}`, amountMinor / 100, 'Rent', MONTH, MONTH, stamp, stamp);
  }

  const records = [];
  for (const spec of scenario.startingExpenses) {
    records.push(await insertExpense(userId, {
      amountMinor: spec.amountMinor,
      category: categoryAt(spec.categoryIndex),
      note: spec.note,
      spentOn: spec.spentOn,
      marked: spec.marked,
    }));
  }
  records.push(await insertExpense(userId, {
    amountMinor: scenario.entryAmountMinor,
    category: entryCategory,
    note: scenario.entryNoteKey,
    spentOn: TODAY,
    marked: scenario.duplicateMarked,
  }));
  return new LedgerModel(records);
}

async function readLedger(userId) {
  const rows = await db.prepare(
    `SELECT id, month, category, amount, note, spent_on, exclude_from_daily_allowance
       FROM expense_log
      WHERE user_id = ?
      ORDER BY id`
  ).all(userId);
  return rows.map((row) => ({
    id: Number(row.id),
    month: row.month,
    category: row.category,
    amountMinor: Math.round(Number(row.amount) * 100),
    note: row.note ?? null,
    spentOn: row.spent_on,
    exclusionStored: row.exclude_from_daily_allowance === null
      ? null
      : Number(row.exclude_from_daily_allowance),
  }));
}

async function readFinancialState(userId) {
  const [receipts, version] = await Promise.all([
    db.prepare(
      `SELECT id, idempotency_key, operation, record_id, record_version, status
         FROM financial_record_changes
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId),
    db.prepare('SELECT data_version FROM user_financial_state WHERE user_id = ?').get(userId),
  ]);
  return {
    receipts: receipts.map((row) => ({
      changeId: Number(row.id),
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      recordId: Number(row.record_id),
      recordVersion: Number(row.record_version),
      status: row.status,
    })),
    dataVersion: version ? Number(version.data_version) : 0,
  };
}

/* ---------------------------------------------------------- service inputs */

function createInput(userId, idempotencyKey, entry, exclusionMode) {
  const body = {
    amountMinor: entry.amountMinor,
    category: entry.category,
    note: entry.note,
    spentOn: entry.spentOn,
    expectedRecordVersion: 0,
  };
  if (exclusionMode === 'true') body.excludeFromDailyAllowance = true;
  if (exclusionMode === 'false') body.excludeFromDailyAllowance = false;
  const normalized = normalizeExpenseCreateCommand(body, NOW);
  assert.equal(
    Object.hasOwn(normalized.command, 'excludeFromDailyAllowance'),
    exclusionMode === 'true',
    'only true is retained in the normalized create command',
  );
  return {
    userId,
    idempotencyKey,
    operation: 'expense.create',
    ...normalized,
  };
}

function updateCategoryInput(userId, idempotencyKey, recordId, category) {
  return {
    userId,
    idempotencyKey,
    operation: 'expense.update',
    ...normalizeExpenseUpdateCommand({
      category,
      expectedRecordVersion: 1,
    }, recordId, NOW),
  };
}

function deleteInput(userId, idempotencyKey, recordId) {
  const normalized = normalizeExpenseDeleteCommand({}, recordId);
  assert.equal(normalized.expectedRecordVersion, undefined, 'undo sends no expected record version');
  return {
    userId,
    idempotencyKey,
    operation: 'expense.delete',
    ...normalized,
  };
}

/* ------------------------------------------------------ restored snapshots */

function withoutDataVersions(value) {
  if (Array.isArray(value)) return value.map(withoutDataVersions);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'dataVersion')
      .map(([key, child]) => [key, withoutDataVersions(child)]),
  );
}

function allowanceValues(snapshot) {
  assert.equal(snapshot.outcomes.monthlyPlan.status, 'available', 'the generated plan is available');
  assert.equal(snapshot.outcomes.spending.status, 'available', 'the generated spending outcome is available');
  assert.equal(snapshot.outcomes.todayAllowance.status, 'available', 'the generated today outcome is available');
  return {
    monthlyRemainingSpendable: snapshot.outcomes.monthlyPlan.value.remainingSpendable.amountMinor,
    spendingRemainingSpendable: snapshot.outcomes.spending.value.remainingSpendable.amountMinor,
    todaySpent: snapshot.outcomes.todayAllowance.value.todaySpent.amountMinor,
    todayAllowance: snapshot.outcomes.todayAllowance.value.todayAllowance.amountMinor,
    leftToday: snapshot.outcomes.todayAllowance.value.leftToday.amountMinor,
  };
}

function assertSnapshotRestored(beforeSnapshot, afterSnapshot) {
  assert.deepEqual(
    withoutDataVersions(afterSnapshot.outcomes),
    withoutDataVersions(beforeSnapshot.outcomes),
    'every server outcome returns to its before-save value',
  );
  const { outcomes: _beforeOutcomes, ...beforeEnvelope } = beforeSnapshot;
  const { outcomes: _afterOutcomes, ...afterEnvelope } = afterSnapshot;
  assert.deepEqual(
    withoutDataVersions(afterEnvelope),
    withoutDataVersions(beforeEnvelope),
    'the restored outcomes retain the same period, facts, actions, and highlights',
  );
  assert.deepEqual(
    allowanceValues(afterSnapshot),
    allowanceValues(beforeSnapshot),
    'Remaining_Spendable, Today_Spent, Today_Allowance, and Left_Today are restored',
  );
}

/* ------------------------------------------------------ memory compensation */

async function seedMemory(memoryService, userId, scenario, memoryModel, previousCategory) {
  if (scenario.targetMemoryExists) {
    await memoryService.upsert(userId, {
      noteKey: scenario.entryNoteKey,
      category: previousCategory,
    });
    memoryModel.set(scenario.entryNoteKey, previousCategory);
  }
  for (const [index, entry] of scenario.auxiliaryMemory.entries()) {
    const noteKey = `aux-${index}-${entry.keyPart}`;
    const category = categoryAt(entry.categoryIndex);
    await memoryService.upsert(userId, { noteKey, category });
    memoryModel.set(noteKey, category);
  }
}

async function beginMemoryChange({
  memoryService,
  userId,
  noteKey,
  writtenCategory,
  laterCategory,
  mode,
  memoryModel,
}) {
  const beforeEntries = await memoryService.list(userId);
  assert.deepEqual(actualMemoryRows(beforeEntries), memoryModelRows(memoryModel), 'memory begins at the model state');
  const prior = beforeEntries.find((entry) => entry.noteKey === noteKey) ?? null;
  const beforeRows = memoryModelRows(memoryModel);
  if (mode === 'none') {
    return async () => {
      assert.deepEqual(actualMemoryRows(await memoryService.list(userId)), beforeRows, 'no memory write stays unchanged');
    };
  }

  assert.notEqual(prior?.category, writtenCategory, 'a modeled save changes category memory');
  const written = await memoryService.upsert(userId, {
    noteKey,
    category: writtenCategory,
    ...(prior ? { expectedRevision: prior.revision } : {}),
  });
  memoryModel.set(noteKey, writtenCategory);
  assert.deepEqual(actualMemoryRows(await memoryService.list(userId)), memoryModelRows(memoryModel), 'save memory state matches the model');

  if (mode === 'newer') {
    assert.notEqual(laterCategory, writtenCategory, 'the later category differs from the save write');
    const newer = await memoryService.upsert(userId, {
      noteKey,
      category: laterCategory,
      expectedRevision: written.entry.revision,
    });
    memoryModel.set(noteKey, laterCategory);
    assert.deepEqual(actualMemoryRows(await memoryService.list(userId)), memoryModelRows(memoryModel), 'later memory state matches the model');
    return async () => {
      await assert.rejects(
        prior
          ? memoryService.upsert(userId, {
              noteKey,
              category: prior.category,
              expectedRevision: written.entry.revision,
            })
          : memoryService.remove(userId, written.entry.id, {
              expectedRevision: written.entry.revision,
            }),
        (error) => error?.code === 'MEMORY_REVISION_CONFLICT' && error?.httpStatus === 409,
        'undo compensation refuses to overwrite a newer memory revision',
      );
      assert.deepEqual(actualMemoryRows(await memoryService.list(userId)), memoryModelRows(memoryModel), 'the newer memory change is preserved');
    };
  }

  return async () => {
    if (prior) {
      const restored = await memoryService.upsert(userId, {
        noteKey,
        category: prior.category,
        expectedRevision: written.entry.revision,
      });
      assert.ok(restored.entry.revision > prior.revision, 'memory revision remains monotonic after restoration');
      memoryModel.set(noteKey, prior.category);
    } else {
      await memoryService.remove(userId, written.entry.id, {
        expectedRevision: written.entry.revision,
      });
      memoryModel.delete(noteKey);
    }
    assert.deepEqual(actualMemoryRows(await memoryService.list(userId)), beforeRows, 'undo restores the prior semantic memory state');
  };
}

/* ------------------------------------------------------------- assertions */

function assertReceiptSuffix({
  beforeState,
  afterState,
  createKey,
  updateKey,
  deleteKey,
  createdId,
  changedCategory,
}) {
  assert.deepEqual(
    afterState.receipts.slice(0, beforeState.receipts.length),
    beforeState.receipts,
    'undo never rewrites an earlier receipt',
  );
  const suffix = afterState.receipts.slice(beforeState.receipts.length);
  const expected = [
    { key: createKey, operation: 'expense.create', recordVersion: 1, status: 'confirmed' },
    ...(changedCategory
      ? [{ key: updateKey, operation: 'expense.update', recordVersion: 2, status: 'confirmed' }]
      : []),
    {
      key: deleteKey,
      operation: 'expense.delete',
      recordVersion: changedCategory ? 3 : 2,
      // A delete receipt is recorded as 'reversed' by the mutation service's documented default.
      status: 'reversed',
    },
  ];
  assert.equal(suffix.length, expected.length, 'only accepted create, category update, and undo leave receipts');
  for (const [index, receipt] of suffix.entries()) {
    assert.equal(receipt.idempotencyKey, expected[index].key, 'receipt keeps the operation key');
    assert.equal(receipt.operation, expected[index].operation, 'receipt keeps the operation kind');
    assert.equal(receipt.recordId, createdId, 'every cycle receipt targets the created expense ID');
    assert.equal(receipt.recordVersion, expected[index].recordVersion, 'record versions increase once per accepted change');
    assert.equal(
      receipt.status,
      expected[index].status,
      'create and update receipts are confirmed and the undo delete receipt is reversed',
    );
    if (index > 0) assert.ok(receipt.changeId > suffix[index - 1].changeId, 'change IDs are monotonic');
  }
  assert.equal(
    afterState.dataVersion,
    beforeState.dataVersion + expected.length,
    'dataVersion increases once per accepted create, update, and delete',
  );
}

async function assertLedger(userId, model, message) {
  assert.deepEqual(await readLedger(userId), model.rows(), message);
}

/* ----------------------------------------------------------- one lifecycle */

async function runLifecycle({
  scenario,
  cycle,
  userId,
  mutationService,
  clarityService,
  memoryService,
  ledgerModel,
  memoryModel,
  entryCategory,
  updatedCategory,
  laterMemoryCategory,
}) {
  const exclusionMode = EXCLUSION_MODES[cycle];
  const changedCategory = (cycle + scenario.categoryChangeOffset) % 2 === 0;
  const memoryMode = MEMORY_MODES[(cycle + scenario.memoryModeOffset) % MEMORY_MODES.length];
  const createKey = derivedUuid(scenario.idempotencyBase, cycle * 8 + 1);
  const updateKey = derivedUuid(scenario.idempotencyBase, cycle * 8 + 2);
  const deleteKey = derivedUuid(scenario.idempotencyBase, cycle * 8 + 3);
  const missingDeleteKey = derivedUuid(scenario.idempotencyBase, cycle * 8 + 4);
  const entry = {
    amountMinor: scenario.entryAmountMinor,
    category: entryCategory,
    note: scenario.entryNoteKey,
    spentOn: TODAY,
  };

  await assertLedger(userId, ledgerModel, 'the generated starting ledger matches the independent model');
  const beforeSnapshot = await clarityService.getSnapshot({
    userId,
    month: MONTH,
    now: NOW,
    timeZone: 'Asia/Kolkata',
  });
  const beforeFinancialState = await readFinancialState(userId);
  const cycleModel = ledgerModel.clone();

  const createRequest = createInput(userId, createKey, entry, exclusionMode);
  const saved = await mutationService.execute(createRequest);
  const createdId = saved.mutation.recordId;
  assert.equal(saved.mutation.recordVersion, 1, 'the saved expense starts at record version one');
  assert.equal(saved.mutation.replayed, false, 'the initial save is not a replay');
  cycleModel.insert({
    id: createdId,
    month: MONTH,
    category: entryCategory,
    amountMinor: entry.amountMinor,
    note: entry.note,
    spentOn: entry.spentOn,
    exclusionStored: exclusionMode === 'true' ? 1 : null,
  });
  await assertLedger(userId, cycleModel, 'save adds exactly the modeled expense');
  const savedRows = cycleModel.rows();
  assert.ok(
    savedRows.some((record) => (
      record.id !== createdId
      && record.amountMinor === entry.amountMinor
      && record.note === entry.note
      && record.spentOn === entry.spentOn
      && record.category === entry.category
    )),
    'an indistinguishable starting expense remains beside the created expense',
  );

  let finalExpenseCategory = entryCategory;
  if (changedCategory) {
    const updated = await mutationService.execute(
      updateCategoryInput(userId, updateKey, createdId, updatedCategory),
    );
    assert.equal(updated.mutation.recordId, createdId, 'category change targets the created expense');
    assert.equal(updated.mutation.recordVersion, 2, 'category change advances the created record version');
    cycleModel.updateCategory(createdId, updatedCategory);
    finalExpenseCategory = updatedCategory;
    await assertLedger(userId, cycleModel, 'category change updates only the created expense');
  }

  const compensateMemory = await beginMemoryChange({
    memoryService,
    userId,
    noteKey: scenario.entryNoteKey,
    writtenCategory: finalExpenseCategory,
    laterCategory: laterMemoryCategory,
    mode: memoryMode,
    memoryModel,
  });

  const undoRequest = deleteInput(userId, deleteKey, createdId);
  const undone = await mutationService.execute(undoRequest);
  assert.equal(undone.mutation.recordId, createdId, 'undo confirms the created expense ID');
  assert.equal(undone.mutation.operation, 'expense.delete', 'undo uses the expense delete operation');
  assert.equal(undone.mutation.recordVersion, changedCategory ? 3 : 2, 'undo advances the existing record version');
  cycleModel.remove(createdId);
  assert.deepEqual(cycleModel.rows(), ledgerModel.rows(), 'the independent model returns to its starting ledger');
  await assertLedger(userId, ledgerModel, 'undo removes only the expense returned by save');
  assertSnapshotRestored(beforeSnapshot, undone.clarity);

  const replayedUndo = await mutationService.execute(undoRequest);
  assert.equal(replayedUndo.mutation.replayed, true, 'same-key undo replay is identified');
  assert.equal(replayedUndo.mutation.changeId, undone.mutation.changeId, 'same-key undo replay returns the same change');
  assert.equal(replayedUndo.mutation.recordId, createdId, 'same-key undo replay returns the same record ID');
  assert.equal(replayedUndo.mutation.recordVersion, undone.mutation.recordVersion, 'same-key undo replay returns the same record version');
  assert.deepEqual(replayedUndo.clarity, undone.clarity, 'same-key undo replay returns the current restored snapshot');

  await assert.rejects(
    mutationService.execute(deleteInput(userId, missingDeleteKey, createdId)),
    (error) => error?.code === 'FINANCIAL_RECORD_NOT_FOUND' && error?.httpStatus === 404,
    'a new-key undo after removal has the designed already-removed 404 semantics',
  );
  const refreshed = await clarityService.getSnapshot({
    userId,
    month: MONTH,
    now: NOW,
    timeZone: 'Asia/Kolkata',
  });
  assert.deepEqual(refreshed, undone.clarity, 'the 404 refresh reads the restored server answer without another write');

  await compensateMemory();
  const afterFinancialState = await readFinancialState(userId);
  assertReceiptSuffix({
    beforeState: beforeFinancialState,
    afterState: afterFinancialState,
    createKey,
    updateKey,
    deleteKey,
    createdId,
    changedCategory,
  });
  assert.equal(
    afterFinancialState.receipts.some(({ idempotencyKey }) => idempotencyKey === missingDeleteKey),
    false,
    'an already-removed 404 creates no receipt',
  );
}

/* ------------------------------------------------------------- Property 20 */

async function runScenario(scenario) {
  const userId = await createUser();
  const entryCategory = categoryAt(scenario.categoryIndex);
  const updatedCategory = categoryAt(scenario.categoryIndex, 1);
  const previousMemoryCategory = categoryAt(scenario.categoryIndex, 2);
  const laterMemoryCategory = categoryAt(scenario.categoryIndex, 3);
  let memoryTick = 0;
  const memoryService = new CategoryMemoryService({
    database: db,
    now: () => new Date(NOW.getTime() + memoryTick++ * 1000),
  });
  const memoryModel = new Map();

  try {
    const ledgerModel = await seedFinancialState(userId, scenario, entryCategory);
    await seedMemory(memoryService, userId, scenario, memoryModel, previousMemoryCategory);
    const repository = new FinancialRepository(db);
    const clarityService = new ClarityService({ repository });
    const mutationService = createExpenseMutationService({
      database: db,
      snapshotService: clarityService,
      fingerprintKey: FINGERPRINT_KEY,
      clock: () => new Date(NOW),
    });

    for (let cycle = 0; cycle < EXCLUSION_MODES.length; cycle += 1) {
      await runLifecycle({
        scenario,
        cycle,
        userId,
        mutationService,
        clarityService,
        memoryService,
        ledgerModel,
        memoryModel,
        entryCategory,
        updatedCategory,
        laterMemoryCategory,
      });
    }
  } finally {
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

test('Property 20: save then undo restores the real ledger, category memory, and all server outcomes', { timeout: 850_000 }, async () => {
  await assertProperty(
    fc.asyncProperty(scenarioArb(), runScenario),
    { numRuns: RUNS },
  );
});
