import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Requirements 10.1-10.4: `capacitor.config.ts` is a function of `CAPACITOR_ENV`.
// Importing the module evaluates its default export from `process.cwd()` and the real environment, so it is
// imported dynamically with a stubbed `VITE_API_BASE` and `process.cwd()` pointed at an empty temp directory.
// That keeps the repo's real `.env.android*` files out of the test.
type CapacitorConfigModule = typeof import('../../capacitor.config');

let mod: CapacitorConfigModule;
let importDir: string;

const API = 'https://api.example.com';
const ENV_KEYS = ['CAPACITOR_ENV', 'VITE_API_BASE'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capacitor-config-test-'));
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  importDir = makeTempDir();
  process.env.VITE_API_BASE = API;
  delete process.env.CAPACITOR_ENV;
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(importDir);
  try {
    mod = await import('../../capacitor.config');
  } finally {
    cwd.mockRestore();
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(importDir, { recursive: true, force: true });
});

describe('resolveCapacitorEnv', () => {
  it('resolves only the exact value "debug" to debug', () => {
    expect(mod.resolveCapacitorEnv('debug')).toBe('debug');
    expect(mod.resolveCapacitorEnv('release')).toBe('release');
  });

  it('resolves unset, empty, and unknown values to release', () => {
    for (const value of [undefined, '', 'staging', 'DEBUG', 'Debug', ' debug', 'production']) {
      expect(mod.resolveCapacitorEnv(value)).toBe('release');
    }
  });
});

describe('buildCapacitorConfig, release', () => {
  const build = () => mod.buildCapacitorConfig({ CAPACITOR_ENV: 'release', VITE_API_BASE: API });

  it('locks down mixed content, WebView debugging, and native logging', () => {
    const config = build();
    expect(config.android?.allowMixedContent).toBe(false);
    expect(config.android?.webContentsDebuggingEnabled).toBe(false);
    expect(config.loggingBehavior ?? config.android?.loggingBehavior).toBe('none');
  });

  it('allows navigation to exactly the API hostname, without port or path', () => {
    expect(build().server?.allowNavigation).toEqual(['api.example.com']);
    const withPort = mod.buildCapacitorConfig({ CAPACITOR_ENV: 'release', VITE_API_BASE: 'https://api.example.com:8443/v1/' });
    expect(withPort.server?.allowNavigation).toEqual(['api.example.com']);
  });

  it('defines no server.url and no server.cleartext', () => {
    const server = build().server ?? {};
    expect(server).not.toHaveProperty('url');
    expect(server).not.toHaveProperty('cleartext');
  });

  it('is also produced by a missing or unknown CAPACITOR_ENV', () => {
    const expected = build();
    expect(mod.buildCapacitorConfig({ VITE_API_BASE: API })).toEqual(expected);
    expect(mod.buildCapacitorConfig({ CAPACITOR_ENV: 'bogus', VITE_API_BASE: API })).toEqual(expected);
    expect(mod.buildCapacitorConfig({ CAPACITOR_ENV: '', VITE_API_BASE: API })).toEqual(expected);
  });

  it('serves the bundled app over the https scheme', () => {
    expect(build().server?.androidScheme).toBe('https');
  });
});

describe('buildCapacitorConfig, debug', () => {
  const build = (apiBase?: string) => mod.buildCapacitorConfig({ CAPACITOR_ENV: 'debug', VITE_API_BASE: apiBase });

  it('enables mixed content and WebView debugging', () => {
    const config = build(API);
    expect(config.android?.allowMixedContent).toBe(true);
    expect(config.android?.webContentsDebuggingEnabled).toBe(true);
    expect(config.loggingBehavior ?? config.android?.loggingBehavior).not.toBe('none');
  });

  it('allows navigation to the API host plus 10.0.2.2 and localhost', () => {
    const nav = build(API).server?.allowNavigation;
    expect(nav).toEqual(expect.arrayContaining(['api.example.com', '10.0.2.2', 'localhost']));
    expect(mod.DEBUG_EXTRA_HOSTS).toEqual(expect.arrayContaining(['10.0.2.2', 'localhost']));
  });

  it('lists each host once when the API base is itself an emulator host', () => {
    const nav = build('http://10.0.2.2:4000').server?.allowNavigation ?? [];
    expect(nav).toHaveLength(new Set(nav).size);
    expect(nav).toEqual(expect.arrayContaining(['10.0.2.2', 'localhost']));
  });

  it('defines no server.url and no server.cleartext', () => {
    const server = build(API).server ?? {};
    expect(server).not.toHaveProperty('url');
    expect(server).not.toHaveProperty('cleartext');
  });

  it('falls back to the default API host when VITE_API_BASE is missing, empty, or unusable', () => {
    for (const value of [undefined, '', '   ', 'not a url']) {
      expect(build(value).server?.allowNavigation).toContain(mod.DEFAULT_API_HOST);
    }
    expect(mod.DEFAULT_API_HOST).toBe('project-money-api.onrender.com');
  });
});

