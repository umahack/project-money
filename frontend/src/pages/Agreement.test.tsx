import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installAgreementNetwork, renderAgreement } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';

// Read from disk: the test runner turns stylesheet imports into empty modules, `?raw` included.
const agreementCss = readFileSync(resolve(process.cwd(), 'src/pages/agreement.css'), 'utf8');

const AGREE = { name: 'I agree and continue' };

/** The page's own live region. The toast container is also a status region, so the role alone is ambiguous. */
function pageStatus(): HTMLElement {
  const region = document.querySelector<HTMLElement>('p.agreement-status');
  if (!region) throw new Error('The Agreement page status region is missing');
  return region;
}

/** Declared min-width and min-height, in px, from the stylesheet rules that match `element`. */
function declaredMinimums(element: Element): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!rule.selectorText.split(',').some((selector) => element.matches(selector.trim()))) continue;
      width = Math.max(width, parseFloat(rule.style.getPropertyValue('min-width')) || 0);
      height = Math.max(height, parseFloat(rule.style.getPropertyValue('min-height')) || 0);
    }
  }
  return { width, height };
}

let injectedStyle: HTMLStyleElement | null = null;
afterEach(() => {
  injectedStyle?.remove();
  injectedStyle = null;
});

describe('Agreement page', () => {
  it('moves focus to the heading on mount (Requirement 1.6)', async () => {
    installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: { pathname: '/spending', search: '' } });
    const heading = await screen.findByRole('heading', { level: 1, name: /review how project money uses your data/i });
    expect(heading).toHaveFocus();
    // Still on the heading once the notice has loaded.
    await screen.findByRole('button', AGREE);
    expect(heading).toHaveFocus();
  });

  it('shows a polite checking message while settings load (Requirement 7.3)', async () => {
    installAgreementNetwork({ settings: buildSettings(), get: 'pending' });
    renderAgreement({ from: { pathname: '/spending', search: '' } });
    await screen.findByRole('heading', { level: 1 });
    const status = pageStatus();
    await waitFor(() => expect(status).toHaveTextContent('Checking your data-use settings'));
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', AGREE)).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/agreement');
  });

  it('shows a retry control on error and does not navigate away (Requirement 7.4)', async () => {
    const network = installAgreementNetwork({ settings: buildSettings(), get: 'error' });
    renderAgreement({ from: { pathname: '/spending', search: '' } });
    const alert = await screen.findByRole('alert');
    const retry = within(alert).getByRole('button', { name: 'Retry loading settings' });
    expect(screen.getByTestId('location').textContent).toBe('/agreement');
    expect(screen.queryByTestId('landed')).toBeNull();

    const before = network.gets();
    fireEvent.click(retry);
    await waitFor(() => expect(network.gets()).toBeGreaterThan(before));
    await screen.findByRole('alert');
    expect(screen.getByTestId('location').textContent).toBe('/agreement');
  });

  it('gives the primary control a hit area of at least 44 by 44 CSS pixels (Requirement 2.5)', async () => {
    installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: { pathname: '/spending', search: '' } });
    const primary = await screen.findByRole('button', AGREE);

    // jsdom has no layout, so apply the page stylesheet and read the computed minimums from it.
    injectedStyle = document.createElement('style');
    injectedStyle.textContent = agreementCss.replace(/@import[^;]*;/g, '');
    document.head.appendChild(injectedStyle);
    const { width, height } = declaredMinimums(primary);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  });

  it('marks the primary control aria-disabled and announces progress while acknowledging (Requirement 2.3)', async () => {
    const network = installAgreementNetwork({ settings: buildSettings(), patch: 'hold' });
    renderAgreement({ from: { pathname: '/spending', search: '?month=2026-01' } });
    const primary = await screen.findByRole('button', AGREE);
    expect(primary).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(primary);

    await waitFor(() => expect(primary).toHaveAttribute('aria-disabled', 'true'));
    // aria-disabled by design: the control stays focusable, so it is not natively disabled.
    expect(primary).not.toBeDisabled();
    expect(primary).toHaveTextContent('Saving…');
    expect(pageStatus()).toHaveTextContent('Saving your acknowledgement');

    // A second activation while the first is in flight sends nothing more.
    fireEvent.click(primary);
    expect(network.patches()).toHaveLength(1);
    expect(screen.getByTestId('location').textContent).toBe('/agreement');

    await act(async () => { network.release(); });
    await screen.findByTestId('landed');
    expect(screen.getByTestId('location').textContent).toBe('/spending?month=2026-01');
  });
});
