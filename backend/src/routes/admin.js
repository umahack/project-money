import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { adminRequired } from '../middleware/admin.js';

const router = Router();
router.use(authRequired, adminRequired);

router.get('/users', (req, res) => {
  const rows = db
    .prepare(
      `SELECT
        u.id, u.email, u.name, u.is_admin, u.created_at,
        (SELECT amount FROM salary_entries WHERE user_id = u.id ORDER BY month DESC LIMIT 1) AS latest_salary,
        (SELECT COALESCE(SUM(amount),0) FROM emis WHERE user_id = u.id) AS emi_total,
        (SELECT COUNT(*) FROM trips WHERE user_id = u.id) AS trip_count
       FROM users u
       ORDER BY u.id DESC`
    )
    .all();
  res.json({ users: rows });
});

router.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const salaries = db.prepare('SELECT month, amount FROM salary_entries WHERE user_id = ? ORDER BY month DESC').all(id);
  const emis = db.prepare('SELECT id, label, amount, category, created_at FROM emis WHERE user_id = ? ORDER BY id DESC').all(id);
  const trips = db.prepare('SELECT id, name, destination, budget, start_date, end_date FROM trips WHERE user_id = ? ORDER BY id DESC').all(id);
  res.json({ user, salaries, emis, trips });
});

router.put(
  '/users/:id/salary',
  [body('amount').isFloat({ min: 0, max: 1e12 }), body('month').matches(/^\d{4}-\d{2}$/)],
  (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
    db.prepare(
      `INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)
       ON CONFLICT(user_id, month) DO UPDATE SET amount=excluded.amount`
    ).run(id, req.body.month, Number(req.body.amount));
    res.json({ ok: true });
  }
);

router.put('/users/:id/admin', [body('is_admin').isBoolean()], (req, res) => {
  const id = Number(req.params.id);
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot demote yourself' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, id);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/emis/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM emis WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/trips/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM trips WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/feedback', (_req, res) => {
  const rows = db
    .prepare('SELECT id, user_id, email, rating, message, created_at FROM feedback ORDER BY id DESC LIMIT 500')
    .all();
  res.json({ feedback: rows });
});

router.delete('/feedback/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/stats', (_req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    admins: db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c,
    trips: db.prepare('SELECT COUNT(*) AS c FROM trips').get().c,
    emis: db.prepare('SELECT COUNT(*) AS c FROM emis').get().c,
    total_income: db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM salary_entries').get().s,
    total_emi: db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM emis').get().s,
    feedback_count: db.prepare('SELECT COUNT(*) AS c FROM feedback').get().c,
    avg_rating:
      db.prepare('SELECT ROUND(AVG(rating), 2) AS a FROM feedback').get().a ?? null,
  };
  res.json(stats);
});

export default router;
