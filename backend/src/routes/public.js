import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import db from '../db/index.js';
import { calculateTripOutcome } from '../domain/trips.js';
import { serializePublicTrip } from '../serializers/publicTrip.js';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

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

/**
 * Share-link read-only trip view. No auth; token must be exactly 32 hex chars.
 * The stored IDs are calculator inputs only. The serializer constructs the
 * anonymous response from an explicit display-field allowlist.
 */
router.get('/trips/:token', publicLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).json({ error: 'Not found' });

  const trip = await db
    .prepare(
      `SELECT id, name, destination, budget, start_date, end_date, trip_version
         FROM trips
        WHERE public_token = ? AND public_enabled = 1`
    )
    .get(token);
  if (!trip) return res.status(404).json({ error: 'Not found' });

  const members = await db
    .prepare('SELECT id, name FROM trip_members WHERE trip_id = ?')
    .all(trip.id);
  const expenses = await db
    .prepare(
      `SELECT id, payer, description, amount, split_json, created_at
         FROM trip_expenses WHERE trip_id = ? ORDER BY id DESC`
    )
    .all(trip.id);
  const calculation = calculateTripOutcome({
    tripId: trip.id,
    tripVersion: trip.trip_version ?? 0,
    members,
    expenses,
  });

  res.json(serializePublicTrip({ trip, members, expenses, calculation }));
});

export default router;
