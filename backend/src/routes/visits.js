import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import db from '../db/index.js';
import measurementRepository from '../repositories/measurementRepository.js';

/**
 * Visits are stored as fixed route keys, never as raw paths. Signed-in routes
 * are stored only for consenting authenticated users. Anonymous visitors can
 * only record the public routes.
 */
export const PUBLIC_VISIT_ROUTES = Object.freeze([
  'login',
  'register',
  'forgot_password',
  'admin_login',
  'public_trip_share',
  'privacy',
  'terms',
  'other',
]);
export const PRIVATE_VISIT_ROUTES = Object.freeze([
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
]);

const PUBLIC_ROUTE_SET = new Set(PUBLIC_VISIT_ROUTES);
const VISIT_ROUTE_SET = new Set([...PUBLIC_VISIT_ROUTES, ...PRIVATE_VISIT_ROUTES]);

// Exact, already-normalized paths sent by the existing client. Anything not
// listed becomes 'other'; the submitted text is never stored.
const LEGACY_PATH_ROUTES = new Map([
  ['/', 'home'],
  ['/login', 'login'],
  ['/register', 'register'],
  ['/forgot-password', 'forgot_password'],
  ['/admin-login', 'admin_login'],
  ['/share/trip/*', 'public_trip_share'],
  ['/privacy', 'privacy'],
  ['/terms', 'terms'],
  ['/spending', 'spending'],
  ['/plan', 'plan'],
  ['/recurring', 'recurring'],
  ['/goals', 'goals'],
  ['/trips', 'trips'],
  ['/trips/:id', 'trip_detail'],
  ['/settings', 'settings'],
  ['/arcade', 'arcade'],
  ['/admin', 'admin_overview'],
  ['/admin/users', 'admin_users'],
  ['/admin/feedback', 'admin_feedback'],
  ['/admin/traffic', 'admin_traffic'],
  ['/admin/broadcast', 'admin_broadcast'],
  ['/admin/account', 'admin_account'],
]);

/**
 * Hash the IP + a daily salt. The hash rotates every day so we can count unique
 * visitors per day without storing raw IPs or persisting a long-term identifier.
 */
function dailyIpHash(ip) {
  const salt = (process.env.JWT_SECRET || 'pm-fallback-salt').slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${day}:${salt}:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Attempt to recover the signed-in user id from the auth header without
 * requiring auth. Also verifies the session hasn't been revoked (e.g., by
 * the 3-device cap) and that token_version is current — otherwise visits
 * get attributed to accounts whose device no longer has access.
 */
async function optionalUserId(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const sub = Number(payload.sub);
  if (!sub || !payload.sid) return null;
  try {
    const row = await db
      .prepare(
        `SELECT u.token_version AS tv, s.revoked_at
           FROM users u JOIN sessions s ON s.user_id = u.id
          WHERE u.id = ? AND s.id = ?`
      )
      .get(sub, Number(payload.sid));
    if (!row) return null;
    if (row.revoked_at) return null;
    if (Number(payload.tv ?? 1) !== Number(row.tv)) return null;
    return sub;
  } catch {
    return null;
  }
}

/**
 * Accept exactly one of `route` (a fixed route key) or the legacy `path`
 * string. Returns the fixed route key, or null when the body is not accepted.
 */
function parseVisitRoute(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;

  if (keys[0] === 'route') {
    return typeof body.route === 'string' && VISIT_ROUTE_SET.has(body.route) ? body.route : null;
  }
  if (keys[0] === 'path') {
    if (typeof body.path !== 'string' || body.path.length < 1 || body.path.length > 200) return null;
    return LEGACY_PATH_ROUTES.get(body.path) ?? 'other';
  }
  return null;
}

export function createVisitsRouter({
  repository = measurementRepository,
  resolveUserId = optionalUserId,
} = {}) {
  const router = Router();

  const trackLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/track', trackLimiter, async (req, res) => {
    const route = parseVisitRoute(req.body);
    if (!route) return res.status(400).json({ error: 'Bad route' });

    // Cap UA length to keep rows small; never store `null` as the string literal.
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 240) || null;
    const ipHash = dailyIpHash(req.ip || req.socket?.remoteAddress || '');
    const userId = await resolveUserId(req);

    if (userId) {
      // Consent is checked by the insert itself, so an opt-out wins over this request.
      await repository.recordConsentedVisit({ userId, route, ipHash, userAgent });
    } else if (PUBLIC_ROUTE_SET.has(route)) {
      await repository.recordAnonymousVisit({ route, ipHash, userAgent });
    }
    // Signed-in routes without a valid signed-in session are dropped.
    return res.status(204).end();
  });

  return router;
}

export default createVisitsRouter();
