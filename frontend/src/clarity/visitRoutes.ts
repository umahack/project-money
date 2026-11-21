// Fixed route keys for visit tracking. The server stores only these keys
// (`backend/src/routes/visits.js`), never a raw path, so a record id, a public
// share token, or a query string cannot reach Product Analytics.

export const PUBLIC_VISIT_ROUTES = [
  'login',
  'register',
  'forgot_password',
  'admin_login',
  'public_trip_share',
  'privacy',
  'terms',
  'other',
] as const;

export const PRIVATE_VISIT_ROUTES = [
  'home',
  'spending',
  'plan',
  'recurring',
  'goals',
  'trips',
  'trip_detail',
  'settings',
  'arcade',
  'admin_overview',
  'admin_users',
  'admin_feedback',
  'admin_traffic',
  'admin_broadcast',
  'admin_account',
] as const;

export type PublicVisitRoute = (typeof PUBLIC_VISIT_ROUTES)[number];
export type PrivateVisitRoute = (typeof PRIVATE_VISIT_ROUTES)[number];
export type VisitRoute = PublicVisitRoute | PrivateVisitRoute;

const PUBLIC_SET: ReadonlySet<string> = new Set(PUBLIC_VISIT_ROUTES);

/** Exact pathnames (lower-case, no trailing slash) that the router renders. */
const EXACT_ROUTES: Readonly<Record<string, VisitRoute>> = Object.freeze({
  '/': 'home',
  '/login': 'login',
  '/register': 'register',
  '/forgot-password': 'forgot_password',
  '/admin-login': 'admin_login',
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/spending': 'spending',
  '/plan': 'plan',
  '/recurring': 'recurring',
  '/goals': 'goals',
  '/trips': 'trips',
  '/settings': 'settings',
  '/arcade': 'arcade',
  '/admin': 'admin_overview',
  '/admin/users': 'admin_users',
  '/admin/feedback': 'admin_feedback',
  '/admin/traffic': 'admin_traffic',
  '/admin/broadcast': 'admin_broadcast',
  '/admin/account': 'admin_account',
});

export function isPublicVisitRoute(route: VisitRoute): route is PublicVisitRoute {
  return PUBLIC_SET.has(route);
}

/**
 * Maps a router pathname to its fixed route key. Matching mirrors the router
 * (case-insensitive, trailing slash ignored). Dynamic segments (`/trips/:id`,
 * `/share/trip/:token`) collapse to one key, and any other path is `other`.
 * Only a pathname is accepted, so a query string or hash is never mapped.
 */
export function visitRouteForPath(pathname: string): VisitRoute {
  const path = (typeof pathname === 'string' ? pathname : '')
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/+$/, '$1') || '/';

  const exact = Object.hasOwn(EXACT_ROUTES, path) ? EXACT_ROUTES[path] : undefined;
  if (exact) return exact;
  if (/^\/share\/trip\/[^/]+$/.test(path)) return 'public_trip_share';
  if (/^\/trips\/[^/]+$/.test(path)) return 'trip_detail';
  return 'other';
}
