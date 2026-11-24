import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_NOTICE_REQUIRED_EVENT, REQUEST_TIMEOUT_CODE, clearAuth } from '../../api';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import { createTestQueryClient } from '../../test/test-utils';
import { FinancialClarityProvider } from '../FinancialClarityProvider';
import { formatInr } from './amount';
import { measurement } from '../measurement';
import { MutationStatusProvider } from '../MutationStatusProvider';
import {
  resetExpenseEventsForTests,
  subscribeToExpenseChanges,
  type ConfirmedExpenseChange,
} from './expenseEvents';
import { resetServerTimeOffset } from './kolkata';
import { createMemoryClient, type MemoryClient } from './memoryClient';
import { QuickAddProvider } from './QuickAddProvider';
import {
  WAKING_UP_TEXT,
  createQuickAddStore,
  initialQuickAddState,
  isUndoAvailable,
  selectCurrentAnswerEntry,
  selectEntry,
  type QuickAddEntry,
  type QuickAddStore,
} from './quickAddStore';
import {
  ALREADY_REMOVED_TEXT,
  REMOVED_TEXT,
  SAVE_FAILED_TEXT,
  UNDO_FAILED_TEXT,
  useQuickAddActions,
  type QuickAddActions,
  type QuickAddContext,
} from './useQuickAddActions';

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const MEMORY = '/finance/category-memory';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Bills', 'Health', 'Travel', 'Education', 'Other'];

interface Harness {
  actions: QuickAddActions;
  backend: FakeQuickAddBackend;
  net: SpendingFetch;
  store: QuickAddStore;
  memory: MemoryClient;
  events: ConfirmedExpenseChange[];
  reported: ReturnType<typeof vi.spyOn>;
  queryClient: QueryClient;
  /** Every request that is not a measurement beacon, as `METHOD path`. */
  requests(): string[];
  entry(cid: string): QuickAddEntry;
  first(): QuickAddEntry;
  all(): readonly QuickAddEntry[];
}

interface SetupOptions {
  backend?: FakeQuickAddBackend;
  /** Quick_Add_Enabled. Defaults to on. */
  enabled?: boolean;
  /** Read the hints before the test starts, as the preview does. */
  hints?: boolean;
  context?: QuickAddContext;
}

const memoryClients: MemoryClient[] = [];

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const enabled = options.enabled ?? true;
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', enabled ? 'true' : 'false');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', enabled ? 'true' : 'false');
  const backend = options.backend ?? new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
  const net = installSpendingFetch(backend);
  const queryClient = createTestQueryClient();
  const memoryCache = new QueryClient();
  const memory = createMemoryClient({ queryClient: memoryCache, isEnabled: () => enabled });
  memoryClients.push(memory);
  const store = createQuickAddStore();
  const events: ConfirmedExpenseChange[] = [];
  subscribeToExpenseChanges((change) => events.push(change));
  const reported = vi.spyOn(measurement, 'financialChangeUi');

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <FinancialClarityProvider>
          <MutationStatusProvider>
            <QuickAddProvider store={store}>{children}</QuickAddProvider>
          </MutationStatusProvider>
        </FinancialClarityProvider>
      </QueryClientProvider>
    );
  }

  const { result } = renderHook(
    () => useQuickAddActions({ memory, today: () => TODAY, categories: CATEGORIES, ...options.context }),
    { wrapper: Wrapper },
  );
  if (options.hints) {
    await act(async () => {
      await memory.loadHints();
    });
  }

  const entries = () => store.getState().entries;
  return {
    get actions() {
      return result.current;
    },
    backend,
    net,
    store,
    memory,
    events,
    reported,
    queryClient,
    requests: () => net.calls.map((call) => `${call.method} ${call.path}`),
    entry(cid) {
      const found = selectEntry(store.getState(), cid);
      if (!found) throw new Error('No such entry');
      return found;
    },
    first() {
      const found = entries()[0];
      if (!found) throw new Error('No entries');
      return found;
    },
    all: entries,
  };
}

function writes(h: Harness, method: string, path: string) {
  return h.net.to(method, path);
}

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  resetExpenseEventsForTests();
  resetServerTimeOffset();
  for (const client of memoryClients.splice(0)) client.dispose();
});

async function run<T>(work: () => Promise<T>): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await work();
  });
  return value;
}

describe('submit', () => {
  it('saves one entry with structured fields only and shows the answer from the confirmed snapshot', async () => {
    const h = await setup();
    const result = await run(() => h.actions.submit({ line: '120 coffee' }));

    expect(result).toMatchObject({ status: 'confirmed' });
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(1);
    // Requirement 4.5: the typed line is never sent, only the structured fields.
    expect(posts[0]?.body).toEqual({ amountMinor: 12000, category: 'Food', note: 'coffee', spentOn: TODAY });
    expect(JSON.stringify(posts[0]?.body)).not.toContain('120 coffee');
    expect(posts[0]?.headers['idempotency-key']).toMatch(UUID);
    expect(posts[0]?.headers['x-clarity-contract']).toBe('1');
    expect(h.backend.expenses).toHaveLength(1);

    const entry = h.first();
    expect(entry.phase).toBe('saved');
    expect(entry.expenseId).toBe(h.backend.expenses[0]?.id);
    expect(isUndoAvailable(entry)).toBe(true);
    expect(entry.answer?.titleKey).toBe('answer.saved');
    expect(entry.answer?.lines[0]).toMatchObject({ key: 'answer.saved', money: { amount: { amountMinor: 12000 } } });
    expect(selectCurrentAnswerEntry(h.store.getState())?.cid).toBe(entry.cid);
    expect(h.store.getState().announcements.map((item) => item.text)).toEqual(['Saved ₹120 to Food. Counts toward November 2026.']);
    // Confirmed results only reach the change bus and the existing measurement call (Requirements 7.17, 14.6).
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ confirmed: true, kind: 'create', expenseId: entry.expenseId, resultingMonth: MONTH });
    expect(h.reported).toHaveBeenCalledTimes(1);
    expect(h.reported).toHaveBeenCalledWith({
      changeId: expect.any(Number),
      causedReload: false,
      causedPageWideLoading: false,
    });
    // No memory write when the User kept the suggestion.
    expect(writes(h, 'PUT', MEMORY)).toHaveLength(0);
  });

  it('uses the draft line and clears it when the row is added, and rejects an unparsable line without a request', async () => {
    const h = await setup();
    h.store.dispatch({ type: 'line/set', line: 'coffee' });
    const invalid = await run(() => h.actions.submit());
    expect(invalid).toMatchObject({ status: 'invalid' });
    expect(h.requests()).toEqual([]);
    expect(h.store.getState().line).toBe('coffee');
    expect(h.all()).toHaveLength(0);

    h.store.dispatch({ type: 'line/set', line: '45 chai' });
    const pending = h.actions.submit();
    // The pending row exists, and the input is empty, before the request has answered.
    expect(h.first().phase).toBe('pending');
    expect(h.store.getState().line).toBe('');
    await run(() => pending);
    expect(h.first().phase).toBe('saved');
  });

  it('gives each of several entries its own key and keeps the newest snapshot when responses arrive out of order', async () => {
    const h = await setup();
    const gate = h.net.holdResponse('POST', EXPENSES);
    const first = h.actions.submit({ line: '10 coffee' });
    const second = h.actions.submit({ line: '20 coffee' });
    const third = h.actions.submit({ line: '30 coffee' });
    await run(() => Promise.all([second, third]));

    expect(h.all().map((entry) => entry.phase)).toEqual(['pending', 'saved', 'saved']);
    await run(async () => {
      gate.release();
      await first;
    });

    expect(h.all().map((entry) => entry.phase)).toEqual(['saved', 'saved', 'saved']);
    expect(new Set(h.all().map((entry) => entry.expenseId)).size).toBe(3);
    const keys = writes(h, 'POST', EXPENSES).map((call) => call.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(3);
    expect(h.backend.expenses).toHaveLength(3);
    // The first entry's response arrived last but carries the oldest snapshot, so the third entry's answer stays.
    const versions = h.all().map((entry) => entry.answer?.dataVersion ?? 0);
    expect(versions[0]).toBeLessThan(versions[2] ?? 0);
    expect(selectCurrentAnswerEntry(h.store.getState())?.cid).toBe(h.all()[2]?.cid);
  });

  it('disables the sixth submission while five are pending and keeps the typed line', async () => {
    const h = await setup();
    const gates = Array.from({ length: 5 }, () => h.net.hold('POST', EXPENSES));
    const pending = Array.from({ length: 5 }, (_, index) => h.actions.submit({ line: `${index + 1}0 coffee` }));
    h.store.dispatch({ type: 'line/set', line: '99 tea' });

    const sixth = await run(() => h.actions.submit());
    expect(sixth).toMatchObject({ status: 'blocked' });
    expect(h.store.getState().line).toBe('99 tea');
    expect(h.all()).toHaveLength(5);

    await run(async () => {
      for (const gate of gates) gate.release();
      await Promise.all(pending);
    });
    expect(h.all().every((entry) => entry.phase === 'saved')).toBe(true);
  });
});

