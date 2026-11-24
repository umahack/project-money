import { expect, type Locator, type Page, type Response } from '@playwright/test';

const DOCUMENT_IDENTITY_KEY = '__pmPlaywrightDocumentIdentity';
const RELOAD_COUNT_KEY = '__pmPlaywrightReloadCount';
const FOCUS_HISTORY_KEY = '__pmPlaywrightFocusHistory';

export interface DocumentIdentity {
  marker: string;
}

export interface FocusRecord {
  tagName: string;
  id: string | null;
  name: string | null;
  role: string | null;
  testId: string | null;
}

export interface FocusTracker {
  active(): Promise<FocusRecord | null>;
  clear(): Promise<void>;
  history(): Promise<FocusRecord[]>;
}

export interface ReloadSpy {
  count(): Promise<number>;
  expectNoReloads(): Promise<void>;
  reset(): Promise<void>;
}

export interface LayoutIssue {
  selector: string;
  index: number;
  kind: 'horizontal-overflow' | 'clipped';
  clientWidth: number;
  scrollWidth: number;
  left: number;
  right: number;
}

export interface OverlapIssue {
  firstSelector: string;
  secondSelector: string;
  overlapWidth: number;
  overlapHeight: number;
}

export interface ResponseToPaintTiming {
  url: string;
  status: number;
  responseObservedAt: number;
  paintedAt: number;
  durationMs: number;
}

