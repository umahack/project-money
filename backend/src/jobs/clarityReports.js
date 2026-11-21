import measurementReportService from '../services/measurementReportService.js';

/**
 * Scheduled entry point for completed-period success reports. Invoked by
 * POST /api/internal/cron/clarity-reports (secret-gated, see routes/internal.js).
 * Safe to trigger repeatedly: periods are upserted by key and the checkpoint
 * only moves forward. Pass `dry: true` to list the work without writing or
 * purging anything.
 *
 * The result holds counts and instants only, never user or financial data.
 */
export async function runClarityReports({ dry = false, service = measurementReportService } = {}) {
  return service.generateCompletedReports({ dry });
}
