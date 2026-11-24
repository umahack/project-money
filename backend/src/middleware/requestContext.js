import { randomUUID } from 'node:crypto';
import {
  durationBucket,
  isRoutePattern,
  operationalLogger,
  outcomeKindForStatus,
} from '../observability/operationalLog.js';
import { requestsClarityContract } from '../rollout/contractNegotiation.js';

/**
 * Fixed router mount points. The route label is `<mount><route pattern>`, so
 * it never contains a concrete path value. A request that matched no route is
 * labelled `unmatched` regardless of its path.
 */
const API_MOUNTS = Object.freeze([
  '/api/clarity/settings',
  '/api/clarity/events',
  '/api/clarity/journeys',
  '/api/admin/clarity-reports',
  '/api/internal',
  '/api/finance',
  '/api/trips',
  '/api/admin',
  '/api/feedback',
  '/api/public',
  '/api/auth',
  '/api',
]);

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const ID_PATTERN = /^[1-9]\d{0,14}$/;

// Route families that carry `:id` for a record, as full route patterns.
const RECORD_FAMILIES = Object.freeze([
  ['/api/finance/goals/:id', 'goal'],
  ['/api/finance/expenses/:id', 'expense'],
  ['/api/finance/category-memory/:id', 'category_memory'],
  ['/api/finance/emis/:id', 'bill'],
  ['/api/finance/recurring/:id', 'recurring'],
  ['/api/trips/:id', 'trip'],
  ['/api/clarity/journeys/:id', 'journey'],
]);

function pathnameOf(req) {
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : (req.url ?? '');
  const queryAt = raw.indexOf('?');
  return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/** Express route pattern for a finished request, or `unmatched`. */
export function routeLabel(req, mounts = API_MOUNTS) {
  const routePath = typeof req?.route?.path === 'string' ? req.route.path : null;
  if (routePath === null) return 'unmatched';
  const pathname = pathnameOf(req);
  const mount = mounts.find((candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`)) ?? '';
  // Routes registered directly on the app (such as the health check) already
  // carry their full path; router routes carry only the part after the mount.
  const label = routePath.startsWith('/api/')
    ? routePath
    : `${mount}${routePath === '/' ? '' : routePath}` || '/';
  return isRoutePattern(label) ? label : 'unmatched';
}

/** Record type and numeric id when the route is a known record route. */
export function recordReference(req, label) {
  if (!isRoutePattern(label) || label === 'unmatched') return {};
  if (label === '/api/finance/explanations/:outcomeId') {
    const segment = pathnameOf(req).split('/')[label.split('/').indexOf(':outcomeId')];
    const match = typeof segment === 'string' ? /^(goal|trip):([1-9]\d{0,14})$/.exec(segment) : null;
    return match ? { recordType: match[1], recordId: Number(match[2]) } : {};
  }
  const family = RECORD_FAMILIES.find(([prefix]) => label === prefix || label.startsWith(`${prefix}/`));
  if (!family) return {};
  const patternSegments = label.split('/');
  const pathSegments = pathnameOf(req).split('/');
  const index = patternSegments.indexOf(':id');
  const candidate = index === -1 ? undefined : pathSegments[index];
  if (typeof candidate !== 'string' || !ID_PATTERN.test(candidate)) return {};
  const recordId = Number(candidate);
  return Number.isSafeInteger(recordId) ? { recordType: family[1], recordId } : {};
}

function observedFamily(label, req) {
  return label.startsWith('/api/clarity/')
    || label === '/api/finance/clarity'
    || label.startsWith('/api/finance/explanations/')
    || label.startsWith('/api/finance/quick-add/')
    || label.startsWith('/api/finance/category-memory')
    || label.startsWith('/api/admin/clarity-reports')
    || label.startsWith('/api/internal/cron/clarity-reports')
    || label === '/api/auth/export'
    || (label === '/api/auth/account' && req.method === 'DELETE')
    || requestsClarityContract(req);
}

function errorCodeFrom(body) {
  const nested = body?.error;
  const candidate = nested !== null && typeof nested === 'object' ? nested.code : body?.code;
  return typeof candidate === 'string' && ERROR_CODE_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Assign a server-generated request ID, return it as `X-Request-Id`, and emit
 * one `REQUEST_COMPLETED` event per observed request. The ID is never taken
 * from the client, so a caller cannot forge log correlation.
 *
 * The event carries the route pattern, method, status, duration bucket,
 * outcome kind, the stable error code from a failure body when there is one,
 * and a record type/id for record routes. Successful reads and writes are
 * logged at `info` for the clarity route families (every route when
 * `logAllRequests` is set, as in production, except the health check); every 5xx, version
 * conflict, notice-required, and rate-limited response is logged anywhere in
 * the API at `warn` or `error`. No body, header, query string, or user text is
 * read other than the response's own error code.
 */
export function createRequestContext({ logger = operationalLogger, logAllRequests = false } = {}) {
  return function requestContext(req, res, next) {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    let errorCode;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        errorCode = errorCodeFrom(body) ?? errorCode;
      } catch {
        // Observing the body must never alter the response.
      }
      return originalJson(body);
    };

    res.once('finish', () => {
      try {
        const status = res.statusCode;
        const label = routeLabel(req);
        const outcome = outcomeKindForStatus(status, errorCode);
        const important = outcome === 'server_error'
          || outcome === 'conflict'
          || outcome === 'notice_required'
          || outcome === 'rate_limited';
        if (!important && !logAllRequests && !observedFamily(label, req)) return;
        if (label === '/api/health' && !important) return;

        const level = outcome === 'server_error'
          ? 'error'
          : (important ? 'warn' : 'info');
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logger[level]({
          event: 'REQUEST_COMPLETED',
          requestId,
          route: label,
          method: req.method,
          status,
          durationBucket: durationBucket(durationMs),
          outcome,
          code: errorCode,
          ...recordReference(req, label),
          // Pseudonymous account id, only where a failure may need follow-up.
          userId: outcome === 'server_error' ? req.user?.id : undefined,
        });
      } catch {
        // Logging must never affect the response.
      }
    });

    next();
  };
}
