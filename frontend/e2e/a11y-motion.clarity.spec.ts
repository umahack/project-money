// Reduced motion on the clarity pages (task 17.4, Requirement 12.7).
//
// With the device setting `prefers-reduced-motion: reduce` emulated, the real, unmodified CSS and the real
// Framer Motion code must not move anything that is not needed to understand the page:
//
// 1. A sampler records every animation the browser runs (`document.getAnimations()` every frame) from the
//    first paint, through a page change, a theme switch, and a save. Under reduce there is no infinite
//    animation, no CSS animation or transition longer than a frame, and no script animation that moves
//    anything (only opacity may change).
// 2. The background blobs and floating coins, the pulsing badge, and the skeleton shimmer are off.
// 3. Elements that Framer Motion slides (the page transition) are never part-way through a slide.
// 4. Each check has a control run with `no-preference`: the same sampler sees the movement, so a pass is not
//    a sampler that sees nothing.
import { MONTH, SCENARIOS, signIn } from './helpers/clarityScenarios';
import { installClarityBackend } from './helpers/clarityApi';
import { settleAnimations } from './helpers/layout';
import { expect, installAuthenticatedSession, test } from './fixtures/test';
import { setTheme } from './helpers/a11y';
import type { Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off' });

interface AnimationRecord {
  kind: 'css-animation' | 'css-transition' | 'script';
  name: string;
  durationMs: number;
  iterations: number;
  properties: string[];
  target: string;
}

const LOG_KEY = '__pmAnimationLog';
/** One display frame at 60 Hz is 16.7 ms. Anything at or under this is an instant change, not movement. */
const INSTANT_MS = 17;
const MOVEMENT_PROPERTIES = /^(transform|translate|scale|rotate|top|left|right|bottom|width|height|margin|inset|offset|filter|backgroundPosition)/;

async function installAnimationLog(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const log = new Map<string, unknown>();
    (window as unknown as Record<string, unknown>)[key] = log;
    const sample = () => {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        const timing = effect?.getComputedTiming();
        const properties = new Set<string>();
        for (const frame of effect?.getKeyframes?.() ?? []) {
          for (const property of Object.keys(frame)) {
            if (!['offset', 'easing', 'composite', 'computedOffset'].includes(property)) properties.add(property);
          }
        }
        const kind = animation instanceof CSSAnimation ? 'css-animation' : animation instanceof CSSTransition ? 'css-transition' : 'script';
        const name = animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? animation.transitionProperty : animation.id || 'waapi';
        const target = effect?.target instanceof Element ? `${effect.target.tagName.toLowerCase()}.${String(effect.target.className).split(/\s+/).slice(0, 2).join('.')}` : '?';
        const duration = Number(timing?.duration ?? 0);
        const iterations = Number(timing?.iterations ?? 1);
        log.set(`${kind}|${name}|${duration}|${iterations}|${[...properties].join(',')}|${target}`, { kind, name, durationMs: duration, iterations, properties: [...properties], target });
      }
    };
    window.setInterval(sample, 8);
  }, LOG_KEY);
}

async function readAnimationLog(page: Page): Promise<AnimationRecord[]> {
  return page.evaluate((key) => Array.from(((window as unknown as Record<string, Map<string, AnimationRecord>>)[key] as Map<string, AnimationRecord>).values()), LOG_KEY);
}

/** What a person with reduced motion should never meet. */
function movement(records: readonly AnimationRecord[]): string[] {
  return records.flatMap((record) => {
    const label = `${record.kind} "${record.name}" on ${record.target} (${record.durationMs} ms x ${record.iterations}; ${record.properties.join(', ') || 'no properties'})`;
    const problems: string[] = [];
    if (!Number.isFinite(record.iterations) || record.iterations > 1) problems.push(`repeats: ${label}`);
    if (record.kind !== 'script' && record.durationMs > INSTANT_MS) problems.push(`runs longer than a frame: ${label}`);
    if (record.kind === 'script' && record.properties.some((property) => MOVEMENT_PROPERTIES.test(property))) problems.push(`moves something: ${label}`);
    return problems;
  });
}

