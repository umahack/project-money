import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { adminEmails } from '../middleware/admin.js';
import { authRequired } from '../middleware/auth.js';
import { audit } from '../audit.js';
import { createSession, revokeSession } from '../sessions.js';
import { generateCode, hashCode, matches, expiresAt, isExpired, MAX_VERIFY_ATTEMPTS } from '../otp.js';
import {
  sendMail,
  registerVerifyEmail,
  emailChangeVerifyEmail,
  passwordResetEmail,
  alreadyRegisteredEmail,
} from '../mailer.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, slow down.' },
});

// Two layered caps so an attacker can't burn Resend quota:
//   sendLimiter      — 8/hr per destination email
//   sendIpLimiter    — 20/hr per source IP (bounded regardless of how many
//                      different emails they try)
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails requested. Try again later.' },
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return email || `ip:${req.ip || 'unknown'}`;
  },
});
const sendIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't burn tokens on 4xx responses (bad email syntax, missing fields).
  // Only count hits that reached handler logic.
  skipFailedRequests: true,
  message: { error: 'Too many requests from this network. Try again later.' },
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

// Shared password-strength check applied anywhere a NEW password is set
// (register, change-password, reset-password-finish). Mirrors the frontend
// rules in frontend/src/passwordRules.ts so a password that passed the UI
// doesn't get rejected by the server, and vice versa.
function isStrongPassword(p) {
  if (typeof p !== 'string') return false;
  if (p.length < 8 || p.length > 128) return false;
  if (!/[A-Za-z]/.test(p)) return false;
  if (!/\d/.test(p)) return false;
  if (p !== p.trim()) return false;
  return true;
}
const STRONG_PW_MSG = 'Password needs 8+ characters, a letter, a number, and no leading or trailing spaces.';

/**
 * Opportunistic purge of expired pending-OTP rows across the three tables.
 * Called at the top of every OTP-start handler so abandoned signups don't
 * accumulate PII + bcrypt hashes indefinitely. Idempotent and fast — a few
 * ms, bounded by expired-row count. We don't block the request on failure.
 */
async function sweepExpiredPending() {
  try {
    await Promise.all([
      db.prepare('DELETE FROM pending_registrations WHERE verify_expires_at < ?').run(new Date().toISOString()),
      db.prepare('DELETE FROM pending_email_changes WHERE verify_expires_at < ?').run(new Date().toISOString()),
      db.prepare('DELETE FROM pending_password_resets WHERE verify_expires_at < ?').run(new Date().toISOString()),
    ]);
  } catch (e) {
    console.error('[pending-sweep] skipped:', e?.message);
  }
}

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
  sendIpLimiter,
  sendLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('name').isString().trim().isLength({ min: 1, max: 60 }),
    body('password').custom((v) => isStrongPassword(v)).withMessage(STRONG_PW_MSG),
  ],
  async (req, res) => {
    await sweepExpiredPending();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { email, name, password } = req.body;
    const existing = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    // Constant-shape response regardless of whether the account exists — don't
    // give unauthenticated clients an enumeration oracle. We ALWAYS run bcrypt
    // to flatten the timing side-channel too.
    const pwHash = await bcrypt.hash(password, 12);
    if (existing) {
      const { subject, text, html } = alreadyRegisteredEmail(existing.name);
      await sendMail({ to: email, subject, text, html });
    } else {
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
      await sendMail({ to: email, subject, text, html });
    }
    res.json({ ok: true, email, mail: { sent: true, fallback: false } });
  }
);

