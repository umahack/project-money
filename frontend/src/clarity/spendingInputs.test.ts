import { describe, expect, it } from 'vitest';
import type { MutationMetadata } from './contracts';
import {
  applyConfirmedExpense,
  describeExpenseTransition,
  readExpenseTransition,
  selectCategoryTreatments,
  spendingConfirmedState,
  treatmentPatch,
  treatmentScope,
  validateExpenseFields,
  type ExpensesResponse,
} from './spendingInputs';
import { expenseRow, spendingSnapshot } from '../test/spendingFixtures';

const MONTH = '2026-11';
const NOW = new Date(2026, 10, 15);
const LIST: ExpensesResponse = {
  month: MONTH,
  categories: ['Food', 'Other'],
  expenses: [expenseRow(2, 'Food', 200, MONTH, { spent_on: '2026-11-12' }), expenseRow(1, 'Food', 100, MONTH, { spent_on: '2026-11-10' })],
};

function mutation(operation: string, recordId: number, record: Record<string, unknown> | null): MutationMetadata {
  return {
    changeId: 1,
    idempotencyKey: 'k',
    scopeKey: `expense:${recordId}`,
    operation,
    recordType: 'expense',
    recordId,
    status: 'confirmed',
    recordVersion: 1,
    record,
  };
}

describe('validateExpenseFields', () => {
  const categories = ['Food', 'Other'];

  it('accepts a valid entry and trims the note to null when empty', () => {
    const { values, errors } = validateExpenseFields({ amount: '1,250.50', category: 'Food', note: '  ' }, { categories, withDate: false, now: NOW });
    expect(errors).toEqual({});
    expect(values).toEqual({ amountMinor: 125050, category: 'Food', note: null, spentOn: null });
  });

  it('names each invalid input with a reason and a correction, and still reports the valid ones', () => {
    const { values, errors } = validateExpenseFields(
      { amount: '0', category: 'Gone', note: 'x'.repeat(121), date: '2026-02-30' },
      { categories, withDate: true, now: NOW },
    );
    expect(values).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['amount', 'category', 'date', 'note']);
    expect(errors.amount).toMatchObject({ field: 'Amount', reason: 'must be an amount above 0.' });
    expect(errors.date?.correction).toContain('2016');
    expect(errors.date?.correction).toContain('2027');
  });

  it('rejects a date outside the accepted years and accepts the edges', () => {
    const check = (date: string) => validateExpenseFields({ amount: '5', category: 'Food', note: '', date }, { categories, withDate: true, now: NOW });
    expect(check('2015-12-31').values).toBeNull();
    expect(check('2016-01-01').values?.spentOn).toBe('2016-01-01');
    expect(check('2027-12-31').values?.spentOn).toBe('2027-12-31');
    expect(check('2028-01-01').values).toBeNull();
    expect(check('').errors.date?.reason).toBe('is required.');
  });
});

describe('applyConfirmedExpense', () => {
  it('inserts a created record in date order and replaces an updated one', () => {
    const created = applyConfirmedExpense(LIST, mutation('expense.create', 3, { id: 3, month: MONTH, category: 'Other', amountMinor: 5000, note: null, spentOn: '2026-11-20' }));
    expect(created.expenses.map((row) => row.id)).toEqual([3, 2, 1]);
    const updated = applyConfirmedExpense(created, mutation('expense.update', 2, { id: 2, month: MONTH, category: 'Food', amountMinor: 30000, note: 'x', spentOn: '2026-11-12' }));
    expect(updated.expenses.find((row) => row.id === 2)).toMatchObject({ amount: 300, note: 'x' });
    expect(updated.expenses).toHaveLength(3);
  });

  it('removes a record that moved to another month and one that was deleted', () => {
    const moved = applyConfirmedExpense(LIST, mutation('expense.update', 2, { id: 2, month: '2026-10', category: 'Food', amountMinor: 20000, note: null, spentOn: '2026-10-12' }));
    expect(moved.expenses.map((row) => row.id)).toEqual([1]);
    expect(applyConfirmedExpense(LIST, mutation('expense.delete', 1, null)).expenses.map((row) => row.id)).toEqual([2]);
  });

  it('returns the same list when the record is unreadable or the operation is not an expense change', () => {
    expect(applyConfirmedExpense(LIST, mutation('expense.update', 2, { id: 2 }))).toBe(LIST);
    expect(applyConfirmedExpense(LIST, mutation('category_treatment.set', 2, null))).toBe(LIST);
  });

  it('does not mutate the list it was given', () => {
    const before = JSON.stringify(LIST);
    applyConfirmedExpense(LIST, mutation('expense.delete', 1, null));
    expect(JSON.stringify(LIST)).toBe(before);
  });
});

