import '../helpers/blockingStdout.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty } from '../helpers/propertyReport.js';

// Feature: quick-add-daily-answer, Property 7: Parsed entries are accepted by the server validator
// **Validates: Requirements 4.1, 4.2, 4.3, 17.7**

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/parserServerContract.json', import.meta.url), 'utf8')
);

let testDatabase;
let normalizeExpenseCreateCommand;
let acceptedConstraints;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  const expenseMutations = await import('../../src/services/expenseMutations.js');
  normalizeExpenseCreateCommand = expenseMutations.normalizeExpenseCreateCommand;
  acceptedConstraints = expenseMutations.EXPENSE_ACCEPTED_CONSTRAINTS;
});

after(async () => {
  await testDatabase?.cleanup();
});

function expectedCommandKeys(excluded) {
  return [
    'amountMinor',
    'category',
    ...(excluded ? ['excludeFromDailyAllowance'] : []),
    'month',
    'note',
    'spentOn',
  ].sort();
}

function assertAcceptedParserCase(sample) {
  const body = {
    amountMinor: sample.parsed.amountMinor,
    category: sample.category,
    note: sample.parsed.note,
    spentOn: sample.parsed.spentOn,
    excludeFromDailyAllowance: sample.excludeFromDailyAllowance,
  };
  const normalized = normalizeExpenseCreateCommand(body, new Date(sample.validatorNow));

  // Keep these field assertions independent so a mismatch identifies the exact contract boundary.
  assert.equal(normalized.command.amountMinor, sample.parsed.amountMinor, `${sample.id}: amountMinor`);
  assert.equal(normalized.command.category, sample.category, `${sample.id}: category`);
  assert.equal(
    normalized.command.note,
    sample.parsed.note === '' ? null : sample.parsed.note,
    `${sample.id}: note`
  );
  assert.equal(normalized.command.spentOn, sample.parsed.spentOn, `${sample.id}: spentOn`);
  assert.equal(normalized.command.month, sample.parsed.spentOn.slice(0, 7), `${sample.id}: month`);
  assert.equal(normalized.expectedRecordVersion, undefined, `${sample.id}: expectedRecordVersion`);

  if (sample.excludeFromDailyAllowance) {
    assert.equal(
      normalized.command.excludeFromDailyAllowance,
      true,
      `${sample.id}: excludeFromDailyAllowance true`
    );
    assert.equal(
      Object.hasOwn(normalized.command, 'excludeFromDailyAllowance'),
      true,
      `${sample.id}: exclusion field present`
    );
  } else {
    assert.equal(
      Object.hasOwn(normalized.command, 'excludeFromDailyAllowance'),
      false,
      `${sample.id}: false exclusion uses the server's counted default`
    );
  }

  assert.deepEqual(
    Object.keys(normalized.command).sort(),
    expectedCommandKeys(sample.excludeFromDailyAllowance),
    `${sample.id}: normalized command fields`
  );
}

test('Property 7: every generated successful parser output is accepted with equal server values', () => {
  assert.equal(fixture.feature, 'quick-add-daily-answer');
  assert.equal(fixture.property, 7);
  assert.ok(fixture.generatedCases >= 100);
  assert.ok(fixture.cases.length >= 100);
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  assert.ok(fixture.cases.some(({ categoryOrigin }) => categoryOrigin.startsWith('suggest:')));
  assert.ok(fixture.cases.some(({ categoryOrigin }) => categoryOrigin === 'generated'));

  // Every property run checks every generated parser output; shuffling proves no case depends on test order.
  assertProperty(
    fc.property(
      fc.shuffledSubarray(fixture.cases, {
        minLength: fixture.cases.length,
        maxLength: fixture.cases.length,
      }),
      (samples) => {
        for (const sample of samples) assertAcceptedParserCase(sample);
      }
    ),
    { numRuns: 100, seed: fixture.seed }
  );
});

test('Property 7: parser limits are no looser than the server limits', () => {
  const parser = fixture.parserLimits;

  assert.ok(parser.amountMinor.min >= acceptedConstraints.amountMinor.minMinor);
  assert.ok(parser.amountMinor.max <= acceptedConstraints.amountMinor.maxMinor);
  assert.equal(Number.isSafeInteger(parser.amountMinor.min), true);
  assert.equal(Number.isSafeInteger(parser.amountMinor.max), true);
  assert.ok(parser.noteMaxUtf16Units <= acceptedConstraints.note.maxLength);
  assert.ok(
    parser.spentOnYearOffsets.min >= acceptedConstraints.spentOn.earliestYearOffset
  );
  assert.ok(
    parser.spentOnYearOffsets.max <= acceptedConstraints.spentOn.latestYearOffset
  );

  const boundaryIds = new Set(
    fixture.cases.filter(({ kind }) => kind === 'boundary').map(({ id }) => id)
  );
  assert.deepEqual(boundaryIds, new Set(['boundary-0', 'boundary-1', 'boundary-2', 'boundary-3']));

  const minimum = fixture.cases.find(({ parsed }) => parsed.amountMinor === parser.amountMinor.min);
  const maximum = fixture.cases.find(({ parsed }) => parsed.amountMinor === parser.amountMinor.max);
  const longestNote = fixture.cases.find(
    ({ parsed }) => parsed.note.length === parser.noteMaxUtf16Units
  );
  assert.ok(minimum, 'fixture covers the parser minimum amount');
  assert.ok(maximum, 'fixture covers the parser maximum amount');
  assert.ok(longestNote, 'fixture covers the parser maximum note length');
  assertAcceptedParserCase(minimum);
  assertAcceptedParserCase(maximum);
  assertAcceptedParserCase(longestNote);
});
