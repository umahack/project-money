import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { adminRequired } from '../middleware/admin.js';
import { audit } from '../audit.js';

const router = Router();
router.use(authRequired, adminRequired);

router.get('/users', async (_req, res) => {
  const rows = await db
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

router.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const user = await db
    .prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?')
    .get(id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const salaries = await db
    .prepare('SELECT month, amount FROM salary_entries WHERE user_id = ? ORDER BY month DESC')
    .all(id);
  const emis = await db
    .prepare('SELECT id, label, amount, category, created_at FROM emis WHERE user_id = ? ORDER BY id DESC')
    .all(id);
  const trips = await db
    .prepare('SELECT id, name, destination, budget, start_date, end_date FROM trips WHERE user_id = ? ORDER BY id DESC')
    .all(id);
  res.json({ user, salaries, emis, trips });
});

router.put(
  '/users/:id/salary',
  [body('amount').isFloat({ min: 0, max: 1e12 }), body('month').matches(/^\d{4}-\d{2}$/)],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const exists = await db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    await db
      .prepare(
        `INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)
         ON CONFLICT(user_id, month) DO UPDATE SET amount=excluded.amount`
      )
      .run(id, req.body.month, Number(req.body.amount));
    res.json({ ok: true });
  }
);

router.put(
  '/users/:id/password',
  [body('newPassword').isString().isLength({ min: 8, max: 128 })],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const bcrypt = (await import('bcrypt')).default;
    const hash = await bcrypt.hash(req.body.newPassword, 12);
    // Bump token_version to boot anyone currently signed into this account.
    await db
      .prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
      .run(hash, id);
    await audit(req, { action: 'admin.password_reset', target: `user:${id}` });
    res.json({ ok: true });
  }
);

router.put('/users/:id/admin', [body('is_admin').isBoolean()], async (req, res) => {
  const id = Number(req.params.id);
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot demote yourself' });
  const exists = await db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, id);
  await audit(req, {
    action: req.body.is_admin ? 'admin.promote' : 'admin.demote',
    target: `user:${id}`,
  });
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const info = await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  await audit(req, { action: 'admin.user_delete', target: `user:${id}` });
  res.json({ ok: true });
});

router.delete('/emis/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db.prepare('DELETE FROM emis WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/trips/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db.prepare('DELETE FROM trips WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/feedback', async (_req, res) => {
  const rows = await db
    .prepare('SELECT id, user_id, email, rating, message, created_at FROM feedback ORDER BY id DESC LIMIT 500')
    .all();
  res.json({ feedback: rows });
});

router.delete('/feedback/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/audit', async (_req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, actor_id, actor_email, action, target, details, created_at
         FROM audit_log ORDER BY id DESC LIMIT 200`
    )
    .all();
  res.json({ audit: rows });
});

router.get('/visits/stats', async (_req, res) => {
  const total = Number((await db.prepare('SELECT COUNT(*) AS c FROM visits').get()).c);
  const uniqueVisitors = Number(
    (await db.prepare('SELECT COUNT(DISTINCT ip_hash) AS c FROM visits').get()).c
  );
  const uniqueToday = Number(
    (
      await db
        .prepare(
          "SELECT COUNT(DISTINCT ip_hash) AS c FROM visits WHERE substr(created_at, 1, 10) = date('now')"
        )
        .get()
    ).c
  );
  const todayVisits = Number(
    (
      await db
        .prepare("SELECT COUNT(*) AS c FROM visits WHERE substr(created_at, 1, 10) = date('now')")
        .get()
    ).c
  );
  const perDayRows = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS visits,
              COUNT(DISTINCT ip_hash) AS visitors
         FROM visits
        WHERE created_at >= date('now', '-13 days')
        GROUP BY day
        ORDER BY day ASC`
    )
    .all();
  const topPaths = await db
    .prepare(
      `SELECT path, COUNT(*) AS c FROM visits
        GROUP BY path ORDER BY c DESC LIMIT 10`
    )
    .all();
  const latest = await db
    .prepare(
      `SELECT v.path, v.user_agent, v.created_at, u.email, u.name
         FROM visits v
         LEFT JOIN users u ON u.id = v.user_id
         ORDER BY v.id DESC LIMIT 25`
    )
    .all();
  res.json({
    total,
    unique_visitors: uniqueVisitors,
    today_visits: todayVisits,
    today_visitors: uniqueToday,
    per_day: perDayRows.map((r) => ({ ...r, visits: Number(r.visits), visitors: Number(r.visitors) })),
    top_paths: topPaths.map((r) => ({ path: r.path, count: Number(r.c) })),
    latest,
  });
});

router.get('/stats', async (_req, res) => {
  const [users, admins, trips, emis, income, emi, feedback, rating] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM users').get(),
    db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get(),
    db.prepare('SELECT COUNT(*) AS c FROM trips').get(),
    db.prepare('SELECT COUNT(*) AS c FROM emis').get(),
    db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM salary_entries').get(),
    db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM emis').get(),
    db.prepare('SELECT COUNT(*) AS c FROM feedback').get(),
    db.prepare('SELECT ROUND(AVG(rating), 2) AS a FROM feedback').get(),
  ]);
  res.json({
    users: Number(users.c),
    admins: Number(admins.c),
    trips: Number(trips.c),
    emis: Number(emis.c),
    total_income: Number(income.s),
    total_emi: Number(emi.s),
    feedback_count: Number(feedback.c),
    avg_rating: rating.a ?? null,
  });
});

export default router;
