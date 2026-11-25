import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEASUREMENT_EVENT_NAMES,
  MEASUREMENT_EVENTS_PATH,
  VISIT_TRACK_PATH,
  measurement,
} from '../clarity/measurement';
import { installAgreementNetwork, renderAgreement } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';

// Example tests for Requirement 8.3 (no motion-based transition under reduced motion) and Requirement 8.6 (no new
// Product_Analytics event name). Stylesheets and sources are read from disk, because the test runner turns
// stylesheet imports into empty modules.

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Drops block and line comments, so a sentence about `measurement` is not taken for a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

afterEach(() => {
  measurement.setAnalyticsConsent(false);
  cleanup();
});

// ------------------------------ Reduced motion ------------------------------

const REDUCED_BLOCK = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;

/** The rules inside every `prefers-reduced-motion: reduce` block of `css`, as selector and declarations. */
function reducedMotionRules(css: string): Array<{ selectors: string[]; body: string }> {
  const rules: Array<{ selectors: string[]; body: string }> = [];
  for (const block of css.matchAll(REDUCED_BLOCK)) {
    for (const rule of (block[1] ?? '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      rules.push({
        selectors: (rule[1] ?? '').split(',').map((selector) => selector.trim()).filter(Boolean),
        body: rule[2] ?? '',
      });
    }
  }
  return rules;
}

/** Everything outside the reduced-motion blocks, so a transition declared there can be told from one that turns it off. */
function outsideReducedMotion(css: string): string {
  return css.replace(REDUCED_BLOCK, '');
}

