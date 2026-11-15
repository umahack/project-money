import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/',
  authRequired,
  limiter,
  [
    body('rating').isInt({ min: 1, max: 5 }),
    body('message').optional().isString().isLength({ max: 2000 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const info = db
      .prepare('INSERT INTO feedback (user_id, email, rating, message) VALUES (?, ?, ?, ?)')
      .run(req.user.id, req.user.email, Number(req.body.rating), req.body.message?.trim() || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  }
);

export default router;
