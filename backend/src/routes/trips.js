import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

function ownTrip(userId, tripId) {
  return db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 60 }),
    body('destination').optional().isString().trim().isLength({ max: 80 }),
    body('budget').isFloat({ min: 0, max: 1e12 }),
    body('startDate').optional().isISO8601(),
    body('endDate').optional().isISO8601(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { name, destination = '', budget, startDate = null, endDate = null } = req.body;
    const info = db
      .prepare(
        'INSERT INTO trips (user_id, name, destination, budget, start_date, end_date) VALUES (?,?,?,?,?,?)'
      )
      .run(req.user.id, name, destination, Number(budget), startDate, endDate);
    res.json({ id: info.lastInsertRowid });
  }
);

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM trips WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ trips: rows });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const trip = ownTrip(req.user.id, id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const members = db.prepare('SELECT id, name, email FROM trip_members WHERE trip_id = ?').all(id);
  const expenses = db
    .prepare('SELECT id, payer, description, amount, split_json, created_at FROM trip_expenses WHERE trip_id = ? ORDER BY id DESC')
    .all(id)
    .map((e) => ({ ...e, split: JSON.parse(e.split_json), split_json: undefined }));
  res.json({ trip, members, expenses, settlement: settle(members, expenses) });
});

router.post(
  '/:id/members',
  [body('name').isString().trim().isLength({ min: 1, max: 40 }), body('email').optional().isEmail()],
  (req, res) => {
    const id = Number(req.params.id);
    if (!ownTrip(req.user.id, id)) return res.status(404).json({ error: 'Not found' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const info = db
        .prepare('INSERT INTO trip_members (trip_id, name, email) VALUES (?,?,?)')
        .run(id, req.body.name, req.body.email || null);
      res.json({ id: info.lastInsertRowid });
    } catch {
      res.status(409).json({ error: 'Member with that name exists' });
    }
  }
);

router.post(
  '/:id/expenses',
  [
    body('payer').isString().trim().isLength({ min: 1, max: 40 }),
    body('description').isString().trim().isLength({ min: 1, max: 100 }),
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('split').isArray({ min: 1 }),
  ],
  (req, res) => {
    const id = Number(req.params.id);
    if (!ownTrip(req.user.id, id)) return res.status(404).json({ error: 'Not found' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { payer, description, amount, split } = req.body;
    const clean = split
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({ name: String(s.name).slice(0, 40), share: Math.max(0, Number(s.share) || 0) }));
    if (!clean.length) return res.status(400).json({ error: 'Split required' });
    const info = db
      .prepare(
        'INSERT INTO trip_expenses (trip_id, payer, description, amount, split_json) VALUES (?,?,?,?,?)'
      )
      .run(id, payer, description, Number(amount), JSON.stringify(clean));
    res.json({ id: info.lastInsertRowid });
  }
);

function settle(members, expenses) {
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
  let i = 0,
    j = 0;
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
