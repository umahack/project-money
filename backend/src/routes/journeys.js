import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { createDataUseNoticeGate } from '../middleware/dataUse.js';
import {
  operationalLogger,
  safeErrorCode,
  safeErrorName,
} from '../observability/operationalLog.js';
import journeyService, {
  JOURNEY_SCHEMA_VERSION,
  JourneyError,
} from '../services/journeyService.js';

const JOURNEY_ID_PATTERN = /^[1-9]\d{0,14}$/;
// Pause and resume only move saved progress; they do not need the notice.
const NOTICE_EXEMPT_ACTIONS = new Set(['pause', 'resume']);

function journeyErrorBody(error) {
  const body = {
    code: error.code,
    message: error.message,
  };
  for (const field of [
    'field',
    'allowedFields',
    'allowedValues',
    'stepKey',
    'retryScopeKey',
    'status',
    'activeJourneyId',
    'activeDesiredOutcome',
  ]) {
    if (Object.hasOwn(error, field)) body[field] = error[field];
  }
  return {
    error: body,
    ...(error.journey === undefined
      ? {}
      : { schemaVersion: JOURNEY_SCHEMA_VERSION, journey: error.journey }),
  };
}

/**
 * Failures that are not part of the journey contract. The response names the
 * scope to retry and states that confirmed records are untouched. It never
 * echoes the underlying error, which may reference stored data.
 */
function operationFailureBody(retryScopeKey, correlationId) {
  return {
    error: {
      code: 'JOURNEY_OPERATION_FAILED',
      message: 'The journey change could not be saved. Your confirmed records were not changed. Try again.',
      retryable: true,
      retryScopeKey,
      ...(typeof correlationId === 'string' ? { correlationId } : {}),
    },
  };
}

function logJourneyFailure(req, operation, error) {
  operationalLogger.error({
    event: 'JOURNEY_OPERATION_FAILED',
    requestId: req.requestId,
    operation,
    errorName: safeErrorName(error),
    code: safeErrorCode(error),
    userId: req.user?.id,
  });
}

function parseJourneyId(value) {
  return typeof value === 'string' && JOURNEY_ID_PATTERN.test(value) ? Number(value) : null;
}

/**
 * Authenticated, server-owned guided-journey routes. Every route runs after
 * `authRequired`; journeys are looked up by authenticated user and ID, so an
 * ID that belongs to another user is indistinguishable from a missing one.
 */
export function createJourneysRouter({ service = journeyService, dataUseGate } = {}) {
  for (const method of ['getActive', 'start', 'apply']) {
    if (!service || typeof service[method] !== 'function') {
      throw new TypeError(`A journey service with ${method}() is required.`);
    }
  }

  const startGate = dataUseGate ?? createDataUseNoticeGate();
  const transitionGate = dataUseGate ?? createDataUseNoticeGate({
    appliesTo: (req) => !NOTICE_EXEMPT_ACTIONS.has(req.body?.action),
  });

  const router = Router();
  router.use(authRequired);

  router.get('/active', async (req, res) => {
    const journey = await service.getActive({ userId: req.user.id });
    return res.json({ schemaVersion: JOURNEY_SCHEMA_VERSION, journey });
  });

  router.post('/', startGate, async (req, res) => {
    try {
      const { journey, created } = await service.start({
        userId: req.user.id,
        sessionId: req.user.sid,
        body: req.body,
      });
      return res
        .status(created ? 201 : 200)
        .json({ schemaVersion: JOURNEY_SCHEMA_VERSION, journey });
    } catch (error) {
      if (error instanceof JourneyError) {
        return res.status(error.httpStatus).json(journeyErrorBody(error));
      }
      logJourneyFailure(req, 'journey.start', error);
      return res.status(500).json(operationFailureBody('journey:start', req.requestId));
    }
  });

  router.patch('/:id', transitionGate, async (req, res) => {
    const journeyId = parseJourneyId(req.params.id);
    if (journeyId === null) {
      return res.status(404).json(journeyErrorBody(new JourneyError({
        code: 'JOURNEY_NOT_FOUND',
        message: 'Journey was not found.',
        httpStatus: 404,
      })));
    }
    try {
      const result = await service.apply({
        userId: req.user.id,
        journeyId,
        body: req.body,
      });
      return res.json({ schemaVersion: JOURNEY_SCHEMA_VERSION, ...result });
    } catch (error) {
      if (error instanceof JourneyError) {
        return res.status(error.httpStatus).json(journeyErrorBody(error));
      }
      const target = typeof req.body?.stepKey === 'string' && /^[a-z_]{1,40}$/.test(req.body.stepKey)
        ? req.body.stepKey
        : typeof req.body?.action === 'string' && /^[a-z_]{1,20}$/.test(req.body.action)
          ? req.body.action
          : 'transition';
      logJourneyFailure(req, 'journey.transition', error);
      return res.status(500).json(operationFailureBody(`journey:${journeyId}:${target}`, req.requestId));
    }
  });

  return router;
}

export default createJourneysRouter();
