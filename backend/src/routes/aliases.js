import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { aliasVerifyEmail, sendMail } from '../mailer.js';

const MAX_ALIASES_PER_USER = 5;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 6;

const router = Router();
router.use(authRequired);

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails. Try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Try again later.' },
});

/**
 * Find a user by email, checking primary users.email first, then VERIFIED aliases only.
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
        WHERE a.email = ? AND a.verified = 1`
    )
    .get(lower);
  return row ? { ...row, matched_via: 'alias' } : null;
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function issueCode(aliasId) {
  const code = generateCode();
  const hash = await bcrypt.hash(code, 10);
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db
    .prepare(
      `UPDATE user_aliases
          SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0
        WHERE id = ?`
    )
    .run(hash, expires, aliasId);
  return code;
}

async function sendVerificationFor(aliasId, email, inviterEmail) {
  const code = await issueCode(aliasId);
  const { subject, text, html } = aliasVerifyEmail(code, inviterEmail);
  const result = await sendMail({ to: email, subject, text, html });
  return result;
}

router.get('/', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, email, label, verified, created_at, verified_at
         FROM user_aliases
        WHERE user_id = ?
        ORDER BY id ASC`
    )
    .all(req.user.id);
  res.json({
    aliases: rows.map((r) => ({ ...r, verified: !!r.verified })),
  });
});

router.post(
  '/',
  sendLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('label').optional().isString().trim().isLength({ max: 40 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email and a label up to 40 characters' });
    const email = String(req.body.email).toLowerCase();
    const label = req.body.label ? String(req.body.label).trim().slice(0, 40) : null;

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
      .prepare('SELECT user_id, verified FROM user_aliases WHERE email = ?')
      .get(email);
    if (takenAlias && (takenAlias.verified || takenAlias.user_id !== req.user.id))
      return res.status(409).json({ error: 'That email is already linked to another account.' });

    let aliasId;
    if (takenAlias && takenAlias.user_id === req.user.id) {
      aliasId = (await db.prepare('SELECT id FROM user_aliases WHERE email = ?').get(email)).id;
      if (label) await db.prepare('UPDATE user_aliases SET label = ? WHERE id = ?').run(label, aliasId);
    } else {
      const info = await db
        .prepare('INSERT INTO user_aliases (user_id, email, label, verified) VALUES (?, ?, ?, 0)')
        .run(req.user.id, email, label);
      aliasId = info.lastInsertRowid;
    }
    const mail = await sendVerificationFor(aliasId, email, me.email);
    res.json({
      id: aliasId,
      email,
      label,
      verified: false,
      mail: { sent: mail.ok, fallback: !!mail.fallback },
    });
  }
);

router.put(
  '/:id',
  [body('label').optional({ nullable: true }).isString().trim().isLength({ max: 40 })],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Label must be ≤ 40 characters' });
    const label = req.body.label ? String(req.body.label).trim().slice(0, 40) : null;
    const info = await db
      .prepare('UPDATE user_aliases SET label = ? WHERE id = ? AND user_id = ?')
      .run(label, id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, label });
  }
);

router.post(
  '/:id/resend',
  sendLimiter,
  async (req, res) => {
    const id = Number(req.params.id);
    const row = await db
      .prepare('SELECT id, email, verified FROM user_aliases WHERE id = ? AND user_id = ?')
      .get(id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.verified) return res.status(400).json({ error: 'Already verified.' });
    const me = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    const mail = await sendVerificationFor(row.id, row.email, me.email);
    res.json({ ok: true, mail: { sent: mail.ok, fallback: !!mail.fallback } });
  }
);

router.post(
  '/:id/verify',
  verifyLimiter,
  [body('code').isString().matches(/^\d{6}$/)],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter the 6-digit code.' });

    const row = await db
      .prepare(
        `SELECT id, email, verified, verify_code_hash, verify_expires_at, verify_attempts
           FROM user_aliases WHERE id = ? AND user_id = ?`
      )
      .get(id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.verified) return res.json({ ok: true, alreadyVerified: true });
    if (!row.verify_code_hash) return res.status(400).json({ error: 'No code is active. Resend first.' });
    if (new Date(row.verify_expires_at).getTime() < Date.now())
      return res.status(400).json({ error: 'Code expired. Resend a new one.' });
    if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Resend a fresh code.' });

    const ok = await bcrypt.compare(req.body.code, row.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE user_aliases SET verify_attempts = verify_attempts + 1 WHERE id = ?')
        .run(id);
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    await db
      .prepare(
        `UPDATE user_aliases
            SET verified = 1,
                verified_at = CURRENT_TIMESTAMP,
                verify_code_hash = NULL,
                verify_expires_at = NULL,
                verify_attempts = 0
          WHERE id = ?`
      )
      .run(id);
    res.json({ ok: true });
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
