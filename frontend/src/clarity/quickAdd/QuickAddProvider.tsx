import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { subscribeToFinancialStateClear } from '../stateLifecycle';
import type { EntryAnswerModel } from './answer';
import {
  createQuickAddStore,
  initialQuickAddState,
  isSubmissionBlocked,
  selectCurrentAnswer,
  selectEntry,
  submissionBlockedReason,
  type QuickAddEntry,
  type QuickAddState,
  type QuickAddStore,
} from './quickAddStore';

const QuickAddContext = createContext<QuickAddStore | null>(null);

export interface QuickAddProviderProps {
  children: ReactNode;
  /** A store made by the caller, for example with a fake clock in a test. Read once, on the first render. */
  store?: QuickAddStore;
}

/**
 * Holds the Quick Add store in memory for the signed-in session and renders no UI.
 * Must be rendered inside FinancialClarityProvider and MutationStatusProvider, so the actions of
 * `useQuickAddActions` can use the mutation runner. The store is reset when the financial state clears,
 * which `clearAuth()` triggers on sign-out (Requirement 7.19).
 */
export function QuickAddProvider({ children, store: provided }: QuickAddProviderProps) {
  const providedRef = useRef(provided);
  const [store] = useState(() => providedRef.current ?? createQuickAddStore());

  useEffect(() => {
    store.setTimersEnabled(true);
    const unsubscribe = subscribeToFinancialStateClear(() => store.reset());
    return () => {
      unsubscribe();
      // Timers stop with the provider and restart when it mounts again (React StrictMode runs both).
      store.setTimersEnabled(false);
    };
  }, [store]);

  return <QuickAddContext.Provider value={store}>{children}</QuickAddContext.Provider>;
}

export function useQuickAddStore(): QuickAddStore {
  const store = useContext(QuickAddContext);
  if (!store) throw new Error('Quick Add hooks must be used inside QuickAddProvider');
  return store;
}

/**
 * Subscribes to a value derived from the Quick Add state. The selector must return a stable value for an
 * unchanged state (a primitive or a reference held by the state), never a new array or object.
 */
export function useQuickAddSelector<T>(selector: (state: QuickAddState) => T): T {
  const store = useQuickAddStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(initialQuickAddState),
  );
}

export function useQuickAddState(): QuickAddState {
  return useQuickAddSelector(identity);
}

function identity(state: QuickAddState): QuickAddState {
  return state;
}

/** The draft line, shared by the Home input and the dialog. */
export function useQuickAddLine(): readonly [string, (line: string) => void] {
  const store = useQuickAddStore();
  const line = useQuickAddSelector(selectLine);
  const [setLine] = useState(() => (next: string) => {
    store.dispatch({ type: 'line/set', line: next });
  });
  return [line, setLine] as const;
}

function selectLine(state: QuickAddState): string {
  return state.line;
}

export function useQuickAddEntries(): readonly QuickAddEntry[] {
  return useQuickAddSelector(selectEntries);
}

function selectEntries(state: QuickAddState): readonly QuickAddEntry[] {
  return state.entries;
}

export function useQuickAddEntry(cid: string): QuickAddEntry | undefined {
  return useQuickAddSelector((state) => selectEntry(state, cid));
}

/** The answer of the entry with the newest confirmed snapshot, or undefined before any entry is confirmed. */
export function useCurrentAnswer(): EntryAnswerModel | undefined {
  return useQuickAddSelector(selectCurrentAnswer);
}

/** True while five entries are pending. */
export function useSubmissionBlocked(): boolean {
  return useQuickAddSelector(isSubmissionBlocked);
}

/** The text that says why submission is disabled, or null. */
export function useSubmissionBlockedReason(): string | null {
  return useQuickAddSelector(submissionBlockedReason);
}
