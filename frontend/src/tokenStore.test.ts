import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, setToken } from './tokenStore';

describe('tokenStore edge cases', () => {
  it('returns null when sessionStorage throws on read', () => {
    setToken('abc');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(getToken()).toBeNull();
  });

  it('clearToken removes only pm_token', () => {
    sessionStorage.setItem('pm_user', '{"id":1}');
    sessionStorage.setItem('other', 'keep');
    localStorage.setItem('local', 'keep');
    setToken('abc');

    clearToken();

    expect(sessionStorage.getItem('pm_token')).toBeNull();
    expect(sessionStorage.getItem('pm_user')).toBe('{"id":1}');
    expect(sessionStorage.getItem('other')).toBe('keep');
    expect(localStorage.getItem('local')).toBe('keep');
  });
});

describe('tokenStore is the only user of pm_token', () => {
  const SRC_DIR = resolve(__dirname);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) return [];
      if (/\.test\./.test(entry.name)) return [];
      return [path];
    });
  }

  it('no non-test file under frontend/src other than tokenStore.ts mentions pm_token', () => {
    const files = sourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(join(SRC_DIR, 'tokenStore.ts'));

    const offenders = files
      .filter((file) => file !== join(SRC_DIR, 'tokenStore.ts'))
      .filter((file) => /pm_token/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
