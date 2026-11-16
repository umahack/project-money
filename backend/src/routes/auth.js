import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { adminEmails } from '../middleware/admin.js';
import { authRequired } from '../middleware/auth.js';
import { audit } from '../audit.js';
import { createSingleSession, revokeSession } from '../sessions.js';
import { generateCode, hashCode, matches, expiresAt, isExpired, MAX_VERIFY_ATTEMPTS } from '../otp.js';
import { sendMail, registerVerifyEmail, emailChangeVerifyEmail } from '../mailer.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, slow down.' },
});

// Separate send-side limit so a bad actor can't burn through our Resend quota.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails requested. Try again later.' },
});

function sign(user, sid) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      is_admin: !!user.is_admin,
      tv: Number(user.token_version ?? 1),
      sid: Number(sid),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '30m' }
  );
}

// Per-account login throttle (in-memory). Not a replacement for the global IP
// rate-limiter — this blocks credential-stuffing against a single email even
// when attempts come from rotating IPs.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const loginAttempts = new Map(); // email -> { count, firstAt, lockedUntil }

function throttleKey(email) {
  return String(email || '').toLowerCase();
}
function isLocked(email) {
  const r = loginAttempts.get(throttleKey(email));
  if (!r?.lockedUntil) return false;
  if (Date.now() < r.lockedUntil) return true;
  loginAttempts.delete(throttleKey(email));
  return false;
}
function recordFail(email) {
  const k = throttleKey(email);
  const now = Date.now();
  const r = loginAttempts.get(k) || { count: 0, firstAt: now };
  if (now - r.firstAt > LOGIN_WINDOW_MS) { r.count = 0; r.firstAt = now; }
  r.count++;
  if (r.count >= LOGIN_MAX_FAILS) r.lockedUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(k, r);
}
function clearFails(email) { loginAttempts.delete(throttleKey(email)); }

async function promoteIfConfigured(userId, email) {
  const admins = adminEmails();
  const shouldBeAdmin = admins.has(String(email).toLowerCase()) ? 1 : 0;
  if (shouldBeAdmin) await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
  return shouldBeAdmin;
}

// Step 1: capture name/email/password, email a 6-digit code. We store the
// password hash immediately (bcrypt is CPU-heavy; nobody wants to re-run it
// after each code attempt) in a pending_registrations row — the real user
// is only created after the correct code lands in /register-finish.
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

    const pwHash = await bcrypt.hash(password, 12);
    const code = generateCode();
    const codeHash = await hashCode(code);
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
      .run(email, name.trim(), pwHash, codeHash, expiresAt());

    const { subject, text, html } = registerVerifyEmail(code, name);
    const result = await sendMail({ to: email, subject, text, html });
    res.json({ ok: true, email, mail: { sent: result.ok, fallback: !!result.fallback } });
  }
);

// Resend if the user never got the code (same send-limit applies).
router.post(
  '/register-resend',
  sendLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const { email } = req.body;
    const row = await db.prepare('SELECT name FROM pending_registrations WHERE email = ?').get(email);
    if (!row) return res.status(404).json({ error: 'Start sign-up first — we need your name and password.' });
    const code = generateCode();
    await db
      .prepare(
        `UPDATE pending_registrations SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0 WHERE email = ?`
      )
      .run(await hashCode(code), expiresAt(), email);
    const { subject, text, html } = registerVerifyEmail(code, row.name);
    const result = await sendMail({ to: email, subject, text, html });
    res.json({ ok: true, mail: { sent: result.ok, fallback: !!result.fallback } });
  }
);

// Step 2: verify code, create the real user, mint a session JWT.
router.post(
  '/register-finish',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('code').isString().matches(/^\d{6}$/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    const { email, code } = req.body;
    const pending = await db
      .prepare(
        `SELECT name, password_hash, verify_code_hash, verify_expires_at, verify_attempts
           FROM pending_registrations WHERE email = ?`
      )
      .get(email);
    if (!pending) return res.status(404).json({ error: 'Start sign-up first.' });
    if (isExpired(pending.verify_expires_at))
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    if (pending.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Resend a fresh code.' });
    const ok = await matches(code, pending.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE pending_registrations SET verify_attempts = verify_attempts + 1 WHERE email = ?')
        .run(email);
      return res.status(400).json({ error: 'Incorrect code.' });
    }
    const taken = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken) {
      await db.prepare('DELETE FROM pending_registrations WHERE email = ?').run(email);
      return res.status(409).json({ error: 'That email was just claimed. Please sign in.' });
    }
    const info = await db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, pending.name, pending.password_hash);
    await db.prepare('DELETE FROM pending_registrations WHERE email = ?').run(email);
    const is_admin = await promoteIfConfigured(info.lastInsertRowid, email);
    const user = {
      id: info.lastInsertRowid,
      email,
      name: pending.name,
      is_admin: !!is_admin,
      token_version: 1,
    };
    const sid = await createSingleSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      token: sign(user, sid),
      user: { id: user.id, email, name: pending.name, is_admin: !!is_admin },
    });
  }
);

