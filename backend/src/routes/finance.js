import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
router.use(authRequired);

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Materialize this month's auto-logs for every active recurring entry whose
 * day-of-month has arrived. Idempotent via last_logged_month on the row.
 * Called on finance endpoints that read current-month state so the ledger
 * stays correct without any cron.
 */
async function materializeRecurring(userId) {
  const now = new Date();
  const month = monthKey(now);
  const dayToday = now.getDate();
  const rows = await db
    .prepare(
      `SELECT id, label, amount, category, day_of_month, last_logged_month
         FROM recurring_expenses
        WHERE user_id = ? AND active = 1`
    )
    .all(userId);
  for (const r of rows) {
    if (r.last_logged_month === month) continue;
    if (Number(r.day_of_month) > dayToday) continue;
    const spentOn = `${month}-${String(Math.min(Number(r.day_of_month), 28)).padStart(2, '0')}`;
    try {
      await db
        .prepare(
          `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(userId, month, r.category, Number(r.amount), `${r.label} (recurring)`, spentOn);
      await db
        .prepare('UPDATE recurring_expenses SET last_logged_month = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(month, r.id);
    } catch (e) {
      console.error('[recurring-materialize] skipped id', r.id, e?.message);
    }
  }
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
  await materializeRecurring(req.user.id);
  const salary = await db
    .prepare('SELECT amount FROM salary_entries WHERE user_id = ? ORDER BY month DESC LIMIT 1')
    .get(req.user.id);
  const emiRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS total FROM emis WHERE user_id = ?')
    .get(req.user.id);
  const month = monthKey();
  const spentRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expense_log WHERE user_id = ? AND month = ?')
    .get(req.user.id, month);
  const byCategoryRows = await db
    .prepare(
      `SELECT category, COALESCE(SUM(amount), 0) AS total
         FROM expense_log
        WHERE user_id = ? AND month = ?
        GROUP BY category`
    )
    .all(req.user.id, month);
  const emiTotal = Number(emiRow.total || 0);
  const income = Number(salary?.amount || 0);
  const afterFixed = Math.max(income - emiTotal, 0);
  const needs = Math.round(afterFixed * 0.5);
  const wants = Math.round(afterFixed * 0.3);
  const save = afterFixed - needs - wants;
  const spentThisMonth = Number(spentRow.total || 0);
  const byCategory = Object.fromEntries(byCategoryRows.map((r) => [r.category, Number(r.total)]));
  const tips = [];
  if (emiTotal / Math.max(income, 1) > 0.4)
    tips.push('Your fixed obligations exceed 40% of income — consider refinancing EMIs or renegotiating rent.');
  if (save / Math.max(income, 1) < 0.2 && income > 0)
    tips.push('Target saving at least 20% of take-home. Automate a transfer on salary day.');
  if (income > 0 && emiTotal === 0)
    tips.push('No EMIs — great! Add a monthly SIP into index funds to make the surplus work for you.');
  if (spentThisMonth > afterFixed && afterFixed > 0)
    tips.push("You've already spent more than your disposable this month — pause discretionary spends and revisit the plan.");
  tips.push('Keep an emergency fund of 6 months of fixed expenses in a liquid account.');
  res.json({
    income,
    emiTotal,
    afterFixed,
    breakdown: { needs, wants, save },
    month,
    spentThisMonth,
    byCategory,
    tips,
  });
});

// ---------- Expense log ----------
const EXPENSE_CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Bills', 'Health', 'Travel', 'Education', 'Other'];

async function allowedCategoriesFor(userId) {
  const rows = await db
    .prepare('SELECT name FROM user_categories WHERE user_id = ? ORDER BY id ASC')
    .all(userId);
  return [...EXPENSE_CATEGORIES, ...rows.map((r) => r.name)];
}

const CATEGORY_NAME_RE = /^[A-Za-z0-9 &/+()-]{1,24}$/;

router.post(
  '/expenses',
  [
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('category').isString().isLength({ min: 1, max: 24 }),
    body('note').optional().isString().trim().isLength({ max: 120 }),
    body('spentOn').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const allowed = await allowedCategoriesFor(req.user.id);
    if (!allowed.includes(req.body.category))
      return res.status(400).json({ error: 'Unknown category — add it in Settings first.' });
    const spentOn = req.body.spentOn || new Date().toISOString().slice(0, 10);
    const month = spentOn.slice(0, 7);
    const info = await db
      .prepare(
        'INSERT INTO expense_log (user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(req.user.id, month, req.body.category, Number(req.body.amount), req.body.note?.trim() || null, spentOn);
    res.json({ id: info.lastInsertRowid, month });
  }
);

router.get('/expenses', async (req, res) => {
  await materializeRecurring(req.user.id);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : monthKey();
  const rows = await db
    .prepare(
      `SELECT id, month, category, amount, note, spent_on, created_at
         FROM expense_log
        WHERE user_id = ? AND month = ?
        ORDER BY COALESCE(spent_on, created_at) DESC, id DESC
        LIMIT 500`
    )
    .all(req.user.id, month);
  const categories = await allowedCategoriesFor(req.user.id);
  res.json({ month, categories, expenses: rows });
});

// GET/POST/DELETE user-defined categories (on top of the 10 defaults).
router.get('/categories', async (req, res) => {
  const custom = await db
    .prepare('SELECT id, name FROM user_categories WHERE user_id = ? ORDER BY id ASC')
    .all(req.user.id);
  res.json({ defaults: EXPENSE_CATEGORIES, custom });
});

router.post(
  '/categories',
  [body('name').isString()],
  async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!CATEGORY_NAME_RE.test(name))
      return res.status(400).json({ error: 'Up to 24 chars; letters, digits, spaces, & / + ( ) -' });
    if (EXPENSE_CATEGORIES.map((c) => c.toLowerCase()).includes(name.toLowerCase()))
      return res.status(409).json({ error: 'That matches a built-in category.' });
    try {
      const info = await db
        .prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)')
        .run(req.user.id, name);
      res.json({ id: info.lastInsertRowid, name });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'You already have this category.' });
      throw e;
    }
  }
);

router.delete('/categories/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const info = await db
    .prepare('DELETE FROM user_categories WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/expenses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const info = await db
    .prepare('DELETE FROM expense_log WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Smart insights (derived from expense_log) ----------
router.get('/insights', async (req, res) => {
  await materializeRecurring(req.user.id);
  const now = new Date();
  const thisMonth = monthKey(now);
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = monthKey(prev);

  // Per-category totals this month + last month
  const rows = await db
    .prepare(
      `SELECT month, category, COALESCE(SUM(amount), 0) AS total
         FROM expense_log
        WHERE user_id = ? AND month IN (?, ?)
        GROUP BY month, category`
    )
    .all(req.user.id, thisMonth, prevMonth);
  const totals = { [thisMonth]: {}, [prevMonth]: {} };
  for (const r of rows) totals[r.month][r.category] = Number(r.total);
  const sumFor = (m) => Object.values(totals[m] || {}).reduce((a, b) => a + b, 0);
  const thisTotal = sumFor(thisMonth);
  const prevTotal = sumFor(prevMonth);

  // 90-day weekday pattern
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90)
    .toISOString()
    .slice(0, 10);
  const weekdayRows = await db
    .prepare(
      `SELECT COALESCE(spent_on, substr(created_at, 1, 10)) AS d, SUM(amount) AS t
         FROM expense_log
        WHERE user_id = ? AND COALESCE(spent_on, substr(created_at, 1, 10)) >= ?
        GROUP BY d`
    )
    .all(req.user.id, since);
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  const countByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const r of weekdayRows) {
    const w = new Date(r.d).getDay(); // 0 = Sun
    byWeekday[w] += Number(r.t);
    countByWeekday[w]++;
  }
  const avgByWeekday = byWeekday.map((s, i) => (countByWeekday[i] ? s / countByWeekday[i] : 0));
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const topWeekdayIdx =
    avgByWeekday.some((v) => v > 0)
      ? avgByWeekday.reduce((best, v, i) => (v > avgByWeekday[best] ? i : best), 0)
      : -1;

  // Trailing 3-month average per category for spike detection
  const threeStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const spikeRows = await db
    .prepare(
      `SELECT month, category, COALESCE(SUM(amount), 0) AS total
         FROM expense_log
        WHERE user_id = ? AND month >= ?
        GROUP BY month, category`
    )
    .all(req.user.id, monthKey(threeStart));
  const sumByCat = {}; // category -> {months: Set, total: n}
  for (const r of spikeRows) {
    if (r.month === thisMonth) continue;
    sumByCat[r.category] = sumByCat[r.category] || { months: new Set(), total: 0 };
    sumByCat[r.category].months.add(r.month);
    sumByCat[r.category].total += Number(r.total);
  }

  const insights = [];
  if (prevTotal > 0 && thisTotal > 0) {
    const diffPct = Math.round(((thisTotal - prevTotal) / prevTotal) * 100);
    if (Math.abs(diffPct) >= 5) {
      insights.push({
        id: 'mom-total',
        kind: diffPct > 0 ? 'warn' : 'ok',
        title: `${diffPct > 0 ? '📈' : '📉'} ${Math.abs(diffPct)}% ${diffPct > 0 ? 'more' : 'less'} spent vs last month`,
        text: `This month: ${Math.round(thisTotal)}. Last month: ${Math.round(prevTotal)}.`,
      });
    }
  }

  // Per-category deltas (top 1 up, top 1 down)
  const catDelta = [];
  const allCats = new Set([...Object.keys(totals[thisMonth]), ...Object.keys(totals[prevMonth])]);
  for (const c of allCats) {
    const a = totals[thisMonth][c] || 0;
    const b = totals[prevMonth][c] || 0;
    if (b >= 100) {
      catDelta.push({ cat: c, delta: a - b, pct: ((a - b) / b) * 100, a, b });
    }
  }
  catDelta.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
  const biggest = catDelta[0];
  if (biggest && Math.abs(biggest.pct) >= 25) {
    insights.push({
      id: `mom-cat-${biggest.cat}`,
      kind: biggest.delta > 0 ? 'warn' : 'ok',
      title: `${biggest.cat}: ${biggest.delta > 0 ? '↑' : '↓'} ${Math.round(Math.abs(biggest.pct))}% vs last month`,
      text: `This month ${Math.round(biggest.a)}, last month ${Math.round(biggest.b)}.`,
    });
  }

  // Category spike (vs 3-month average, excluding current)
  for (const [cat, agg] of Object.entries(sumByCat)) {
    if (agg.months.size < 2) continue;
    const avg = agg.total / agg.months.size;
    const cur = totals[thisMonth][cat] || 0;
    if (avg > 500 && cur > avg * 1.5) {
      insights.push({
        id: `spike-${cat}`,
        kind: 'warn',
        title: `${cat} is spiking this month`,
        text: `You've already spent ${Math.round(cur)} vs a 3-month average of ${Math.round(avg)}.`,
      });
      break;
    }
  }

  if (topWeekdayIdx >= 0 && avgByWeekday[topWeekdayIdx] > 100) {
    insights.push({
      id: 'weekday',
      kind: 'info',
      title: `${weekdayNames[topWeekdayIdx]}s are your heaviest day`,
      text: `Average ${Math.round(avgByWeekday[topWeekdayIdx])} on ${weekdayNames[topWeekdayIdx]}s over the last 90 days.`,
    });
  }

  // Positive affirmation when nothing is wrong
  if (insights.length === 0) {
    const tip = thisTotal > 0
      ? "You're on steady spending so far — keep logging to unlock sharper comparisons."
      : 'No expenses logged this month yet. Log a few and insights will appear here.';
    insights.push({ id: 'affirm', kind: 'info', title: 'Nothing unusual', text: tip });
  }

  res.json({
    thisMonth,
    prevMonth,
    totals: { thisMonth: thisTotal, prevMonth: prevTotal },
    weekdayAvg: avgByWeekday.map((v, i) => ({ day: weekdayNames[i], avg: Math.round(v) })),
    insights,
  });
});

