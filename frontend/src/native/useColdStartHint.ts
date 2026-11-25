import { useEffect, useState } from 'react';
import { COLD_START_HINT_DELAY_MS } from './networkStatus';

/**
 * True once `pending` has stayed true for `delayMs` without a break. Resets to false as soon as `pending`
 * becomes false, so a fast response never flashes the "free server is waking up" hint.
 */
export function useColdStartHint(pending: boolean, delayMs: number = COLD_START_HINT_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!pending) {
      setElapsed(false);
      return undefined;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [pending, delayMs]);
  return pending && elapsed;
}
