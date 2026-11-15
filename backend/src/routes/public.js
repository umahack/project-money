import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import db from '../db/index.js';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Share-link read-only trip view. No auth; token must be exactly 32 hex chars.
 * Returns a sanitized shape — no owner id, no raw member emails leaked.
 */
router.get('/trips/:token', publicLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).json({ error: 'Not found' });
  const trip = await db
    .prepare(
      `SELECT id, name, destination, budget, start_date, end_date
         FROM trips
        WHERE public_token = ? AND public_enabled = 1`
    )
    .get(token);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const members = await db
    .prepare('SELECT id, name FROM trip_members WHERE trip_id = ?')
    .all(trip.id);
  const rawExpenses = await db
    .prepare(
      `SELECT id, payer, description, amount, split_json, created_at
         FROM trip_expenses WHERE trip_id = ? ORDER BY id DESC`
    )
    .all(trip.id);
  const expenses = rawExpenses.map((e) => ({
    id: e.id,
    payer: e.payer,
    description: e.description,
    amount: Number(e.amount),
    created_at: e.created_at,
    split: JSON.parse(e.split_json),
  }));
  const settlement = computeSettlement(members, expenses);
  res.json({ trip, members, expenses, settlement });
});

function computeSettlement(members, expenses) {
  const bal = {};
  for (const m of members) bal[m.name] = 0;
  for (const e of expenses) {
    const totalShare = e.split.reduce((a, b) => a + b.share, 0) || 1;
    bal[e.payer] = (bal[e.payer] || 0) + e.amount;
    for (const s of e.split) {
      bal[s.name] = (bal[s.name] || 0) - (e.amount * s.share) / totalShare;
    }
  }
  const creditors = [];
  const debtors = [];
  for (const [name, v] of Object.entries(bal)) {
    const rounded = Math.round(v * 100) / 100;
    if (rounded > 0.01) creditors.push({ name, amount: rounded });
    else if (rounded < -0.01) debtors.push({ name, amount: -rounded });
  }
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  const txns = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    txns.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(pay * 100) / 100 });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return { balances: bal, transactions: txns };
}

export default router;
