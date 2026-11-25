import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigEnv, Plugin, ResolvedConfig, UserConfig } from 'vite';
import { ANDROID_EXCLUDED_PUBLIC_FILES } from '../../build/androidBuild';
import { androidExcludePublicFiles } from '../../vite.config';

// The web-only SEO files are removed from the `--mode android` output only (build-less: hooks called directly).

type AnyHook = ((...args: unknown[]) => unknown) | { handler: (...args: unknown[]) => unknown };
function callHook(hook: unknown, ...args: unknown[]): unknown {
  const h = hook as AnyHook;
  return typeof h === 'function' ? h.call({}, ...args) : h.handler.call({}, ...args);
}
function isApplied(plugin: Plugin, env: ConfigEnv): boolean {
  const apply = plugin.apply;
  if (typeof apply !== 'function') throw new Error('expected a function-valued apply');
  return apply({} as UserConfig, env);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('ANDROID_EXCLUDED_PUBLIC_FILES', () => {
  it('lists exactly the web-only SEO files', () => {
    expect([...ANDROID_EXCLUDED_PUBLIC_FILES]).toEqual(['sitemap.xml', 'robots.txt']);
  });
});

describe('androidExcludePublicFiles plugin', () => {
  it('applies only to builds in android mode', () => {
    const plugin = androidExcludePublicFiles();
    expect(isApplied(plugin, { command: 'build', mode: 'android' })).toBe(true);
    expect(isApplied(plugin, { command: 'build', mode: 'production' })).toBe(false);
    expect(isApplied(plugin, { command: 'serve', mode: 'development' })).toBe(false);
  });

  it('deletes the excluded files from the resolved outDir in closeBundle and keeps the rest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-exclusions-test-'));
    tempDirs.push(root);
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    for (const name of [...ANDROID_EXCLUDED_PUBLIC_FILES, 'index.html', 'manifest.webmanifest', 'assets/robots.txt']) {
      fs.writeFileSync(path.join(outDir, name), 'x');
    }
    const plugin = androidExcludePublicFiles();
    callHook(plugin.configResolved, { root, build: { outDir: 'out' } } as unknown as ResolvedConfig);
    callHook(plugin.closeBundle);
    for (const name of ANDROID_EXCLUDED_PUBLIC_FILES) expect(fs.existsSync(path.join(outDir, name))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(['assets', 'index.html', 'manifest.webmanifest']);
    expect(fs.existsSync(path.join(outDir, 'assets/robots.txt'))).toBe(true);
    // Already-absent files are not an error.
    expect(() => callHook(plugin.closeBundle)).not.toThrow();
  });
});