// ---------- Monthly history (last 12 months, including months with no spend) ----------
router.get('/history', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT month, category, COALESCE(SUM(amount), 0) AS total
         FROM expense_log
        WHERE user_id = ?
        GROUP BY month, category
        ORDER BY month ASC`
    )
    .all(req.user.id);
  // Fill the trailing 12-month window so the chart always shows a stable X-axis.
  const now = new Date();
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const totalsByMonth = new Map(monthKeys.map((m) => [m, { total: 0, byCategory: {} }]));
  for (const r of rows) {
    const bucket = totalsByMonth.get(r.month);
    if (!bucket) continue;
    bucket.byCategory[r.category] = Number(r.total);
    bucket.total += Number(r.total);
  }
  res.json({
    months: monthKeys.map((m) => ({ month: m, ...totalsByMonth.get(m) })),
  });
});

// ---------- Category budgets ----------
router.get('/budgets', async (req, res) => {
  const rows = await db
    .prepare('SELECT category, amount FROM category_budgets WHERE user_id = ? ORDER BY category')
    .all(req.user.id);
  res.json({ budgets: Object.fromEntries(rows.map((r) => [r.category, Number(r.amount)])) });
});

router.put(
  '/budgets/:category',
  [body('amount').isFloat({ min: 0, max: 1e12 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const category = String(req.params.category);
    if (!EXPENSE_CATEGORIES.includes(category))
      return res.status(400).json({ error: 'Invalid category' });
    await db
      .prepare(
        `INSERT INTO category_budgets (user_id, category, amount) VALUES (?, ?, ?)
         ON CONFLICT(user_id, category) DO UPDATE
           SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP`
      )
      .run(req.user.id, category, Number(req.body.amount));
    res.json({ ok: true, category, amount: Number(req.body.amount) });
  }
);

router.delete('/budgets/:category', async (req, res) => {
  const info = await db
    .prepare('DELETE FROM category_budgets WHERE user_id = ? AND category = ?')
    .run(req.user.id, String(req.params.category));
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Savings goals ----------
router.get('/goals', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, name, target_amount, saved_amount, target_date, created_at, updated_at
         FROM savings_goals
        WHERE user_id = ?
        ORDER BY id DESC`
    )
    .all(req.user.id);
  res.json({ goals: rows });
});