describe('category suggestion, correction, and memory', () => {
  it('saves the chosen category, remembers a correction once, and uses it for the next suggestion', async () => {
    const h = await setup({ hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));

    expect(writes(h, 'POST', EXPENSES)[0]?.body).toMatchObject({ category: 'Transport' });
    const puts = writes(h, 'PUT', MEMORY);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual({ noteKey: 'coffee', category: 'Transport' });
    expect(h.backend.memoryFor('coffee')).toMatchObject({ category: 'Transport', revision: 1 });
    expect(h.first().memory).toMatchObject({
      phase: 'saved',
      noteKey: 'coffee',
      previous: null,
      written: { id: h.backend.memoryFor('coffee')?.id, revision: 1 },
    });
    // The cached hints changed in place, with no second read.
    expect(writes(h, 'GET', '/finance/quick-add/hints')).toHaveLength(1);

    await run(() => h.actions.submit({ line: '90 coffee' }));
    expect(writes(h, 'POST', EXPENSES)[1]?.body).toMatchObject({ category: 'Transport' });
    expect(h.all()[1]?.suggestion.source).toBe('memory');
    expect(writes(h, 'PUT', MEMORY)).toHaveLength(1);
  });

  it('changes the category of a saved entry through the update operation and remembers the correction', async () => {
    const h = await setup({ hints: true });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const { cid, expenseId } = h.first();

    const result = await run(() => h.actions.changeCategory(cid, 'Shopping'));

    expect(result).toEqual({ status: 'confirmed', cid });
    const patches = writes(h, 'PATCH', `${EXPENSES}/${expenseId}`);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ category: 'Shopping' });
    expect(patches[0]?.headers['idempotency-key']).toMatch(UUID);
    expect(patches[0]?.headers['x-clarity-contract']).toBe('1');
    expect(h.first().category).toBe('Shopping');
    expect(h.first().phase).toBe('saved');
    expect(writes(h, 'PUT', MEMORY)[0]?.body).toEqual({ noteKey: 'coffee', category: 'Shopping' });
    expect(h.events.map((event) => event.kind)).toEqual(['create', 'update']);
    expect(h.reported).toHaveBeenCalledTimes(2);

    expect(await run(() => h.actions.changeCategory(cid, 'Shopping'))).toEqual({ status: 'unchanged' });
    expect(writes(h, 'PATCH', `${EXPENSES}/${expenseId}`)).toHaveLength(1);
  });

  it('keeps the saved expense and offers a retry when the memory write fails, then sends the same write again', async () => {
    const h = await setup({ hints: true });
    h.backend.failWith('PUT', MEMORY, { status: 500, code: 'SERVER_ERROR', message: 'Try again.' });

    const result = await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));

    expect(result).toMatchObject({ status: 'confirmed' });
    expect(h.first().phase).toBe('saved');
    expect(h.first().memory.phase).toBe('failed');
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.backend.memory).toHaveLength(0);

    const retried = await run(() => h.actions.retry(h.first().cid));
    expect(retried).toMatchObject({ status: 'memory', memory: 'saved' });
    const puts = writes(h, 'PUT', MEMORY);
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toEqual(puts[0]?.body);
    expect(h.backend.memoryFor('coffee')?.category).toBe('Transport');
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);
  });

  it('treats memory as unavailable when the server refuses writes, and still saves', async () => {
    const h = await setup({ hints: true });
    h.backend.memoryWritesDisabled = true;

    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    await run(() => h.actions.submit({ line: '80 coffee', category: 'Transport' }));

    expect(h.all().map((entry) => entry.phase)).toEqual(['saved', 'saved']);
    expect(h.all().map((entry) => entry.memory.phase)).toEqual(['none', 'none']);
    expect(writes(h, 'PUT', MEMORY)).toHaveLength(1);
  });

  it('deletes the Memory_Entry for "Forget this" and stops suggesting from it', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    const seeded = backend.seedMemory('coffee', 'Transport');
    const h = await setup({ backend, hints: true });

    expect(await run(() => h.actions.forgetMemory({ noteKey: 'tea' }))).toEqual({ status: 'not_found' });
    expect(h.requests().filter((request) => request.startsWith('DELETE'))).toEqual([]);

    const forgotten = await run(() => h.actions.forgetMemory({ noteKey: 'coffee' }));
    expect(forgotten).toMatchObject({ status: 'saved' });
    expect(writes(h, 'DELETE', `${MEMORY}/${seeded.id}`)).toHaveLength(1);
    expect(backend.memory).toHaveLength(0);

    await run(() => h.actions.submit({ line: '10 coffee' }));
    expect(h.first().suggestion.source).toBe('keyword');
    expect(writes(h, 'POST', EXPENSES)[0]?.body).toMatchObject({ category: 'Food' });
  });
});

