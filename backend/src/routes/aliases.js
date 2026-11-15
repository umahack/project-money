import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const MAX_ALIASES_PER_USER = 5;

const router = Router();
router.use(authRequired);

const addLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Find a user by email, checking primary users.email first, then user_aliases.
 * Primary wins when both exist (shouldn't happen; defensive).
 */
export async function resolveUserByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) return null;
  const primary = await db
    .prepare('SELECT id, email, name, password_hash, is_admin FROM users WHERE email = ?')
    .get(lower);
  if (primary) return { ...primary, matched_via: 'primary' };
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.password_hash, u.is_admin
         FROM users u
         JOIN user_aliases a ON a.user_id = u.id
        WHERE a.email = ?`
    )
    .get(lower);
  return row ? { ...row, matched_via: 'alias' } : null;
}

router.get('/', async (req, res) => {
  const rows = await db
    .prepare('SELECT id, email, created_at FROM user_aliases WHERE user_id = ? ORDER BY id ASC')
    .all(req.user.id);
  res.json({ aliases: rows });
});

router.post(
  '/',
  addLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const email = String(req.body.email).toLowerCase();

    const me = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (me?.email === email) return res.status(400).json({ error: 'That is already your primary email.' });

    const owned = await db
      .prepare('SELECT COUNT(*) AS c FROM user_aliases WHERE user_id = ?')
      .get(req.user.id);
    if (Number(owned.c) >= MAX_ALIASES_PER_USER)
      return res.status(400).json({ error: `You can link at most ${MAX_ALIASES_PER_USER} alias emails.` });

    const takenPrimary = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (takenPrimary)
      return res.status(409).json({ error: 'That email is the primary email of another account.' });
    const takenAlias = await db
      .prepare('SELECT user_id FROM user_aliases WHERE email = ?')
      .get(email);
    if (takenAlias)
      return res.status(409).json({ error: 'That email is already linked to another account.' });

    const info = await db
      .prepare('INSERT INTO user_aliases (user_id, email) VALUES (?, ?)')
      .run(req.user.id, email);
    res.json({ id: info.lastInsertRowid, email });
  }
);

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const info = await db
    .prepare('DELETE FROM user_aliases WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
