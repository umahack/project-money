/**
 * Standalone runner for manual / local use. The production schedule invokes
 * the same logic via POST /api/internal/cron/monthly-review (see
 * backend/src/routes/internal.js). The real logic lives in
 * backend/src/jobs/monthlyReview.js.
 *
 * Env needed:
 *   TURSO_DATABASE_URL
 *   TURSO_AUTH_TOKEN
 *   RESEND_API_KEY
 *   MAIL_FROM (optional)
 *
 * Flags: MONTHLY_REVIEW_DRY_RUN=1 to preview without sending.
 */
import 'dotenv/config';
import { runMonthlyReview } from '../src/jobs/monthlyReview.js';

runMonthlyReview({ dry: process.env.MONTHLY_REVIEW_DRY_RUN === '1' })
  .then((r) => { if (r.failed > 0 && !r.dry) process.exitCode = 1; })
  .catch((e) => { console.error('[monthly-review] fatal:', e); process.exit(1); });
