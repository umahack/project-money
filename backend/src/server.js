import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import financeRoutes from './routes/finance.js';
import tripRoutes from './routes/trips.js';
import adminRoutes from './routes/admin.js';
import feedbackRoutes from './routes/feedback.js';
import invitesRoutes from './routes/invites.js';
import publicRoutes from './routes/public.js';
import visitsRoutes from './routes/visits.js';
import internalRoutes from './routes/internal.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
  console.error('JWT_SECRET missing or too short. Copy .env.example to .env and set a strong secret.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Strict security headers. The API itself only serves JSON, so CSP is very
// locked down — no scripts, no inline, no frames.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false, // JSON API; we don't need COEP
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  })
);

// Strict CORS: in production, CORS_ORIGIN MUST be a comma-separated allowlist.
// We refuse the wildcard fallback (`*`) in production so a misconfig can't
// expose the API to any origin.
const rawOrigin = process.env.CORS_ORIGIN?.trim();
const isProd = process.env.NODE_ENV === 'production';
let corsOrigin;
if (!rawOrigin || rawOrigin === '*') {
  if (isProd) {
    console.error('CORS_ORIGIN must be set to a specific allowlist in production. Refusing to boot.');
    process.exit(1);
  }
  corsOrigin = true; // dev convenience only
} else {
  const list = rawOrigin.split(',').map((s) => s.trim()).filter(Boolean);
  corsOrigin = (origin, cb) => {
    // Allow curl / server-to-server (no Origin header)
    if (!origin) return cb(null, true);
    if (list.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  };
}
app.use(cors({ origin: corsOrigin, credentials: false }));
app.use(express.json({ limit: '64kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api/auth', authRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/public', publicRoutes); // must come before `/api` catch-alls so no-auth routes are reachable
app.use('/api', visitsRoutes); // `/track` is public (optional auth); mount before invitesRoutes which uses authRequired
app.use('/api', invitesRoutes);
app.use('/api/internal', internalRoutes);

// Any /api/* path the routers above didn't match is a 404, not an HTML page.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  // CORS rejections bubble as plain Error; return them as 403 so operator
  // metrics distinguish "wrong origin" from true server faults.
  if (typeof err?.message === 'string' && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