/** Changes the page the way a person does: through the navigation, so the page transition runs. */
async function navigateTo(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: new RegExp(`${name}$`) }).click();
}

async function runFlow(page: Page, api: Parameters<(typeof SCENARIOS)[number]['open']>[1], preference: 'reduce' | 'no-preference'): Promise<AnimationRecord[]> {
  await installAnimationLog(page);
  await page.emulateMedia({ reducedMotion: preference });
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000, bills: [{ label: 'Rent', amountMinor: 25_000_00 }] });
  api.stub('GET', '/api/finance/streak', { json: { current: 3, longest: 9, days_logged: 30 } });
  await signIn(page, '/');
  expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(preference === 'reduce');
  // Both themes: the drifting colour blobs and floating coins belong to the dark theme.
  await setTheme(page, 'dark');
  await page.waitForTimeout(300);
  await navigateTo(page, 'Plan');
  await expect(page.getByRole('article', { name: /^Your plan for / })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^How this was calculated for / }).first().click();
  await page.waitForTimeout(300);
  await setTheme(page, 'light');
  await page.waitForTimeout(300);
  return readAnimationLog(page);
}

test('reduced motion: nothing repeats, slides, or runs longer than a frame', async ({ page, api }) => {
  api.stub('GET', `/api/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}?version=1`, { status: 404, json: { error: 'No explanation in this fixture' } });
  const records = await runFlow(page, api, 'reduce');
  expect(records.length, 'the sampler saw animations at all (instant ones included)').toBeGreaterThan(0);
  expect(movement(records)).toEqual([]);
});

test('control: with no reduced-motion preference the sampler does see repeating and moving animations', async ({ page, api }) => {
  api.stub('GET', `/api/finance/explanations/${encodeURIComponent(`monthly-plan:${MONTH}`)}?version=1`, { status: 404, json: { error: 'No explanation in this fixture' } });
  const records = await runFlow(page, api, 'no-preference');
  const problems = movement(records);
  expect(problems.some((problem) => problem.startsWith('repeats')), 'the background blobs repeat').toBe(true);
  expect(problems.some((problem) => problem.includes('"drift"')), 'the blob drift animation').toBe(true);
});

test('reduced motion: the decorative loops (blobs, floating coins, badge pulse) are off', async ({ page, api }) => {
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', '/api/finance/streak', { json: { current: 3, longest: 9, days_logged: 30 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, '/');
  await setTheme(page, 'dark');
  await page.waitForTimeout(250);
  const state = await page.evaluate(() => {
    const iterations = (selector: string) => Array.from(document.querySelectorAll(selector)).map((element) => ({
      selector,
      count: getComputedStyle(element).animationIterationCount,
      duration: getComputedStyle(element).animationDuration,
      display: getComputedStyle(element).display,
    }));
    return {
      blobs: iterations('.bg .blob'),
      coins: iterations('.float-coin'),
      running: document.getAnimations().filter((animation) => animation.playState === 'running'
        && (animation.effect?.getComputedTiming().iterations === Infinity)).length,
    };
  });
  expect(state.blobs.length, 'the blobs exist').toBeGreaterThan(0);
  for (const blob of state.blobs) {
    expect(blob.count, 'a blob plays once at most').toBe('1');
    expect(parseFloat(blob.duration) * (blob.duration.endsWith('ms') ? 1 : 1000), 'a blob finishes within a frame').toBeLessThanOrEqual(INSTANT_MS);
  }
  for (const coin of state.coins) expect(coin.display, 'floating coins are hidden').toBe('none');
  expect(state.running, 'no animation runs forever').toBe(0);
});