export async function captureDocumentIdentity(page: Page): Promise<DocumentIdentity> {
  const marker = `document-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.evaluate(({ key, value }) => {
    Object.defineProperty(document, key, { value, configurable: false });
  }, { key: DOCUMENT_IDENTITY_KEY, value: marker });
  return { marker };
}

export async function expectSameDocument(page: Page, identity: DocumentIdentity): Promise<void> {
  const isSame = await page.evaluate(({ key, marker }) => (
    (document as unknown as Record<string, unknown>)[key] === marker
  ), { key: DOCUMENT_IDENTITY_KEY, marker: identity.marker }).catch(() => false);
  expect(isSame, 'The page document was replaced').toBe(true);
}

/** Characterization helper for legacy flows that are expected to replace the document. */
export async function expectDocumentReplaced(page: Page, identity: DocumentIdentity): Promise<void> {
  const isSame = await page.evaluate(({ key, marker }) => (
    (document as unknown as Record<string, unknown>)[key] === marker
  ), { key: DOCUMENT_IDENTITY_KEY, marker: identity.marker }).catch(() => false);
  expect(isSame, 'The legacy flow should replace the page document').toBe(false);
}

export async function installReloadSpy(page: Page): Promise<ReloadSpy> {
  const observeNavigation = (key: string) => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const priorCount = Number(sessionStorage.getItem(key) ?? '0');
    sessionStorage.setItem(key, String(priorCount + (navigation?.type === 'reload' ? 1 : 0)));
  };

  await page.addInitScript(observeNavigation, RELOAD_COUNT_KEY);
  if (page.url() !== 'about:blank') {
    await page.evaluate((key) => sessionStorage.setItem(key, '0'), RELOAD_COUNT_KEY);
  }

  const count = async () => page.evaluate((key) => Number(sessionStorage.getItem(key) ?? '0'), RELOAD_COUNT_KEY);
  return {
    count,
    async expectNoReloads() {
      expect(await count(), 'window.location.reload() replaced the document').toBe(0);
    },
    async reset() {
      await page.evaluate((key) => sessionStorage.setItem(key, '0'), RELOAD_COUNT_KEY);
    },
  };
}

export async function installFocusTracker(page: Page): Promise<FocusTracker> {
  const install = (key: string) => {
    type FocusWindow = Window & { [FOCUS_HISTORY_KEY]: FocusRecord[] };
    const target = window as unknown as FocusWindow;
    if (Array.isArray(target[key as typeof FOCUS_HISTORY_KEY])) return;
    target[key as typeof FOCUS_HISTORY_KEY] = [];
    document.addEventListener('focusin', (event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      target[key as typeof FOCUS_HISTORY_KEY].push({
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        name: element.getAttribute('name'),
        role: element.getAttribute('role'),
        testId: element.dataset.testid ?? null,
      });
    }, true);
  };

  await page.addInitScript(install, FOCUS_HISTORY_KEY);
  await page.evaluate(install, FOCUS_HISTORY_KEY);

  const history = async () => page.evaluate((key) => {
    const records = (window as unknown as Record<string, FocusRecord[]>)[key];
    return Array.isArray(records) ? records : [];
  }, FOCUS_HISTORY_KEY);

  return {
    history,
    async active() {
      const records = await history();
      return records.at(-1) ?? null;
    },
    async clear() {
      await page.evaluate((key) => {
        (window as unknown as Record<string, FocusRecord[]>)[key] = [];
      }, FOCUS_HISTORY_KEY);
    },
  };
}

export async function emulateReducedMotion(page: Page, reduce = true): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
}

export async function expectReducedMotion(page: Page, expected = true): Promise<void> {
  const matches = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  expect(matches).toBe(expected);
}

export async function collectLayoutIssues(
  page: Page,
  selectors: string[],
  tolerancePx = 1,
): Promise<LayoutIssue[]> {
  return page.evaluate(({ requestedSelectors, tolerance }) => {
    const viewportWidth = document.documentElement.clientWidth;
    const issues: LayoutIssue[] = [];
    for (const selector of requestedSelectors) {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      elements.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        if (!visible) return;
        if (element.scrollWidth > element.clientWidth + tolerance) {
          issues.push({
            selector,
            index,
            kind: 'horizontal-overflow',
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            left: rect.left,
            right: rect.right,
          });
        }
        if (rect.left < -tolerance || rect.right > viewportWidth + tolerance) {
          issues.push({
            selector,
            index,
            kind: 'clipped',
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            left: rect.left,
            right: rect.right,
          });
        }
      });
    }
    return issues;
  }, { requestedSelectors: selectors, tolerance: tolerancePx });
}

export async function expectNoOverflowOrClipping(
  page: Page,
  selectors: string[] = ['html', 'body', 'main'],
  tolerancePx = 1,
): Promise<void> {
  const issues = await collectLayoutIssues(page, selectors, tolerancePx);
  expect(issues, 'The selected page regions must not overflow or clip horizontally').toEqual([]);
}

export async function collectOverlapIssues(
  page: Page,
  selectorPairs: ReadonlyArray<readonly [string, string]>,
  tolerancePx = 1,
): Promise<OverlapIssue[]> {
  return page.evaluate(({ pairs, tolerance }) => {
    const issues: OverlapIssue[] = [];
    for (const [firstSelector, secondSelector] of pairs) {
      const first = document.querySelector<HTMLElement>(firstSelector);
      const second = document.querySelector<HTMLElement>(secondSelector);
      if (!first || !second) continue;
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapWidth > tolerance && overlapHeight > tolerance) {
        issues.push({ firstSelector, secondSelector, overlapWidth, overlapHeight });
      }
    }
    return issues;
  }, { pairs: selectorPairs, tolerance: tolerancePx });
}

export async function expectNoOverlap(
  page: Page,
  selectorPairs: ReadonlyArray<readonly [string, string]>,
  tolerancePx = 1,
): Promise<void> {
  const issues = await collectOverlapIssues(page, selectorPairs, tolerancePx);
  expect(issues, 'The selected page regions must not overlap').toEqual([]);
}

/** Measures from browser observation of an API response through the next stable animation frame. */
export async function measureResponseToPaint(
  page: Page,
  responsePromise: Promise<Response>,
  paintedResult: Locator,
): Promise<ResponseToPaintTiming> {
  const response = await responsePromise;
  const responseObservedAt = await page.evaluate(() => performance.now());
  await paintedResult.waitFor({ state: 'visible' });
  const paintedAt = await page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
  }));
  return {
    url: response.url(),
    status: response.status(),
    responseObservedAt,
    paintedAt,
    durationMs: paintedAt - responseObservedAt,
  };
}

export async function expectResponseToPaintWithin(
  timing: ResponseToPaintTiming,
  budgetMs = 100,
): Promise<void> {
  expect(timing.durationMs, `Response-to-paint exceeded ${budgetMs} ms for ${timing.url}`).toBeLessThanOrEqual(budgetMs);
}

/**
 * Resolves once `frames` consecutive animation frames arrive no more than
 * `maxGapMs` apart, so a timing measurement starts after page load work and
 * entrance animations have stopped competing for the main thread.
 */
export async function waitForQuietFrames(
  page: Page,
  // Headless Chromium delivers frames every 17 to 33 ms, so a 50 ms limit only trips on real main-thread work.
  { frames = 12, maxGapMs = 50, timeoutMs = 10_000 }: { frames?: number; maxGapMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  await page.evaluate(({ requiredFrames, gapLimit, limit }) => new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + limit;
    let previous = performance.now();
    let quiet = 0;
    const tick = (now: number) => {
      quiet = now - previous <= gapLimit ? quiet + 1 : 0;
      previous = now;
      if (quiet >= requiredFrames) {
        resolve();
        return;
      }
      if (now > deadline) {
        reject(new Error('The page never settled into steady animation frames.'));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { requiredFrames: frames, gapLimit: maxGapMs, limit: timeoutMs });
}

const DECORATIVE_STYLE_ID = '__pmPlaywrightNeutralizedDecorativeRendering';

/**
 * Test-only stylesheet used by `neutralizeDecorativeRendering`. It switches off exactly
 * two kinds of purely decorative rendering cost, and nothing that affects layout, focus,
 * overflow, or motion preferences:
 *
 * - the animated background blobs in `Shell.tsx` (`.blob` in src/styles.css): their
 *   infinite `drift` animation and their `blur(80px)` filter, and
 * - `backdrop-filter` on every element (cards, stat tiles, the top bar, the mobile nav,
 *   toasts, and modal backdrops), which the browser has to re-blur whenever anything
 *   behind or inside the surface repaints.
 */
export const DECORATIVE_RENDERING_CSS = `
.blob { animation: none !important; filter: none !important; }
*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
`;

/**
 * Opt-in helper for specs that assert paint-time budgets (100 ms response-to-paint and
 * submit-to-paint). Do not use it in layout, focus, overflow, reduced-motion, responsive,
 * or accessibility specs: those must run against the real, unmodified CSS.
 *
 * Why it exists: the production stylesheet animates three large blurred blobs forever and
 * puts `backdrop-filter: blur(16px)` on every card. Headless Chromium rasterizes both in
 * software, so on a busy machine frames take 50 ms or more. A paint budget is then missed
 * because of frame cadence, not because of application latency, and the more cards a page
 * has (Goals has the most) the worse it gets. This helper removes only that decorative
 * cost so the budget measures what the application does between a response and the
 * pixels. It does not touch production CSS and it does not change any budget.
 *
 * It injects the stylesheet into every document the page loads from now on (so call it
 * before `page.goto`) and, if a document is already loaded, into that one as well. It is
 * safe to call more than once. The `neutralizeDecorativeRendering` fixture option in
 * fixtures/test.ts calls it for a whole spec; `decorative-rendering.clarity.spec.ts`
 * checks that it leaves layout geometry unchanged.
 */
export async function neutralizeDecorativeRendering(page: Page): Promise<void> {
  const install = ({ id, css }: { id: string; css: string }) => {
    const attach = (): boolean => {
      if (document.getElementById(id)) return true;
      const parent = document.head ?? document.documentElement;
      if (!parent) return false;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = css;
      parent.appendChild(style);
      return true;
    };
    if (attach()) return;
    // In an init script the document element may not exist yet.
    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  };
  const arg = { id: DECORATIVE_STYLE_ID, css: DECORATIVE_RENDERING_CSS };
  await page.addInitScript(install, arg);
  if (page.url() !== 'about:blank') await page.evaluate(install, arg);
}

export interface SubmitToPaintTiming {
  /** Page clock time of the first matching DOM event after the probe was armed. */
  eventAt: number;
  /** Page clock time when the feedback text first appeared in the DOM. */
  appearedAt: number;
  /** Page clock time just after the first animation frame that follows it, which is when it is on screen. */
  paintedAt: number;
  durationMs: number;
}

const SUBMIT_PROBE_KEY = '__pmPlaywrightSubmitProbe';

/**
 * Measures, entirely in the page's clock, from a DOM event (for example the form
 * `submit`) to the first paint after `feedback.text` shows up inside
 * `feedback.selector`. Nothing from the Playwright round trip is counted.
 *
 * The feedback must not be on the page when this is called.
 */
export async function measureSubmitToPaint(
  page: Page,
  action: () => Promise<void>,
  feedback: { selector: string; text: string },
  eventType: 'submit' | 'click' | 'keydown' = 'submit',
): Promise<SubmitToPaintTiming> {
  await page.evaluate(({ key, type, selector, text }) => {
    interface Probe {
      eventAt: number | null;
      appearedAt: number | null;
      paintedAt: number | null;
      done: Promise<void>;
    }
    const probe = { eventAt: null, appearedAt: null, paintedAt: null } as Probe;
    document.addEventListener(type, () => {
      if (probe.eventAt === null) probe.eventAt = performance.now();
    }, { capture: true, once: true });
    probe.done = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => check());
      const check = () => {
        if (probe.appearedAt !== null) return;
        const target = document.querySelector(selector);
        if (!target || !(target.textContent ?? '').includes(text)) return;
        probe.appearedAt = performance.now();
        observer.disconnect();
        // A task queued from inside the animation frame callback runs after that frame has painted.
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            probe.paintedAt = performance.now();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      };
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    });
    (window as unknown as Record<string, Probe>)[key] = probe;
  }, { key: SUBMIT_PROBE_KEY, type: eventType, selector: feedback.selector, text: feedback.text });
  await action();
  const timing = await page.evaluate(async (key) => {
    const probe = (window as unknown as Record<string, {
      eventAt: number | null;
      appearedAt: number | null;
      paintedAt: number | null;
      done: Promise<void>;
    }>)[key];
    if (!probe) return null;
    await probe.done;
    return { eventAt: probe.eventAt, appearedAt: probe.appearedAt, paintedAt: probe.paintedAt };
  }, SUBMIT_PROBE_KEY);
  if (!timing || timing.eventAt === null || timing.appearedAt === null || timing.paintedAt === null) {
    throw new Error(`The ${eventType} event or the feedback "${feedback.text}" was not observed.`);
  }
  return {
    eventAt: timing.eventAt,
    appearedAt: timing.appearedAt,
    paintedAt: timing.paintedAt,
    durationMs: timing.paintedAt - timing.eventAt,
  };
}

export function expectSubmitToPaintWithin(timing: SubmitToPaintTiming, budgetMs = 100): void {
  expect(timing.durationMs, `Submit-to-paint exceeded ${budgetMs} ms`).toBeLessThanOrEqual(budgetMs);
}