// Resend if the user never got the code (same send-limit applies).
router.post(
  '/register-resend',
  sendIpLimiter,
  sendLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    await sweepExpiredPending();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const { email } = req.body;
    const row = await db.prepare('SELECT name FROM pending_registrations WHERE email = ?').get(email);
    // Constant response regardless of whether a pending row exists, to avoid
    // leaking account existence via the resend endpoint.
    if (row) {
      const code = generateCode();
      await db
        .prepare(
          `UPDATE pending_registrations SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0 WHERE email = ?`
        )
        .run(await hashCode(code), expiresAt(), email);
      const { subject, text, html } = registerVerifyEmail(code, row.name);
      await sendMail({ to: email, subject, text, html });
    }
    res.json({ ok: true, mail: { sent: true, fallback: false } });
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
    // Collapse "no pending row" and "wrong code" into the same error to avoid
    // leaking whether the email is already a real account.
    const GENERIC_BAD = 'Invalid or expired code. Please start sign-up again.';
    if (!pending) return res.status(400).json({ error: GENERIC_BAD });
    if (isExpired(pending.verify_expires_at))
      return res.status(400).json({ error: GENERIC_BAD });
    if (pending.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Request a fresh code.' });
    const ok = await matches(code, pending.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE pending_registrations SET verify_attempts = verify_attempts + 1 WHERE email = ?')
        .run(email);
      return res.status(400).json({ error: GENERIC_BAD });
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
    const sid = await createSession(user.id, {
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
    // Up to 3 concurrent devices per account. If this login would push the
    // active count above the cap, the oldest session is revoked and that
    // device's next request returns 401 with the 'another_device' message.
    const sid = await createSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      token: sign(user, sid),
      user: { id: user.id, email: user.email, name: user.name, is_admin: !!is_admin },
    });
  }
);

// ---------- Forgot password (unauthenticated) ----------
// Step 1 — ask for a reset code. We ALWAYS return 200 regardless of whether
// the email is on file, so this endpoint does not reveal account existence.
router.post(
  '/password-reset-start',
  sendIpLimiter,
  sendLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    await sweepExpiredPending();
    const errors = validationResult(req);
    // Even on validation failure, return a generic ok to avoid probing. The
    // UI treats a bad email client-side anyway.
    if (!errors.isEmpty()) return res.json({ ok: true });
    const email = String(req.body.email).toLowerCase();
    const user = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    // Always hash a code and run bcrypt, even if the account doesn't exist,
    // to keep response-time similar for the two branches (no timing oracle).
    const code = generateCode();
    const codeHash = await hashCode(code);
    if (user) {
      await db
        .prepare(
          `INSERT INTO pending_password_resets (email, verify_code_hash, verify_expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             verify_code_hash = excluded.verify_code_hash,
             verify_expires_at = excluded.verify_expires_at,
             verify_attempts = 0,
             created_at = CURRENT_TIMESTAMP`
        )
        .run(email, codeHash, expiresAt());
      const { subject, text, html } = passwordResetEmail(code, user.name);
      await sendMail({ to: email, subject, text, html });
    }
    // Always ok. Caller shows "If that email is on file, a code is on the way."
    res.json({ ok: true });
  }
);

// Step 2 — verify code and set the new password. Bumps token_version and
// revokes every existing session for that user (nothing is signed in here).
// Per-email finish limiter — tracks wrong attempts regardless of whether a
// pending reset row exists, so an attacker can't tell "no account" (400) from
// "account exists but still has attempts left" by response pattern.
const resetFinishLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MAX_VERIFY_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `pwr:${email || `ip:${req.ip || 'unknown'}`}`;
  },
  message: { error: 'Too many attempts. Start again.' },
});

