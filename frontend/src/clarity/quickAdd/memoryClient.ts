/**
 * Category memory client and the Quick Add hints query.
 *
 * Reads (Requirements 5.14, 5.15, 13.7):
 *   - `GET /finance/quick-add/hints` is read once per page load. The query uses `staleTime: Infinity`, never
 *     retries, never refetches on mount, focus, or reconnect, and lives only in the in-memory query cache, so it is
 *     discarded by the existing auth-clear lifecycle (`queryClient.clear()` in `queryClient.ts`).
 *   - A change to a Memory_Entry updates the cached hints in place. It never triggers another read.
 *   - The states are `disabled` (Quick_Add_Enabled is off, no request is ever sent), `loading`, `ready`, and
 *     `unavailable` (the read failed, or the server reported QUICK_ADD_DISABLED). In `loading` and `unavailable`
 *     the suggestion inputs are empty, so the suggester uses its remaining sources.
 *
 * Writes (Requirements 6.5, 6.8, 6.11, 7.20, 16.8):
 *   - `PUT /finance/category-memory`, `DELETE /finance/category-memory/:id`, and `DELETE /finance/category-memory`
 *     are not financial mutations. They carry no Idempotency-Key. A write is idempotent by state, so a retry resends
 *     the identical command.
 *   - Each caller-chosen status key (one per Quick Add entry, or per Settings row) has its own status. At most one
 *     request per key is in flight, and a repeated call while pending joins the request already sent.
 *   - A 404 `QUICK_ADD_DISABLED` marks memory unavailable for the rest of the page load. Later writes send nothing,
 *     the remembered choices stop being offered as suggestions, and history, category names, and keywords continue.
 *   - A 428 `DATA_NOTICE_REQUIRED` is a retryable failure. `api.ts` already tells the Data_Use_Gate to show the
 *     notice, so a retry after the notice is reviewed resends the same state.
 *
 * Privacy (Requirements 6.14, 13.3): the hints are exposed only through `selectSuggestionSources`, which returns the
 * `memory` and `history` inputs of `suggestCategory`. Nothing here writes notes, keys, or categories to the console
 * or to browser storage, and a status never keeps the server's message text.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import {
  ApiError,
  REQUEST_TIMEOUT_CODE,
  REQUEST_TIMEOUT_MESSAGE,
  api,
} from '../../api';
import { queryClient, queryKeys } from '../queryClient';
import { selectQuickAddEnabled } from '../rollout';
import { subscribeToFinancialStateClear } from '../stateLifecycle';
import type { HistorySuggestionEntry, MemorySuggestionEntry } from './suggester';

export const HINTS_PATH = '/finance/quick-add/hints';
export const MEMORY_PATH = '/finance/category-memory';
export const QUICK_ADD_DISABLED_CODE = 'QUICK_ADD_DISABLED';
export const MEMORY_NOT_FOUND_CODE = 'MEMORY_NOT_FOUND';
export const MEMORY_REVISION_CONFLICT_CODE = 'MEMORY_REVISION_CONFLICT';
export const DATA_NOTICE_REQUIRED_STATUS_CODE = 'DATA_NOTICE_REQUIRED';
/** Requirement 7.23: a Memory_API request with no response in 60 seconds counts as failed. */
export const MEMORY_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_LIMIT = 500;

export interface MemoryEntry {
  id: number;
  noteKey: string;
  category: string;
  revision: number;
  updatedAt: string;
}

export interface HistoryEntry {
  noteKey: string;
  category: string;
  /** `YYYY-MM-DD`. */
  lastSpentOn: string;
}

export interface QuickAddHints {
  schemaVersion: 1;
  /** Newest change first, the order the server returns. */
  memory: MemoryEntry[];
  history: HistoryEntry[];
  limits: { memoryEntries: number; historyDays: number; historyKeys: number };
}

export type QuickAddHintsState = 'disabled' | 'loading' | 'ready' | 'unavailable';

export interface QuickAddHintsView {
  state: QuickAddHintsState;
  /** True after the server reported QUICK_ADD_DISABLED. Remembered choices are then not used or written. */
  memoryUnavailable: boolean;
  /** Empty unless `state` is `ready` and memory is available. */
  memory: readonly MemoryEntry[];
  /** Empty unless `state` is `ready`. */
  history: readonly HistoryEntry[];
}