describe('the exclusion mark and the entry warning', () => {
  it('sends the mark in the create request and shows the confirmed statements', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.todayDate = TODAY;
    const h = await setup({ backend });

    await run(() => h.actions.submit({ line: '1,500 rent', excludeFromToday: true }));

    expect(writes(h, 'POST', EXPENSES)[0]?.body).toEqual({
      amountMinor: 150000,
      category: 'Bills',
      note: 'rent',
      spentOn: TODAY,
      excludeFromDailyAllowance: true,
    });
    expect(h.first().excluded).toBe(true);
    const keys = h.first().answer?.lines.map((line) => line.key) ?? [];
    expect(keys).toContain('answer.today.excluded.notCounted');
    expect(keys).toContain('answer.today.excluded.monthIncludes');
    expect(h.events[0]?.excludedFromDailyAllowance).toBe(true);
  });

  it('announces Left_Today from the confirmed snapshot in the save message, without calculating it (Requirement 9.18)', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.todayDate = TODAY;
    const h = await setup({ backend });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const lines = h.first().answer?.lines ?? [];
    const left = lines.find((line) => line.key === 'answer.today.left')?.money?.leftToday;
    expect(left).toBeDefined();
    expect(h.store.getState().announcements.map((item) => item.text)).toEqual([
      `Saved ₹120 to Food. ${formatInr((left as { amountMinor: number }).amountMinor)} left today.`,
    ]);
  });
  it('sends no mark for an entry dated another day, or when the User did not ask', async () => {
    const h = await setup();
    await run(() => h.actions.submit({ line: '1,500 rent yesterday', excludeFromToday: true }));
    await run(() => h.actions.submit({ line: '1,500 rent', excludeFromToday: false }));
    for (const call of writes(h, 'POST', EXPENSES)) expect(call.body).not.toHaveProperty('excludeFromDailyAllowance');
  });

  it('says the entry was counted when the response does not confirm the mark, and offers the update that sets it', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.todayDate = TODAY;
    backend.echoMark = false;
    const h = await setup({ backend });

    await run(() => h.actions.submit({ line: '1,500 rent', excludeFromToday: true }));

    const entry = h.first();
    expect(entry.excluded).toBeUndefined();
    expect(entry.answer?.lines.map((line) => line.key)).toContain('answer.today.exclusionUnconfirmed');
    const offer = entry.answer?.actions.find((action) => action.key === 'exclude_from_today');
    expect(offer).toMatchObject({ key: 'exclude_from_today', recordId: entry.expenseId });

    backend.echoMark = true;
    const result = await run(() => h.actions.setExclusion(entry.cid, true));
    expect(result).toEqual({ status: 'confirmed', cid: entry.cid });
    const patch = writes(h, 'PATCH', `${EXPENSES}/${entry.expenseId}`)[0];
    expect(patch?.body).toEqual({ excludeFromDailyAllowance: true });
    expect(patch?.headers['idempotency-key']).toMatch(UUID);
    expect(patch?.headers['x-clarity-contract']).toBe('1');
    expect(h.first().excluded).toBe(true);
    expect(h.first().answer?.lines.map((line) => line.key)).toContain('answer.today.excluded.notCounted');
  });

  it('keeps a large or bill-like entry counted by default and offers the exclusion afterward', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.todayDate = TODAY;
    const h = await setup({ backend, context: { billLabels: ['Rent'], largeEntryThresholdMinor: 100_000 } });

    // Enter while a warning is shown saves as "Save and count today".
    await run(() => h.actions.submit({ line: '5,000 rent' }));
    const counted = h.first();
    expect(counted.warning).toEqual({ kind: 'warn', bill: 'Rent', large: true });
    expect(writes(h, 'POST', EXPENSES)[0]?.body).not.toHaveProperty('excludeFromDailyAllowance');
    const offer = counted.answer?.actions.find((action) => action.key === 'exclude_from_today');
    expect(offer).toMatchObject({ reasons: ['large', 'bill'] });

    // "Save, but don't count against today" sends the mark in the same create request, once.
    await run(() => h.actions.submit({ line: '5,000 rent', excludeFromToday: true }));
    const withMark = writes(h, 'POST', EXPENSES)[1];
    expect(withMark?.body).toMatchObject({ excludeFromDailyAllowance: true });
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(2);
    expect(h.all()[1]?.excluded).toBe(true);

    // Not dated Today: no warning and no offer.
    await run(() => h.actions.submit({ line: '5,000 rent yesterday' }));
    expect(h.all()[2]?.warning).toEqual({ kind: 'none' });

    // The warning never changed what was saved.
    expect(h.backend.expenses.map((expense) => [expense.amountMinor, expense.category, expense.note])).toEqual([
      [500000, 'Bills', 'rent'],
      [500000, 'Bills', 'rent'],
      [500000, 'Bills', 'rent'],
    ]);

    // The exclusion can be cleared again through the update operation.
    const marked = await run(() => h.actions.setExclusion(counted.cid, true));
    expect(marked).toMatchObject({ status: 'confirmed' });
    expect(await run(() => h.actions.setExclusion(counted.cid, false))).toMatchObject({ status: 'confirmed' });
    expect(writes(h, 'PATCH', `${EXPENSES}/${counted.expenseId}`).map((call) => call.body)).toEqual([
      { excludeFromDailyAllowance: true },
      { excludeFromDailyAllowance: false },
    ]);
  });
});

