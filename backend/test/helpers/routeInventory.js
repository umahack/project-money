// Shared by canonicalRoutes.integration.test.js and rolloutRollback.integration.test.js (task 17.5): the
// registered-route inventory walker and the source-tree scan. The walker is unchanged from the copy that
// lived in canonicalRoutes.integration.test.js before it was moved here.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// 'POST /api/auth/google' is Sign in with Google: a pre-authentication entry point like /login. It
// verifies the Google ID token server-side (audience = GOOGLE_CLIENT_ID), answers 503 when
// GOOGLE_CLIENT_ID is unset, is rate limited by authLimiter, and issues the normal session.
export const ANONYMOUS_ROUTE_ALLOWLIST = Object.freeze([
  'GET /api/health',
  'GET /api/public/announcement',
  'GET /api/public/trips/:token',
  'POST /api/auth/google',
  'POST /api/auth/login',
  'POST /api/auth/password-reset-finish',
  'POST /api/auth/password-reset-start',
  'POST /api/auth/register-finish',
  'POST /api/auth/register-resend',
  'POST /api/auth/register-start',
  'POST /api/track',
]);

export const CRON_ROUTE_ALLOWLIST = Object.freeze([
  'POST /api/internal/cron/clarity-reports',
  'POST /api/internal/cron/monthly-review',
]);

export function mountPathOf(layer) {
  if (layer.regexp?.fast_slash) return '';
  const match = /^\^((?:\\\/[A-Za-z0-9_-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!match) throw new Error(`Unsupported mount pattern; extend the inventory walker: ${layer.regexp.source}`);
  return match[1].replaceAll('\\/', '/');
}

export function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Walk the registered Express stack in order. A middleware layer guards every
 * route registered after it in the same router (and in nested routers).
 *
 * express-async-errors wraps every handler, so guards are identified by the
 * Layer name (the original function name) rather than by function identity.
 * The anonymous-request probe below verifies the behavior independently.
 */
export function collectRoutes(stack, prefix = '', inherited = [], routes = []) {
  const guards = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const routeGuards = [...guards, ...layer.route.stack.map((entry) => entry.name)];
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(),
          path: normalizePath(`${prefix}${layer.route.path}`),
          guards: routeGuards,
        });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, `${prefix}${mountPathOf(layer)}`, guards, routes);
    } else {
      guards.push(layer.name);
    }
  }
  return routes;
}

export const routeKey = (route) => `${route.method} ${route.path}`;

export function concretePath(path) {
  return path.replace(/:([A-Za-z]+)/g, (_match, name) => (name === 'token' ? 'a'.repeat(32) : '1'));
}

export async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files.sort();
}
