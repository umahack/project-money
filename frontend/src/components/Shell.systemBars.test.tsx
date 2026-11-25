import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSettings, mockSettingsApi } from '../test/dataUseFixtures';
import { createTestUser, renderAuthenticated } from '../test/test-utils';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { Shell } from './Shell';

// Validates: Requirements 6.3, 6.4

const mocks = vi.hoisted(() => ({ applySystemBarStyle: vi.fn<(theme: 'light' | 'dark') => Promise<void>>() }));

vi.mock('../native/systemBars', () => ({ applySystemBarStyle: mocks.applySystemBarStyle }));

function renderShell() {
  mockSettingsApi(buildSettings());
  return renderAuthenticated(
    <Routes>
      <Route element={<DataUseGateProvider><Shell /></DataUseGateProvider>}>
        <Route path="/" element={<h1>Home page</h1>} />
      </Route>
    </Routes>,
    { route: '/', user: createTestUser() },
  );
}

let themeColor: HTMLMetaElement;

beforeEach(() => {
  mocks.applySystemBarStyle.mockReset().mockResolvedValue(undefined);
  delete document.documentElement.dataset.theme;
  themeColor = document.createElement('meta');
  themeColor.name = 'theme-color';
  themeColor.content = '';
  document.head.appendChild(themeColor);
});

afterEach(() => {
  themeColor.remove();
  delete document.documentElement.dataset.theme;
});

describe('Shell theme and system bar style', () => {
  it('applies the stored initial theme once on mount', async () => {
    localStorage.setItem('theme', 'dark');
    renderShell();
    await screen.findByRole('heading', { name: 'Home page' });

    expect(mocks.applySystemBarStyle).toHaveBeenCalledTimes(1);
    expect(mocks.applySystemBarStyle).toHaveBeenLastCalledWith('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(themeColor.getAttribute('content')).toBe('#0b0b1a');
  });

  it('calls the wrapper with the new theme exactly once per toggle, alongside the DOM theme updates', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('heading', { name: 'Home page' });

    // Default is the light theme.
    expect(mocks.applySystemBarStyle).toHaveBeenCalledTimes(1);
    expect(mocks.applySystemBarStyle).toHaveBeenLastCalledWith('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeColor.getAttribute('content')).toBe('#faf7f2');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    await waitFor(() => expect(mocks.applySystemBarStyle).toHaveBeenCalledTimes(2));
    expect(mocks.applySystemBarStyle).toHaveBeenLastCalledWith('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(themeColor.getAttribute('content')).toBe('#0b0b1a');
    expect(localStorage.getItem('theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    await waitFor(() => expect(mocks.applySystemBarStyle).toHaveBeenCalledTimes(3));
    expect(mocks.applySystemBarStyle).toHaveBeenLastCalledWith('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeColor.getAttribute('content')).toBe('#faf7f2');

    // Let any stray effect run; the count must not grow without another toggle.
    await act(async () => {});
    expect(mocks.applySystemBarStyle.mock.calls.map(([theme]) => theme)).toEqual(['light', 'dark', 'light']);
  });
});
