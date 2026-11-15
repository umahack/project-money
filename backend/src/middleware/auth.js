import jwt from 'jsonwebtoken';
import db from '../db/index.js';

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(payload.sub);
    if (!row) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    req.user = { id: row.id, email: row.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
