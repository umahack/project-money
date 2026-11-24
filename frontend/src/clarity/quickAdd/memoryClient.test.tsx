import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_NOTICE_REQUIRED_EVENT, clearAuth } from '../../api';
import { createApiResponse } from '../../test/test-utils';
import { queryClient, queryKeys } from '../queryClient';
import {
  createMemoryClient,
  findMemoryEntry,
  memoryClient,
  selectSuggestionSources,
  useQuickAddHints,
  useSuggestionSources,
  type MemoryClient,
  type QuickAddHints,
} from './memoryClient';
import { suggestCategory } from './suggester';

const CATEGORIES = ['Food', 'Transport', 'Other'];

function hintsBody(overrides: Partial<QuickAddHints> = {}): QuickAddHints {
  return {
    schemaVersion: 1,
    memory: [
      { id: 12, noteKey: 'coffee', category: 'Food', revision: 2, updatedAt: '2026-11-10T07:12:03.121Z' },
      { id: 7, noteKey: 'metro', category: 'Transport', revision: 1, updatedAt: '2026-11-09T07:12:03.121Z' },
    ],
    history: [{ noteKey: 'swiggy', category: 'Food', lastSpentOn: '2026-11-17' }],
    limits: { memoryEntries: 500, historyDays: 90, historyKeys: 500 },
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status?: number; body: unknown } | 'network' | 'hang';

/** Routes every request of the test to `handler` and records it. */
function fakeServer(handler: (call: Call, calls: Call[]) => Reply) {
  const calls: Call[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path: String(input).replace(/^\/api/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    };
    calls.push(call);
    const reply = handler(call, calls);
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if (reply === 'hang') return new Promise<Response>(() => undefined);
    return createApiResponse(reply);
  });
  return calls;
}

function entryReply(call: Call, revision = 3) {
  const { noteKey, category } = call.body as { noteKey: string; category: string };
  // The server keeps one entry per Note_Key, so `coffee` is entry 12 and any other key is a new entry.
  const id = noteKey === 'coffee' ? 12 : noteKey === 'metro' ? 7 : 40;
  return {
    body: {
      schemaVersion: 1,
      created: id === 40,
      evicted: false,
      entry: { id, noteKey, category, revision, updatedAt: '2026-11-18T01:00:00.000Z' },
    },
  };
}

function isolated(isEnabled = true): { client: MemoryClient; cache: QueryClient } {
  const cache = new QueryClient();
  return { cache, client: createMemoryClient({ queryClient: cache, isEnabled: () => isEnabled }) };
}

function wrapperFor(cache: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={cache}>{children}</QueryClientProvider>;
  };
}

function cachedHints(cache: QueryClient) {
  return cache.getQueryData<QuickAddHints>(queryKeys.quickAddHints());
}

const hintCalls = (calls: Call[]) => calls.filter((call) => call.path === '/finance/quick-add/hints');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  memoryClient.reset();
  queryClient.clear();
});

