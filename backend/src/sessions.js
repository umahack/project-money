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
 * Enforce single-session: revoke every active session for this user,
 * then insert a fresh row. Returns the new session id.
 */
export async function createSingleSession(userId, { ip, userAgent, reason = 'new_login' } = {}) {
  await db
    .prepare(
      `UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL`
    )
    .run(reason === 'new_login' ? 'another_device' : reason, userId);
  const info = await db
    .prepare(
      `INSERT INTO sessions (user_id, device_label, ip_hash, user_agent)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, labelForUA(userAgent).slice(0, 60), dailyIpHash(ip), String(userAgent || '').slice(0, 240) || null);
  return Number(info.lastInsertRowid);
}

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