describe('buildCapacitorConfig, release rejects a bad VITE_API_BASE', () => {
  const release = (apiBase: string | undefined) => () =>
    mod.buildCapacitorConfig({ CAPACITOR_ENV: 'release', VITE_API_BASE: apiBase });

  it('throws a message naming VITE_API_BASE when it is missing or empty', () => {
    for (const value of [undefined, '', '   ']) {
      expect(release(value)).toThrow(/VITE_API_BASE/);
    }
  });

  it('throws a message naming VITE_API_BASE for an http:// value', () => {
    expect(release('http://api.example.com')).toThrow(/VITE_API_BASE/);
    expect(release('HTTP://api.example.com')).toThrow(/VITE_API_BASE/);
  });

  it('throws a message naming VITE_API_BASE for a value that is not a URL', () => {
    for (const value of ['not a url', 'api.example.com', 'ftp://api.example.com', 'https://']) {
      expect(release(value)).toThrow(/VITE_API_BASE/);
    }
  });

  it('applies the same rule when CAPACITOR_ENV is unset', () => {
    expect(() => mod.buildCapacitorConfig({ VITE_API_BASE: 'http://api.example.com' })).toThrow(/VITE_API_BASE/);
    expect(() => mod.buildCapacitorConfig({})).toThrow(/VITE_API_BASE/);
  });
});

describe('deriveApiHost', () => {
  it('returns the lowercase hostname only', () => {
    expect(mod.deriveApiHost('https://API.Example.com:8443/v1?x=1', 'release')).toBe('api.example.com');
  });

  it('accepts http only for debug', () => {
    expect(mod.deriveApiHost('http://10.0.2.2:4000', 'debug')).toBe('10.0.2.2');
    expect(() => mod.deriveApiHost('http://10.0.2.2:4000', 'release')).toThrow(/VITE_API_BASE/);
  });
});

describe('default export', () => {
  it('is the release configuration for the environment the module was loaded in', () => {
    expect(mod.default).toEqual(mod.buildCapacitorConfig({ CAPACITOR_ENV: 'release', VITE_API_BASE: API }));
    expect(mod.default.appId).toBe('online.projectmoney.app');
    expect(mod.default.webDir).toBe('dist');
  });
});

describe('parseDotenv', () => {
  it('parses plain KEY=VALUE and export-prefixed lines', () => {
    expect(mod.parseDotenv('A=1\nexport B=two\n  export   C = three  ')).toEqual({ A: '1', B: 'two', C: 'three' });
  });

  it('strips double and single quotes', () => {
    expect(mod.parseDotenv('A="https://a.example.com"\nB=\'b value\'')).toEqual({
      A: 'https://a.example.com',
      B: 'b value',
    });
  });

  it('ignores a trailing comment after a quoted value', () => {
    expect(mod.parseDotenv('VITE_API_BASE="https://api.example.com" # x')).toEqual({
      VITE_API_BASE: 'https://api.example.com',
    });
  });

  it('ignores a trailing comment after an unquoted value', () => {
    expect(mod.parseDotenv('VITE_API_BASE=https://api.example.com # x')).toEqual({
      VITE_API_BASE: 'https://api.example.com',
    });
  });

  it('skips blank lines and comment lines', () => {
    expect(mod.parseDotenv('\n# comment\n   \n  # indented comment\nA=1\n\n')).toEqual({ A: '1' });
  });

  it('handles CRLF line endings and empty values', () => {
    expect(mod.parseDotenv('A=1\r\nB=\r\n')).toEqual({ A: '1', B: '' });
  });

  it('ignores lines that are not assignments', () => {
    expect(mod.parseDotenv('just text\n=novalue\n1BAD=x')).toEqual({});
  });

  it('keeps a # that is not preceded by whitespace', () => {
    expect(mod.parseDotenv('A=https://a.example.com/#frag')).toEqual({ A: 'https://a.example.com/#frag' });
  });
});

describe('loadBuildEnv precedence', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    delete process.env.VITE_API_BASE;
    delete process.env.CAPACITOR_ENV;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

  it('returns undefined values when nothing is set', () => {
    expect(mod.loadBuildEnv(dir)).toEqual({ CAPACITOR_ENV: undefined, VITE_API_BASE: undefined });
  });

  it('reads .env.android when it is the only source', () => {
    write('.env.android', 'VITE_API_BASE=https://file.example.com\n');
    expect(mod.loadBuildEnv(dir).VITE_API_BASE).toBe('https://file.example.com');
  });

  it('prefers .env.android.local over .env.android', () => {
    write('.env.android', 'VITE_API_BASE=https://file.example.com\n');
    write('.env.android.local', 'VITE_API_BASE=https://local.example.com\n');
    expect(mod.loadBuildEnv(dir).VITE_API_BASE).toBe('https://local.example.com');
  });

  it('prefers the process environment over both files', () => {
    write('.env.android', 'VITE_API_BASE=https://file.example.com\n');
    write('.env.android.local', 'VITE_API_BASE=https://local.example.com\n');
    process.env.VITE_API_BASE = 'https://process.example.com';
    expect(mod.loadBuildEnv(dir).VITE_API_BASE).toBe('https://process.example.com');
  });

  it('falls back to the files when the process variable is empty', () => {
    write('.env.android', 'VITE_API_BASE=https://file.example.com\n');
    process.env.VITE_API_BASE = '';
    expect(mod.loadBuildEnv(dir).VITE_API_BASE).toBe('https://file.example.com');
  });

  it('takes CAPACITOR_ENV from the process environment only', () => {
    write('.env.android', 'CAPACITOR_ENV=debug\n');
    expect(mod.loadBuildEnv(dir).CAPACITOR_ENV).toBeUndefined();
    process.env.CAPACITOR_ENV = 'debug';
    expect(mod.loadBuildEnv(dir).CAPACITOR_ENV).toBe('debug');
  });

  it('feeds a file-provided API base into a release config', () => {
    write('.env.android', 'VITE_API_BASE="https://file.example.com" # production\n');
    expect(mod.buildCapacitorConfig(mod.loadBuildEnv(dir)).server?.allowNavigation).toEqual(['file.example.com']);
  });
});