describe('hints query', () => {
  it('reads the hints once per page load however often they are asked for', async () => {
    const calls = fakeServer(() => ({ body: hintsBody() }));
    const { client, cache } = isolated();

    const first = renderHook(() => useQuickAddHints(client), { wrapper: wrapperFor(cache) });
    const second = renderHook(() => useQuickAddHints(client), { wrapper: wrapperFor(cache) });
    expect(first.result.current.state).toBe('loading');
    await waitFor(() => expect(first.result.current.state).toBe('ready'));
    await client.loadHints();
    await client.loadHints();
    first.unmount();
    renderHook(() => useQuickAddHints(client), { wrapper: wrapperFor(cache) });

    expect(second.result.current.state).toBe('ready');
    expect(hintCalls(calls)).toHaveLength(1);
    expect(hintCalls(calls)[0]).toMatchObject({ method: 'GET', body: undefined });
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it('is unavailable after a failed read and does not read again', async () => {
    const calls = fakeServer(() => ({ status: 500, body: { error: 'boom' } }));
    const { client, cache } = isolated();

    await expect(client.loadHints()).rejects.toMatchObject({ status: 500 });
    await expect(client.loadHints()).rejects.toMatchObject({ status: 500 });
    const mounted = renderHook(() => useQuickAddHints(client), { wrapper: wrapperFor(cache) });

    await waitFor(() => expect(mounted.result.current.state).toBe('unavailable'));
    expect(hintCalls(calls)).toHaveLength(1);
    expect(selectSuggestionSources(mounted.result.current)).toEqual({ memory: [], history: [] });
  });

  it('treats an unsupported response as unavailable', async () => {
    fakeServer(() => ({ body: { schemaVersion: 2, memory: [], history: [] } }));
    const { client } = isolated();
    await expect(client.loadHints()).rejects.toMatchObject({ code: 'UNSUPPORTED_QUICK_ADD_HINTS' });
    expect(client.readView().state).toBe('unavailable');
  });

  it('sends no request at all while Quick_Add_Enabled is off', async () => {
    const calls = fakeServer(() => ({ body: hintsBody() }));
    const { client, cache } = isolated(false);

    const mounted = renderHook(() => useSuggestionSources(client), { wrapper: wrapperFor(cache) });
    expect(await client.loadHints()).toBeNull();
    expect(await client.remember('entry-1', { noteKey: 'coffee', category: 'Food' })).toMatchObject({ status: 'disabled' });
    expect(await client.forget('entry-1', { id: 12 })).toMatchObject({ status: 'disabled' });
    expect(await client.forgetAll('all')).toMatchObject({ status: 'disabled' });

    expect(client.readView().state).toBe('disabled');
    expect(mounted.result.current).toEqual({ memory: [], history: [] });
    expect(calls).toHaveLength(0);
  });

  it('follows the real flags: off by default and off when only one flag is set', async () => {
    const calls = fakeServer(() => ({ body: hintsBody() }));
    expect(await memoryClient.loadHints()).toBeNull();
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    expect(await memoryClient.loadHints()).toBeNull();
    expect(calls).toHaveLength(0);

    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    expect((await memoryClient.loadHints())?.memory).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('is cleared with the rest of the memory-only state when auth is cleared', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    const calls = fakeServer((call) => (call.method === 'PUT' ? { status: 404, body: { error: { code: 'QUICK_ADD_DISABLED', message: 'off' } } } : { body: hintsBody() }));
    await memoryClient.loadHints();
    await memoryClient.remember('entry-1', { noteKey: 'coffee', category: 'Food' });
    expect(queryClient.getQueryData(queryKeys.quickAddHints())).toBeDefined();
    expect(memoryClient.getState().memoryUnavailable).toBe(true);
    expect(memoryClient.getStatus('entry-1')).toBeDefined();

    clearAuth();

    expect(queryClient.getQueryData(queryKeys.quickAddHints())).toBeUndefined();
    expect(memoryClient.getState().memoryUnavailable).toBe(false);
    expect(memoryClient.getStatus('entry-1')).toBeUndefined();
    await memoryClient.loadHints();
    expect(hintCalls(calls)).toHaveLength(2);
  });

  it('drops a response that arrives after auth was cleared', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'PUT') await held;
      return createApiResponse({ body: init?.method === 'PUT' ? { schemaVersion: 1, entry: { id: 1, noteKey: 'tea', category: 'Food', revision: 1, updatedAt: 'x' } } : hintsBody() });
    });
    await memoryClient.loadHints();
    const write = memoryClient.remember('entry-1', { noteKey: 'tea', category: 'Food' });
    clearAuth();
    release?.();
    await write;

    expect(queryClient.getQueryData(queryKeys.quickAddHints())).toBeUndefined();
    expect(memoryClient.getStatus('entry-1')).toBeUndefined();
  });
});

