import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  buildFinancialRecordFixtures,
  buildSessionFixture,
  buildUserFixture,
} from '../helpers/fixtures.js';

test('fixture builders remain deterministic for generated identifiers and amounts', () => {
  // Harness property: generated overrides produce fresh, structurally equal fixtures.
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000_000 }),
      (userId, salaryAmount) => {
        const options = {
          userId,
          salary: { amount: salaryAmount },
        };
        const first = buildFinancialRecordFixtures(options);
        const second = buildFinancialRecordFixtures(options);

        assert.deepEqual(first, second);
        assert.notStrictEqual(first.expenses, second.expenses);
        assert.equal(first.salary.user_id, userId);
        assert.equal(first.salary.amount, salaryAmount);
        assert.equal(buildUserFixture({ id: userId }).id, userId);
        assert.equal(buildSessionFixture({ userId }).user_id, userId);
      }
    ),
    { numRuns: 100 }
  );
});
