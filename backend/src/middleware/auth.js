import jwt from 'jsonwebtoken';
import db from '../db/index.js';

/**
 * Validate the Bearer JWT and resolve to a live, non-revoked session row.
 * We also pin HS256 to defeat algorithm-confusion attacks, and still verify
 * token_version as a nuclear kill-switch for mass revocation.
 */
export async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = await db
    .prepare('SELECT id, email, token_version FROM users WHERE id = ?')
    .get(payload.sub);
  if (!user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  if (Number(payload.tv ?? 1) !== Number(user.token_version)) {
    return res.status(401).json({ error: 'Session was invalidated. Please sign in again.' });
  }

  // Session-level revocation (per-device).
  if (!payload.sid) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  const session = await db
    .prepare(
      'SELECT id, user_id, revoked_at, revoked_reason FROM sessions WHERE id = ?'
    )
    .get(payload.sid);
  if (!session || Number(session.user_id) !== Number(user.id)) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  if (session.revoked_at) {
    const msg =
      session.revoked_reason === 'another_device'
        ? 'Signed out because this account reached the 3-device limit on a new sign-in.'
        : 'This session was signed out.';
    return res.status(401).json({ error: msg, code: 'SESSION_REVOKED' });
  }

  // Touch last_seen_at (best-effort; cheap, no transaction). We don't await
  // it so request latency isn't hurt, but we DO log errors so real DB
  // issues aren't invisible.
  db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(session.id)
    .catch?.((e) => console.error('[session.last_seen_at] skipped:', e?.message));

  req.user = { id: user.id, email: user.email, sid: Number(session.id) };
  next();
}
