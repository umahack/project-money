import { describe, expect, it } from 'vitest';
import { fc, propertyTestParameters } from '../test/test-utils';
import {
  ACTION_ANCHORS,
  BUDGET_BUCKETS,
  CLARITY_ACTION_KEYS,
  FALLBACK_ACTIONS,
  PAGE_DECISIONS,
  TRIP_DETAIL_TABS,
  actionSlugsFor,
  buildActionRoute,
  parseActionContext,
  pickPageAction,
  resolveInsightAction,
  tabForAction,
  tripBalancesFallback,
  tripDetailFallback,
  type ActionPage,
} from './actionContext';
import { safeInternalRoute } from '../components/clarity/ActionLink';
import type { ActionableInsight } from './contracts';

const PAGES: readonly ActionPage[] = ['home', 'plan', 'spending', 'goals', 'trips', 'trip-detail'];

function insight(overrides: Partial<ActionableInsight>): ActionableInsight {
  return {
    id: 'insight-1',
    conditionCode: 'condition',
    observation: 'Observation',
    actionKey: 'review_bills',
    actionLabel: 'Review monthly bills',
    expectedEffect: 'Effect',
    route: '/plan#bills-form',
    context: {},
    disclaimer: 'Informational guidance, not a guaranteed financial result.',
    ...overrides,
  };
}

/** DOM IDs the registry may ask the arrival hook to focus. */
function isKnownTarget(id: string): boolean {
  return (ACTION_ANCHORS as readonly string[]).includes(id) || /^(goal|expense)-[1-9][0-9]{0,8}$/.test(id);
}

