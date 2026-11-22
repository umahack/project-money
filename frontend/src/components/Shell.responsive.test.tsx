import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSettings, mockSettingsApi } from '../test/dataUseFixtures';
import { createTestUser, renderAuthenticated } from '../test/test-utils';
import { Shell } from './Shell';

function renderShell() {
  return renderAuthenticated(
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<h1>Home page</h1>} />
      </Route>
    </Routes>,
    { route: '/', user: createTestUser() },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--bottom-nav-h');
});

describe('Shell responsive navigation', () => {
  it('marks the main area for the clarity layout only when the rollout flag is on', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    mockSettingsApi(buildSettings({ acknowledgedVersion: 1 }));
    const { unmount } = renderShell();
    expect(await screen.findByRole('heading', { name: 'Home page' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('clarity-on');
    unmount();
    vi.unstubAllEnvs();
    mockSettingsApi(buildSettings());
    renderShell();
    expect(await screen.findByRole('heading', { name: 'Home page' })).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveClass('clarity-on');
  });

  it('renders both navigations so CSS can show exactly one at each width', async () => {
    mockSettingsApi(buildSettings());
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const bottom = screen.getByRole('navigation', { name: 'Primary mobile' });
    expect(bottom).toHaveClass('bottom-tabs', 'mobile-only');
    for (const label of ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings']) {
      expect(bottom).toHaveTextContent(label);
    }
  });

  it('publishes the bottom navigation height and clears it on unmount', async () => {
    const observed: Element[] = [];
    let notify: () => void = () => undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() { observed.length = 0; }
      unobserve() { /* not used */ }
    });
    let height = 62.2;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mock(this: HTMLElement) {
      const isBottomNav = this.classList.contains('bottom-tabs');
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 320, height: isBottomNav ? height : 10, toJSON: () => ({}) };
    });
    mockSettingsApi(buildSettings());
    const { unmount } = renderShell();
    await screen.findByRole('heading', { name: 'Home page' });
    expect(observed).toHaveLength(1);
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-h')).toBe('63px');
    // Enlarged text wraps the tabs onto a second row.
    height = 124;
    notify();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bottom-nav-h')).toBe('124px'));
    // Hidden at 900 px and above: no height, so the variable falls back to its default.
    height = 0;
    notify();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bottom-nav-h')).toBe(''));
    height = 70;
    notify();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bottom-nav-h')).toBe('70px'));
    unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-h')).toBe('');
    vi.restoreAllMocks();
  });
});