describe('expense transition summary', () => {
  const name = (month: string) => `M(${month})`;

  it('describes a move across months with both months recalculated', () => {
    const transition = readExpenseTransition({
      operation: 'expense.update',
      expenseTransition: { type: 'move', originalPeriod: '2026-11', resultingPeriod: '2026-10', originalCategory: 'Food', resultingCategory: 'Other', affectedPeriods: ['2026-11', '2026-10'] },
    });
    expect(transition).not.toBeNull();
    expect(describeExpenseTransition(transition!, name)).toBe('Moved from Food in M(2026-11) to Other in M(2026-10). Recalculated: M(2026-11) and M(2026-10).');
  });

  it('describes create, delete, and in-place updates', () => {
    const base = { type: 'x', originalPeriod: null, resultingPeriod: null, originalCategory: null, resultingCategory: null, affectedPeriods: [] };
    expect(describeExpenseTransition({ ...base, resultingPeriod: '2026-11', resultingCategory: 'Food', affectedPeriods: ['2026-11'] }, name)).toBe('Added to Food for M(2026-11). Recalculated: M(2026-11).');
    expect(describeExpenseTransition({ ...base, originalPeriod: '2026-11', originalCategory: 'Food' }, name)).toBe('Removed from Food for M(2026-11).');
    expect(describeExpenseTransition({ ...base, originalPeriod: '2026-11', resultingPeriod: '2026-11', originalCategory: 'Food', resultingCategory: 'Food' }, name)).toBe('Updated Food for M(2026-11).');
  });

  it('returns null for a response with no mutation object', () => {
    expect(readExpenseTransition(undefined)).toBeNull();
  });
});

describe('treatment helpers', () => {
  const snapshot = spendingSnapshot(MONTH, { expenses: [{ id: 1, category: 'Food', amount: 100 }, { id: 2, category: 'Shopping', amount: 50 }] });

  it('reads the applied treatment per category from the server snapshot', () => {
    const map = selectCategoryTreatments(snapshot, MONTH);
    expect(map.get('Food')).toMatchObject({ treatment: 'needs', source: 'default' });
    expect(map.get('Shopping')).toMatchObject({ treatment: 'wants', source: 'default' });
    expect(selectCategoryTreatments(snapshot, '2026-10').size).toBe(0);
  });

  it('shows the chosen treatment as an override without touching any calculated value', () => {
    const patched = treatmentPatch(MONTH, 'food', 'wants')(snapshot);
    expect(selectCategoryTreatments(patched, MONTH).get('Food')).toMatchObject({ treatment: 'wants', source: 'override' });
    expect(patched.outcomes.spending.value?.needsSpent).toEqual(snapshot.outcomes.spending.value?.needsSpent);
    expect(patched.outcomes.spending.value?.remainingSpendable).toEqual(snapshot.outcomes.spending.value?.remainingSpendable);
    expect(selectCategoryTreatments(snapshot, MONTH).get('Food')?.source).toBe('default');
    expect(treatmentPatch('2026-10', 'Food', 'wants')(snapshot)).toBe(snapshot);
  });

  it('uses one case-insensitive scope per category', () => {
    expect(treatmentScope('Food')).toBe(treatmentScope('FOOD'));
    expect(treatmentScope('Food & Drink')).toBe('category-treatment:food%20%26%20drink');
  });
});

describe('spendingConfirmedState', () => {
  const snapshot = spendingSnapshot(MONTH, { expenses: [{ id: 1, category: 'Food', amount: 100 }] });

  it('is empty before any expense exists, so the preview uses the labelled example', () => {
    expect(spendingConfirmedState(spendingSnapshot(MONTH), MONTH, { hasExpenses: false, category: 'Food' })).toEqual({});
  });

  it('previews the server values, with the selected category total or zero', () => {
    const food = spendingConfirmedState(snapshot, MONTH, { hasExpenses: true, category: 'Food' });
    expect(food.expense?.outcomes.category_total).toEqual({ currency: 'INR', amountMinor: 10000 });
    expect(food.expense?.outcomes.remaining_spendable_budget).toEqual(snapshot.outcomes.spending.value?.remainingSpendable);
    const other = spendingConfirmedState(snapshot, MONTH, { hasExpenses: true, category: 'Other' });
    expect(other.expense?.outcomes.category_total).toEqual({ currency: 'INR', amountMinor: 0 });
  });

  it('counts an existing expense with no calculated value as existing but not yet available', () => {
    const failed = spendingSnapshot(MONTH, { spending: { status: 'calculation_failed', value: undefined } });
    expect(spendingConfirmedState(failed, MONTH, { hasExpenses: true, category: 'Food' })).toEqual({ expense: { outcomes: {} } });
  });
});
