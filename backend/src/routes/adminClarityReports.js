import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { adminRequired } from '../middleware/admin.js';
import measurementReportService, {
  DEFAULT_LIST_LIMIT,
  MeasurementReportError,
} from '../services/measurementReportService.js';

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return Number.NaN;
  return Number(raw);
}

/**
 * Admin-only aggregate success-metric reads. Authentication and the admin
 * check run before anything else; there is no anonymous path and no listener.
 * Responses come from the report service allowlist: period metadata and metric
 * aggregates only, never user rows, identifiers, or financial values.
 */
export function createAdminClarityReportsRouter({ service = measurementReportService } = {}) {
  if (!service || typeof service.listReports !== 'function') {
    throw new TypeError('A measurement report service with listReports() is required.');
  }

  const router = Router();
  router.use(authRequired, adminRequired);

  router.get('/', async (req, res) => {
    const { periodType, limit } = req.query;
    try {
      const result = await service.listReports({
        periodType: periodType === undefined
          ? null
          : (typeof periodType === 'string' ? periodType : '__invalid__'),
        limit: parseLimit(limit),
      });
      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      if (error instanceof MeasurementReportError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message },
        });
      }
      throw error;
    }
  });

  return router;
}

export default createAdminClarityReportsRouter();
