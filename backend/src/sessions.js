import crypto from 'node:crypto';
import db from './db/index.js';

/** Hash the IP with a daily-rotating salt so we never store raw IPs. */
export function dailyIpHash(ip) {
  const salt = (process.env.JWT_SECRET || 'pm-fallback-salt').slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${day}:${salt}:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
}

/** Very light device label parser; we don't ship a UA library for scope. */
export function labelForUA(ua) {
  if (!ua) return 'Unknown device';
  const u = String(ua);
  let os = 'Unknown';
  if (/Windows NT 10/i.test(u)) os = 'Windows';
  else if (/Mac OS X/i.test(u)) os = u.includes('iPhone') ? 'iPhone' : u.includes('iPad') ? 'iPad' : 'Mac';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/Linux/i.test(u)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//i.test(u)) browser = 'Edge';
  else if (/Chrome\//i.test(u) && !/Edg\//i.test(u)) browser = 'Chrome';
  else if (/Firefox\//i.test(u)) browser = 'Firefox';
  else if (/Safari\//i.test(u) && !/Chrome\//i.test(u)) browser = 'Safari';
  return `${browser} on ${os}`;
}

/**
 * Max concurrent active sessions per account. When a login would push the count
 * above this, the oldest active session(s) are revoked first (FIFO) so the new
 * device fits inside the cap.
 */
export const MAX_ACTIVE_SESSIONS = 3;

/**
 * Allow up to MAX_ACTIVE_SESSIONS devices per user. If adding this one would
 * exceed the cap, revoke the oldest active session(s) FIFO. Returns the new
 * session id.
 */
export async function createSession(userId, { ip, userAgent, reason = 'new_login' } = {}) {
  const active = await db
    .prepare(
      `SELECT id FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC, id ASC`
    )
    .all(userId);
  const keepSlots = MAX_ACTIVE_SESSIONS - 1; // room for the new one we're about to insert
  const toRevoke = active.slice(0, Math.max(0, active.length - keepSlots));
  if (toRevoke.length > 0) {
    const ids = toRevoke.map((r) => Number(r.id));
    const placeholders = ids.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP,
                revoked_reason = ?
          WHERE id IN (${placeholders})`
      )
      .run(reason === 'new_login' ? 'another_device' : reason, ...ids);
  }
  const info = await db
    .prepare(
      `INSERT INTO sessions (user_id, device_label, ip_hash, user_agent)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, labelForUA(userAgent).slice(0, 60), dailyIpHash(ip), String(userAgent || '').slice(0, 240) || null);
  return Number(info.lastInsertRowid);
}

// Backwards-compatible alias — older imports still work.
export const createSingleSession = createSession;

/** Mark a specific session revoked. */
export async function revokeSession(userId, sessionId, reason = 'user_revoked') {
  const info = await db
    .prepare(
      `UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .run(reason, sessionId, userId);
  return Number(info.changes) > 0;
}
