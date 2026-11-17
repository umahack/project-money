/**
 * Monthly review mailer. Intended to be run on the 1st of each month at
 * 09:00 IST via the GitHub Actions workflow in .github/workflows/
 * monthly-review.yml. Walks every user, computes last-month totals from
 * expense_log + salary_entries, and sends a wrap-up email via Resend.
 *
 * Env needed:
 *   TURSO_DATABASE_URL
 *   TURSO_AUTH_TOKEN
 *   RESEND_API_KEY
 *   MAIL_FROM (optional, falls back to onboarding@resend.dev)
 *
 * The script is idempotent per (user, month) via a tiny `monthly_review_log`
 * row — re-running on the same day skips users who already got it. If
 * MONTHLY_REVIEW_DRY_RUN=1 is set, prints the plan without sending.
 */
import 'dotenv/config';
import db from '../src/db/index.js';
import { sendMail, monthlyReviewEmail } from '../src/mailer.js';

async function ensureLogTable() {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS monthly_review_log (
       user_id INTEGER NOT NULL,
       month TEXT NOT NULL,
       sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, month)
     )`
  ).run();
}

function previousMonthKey(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  };
}

async function computeStreakFor(userId) {
  const rows = await db.prepare(
    `SELECT COALESCE(spent_on, substr(datetime(created_at,'+5 hours','+30 minutes'), 1, 10)) AS day
       FROM expense_log WHERE user_id = ? GROUP BY day ORDER BY day DESC LIMIT 400`
  ).all(userId);
  const days = rows.map((r) => String(r.day));
  if (!days.length) return 0;
  const todayISO = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = todayISO();
  const yesterday = todayISO(new Date(Date.now() - 86_400_000));
  if (days[0] !== today && days[0] !== yesterday) return 0;
  let cursor = days[0] === today ? today : yesterday;
  let streak = 0;
  for (const d of days) {
    if (d !== cursor) break;
    streak++;
    const prev = new Date(`${cursor}T00:00:00`);
    prev.setDate(prev.getDate() - 1);
    cursor = todayISO(prev);
  }
  return streak;
}

const NEEDS = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);

async function main() {
  await ensureLogTable();
  const dry = process.env.MONTHLY_REVIEW_DRY_RUN === '1';
  const { key: month, label } = previousMonthKey();
  console.log(`[monthly-review] month=${month} dry=${dry}`);

  const users = await db
    .prepare('SELECT id, email, name FROM users ORDER BY id ASC')
    .all();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const u of users) {
    try {
      const already = await db
        .prepare('SELECT 1 AS ok FROM monthly_review_log WHERE user_id = ? AND month = ?')
        .get(u.id, month);
      if (already) { skipped++; continue; }

      const salary = await db
        .prepare('SELECT amount FROM salary_entries WHERE user_id = ? AND month = ?')
        .get(u.id, month);
      const expenses = await db
        .prepare(
          `SELECT category, COALESCE(SUM(amount), 0) AS total
             FROM expense_log
            WHERE user_id = ? AND month = ?
            GROUP BY category
            ORDER BY total DESC`
        )
        .all(u.id, month);
      const totalSpent = expenses.reduce((s, r) => s + Number(r.total || 0), 0);
      const needsSpent = expenses.filter((r) => NEEDS.has(r.category)).reduce((s, r) => s + Number(r.total || 0), 0);
      const wantsSpent = totalSpent - needsSpent;
      const income = Number(salary?.amount || 0);
      const emiRow = await db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM emis WHERE user_id = ?').get(u.id);
      const emiTotal = Number(emiRow?.t || 0);
      const afterFixed = Math.max(income - emiTotal, 0);
      const save = Math.max(income - emiTotal - totalSpent, 0);
      const saveTarget = Math.round(afterFixed * 0.2);
      const top3 = expenses.slice(0, 3);
      const streak = await computeStreakFor(u.id);

      // Skip entirely-inactive users (no salary and no expenses that month) —
      // they don't need an empty wrap-up.
      if (!income && !totalSpent) { skipped++; continue; }

      const { subject, text, html } = monthlyReviewEmail({
        name: u.name,
        monthLabel: label,
        income,
        needs: needsSpent,
        wants: wantsSpent,
        save,
        saveTarget,
        top3,
        streak,
      });
      if (dry) {
        console.log(`[dry] would send to ${u.email}: ${subject}`);
      } else {
        const r = await sendMail({ to: u.email, subject, text, html });
        if (!r?.ok && !r?.fallback) throw new Error(r?.error || 'send failed');
        await db
          .prepare('INSERT INTO monthly_review_log (user_id, month) VALUES (?, ?)')
          .run(u.id, month);
      }
      sent++;
    } catch (e) {
      failed++;
      console.error(`[monthly-review] failed for user ${u.id} <${u.email}>:`, e?.message || e);
    }
  }
  console.log(`[monthly-review] done · sent=${sent} skipped=${skipped} failed=${failed}`);
  if (failed > 0 && !dry) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[monthly-review] fatal:', e);
  process.exit(1);
});
