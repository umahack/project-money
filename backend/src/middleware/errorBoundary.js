import {
  operationalLogger,
  safeErrorCode,
  safeErrorName,
} from '../observability/operationalLog.js';
import { routeLabel } from './requestContext.js';
import { requestsClarityContract } from '../rollout/contractNegotiation.js';

/**
 * Fixed, user-safe text for each unexpected-failure code. Nothing from the
 * thrown error (message, stack, SQL, record data) is ever copied into a
 * response.
 */
export const UNEXPECTED_ERROR_ENVELOPES = Object.freeze({
  INTERNAL_ERROR: 'Something went wrong on our side. Your confirmed records were not changed. Try again.',
  MUTATION_FAILED: 'The change could not be saved. Your confirmed records were not changed. Try again.',
});

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CLARITY_PATH_PREFIXES = Object.freeze([
  '/api/clarity/',
  '/api/finance/explanations/',
  '/api/admin/clarity-reports',
  '/api/internal/cron/clarity-reports',
]);

function pathnameOf(req) {
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : (req.url ?? '');
  const queryAt = raw.indexOf('?');
  return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/**
 * New-contract requests get the structured envelope. These are the routers
 * added for the clarity experience and any request that negotiated contract
 * version 1 with `X-Clarity-Contract`. Every other request keeps the legacy
 * `{ error: 'Server error' }` body so existing clients are unchanged.
 */
export function usesClarityErrorEnvelope(req) {
  const pathname = pathnameOf(req);
  return pathname === '/api/finance/clarity'
    || CLARITY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    || requestsClarityContract(req);
}

/** Build the unexpected-failure body for a new-contract request. */
export function unexpectedErrorEnvelope(req) {
  const code = MUTATING_METHODS.has(req.method) ? 'MUTATION_FAILED' : 'INTERNAL_ERROR';
  return {
    error: {
      code,
      message: UNEXPECTED_ERROR_ENVELOPES[code],
      retryable: true,
      ...(typeof req.requestId === 'string' ? { correlationId: req.requestId } : {}),
    },
  };
}

/**
 * Final Express error handler. Known transport errors and the CORS rejection
 * keep their existing legacy responses. Anything else is unexpected: it is
 * logged as a single event with the error class name and an optional stable
 * error code, and the client receives a fixed envelope. The error object is
 * never printed, so its stack, SQL text, and attached data cannot reach logs.
 */
export function createErrorBoundary({ logger = operationalLogger } = {}) {
  return function errorBoundary(err, req, res, _next) {
    if (res.headersSent) {
      // The body is already partly written. Close the connection rather than
      // let the default handler print the error and its stack.
      logUnexpected(logger, req, err, 500);
      req.socket?.destroy();
      return undefined;
    }

    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (typeof err?.message === 'string' && err.message.startsWith('CORS:')) {
      return res.status(403).json({ error: err.message });
    }

    logUnexpected(logger, req, err, 500);
    if (usesClarityErrorEnvelope(req)) {
      return res.status(500).json(unexpectedErrorEnvelope(req));
    }
    return res.status(500).json({ error: 'Server error' });
  };
}

function logUnexpected(logger, req, err, status) {
  logger.error({
    event: 'REQUEST_UNEXPECTED_ERROR',
    requestId: req.requestId,
    route: routeLabel(req),
    method: req.method,
    status,
    errorName: safeErrorName(err),
    code: safeErrorCode(err),
    userId: req.user?.id,
  });
}
