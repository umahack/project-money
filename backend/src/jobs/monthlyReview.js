/**
 * Monthly review job — walks every user, builds the prior-month review from
 * the canonical clarity service, and sends the existing wrap-up email.
 * Imported by both the standalone CLI script (backend/scripts/
 * send-monthly-review.js) for manual runs and by the internal cron
 * endpoint POST /api/internal/cron/monthly-review for the real schedule.
 *
 * Idempotent per (user_id, month) via monthly_review_log.
 * Set MONTHLY_REVIEW_CALCULATION_MODE=legacy for rollback. Set
 * CLARITY_SHADOW_COMPARE=1 to compare both paths without logging values.
 */
import db from '../db/index.js';
import { sendMail, monthlyReviewEmail } from '../mailer.js';
import { ClarityService } from '../services/clarityService.js';
import { readServerFeatureFlags } from '../rollout/featureFlags.js';
import { logShadowMismatchCodes } from '../rollout/shadowComparison.js';
import { logJobLine } from '../observability/operationalLog.js';

const NEEDS = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);
const CALCULATION_MODES = new Set(['canonical', 'legacy']);

const SHADOW_COMPARISONS = Object.freeze([
  {
    code: 'SHADOW_INCOME_MISMATCH',
    matches: (canonical, legacy) => canonical.income === legacy.income,
    recordTypes: ['salary'],
  },
  {
    code: 'SHADOW_NEEDS_SPENT_MISMATCH',
    matches: (canonical, legacy) => canonical.needs === legacy.needs,
    recordTypes: ['expense', 'categoryTreatment'],
  },
  {
    code: 'SHADOW_WANTS_SPENT_MISMATCH',
    matches: (canonical, legacy) => canonical.wants === legacy.wants,
    recordTypes: ['expense', 'categoryTreatment'],
  },
  {
    code: 'SHADOW_PROJECTED_SAVINGS_MISMATCH',
    matches: (canonical, legacy) => canonical.save === legacy.save,
    recordTypes: ['salary', 'bill', 'expense'],
  },
  {
    code: 'SHADOW_SAVINGS_TARGET_MISMATCH',
    matches: (canonical, legacy) => canonical.saveTarget === legacy.saveTarget,
    recordTypes: ['salary', 'bill'],
  },
  {
    code: 'SHADOW_CATEGORY_TOTALS_MISMATCH',
    matches: (canonical, legacy) => categoryTotalsMatch(
      canonical.categoryTotals,
      legacy.categoryTotals
    ),
    recordTypes: ['expense'],
  },
]);

async function ensureLogTable(database) {
  await database.prepare(
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

const todayISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function computeStreakFor(database, userId, now) {
  const rows = await database.prepare(
    `SELECT COALESCE(spent_on, substr(datetime(created_at,'+5 hours','+30 minutes'), 1, 10)) AS day
       FROM expense_log WHERE user_id = ? GROUP BY day ORDER BY day DESC LIMIT 400`
  ).all(userId);
  const days = rows.map((r) => String(r.day));
  if (!days.length) return 0;
  const today = todayISO(now);
  const yesterday = todayISO(new Date(now.getTime() - 86_400_000));
  if (days[0] !== today && days[0] !== yesterday) return 0;
  let cursor = days[0] === today ? today : yesterday;
  let streak = 0;
  for (const d of days) {
    if (d !== cursor) break;
    streak++;
    // Build the previous day without parsing an ISO timestamp. This avoids
    // relying on UTC interpretation of a local calendar date.
    const [y, m, dd] = cursor.split('-').map(Number);
    const prev = new Date(y, m - 1, dd);
    prev.setDate(prev.getDate() - 1);
    cursor = todayISO(prev);
  }
  return streak;
}

function resolveCalculationMode(value) {
  const mode = value || 'canonical';
  if (!CALCULATION_MODES.has(mode)) {
    throw new RangeError('MONTHLY_REVIEW_CALCULATION_MODE must be canonical or legacy.');
  }
  return mode;
}

function parseIdList(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value
    .split(',')
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .toSorted((left, right) => left - right);
}

function mergeRecordIds(...collections) {
  const merged = {
    salary: [],
    bill: [],
    expense: [],
    categoryTreatment: [],
  };
  for (const collection of collections) {
    if (!collection) continue;
    for (const type of Object.keys(merged)) {
      for (const id of collection[type] ?? []) {
        if (Number.isSafeInteger(id) && id > 0) merged[type].push(id);
      }
    }
  }
  for (const type of Object.keys(merged)) {
    merged[type] = [...new Set(merged[type])].toSorted((left, right) => left - right);
  }
  return merged;
}

function recordIdsFromSnapshot(snapshot) {
  const ids = mergeRecordIds();
  const sourceTypeToKey = {
    salary: 'salary',
    bill: 'bill',
    expense: 'expense',
    category_treatment: 'categoryTreatment',
  };
  for (const fact of snapshot?.facts ?? []) {
    const source = fact?.source;
    const key = sourceTypeToKey[source?.sourceType];
    if (key && Number.isSafeInteger(source.recordId) && source.recordId > 0) {
      ids[key].push(source.recordId);
    }
  }
  return mergeRecordIds(ids);
}

function amountMajor(money, field) {
  const amountMinor = money?.amountMinor;
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`Canonical ${field} is unavailable.`);
  }
  return amountMinor / 100;
}

