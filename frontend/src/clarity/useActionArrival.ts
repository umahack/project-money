import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { prefersReducedMotion } from '../reducedMotion';
import { emptyActionContext, parseActionContext, type ActionContext, type ActionPage } from './actionContext';
import { selectFinancialClarityRollout } from './rollout';

/** How long the most specific target may take to appear before a broader target is used. */
export const ARRIVAL_FALLBACK_MS = 1500;
/** How long to wait for any target before giving up. */
export const ARRIVAL_GIVE_UP_MS = 5000;

function reveal(element: HTMLElement): void {
  // Headings and forms are not focusable by default; this lets them take programmatic focus only.
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  // Keep focus where it is when the target already contains it, such as an autofocused field.
  if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
}

/**
 * Scrolls to and focuses the first target that exists. The most specific target
 * gets `ARRIVAL_FALLBACK_MS` to appear, because records load after the page
 * renders. Any user input cancels the search so focus is never taken from the user.
 * Returns a cleanup function.
 */
export function focusActionTarget(targets: readonly string[]): () => void {
  if (targets.length === 0) return () => undefined;
  const [primary, ...rest] = targets as [string, ...string[]];
  let done = false;
  let observer: MutationObserver | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const events = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

  const stop = () => {
    done = true;
    observer?.disconnect();
    timers.forEach(clearTimeout);
    events.forEach((name) => document.removeEventListener(name, stop, true));
  };
  const find = (id: string) => document.getElementById(id);
  const attempt = (allowFallback: boolean) => {
    if (done) return;
    const element = find(primary) ?? (allowFallback ? rest.map(find).find(Boolean) ?? null : null);
    if (!element) return;
    stop();
    reveal(element);
  };

  attempt(false);
  if (done) return stop;
  events.forEach((name) => document.addEventListener(name, stop, true));
  let fallbackAllowed = false;
  observer = new MutationObserver(() => attempt(fallbackAllowed));
  observer.observe(document.body, { childList: true, subtree: true });
  timers.push(
    setTimeout(() => {
      fallbackAllowed = true;
      attempt(true);
    }, ARRIVAL_FALLBACK_MS),
    setTimeout(stop, ARRIVAL_GIVE_UP_MS),
  );
  return stop;
}

/**
 * Reads the allowlisted action context from the current location and, when the
 * rollout is on, scrolls to and focuses the matching existing form on arrival.
 * It stores nothing: the context is re-read from the URL each time.
 */
export function useActionArrival(page: ActionPage): ActionContext & { arrivalKey: string } {
  const location = useLocation();
  const enabled = selectFinancialClarityRollout().enabled;
  const context = useMemo(
    () => (enabled ? parseActionContext(page, location.search, location.hash) : emptyActionContext(page)),
    [enabled, page, location.search, location.hash],
  );
  const targetKey = context.targets.join('|');
  useEffect(() => {
    if (!enabled || !targetKey) return undefined;
    return focusActionTarget(targetKey.split('|'));
    // location.key re-runs the arrival when the same action link is used again.
  }, [enabled, targetKey, location.key]);
  return { ...context, arrivalKey: location.key };
}
