import { describe, expect, it } from 'vitest';
import type {
  ExpenseAllowanceMark,
  FinancialSnapshot,
  HistoryEntry,
  MemoryEntry,
  QuickAddHintsResponse,
  TodayAllowanceValue,
} from './contracts';

const inr = (amountMinor: number) => ({ currency: 'INR' as const, amountMinor });

// These fixtures mirror what backend/src/services/clarityService.js and
// backend/src/routes/quickAdd.js send. A shape drift fails `tsc --noEmit`.
describe('Quick Add contract types', () => {
  it('describes the todayAllowance values the server sends', () => {
    const available: TodayAllowanceValue = {
      applicable: true,
      date: '2026-11-18',
      daysRemainingInclusive: 13,
      todayAllowance: inr(120000),
      todaySpent: inr(30000),
      leftToday: inr(90000),
      overToday: inr(0),
      allowanceBasis: inr(1560000),
      usedPermille: 250,
      zeroReason: null,
      usedBeyondBudget: inr(0),
      excludedToday: { count: 1, total: inr(2500000) },
      largeEntryThreshold: inr(100000),
    };
    const otherMonth: TodayAllowanceValue = { applicable: false, reason: 'not_current_month' };

    expect(available.applicable && available.todayAllowance.amountMinor).toBe(120000);
    expect(otherMonth.applicable).toBe(false);
  });

  it('describes the hints response', () => {
    const memory: MemoryEntry = {
      id: 7,
      noteKey: 'chai',
      category: 'Food',
      revision: 2,
      updatedAt: '2026-11-18T05:00:00.000Z',
    };
    const history: HistoryEntry = { noteKey: 'chai', category: 'Food', lastSpentOn: '2026-11-17' };
    const hints: QuickAddHintsResponse = {
      schemaVersion: 1,
      memory: [memory],
      history: [history],
      limits: { memoryEntries: 500, historyDays: 90, historyKeys: 500 },
    };

    expect(hints.memory[0]?.revision).toBe(2);
  });

  it('keeps the exclusion mark and the allowance outcome optional for old servers', () => {
    const oldRecord: ExpenseAllowanceMark = {};
    const markedRecord: ExpenseAllowanceMark = { excludeFromDailyAllowance: true };
    const oldOutcomes: Pick<FinancialSnapshot['outcomes'], 'todayAllowance'> = {};

    expect(oldRecord.excludeFromDailyAllowance).toBeUndefined();
    expect(markedRecord.excludeFromDailyAllowance).toBe(true);
    expect(oldOutcomes.todayAllowance).toBeUndefined();
  });
});
