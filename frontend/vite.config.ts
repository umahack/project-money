import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
 */
function csp(apiBase: string): Plugin {
  let apiOrigin = '';
  try {
    if (apiBase) apiOrigin = new URL(apiBase).origin;
  } catch {
    /* ignore malformed value, falls back to same-origin only */
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://accounts.google.com/gsi/style",
    "img-src 'self' data: https://*.googleusercontent.com https://accounts.google.com",
    "font-src 'self'",
    `connect-src 'self' https://accounts.google.com/gsi/${apiOrigin ? ' ' + apiOrigin : ''}`,
    "frame-src https://accounts.google.com/gsi/",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Override with API_PROXY to point the dev/preview server at a different local API.
  const target = process.env.API_PROXY || 'http://localhost:4000';
  const proxy = { '/api': { target } };
  return {
    plugins: [react(), csp(env.VITE_API_BASE || '')],
    // Dev and preview servers stay on loopback only.
    server: { host: '127.0.0.1', port: 5173, proxy },
    preview: { host: '127.0.0.1', port: 4173, proxy },
    build: {
      outDir: 'dist',
      sourcemap: false,
      assetsInlineLimit: 0, // keep every asset a same-origin file so the CSP can stay strict
    },
  };
});
