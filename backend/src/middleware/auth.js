import jwt from 'jsonwebtoken';
import db from '../db/index.js';

/**
 * Validate the Bearer JWT, pin the HS256 algorithm (defense against
 * algorithm-confusion attacks where a signer swaps to `none`), and verify
 * the user still exists AND the token_version matches — bumping that column
 * revokes every outstanding JWT for the user (used on password change).
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
  const row = await db
    .prepare('SELECT id, email, token_version FROM users WHERE id = ?')
    .get(payload.sub);
  if (!row) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  if (Number(payload.tv ?? 1) !== Number(row.token_version)) {
    return res.status(401).json({ error: 'Session was invalidated. Please sign in again.' });
  }
  req.user = { id: row.id, email: row.email };
  next();
}
