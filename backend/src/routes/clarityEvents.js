import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authRequired } from '../middleware/auth.js';
import measurementService, { MeasurementError } from '../services/measurementService.js';

function errorBody(error) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    },
  };
}

/**
 * Authenticated, closed-schema Product Analytics ingestion. Accepted events,
 * disabled analytics, and dropped retries all return the same 204 so the
 * response does not reveal consent state or event counting.
 */
export function createClarityEventsRouter({ service = measurementService } = {}) {
  if (!service || typeof service.ingest !== 'function') {
    throw new TypeError('A measurement service with ingest() is required.');
  }

  const router = Router();
  router.use(authRequired);
  router.use(rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  router.post('/', async (req, res) => {
    try {
      await service.ingest({
        userId: req.user.id,
        sessionId: req.user.sid,
        input: req.body,
      });
      return res.status(204).end();
    } catch (error) {
      if (error instanceof MeasurementError) {
        return res.status(error.httpStatus).json(errorBody(error));
      }
      throw error;
    }
  });

  return router;
}

export default createClarityEventsRouter();
