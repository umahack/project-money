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
/**
 * The currently-active banner, if any. No auth so the login page can show it.
 * Response: { announcement: { id, message, kind } | null }
 */
router.get('/announcement', publicLimiter, async (_req, res) => {
  const row = await db
    .prepare('SELECT id, message, kind FROM announcements WHERE is_active = 1 ORDER BY id DESC LIMIT 1')
    .get();
  res.json({ announcement: row || null });
});

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
  const memberNames = new Set();
  for (const m of members) {
    bal[m.name] = 0;
    memberNames.add(m.name);
  }
  for (const e of expenses) {
    const totalShare = e.split.reduce((a, b) => a + Math.max(0, Number(b.share) || 0), 0);
    if (!(e.amount > 0) || totalShare <= 0) continue;
    if (!memberNames.has(e.payer)) continue;
    bal[e.payer] += e.amount;
    for (const s of e.split) {
      if (!memberNames.has(s.name)) continue;
      const share = Math.max(0, Number(s.share) || 0);
      if (share <= 0) continue;
      bal[s.name] -= (e.amount * share) / totalShare;
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
