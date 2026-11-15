import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { adminEmails } from '../middleware/admin.js';
import { resolveUserByEmail } from './aliases.js';
import { registerVerifyEmail, sendMail } from '../mailer.js';

const router = Router();
const HANDLE_RE = /^[a-z0-9._-]{3,30}$/;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 6;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, slow down.' },
});

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails. Try again later.' },
});

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function promoteIfConfigured(userId, email) {
  const admins = adminEmails();
  const shouldBeAdmin = admins.has(String(email).toLowerCase()) ? 1 : 0;
  if (shouldBeAdmin) await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
  return shouldBeAdmin;
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function issueRegistrationCode(email) {
  const code = generateCode();
  const hash = await bcrypt.hash(code, 10);
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db
    .prepare(
      `UPDATE pending_registrations
          SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0
        WHERE email = ?`
    )
    .run(hash, expires, email);
  return code;
}

// Step 1 of registration: capture name/email/password, email a 6-digit code.
router.post(
  '/register-start',
  sendLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('name').isString().trim().isLength({ min: 1, max: 60 }),
    body('password')
      .isString()
      .isLength({ min: 8, max: 128 })
      .withMessage('Password must be at least 8 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { email, name, password } = req.body;

    const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(409).json({ error: 'That email is already registered. Try signing in instead.' });

    const hash = await bcrypt.hash(password, 12);
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();

    await db
      .prepare(
        `INSERT INTO pending_registrations (email, name, password_hash, verify_code_hash, verify_expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           name = excluded.name,
           password_hash = excluded.password_hash,
           verify_code_hash = excluded.verify_code_hash,
           verify_expires_at = excluded.verify_expires_at,
           verify_attempts = 0`
      )
      .run(email, name.trim(), hash, codeHash, expires);

    const { subject, text, html } = registerVerifyEmail(code);
    const result = await sendMail({ to: email, subject, text, html });
    res.json({ ok: true, email, mail: { sent: result.ok, fallback: !!result.fallback } });
  }
);

// Resend the code if the user never got it.
router.post(
  '/register-resend',
  sendLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const { email } = req.body;
    const row = await db.prepare('SELECT email FROM pending_registrations WHERE email = ?').get(email);
    if (!row) return res.status(404).json({ error: 'Start sign-up first — we need your name and password.' });
    const code = await issueRegistrationCode(email);
    const { subject, text, html } = registerVerifyEmail(code);
    const result = await sendMail({ to: email, subject, text, html });
    res.json({ ok: true, mail: { sent: result.ok, fallback: !!result.fallback } });
  }
);

// Step 2: validate the code (does NOT create the user yet — the alias step does).
router.post(
  '/register-verify-code',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isString().matches(/^\d{6}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    const { email, code } = req.body;
    const row = await db
      .prepare(
        `SELECT verify_code_hash, verify_expires_at, verify_attempts
           FROM pending_registrations WHERE email = ?`
      )
      .get(email);
    if (!row) return res.status(404).json({ error: 'Start sign-up first.' });
    if (new Date(row.verify_expires_at).getTime() < Date.now())
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Resend a new code.' });

    const ok = await bcrypt.compare(code, row.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE pending_registrations SET verify_attempts = verify_attempts + 1 WHERE email = ?')
        .run(email);
      return res.status(400).json({ error: 'Incorrect code.' });
    }
    res.json({ ok: true });
  }
);

// Step 3: user provides a unique nickname. We re-check the OTP as a defense-in-depth
// so step 2 alone can't finish an account without the second request also carrying the code.
router.post(
  '/register-finish',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isString().matches(/^\d{6}$/),
    body('handle').isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { email, code } = req.body;
    const handle = String(req.body.handle || '').trim().toLowerCase();
    if (!HANDLE_RE.test(handle))
      return res.status(400).json({ error: 'Nickname must be 3–30 chars: letters, digits, dot, underscore, or dash.' });

    const pending = await db
      .prepare(
        `SELECT name, password_hash, verify_code_hash, verify_expires_at, verify_attempts
           FROM pending_registrations WHERE email = ?`
      )
      .get(email);
    if (!pending) return res.status(404).json({ error: 'Start sign-up first.' });
    if (new Date(pending.verify_expires_at).getTime() < Date.now())
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    if (pending.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Resend a new code.' });
    const codeOk = await bcrypt.compare(code, pending.verify_code_hash);
    if (!codeOk) {
      await db
        .prepare('UPDATE pending_registrations SET verify_attempts = verify_attempts + 1 WHERE email = ?')
        .run(email);
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    const takenPrimary = await db.prepare('SELECT 1 AS ok FROM users WHERE email = ?').get(email);
    if (takenPrimary) {
      await db.prepare('DELETE FROM pending_registrations WHERE email = ?').run(email);
      return res.status(409).json({ error: 'That email is already registered.' });
    }
    const takenHandle = await db.prepare('SELECT 1 AS ok FROM user_aliases WHERE label = ?').get(handle);
    if (takenHandle) return res.status(409).json({ error: 'That nickname is already taken. Try another.' });

    // Create user + verified alias row (so the handle can log in immediately).
    const info = await db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, pending.name, pending.password_hash);
    const userId = info.lastInsertRowid;
    try {
      await db
        .prepare(
          `INSERT INTO user_aliases (user_id, email, label, verified, verified_at)
           VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
        )
        .run(userId, email, handle);
    } catch (e) {
      // Race on handle uniqueness — rollback the user we just created.
      await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'That nickname was just taken. Try another.' });
      throw e;
    }
    await db.prepare('DELETE FROM pending_registrations WHERE email = ?').run(email);
    const is_admin = await promoteIfConfigured(userId, email);
    const user = { id: userId, email, name: pending.name, is_admin: !!is_admin };
    res.json({ token: sign(user), user, handle });
  }
);

router.post(
  '/login',
  authLimiter,
  [
    body('email').isString().trim().isLength({ min: 1, max: 254 }),
    body('password').isString().isLength({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid credentials' });
    const { email, password } = req.body;
    const row = await resolveUserByEmail(email);
    if (!row) {
      await bcrypt.hash(password, 12); // timing equalization
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const is_admin = row.is_admin || (await promoteIfConfigured(row.id, row.email));
    const user = { id: row.id, email: row.email, name: row.name, is_admin: !!is_admin };
    res.json({ token: sign(user), user });
  }
);

export default router;