export interface SuggestionSources {
  memory: readonly MemorySuggestionEntry[];
  history: readonly HistorySuggestionEntry[];
}

export type MemoryOperation = 'remember' | 'forget' | 'forget_all';
export type MemoryStatusKind = 'pending' | 'saved' | 'failed' | 'unavailable' | 'conflict';

export interface MemoryStatus {
  status: MemoryStatusKind;
  operation: MemoryOperation;
  /** The server error code or `REQUEST_TIMEOUT`, when there is one. Never message text. */
  code?: string;
  httpStatus?: number;
  /** True only for `failed` when resending the same state can succeed. */
  retryable: boolean;
}

export interface RememberChoiceInput {
  noteKey: string;
  category: string;
  /** Present for a compensating write. The server refuses it when the entry has changed since. */
  expectedRevision?: number;
}

export interface ForgetEntryInput {
  id: number;
  expectedRevision?: number;
}

export type MemoryResult = MemoryStatus | { status: 'disabled'; retryable: false };

export interface MemoryClientState {
  statuses: ReadonlyMap<string, MemoryStatus>;
  memoryUnavailable: boolean;
}

export interface MemoryClientOptions {
  queryClient?: QueryClient;
  isEnabled?: () => boolean;
  timeoutMs?: number;
}

type Command =
  | { operation: 'remember'; input: RememberChoiceInput }
  | { operation: 'forget'; input: ForgetEntryInput }
  | { operation: 'forget_all' };

const EMPTY_MEMORY: readonly MemoryEntry[] = Object.freeze([]);
const EMPTY_HISTORY: readonly HistoryEntry[] = Object.freeze([]);
const EMPTY_SOURCES: SuggestionSources = Object.freeze({ memory: EMPTY_MEMORY, history: EMPTY_HISTORY });
const HISTORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseMemoryEntry(value: unknown): MemoryEntry | null {
  if (!isRecord(value)) return null;
  const { id, noteKey, category, revision, updatedAt } = value;
  if (!isPositiveInteger(id) || !isPositiveInteger(revision)) return null;
  if (typeof noteKey !== 'string' || typeof category !== 'string' || typeof updatedAt !== 'string') return null;
  return { id, noteKey, category, revision, updatedAt };
}

function parseHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  const { noteKey, category, lastSpentOn } = value;
  if (typeof noteKey !== 'string' || typeof category !== 'string') return null;
  if (typeof lastSpentOn !== 'string' || !HISTORY_DATE_PATTERN.test(lastSpentOn)) return null;
  return { noteKey, category, lastSpentOn };
}

function unsupportedHints(): ApiError {
  return new ApiError(0, 'The server returned an unsupported Quick Add hints response.', {
    code: 'UNSUPPORTED_QUICK_ADD_HINTS',
  });
}

/** Strict parse: any malformed part makes the whole read unavailable instead of guessing. */
export function parseQuickAddHints(value: unknown): QuickAddHints {
  if (!isRecord(value) || value.schemaVersion !== 1) throw unsupportedHints();
  if (!Array.isArray(value.memory) || !Array.isArray(value.history)) throw unsupportedHints();
  const memory: MemoryEntry[] = [];
  for (const item of value.memory) {
    const entry = parseMemoryEntry(item);
    if (entry === null) throw unsupportedHints();
    memory.push(entry);
  }
  const history: HistoryEntry[] = [];
  for (const item of value.history) {
    const entry = parseHistoryEntry(item);
    if (entry === null) throw unsupportedHints();
    history.push(entry);
  }
  const limits = isRecord(value.limits) ? value.limits : {};
  return {
    schemaVersion: 1,
    memory,
    history,
    limits: {
      memoryEntries: isPositiveInteger(limits.memoryEntries) ? limits.memoryEntries : DEFAULT_MEMORY_LIMIT,
      historyDays: isPositiveInteger(limits.historyDays) ? limits.historyDays : 90,
      historyKeys: isPositiveInteger(limits.historyKeys) ? limits.historyKeys : 500,
    },
  };
}

