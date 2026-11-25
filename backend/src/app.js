import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import clarityRoutes from './routes/clarity.js';
import settingsRoutes from './routes/settings.js';
import clarityEventsRoutes from './routes/clarityEvents.js';
import journeysRoutes from './routes/journeys.js';
import financeRoutes from './routes/finance.js';
import quickAddRoutes from './routes/quickAdd.js';
import tripRoutes from './routes/trips.js';
import adminRoutes from './routes/admin.js';
import adminClarityReportsRoutes from './routes/adminClarityReports.js';
import feedbackRoutes from './routes/feedback.js';
import invitesRoutes from './routes/invites.js';
import publicRoutes from './routes/public.js';
import visitsRoutes from './routes/visits.js';
import internalRoutes from './routes/internal.js';
import { createRequestContext } from './middleware/requestContext.js';
import { createErrorBoundary } from './middleware/errorBoundary.js';
import { operationalLogger } from './observability/operationalLog.js';

export function resolveCorsOrigin(rawOrigin, isProduction) {
  if (!rawOrigin || rawOrigin === '*') {
    if (isProduction) {
      throw new Error('CORS_ORIGIN must be set to a specific allowlist in production. Refusing to boot.');
    }
    return true;
  }

  const allowlist = rawOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return (origin, callback) => {
    // Allow curl and server-to-server requests that have no Origin header.
    if (!origin) return callback(null, true);
    if (allowlist.includes(origin)) return callback(null, true);
    return callback(new Error('CORS: origin not allowed'));
  };
}

/**
 * Build the Express application without opening a network listener.
 * `operationalLogger` is injectable so tests can capture structured events.
 */
export function createApp({ operationalLogger: logger = operationalLogger } = {}) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
    throw new Error('JWT_SECRET missing or too short. Copy .env.example to .env and set a strong secret.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // First in the chain so every response, including CORS and parse failures,
  // carries a server-generated request ID for log correlation.
  app.use(createRequestContext({ logger, logAllRequests: process.env.NODE_ENV === 'production' }));

  // Strict security headers. The API itself only serves JSON, so CSP allows
  // no scripts, inline content, or frames.
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
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    })
  );

  const isProduction = process.env.NODE_ENV === 'production';
  const rawOrigin = process.env.CORS_ORIGIN?.trim();
  app.use(cors({ origin: resolveCorsOrigin(rawOrigin, isProduction), credentials: false }));
  app.use(express.json({ limit: '64kb' }));
  // Production access logging is the structured, redacted REQUEST_COMPLETED
  // event (route pattern, status, duration bucket; no URL, IP, referrer, or
  // user-agent text). The human-readable morgan line is for local development.
  if (process.env.NODE_ENV !== 'test' && !isProduction) {
    app.use(morgan('dev', {
      // Public share tokens are bearer capabilities. Do not place them in
      // access logs; route-level logging starts only after this path.
      skip: (req) => /^\/api\/public\/trips(?:\/|$)/.test(req.originalUrl || req.url),
    }));
  }

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
  app.use('/api/clarity/settings', settingsRoutes);
  app.use('/api/clarity/events', clarityEventsRoutes);
  app.use('/api/clarity/journeys', journeysRoutes);
  app.use('/api/finance', clarityRoutes);
  app.use('/api/finance', quickAddRoutes);
  app.use('/api/finance', financeRoutes);
  app.use('/api/trips', tripRoutes);
  app.use('/api/admin/clarity-reports', adminClarityReportsRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/public', publicRoutes);
  // Secret-gated scheduler endpoints must precede the /api-wide authenticated
  // routers so scheduler requests reach their own authorization middleware.
  app.use('/api/internal', internalRoutes);
  app.use('/api', visitsRoutes);
  app.use('/api', invitesRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Unexpected errors are logged as one redacted event and answered with a
  // fixed body; legacy routes keep `{ error: 'Server error' }`.
  app.use(createErrorBoundary({ logger }));

  return app;
}
