import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { runMonthlyReview } from '../jobs/monthlyReview.js';

const router = Router();

/**
 * Secret-gated endpoints for scheduled jobs. Protected by a shared bearer in
 * the `x-cron-secret` header matching the CRON_SECRET env var. Compared with
 * timing-safe equality to defeat length-leak timing attacks. We never expose
 * CRON_SECRET to the frontend, so the only way to hit these is to know the
 * raw value stored on Render's env.
 */
function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    return res.status(503).json({ error: 'Cron endpoints disabled (CRON_SECRET not configured).' });
  }
  const got = String(req.headers['x-cron-secret'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Light rate limit — these endpoints are called at most monthly in prod.
// A tighter cap means an attacker who guesses the secret can still only
// trigger a dozen runs an hour before being blocked.
const cronLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Cron endpoint rate-limited.' },
});

router.use(cronLimiter);
router.use(requireCronSecret);

router.post('/cron/monthly-review', async (req, res) => {
  const dry = req.query?.dry === '1' || req.body?.dry === true;
  const result = await runMonthlyReview({ dry });
  res.json({ ok: true, ...result });
});

export default router;