describe('action context registry', () => {
  it('uses the exact decision wording for each page', () => {
    expect(PAGE_DECISIONS.home).toBe('Which current financial condition needs attention?');
    expect(PAGE_DECISIONS.plan).toBe('How much income is available to spend and save?');
    expect(PAGE_DECISIONS.spending).toBe('Does current spending fit the monthly plan?');
    expect(PAGE_DECISIONS.goals).toBe('What contribution is required for the selected goal?');
    expect(PAGE_DECISIONS.trips).toContain('owe');
    expect(PAGE_DECISIONS.trips).toContain('settled');
  });

  it('builds every fixed fallback action as a safe in-app route inside the registry', () => {
    for (const action of Object.values(FALLBACK_ACTIONS)) {
      expect(safeInternalRoute(action.to)).toBe(action.to);
      expect(action.to).not.toMatch(/[A-Za-z]+@|=\d{4,}/);
    }
    expect(FALLBACK_ACTIONS.planAddBills.to).toBe('/plan#bills-form');
    expect(FALLBACK_ACTIONS.spendingRecord.to).toBe('/spending?action=log-expense');
    expect(tripDetailFallback('settle', 7)?.to).toBe('/trips/7?tab=balances&action=settle');
    expect(tripBalancesFallback(7)?.to).toBe('/trips/7?tab=balances');
    expect(tripDetailFallback('settle', 0)).toBeNull();
  });

  it('parses the design example routes into a focus target', () => {
    expect(parseActionContext('plan', '', '#bills-form').targets).toEqual(['bills-form']);
    expect(parseActionContext('plan', '', '#pay-form').anchor).toBe('pay-form');

    const budget = parseActionContext('spending', '?action=review-budget&bucket=needs', '');
    expect(budget).toMatchObject({ action: 'review-budget', params: { bucket: 'needs' } });
    expect(budget.targets).toEqual(['category-budgets', 'expense-form']);

    const contribute = parseActionContext('goals', '?action=contribute&goalId=12', '');
    expect(contribute.params).toEqual({ goalId: 12 });
    expect(contribute.targets).toEqual(['goal-12', 'goals-list', 'goal-form']);

    const settle = parseActionContext('trip-detail', '?tab=balances&action=settle', '');
    expect(settle).toMatchObject({ action: 'settle', params: { tab: 'balances' }, targets: ['trip-balances'] });
    expect(tabForAction('settle')).toBe('balances');
    expect(tabForAction('unknown')).toBeNull();
    expect(tabForAction(null)).toBeNull();
  });

  it('ignores unknown action keys, other pages’ actions, and prototype names', () => {
    for (const search of ['?action=drop-table', '?action=__proto__', '?action=constructor', '?action=SETTLE', '?action=']) {
      expect(parseActionContext('trip-detail', search, '').action).toBeNull();
    }
    expect(parseActionContext('plan', '?action=settle', '').action).toBeNull();
    expect(parseActionContext('goals', '?action=review-budget&bucket=needs', '').targets).toEqual([]);
    expect(parseActionContext('home', '', '#pay-form').anchor).toBeNull();
    expect(parseActionContext('plan', '', '#unknown').targets).toEqual([]);
    expect(parseActionContext('plan', '', '#bills-form-extra').anchor).toBeNull();
  });

  it('drops values, names, and any query key outside the allowlist', () => {
    const context = parseActionContext(
      'goals',
      '?action=contribute&goalId=3&amount=50000&name=Laptop&note=Priya&email=a%40b.co&tripName=Goa&rid=abcdefgh1234',
      '',
    );
    expect(context.params).toEqual({ goalId: 3 });
    expect(JSON.stringify(context)).not.toMatch(/50000|Laptop|Priya|a@b|Goa|abcdefgh/);

    // A parameter that belongs to a different action is not accepted for this one.
    expect(parseActionContext('goals', '?action=add-goal&goalId=3', '').params).toEqual({});
    expect(parseActionContext('spending', '?action=log-expense&bucket=needs', '').params).toEqual({});
  });

  it('rejects parameter values that are not fixed enums or positive IDs', () => {
    for (const value of ['0', '-1', '1.5', '1e3', '01', '1234567890', 'abc', '3 ', '3;DROP', '%20', '']) {
      expect(parseActionContext('goals', `?action=contribute&goalId=${encodeURIComponent(value)}`, '').params).toEqual({});
    }
    for (const value of ['Groceries', 'NEEDS', 'needs,wants', '<script>', '']) {
      expect(parseActionContext('spending', `?action=review-budget&bucket=${encodeURIComponent(value)}`, '').params).toEqual({});
    }
    expect(parseActionContext('trip-detail', '?tab=Rent', '').params).toEqual({});
    // An invalid parameter still leaves the action itself usable.
    expect(parseActionContext('goals', '?action=contribute&goalId=abc', '').targets).toEqual(['goals-list', 'goal-form']);
  });

  it('builds routes only from fixed parts and refuses anything else', () => {
    expect(buildActionRoute({ page: 'goals', action: 'revise', params: { goalId: 9 } })).toBe('/goals?action=revise&goalId=9');
    expect(buildActionRoute({ page: 'spending', action: 'review-budget', params: { bucket: 'wants' } })).toBe(
      '/spending?action=review-budget&bucket=wants',
    );
    expect(buildActionRoute({ page: 'plan', anchor: 'pay-form' })).toBe('/plan#pay-form');
    expect(buildActionRoute({ page: 'trip-detail', action: 'add-expense', tripId: 4 })).toBe('/trips/4?tab=expenses&action=add-expense');

    expect(buildActionRoute({ page: 'goals', action: 'steal' })).toBeNull();
    expect(buildActionRoute({ page: 'goals', action: 'contribute', params: { goalId: 0 } })).toBeNull();
    expect(buildActionRoute({ page: 'goals', action: 'contribute', params: { bucket: 'needs' } })).toBeNull();
    expect(buildActionRoute({ page: 'goals', action: 'contribute', params: { amount: 5 } as never })).toBeNull();
    expect(buildActionRoute({ page: 'spending', action: 'review-budget', params: { bucket: 'Rent' as never } })).toBeNull();
    expect(buildActionRoute({ page: 'plan', anchor: 'goal-form' })).toBeNull();
    expect(buildActionRoute({ page: 'trip-detail', action: 'settle' })).toBeNull();
    expect(buildActionRoute({ page: 'trip-detail', action: 'settle', tripId: 1.5 })).toBeNull();
    expect(buildActionRoute({ page: 'nowhere' as never })).toBeNull();
  });

  it('property: parsing never returns text from the URL and only registry targets', () => {
    const text = fc.string({ maxLength: 24 });
    const key = fc.oneof(
      fc.constantFrom('action', 'tab', 'bucket', 'goalId', 'expenseId', 'amount', 'name', 'note', 'rid', 'tripName'),
      text,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...PAGES),
        fc.array(fc.tuple(key, text), { maxLength: 8 }),
        text,
        (page, pairs, hash) => {
          const search = `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
          const context = parseActionContext(page, search, `#${encodeURIComponent(hash)}`);

          if (context.action !== null) expect(actionSlugsFor(page)).toContain(context.action);
          for (const [name, value] of Object.entries(context.params)) {
            if (name === 'tab') expect(TRIP_DETAIL_TABS as readonly string[]).toContain(value);
            else if (name === 'bucket') expect(BUDGET_BUCKETS as readonly string[]).toContain(value);
            else expect(Number.isSafeInteger(value) && (value as number) > 0).toBe(true);
          }
          expect(Object.keys(context.params).every((n) => ['tab', 'bucket', 'goalId', 'expenseId'].includes(n))).toBe(true);
          expect(context.targets.every(isKnownTarget)).toBe(true);
          if (context.anchor !== null) expect(ACTION_ANCHORS as readonly string[]).toContain(context.anchor);
        },
      ),
      propertyTestParameters,
    );
  });

  it('property: a built route parses back to the same action and parameters', () => {
    const id = fc.integer({ min: 1, max: 999_999_999 });
    const spec = fc.oneof(
      fc.record({ page: fc.constant<ActionPage>('goals'), action: fc.constantFrom('contribute', 'revise'), goalId: id }),
      fc.record({ page: fc.constant<ActionPage>('spending'), action: fc.constant('review-budget'), bucket: fc.constantFrom(...BUDGET_BUCKETS) }),
      fc.record({ page: fc.constant<ActionPage>('spending'), action: fc.constant('correct-expense'), expenseId: id }),
      fc.record({ page: fc.constant<ActionPage>('trip-detail'), action: fc.constantFrom('settle', 'add-expense', 'add-member'), tripId: id }),
    );
    fc.assert(
      fc.property(spec, (value) => {
        const { page, action, ...rest } = value as { page: ActionPage; action: string; tripId?: number; goalId?: number; bucket?: 'needs' | 'wants'; expenseId?: number };
        const { tripId, ...params } = rest;
        const route = buildActionRoute({ page, action, params, tripId });
        expect(route).not.toBeNull();
        expect(safeInternalRoute(route!)).toBe(route);
        const url = new URL(route!, 'https://route.invalid');
        const parsed = parseActionContext(page, url.search, url.hash);
        expect(parsed.action).toBe(action);
        for (const [name, expected] of Object.entries(params)) {
          expect((parsed.params as Record<string, unknown>)[name]).toBe(expected);
        }
      }),
      propertyTestParameters,
    );
  });
});

