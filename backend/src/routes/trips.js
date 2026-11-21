import { Router } from 'express';
import crypto from 'node:crypto';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { createDataUseNoticeGate } from '../middleware/dataUse.js';
import { requestsClarityContract } from '../rollout/contractNegotiation.js';
import { legacyTripSettlement } from '../rollout/legacyTripSettlement.js';
import { PUBLIC_TRIP_DISCLOSURE } from '../serializers/publicTrip.js';
import tripService, { TripServiceError } from '../services/tripService.js';

const router = Router();
router.use(authRequired);

const clarityFinancialInputDataUseGate = createDataUseNoticeGate({
  appliesTo: requestsClarityContract,
});
const currentFinancialDataUseGate = createDataUseNoticeGate();

function idempotencyKey(req, { required = false } = {}) {
  const supplied = req.get('Idempotency-Key');
  if (supplied) return supplied;
  return required ? undefined : crypto.randomUUID();
}

function sendTripServiceError(error, res) {
  if (!(error instanceof TripServiceError)) throw error;
  if (error.httpStatus === 404) return res.status(404).json({ error: 'Not found' });
  return res.status(error.httpStatus).json({
    error: error.message,
    code: error.code,
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
    ...(error.currentTripVersion === undefined
      ? {}
      : { currentTripVersion: error.currentTripVersion }),
    ...(error.tripOutcome === undefined ? {} : { tripOutcome: error.tripOutcome }),
  });
}

async function ownTrip(userId, tripId) {
  return db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

// The share link belongs to the owner. A member reads the trip, but never the
// token that grants anonymous access to it, so it is left out of their reads.
function withoutShareFields(row) {
  const { public_token: _token, public_enabled: _enabled, ...rest } = row;
  return rest;
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
    clarityFinancialInputDataUseGate,
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
  res.json({ trips: rows.map((row) => (row.role === 'owner' ? row : withoutShareFields(row))) });
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
  const expenses = rawExpenses.map((e) => {
    let split = [];
    try {
      const parsed = JSON.parse(e.split_json);
      if (Array.isArray(parsed)) split = parsed;
    } catch {
      // Keep the row visible but with an empty split so the whole trip
      // doesn't 500 on a single corrupted blob.
    }
    return { ...e, split, split_json: undefined };
  });
  res.json({
    trip: access.role === 'owner' ? access.trip : withoutShareFields(access.trip),
    role: access.role,
    members,
    expenses,
    settlement: legacyTripSettlement(members, expenses),
  });
});

router.post(
  '/:id/members',
  [
    body('name').isString().trim().isLength({ min: 1, max: 40 }),
    body('email').optional().isEmail(),
    clarityFinancialInputDataUseGate,
  ],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const response = await tripService.addMember({
        userId: req.user.id,
        tripId: id,
        name: req.body.name,
        email: req.body.email,
        idempotencyKey: idempotencyKey(req),
        expectedTripVersion: req.body.expectedTripVersion,
      });
      return res.json(response);
    } catch (error) {
      return sendTripServiceError(error, res);
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
    clarityFinancialInputDataUseGate,
  ],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const response = await tripService.addExpense({
        userId: req.user.id,
        tripId: id,
        payer: req.body.payer,
        description: req.body.description,
        amount: req.body.amount,
        split: req.body.split,
        idempotencyKey: idempotencyKey(req),
        expectedTripVersion: req.body.expectedTripVersion,
      });
      return res.json(response);
    } catch (error) {
      return sendTripServiceError(error, res);
    }
  }
);

router.put(
  '/:id/expenses/:expenseId/personal-link',
  [
    body('category').isString().trim().isLength({ min: 1, max: 24 }),
    body('spentOn').isString().matches(/^\d{4}-\d{2}-\d{2}$/),
    currentFinancialDataUseGate,
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const response = await tripService.includePersonalExpense({
        userId: req.user.id,
        tripId: Number(req.params.id),
        tripExpenseId: Number(req.params.expenseId),
        category: req.body.category,
        spentOn: req.body.spentOn,
        idempotencyKey: idempotencyKey(req, { required: true }),
      });
      return res.json(response);
    } catch (error) {
      return sendTripServiceError(error, res);
    }
  }
);

router.delete('/:id/expenses/:expenseId/personal-link', async (req, res) => {
  try {
    const response = await tripService.removePersonalExpense({
      userId: req.user.id,
      tripId: Number(req.params.id),
      tripExpenseId: Number(req.params.expenseId),
      idempotencyKey: idempotencyKey(req, { required: true }),
    });
    return res.json(response);
  } catch (error) {
    return sendTripServiceError(error, res);
  }
});

// ---------- Owner-only: enable / rotate / disable a public share link ----------
// Creating or rotating a link is a new use of trip data (it publishes it), so a
// clarity-contract request needs the current data-use notice. Legacy requests,
// revoking, and reading the status stay ungated.
router.post('/:id/share', clarityFinancialInputDataUseGate, async (req, res) => {
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

// Owner-only description of every field the public link serves, read from the
// serializer module that produces the public response. Not a public route.
router.get('/:id/share/disclosure', async (req, res) => {
  const id = Number(req.params.id);
  if (!(await ownTrip(req.user.id, id))) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.json(PUBLIC_TRIP_DISCLOSURE);
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
