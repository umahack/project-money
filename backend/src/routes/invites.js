import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { resolveUserByEmail } from './aliases.js';

const router = Router();
router.use(authRequired);

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

async function tripParticipant(userId, tripId) {
  const owner = await db
    .prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?')
    .get(tripId, userId);
  if (owner) return 'owner';
  const member = await db
    .prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?')
    .get(tripId, userId);
  return member ? 'member' : null;
}

// Owner-only: invite a REGISTERED user by email to a trip
router.post(
  '/trips/:id/invite',
  inviteLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const tripId = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const trip = await db
      .prepare('SELECT id, name, user_id FROM trips WHERE id = ? AND user_id = ?')
      .get(tripId, req.user.id);
    if (!trip) return res.status(404).json({ error: 'Not found' });

    const invitee = await resolveUserByEmail(req.body.email);
    if (!invitee) return res.status(404).json({ error: 'No user with that email. Ask them to sign up first.' });
    if (invitee.id === req.user.id) return res.status(400).json({ error: "You can't invite yourself." });

    const already = await db
      .prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?')
      .get(tripId, invitee.id);
    if (already) return res.status(409).json({ error: 'That person is already on this trip.' });

    try {
      const info = await db
        .prepare(
          'INSERT INTO trip_invites (trip_id, inviter_id, invitee_id, status) VALUES (?, ?, ?, ?)'
        )
        .run(tripId, req.user.id, invitee.id, 'pending');
      res.json({ id: info.lastInsertRowid, invitee: { email: invitee.email, name: invitee.name } });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        // Previous invite already exists; if declined, re-open it as pending
        await db
          .prepare(
            `UPDATE trip_invites SET status = 'pending', responded_at = NULL, inviter_id = ?
             WHERE trip_id = ? AND invitee_id = ?`
          )
          .run(req.user.id, tripId, invitee.id);
        return res.json({ ok: true, reopened: true });
      }
      throw e;
    }
  }
);

// List pending invites for current user
router.get('/invites', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT i.id, i.trip_id, i.created_at,
              t.name AS trip_name, t.destination, t.budget,
              u.name AS inviter_name, u.email AS inviter_email
       FROM trip_invites i
       JOIN trips t ON t.id = i.trip_id
       JOIN users u ON u.id = i.inviter_id
       WHERE i.invitee_id = ? AND i.status = 'pending'
       ORDER BY i.id DESC`
    )
    .all(req.user.id);
  res.json({ invites: rows });
});

router.post('/invites/:id/accept', async (req, res) => {
  const id = Number(req.params.id);
  const inv = await db
    .prepare('SELECT * FROM trip_invites WHERE id = ? AND invitee_id = ? AND status = ?')
    .get(id, req.user.id, 'pending');
  if (!inv) return res.status(404).json({ error: 'Invite not found or already responded.' });

  const me = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id);
  // Pick a unique member name within the trip: prefer real name, fall back to email handle, then suffix.
  const base = (me.name || me.email.split('@')[0]).trim().slice(0, 30);
  let candidate = base;
  let n = 2;
  while (true) {
    const clash = await db
      .prepare('SELECT 1 AS ok FROM trip_members WHERE trip_id = ? AND name = ?')
      .get(inv.trip_id, candidate);
    if (!clash) break;
    candidate = `${base} ${n++}`.slice(0, 40);
    if (n > 50) break;
  }
  try {
    await db
      .prepare('INSERT INTO trip_members (trip_id, user_id, name, email) VALUES (?, ?, ?, ?)')
      .run(inv.trip_id, me.id, candidate, me.email);
  } catch (e) {
    // Race: another accept slipped in. Treat as success.
    if (!/UNIQUE/i.test(e.message)) throw e;
  }
  await db
    .prepare(`UPDATE trip_invites SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(id);
  res.json({ ok: true, trip_id: inv.trip_id });
});

router.post('/invites/:id/decline', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db
    .prepare(
      `UPDATE trip_invites SET status = 'declined', responded_at = CURRENT_TIMESTAMP
       WHERE id = ? AND invitee_id = ? AND status = 'pending'`
    )
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Invite not found or already responded.' });
  res.json({ ok: true });
});

export default router;
export { tripParticipant };
