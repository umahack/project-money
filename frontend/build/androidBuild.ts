/**
 * Pure helpers for the Android Release_Web_Bundle (`vite build --mode android`). They are kept free of any
 * Vite import so they can be unit-tested without booting Vite, and `vite.config.ts` only wires them in.
 *
 * Every helper leaves non-android builds exactly as they were before the Android release feature.
 */

/** The Vite mode name that selects the Android Release_Web_Bundle. */
export const ANDROID_MODE = 'android';

/** True only for `vite build --mode android`. */
export function isAndroidMode(mode: string): boolean {
  return mode === ANDROID_MODE;
}

/**
 * Validates the API base for the Android build: it must be present and an absolute `https://` URL.
 * A trailing slash is accepted because the app strips trailing slashes from VITE_API_BASE at runtime and the
 * CSP uses only the URL's origin.
 *
 * Returns the (unchanged) API base when valid; throws an Error naming `VITE_API_BASE` otherwise.
 */
export function validateAndroidApiBase(apiBase: string | undefined | null): string {
  const fail = (): never => {
    throw new Error(
      'VITE_API_BASE must be an https:// URL when building with --mode android ' +
        '(set it in frontend/.env.android, e.g. VITE_API_BASE=https://project-money-api.onrender.com).',
    );
  };
  if (typeof apiBase !== 'string' || !apiBase.startsWith('https://')) return fail();
  let host = '';
  try {
    host = new URL(apiBase).hostname;
  } catch {
    return fail();
  }
  if (!host) return fail();
  return apiBase;
}

/**
 * Content-Security-Policy for the built index.html.
 *
 * - Non-android (default / production): byte-for-byte the policy that shipped before the Android feature,
 *   including the Google Identity Services (GSI) exceptions needed by the web "Sign in with Google" button.
 * - Android: no `accounts.google.com` entry anywhere (the GSI script is never loaded on native), no
 *   `unsafe-eval`, and `connect-src` limited to 'self' plus the API origin.
 *
 * `style-src` keeps 'unsafe-inline' in both variants, as designed.
 */
export function buildCsp(apiBase: string, isAndroid = false): string {
  let apiOrigin = '';
  try {
    if (apiBase) apiOrigin = new URL(apiBase).origin;
  } catch {
    /* ignore malformed value, falls back to same-origin only */
  }
  if (isAndroid) {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${apiOrigin ? ' ' + apiOrigin : ''}`,
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ');
  }
  return [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    // 'unsafe-inline' is required because GSI injects inline <style> blocks
    // into the button iframe; their hashes rotate with each release, so
    // pinning hashes is brittle. No user-controlled styles reach the page.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: https://*.googleusercontent.com https://accounts.google.com",
    "font-src 'self'",
    `connect-src 'self' https://accounts.google.com/gsi/${apiOrigin ? ' ' + apiOrigin : ''}`,
    "frame-src https://accounts.google.com/gsi/",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Web-only SEO files from `public/` that must not ship inside the Android app (assets/public). The
 * `--mode android` build deletes them from the output directory after bundling; other builds keep them.
 */
export const ANDROID_EXCLUDED_PUBLIC_FILES: readonly string[] = Object.freeze(['sitemap.xml', 'robots.txt']);
/**
 * Output minifier options for the Android bundle: removes every `console.*` call and `debugger` statement
 * (Requirement 8.5). Passed as `build.rolldownOptions.output.minify` for `--mode android` only.
 */
export const ANDROID_MINIFY_OPTIONS = {
  mangle: true,
  compress: { dropConsole: true, dropDebugger: true },
} as const;