router.post(
  '/password-reset-finish',
  authLimiter,
  resetFinishLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isString().matches(/^\d{6}$/),
    body('newPassword').custom((v) => isStrongPassword(v)).withMessage(STRONG_PW_MSG),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request' });
    const { email, code, newPassword } = req.body;
    const pending = await db
      .prepare(
        `SELECT verify_code_hash, verify_expires_at, verify_attempts
           FROM pending_password_resets WHERE email = ?`
      )
      .get(String(email).toLowerCase());
    // Keep the error generic so a wrong email vs wrong code are indistinguishable.
    if (!pending) return res.status(400).json({ error: 'Invalid or expired code. Start again.' });
    if (isExpired(pending.verify_expires_at))
      return res.status(400).json({ error: 'Code expired. Start again.' });
    if (pending.verify_attempts >= MAX_VERIFY_ATTEMPTS)
      return res.status(429).json({ error: 'Too many wrong attempts. Start again.' });
    const ok = await matches(code, pending.verify_code_hash);
    if (!ok) {
      await db
        .prepare('UPDATE pending_password_resets SET verify_attempts = verify_attempts + 1 WHERE email = ?')
        .run(String(email).toLowerCase());
      return res.status(400).json({ error: 'Incorrect code.' });
    }
    const user = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(String(email).toLowerCase());
    if (!user) return res.status(400).json({ error: 'Invalid or expired code. Start again.' });
    const newHash = await bcrypt.hash(newPassword, 12);
    await db
      .prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
      .run(newHash, user.id);
    await db
      .prepare(
        `UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP,
                revoked_reason = 'password_reset'
          WHERE user_id = ? AND revoked_at IS NULL`
      )
      .run(user.id);
    await db.prepare('DELETE FROM pending_password_resets WHERE email = ?').run(String(email).toLowerCase());
    await audit(req, { action: 'password.reset', details: `email=${String(email).toLowerCase()}` });
    clearFails(email);
    res.json({ ok: true });
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
    body('newPassword').custom((v) => isStrongPassword(v)).withMessage(STRONG_PW_MSG),
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
    // Keep trip members & expense payer strings in sync with the new name so
    // the user doesn't silently vanish from trip balances. Updates only this
    // user's own `trip_members` rows (user_id-scoped) and the payer field on
    // trips they are a member of where the string still matches the old name.
    try {
      await db
        .prepare('UPDATE trip_members SET name = ? WHERE user_id = ? AND name = ?')
        .run(name, req.user.id, current.name);
      await db
        .prepare(
          `UPDATE trip_expenses SET payer = ?
             WHERE payer = ? AND trip_id IN (
               SELECT trip_id FROM trip_members WHERE user_id = ?
             )`
        )
        .run(name, current.name, req.user.id);
    } catch (e) {
      console.error('[profile.rename-sync] skipped:', e?.message);
    }
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

// Tight per-user cap so an authenticated attacker can't use /email-change-start
// as an enumeration oracle — 3 starts/hour/user. sendLimiter still runs for
// quota control, keyed by the destination email.
const emailChangeStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `uid:${req.user?.id ?? req.ip ?? 'unknown'}`,
  message: { error: 'Too many email change attempts. Try again in an hour.' },
});

// Step 1 of email change: email the new address a 6-digit code.
router.post(
  '/email-change-start',
  authRequired,
  emailChangeStartLimiter,
  sendIpLimiter,
  sendLimiter,
  [body('newEmail').isEmail().normalizeEmail()],
  async (req, res) => {
    await sweepExpiredPending();
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email' });
    const newEmail = String(req.body.newEmail).toLowerCase();
    const me = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (!me) return res.status(401).json({ error: 'Session expired' });
    if (newEmail === me.email) return res.status(400).json({ error: 'That is already your email.' });
    const taken = await db.prepare('SELECT id FROM users WHERE email = ?').get(newEmail);
    // Constant-shape response: whether the target address is taken or not we
    // return the same payload. If taken, we silently skip creating the pending
    // row and skip the OTP send — the attacker learns nothing from the HTTP
    // response. The tight per-user limiter caps probing to 3/hour.
    if (!taken) {
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
      await sendMail({ to: newEmail, subject, text, html });
    }
    res.json({ ok: true, newEmail, mail: { sent: true, fallback: false } });
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
    // Clear the pending row FIRST — if the UPDATE then fails, the user can
    // retry the whole flow without being blocked by a surviving pending row.
    // The caller already proved they owned the code; a transient DB blip
    // shouldn't cost them access to their own email-change feature.
    await db.prepare('DELETE FROM pending_email_changes WHERE user_id = ?').run(req.user.id);
    // Treat email change as a strong account-change event — bump token_version
    // to invalidate every other active session, and revoke other sessions so
    // the user is kicked out of any device still signed in with the old email.
    await db
      .prepare('UPDATE users SET email = ?, token_version = token_version + 1 WHERE id = ?')
      .run(row.new_email, req.user.id);
    await db
      .prepare(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'email_changed'
          WHERE user_id = ? AND id != ? AND revoked_at IS NULL`
      )
      .run(req.user.id, req.user.sid);
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

// ---------- Account export & delete ----------
// Return every row this user owns as a single JSON blob. The client offers it
// as a download. Trip data where the user is a member (not owner) is included.
router.get('/export', authRequired, async (req, res) => {
  const uid = req.user.id;
  const user = await db
    .prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?')
    .get(uid);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  const [
    salary,
    emis,
    expenses,
    categoryBudgets,
    recurring,
    goals,
    userCategories,
    sessions,
    tripsOwned,
    tripMemberships,
    feedback,
  ] = await Promise.all([
    db.prepare('SELECT * FROM salary_entries WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM emis WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM expense_log WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM category_budgets WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM recurring_expenses WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM savings_goals WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM user_categories WHERE user_id = ?').all(uid),
    db.prepare('SELECT id, device_label, created_at, last_seen_at, revoked_at, revoked_reason FROM sessions WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM trips WHERE user_id = ?').all(uid),
    db.prepare('SELECT * FROM trip_members WHERE user_id = ?').all(uid),
    db.prepare('SELECT id, rating, message, created_at FROM feedback WHERE user_id = ?').all(uid),
  ]);
  res.setHeader('Content-Disposition', `attachment; filename="project-money-${uid}-${Date.now()}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    user,
    data: {
      salary_entries: salary,
      emis,
      expenses,
      category_budgets: categoryBudgets,
      recurring_expenses: recurring,
      savings_goals: goals,
      user_categories: userCategories,
      sessions,
      trips_owned: tripsOwned,
      trip_memberships: tripMemberships,
      feedback,
    },
  });
});

