import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { clarityApi } from '../api';
import type { MutationEnvelope } from './contracts';
import { useClarityStore } from './FinancialClarityProvider';
import {
  createMutationStatusStore,
  type MutationCommand,
  type MutationStatus,
  type MutationStatusStore,
  type MutationSubmitResult,
} from './mutationStatusStore';
import { setFinancialSnapshot } from './queryClient';
import { subscribeToFinancialStateClear } from './stateLifecycle';
import { isTripMutationPath, sendTripMutation } from './tripMutation';

const MutationStatusContext = createContext<MutationStatusStore | null>(null);

/** Must be rendered inside FinancialClarityProvider and a QueryClientProvider. */
export function MutationStatusProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const clarityStore = useClarityStore();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const [store] = useState(() => createMutationStatusStore({
    clarityStore,
    send: (request) => (
      // Trip writes do not return a snapshot, so they read it after the server confirms the change.
      isTripMutationPath(request.path)
        ? sendTripMutation(request)
        : clarityApi.mutate<MutationEnvelope>(request.path, {
          method: request.method,
          body: request.body,
          idempotencyKey: request.idempotencyKey,
          timeoutMs: request.timeoutMs,
        })
    ),
    onConfirmed: (snapshot) => setFinancialSnapshot(queryClientRef.current, snapshot),
  }));

  useEffect(() => subscribeToFinancialStateClear(() => store.reset()), [store]);

  return <MutationStatusContext.Provider value={store}>{children}</MutationStatusContext.Provider>;
}

function useMutationStatusStore(): MutationStatusStore {
  const store = useContext(MutationStatusContext);
  if (!store) throw new Error('Mutation status hooks must be used inside MutationStatusProvider');
  return store;
}

/** Status of the latest change for one record scope, or undefined when idle. */
export function useMutationStatus(scopeKey: string): MutationStatus | undefined {
  const store = useMutationStatusStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getStatus(scopeKey),
    () => undefined,
  );
}

export interface MutationRunner {
  submit(command: MutationCommand): Promise<MutationSubmitResult>;
  retry(scopeKey: string): Promise<MutationSubmitResult>;
  dismiss(scopeKey: string): void;
}

export function useMutationRunner(): MutationRunner {
  const store = useMutationStatusStore();
  return store;
}
