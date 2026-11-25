import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  ANDROID_EXCLUDED_PUBLIC_FILES,
  ANDROID_MINIFY_OPTIONS,
  buildCsp,
  isAndroidMode,
  validateAndroidApiBase,
} from './build/androidBuild';

/**
 * Production-only Content-Security-Policy (meta tag). Not applied in `vite dev`, because the dev server
 * injects an inline React-refresh script. Everything is same-origin: fonts are bundled, no CDN, no inline
 * script. connect-src is limited to this site and the exact API origin baked in via VITE_API_BASE.
 *
 * Google Identity Services (the "Sign in with Google" button) needs a handful
 * of exceptions, documented here:
 *   https://developers.google.com/identity/gsi/web/guides/display-google-one-tap#content_security_policy
 * These origins only serve official Google code; allowing them doesn't open
 * a new vector. We include them unconditionally so the dev/preview build
 * matches prod behaviour regardless of whether VITE_GOOGLE_CLIENT_ID is set.
 *
 * `--mode android` (the Capacitor Release_Web_Bundle) uses a narrower policy with no Google origins and
 * `connect-src` limited to 'self' plus the API origin. The policy builders live in ./build/androidBuild.ts.
 */
function csp(apiBase: string, isAndroid = false): Plugin {
  const policy = buildCsp(apiBase, isAndroid);
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}
/**
 * `--mode android` only: removes the web-only SEO files (ANDROID_EXCLUDED_PUBLIC_FILES) that Vite copies from
 * `public/` into the build output, so they are not packaged into the app. Other modes never apply this plugin.
 */
export function androidExcludePublicFiles(): Plugin {
  let outDir = 'dist';
  return {
    name: 'android-exclude-public-files',
    apply: (_config, { command, mode }) => command === 'build' && isAndroidMode(mode),
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const name of ANDROID_EXCLUDED_PUBLIC_FILES) fs.rmSync(path.join(outDir, name), { force: true });
    },
  };
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isAndroid = isAndroidMode(mode);
  // Android build only: fail fast, before bundling, unless VITE_API_BASE is an https:// URL.
  if (isAndroid) validateAndroidApiBase(env.VITE_API_BASE);
  // Override with API_PROXY to point the dev/preview server at a different local API.
  const target = process.env.API_PROXY || 'http://localhost:4000';
  const proxy = { '/api': { target } };
  return {
    plugins: [react(), csp(env.VITE_API_BASE || '', isAndroid), androidExcludePublicFiles()],
    // Dev and preview servers stay on loopback only.
    server: { host: '127.0.0.1', port: 5173, proxy },
    preview: { host: '127.0.0.1', port: 4173, proxy },
    build: {
      outDir: 'dist',
      sourcemap: false,
      assetsInlineLimit: 0, // keep every asset a same-origin file so the CSP can stay strict
      // Android bundle only: strip console.* and debugger from the output.
      ...(isAndroid ? { rolldownOptions: { output: { minify: ANDROID_MINIFY_OPTIONS } } } : {}),
    },
  };
});