function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('Agreement page and reduced motion (Requirement 8.3)', () => {
  const agreementCss = read('src/pages/agreement.css');
  const dataUseCss = read('src/components/clarity/dataUse.css');
  const clarityCss = read('src/components/clarity/clarity.css');
  const appCss = read('src/styles.css');

  it('declares no transition or animation of its own, and turns every one off under prefers-reduced-motion: reduce', () => {
    // The page's own stylesheet, and the two it imports, add no motion outside a reduced-motion block.
    for (const [name, css] of [['agreement.css', agreementCss], ['dataUse.css', dataUseCss], ['clarity.css', clarityCss]] as const) {
      expect(outsideReducedMotion(css), `${name} animates`).not.toMatch(/(^|[;\s{])(transition|animation|animation-name)\s*:/);
      expect(outsideReducedMotion(css), `${name} has keyframes`).not.toMatch(/@keyframes/);
    }

    const rules = reducedMotionRules(agreementCss);
    expect(rules.length).toBeGreaterThan(0);
    const turnsOff = rules.filter((rule) => /transition:\s*none\s*!important/.test(rule.body) && /animation:\s*none\s*!important/.test(rule.body));
    expect(turnsOff.flatMap((rule) => rule.selectors)).toEqual(expect.arrayContaining(['.agreement', '.agreement *']));
  });

  it('covers the shared button and input transitions the page inherits', () => {
    // The app stylesheet gives `.btn` and form inputs a transition. The page uses both, so the reduced-motion rule
    // has to reach them (and it does, through `.agreement *` with !important).
    expect(appCss).toMatch(/\.btn\b[^{]*\{[^}]*transition:/);
    expect(appCss).toMatch(/input, select \{[^}]*transition:/);
    expect(appCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*transition-duration: 0\.001ms !important/);
  });

  it('matches every element the page renders, expanded and with the analytics toggle, in the reduced-motion rule', async () => {
    setReducedMotion(true);
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    installAgreementNetwork({ settings: buildSettings() });
    const { container } = renderAgreement({ from: { pathname: '/spending', search: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /read full details/i }));
    await screen.findByRole('heading', { name: 'Full notice' });

    const selectors = reducedMotionRules(agreementCss)
      .filter((rule) => /transition:\s*none\s*!important/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    // The page itself. The harness's location probe and the toast region are siblings, not part of the page.
    const page = container.querySelector('main.agreement');
    expect(page).not.toBeNull();
    const elements = [page as Element, ...Array.from((page as Element).querySelectorAll('*'))];
    expect(elements.length).toBeGreaterThan(20);
    // Controls the page uses that carry a shared transition are among them.
    expect(page?.querySelector('.btn')).not.toBeNull();
    expect(page?.querySelector('input[type="checkbox"]')).not.toBeNull();
    for (const element of elements) {
      expect(selectors.some((selector) => element.matches(selector)), `<${element.tagName.toLowerCase()} class="${element.className}">`).toBe(true);
    }
  });

  it('shows and hides its details without any inline motion, and ships no motion library or smooth scrolling', async () => {
    setReducedMotion(true);
    installAgreementNetwork({ settings: buildSettings() });
    const { container } = renderAgreement({ from: { pathname: '/spending', search: '' } });
    const toggle = await screen.findByRole('button', { name: /read full details/i });
    const inlineMotion = () => Array.from(container.querySelectorAll<HTMLElement>('[style]'))
      .map((element) => element.getAttribute('style') ?? '')
      .filter((style) => /transition|animation|transform|opacity|will-change/.test(style));

    expect(inlineMotion()).toEqual([]);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    expect(inlineMotion()).toEqual([]);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(inlineMotion()).toEqual([]);

    const source = stripComments(read('src/pages/Agreement.tsx'));
    expect(source).not.toMatch(/framer-motion|motion\/react|AnimatePresence|\bmotion\./);
    expect(source).not.toMatch(/behavior:\s*['"]smooth['"]|scrollIntoView|requestAnimationFrame|setInterval/);
  });
});

// -------------------------- No new analytics event name --------------------------

const FEATURE_SOURCES = [
  'src/pages/Agreement.tsx',
  'src/clarity/AgreementGateProvider.tsx',
  'src/components/clarity/DataUseGate.tsx',
  'src/pages/Settings.tsx', // carries the paused-entries banner
] as const;

describe('Agreement page and Product_Analytics events (Requirement 8.6)', () => {
  it('keeps the event vocabulary at the five names that existed before this feature', () => {
    expect([...MEASUREMENT_EVENT_NAMES]).toEqual([
      'journey_started',
      'first_outcome_displayed',
      'clarity_response',
      'recommended_action_completed',
      'financial_change_ui',
    ]);
  });

  it.each(FEATURE_SOURCES)('%s makes no measurement or analytics-event call', (path) => {
    const text = stripComments(read(path));
    // It does not reach the measurement client at all, so it cannot send an event under any name.
    expect(text).not.toMatch(/clarity\/measurement|\bmeasurement\./);
    expect(text).not.toMatch(/MEASUREMENT_EVENT_NAMES|MEASUREMENT_EVENTS_PATH|VISIT_TRACK_PATH/);
    expect(text).not.toMatch(/journeyStarted|firstOutcomeDisplayed|clarityResponse|recommendedActionCompleted|financialChangeUi|trackVisit/);
    expect(text).not.toMatch(/buildEventPayload|createMeasurementClient|sendBeacon|\bfetch\s*\(/);
    expect(text).not.toMatch(/\/api\/clarity\/events|\/api\/track/);
    // No event payload is built here, and none of the existing names is used as a literal.
    expect(text).not.toMatch(/\bevent\s*:/);
    for (const name of MEASUREMENT_EVENT_NAMES) expect(text).not.toContain(name);
  });

  it('sends no measurement or visit request while the page is used (agree, not now, details, analytics toggle)', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: beacon });
    const FROM = { pathname: '/spending', search: '' };
    const urls: string[] = [];
    try {
      // Details and the analytics toggle. The fake server answers any PATCH with the acknowledged settings, so the
      // page leaves for the destination once the toggle is saved.
      let network = installAgreementNetwork({ settings: buildSettings({ analyticsEnabled: true }) });
      renderAgreement({ from: FROM });
      fireEvent.click(await screen.findByRole('button', { name: /read full details/i }));
      const box = await screen.findByRole('checkbox', { name: /Product Analytics/ });
      await waitFor(() => expect(box).not.toBeDisabled());
      fireEvent.click(box);
      await waitFor(() => expect(network.patches()).toHaveLength(1));
      await screen.findByTestId('landed');
      urls.push(...network.calls.map((call) => call.url));
      cleanup();

      // Agree.
      network = installAgreementNetwork({ settings: buildSettings({ analyticsEnabled: true }) });
      renderAgreement({ from: FROM });
      fireEvent.click(await screen.findByRole('button', { name: 'I agree and continue' }));
      await screen.findByTestId('landed');
      urls.push(...network.calls.map((call) => call.url));
      cleanup();

      // Not now.
      network = installAgreementNetwork({ settings: buildSettings({ analyticsEnabled: true }) });
      renderAgreement({ from: FROM });
      fireEvent.click(await screen.findByRole('button', { name: 'Not now, just look around' }));
      await screen.findByTestId('landed');
      urls.push(...network.calls.map((call) => call.url));

      expect(urls.length).toBeGreaterThan(3);
      for (const url of urls) {
        expect(url.endsWith('/api/clarity/settings'), url).toBe(true);
        expect(url).not.toContain(MEASUREMENT_EVENTS_PATH);
        expect(url).not.toContain(VISIT_TRACK_PATH);
      }
      expect(beacon).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).sendBeacon;
    }
  });
});