router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').isString().isLength({ min: 1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid credentials' });
    const { email, password } = req.body;
    if (isLocked(email)) {
      return res
        .status(429)
        .json({ error: 'Too many failed sign-ins for this account. Please try again in a few minutes.' });
    }
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      await bcrypt.hash(password, 12); // timing equalization
      recordFail(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      recordFail(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    clearFails(email);
    const is_admin = row.is_admin || (await promoteIfConfigured(row.id, row.email));
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      is_admin: !!is_admin,
      token_version: Number(row.token_version ?? 1),
    };
    // Single-device policy: revoke every prior active session for this user,
    // then create a fresh one. The old device's next request returns 401
    // 'Signed out because this account was used on another device.'
    const sid = await createSingleSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      token: sign(user, sid),
      user: { id: user.id, email: user.email, name: user.name, is_admin: !!is_admin },
    });
  }
);

// ---------- Password change (authenticated) ----------
const pwChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password-change attempts, slow down.' },
});

router.post(
  '/password',
  authRequired,
  pwChangeLimiter,
  [
    body('currentPassword').isString().isLength({ min: 1 }),
    body('newPassword')
      .isString()
      .isLength({ min: 8, max: 128 })
      .withMessage('New password must be at least 8 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { currentPassword, newPassword } = req.body;
    if (currentPassword === newPassword)
      return res.status(400).json({ error: 'New password must be different from the current one.' });
    const row = await db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(req.user.id);
    if (!row) return res.status(401).json({ error: 'Session expired' });
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    const newHash = await bcrypt.hash(newPassword, 12);
    // Bump token_version + revoke every session except the one on this
    // request. We re-issue a fresh JWT on the current session so this
    // device stays signed in.
    await db
      .prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
      .run(newHash, req.user.id);
    await db
      .prepare(
        `UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP,
                revoked_reason = 'password_changed'
          WHERE user_id = ? AND id != ? AND revoked_at IS NULL`
      )
      .run(req.user.id, req.user.sid);
    const u = await db
      .prepare('SELECT id, email, name, is_admin, token_version FROM users WHERE id = ?')
      .get(req.user.id);
    await audit(req, { action: 'password.self_change' });
    res.json({
      ok: true,
      token: sign(u, req.user.sid),
      user: { id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin },
    });
  }
);

// ---------- Edit profile ----------
// Name updates immediately. Email changes go through /auth/email-change-* (OTP).
router.patch(
  '/profile',
  authRequired,
  [body('name').isString().trim().isLength({ min: 1, max: 60 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const name = String(req.body.name).trim();
    const current = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.user.id);
    if (!current) return res.status(401).json({ error: 'Session expired' });
    if (name === current.name) return res.json({ ok: true, unchanged: true });
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    const u = await db
      .prepare('SELECT id, email, name, is_admin, token_version FROM users WHERE id = ?')
      .get(req.user.id);
    await audit(req, { action: 'profile.update', details: `name "${current.name}" → "${name}"` });
    res.json({
      ok: true,
      token: sign(u, req.user.sid),
      user: { id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin },
    });
  }
);

// Step 1 of email change: email the new address a 6-digit code.
router.post(
  '/email-change-start',
  authRequired,
  sendLimiter,
  [body('newEmail').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const newEmail = String(req.body.newEmail).toLowerCase();
    const me = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (!me) return res.status(401).json({ error: 'Session expired' });
    if (newEmail === me.email) return res.status(400).json({ error: 'That is already your email.' });
    const taken = await db.prepare('SELECT id FROM users WHERE email = ?').get(newEmail);
    if (taken) return res.status(409).json({ error: 'That email is already in use.' });

    const code = generateCode();
    await db
      .prepare(
        `INSERT INTO pending_email_changes (user_id, new_email, verify_code_hash, verify_expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           new_email = excluded.new_email,
           verify_code_hash = excluded.verify_code_hash,
           verify_expires_at = excluded.verify_expires_at,
           verify_attempts = 0`
      )
      .run(req.user.id, newEmail, await hashCode(code), expiresAt());

    const { subject, text, html } = emailChangeVerifyEmail(code, me.email);
    const result = await sendMail({ to: newEmail, subject, text, html });
    res.json({ ok: true, newEmail, mail: { sent: result.ok, fallback: !!result.fallback } });
  }
);

// Step 2: verify code, swap the email, mint a fresh JWT.
router.post(
  '/email-change-confirm',
  authRequired,
  authLimiter,
  [body('code').isString().matches(/^\d{6}$/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    const row = await db
      .prepare(
        `SELECT new_email, verify_code_hash, verify_expires_at, verify_attempts
           FROM pending_email_changes WHERE user_id = ?`
      )
      .get(req.user.id);
    if (!row) return res.status(404).json({ error: 'No email change in progress.' });
    if (isExpired(row.verify_expires_at))
      return res.status(400).json({ error: 'Code expired. Start again.' });
    if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Start again.' });
    const ok = await matches(req.body.code, row.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE pending_email_changes SET verify_attempts = verify_attempts + 1 WHERE user_id = ?')
        .run(req.user.id);
      return res.status(400).json({ error: 'Incorrect code.' });
    }
    // Race-check: did someone else grab this email during the 15-min window?
    const taken = await db
      .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .get(row.new_email, req.user.id);
    if (taken) {
      await db.prepare('DELETE FROM pending_email_changes WHERE user_id = ?').run(req.user.id);
      return res.status(409).json({ error: 'That email was just taken. Start again with a different address.' });
    }
    const current = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.new_email, req.user.id);
    await db.prepare('DELETE FROM pending_email_changes WHERE user_id = ?').run(req.user.id);
    const u = await db
      .prepare('SELECT id, email, name, is_admin, token_version FROM users WHERE id = ?')
      .get(req.user.id);
    await audit(req, { action: 'profile.email_change', details: `${current?.email} → ${row.new_email}` });
    res.json({
      ok: true,
      token: sign(u, req.user.sid),
      user: { id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin },
    });
  }
);

// Read current pending email change (for the UI to show it after a refresh).
router.get('/email-change-pending', authRequired, async (req, res) => {
  const row = await db
    .prepare('SELECT new_email, verify_expires_at FROM pending_email_changes WHERE user_id = ?')
    .get(req.user.id);
  res.json({ pending: row ? { newEmail: row.new_email, expires_at: row.verify_expires_at } : null });
});

// Cancel an in-flight email change.
router.delete('/email-change-pending', authRequired, async (req, res) => {
  await db.prepare('DELETE FROM pending_email_changes WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- Session refresh ----------
// authRequired already validated the token + session row; we just mint a new
// JWT so the client's 30-min window slides forward. Used by the "stay signed
// in" prompt that fires at the 25-min mark.
router.post('/refresh', authRequired, async (req, res) => {
  const u = await db
    .prepare('SELECT id, email, name, is_admin, token_version FROM users WHERE id = ?')
    .get(req.user.id);
  if (!u) return res.status(401).json({ error: 'Session expired' });
  res.json({
    token: sign(u, req.user.sid),
    user: { id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin },
  });
});

// ---------- Device sessions ----------
router.get('/sessions', authRequired, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, device_label, user_agent, created_at, last_seen_at, revoked_at, revoked_reason
         FROM sessions
        WHERE user_id = ?
        ORDER BY (revoked_at IS NULL) DESC, id DESC
        LIMIT 25`
    )
    .all(req.user.id);
  res.json({
    current_sid: req.user.sid,
    sessions: rows.map((r) => ({ ...r, revoked: !!r.revoked_at })),
  });
});

router.delete('/sessions/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  // Only the owning user can revoke; admins intentionally cannot force-quit
  // other users' sessions here.
  const ok = await revokeSession(req.user.id, id, 'user_revoked');
  if (!ok) return res.status(404).json({ error: 'Session not found or already revoked' });
  res.json({ ok: true });
});

router.delete('/sessions', authRequired, async (req, res) => {
  // "Sign out everywhere else" — keeps the current session alive.
  await db
    .prepare(
      `UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'user_signed_out_all'
        WHERE user_id = ? AND id != ? AND revoked_at IS NULL`
    )
    .run(req.user.id, req.user.sid);
  res.json({ ok: true });
});

export default router;