describe('failure, retry, edit, and discard', () => {
  it('keeps the values of a failed entry and retries with the identical key and body', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY', message: 'Busy.' });

    const failed = await run(() => h.actions.submit({ line: '450 swiggy yesterday' }));

    expect(failed).toMatchObject({ status: 'failed', error: { retryable: true, status: 503 } });
    const entry = h.first();
    expect(entry.phase).toBe('failed');
    expect(entry.parsed).toEqual({ amountMinor: 45000, spentOn: '2026-11-17', note: 'swiggy' });
    expect(h.backend.expenses).toHaveLength(0);
    expect(h.store.getState().announcements).toHaveLength(1);

    const retried = await run(() => h.actions.retry(entry.cid));

    expect(retried).toEqual({ status: 'confirmed', cid: entry.cid });
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.first().phase).toBe('saved');
  });

  it('holds exactly one expense when the response was lost and the same-key retry replays it', async () => {
    const h = await setup();
    h.net.loseResponse('POST', EXPENSES);

    const failed = await run(() => h.actions.submit({ line: '120 coffee' }));
    expect(failed).toMatchObject({ status: 'failed', error: { retryable: true } });
    expect(h.backend.expenses).toHaveLength(1);

    await run(() => h.actions.retry(h.first().cid));
    expect(h.backend.expenses).toHaveLength(1);
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(h.first().phase).toBe('saved');
    // The replayed confirmation is a confirmed result and is published once.
    expect(h.events).toHaveLength(1);
  });

  it('marks a request that gets no answer in 60 seconds as timed out and retries it with the same key', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    const gate = h.net.hold('POST', EXPENSES);

    let pending!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      pending = h.actions.submit({ line: '120 coffee' });
    });
    expect(h.first().phase).toBe('pending');
    expect(h.first().wakingUp).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // Requirement 7.13: the row says the free server may be waking up, and nothing is sent again.
    expect(h.first().wakingUp).toBe(true);
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(54_999);
    });
    expect(h.first().phase).toBe('pending');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });
    expect(h.first().phase).toBe('failed');
    expect(h.first().error).toMatchObject({ code: REQUEST_TIMEOUT_CODE, retryable: true });
    expect(h.first().parsed.amountMinor).toBe(12000);

    // The abandoned request reached the server and committed, as a timed-out request can.
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.backend.expenses).toHaveLength(1);

    await act(async () => {
      await h.actions.retry(h.first().cid);
    });
    expect(h.backend.expenses).toHaveLength(1);
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(h.first().phase).toBe('saved');
    vi.useRealTimers();
  });

  it('keeps the entry and offers a retry when the notice must be reviewed', async () => {
    const h = await setup();
    const shown = vi.fn();
    window.addEventListener(DATA_NOTICE_REQUIRED_EVENT, shown);
    h.backend.failWith('POST', EXPENSES, { status: 428, code: 'DATA_NOTICE_REQUIRED', message: 'Review the notice.' });

    const failed = await run(() => h.actions.submit({ line: '120 coffee' }));
    window.removeEventListener(DATA_NOTICE_REQUIRED_EVENT, shown);

    expect(failed).toMatchObject({ status: 'failed', error: { retryable: true, status: 428 } });
    expect(shown).toHaveBeenCalled();
    await run(() => h.actions.retry(h.first().cid));
    expect(h.first().phase).toBe('saved');
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('sends a validation failure back to Edit with the field and constraint named, and offers no retry', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, {
      status: 422,
      code: 'UNKNOWN_EXPENSE_CATEGORY',
      message: 'Unknown category.',
      field: 'category',
      constraint: 'A built-in or custom category',
    });

    const failed = await run(() => h.actions.submit({ line: '120 coffee', category: 'Gadgets' }));

    expect(failed).toMatchObject({ status: 'failed', error: { retryable: false, field: 'category' } });
    const entry = h.first();
    expect(entry.error?.message).toContain('Category');
    expect(entry.error?.message).toContain('Unknown category.');
    expect(entry.error?.message).toContain('A built-in or custom category');

    expect(await run(() => h.actions.retry(entry.cid))).toEqual({ status: 'unavailable' });
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);

    // Edit moves the formatter output to the input, and the next submission is a new entry with a new key.
    const edited = await run(async () => h.actions.edit(entry.cid));
    expect(edited).toEqual({ status: 'edited', line: `₹120 ${TODAY} "coffee"` });
    expect(h.store.getState().line).toBe(`₹120 ${TODAY} "coffee"`);
    expect(h.all()).toHaveLength(0);

    await run(() => h.actions.submit());
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).not.toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual({ amountMinor: 12000, category: 'Food', note: 'coffee', spentOn: TODAY });
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('does not take over a typed line on Edit', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 500, code: 'SERVER_ERROR' });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    h.store.dispatch({ type: 'line/set', line: '60 tea' });

    expect(h.actions.edit(h.first().cid)).toEqual({ status: 'input_not_empty' });
    expect(h.store.getState().line).toBe('60 tea');
    expect(h.first().phase).toBe('failed');
  });

  it('discards a failed or undone row without touching any confirmed record', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 500, code: 'SERVER_ERROR' });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    await run(() => h.actions.submit({ line: '70 tea' }));
    const [failedRow, savedRow] = h.all();

    expect(h.actions.discard(savedRow?.cid ?? '')).toEqual({ status: 'unavailable' });
    expect(h.actions.discard(failedRow?.cid ?? '')).toEqual({ status: 'discarded' });
    expect(h.all().map((entry) => entry.cid)).toEqual([savedRow?.cid]);
    expect(h.backend.expenses).toHaveLength(1);

    await run(() => h.actions.undo(savedRow?.cid ?? ''));
    expect(h.actions.discard(savedRow?.cid ?? '')).toEqual({ status: 'discarded' });
    expect(h.all()).toHaveLength(0);
  });
});