/** The cached hints after one entry was written. The entry moves to the front, and the oldest entries fall off at the cap. */
export function withRememberedEntry(hints: QuickAddHints, entry: MemoryEntry): QuickAddHints {
  const rest = hints.memory.filter((item) => item.id !== entry.id && item.noteKey !== entry.noteKey);
  return { ...hints, memory: [entry, ...rest].slice(0, hints.limits.memoryEntries) };
}

export function withoutMemoryEntry(hints: QuickAddHints, id: number): QuickAddHints {
  return { ...hints, memory: hints.memory.filter((item) => item.id !== id) };
}

export function withoutAnyMemory(hints: QuickAddHints): QuickAddHints {
  return { ...hints, memory: [] };
}

function isQuickAddDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === QUICK_ADD_DISABLED_CODE;
}

function statusFromError(operation: MemoryOperation, error: unknown): MemoryStatus {
  if (!(error instanceof ApiError)) return { status: 'failed', operation, retryable: true };
  const base = { operation, ...(error.code ? { code: error.code } : {}), httpStatus: error.status };
  if (isQuickAddDisabled(error)) return { ...base, status: 'unavailable', retryable: false };
  // The entry changed after it was read. The newer change stays in place, and resending cannot help.
  if (error.status === 409) return { ...base, status: 'conflict', retryable: false };
  const transient = error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  const dataNotice = error.status === 428 && error.code === DATA_NOTICE_REQUIRED_STATUS_CODE;
  return { ...base, status: 'failed', retryable: transient || dataNotice };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(0, REQUEST_TIMEOUT_MESSAGE, { code: REQUEST_TIMEOUT_CODE }));
    }, timeoutMs);
  });
  // An abandoned request that fails later must not become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

export function buildHintsView(args: {
  enabled: boolean;
  status: 'pending' | 'error' | 'success';
  data: QuickAddHints | undefined;
  memoryUnavailable: boolean;
}): QuickAddHintsView {
  const { enabled, status, data, memoryUnavailable } = args;
  if (!enabled) return DISABLED_VIEW;
  if (status === 'error') return { ...UNAVAILABLE_VIEW, memoryUnavailable: true };
  if (status === 'pending' || data === undefined) return { ...LOADING_VIEW, memoryUnavailable };
  return {
    state: 'ready',
    memoryUnavailable,
    memory: memoryUnavailable ? EMPTY_MEMORY : data.memory,
    history: data.history,
  };
}

const DISABLED_VIEW: QuickAddHintsView = Object.freeze({
  state: 'disabled', memoryUnavailable: false, memory: EMPTY_MEMORY, history: EMPTY_HISTORY,
});
const LOADING_VIEW: QuickAddHintsView = Object.freeze({
  state: 'loading', memoryUnavailable: false, memory: EMPTY_MEMORY, history: EMPTY_HISTORY,
});
const UNAVAILABLE_VIEW: QuickAddHintsView = Object.freeze({
  state: 'unavailable', memoryUnavailable: true, memory: EMPTY_MEMORY, history: EMPTY_HISTORY,
});

/**
 * The `memory` and `history` inputs of `suggestCategory`. Empty while the hints are loading, unavailable, or off,
 * so the suggester falls back to its remaining sources. The arrays are the cached references, so they are stable
 * between calls until the hints change.
 */
export function selectSuggestionSources(view: QuickAddHintsView): SuggestionSources {
  if (view.state !== 'ready') return EMPTY_SOURCES;
  return { memory: view.memory, history: view.history };
}

/** The Memory_Entry the "Forget this" action deletes, found by exact Note_Key. */
export function findMemoryEntry(view: QuickAddHintsView, noteKey: string): MemoryEntry | undefined {
  return view.memory.find((entry) => entry.noteKey === noteKey);
}

