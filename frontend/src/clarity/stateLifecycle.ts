// Framework-free notification for "all in-memory financial state must be discarded".
// queryClient.ts fires it from the auth cache clearer so pending patches, mutation
// statuses, and retry commands never outlive the account that created them.

type ClearListener = () => void;

const listeners = new Set<ClearListener>();

export function subscribeToFinancialStateClear(listener: ClearListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyFinancialStateCleared(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One failing listener must not stop the remaining state from clearing.
    }
  }
}
