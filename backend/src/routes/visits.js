import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';

const router = Router();

const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Hash the IP + a daily salt. The hash rotates every day so we can count unique
 * visitors per day without storing raw IPs or persisting a long-term identifier.
 */
function dailyIpHash(ip) {
  const salt = (process.env.JWT_SECRET || 'pm-fallback-salt').slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${day}:${salt}:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Attempt to recover the signed-in user id from the auth header without
 * requiring auth. Also verifies the session hasn't been revoked (e.g., by
 * the 3-device cap) and that token_version is current — otherwise visits
 * get attributed to accounts whose device no longer has access.
 */
async function optionalUserId(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const sub = Number(payload.sub);
  if (!sub || !payload.sid) return null;
  try {
    const row = await db
      .prepare(
        `SELECT u.token_version AS tv, s.revoked_at
           FROM users u JOIN sessions s ON s.user_id = u.id
          WHERE u.id = ? AND s.id = ?`
      )
      .get(sub, Number(payload.sid));
    if (!row) return null;
    if (row.revoked_at) return null;
    if (Number(payload.tv ?? 1) !== Number(row.tv)) return null;
    return sub;
  } catch {
    return null;
  }
}

router.post(
  '/track',
  trackLimiter,
  [body('path').isString().isLength({ min: 1, max: 200 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Bad path' });
    const path = String(req.body.path).slice(0, 200);
    // Cap UA length to keep rows small; never store `null` as the string literal.
    const ua = String(req.headers['user-agent'] || '').slice(0, 240) || null;
    const ip = req.ip || req.socket?.remoteAddress || '';
    await db
      .prepare('INSERT INTO visits (user_id, path, ip_hash, user_agent) VALUES (?, ?, ?, ?)')
      .run(await optionalUserId(req), path, dailyIpHash(ip), ua);
    res.status(204).end();
  }
);

export default router;
