import crypto from 'node:crypto';
import db from './db/index.js';
import { logBackgroundFailure } from './observability/operationalLog.js';

function dailyIpHash(ip) {
  const salt = (process.env.JWT_SECRET || 'pm-fallback-salt').slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${day}:${salt}:${ip || 'unknown'}`).digest('hex').slice(0, 24);
}

/**
 * Append-only record of destructive or privileged actions. Failures are logged
 * but never propagated — audit must never break the primary flow.
 */
export async function audit(req, { action, target = null, details = null }) {
  try {
    const ip = req.ip || req.socket?.remoteAddress || '';
    await db
      .prepare(
        'INSERT INTO audit_log (actor_id, actor_email, action, target, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        req.user?.id ?? null,
        req.user?.email ?? null,
        String(action).slice(0, 60),
        target == null ? null : String(target).slice(0, 120),
        details == null ? null : String(details).slice(0, 400),
        dailyIpHash(ip)
      );
  } catch (err) {
    logBackgroundFailure('audit_write', err);
  }
}
