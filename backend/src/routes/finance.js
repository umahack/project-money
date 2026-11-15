import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

router.post(
  '/salary',
  [
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('month').optional().matches(/^\d{4}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const month = req.body.month || monthKey();
    const amount = Number(req.body.amount);
    await db
      .prepare(
        `INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)
         ON CONFLICT(user_id, month) DO UPDATE SET amount=excluded.amount`
      )
      .run(req.user.id, month, amount);
    res.json({ ok: true, month, amount });
  }
);

router.get('/salary', async (req, res) => {
  const row = await db
    .prepare('SELECT month, amount FROM salary_entries WHERE user_id = ? ORDER BY month DESC LIMIT 1')
    .get(req.user.id);
  res.json({ salary: row || null });
});

router.post(
  '/emis',
  [
    body('label').isString().trim().isLength({ min: 1, max: 60 }),
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('category').isIn(['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { label, amount, category } = req.body;
    const info = await db
      .prepare('INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)')
      .run(req.user.id, label, Number(amount), category);
    res.json({ id: info.lastInsertRowid });
  }
);

router.get('/emis', async (req, res) => {
  const rows = await db
    .prepare('SELECT id, label, amount, category FROM emis WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ emis: rows });
});

router.delete('/emis/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  await db.prepare('DELETE FROM emis WHERE id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ ok: true });
});

router.get('/plan', async (req, res) => {
  const salary = await db
    .prepare('SELECT amount FROM salary_entries WHERE user_id = ? ORDER BY month DESC LIMIT 1')
    .get(req.user.id);
  const emiRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS total FROM emis WHERE user_id = ?')
    .get(req.user.id);
  const emiTotal = Number(emiRow.total || 0);
  const income = Number(salary?.amount || 0);
  const afterFixed = Math.max(income - emiTotal, 0);
  const needs = Math.round(afterFixed * 0.5);
  const wants = Math.round(afterFixed * 0.3);
  const save = afterFixed - needs - wants;
  const tips = [];
  if (emiTotal / Math.max(income, 1) > 0.4)
    tips.push('Your fixed obligations exceed 40% of income — consider refinancing EMIs or renegotiating rent.');
  if (save / Math.max(income, 1) < 0.2 && income > 0)
    tips.push('Target saving at least 20% of take-home. Automate a transfer on salary day.');
  if (income > 0 && emiTotal === 0)
    tips.push('No EMIs — great! Add a monthly SIP into index funds to make the surplus work for you.');
  tips.push('Keep an emergency fund of 6 months of fixed expenses in a liquid account.');
  res.json({
    income,
    emiTotal,
    afterFixed,
    breakdown: { needs, wants, save },
    tips,
  });
});

export default router;