router.post(
  '/goals',
  [
    body('name').isString().trim().isLength({ min: 1, max: 60 }),
    body('targetAmount').isFloat({ gt: 0, max: 1e12 }),
    body('targetDate').optional({ nullable: true }).matches(/^\d{4}-\d{2}-\d{2}$/),
    body('savedAmount').optional().isFloat({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const info = await db
      .prepare(
        `INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, target_date)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        String(req.body.name).trim(),
        Number(req.body.targetAmount),
        Number(req.body.savedAmount || 0),
        req.body.targetDate || null
      );
    res.json({ id: info.lastInsertRowid });
  }
);

router.patch(
  '/goals/:id',
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 60 }),
    body('targetAmount').optional().isFloat({ gt: 0, max: 1e12 }),
    body('targetDate').optional({ nullable: true }),
    body('addToSaved').optional().isFloat(),
    body('setSaved').optional().isFloat({ min: 0 }),
  ],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const existing = await db
      .prepare('SELECT id, saved_amount FROM savings_goals WHERE id = ? AND user_id = ?')
      .get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const sets = [];
    const args = [];
    if (req.body.name !== undefined) { sets.push('name = ?'); args.push(String(req.body.name).trim()); }
    if (req.body.targetAmount !== undefined) { sets.push('target_amount = ?'); args.push(Number(req.body.targetAmount)); }
    if (req.body.targetDate !== undefined) { sets.push('target_date = ?'); args.push(req.body.targetDate || null); }
    if (req.body.setSaved !== undefined) { sets.push('saved_amount = ?'); args.push(Number(req.body.setSaved)); }
    if (req.body.addToSaved !== undefined) {
      const next = Math.max(0, Number(existing.saved_amount) + Number(req.body.addToSaved));
      sets.push('saved_amount = ?');
      args.push(next);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    args.push(id, req.user.id);
    await db.prepare(`UPDATE savings_goals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...args);
    res.json({ ok: true });
  }
);

router.delete('/goals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db
    .prepare('DELETE FROM savings_goals WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Recurring expenses ----------
router.get('/recurring', async (req, res) => {
  await materializeRecurring(req.user.id);
  const rows = await db
    .prepare(
      `SELECT id, label, amount, category, day_of_month, active, last_logged_month, created_at
         FROM recurring_expenses WHERE user_id = ? ORDER BY day_of_month ASC, id DESC`
    )
    .all(req.user.id);
  res.json({
    categories: EXPENSE_CATEGORIES,
    recurring: rows.map((r) => ({ ...r, active: !!r.active })),
  });
});

router.post(
  '/recurring',
  [
    body('label').isString().trim().isLength({ min: 1, max: 60 }),
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('category').isIn(EXPENSE_CATEGORIES),
    body('dayOfMonth').isInt({ min: 1, max: 31 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const info = await db
      .prepare(
        `INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        String(req.body.label).trim(),
        Number(req.body.amount),
        req.body.category,
        Number(req.body.dayOfMonth)
      );
    await materializeRecurring(req.user.id);
    res.json({ id: info.lastInsertRowid });
  }
);

router.patch(
  '/recurring/:id',
  [body('active').optional().isBoolean()],
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (req.body.active === undefined) return res.status(400).json({ error: 'Nothing to update' });
    const info = await db
      .prepare('UPDATE recurring_expenses SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run(req.body.active ? 1 : 0, id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }
);

router.delete('/recurring/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db
    .prepare('DELETE FROM recurring_expenses WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- CSV export ----------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/export.csv', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT COALESCE(spent_on, substr(created_at, 1, 10)) AS date, month, category, amount, note
         FROM expense_log WHERE user_id = ? ORDER BY date ASC, id ASC`
    )
    .all(req.user.id);
  const header = ['date', 'month', 'category', 'amount', 'note'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => csvEscape(r[h])).join(','));
  const filename = `project-money-expenses-${todayISO()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n') + '\n');
});

export default router;