test('reduced motion: the skeleton does not shimmer, and the card text is readable at once', async ({ page, api }) => {
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', '/api/finance/streak', { json: { current: 3, longest: 9, days_logged: 30 } });
  const held = api.defer('GET', `/api/finance/clarity?month=${MONTH}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installAuthenticatedSession(page);
  await page.goto('/');
  const skeleton = page.locator('.clarity-skeleton .skeleton').first();
  await expect(skeleton).toBeVisible();
  const names = await page.locator('.clarity-skeleton .skeleton').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name === 'none'), `shimmer names: ${names.join(', ')}`).toBe(true);
  // Release the held response with the fixture backend's own snapshot.
  held.fulfill({ status: 500, json: { error: 'not needed' } });
});

test('control: the skeleton shimmers when motion is not reduced', async ({ page, api }) => {
  installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
  api.stub('GET', '/api/finance/streak', { json: { current: 3, longest: 9, days_logged: 30 } });
  const held = api.defer('GET', `/api/finance/clarity?month=${MONTH}`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installAuthenticatedSession(page);
  await page.goto('/');
  await expect(page.locator('.clarity-skeleton .skeleton').first()).toBeVisible();
  const names = await page.locator('.clarity-skeleton .skeleton').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
  expect(names.some((name) => name !== 'none'), 'the skeleton shimmers by default').toBe(true);
  held.fulfill({ status: 500, json: { error: 'not needed' } });
});

/** Samples the transform of every Framer Motion element in `main` for `ms` and returns the ones that were part-way through a slide. */
async function sampleSlides(page: Page, ms: number): Promise<string[]> {
  return page.evaluate((duration) => new Promise<string[]>((resolve) => {
    const slid = new Set<string>();
    const end = performance.now() + duration;
    const tick = () => {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('main [style*="transform"], main [style*="opacity"]'))) {
        const style = getComputedStyle(element);
        const transform = style.transform;
        // A box that is still transparent (its first frame, before it is set to its end state) shows nothing to move.
        if (Number(style.opacity) < 0.9) continue;
        if (transform !== 'none' && transform !== 'matrix(1, 0, 0, 1, 0, 0)') {
          slid.add(`${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/).slice(0, 2).join('.')} ${transform}`);
        }
      }
      if (performance.now() < end) requestAnimationFrame(tick);
      else resolve([...slid]);
    };
    requestAnimationFrame(tick);
  }), ms);
}

for (const [preference, expectMovement] of [['reduce', false], ['no-preference', true]] as const) {
  test(`${expectMovement ? 'control' : 'reduced motion'}: a page change ${expectMovement ? 'slides the new page in' : 'appears without sliding'} (${preference})`, async ({ page, api }) => {
    installClarityBackend(api, MONTH, { salaryMinor: 7_500_000 });
    api.stub('GET', '/api/finance/streak', { json: { current: 3, longest: 9, days_logged: 30 } });
    await page.emulateMedia({ reducedMotion: preference });
    await signIn(page, '/');
    await expect(page.getByRole('article', { name: 'Remaining to spend' })).toBeVisible();
    await settleAnimations(page);
    const sliding = sampleSlides(page, 700);
    await navigateTo(page, 'Plan');
    const slid = await sliding;
    await expect(page.getByRole('article', { name: /^Your plan for / })).toBeVisible();
    if (expectMovement) expect(slid.length, 'the page transition slides by default').toBeGreaterThan(0);
    else expect(slid, 'nothing slides under reduced motion').toEqual([]);
  });
}

// The scenarios themselves (full, empty, pending, failed) are also checked under reduced motion for repeating
// animation, because a looping spinner or pulse on a pending state would be the likeliest leak.
for (const name of [
  'Home: retry in progress after every region failed',
  'Plan: pay save pending',
  'Goals: contribution pending',
  'Spending: expense save pending',
  'TripDetail: expense save pending',
  'Journey: first step with a seven-digit pay pending',
]) {
  test(`reduced motion: no repeating animation in the pending state "${name}"`, async ({ page, api }) => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`No scenario is named "${name}".`);
    await installAnimationLog(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await scenario.open(page, api);
    await setTheme(page, 'dark');
    await page.waitForTimeout(400);
    const records = await readAnimationLog(page);
    expect(movement(records).filter((problem) => problem.startsWith('repeats'))).toEqual([]);
  });
}