describe('undo', () => {
  async function savedEntry(h: Harness, line = '120 coffee', category?: string) {
    await run(() => h.actions.submit({ line, ...(category ? { category } : {}) }));
    const entries = h.all();
    return entries[entries.length - 1] as QuickAddEntry;
  }

  it('deletes exactly the created expense by its id, with a new key and no version, even after a category change', async () => {
    const backend = new FakeQuickAddBackend(MONTH, {
      categories: CATEGORIES,
      expenses: [{ id: 1, category: 'Food', amount: 120, note: 'coffee', day: 18 }],
    });
    const h = await setup({ backend });
    const entry = await savedEntry(h);
    expect(entry.expenseId).toBe(2);
    await run(() => h.actions.changeCategory(entry.cid, 'Shopping'));

    const result = await run(() => h.actions.undo(entry.cid));

    expect(result).toEqual({ status: 'removed', cid: entry.cid });
    const deletes = writes(h, 'DELETE', `${EXPENSES}/2`);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.body).toEqual({});
    const expenseWrites = h.net.calls.filter((call) => call.method !== 'GET' && call.path.startsWith(EXPENSES));
    expect(expenseWrites.map((call) => call.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(new Set(expenseWrites.map((call) => call.headers['idempotency-key'])).size).toBe(3);
    // The other expense with the same amount, note, and date stays.
    expect(backend.expenses.map((expense) => expense.id)).toEqual([1]);
    expect(h.entry(entry.cid).phase).toBe('undone');
    expect(h.entry(entry.cid).answer?.mode).toBe('removed');
    expect(h.events.map((event) => event.kind)).toEqual(['create', 'update', 'delete']);
    expect(h.reported).toHaveBeenCalledTimes(3);
    // The hints were never read, so the entry before this entry's write is unknown and nothing is restored.
    expect(h.entry(entry.cid).memory.previous).toBeUndefined();
    expect(backend.memoryFor('coffee')?.category).toBe('Shopping');
  });

  it('shows the removing status in the same step as the click', async () => {
    const h = await setup();
    const entry = await savedEntry(h);
    const gate = h.net.hold('DELETE', `${EXPENSES}/${entry.expenseId}`);

    let pending!: ReturnType<QuickAddActions['undo']>;
    act(() => {
      pending = h.actions.undo(entry.cid);
    });
    expect(h.entry(entry.cid).phase).toBe('removing');
    expect(isUndoAvailable(h.entry(entry.cid))).toBe(true);
    await act(async () => {
      gate.release();
      await pending;
    });
    expect(h.entry(entry.cid).phase).toBe('undone');
  });

  it('offers no Undo after the window ends, and the expense stays', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    await act(async () => {
      await h.actions.submit({ line: '120 coffee' });
    });
    const { cid } = h.first();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(isUndoAvailable(h.entry(cid))).toBe(false);

    expect(await h.actions.undo(cid)).toEqual({ status: 'unavailable' });
    expect(writes(h, 'DELETE', `${EXPENSES}/${h.entry(cid).expenseId}`)).toHaveLength(0);
    expect(h.backend.expenses).toHaveLength(1);
    vi.useRealTimers();
  });

  it('keeps the expense saved when the delete fails, keeps Undo available, and retries with the same key', async () => {
    const h = await setup();
    const entry = await savedEntry(h);
    const path = `${EXPENSES}/${entry.expenseId}`;
    h.backend.failWith('DELETE', path, { status: 503, code: 'SERVER_BUSY' });

    const failed = await run(() => h.actions.undo(entry.cid));

    expect(failed).toMatchObject({ status: 'failed', error: { retryable: true } });
    expect(h.entry(entry.cid).phase).toBe('undo_failed');
    expect(isUndoAvailable(h.entry(entry.cid))).toBe(true);
    expect(h.backend.expenses).toHaveLength(1);

    h.net.loseResponse('DELETE', path);
    await run(() => h.actions.retry(entry.cid));
    // The server removed it but the answer was lost, so the row still offers Undo.
    expect(h.entry(entry.cid).phase).toBe('undo_failed');
    expect(h.backend.expenses).toHaveLength(0);

    // The same-key retry replays the confirmed result.
    await run(() => h.actions.retry(entry.cid));
    const deletes = writes(h, 'DELETE', path);
    expect(deletes).toHaveLength(3);
    expect(new Set(deletes.map((call) => call.headers['idempotency-key'])).size).toBe(1);
    expect(h.entry(entry.cid).phase).toBe('undone');
    expect(h.entry(entry.cid).alreadyRemoved).toBeUndefined();
  });

  it('says the entry was already removed on a 404 and refreshes the answer from the server', async () => {
    const h = await setup();
    const entry = await savedEntry(h);
    const answerBefore = h.entry(entry.cid).answer;
    h.backend.removeElsewhere(entry.expenseId ?? 0);
    h.net.calls.length = 0;

    const result = await run(() => h.actions.undo(entry.cid));

    expect(result).toEqual({ status: 'already_removed', cid: entry.cid });
    expect(h.entry(entry.cid).phase).toBe('undone');
    expect(h.entry(entry.cid).alreadyRemoved).toBe(true);
    expect(h.requests()).toEqual([
      `DELETE ${EXPENSES}/${entry.expenseId}`,
      'GET /finance/clarity',
    ]);
    expect(h.net.calls[1]?.query.get('month')).toBe(MONTH);
    expect(h.entry(entry.cid).answer).not.toBe(answerBefore);
    expect(h.entry(entry.cid).answer?.mode).toBe('removed');
    // This entry did not remove it, so nothing more is published or reported.
    expect(h.events.map((event) => event.kind)).toEqual(['create']);
    expect(h.reported).toHaveBeenCalledTimes(1);
  });
});

