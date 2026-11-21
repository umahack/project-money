import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuth, getToken, setAuth } from '../api';
import type {
  FinancialSnapshot,
  GoalOutcomeValue,
  MonthlyPlanValue,
  Outcome,
  SpendingOutcomeValue,
  TripOutcomeValue,
} from './contracts';
import {
  queryClient,
  queryKeys,
  selectNewestSnapshot,
  setFinancialSnapshot,
} from './queryClient';

const USER = Object.freeze({
  id: 84,
  email: 'cache@example.test',
  name: 'Cache User',
  is_admin: false,
});

function failedOutcome<T>(id: string, kind: Outcome<T>['kind'], dataVersion: number): Outcome<T> {
  return {
    id,
    kind,
    status: 'calculation_failed',
    classification: 'calculated_result',
    dataVersion,
    period: {
      month: '2026-01',
      start: '2026-01-01',
      endExclusive: '2026-02-01',
      timeZone: 'Asia/Kolkata',
    },
    sourceRefs: [],
    retry: { action: 'recalculate', scopeKey: `outcome:${id}` },
  };
}

function snapshot(dataVersion: number): FinancialSnapshot {
  return {
    dataVersion,
    currency: 'INR',
    precisionMinor: 1,
    period: {
      month: '2026-01',
      timeZone: 'Asia/Kolkata',
      start: '2026-01-01',
      endExclusive: '2026-02-01',
      asOfDate: '2026-01-15',
      daysRemainingInclusive: 17,
    },
    generatedAt: `2026-01-15T00:00:0${dataVersion}.000Z`,
    facts: [],
    outcomes: {
      monthlyPlan: failedOutcome<MonthlyPlanValue>('monthly-plan:2026-01', 'monthly_plan', dataVersion),
      spending: failedOutcome<SpendingOutcomeValue>('spending:2026-01', 'spending', dataVersion),
      goals: [failedOutcome<GoalOutcomeValue>('goal:17', 'goal', dataVersion)],
      tripSummary: failedOutcome<TripOutcomeValue[]>('trip-summary:2026-01', 'trip_summary', dataVersion),
    },
    actions: [],
  };
}

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  queryClient.clear();
});

describe('financial clarity query keys and versions', () => {
  it('uses stable keys for each server-state region', () => {
    expect(queryKeys.clarity('2026-01')).toEqual(['clarity', '2026-01']);
    expect(queryKeys.explanation('goal:17', 9)).toEqual(['clarity-explanation', 'goal:17', 9]);
    expect(queryKeys.journey(3)).toEqual(['journey', 3]);
    expect(queryKeys.expenses('2026-01')).toEqual(['finance', 'expenses', '2026-01']);
    expect(queryKeys.goals()).toEqual(['finance', 'goals']);
    expect(queryKeys.trip(12)).toEqual(['trip', 12]);
    expect(queryKeys.settings()).toEqual(['clarity-settings']);
  });

  it('ignores older snapshots while accepting equal or newer confirmed versions', () => {
    const versionSeven = snapshot(7);
    const versionSix = snapshot(6);
    const versionEight = snapshot(8);

    expect(selectNewestSnapshot(versionSeven, versionSix)).toBe(versionSeven);
    setFinancialSnapshot(queryClient, versionSeven);
    expect(setFinancialSnapshot(queryClient, versionSix)).toBe(versionSeven);
    expect(queryClient.getQueryData(queryKeys.clarity('2026-01'))).toBe(versionSeven);

    expect(setFinancialSnapshot(queryClient, versionEight)).toBe(versionEight);
    expect(queryClient.getQueryData(queryKeys.clarity('2026-01'))).toStrictEqual(versionEight);
  });

  it('keeps financial snapshots out of browser storage', () => {
    setFinancialSnapshot(queryClient, snapshot(7));

    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(queryClient.getQueryData(queryKeys.clarity('2026-01'))).toBeDefined();
  });
});

describe('auth cache lifecycle', () => {
  it('keeps auth in sessionStorage and clears auth plus query data together', () => {
    setAuth('session-only-token', USER);
    setFinancialSnapshot(queryClient, snapshot(7));

    expect(getToken()).toBe('session-only-token');
    expect(localStorage.getItem('pm_token')).toBeNull();
    expect(queryClient.getQueryData(queryKeys.clarity('2026-01'))).toBeDefined();

    clearAuth();

    expect(getToken()).toBeNull();
    expect(sessionStorage.getItem('pm_user')).toBeNull();
    expect(queryClient.getQueryData(queryKeys.clarity('2026-01'))).toBeUndefined();
  });
});