function availableValue(outcome, field) {
  if (outcome?.status !== 'available' || !outcome.value) {
    throw new TypeError(`Canonical ${field} outcome is unavailable.`);
  }
  return outcome.value;
}

function compareCategories(left, right) {
  return String(left).localeCompare(String(right), 'en-IN', { sensitivity: 'variant' });
}

function rankedCategories(categoryTotals) {
  return categoryTotals
    .map(({ category, total }) => ({ category, total }))
    .toSorted((left, right) => (
      right.total - left.total || compareCategories(left.category, right.category)
    ));
}

function normalizedCategoryTotals(categoryTotals) {
  return categoryTotals
    .map(({ category, total }) => ({ category, total }))
    .toSorted((left, right) => compareCategories(left.category, right.category));
}

function categoryTotalsMatch(left, right) {
  const canonical = normalizedCategoryTotals(left);
  const legacy = normalizedCategoryTotals(right);
  return canonical.length === legacy.length && canonical.every((entry, index) => (
    entry.category === legacy[index].category && entry.total === legacy[index].total
  ));
}

/**
 * Convert a canonical clarity snapshot into the unchanged monthly-email input.
 * Financial values remain in memory and are never passed to the job logger.
 */
export function reviewDataFromClaritySnapshot(snapshot) {
  const monthlyPlan = availableValue(snapshot?.outcomes?.monthlyPlan, 'monthly plan');
  const spending = availableValue(snapshot?.outcomes?.spending, 'spending');
  const categoryTotals = spending.categoryTotals.map((entry) => ({
    category: entry.category,
    total: amountMajor(entry.total, 'category total'),
  }));

  return {
    income: amountMajor(monthlyPlan.salary, 'salary'),
    needs: amountMajor(spending.needsSpent, 'needs spending'),
    wants: amountMajor(spending.wantsSpent, 'wants spending'),
    save: amountMajor(spending.projectedSavings, 'projected savings'),
    saveTarget: amountMajor(spending.savingsTarget, 'savings target'),
    totalSpent: amountMajor(spending.totalSpending, 'total spending'),
    categoryTotals,
    top3: rankedCategories(categoryTotals).slice(0, 3),
    recordIds: recordIdsFromSnapshot(snapshot),
  };
}

/**
 * Retained rollback implementation. The canonical path is the default; this
 * loader remains selectable while parity monitoring is active.
 */
export async function loadLegacyReviewData({ database = db, userId, month }) {
  const [salary, expenses, bills] = await Promise.all([
    database
      .prepare('SELECT id, amount FROM salary_entries WHERE user_id = ? AND month = ?')
      .get(userId, month),
    database.prepare(
      `SELECT category, COALESCE(SUM(amount), 0) AS total, GROUP_CONCAT(id) AS record_ids
         FROM expense_log
        WHERE user_id = ? AND month = ?
        GROUP BY category
        ORDER BY total DESC`
    ).all(userId, month),
    database.prepare('SELECT id, amount FROM emis WHERE user_id = ? ORDER BY id').all(userId),
  ]);

  const categoryTotals = expenses.map((row) => ({
    category: row.category,
    total: Number(row.total || 0),
  }));
  const totalSpent = categoryTotals.reduce((sum, row) => sum + row.total, 0);
  const needs = categoryTotals
    .filter((row) => NEEDS.has(row.category))
    .reduce((sum, row) => sum + row.total, 0);
  const income = Number(salary?.amount || 0);
  const billTotal = bills.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const afterFixed = Math.max(income - billTotal, 0);

  return {
    income,
    needs,
    wants: totalSpent - needs,
    save: Math.max(income - billTotal - totalSpent, 0),
    saveTarget: Math.round(afterFixed * 0.2),
    totalSpent,
    categoryTotals,
    top3: categoryTotals.slice(0, 3),
    recordIds: mergeRecordIds({
      salary: salary?.id ? [Number(salary.id)] : [],
      bill: bills.map((row) => Number(row.id)),
      expense: expenses.flatMap((row) => parseIdList(row.record_ids)),
    }),
  };
}