describe('undo restores category memory by compensation', () => {
  it('removes the entry it wrote when there was none, with the revision check', async () => {
    const h = await setup({ hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    const { cid } = h.first();
    const written = h.backend.memoryFor('coffee');

    await run(() => h.actions.undo(cid));

    expect(writes(h, 'DELETE', `${MEMORY}/${written?.id}`)).toHaveLength(1);
    expect(h.net.to('DELETE', `${MEMORY}/${written?.id}`)[0]?.query.get('expectedRevision')).toBe('1');
    expect(h.backend.memory).toHaveLength(0);
    expect(h.memory.readView().memory).toHaveLength(0);
    expect(h.entry(cid).memory.phase).toBe('none');
  });

  it('writes the earlier category back with the revision it wrote when one existed', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.seedMemory('coffee', 'Shopping', 3);
    const h = await setup({ backend, hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    const { cid } = h.first();
    expect(h.first().memory).toMatchObject({ previous: { category: 'Shopping', revision: 3 }, written: { revision: 4 } });
    expect(backend.memoryFor('coffee')).toMatchObject({ category: 'Transport', revision: 4 });

    await run(() => h.actions.undo(cid));

    expect(writes(h, 'PUT', MEMORY)[1]?.body).toEqual({ noteKey: 'coffee', category: 'Shopping', expectedRevision: 4 });
    expect(backend.memoryFor('coffee')).toMatchObject({ category: 'Shopping', revision: 5 });
    expect(h.memory.readView().memory[0]).toMatchObject({ category: 'Shopping' });
  });

  it('leaves a newer change in place when the entry changed after this entry wrote it', async () => {
    const backend = new FakeQuickAddBackend(MONTH, { categories: CATEGORIES });
    backend.seedMemory('coffee', 'Shopping', 3);
    backend.seedMemory('metro', 'Transport', 1);
    const h = await setup({ backend, hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    backend.changeMemoryElsewhere('coffee', 'Health');

    const result = await run(() => h.actions.undo(h.first().cid));

    expect(result).toMatchObject({ status: 'removed' });
    expect(backend.memoryFor('coffee')).toMatchObject({ category: 'Health', revision: 5 });
    expect(backend.memoryFor('metro')).toMatchObject({ category: 'Transport', revision: 1 });
    expect(h.first().memory.phase).toBe('none');
    expect(backend.expenses).toHaveLength(0);
  });

  it('leaves a newer change in place when the entry had written a new key and it was changed later', async () => {
    const h = await setup({ hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    h.backend.changeMemoryElsewhere('coffee', 'Health');

    await run(() => h.actions.undo(h.first().cid));

    expect(h.backend.memoryFor('coffee')).toMatchObject({ category: 'Health', revision: 2 });
  });

  it('waits for a memory write that is still in flight before restoring', async () => {
    const h = await setup({ hints: true });
    const gate = h.net.hold('PUT', MEMORY);

    const saving = h.actions.submit({ line: '120 coffee', category: 'Transport' });
    await vi.waitFor(() => {
      expect(h.first().phase).toBe('saved');
      expect(h.first().memory.phase).toBe('saving');
    });
    const undoing = h.actions.undo(h.first().cid);
    await vi.waitFor(() => expect(h.first().phase).toBe('undone'));
    expect(h.backend.memory).toHaveLength(0);

    await run(async () => {
      gate.release();
      await Promise.all([saving, undoing]);
    });
    expect(h.backend.memory).toHaveLength(0);
    expect(writes(h, 'PUT', MEMORY)).toHaveLength(1);
    expect(h.first().memory.phase).toBe('none');
  });

  it('does not restore anything for an entry that was already removed', async () => {
    const h = await setup({ hints: true });
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    h.backend.removeElsewhere(h.first().expenseId ?? 0);

    await run(() => h.actions.undo(h.first().cid));

    expect(h.backend.memoryFor('coffee')).toMatchObject({ category: 'Transport' });
    expect(writes(h, 'DELETE', `${MEMORY}/${h.backend.memoryFor('coffee')?.id}`)).toHaveLength(0);
  });
});

describe('recalculate', () => {
  it('re-reads the snapshot of the entry month and refreshes the answer without sending the entry again', async () => {
    const h = await setup();
    h.backend.calculationFailed = true;
    h.backend.recoverOnRead = false;
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const { cid, expenseId } = h.first();
    expect(h.first().answer?.status).toBe('calculation_failed');
    expect(h.first().answer?.actions.some((action) => action.key === 'recalculate')).toBe(true);

    // A newer version exists on the server by the time the User asks again.
    h.backend.calculationFailed = false;
    h.backend.changeElsewhere(expenseId ?? 0, 'coffee');
    const before = h.requests().length;

    const result = await run(() => h.actions.recalculate(cid));

    expect(result).toEqual({ status: 'recalculated', answerUpdated: true });
    expect(h.requests().slice(before)).toEqual(['GET /finance/clarity']);
    expect(h.net.calls[before]?.query.get('month')).toBe(MONTH);
    expect(h.first().answer?.status).toBe('available');
    expect(h.first().answer?.lines[0]).toMatchObject({ key: 'answer.saved' });
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);
    expect(h.backend.expenses).toHaveLength(1);
    // The snapshot cache holds the re-read snapshot.
    expect(h.queryClient.getQueryData<{ dataVersion: number }>(['clarity', MONTH])?.dataVersion).toBe(h.first().answer?.dataVersion);
  });

  it('keeps the answer and reports a failed read', async () => {
    const h = await setup();
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const answer = h.first().answer;
    h.backend.failWith('GET', '/finance/clarity', { status: 503, code: 'SERVER_BUSY' });

    expect(await run(() => h.actions.recalculate(h.first().cid))).toEqual({ status: 'failed' });
    expect(h.first().answer).toBe(answer);
    expect(h.requests().filter((request) => request.startsWith('POST'))).toHaveLength(1);
  });

  it('has nothing to recalculate for an entry that is not saved', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 500, code: 'SERVER_ERROR' });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    expect(await run(() => h.actions.recalculate(h.first().cid))).toEqual({ status: 'unavailable' });
    expect(h.requests()).toEqual([`POST ${EXPENSES}`]);
  });
});

describe('rollout flag and privacy', () => {
  it('makes every action a no-op with zero requests while Quick_Add_Enabled is off', async () => {
    const h = await setup({ enabled: false });
    h.store.dispatch({ type: 'line/set', line: '120 coffee' });

    const results = await run(async () => [
      await h.actions.submit(),
      await h.actions.retry('x'),
      h.actions.edit('x'),
      h.actions.discard('x'),
      await h.actions.undo('x'),
      await h.actions.changeCategory('x', 'Food'),
      await h.actions.setExclusion('x', true),
      await h.actions.forgetMemory({ noteKey: 'coffee' }),
      await h.actions.recalculate('x'),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(9).fill('disabled'));
    expect(h.net.calls).toHaveLength(0);
    expect(h.store.getState().line).toBe('120 coffee');
    expect(h.all()).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.reported).not.toHaveBeenCalled();
  });

  it('is off when only one of the two flags is on', async () => {
    const h = await setup();
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'false');
    expect(await run(() => h.actions.submit({ line: '120 coffee' }))).toEqual({ status: 'disabled' });
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    expect(await run(() => h.actions.submit({ line: '120 coffee' }))).toEqual({ status: 'disabled' });
    expect(h.net.calls).toHaveLength(0);
  });

  it('writes nothing to the console, storage, cookies, or the address through a full save, change, failure, and undo', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name));
    const address = window.location.href;
    const h = await setup({ hints: true });
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '450 swiggy private note' }));
    await run(() => h.actions.retry(h.first().cid));
    await run(() => h.actions.changeCategory(h.first().cid, 'Shopping'));
    await run(() => h.actions.undo(h.first().cid));

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.location.href).toBe(address);
  });

  it('discards a response that arrives after sign-out and keeps no entry', async () => {
    const h = await setup();
    const gate = h.net.hold('POST', EXPENSES);
    let pending!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      pending = h.actions.submit({ line: '120 coffee' });
    });
    expect(h.all()).toHaveLength(1);

    act(() => {
      clearAuth();
    });
    expect(h.all()).toHaveLength(0);
    await act(async () => {
      gate.release();
      expect(await pending).toMatchObject({ status: 'discarded' });
    });
    expect(h.all()).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.reported).not.toHaveBeenCalled();
  });
});

