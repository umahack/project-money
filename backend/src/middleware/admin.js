import db from '../db/index.js';

export function adminRequired(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user.id);
  if (!row?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

export function adminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}