describe('insight actions', () => {
  it('rebuilds each route from the fixed action key and record ID, ignoring the server route', () => {
    const hostile = 'https://evil.example/steal?amount=90000&name=Goa';
    const cases: Array<[Partial<ActionableInsight>, string | null]> = [
      [{ actionKey: 'review_bills', route: hostile }, '/plan#bills-form'],
      [{ actionKey: 'address_needs_budget_excess', route: hostile }, '/spending?action=review-budget&bucket=needs'],
      [{ actionKey: 'address_wants_budget_excess', route: hostile }, '/spending?action=review-budget&bucket=wants'],
      [{ actionKey: 'contribute_to_goal', route: hostile, context: { recordType: 'goal', recordId: 5 } }, '/goals?action=contribute&goalId=5'],
      [{ actionKey: 'revise_goal_target', route: hostile, context: { recordType: 'goal', recordId: 5 } }, '/goals?action=revise&goalId=5'],
      [{ actionKey: 'contribute_to_goal', route: hostile, context: {} }, '/goals?action=contribute'],
      [{ actionKey: 'settle_trip_balance', route: hostile, context: { recordType: 'trip', recordId: 8 } }, '/trips/8?tab=balances&action=settle'],
      [{ actionKey: 'settle_trip_balance', route: hostile, context: { recordType: 'goal', recordId: 8 } }, null],
      [{ actionKey: 'settle_trip_balance', route: '/trips/8?tab=balances&action=settle', context: {} }, null],
      [{ actionKey: 'not_a_key', route: '/plan#bills-form' }, null],
      [{ actionKey: '__proto__', route: '/plan#bills-form' }, null],
    ];
    for (const [overrides, expected] of cases) {
      const resolved = resolveInsightAction(insight(overrides));
      expect(resolved?.route ?? null).toBe(expected);
    }
    expect(CLARITY_ACTION_KEYS).toHaveLength(6);
  });

  it('picks the first ranked insight that is valid and relevant to the page', () => {
    const actions = [
      insight({ id: 'a', actionKey: 'unknown_key' }),
      insight({ id: 'b', actionKey: 'address_wants_budget_excess' }),
      insight({ id: 'c', actionKey: 'review_bills' }),
      insight({ id: 'd', actionKey: 'settle_trip_balance', context: { recordType: 'trip', recordId: 8 } }),
      insight({ id: 'e', actionKey: 'settle_trip_balance', context: { recordType: 'trip', recordId: 9 } }),
    ];
    expect(pickPageAction(actions, 'home')?.id).toBe('b');
    expect(pickPageAction(actions, 'plan')?.id).toBe('c');
    expect(pickPageAction(actions, 'spending')?.id).toBe('b');
    expect(pickPageAction(actions, 'goals')).toBeNull();
    expect(pickPageAction(actions, 'trips')?.id).toBe('d');
    expect(pickPageAction(actions, 'trip-detail', { tripId: 9 })?.id).toBe('e');
    expect(pickPageAction(actions, 'trip-detail', { tripId: 10 })).toBeNull();
    expect(pickPageAction(undefined, 'home')).toBeNull();
  });
});