describe('recalculate and undo at an unchanged data version (Requirement 9.15)', () => {
  it('replaces a failed answer with the recalculated one at the same version, and only once', async () => {
    const h = await setup();
    h.backend.calculationFailed = true;
    h.backend.recoverOnRead = false;
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const { cid } = h.first();
    const failed = h.first().answer;
    expect(failed?.status).toBe('calculation_failed');
    expect(failed?.actions.some((action) => action.key === 'recalculate')).toBe(true);

    // The server recovers without any data change, so the re-read carries the same version.
    h.backend.calculationFailed = false;
    const versionBefore = h.backend.dataVersion;
    const result = await run(() => h.actions.recalculate(cid));

    expect(h.backend.dataVersion).toBe(versionBefore);
    expect(result).toEqual({ status: 'recalculated', answerUpdated: true });
    const recovered = h.entry(cid).answer;
    expect(recovered?.status).toBe('available');
    expect(recovered?.dataVersion).toBe(failed?.dataVersion);
    expect(recovered).not.toBe(failed);
    expect(recovered?.actions.some((action) => action.key === 'recalculate')).toBe(false);
    expect(selectCurrentAnswerEntry(h.store.getState())?.answer).toBe(recovered);
    // The entry is read, never sent again.
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);
    expect(h.backend.expenses).toHaveLength(1);

    // A second read at the same version leaves the available answer alone.
    const again = await run(() => h.actions.recalculate(cid));
    expect(again).toEqual({ status: 'recalculated', answerUpdated: false });
    expect(h.entry(cid).answer).toBe(recovered);
  });

  it('keeps the failed answer when the recalculation fails again at the same version', async () => {
    const h = await setup();
    h.backend.calculationFailed = true;
    h.backend.recoverOnRead = false;
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const failed = h.first().answer;

    const result = await run(() => h.actions.recalculate(h.first().cid));

    expect(result).toEqual({ status: 'recalculated', answerUpdated: false });
    expect(h.first().answer).toBe(failed);
    expect(h.first().answer?.status).toBe('calculation_failed');
  });

  it('refreshes a failed answer from the re-read after a 404 undo, even when the version did not move', async () => {
    const h = await setup();
    h.backend.calculationFailed = true;
    h.backend.recoverOnRead = false;
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const { cid, expenseId } = h.first();
    const failed = h.first().answer;
    expect(failed?.status).toBe('calculation_failed');

    // Another device removed it, and the server reports the same version with the calculation recovered.
    h.backend.removeElsewhere(expenseId ?? 0);
    h.backend.dataVersion -= 1;
    h.backend.calculationFailed = false;

    const result = await run(() => h.actions.undo(cid));

    expect(result).toEqual({ status: 'already_removed', cid });
    expect(h.entry(cid)).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    const answer = h.entry(cid).answer;
    expect(answer?.mode).toBe('removed');
    expect(answer?.status).toBe('available');
    expect(answer?.dataVersion).toBe(failed?.dataVersion);
    expect(h.store.getState().announcements.map((item) => item.text)).toContain(ALREADY_REMOVED_TEXT);
  });

  it('keeps the held answer and still reports the entry as removed when the re-read after a 404 fails', async () => {
    const h = await setup();
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const { cid, expenseId } = h.first();
    const held = h.first().answer;
    h.backend.removeElsewhere(expenseId ?? 0);
    h.backend.failWith('GET', '/finance/clarity', { status: 503, code: 'SERVER_BUSY' });

    const result = await run(() => h.actions.undo(cid));

    expect(result).toEqual({ status: 'already_removed', cid });
    expect(h.entry(cid)).toMatchObject({ phase: 'undone', alreadyRemoved: true });
    expect(h.entry(cid).answer).toBe(held);
    expect(h.events.map((event) => event.kind)).toEqual(['create']);
  });
});

describe('waking up, the 60-second timeout, and the five-pending limit through the actions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the waking-up state after exactly 5 seconds, sends nothing again, and clears it on confirmation', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    const gate = h.net.hold('POST', EXPENSES);
    let pending!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      pending = h.actions.submit({ line: '120 coffee' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(h.first().wakingUp).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(h.first()).toMatchObject({ phase: 'pending', wakingUp: true });
    expect(WAKING_UP_TEXT).toContain('may be waking up');
    expect(WAKING_UP_TEXT).toContain('still saving');
    expect(WAKING_UP_TEXT).toContain('not sent again');
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);
    // The waking-up state is not announced.
    expect(h.store.getState().announcements).toHaveLength(0);

    await act(async () => {
      gate.release();
      await pending;
    });
    expect(h.first()).toMatchObject({ phase: 'saved', wakingUp: false });
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(1);
  });

  it('never shows waking up for an entry that is confirmed in under 5 seconds', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    await act(async () => {
      await h.actions.submit({ line: '120 coffee' });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.first()).toMatchObject({ phase: 'saved', wakingUp: false });
  });

  it('restarts the 5-second clock on retry and times the retry out after 60 seconds with the same key', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await act(async () => {
      await h.actions.submit({ line: '120 coffee' });
    });
    expect(h.first().phase).toBe('failed');
    expect(h.first().wakingUp).toBe(false);

    const gate = h.net.hold('POST', EXPENSES);
    let retrying!: ReturnType<QuickAddActions['retry']>;
    act(() => {
      retrying = h.actions.retry(h.first().cid);
    });
    expect(h.first()).toMatchObject({ phase: 'pending', wakingUp: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(h.first()).toMatchObject({ phase: 'pending', wakingUp: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
      await retrying;
    });
    expect(h.first()).toMatchObject({ phase: 'failed', wakingUp: false });
    expect(h.first().error).toMatchObject({ code: REQUEST_TIMEOUT_CODE, retryable: true });

    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await h.actions.retry(h.first().cid);
    });
    const keys = writes(h, 'POST', EXPENSES).map((call) => call.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(h.first().phase).toBe('saved');
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('refuses a retry while five entries are pending, then allows it when one settles', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '5 failed' }));
    const failedCid = h.first().cid;

    const gates = Array.from({ length: 5 }, () => h.net.hold('POST', EXPENSES));
    const pending = Array.from({ length: 5 }, (_, index) => h.actions.submit({ line: `${index + 1}0 coffee` }));
    expect(h.all().filter((entry) => entry.phase === 'pending')).toHaveLength(5);

    const blocked = await run(() => h.actions.retry(failedCid));
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(h.entry(failedCid).phase).toBe('failed');
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(6);

    await run(async () => {
      gates[0]?.release();
      await pending[0];
    });
    const retried = await run(async () => {
      gates.slice(1).forEach((gate) => gate.release());
      return h.actions.retry(failedCid);
    });
    expect(retried).toEqual({ status: 'confirmed', cid: failedCid });
    await run(() => Promise.all(pending));
    expect(h.all().every((entry) => entry.phase === 'saved')).toBe(true);
    expect(h.backend.expenses).toHaveLength(6);
  });
});