// Delete the account. Requires currentPassword as a confirmation. Cascading FK
// cleans up every user-owned row; trips/feedback/visits/audit set user to NULL
// (we keep them for aggregates and admin history, now orphaned).
router.delete(
  '/account',
  authRequired,
  authLimiter,
  [body('currentPassword').isString().isLength({ min: 1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Password required to delete account.' });
    const row = await db
      .prepare('SELECT email, password_hash, is_admin FROM users WHERE id = ?')
      .get(req.user.id);
    if (!row) return res.status(401).json({ error: 'Session expired' });
    const ok = await bcrypt.compare(req.body.currentPassword, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Password is incorrect.' });
    // Protect the system from an admin deleting themselves and leaving no
    // one who can manage it. Mirrors the guard in /admin/users/:id.
    if (row.is_admin) {
      const admins = await db
        .prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')
        .get();
      if (Number(admins.n ?? 0) <= 1) {
        return res.status(400).json({
          error: 'You are the last admin. Promote another user before deleting this account.',
        });
      }
    }
    const uid = req.user.id;
    // Explicit cleanup (don't rely on PRAGMA foreign_keys being on).
    const tx = [
      // trip_expenses rows reference the payer by name string, not user_id,
      // so there is nothing to delete directly here. They are rolled up when
      // the parent trip is deleted below via ON DELETE CASCADE.
      ['DELETE FROM trip_members WHERE user_id = ?', [uid]],
      ['DELETE FROM trip_invites WHERE inviter_id = ? OR invitee_id = ?', [uid, uid]],
      // trips.user_id uses ON DELETE SET NULL; we also delete trips the user owned
      // outright to avoid leaving ownerless trips cluttering the DB.
      ['DELETE FROM trips WHERE user_id = ?', [uid]],
      ['DELETE FROM salary_entries WHERE user_id = ?', [uid]],
      ['DELETE FROM emis WHERE user_id = ?', [uid]],
      ['DELETE FROM expense_log WHERE user_id = ?', [uid]],
      ['DELETE FROM category_budgets WHERE user_id = ?', [uid]],
      ['DELETE FROM recurring_expenses WHERE user_id = ?', [uid]],
      ['DELETE FROM savings_goals WHERE user_id = ?', [uid]],
      ['DELETE FROM user_categories WHERE user_id = ?', [uid]],
      ['DELETE FROM user_aliases WHERE user_id = ?', [uid]],
      ['DELETE FROM sessions WHERE user_id = ?', [uid]],
      ['DELETE FROM pending_email_changes WHERE user_id = ?', [uid]],
      ['DELETE FROM pending_registrations WHERE email = ?', [row.email]],
      ['DELETE FROM pending_password_resets WHERE email = ?', [row.email]],
      ['UPDATE feedback SET user_id = NULL WHERE user_id = ?', [uid]],
      ['UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?', [uid]],
      ['UPDATE visits SET user_id = NULL WHERE user_id = ?', [uid]],
      ['DELETE FROM users WHERE id = ?', [uid]],
    ];
    for (const [sql, args] of tx) {
      await db.prepare(sql).run(...args);
    }
    await audit(req, { action: 'account.self_delete', details: `email=${row.email}` });
    res.json({ ok: true });
  }
);

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
