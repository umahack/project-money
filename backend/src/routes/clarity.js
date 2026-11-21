import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import clarityService from '../services/clarityService.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)$/;
const PERIOD_OUTCOME_PATTERN = /^(?:monthly-plan|spending|trip-summary):(\d{4}-(?:0[1-9]|1[0-2]))$/;
const RECORD_OUTCOME_PATTERN = /^(?:goal|trip):([1-9]\d*)$/;

function contractError(res, status, code, message, details = {}) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...details,
    },
  });
}

function isRepresentableMonth(value) {
  return typeof value === 'string'
    && MONTH_PATTERN.test(value)
    && value !== '9999-12';
}

function isSupportedOutcomeId(value) {
  if (typeof value !== 'string') return false;
  const periodMatch = PERIOD_OUTCOME_PATTERN.exec(value);
  if (periodMatch) return isRepresentableMonth(periodMatch[1]);

  const recordMatch = RECORD_OUTCOME_PATTERN.exec(value);
  return Boolean(recordMatch && Number.isSafeInteger(Number(recordMatch[1])));
}

function parseExpectedVersion(value) {
  if (value === undefined) return { valid: true, value: undefined };
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    return { valid: false };
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { valid: true, value: parsed }
    : { valid: false };
}

export function createClarityRouter({ service = clarityService, clock = () => new Date() } = {}) {
  if (!service || typeof service.getSnapshot !== 'function' || typeof service.getExplanation !== 'function') {
    throw new TypeError('A clarity service with read and explanation methods is required.');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  const router = Router();

  router.get('/clarity', authRequired, async (req, res) => {
    const month = req.query.month;
    if (!isRepresentableMonth(month)) {
      return contractError(
        res,
        400,
        'INVALID_MONTH',
        'month must identify an exact, representable period in YYYY-MM format.',
        { field: 'month', constraint: 'YYYY-MM' }
      );
    }

    const snapshot = await service.getSnapshot({
      userId: req.user.id,
      month,
      now: clock(),
    });
    return res.json({ schemaVersion: 1, snapshot });
  });

  router.get('/explanations/:outcomeId', authRequired, async (req, res) => {
    const { outcomeId } = req.params;
    if (!isSupportedOutcomeId(outcomeId)) {
      return contractError(
        res,
        400,
        'INVALID_OUTCOME_ID',
        'outcomeId must identify a supported financial outcome.',
        { field: 'outcomeId' }
      );
    }

    const version = parseExpectedVersion(req.query.version);
    if (!version.valid) {
      return contractError(
        res,
        400,
        'INVALID_VERSION',
        'version must be a non-negative safe integer.',
        { field: 'version', constraint: 'non-negative safe integer' }
      );
    }

    const result = await service.getExplanation({
      userId: req.user.id,
      outcomeId,
      expectedVersion: version.value,
      now: clock(),
    });
    if (!result) {
      return contractError(res, 404, 'OUTCOME_NOT_FOUND', 'Outcome not found.');
    }
    if (result.versionUnavailable) {
      return contractError(
        res,
        409,
        'DATA_VERSION_NOT_AVAILABLE',
        'The requested financial data version is not available.',
        { currentVersion: result.currentVersion }
      );
    }

    return res.json({
      schemaVersion: 1,
      ...(result.supersededByVersion === undefined
        ? {}
        : { supersededByVersion: result.supersededByVersion }),
      explanation: result.explanation,
    });
  });

  return router;
}

export default createClarityRouter();
