// Synchronous external store around the pure clarity reducer. A store (instead of
// React state) lets a submit handler read the current pending set and register a
// new pending patch in the same tick, before any network I/O is awaited.
import {
  clarityReducer,
  initialClarityState,
  type ClarityAction,
  type ClarityState,
} from './patchReducer';

export interface ClarityStore {
  getState(): ClarityState;
  dispatch(action: ClarityAction): ClarityState;
  subscribe(listener: () => void): () => void;
  /** Increments on every reset so late responses from a cleared session can be ignored. */
  getGeneration(): number;
  reset(): void;
}

export function createClarityStore(): ClarityStore {
  let state = initialClarityState;
  let generation = 0;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  return {
    getState: () => state,
    getGeneration: () => generation,
    dispatch(action) {
      const next = clarityReducer(state, action);
      if (next !== state) {
        state = next;
        emit();
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      generation += 1;
      state = initialClarityState;
      emit();
    },
  };
}
