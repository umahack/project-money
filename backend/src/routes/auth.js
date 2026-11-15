import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { adminEmails } from '../middleware/admin.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, slow down.' },
});

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

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
    const user = { id: info.lastInsertRowid, email, name, is_admin: !!is_admin };
    res.json({ token: sign(user), user });
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
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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