export function createMemoryClient(options: MemoryClientOptions = {}) {
  const cache = options.queryClient ?? queryClient;
  const isEnabled = options.isEnabled ?? (() => selectQuickAddEnabled());
  const timeoutMs = options.timeoutMs ?? MEMORY_REQUEST_TIMEOUT_MS;

  let state: MemoryClientState = { statuses: new Map(), memoryUnavailable: false };
  // Bumped on every sign-out clear. A response that arrives afterward belongs to the old account and is dropped.
  let generation = 0;
  const listeners = new Set<() => void>();
  const commands = new Map<string, Command>();
  const inFlight = new Map<string, Promise<MemoryResult>>();

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const setState = (next: MemoryClientState) => {
    state = next;
    emit();
  };
  const setStatus = (key: string, status: MemoryStatus) => {
    const statuses = new Map(state.statuses);
    statuses.set(key, status);
    setState({ ...state, statuses });
  };
  const markMemoryUnavailable = () => {
    if (!state.memoryUnavailable) setState({ ...state, memoryUnavailable: true });
  };

  const updateHints = (update: (hints: QuickAddHints) => QuickAddHints) => {
    // A missing entry returns undefined, which leaves the cache untouched. Nothing is created from a partial value.
    cache.setQueryData<QuickAddHints>(queryKeys.quickAddHints(), (current) => (
      current === undefined ? undefined : update(current)
    ));
  };

  const hintsQueryOptions = () => ({
    queryKey: queryKeys.quickAddHints(),
    queryFn: async (): Promise<QuickAddHints> => {
      if (!isEnabled()) throw new ApiError(0, 'Quick Add is off.', { code: 'QUICK_ADD_CLIENT_DISABLED' });
      const started = generation;
      try {
        return parseQuickAddHints(await api.get<unknown>(HINTS_PATH));
      } catch (error) {
        if (started === generation && isQuickAddDisabled(error)) markMemoryUnavailable();
        throw error;
      }
    },
    enabled: isEnabled(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  /** Reads the hints once. A later call returns the cached result, or the cached failure, without a request. */
  async function loadHints(): Promise<QuickAddHints | null> {
    if (!isEnabled()) return null;
    const existing = cache.getQueryState<QuickAddHints>(queryKeys.quickAddHints());
    if (existing?.status === 'error' && existing.data === undefined) throw existing.error;
    return cache.fetchQuery(hintsQueryOptions());
  }

  function readView(): QuickAddHintsView {
    const enabled = isEnabled();
    const queryState = cache.getQueryState<QuickAddHints>(queryKeys.quickAddHints());
    return buildHintsView({
      enabled,
      status: queryState === undefined ? 'pending' : queryState.status,
      data: cache.getQueryData<QuickAddHints>(queryKeys.quickAddHints()),
      memoryUnavailable: state.memoryUnavailable,
    });
  }

  async function send(command: Command): Promise<unknown> {
    const work = (() => {
      switch (command.operation) {
        case 'remember': {
          const { noteKey, category, expectedRevision } = command.input;
          return api.put<unknown>(MEMORY_PATH, {
            noteKey,
            category,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          });
        }
        case 'forget': {
          const { id, expectedRevision } = command.input;
          const query = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`;
          return api.del<unknown>(`${MEMORY_PATH}/${id}${query}`);
        }
        case 'forget_all':
          return api.del<unknown>(MEMORY_PATH);
      }
    })();
    return withTimeout(work, timeoutMs);
  }

  function applySuccess(command: Command, response: unknown): void {
    if (command.operation === 'remember') {
      const entry = isRecord(response) ? parseMemoryEntry(response.entry) : null;
      // A 200 without a readable entry still saved the choice. The cache catches up at the next page load.
      if (entry !== null) updateHints((hints) => withRememberedEntry(hints, entry));
    } else if (command.operation === 'forget') {
      updateHints((hints) => withoutMemoryEntry(hints, command.input.id));
    } else {
      updateHints(withoutAnyMemory);
    }
  }

  function run(key: string, command: Command): Promise<MemoryResult> {
    if (!isEnabled()) return Promise.resolve({ status: 'disabled', retryable: false });
    const pending = inFlight.get(key);
    if (pending) return pending;
    // A write is refused by the server for the rest of this page load, so do not ask again. Deletes stay allowed.
    if (command.operation === 'remember' && state.memoryUnavailable) {
      const status: MemoryStatus = {
        status: 'unavailable', operation: 'remember', code: QUICK_ADD_DISABLED_CODE, httpStatus: 404, retryable: false,
      };
      setStatus(key, status);
      return Promise.resolve(status);
    }

    const started = generation;
    commands.set(key, command);
    setStatus(key, { status: 'pending', operation: command.operation, retryable: false });

    const request = (async (): Promise<MemoryResult> => {
      let result: MemoryStatus;
      try {
        const response = await send(command);
        if (started === generation) applySuccess(command, response);
        result = { status: 'saved', operation: command.operation, retryable: false };
      } catch (error) {
        // Deleting what is already gone leaves the state the caller asked for.
        if (command.operation === 'forget' && error instanceof ApiError
          && error.status === 404 && error.code === MEMORY_NOT_FOUND_CODE) {
          if (started === generation) applySuccess(command, undefined);
          result = { status: 'saved', operation: command.operation, retryable: false };
        } else {
          result = statusFromError(command.operation, error);
          if (result.status === 'unavailable' && started === generation) markMemoryUnavailable();
        }
      }
      if (started !== generation) return result;
      inFlight.delete(key);
      if (result.status === 'saved') commands.delete(key);
      setStatus(key, result);
      return result;
    })();
    inFlight.set(key, request);
    return request;
  }

  const reset = () => {
    generation += 1;
    commands.clear();
    inFlight.clear();
    setState({ statuses: new Map(), memoryUnavailable: false });
  };
  const unsubscribeFromClear = subscribeToFinancialStateClear(reset);

  return {
    isEnabled,
    hintsQueryOptions,
    loadHints,
    readView,
    /** Remember a category choice for a Note_Key. Resends the same state on retry. */
    remember: (key: string, input: RememberChoiceInput) => run(key, { operation: 'remember', input: { ...input } }),
    /** Delete one Memory_Entry by id, optionally guarded by its revision. */
    forget: (key: string, input: ForgetEntryInput) => run(key, { operation: 'forget', input: { ...input } }),
    forgetAll: (key: string) => run(key, { operation: 'forget_all' }),
    /** Resend the identical command of a failed status. Sends nothing for any other state. */
    retry(key: string): Promise<MemoryResult> {
      const status = state.statuses.get(key);
      const command = commands.get(key);
      if (!status || !command || status.status !== 'failed' || !status.retryable) {
        return Promise.resolve(status ?? { status: 'disabled', retryable: false });
      }
      return run(key, command);
    },
    /** Drop the status and saved command of one entry, for example when its row is discarded. */
    discard(key: string): void {
      if (inFlight.has(key)) return;
      commands.delete(key);
      if (!state.statuses.has(key)) return;
      const statuses = new Map(state.statuses);
      statuses.delete(key);
      setState({ ...state, statuses });
    },
    getStatus: (key: string): MemoryStatus | undefined => state.statuses.get(key),
    getState: (): MemoryClientState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset,
    dispose(): void {
      unsubscribeFromClear();
      listeners.clear();
    },
    cache,
  };
}

export type MemoryClient = ReturnType<typeof createMemoryClient>;

/** The application client, bound to the shared query client. */
export const memoryClient: MemoryClient = createMemoryClient();

/**
 * The hints for Quick Add. Sends no request while Quick_Add_Enabled is off, reads the hints once per page load
 * otherwise, and reports `loading`, `ready`, `unavailable`, or `disabled`.
 */
export function useQuickAddHints(client: MemoryClient = memoryClient): QuickAddHintsView {
  const clientState = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const query = useQuery(client.hintsQueryOptions(), client.cache);
  return buildHintsView({
    enabled: client.isEnabled(),
    status: query.status,
    data: query.data,
    memoryUnavailable: clientState.memoryUnavailable,
  });
}

/** `suggestCategory` memory and history inputs for the current hints. */
export function useSuggestionSources(client: MemoryClient = memoryClient): SuggestionSources {
  const view = useQuickAddHints(client);
  // `selectSuggestionSources` allocates a pair, so keep it stable until the hints themselves change.
  return useMemo(
    () => selectSuggestionSources(view),
    [view.state, view.memory, view.history],
  );
}

/** The status of one entry's memory write or delete, or undefined when none was started. */
export function useMemoryStatus(key: string, client: MemoryClient = memoryClient): MemoryStatus | undefined {
  const clientState = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  return clientState.statuses.get(key);
}
