import { Router } from 'express';
import crypto from 'node:crypto';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

async function ownTrip(userId, tripId) {
  return db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

// Access includes trips the user owns OR is an accepted member of.
async function accessTrip(userId, tripId) {
  const trip = await db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return null;
  if (trip.user_id === userId) return { trip, role: 'owner' };
  const member = await db
    .prepare('SELECT 1 AS ok FROM trip_members WHERE trip_id = ? AND user_id = ?')
    .get(tripId, userId);
  return member ? { trip, role: 'member' } : null;
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
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { name, destination = '', budget, startDate = null, endDate = null } = req.body;
    const info = await db
      .prepare(
        'INSERT INTO trips (user_id, name, destination, budget, start_date, end_date) VALUES (?,?,?,?,?,?)'
      )
      .run(req.user.id, name, destination, Number(budget), startDate, endDate);
    const tripId = info.lastInsertRowid;

    // Add the trip owner as a member so they show up in splits and the member list.
    const me = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
    const base = (me?.name || me?.email?.split('@')[0] || 'Owner').trim().slice(0, 40);
    try {
      await db
        .prepare('INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)')
        .run(tripId, req.user.id, base, me?.email || null);
    } catch { /* ignore if a race adds them first */ }

    res.json({ id: tripId });
  }
);

router.get('/', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT t.* , CASE WHEN t.user_id = ? THEN 'owner' ELSE 'member' END AS role
       FROM trips t
       WHERE t.user_id = ?
          OR t.id IN (SELECT trip_id FROM trip_members WHERE user_id = ?)
       ORDER BY t.id DESC`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ trips: rows });
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const access = await accessTrip(req.user.id, id);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const members = await db
    .prepare('SELECT id, name, email FROM trip_members WHERE trip_id = ?')
    .all(id);
  const rawExpenses = await db
    .prepare(
      'SELECT id, payer, description, amount, split_json, created_at FROM trip_expenses WHERE trip_id = ? ORDER BY id DESC'
    )
    .all(id);
  const expenses = rawExpenses.map((e) => ({ ...e, split: JSON.parse(e.split_json), split_json: undefined }));
  res.json({
    trip: access.trip,
    role: access.role,
    members,
    expenses,
    settlement: settle(members, expenses),
  });
});

router.post(
  '/:id/members',
  [body('name').isString().trim().isLength({ min: 1, max: 40 }), body('email').optional().isEmail()],
  async (req, res) => {
    const id = Number(req.params.id);
    if (!(await accessTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const info = await db
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
  async (req, res) => {
    const id = Number(req.params.id);
    if (!(await accessTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { payer, description, amount, split } = req.body;
    const clean = split
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({ name: String(s.name).slice(0, 40), share: Math.max(0, Number(s.share) || 0) }));
    if (!clean.length) return res.status(400).json({ error: 'Split required' });
    const info = await db
      .prepare(
        'INSERT INTO trip_expenses (trip_id, payer, description, amount, split_json) VALUES (?,?,?,?,?)'
      )
      .run(id, payer, description, Number(amount), JSON.stringify(clean));
    res.json({ id: info.lastInsertRowid });
  }
);

function settle(members, expenses) {
  const bal = {};
  const memberNames = new Set();
  for (const m of members) {
    bal[m.name] = 0;
    memberNames.add(m.name);
  }
  for (const e of expenses) {
    // Skip expenses with no split, no amount, or where every share is 0 —
    // adding `amount` only to the payer would phantom-credit them.
    const totalShare = e.split.reduce((a, b) => a + Math.max(0, Number(b.share) || 0), 0);
    if (!(e.amount > 0) || totalShare <= 0) continue;
    // If the payer isn't a current member (renamed/removed), credit the trip
    // owner implicitly by skipping — never create a new phantom balance key.
    if (!memberNames.has(e.payer)) continue;
    bal[e.payer] += e.amount;
    for (const s of e.split) {
      // Likewise skip split rows for members who no longer exist.
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

// ---------- Owner-only: enable / rotate / disable a public share link ----------
router.post('/:id/share', async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ownTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
  const token = crypto.randomBytes(16).toString('hex'); // 32 chars
  await db
    .prepare('UPDATE trips SET public_token = ?, public_enabled = 1 WHERE id = ?')
    .run(token, id);
  res.json({ token });
});

router.delete('/:id/share', async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ownTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
  await db
    .prepare('UPDATE trips SET public_token = NULL, public_enabled = 0 WHERE id = ?')
    .run(id);
  res.json({ ok: true });
});

router.get('/:id/share', async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ownTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
  const row = await db
    .prepare('SELECT public_token, public_enabled FROM trips WHERE id = ?')
    .get(id);
  res.json({ enabled: !!row?.public_enabled, token: row?.public_enabled ? row.public_token : null });
});

export default router;
