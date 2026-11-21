import { describe, expect, it } from 'vitest';
import {
  isPublicVisitRoute,
  PRIVATE_VISIT_ROUTES,
  PUBLIC_VISIT_ROUTES,
  visitRouteForPath,
  type VisitRoute,
} from './visitRoutes';

// The backend's accepted route enum (`backend/src/routes/visits.js`).
const BACKEND_ROUTES = [
  'login', 'register', 'forgot_password', 'admin_login', 'public_trip_share', 'privacy', 'terms', 'other',
  'home', 'spending', 'plan', 'recurring', 'goals', 'trips', 'trip_detail', 'settings', 'arcade',
  'admin_overview', 'admin_users', 'admin_feedback', 'admin_traffic', 'admin_broadcast', 'admin_account',
];

describe('visit route enum', () => {
  it('matches the server enum exactly, split into public and private routes', () => {
    expect([...PUBLIC_VISIT_ROUTES, ...PRIVATE_VISIT_ROUTES].sort()).toEqual([...BACKEND_ROUTES].sort());
    expect(PUBLIC_VISIT_ROUTES.every((route) => isPublicVisitRoute(route))).toBe(true);
    expect(PRIVATE_VISIT_ROUTES.some((route) => (isPublicVisitRoute as (r: VisitRoute) => boolean)(route))).toBe(false);
  });

  it.each([
    ['/', 'home'],
    ['/login', 'login'],
    ['/register', 'register'],
    ['/forgot-password', 'forgot_password'],
    ['/admin-login', 'admin_login'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/spending', 'spending'],
    ['/plan', 'plan'],
    ['/recurring', 'recurring'],
    ['/goals', 'goals'],
    ['/trips', 'trips'],
    ['/settings', 'settings'],
    ['/arcade', 'arcade'],
    ['/admin', 'admin_overview'],
    ['/admin/users', 'admin_users'],
    ['/admin/feedback', 'admin_feedback'],
    ['/admin/traffic', 'admin_traffic'],
    ['/admin/broadcast', 'admin_broadcast'],
    ['/admin/account', 'admin_account'],
  ])('maps %s to %s', (path, route) => {
    expect(visitRouteForPath(path)).toBe(route);
  });

  it('collapses dynamic segments so ids and share tokens are never reported', () => {
    expect(visitRouteForPath('/trips/42')).toBe('trip_detail');
    expect(visitRouteForPath('/trips/abc-123')).toBe('trip_detail');
    expect(visitRouteForPath('/share/trip/9f8e7d6c5b4a')).toBe('public_trip_share');
  });

  it('follows the router: case and a trailing slash do not change the route', () => {
    expect(visitRouteForPath('/Plan')).toBe('plan');
    expect(visitRouteForPath('/plan/')).toBe('plan');
    expect(visitRouteForPath('/TRIPS/7/')).toBe('trip_detail');
    expect(visitRouteForPath('')).toBe('home');
  });

  it('maps every unknown path to other', () => {
    for (const path of ['/nope', '/trips/1/edit', '/share/trip', '/share/trip/a/b', '/admin/secret', '/plan/extra', '/api/finance']) {
      expect(visitRouteForPath(path)).toBe('other');
    }
  });

  it('only ever returns a member of the closed enum', () => {
    const allowed = new Set<string>(BACKEND_ROUTES);
    for (const path of ['/', '/x', '/trips/9', '/__proto__', '/constructor', '/share/trip/t', '//plan//', '/plan?x=1', '/plan#a']) {
      expect(allowed.has(visitRouteForPath(path))).toBe(true);
    }
  });
});
