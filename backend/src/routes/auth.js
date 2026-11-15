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

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, slow down.' },
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

router.post(
  '/register',
  authLimiter,
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
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const info = await db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name, hash);
    const is_admin = await promoteIfConfigured(info.lastInsertRowid, email);
    const user = { id: info.lastInsertRowid, email, name, is_admin: !!is_admin, token_version: 1 };
    const sid = await createSingleSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      token: sign(user, sid),
      user: { id: user.id, email, name, is_admin: !!is_admin },
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