describe('the Undo window through the actions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function savedAt(h: Harness) {
    await act(async () => {
      await h.actions.submit({ line: '120 coffee' });
    });
    return h.first().cid;
  }

  it('holds the window while the control is hovered or focused and ends it 8 seconds after the pause ends', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    const cid = await savedAt(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    act(() => {
      h.store.dispatch({ type: 'undo/pause', cid, source: 'pointer' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // Paused: 5 seconds are left, however long the pointer stays.
    expect(isUndoAvailable(h.entry(cid))).toBe(true);
    expect(h.entry(cid).undo).toMatchObject({ pausedRemainingMs: 5_000 });

    // Focus joins, the pointer leaves: still held.
    act(() => {
      h.store.dispatch({ type: 'undo/pause', cid, source: 'focus' });
      h.store.dispatch({ type: 'undo/resume', cid, source: 'pointer' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.entry(cid).undo).toMatchObject({ pausedRemainingMs: 5_000 });

    act(() => {
      h.store.dispatch({ type: 'undo/resume', cid, source: 'focus' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(isUndoAvailable(h.entry(cid))).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(isUndoAvailable(h.entry(cid))).toBe(false);
    expect(await h.actions.undo(cid)).toEqual({ status: 'unavailable' });
    expect(writes(h, 'DELETE', `${EXPENSES}/${h.entry(cid).expenseId}`)).toHaveLength(0);
    expect(h.backend.expenses).toHaveLength(1);
  });

  it('undoes an entry whose window is paused, long after 8 seconds, and ends the window for good', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    const cid = await savedAt(h);
    act(() => {
      h.store.dispatch({ type: 'undo/pause', cid, source: 'focus' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const result = await act(async () => h.actions.undo(cid));

    expect(result).toEqual({ status: 'removed', cid });
    expect(h.entry(cid).phase).toBe('undone');
    expect(h.entry(cid).undo).toBeUndefined();
    expect(h.backend.expenses).toHaveLength(0);
  });

  it('removes an entry that expired at the 8-second mark only if the click came first', async () => {
    vi.useFakeTimers({ now: NOW });
    const h = await setup();
    const cid = await savedAt(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_999);
    });

    const result = await act(async () => h.actions.undo(cid));

    expect(result).toEqual({ status: 'removed', cid });
    expect(h.backend.expenses).toHaveLength(0);
  });
});

describe('undo, edit, and announcements for entries in other states', () => {
  it('offers no Undo while the save is still pending, and Undo works once it is confirmed', async () => {
    const h = await setup();
    const gate = h.net.hold('POST', EXPENSES);
    let pending!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      pending = h.actions.submit({ line: '120 coffee' });
    });
    const { cid } = h.first();
    expect(isUndoAvailable(h.entry(cid))).toBe(false);

    expect(await run(() => h.actions.undo(cid))).toEqual({ status: 'unavailable' });
    expect(h.entry(cid).phase).toBe('pending');
    expect(h.requests().filter((request) => request.startsWith('DELETE'))).toEqual([]);

    await run(async () => {
      gate.release();
      await pending;
    });
    expect(isUndoAvailable(h.entry(cid))).toBe(true);
    expect(await run(() => h.actions.undo(cid))).toEqual({ status: 'removed', cid });
    expect(h.backend.expenses).toHaveLength(0);
  });

  it('offers no Undo for a failed entry, which has no expense to remove', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '120 coffee' }));

    expect(await run(() => h.actions.undo(h.first().cid))).toEqual({ status: 'unavailable' });
    expect(h.requests()).toEqual([`POST ${EXPENSES}`]);
  });

  it('edits a failed entry after a retryable failure: the failed command is dropped and the next submission gets a new key', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '450 swiggy yesterday' }));
    const failedCid = h.first().cid;
    expect(h.first().error).toMatchObject({ retryable: true });

    const edited = h.actions.edit(failedCid);

    expect(edited).toEqual({ status: 'edited', line: '₹450 2026-11-17 "swiggy"' });
    expect(h.store.getState().line).toBe('₹450 2026-11-17 "swiggy"');
    expect(h.all()).toHaveLength(0);
    // The row is gone, so there is nothing to retry or edit again.
    expect(await run(() => h.actions.retry(failedCid))).toEqual({ status: 'unavailable' });
    expect(h.actions.edit(failedCid)).toEqual({ status: 'unavailable' });

    await run(() => h.actions.submit());
    const posts = writes(h, 'POST', EXPENSES);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).not.toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(h.backend.expenses).toHaveLength(1);
    expect(h.first().phase).toBe('saved');
  });

  it('discards a failed row with its status and nothing else, and refuses to discard a pending row', async () => {
    const h = await setup();
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '120 coffee' }));
    const gate = h.net.hold('POST', EXPENSES);
    let pending!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      pending = h.actions.submit({ line: '70 tea' });
    });
    const [failedRow, pendingRow] = h.all();

    expect(h.actions.discard(pendingRow?.cid ?? '')).toEqual({ status: 'unavailable' });
    expect(h.actions.discard(failedRow?.cid ?? '')).toEqual({ status: 'discarded' });
    expect(h.all().map((entry) => entry.cid)).toEqual([pendingRow?.cid]);
    // A discarded row cannot be resent.
    expect(await run(() => h.actions.retry(failedRow?.cid ?? ''))).toEqual({ status: 'unavailable' });

    await run(async () => {
      gate.release();
      await pending;
    });
    expect(h.backend.expenses).toHaveLength(1);
    expect(writes(h, 'POST', EXPENSES)).toHaveLength(2);
  });

  it('announces a confirmed save, a failure, a change, and an undo once each, and never a pending state', async () => {
    const h = await setup();
    const texts = () => h.store.getState().announcements.map((item) => item.text);
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });

    const gate = h.net.hold('POST', EXPENSES);
    let submitting!: ReturnType<QuickAddActions['submit']>;
    act(() => {
      submitting = h.actions.submit({ line: '120 coffee' });
    });
    // Typing and pending are silent.
    h.store.dispatch({ type: 'line/set', line: '4' });
    expect(texts()).toEqual([]);
    await run(async () => {
      gate.release();
      await submitting;
    });
    expect(texts()).toEqual([SAVE_FAILED_TEXT]);

    await run(() => h.actions.retry(h.first().cid));
    expect(texts()).toEqual([SAVE_FAILED_TEXT, 'Saved ₹120 to Food. Counts toward November 2026.']);

    await run(() => h.actions.changeCategory(h.first().cid, 'Shopping'));
    expect(texts()).toEqual([SAVE_FAILED_TEXT, 'Saved ₹120 to Food. Counts toward November 2026.', 'Category changed to Shopping.']);

    h.backend.failWith('DELETE', `${EXPENSES}/${h.first().expenseId}`, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.undo(h.first().cid));
    await run(() => h.actions.retry(h.first().cid));

    expect(texts()).toEqual([
      SAVE_FAILED_TEXT,
      'Saved ₹120 to Food. Counts toward November 2026.',
      'Category changed to Shopping.',
      UNDO_FAILED_TEXT,
      REMOVED_TEXT,
    ]);
    expect(h.store.getState().announcements.every((item) => item.assertive === false)).toBe(true);
    expect(new Set(h.store.getState().announcements.map((item) => item.key)).size).toBe(5);
  });

  it('discards every entry, draft, announcement, and status on sign-out', async () => {
    const h = await setup({ hints: true });
    h.backend.failWith('POST', EXPENSES, { status: 503, code: 'SERVER_BUSY' });
    await run(() => h.actions.submit({ line: '10 failed' }));
    await run(() => h.actions.submit({ line: '120 coffee', category: 'Transport' }));
    h.store.dispatch({ type: 'line/set', line: '99 tea' });
    h.store.dispatch({ type: 'dialog/set', open: true });
    expect(h.all()).toHaveLength(2);
    expect(h.store.getState().announcements.length).toBeGreaterThan(0);
    const generation = h.store.getGeneration();

    act(() => {
      clearAuth();
    });

    expect(h.store.getState()).toBe(initialQuickAddState);
    expect(h.store.getGeneration()).toBe(generation + 1);
    // Nothing is left to retry, undo, or restore for the cleared session.
    h.net.calls.length = 0;
    expect(await run(() => h.actions.retry('anything'))).toEqual({ status: 'unavailable' });
    expect(await run(() => h.actions.undo('anything'))).toEqual({ status: 'unavailable' });
    expect(h.net.calls).toHaveLength(0);
  });
});