function logShadowCode(log, code) {
  logShadowMismatchCodes([code], log);
}

function compareInShadow({ canonical, legacy, log }) {
  for (const comparison of SHADOW_COMPARISONS) {
    if (!comparison.matches(canonical, legacy)) {
      logShadowCode(log, comparison.code);
    }
  }
}

function emailInput(review, { name, monthLabel, streak }) {
  return {
    name,
    monthLabel,
    income: review.income,
    needs: review.needs,
    wants: review.wants,
    save: review.save,
    saveTarget: review.saveTarget,
    top3: review.top3,
    streak,
  };
}

/**
 * Run the monthly review job.
 * @param {{
 *   dry?: boolean,
 *   log?: (msg: string) => void,
 *   now?: Date,
 *   calculationMode?: 'canonical' | 'legacy',
 *   shadowCompare?: boolean,
 *   database?: typeof db,
 *   clarityService?: ClarityService
 * }} [opts]
 * @returns {Promise<{ month: string, sent: number, skipped: number, failed: number, dry: boolean }>}
 */
export async function runMonthlyReview({
  dry = false,
  log = (message) => logJobLine(message),
  now = new Date(),
  calculationMode = process.env.MONTHLY_REVIEW_CALCULATION_MODE,
  shadowCompare = readServerFeatureFlags().clarityShadowCompare,
  database = db,
  clarityService = new ClarityService(),
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date.');
  }
  const mode = resolveCalculationMode(calculationMode);
  await ensureLogTable(database);
  const { key: month, label } = previousMonthKey(now);
  log(`[monthly-review] month=${month} dry=${Boolean(dry)}`);

  const users = await database
    .prepare('SELECT id, email, name FROM users ORDER BY id ASC')
    .all();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of users) {
    try {
      const already = await database
        .prepare('SELECT 1 AS ok FROM monthly_review_log WHERE user_id = ? AND month = ?')
        .get(user.id, month);
      if (already) {
        skipped++;
        continue;
      }

      let legacy = null;
      let canonical = null;
      let canonicalFailed = false;
      let legacyFailed = false;

      if (mode === 'legacy' || shadowCompare) {
        try {
          legacy = await loadLegacyReviewData({ database, userId: user.id, month });
        } catch {
          legacyFailed = true;
        }
      }

      if (mode === 'canonical' || shadowCompare) {
        try {
          const snapshot = await clarityService.getSnapshot({
            userId: user.id,
            month,
            now,
            timeZone: 'Asia/Kolkata',
          });
          canonical = reviewDataFromClaritySnapshot(snapshot);
        } catch {
          canonicalFailed = true;
        }
      }

      if (shadowCompare) {
        if (canonical && legacy) {
          compareInShadow({ canonical, legacy, log });
        } else if (canonicalFailed) {
          logShadowCode(log, 'SHADOW_CANONICAL_UNAVAILABLE');
        } else if (legacyFailed) {
          logShadowCode(log, 'SHADOW_LEGACY_UNAVAILABLE');
        }
      }

      let review = mode === 'canonical' ? canonical : legacy;
      if (!review && mode === 'canonical') {
        legacy ??= await loadLegacyReviewData({ database, userId: user.id, month });
        review = legacy;
        logShadowCode(log, 'CANONICAL_FALLBACK');
      }
      if (!review) throw new Error('Selected monthly review calculation path failed.');

      if (!review.income && !review.totalSpent) {
        skipped++;
        continue;
      }

      const streak = await computeStreakFor(database, user.id, now);
      const { subject, text, html } = monthlyReviewEmail(emailInput(review, {
        name: user.name,
        monthLabel: label,
        streak,
      }));

      if (dry) {
        log(`[dry] would send user_id=${user.id}`);
      } else {
        const result = await sendMail({
          to: user.email,
          subject,
          text,
          html,
          logDetails: false,
        });
        if (!result?.ok && !result?.fallback) throw new Error('Monthly review delivery failed.');
        if (result?.fallback) log(`[monthly-review] mail code=FALLBACK user_id=${user.id}`);
        await database
          .prepare('INSERT INTO monthly_review_log (user_id, month) VALUES (?, ?)')
          .run(user.id, month);
      }
      sent++;
    } catch {
      failed++;
      log(`[monthly-review] failed user_id=${user.id} code=USER_PROCESSING_FAILED`);
    }
  }
  log(`[monthly-review] done · sent=${sent} skipped=${skipped} failed=${failed}`);
  return { month, sent, skipped, failed, dry };
}
