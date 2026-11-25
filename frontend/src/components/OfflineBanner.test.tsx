import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTestQueryClient } from '../test/test-utils';
import { OFFLINE_NOTICE_TEXT, OfflineBanner } from './OfflineBanner';

const platform = vi.hoisted(() => ({ native: true }));
vi.mock('../platform', () => ({ isNativePlatform: () => platform.native }));

// Read from disk: the test runner turns stylesheet imports into empty modules.
const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

let onLine: Mock<() => boolean>;
let injectedStyle: HTMLStyleElement | null = null;

function setConnectivity(online: boolean): void {
  onLine.mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

function renderBanner() {
  const queryClient = createTestQueryClient();
  const refetch = vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OfflineBanner />
    </QueryClientProvider>,
  );
  return { ...view, refetch };
}

/** The declared min-width and min-height, in px, of the stylesheet rules that match `element`. */
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

beforeEach(() => {
  platform.native = true;
  onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  injectedStyle?.remove();
  injectedStyle = null;
});

describe('OfflineBanner', () => {
  it('renders nothing on the web, even while offline (Requirement 7.8)', () => {
    platform.native = false;
    onLine.mockReturnValue(false);
    const { container, refetch } = renderBanner();
    expect(container).toBeEmptyDOMElement();
    setConnectivity(false);
    setConnectivity(true);
    expect(container).toBeEmptyDOMElement();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('renders nothing on native while the device is online', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the notice as a polite status region as soon as the device goes offline (Requirements 7.1, 7.2)', () => {
    renderBanner();
    setConnectivity(false);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(OFFLINE_NOTICE_TEXT);
    expect(notice).toHaveTextContent(/offline/i);
    expect(notice).toHaveTextContent(/out of date/i);
    expect(notice).toHaveAttribute('aria-live', 'polite');
  });

  it('shows the notice on first render when the device starts offline', () => {
    onLine.mockReturnValue(false);
    renderBanner();
    expect(screen.getByRole('status')).toHaveTextContent(OFFLINE_NOTICE_TEXT);
  });

  it('refetches the active queries when Retry is activated (Requirement 7.4)', () => {
    const { refetch } = renderBanner();
    setConnectivity(false);
    expect(refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ type: 'active' });
    // The notice stays until the device is back online.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('removes the notice and refetches the active queries once when the device comes back online (Requirement 7.3)', () => {
    const { refetch } = renderBanner();
    setConnectivity(false);
    expect(refetch).not.toHaveBeenCalled();
    setConnectivity(true);
    expect(screen.queryByRole('status')).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ type: 'active' });
    // A repeated online event with no offline period in between does not refetch again.
    setConnectivity(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch for an online event when the device never went offline', () => {
    const { refetch } = renderBanner();
    setConnectivity(true);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('does not move focus when it appears or disappears', () => {
    render(<button type="button">Elsewhere</button>);
    const other = screen.getByRole('button', { name: 'Elsewhere' });
    other.focus();
    renderBanner();
    setConnectivity(false);
    expect(other).toHaveFocus();
    expect(screen.getByRole('status')).not.toContainElement(document.activeElement as HTMLElement);
    setConnectivity(true);
    expect(other).toHaveFocus();
  });

  it('gives the Retry control a hit area of at least 44 by 44 CSS pixels', () => {
    renderBanner();
    setConnectivity(false);
    const retry = screen.getByRole('button', { name: 'Retry' });
    // jsdom has no layout, so apply the banner's own stylesheet rules and read the declared minimums.
    const rules = stylesCss.match(/\.offline-banner-retry\s*\{[^}]*\}/g);
    expect(rules).not.toBeNull();
    injectedStyle = document.createElement('style');
    injectedStyle.textContent = (rules ?? []).join('\n');
    document.head.appendChild(injectedStyle);
    const { width, height } = declaredMinimums(retry);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  });
});
