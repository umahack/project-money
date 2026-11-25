import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Validates: Requirements 6.3, 6.4

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  setStyle: vi.fn<(options: { style: string }) => Promise<void>>(),
  pluginLoads: 0,
}));

vi.mock('../platform', () => ({ isNativePlatform: () => mocks.isNative() }));
vi.mock('@capacitor/core', () => {
  mocks.pluginLoads += 1;
  return {
    SystemBars: { setStyle: mocks.setStyle },
    SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
  };
});

/** A fresh module graph per test, so the plugin factory only runs if systemBars.ts actually imports it. */
async function loadWrapper() {
  vi.resetModules();
  return import('./systemBars');
}

beforeEach(() => {
  mocks.isNative.mockReset().mockReturnValue(false);
  mocks.setStyle.mockReset().mockResolvedValue(undefined);
  mocks.pluginLoads = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applySystemBarStyle', () => {
  it('is a no-op on the web and never imports the plugin', async () => {
    const { applySystemBarStyle } = await loadWrapper();

    await applySystemBarStyle('dark');
    await applySystemBarStyle('light');

    expect(mocks.pluginLoads).toBe(0);
    expect(mocks.setStyle).not.toHaveBeenCalled();
  });

  it('maps the dark theme to SystemBarsStyle.Dark on native', async () => {
    mocks.isNative.mockReturnValue(true);
    const { applySystemBarStyle } = await loadWrapper();

    await applySystemBarStyle('dark');

    expect(mocks.setStyle).toHaveBeenCalledTimes(1);
    expect(mocks.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
  });

  it('maps the light theme to SystemBarsStyle.Light on native', async () => {
    mocks.isNative.mockReturnValue(true);
    const { applySystemBarStyle } = await loadWrapper();

    await applySystemBarStyle('light');

    expect(mocks.setStyle).toHaveBeenCalledTimes(1);
    expect(mocks.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
  });

  it('swallows and logs a plugin rejection', async () => {
    mocks.isNative.mockReturnValue(true);
    const failure = new Error('SystemBars unavailable');
    mocks.setStyle.mockRejectedValue(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { applySystemBarStyle } = await loadWrapper();

    await expect(applySystemBarStyle('dark')).resolves.toBeUndefined();

    expect(mocks.setStyle).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain(failure);
  });

  it('swallows a failure to load the plugin module', async () => {
    mocks.isNative.mockReturnValue(true);
    mocks.setStyle.mockImplementation(() => {
      throw new Error('synchronous native failure');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { applySystemBarStyle } = await loadWrapper();

    await expect(applySystemBarStyle('light')).resolves.toBeUndefined();
  });
});

describe('system bar wiring in the source', () => {
  const SRC_DIR = resolve(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) return [];
      if (/\.test\./.test(entry.name)) return [];
      return [path];
    });
  }

  it('no non-test file other than systemBars.ts imports @capacitor/status-bar', () => {
    const wrapper = join(SRC_DIR, 'native', 'systemBars.ts');
    const files = sourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(wrapper);

    const offenders = files
      .filter((file) => file !== wrapper)
      .filter((file) => /['"`]@capacitor\/status-bar['"`]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });

  it('main.tsx sets the icon style through the wrapper and does not use the StatusBar overlay or background calls', () => {
    const main = readFileSync(join(SRC_DIR, 'main.tsx'), 'utf8');
    // Strip comments so the explanatory note about the removed calls does not count.
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).toMatch(/from '\.\/native\/systemBars'/);
    expect(code).toMatch(/applySystemBarStyle\(/);
    expect(code).not.toMatch(/setOverlaysWebView/);
    expect(code).not.toMatch(/setBackgroundColor/);
    expect(code).not.toMatch(/@capacitor\/status-bar/);
  });
});
