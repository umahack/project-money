import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CapacitorConfig } from '@capacitor/cli';
/**
 * Capacitor wrapper config, a function of `CAPACITOR_ENV` (`release` | `debug`).
 * The React build in `dist/` is copied into the native project by
 * `npx cap sync android`. Use the npm scripts, which set the environment:
 *   npm run android:sync        # release: `vite build --mode android` + CAPACITOR_ENV=release
 *   npm run android:sync:debug  # debug:   `vite build`                + CAPACITOR_ENV=debug
 *
 * `release` (also the result of a missing or unknown `CAPACITOR_ENV`) is locked down: no mixed content,
 * no WebView debugging, no native logging, no `server.url`/`server.cleartext`, and navigation allowed only
 * to the API host taken from `VITE_API_BASE`. `debug` stays convenient for the emulator.
 *
 * `appId` is the Google Play package name, permanent after first publish.
 *
 * This file is loaded by the Capacitor CLI outside Vite, so it imports no other local module. It only uses
 * Node built-ins, and `process.cwd()` (not `__dirname`) so it loads as CommonJS or as native ESM.
 */
export type CapacitorEnv = 'release' | 'debug';
/** The environment values the builder reads. */
export interface CapacitorBuildEnv {
  CAPACITOR_ENV?: string | undefined;
  VITE_API_BASE?: string | undefined;
}
/** Production API host, used when a debug build has no `VITE_API_BASE`. */
export const DEFAULT_API_HOST = 'project-money-api.onrender.com';
/** Emulator alias for the host machine's loopback, plus plain localhost. Debug builds only. */
export const DEBUG_EXTRA_HOSTS: readonly string[] = ['10.0.2.2', 'localhost'];
/** A missing or unknown value is `release`. */
export function resolveCapacitorEnv(value: string | undefined): CapacitorEnv {
  return value === 'debug' ? 'debug' : 'release';
}
/**
 * Hostname of the API from `VITE_API_BASE`. Release requires an `https://` URL and throws a message
 * naming the variable otherwise. Debug accepts `http`/`https` and falls back to the production host
 * when the value is missing or unusable.
 */
export function deriveApiHost(apiBase: string | undefined, envName: CapacitorEnv): string {
  const raw = (apiBase ?? '').trim();
  if (envName === 'release') {
    if (!raw) {
      throw new Error(
        'VITE_API_BASE is required for a release Capacitor build (CAPACITOR_ENV=release) and was not found in the ' +
          'environment, frontend/.env.android.local or frontend/.env.android. Set it to the https:// API origin, e.g. ' +
          'https://project-money-api.onrender.com (see frontend/.env.android.example).',
      );
    }
    if (!/^https:\/\//i.test(raw)) {
      throw new Error(`VITE_API_BASE must be an https:// URL for a release Capacitor build, got "${raw}".`);
    }
  }
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || (envName === 'debug' && url.protocol === 'http:')) && url.hostname) {
      return url.hostname;
    }
  } catch {
    // fall through
  }
  if (envName === 'release') {
    throw new Error(`VITE_API_BASE must be a valid https:// URL for a release Capacitor build, got "${raw}".`);
  }
  return DEFAULT_API_HOST;
}
/** Minimal dotenv parser: `KEY=value`, optional `export `, `#` comments, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2] ?? '';
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    out[m[1] as string] = quoted ? (quoted[2] ?? '') : raw.replace(/\s+#.*$/, '');
  }
  return out;
}
/**
 * Build-time values: real environment first, then `.env.android.local`, then `.env.android` (the same
 * precedence Vite uses for `--mode android`). Files are read from `dir`, default the current directory.
 */
export function loadBuildEnv(dir: string = process.cwd()): CapacitorBuildEnv {
  const fromFiles: Record<string, string> = {};
  for (const name of ['.env.android', '.env.android.local']) {
    const file = resolve(dir, name);
    if (existsSync(file)) Object.assign(fromFiles, parseDotenv(readFileSync(file, 'utf8')));
  }
  return {
    CAPACITOR_ENV: process.env.CAPACITOR_ENV,
    VITE_API_BASE: process.env.VITE_API_BASE || fromFiles.VITE_API_BASE,
  };
}
/** Pure builder; all branching on `CAPACITOR_ENV` lives here. */
export function buildCapacitorConfig(env: CapacitorBuildEnv): CapacitorConfig {
  const envName = resolveCapacitorEnv(env.CAPACITOR_ENV);
  const isDebug = envName === 'debug';
  const apiHost = deriveApiHost(env.VITE_API_BASE, envName);
  const allowNavigation = isDebug ? Array.from(new Set([apiHost, ...DEBUG_EXTRA_HOSTS])) : [apiHost];
  return {
    appId: 'online.projectmoney.app',
    appName: 'Project Money',
    webDir: 'dist',
    // No `server.url` and no `server.cleartext` in either branch: the app always loads its bundled `dist`.
    // To test against the Vite dev server, add them locally and never commit them.
    server: {
      androidScheme: 'https',
      allowNavigation,
    },
    android: {
      allowMixedContent: isDebug,
      webContentsDebuggingEnabled: isDebug,
      loggingBehavior: isDebug ? 'debug' : 'none',
    },
    plugins: {
      SplashScreen: {
        launchShowDuration: 500,
        backgroundColor: '#faf7f2',
        showSpinner: false,
      },
      // Capacitor 8 default made explicit: native insets plus injected --safe-area-inset-* CSS variables.
      SystemBars: { insetsHandling: 'css' },
    },
  };
}
const config: CapacitorConfig = buildCapacitorConfig(loadBuildEnv());
export default config;