describe('memory writes update the cached hints in place', () => {
  it('puts a closed body without an idempotency key, then updates the cache with no further read', async () => {
    const calls = fakeServer((call) => (call.method === 'PUT' ? entryReply(call) : { body: hintsBody() }));
    const { client, cache } = isolated();
    await client.loadHints();

    const result = await client.remember('entry-1', { noteKey: 'coffee', category: 'Transport', expectedRevision: 2 });

    expect(result).toMatchObject({ status: 'saved', operation: 'remember', retryable: false });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put).toMatchObject({
      path: '/finance/category-memory',
      body: { noteKey: 'coffee', category: 'Transport', expectedRevision: 2 },
    });
    expect(Object.keys(put?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain('idempotency-key');
    expect(cachedHints(cache)?.memory[0]).toMatchObject({ id: 12, noteKey: 'coffee', category: 'Transport', revision: 3 });
    expect(cachedHints(cache)?.memory).toHaveLength(2);
    expect(hintCalls(calls)).toHaveLength(1);
    expect(client.getStatus('entry-1')).toMatchObject({ status: 'saved' });
  });

  it('omits expectedRevision for a first write and adds a new entry at the front', async () => {
    const calls = fakeServer((call) => (call.method === 'PUT' ? entryReply(call, 1) : { body: hintsBody() }));
    const { client, cache } = isolated();
    await client.loadHints();

    await client.remember('entry-1', { noteKey: 'chai', category: 'Food' });

    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ noteKey: 'chai', category: 'Food' });
    expect(cachedHints(cache)?.memory.map((entry) => entry.noteKey)).toEqual(['chai', 'coffee', 'metro']);
  });

  it('keeps at most the server limit, dropping the oldest entries', async () => {
    fakeServer((call) => (call.method === 'PUT' ? entryReply(call) : { body: hintsBody({ limits: { memoryEntries: 2, historyDays: 90, historyKeys: 500 } }) }));
    const { client, cache } = isolated();
    await client.loadHints();

    await client.remember('entry-1', { noteKey: 'chai', category: 'Food' });

    expect(cachedHints(cache)?.memory.map((entry) => entry.noteKey)).toEqual(['chai', 'coffee']);
  });

  it('removes one entry, or all of them, from the cache without another read', async () => {
    const calls = fakeServer((call) => (call.method === 'DELETE' ? { body: { schemaVersion: 1, deleted: true } } : { body: hintsBody() }));
    const { client, cache } = isolated();
    await client.loadHints();

    expect(await client.forget('row-12', { id: 12, expectedRevision: 2 })).toMatchObject({ status: 'saved', operation: 'forget' });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/finance/category-memory/12?expectedRevision=2' });
    expect(cachedHints(cache)?.memory.map((entry) => entry.id)).toEqual([7]);

    await client.forgetAll('all');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/finance/category-memory' });
    expect(cachedHints(cache)?.memory).toEqual([]);
    expect(cachedHints(cache)?.history).toHaveLength(1);
    expect(hintCalls(calls)).toHaveLength(1);
  });

  it('counts an already-deleted entry as forgotten and leaves a newer change alone on a revision conflict', async () => {
    fakeServer((call) => (call.path.endsWith('/12')
      ? { status: 404, body: { error: { code: 'MEMORY_NOT_FOUND', message: 'gone' } } }
      : call.path.includes('/7?')
        ? { status: 409, body: { error: { code: 'MEMORY_REVISION_CONFLICT', message: 'changed' } } }
        : { body: hintsBody() }));
    const { client, cache } = isolated();
    await client.loadHints();

    expect(await client.forget('a', { id: 12 })).toMatchObject({ status: 'saved' });
    expect(await client.forget('b', { id: 7, expectedRevision: 1 })).toMatchObject({
      status: 'conflict', code: 'MEMORY_REVISION_CONFLICT', retryable: false,
    });
    expect(cachedHints(cache)?.memory.map((entry) => entry.id)).toEqual([7]);
  });

  it('shares one request among repeated calls for the same entry', async () => {
    const calls = fakeServer((call) => (call.method === 'PUT' ? entryReply(call) : { body: hintsBody() }));
    const { client } = isolated();
    await client.loadHints();

    const [first, second] = await Promise.all([
      client.remember('entry-1', { noteKey: 'coffee', category: 'Food' }),
      client.remember('entry-1', { noteKey: 'coffee', category: 'Food' }),
    ]);

    expect(first).toBe(second);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('keeps a separate status for each entry', async () => {
    fakeServer((call) => (call.method === 'PUT' && (call.body as { noteKey: string }).noteKey === 'bad'
      ? { status: 500, body: { error: 'down' } }
      : call.method === 'PUT' ? entryReply(call) : { body: hintsBody() }));
    const { client } = isolated();
    await client.loadHints();

    await Promise.all([
      client.remember('entry-1', { noteKey: 'coffee', category: 'Food' }),
      client.remember('entry-2', { noteKey: 'bad', category: 'Food' }),
    ]);

    expect(client.getStatus('entry-1')?.status).toBe('saved');
    expect(client.getStatus('entry-2')).toMatchObject({ status: 'failed', retryable: true });
  });
});

describe('server flag off (404 QUICK_ADD_DISABLED)', () => {
  const disabledReply = { status: 404, body: { error: { code: 'QUICK_ADD_DISABLED', message: 'Quick Add category memory is unavailable.' } } };

  it('makes memory unavailable while history and the other sources keep suggesting', async () => {
    const calls = fakeServer((call) => (call.method === 'PUT' ? disabledReply : { body: hintsBody() }));
    const { client } = isolated();
    await client.loadHints();
    const before = selectSuggestionSources(client.readView());
    expect(suggestCategory({ note: 'coffee', categories: CATEGORIES, ...before }).source).toBe('memory');

    const result = await client.remember('entry-1', { noteKey: 'coffee', category: 'Transport' });

    expect(result).toMatchObject({ status: 'unavailable', code: 'QUICK_ADD_DISABLED', retryable: false });
    const view = client.readView();
    expect(view).toMatchObject({ state: 'ready', memoryUnavailable: true });
    const sources = selectSuggestionSources(view);
    expect(sources.memory).toEqual([]);
    expect(suggestCategory({ note: 'coffee', categories: CATEGORIES, ...sources })).toMatchObject({ source: 'keyword' });
    expect(suggestCategory({ note: 'swiggy', categories: CATEGORIES, ...sources })).toMatchObject({ source: 'history', category: 'Food' });
    expect(findMemoryEntry(view, 'coffee')).toBeUndefined();

    // Later writes send nothing. Deleting stays possible.
    const putsBefore = calls.filter((call) => call.method === 'PUT').length;
    expect(await client.remember('entry-2', { noteKey: 'metro', category: 'Food' })).toMatchObject({ status: 'unavailable' });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(putsBefore);
  });

  it('treats the same answer to the hints read as memory unavailable', async () => {
    fakeServer(() => disabledReply);
    const { client } = isolated();
    await expect(client.loadHints()).rejects.toMatchObject({ status: 404, code: 'QUICK_ADD_DISABLED' });
    expect(client.readView()).toMatchObject({ state: 'unavailable', memoryUnavailable: true });
  });
});

describe('data-use gate (428) and same-state retry', () => {
  it('fails retryably on 428, tells the gate, and resends the identical body after the notice', async () => {
    let acknowledged = false;
    const calls = fakeServer((call) => {
      if (call.method !== 'PUT') return { body: hintsBody() };
      return acknowledged
        ? entryReply(call)
        : { status: 428, body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Review the notice.' } } };
    });
    const { client, cache } = isolated();
    await client.loadHints();
    const noticeEvents = vi.fn();
    window.addEventListener(DATA_NOTICE_REQUIRED_EVENT, noticeEvents);

    const failed = await client.remember('entry-1', { noteKey: 'coffee', category: 'Transport', expectedRevision: 2 });
    window.removeEventListener(DATA_NOTICE_REQUIRED_EVENT, noticeEvents);

    expect(failed).toMatchObject({ status: 'failed', code: 'DATA_NOTICE_REQUIRED', httpStatus: 428, retryable: true });
    expect(noticeEvents).toHaveBeenCalledTimes(1);
    expect(cachedHints(cache)?.memory[0]).toMatchObject({ category: 'Food', revision: 2 });

    acknowledged = true;
    expect(await client.retry('entry-1')).toMatchObject({ status: 'saved' });

    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toEqual(puts[0]?.body);
    expect(cachedHints(cache)?.memory[0]).toMatchObject({ category: 'Transport', revision: 3 });
  });

  it('retries a lost response with the same state, and keeps a delete retry the same too', async () => {
    let lose = true;
    const calls = fakeServer((call) => {
      if (call.method === 'GET') return { body: hintsBody() };
      if (lose) return 'network';
      return call.method === 'PUT' ? entryReply(call) : { body: { schemaVersion: 1, deleted: true } };
    });
    const { client, cache } = isolated();
    await client.loadHints();

    expect(await client.remember('entry-1', { noteKey: 'coffee', category: 'Food' })).toMatchObject({ status: 'failed', retryable: true });
    expect(await client.forget('row-7', { id: 7, expectedRevision: 1 })).toMatchObject({ status: 'failed', retryable: true });
    lose = false;
    expect(await client.retry('entry-1')).toMatchObject({ status: 'saved' });
    expect(await client.retry('row-7')).toMatchObject({ status: 'saved' });

    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'PUT /finance/category-memory',
      'DELETE /finance/category-memory/7?expectedRevision=1',
      'PUT /finance/category-memory',
      'DELETE /finance/category-memory/7?expectedRevision=1',
    ]);
    expect(writes[2]?.body).toEqual(writes[0]?.body);
    expect(cachedHints(cache)?.memory.map((entry) => entry.id)).toEqual([12]);
  });

  it('sends nothing on retry unless the entry failed in a way a retry can fix', async () => {
    const calls = fakeServer((call) => (call.method === 'PUT'
      ? { status: 422, body: { error: { code: 'UNKNOWN_EXPENSE_CATEGORY', message: 'Unknown category' } } }
      : { body: hintsBody() }));
    const { client } = isolated();
    await client.loadHints();

    expect(await client.remember('entry-1', { noteKey: 'coffee', category: 'Gone' })).toMatchObject({
      status: 'failed', code: 'UNKNOWN_EXPENSE_CATEGORY', retryable: false,
    });
    await client.retry('entry-1');
    await client.retry('never-started');

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('fails an unanswered write after 60 seconds and offers the same-state retry', async () => {
    vi.useFakeTimers();
    let hang = true;
    const calls = fakeServer((call) => {
      if (call.method === 'GET') return { body: hintsBody() };
      return hang ? 'hang' : entryReply(call);
    });
    const { client } = isolated();
    await client.loadHints();

    const pending = client.remember('entry-1', { noteKey: 'coffee', category: 'Food' });
    expect(client.getStatus('entry-1')?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pending).toMatchObject({ status: 'failed', code: 'REQUEST_TIMEOUT', retryable: true });
    hang = false;
    expect(await client.retry('entry-1')).toMatchObject({ status: 'saved' });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });
});

describe('suggestion sources', () => {
  it('returns the memory and history arrays only when the hints are ready, and they feed suggestCategory', async () => {
    fakeServer(() => ({ body: hintsBody() }));
    const { client, cache } = isolated();
    const mounted = renderHook(() => useSuggestionSources(client), { wrapper: wrapperFor(cache) });
    expect(mounted.result.current).toEqual({ memory: [], history: [] });

    await waitFor(() => expect(mounted.result.current.memory).toHaveLength(2));
    const stable = mounted.result.current;
    mounted.rerender();
    expect(mounted.result.current).toBe(stable);

    expect(suggestCategory({ note: 'metro', categories: CATEGORIES, ...stable })).toMatchObject({ source: 'memory', category: 'Transport' });
    expect(suggestCategory({ note: 'swiggy', categories: CATEGORIES, ...stable })).toMatchObject({ source: 'history', category: 'Food' });
  });

  it('shows a remembered choice from the next suggestion on after the entry is forgotten', async () => {
    fakeServer((call) => (call.method === 'DELETE' ? { body: { schemaVersion: 1, deleted: true } } : { body: hintsBody() }));
    const { client, cache } = isolated();
    const mounted = renderHook(() => useSuggestionSources(client), { wrapper: wrapperFor(cache) });
    await waitFor(() => expect(mounted.result.current.memory).toHaveLength(2));

    await act(async () => {
      await client.forget('row-7', { id: 7 });
    });

    expect(mounted.result.current.memory.map((entry) => entry.noteKey)).toEqual(['coffee']);
  });
});
