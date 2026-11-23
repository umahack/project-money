import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import db from '../db/index.js';
import { authRequired } from '../middleware/auth.js';
import { createDataUseNoticeGate } from '../middleware/dataUse.js';
import clarityService from '../services/clarityService.js';
import {
  CATEGORY_TREATMENT_ACCEPTED_CONSTRAINTS,
  EXPENSE_ACCEPTED_CONSTRAINTS,
  EXPENSE_CATEGORIES,
  categoryTreatmentRecordFromRow,
  createExpenseMutationService,
  expenseRecordFromRow,
  normalizeCategoryTreatmentDeleteCommand,
  normalizeCategoryTreatmentSetCommand,
  normalizeExpenseCreateCommand,
  normalizeExpenseDeleteCommand,
  normalizeExpenseUpdateCommand,
} from '../services/expenseMutations.js';
import { FinancialMutationError } from '../services/financialMutation.js';
import { logBackgroundFailure } from '../observability/operationalLog.js';
import {
  GOAL_ACCEPTED_CONSTRAINTS,
  GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS,
  createGoalLegacy,
  createGoalMutationService,
  goalRecordFromRow,
  legacyGoalFromRow,
  loadGoalRow,
  normalizeGoalContributionCommand,
  normalizeGoalCreateCommand,
  normalizeGoalDeleteCommand,
  normalizeGoalUpdateCommand,
  patchGoalLegacy,
} from '../services/goalMutations.js';
import {
  BILL_ACCEPTED_CONSTRAINTS,
  SALARY_ACCEPTED_CONSTRAINTS,
  SALARY_APPLY_ACCEPTED_CONSTRAINTS,
  billRecordFromRow,
  createSalaryBillMutationService,
  normalizeBillCreateCommand,
  normalizeBillDeleteCommand,
  normalizeBillUpdateCommand,
  normalizeSalaryApplyCommand,
  normalizeSalaryCommand,
  salaryRecordFromRow,
} from '../services/salaryBillMutations.js';
import { readServerFeatureFlags } from '../rollout/featureFlags.js';
import {
  negotiateClarityContract,
  requestsClarityContract,
} from '../rollout/contractNegotiation.js';
import {
  logShadowMismatchCodes,
  planMismatchCodes,
} from '../rollout/shadowComparison.js';

const router = Router();
router.use(authRequired);

const salaryBillMutationService = createSalaryBillMutationService();
const expenseMutationService = createExpenseMutationService();
const goalMutationService = createGoalMutationService();

function mutationErrorBody(error) {
  const responseError = { code: error.code, message: error.message };
  for (const field of ['field', 'constraint', 'currentRecordVersion', 'errors']) {
    if (Object.hasOwn(error, field)) responseError[field] = error[field];
  }
  return { error: responseError };
}

function sendMutationError(res, error) {
  if (!(error instanceof FinancialMutationError)) return false;
  res.status(error.httpStatus).json(mutationErrorBody(error));
  return true;
}

async function snapshotBeforeMutation(userId, month) {
  try {
    return await clarityService.getSnapshot({
      userId,
      month,
      now: new Date(),
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return null;
  }
}

function availableMonthlyValues(snapshot) {
  const outcome = snapshot?.outcomes?.monthlyPlan;
  return outcome?.status === 'available' ? outcome.value : null;
}

function buildPlanDeltas({ precedingSnapshot, resultingSnapshot, month, salaryMutation }) {
  const resulting = availableMonthlyValues(resultingSnapshot);
  let preceding = availableMonthlyValues(precedingSnapshot);
  if (!preceding && salaryMutation) {
    preceding = {
      disposableIncome: { amountMinor: 0 },
      dailySpendingGuide: { amountMinor: 0 },
    };
  }
  if (!preceding || !resulting) {
    return {
      status: 'unavailable',
      month,
      reason: 'A valid confirmed salary is required before plan deltas are available.',
    };
  }
  return {
    status: 'available',
    month,
    disposableIncomeMinor:
      resulting.disposableIncome.amountMinor - preceding.disposableIncome.amountMinor,
    dailySpendingGuideMinor:
      resulting.dailySpendingGuide.amountMinor - preceding.dailySpendingGuide.amountMinor,
  };
}

function mutationContract({
  envelope,
  precedingSnapshot,
  month,
  acceptedConstraints,
  salaryMutation = false,
  record,
}) {
  return {
    schemaVersion: envelope.schemaVersion,
    mutation: {
      ...envelope.mutation,
      planDeltas: buildPlanDeltas({
        precedingSnapshot,
        resultingSnapshot: envelope.clarity,
        month,
        salaryMutation,
      }),
      acceptedConstraints,
      ...(record === undefined ? {} : { record }),
    },
    clarity: envelope.clarity,
  };
}

async function loadSalaryRow(userId, month) {
  return db.prepare(
    `SELECT id, month, amount
       FROM salary_entries
      WHERE user_id = ? AND month = ?`
  ).get(userId, month);
}

async function loadBillRow(userId, id) {
  return db.prepare(
    `SELECT id, label, amount, category, active,
            effective_from_month, effective_to_month
       FROM emis
      WHERE user_id = ? AND id = ?`
  ).get(userId, id);
}

async function loadExpenseRow(userId, id) {
  return db.prepare(
    `SELECT id, month, category, amount, note, spent_on
       FROM expense_log
      WHERE user_id = ? AND id = ?`
  ).get(userId, id);
}

async function loadCategoryTreatmentRow(userId, category) {
  return db.prepare(
    `SELECT id, category, treatment
       FROM expense_category_treatments
      WHERE user_id = ? AND category = ?`
  ).get(userId, category);
}

function legacyExpenseRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    month: record.month,
    category: record.category,
    amount: record.amountMinor / 100,
    note: record.note,
    spent_on: record.spentOn,
  };
}

function expenseMutationContract({ envelope, record, fallbackTransition = null }) {
  const transition = envelope.mutation.result ?? fallbackTransition;
  return {
    schemaVersion: envelope.schemaVersion,
    mutation: {
      ...envelope.mutation,
      acceptedConstraints: EXPENSE_ACCEPTED_CONSTRAINTS,
      record,
      ...(transition ? {
        expenseTransition: transition,
        originalPeriod: transition.originalPeriod,
        resultingPeriod: transition.resultingPeriod,
        originalCategory: transition.originalCategory,
        resultingCategory: transition.resultingCategory,
        affectedPeriods: transition.affectedPeriods,
        affectedCategories: transition.affectedCategories,
      } : {}),
    },
    clarity: envelope.clarity,
  };
}

function categoryTreatmentMutationContract({ envelope, record }) {
  const transition = envelope.mutation.result;
  return {
    schemaVersion: envelope.schemaVersion,
    mutation: {
      ...envelope.mutation,
      acceptedConstraints: CATEGORY_TREATMENT_ACCEPTED_CONSTRAINTS,
      record,
      ...(transition ? { categoryTreatmentTransition: transition } : {}),
    },
    clarity: envelope.clarity,
  };
}

const clarityFinancialInputDataUseGate = createDataUseNoticeGate({
  appliesTo: requestsClarityContract,
});
const currentFinancialDataUseGate = createDataUseNoticeGate();
const newClaritySalaryDataUseGate = createDataUseNoticeGate({
  appliesTo: async (req) => {
    if (!requestsClarityContract(req)) return false;
    const month = typeof req.body?.month === 'string' ? req.body.month : monthKey();
    return !(await loadSalaryRow(req.user.id, month));
  },
});

// All of these use the Date getters (not toISOString), so they respect the
// server's configured TZ (set to Asia/Kolkata in render.yaml). This keeps the
// expense/month tagging aligned with the IST frontend across midnight.
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    // Clamp to the real last day of THIS month (28/29/30/31 as applicable),
    // not a hardcoded 28 — rent-due-on-the-30th shouldn't post on the 28th
    // every month, only in February.
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const day = Math.min(Math.max(1, Number(r.day_of_month) || 1), lastDay);
    const spentOn = `${month}-${String(day).padStart(2, '0')}`;
    try {
      // Claim this (recurring_id, month) slot FIRST via a conditional UPDATE.
      // Only one concurrent caller will see `changes > 0`; the others see 0
      // and skip the insert — prevents the double-materialize race when the
      // Dashboard fetches /plan, /recurring, /salary in parallel on month-1.
      const claim = await db
        .prepare(
          `UPDATE recurring_expenses
              SET last_logged_month = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND (last_logged_month IS NULL OR last_logged_month != ?)`
        )
        .run(month, r.id, userId, month);
      if (!claim.changes) continue;
      await db
        .prepare(
          `INSERT INTO expense_log (user_id, month, category, amount, note, spent_on)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(userId, month, r.category, Number(r.amount), `${r.label} (recurring)`, spentOn);
    } catch (e) {
      logBackgroundFailure('recurring_materialize', e, {
        recordType: 'recurring',
        recordId: Number.isSafeInteger(r.id) && r.id > 0 ? r.id : undefined,
      });
    }
  }
}

router.post(
  '/salary',
  [
    body('amount').isFloat({ min: 0, max: 1e12 }),
    body('month').optional().matches(/^\d{4}-\d{2}$/),
    newClaritySalaryDataUseGate,
  ],
  async (req, res) => {
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeSalaryCommand(req.body);
        const precedingSnapshot = await snapshotBeforeMutation(req.user.id, command.month);
        const envelope = await salaryBillMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'salary.upsert',
          command,
          expectedRecordVersion,
        });
        const row = await loadSalaryRow(req.user.id, command.month);
        const record = salaryRecordFromRow(row);
        const legacyResponse = {
          ok: true,
          month: command.month,
          amount: record.amountMinor / 100,
        };
        return res.json(negotiateClarityContract(req, legacyResponse, mutationContract({
          envelope,
          precedingSnapshot,
          month: command.month,
          acceptedConstraints: SALARY_ACCEPTED_CONSTRAINTS,
          salaryMutation: true,
          record,
        })));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

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
    return res.json({ ok: true, month, amount });
  }
);

router.post('/salary/apply', currentFinancialDataUseGate, async (req, res) => {
  try {
    const { command, expectedRecordVersion } = normalizeSalaryApplyCommand(req.body);
    const precedingSnapshot = await snapshotBeforeMutation(req.user.id, command.targetMonth);
    const envelope = await salaryBillMutationService.execute({
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'salary.apply',
      command,
      expectedRecordVersion,
    });
    const row = await loadSalaryRow(req.user.id, command.targetMonth);
    const record = salaryRecordFromRow(row);
    return res.json({
      ok: true,
      sourceMonth: command.sourceMonth,
      targetMonth: command.targetMonth,
      month: command.targetMonth,
      amount: record.amountMinor / 100,
      ...mutationContract({
        envelope,
        precedingSnapshot,
        month: command.targetMonth,
        acceptedConstraints: SALARY_APPLY_ACCEPTED_CONSTRAINTS,
        salaryMutation: true,
        record,
      }),
    });
  } catch (error) {
    if (sendMutationError(res, error)) return;
    throw error;
  }
});

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
    clarityFinancialInputDataUseGate,
  ],
  async (req, res) => {
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeBillCreateCommand(req.body);
        const precedingSnapshot = await snapshotBeforeMutation(
          req.user.id,
          command.snapshotMonth
        );
        const envelope = await salaryBillMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'bill.create',
          command,
          expectedRecordVersion,
        });
        const record = billRecordFromRow(await loadBillRow(
          req.user.id,
          envelope.mutation.recordId
        ));
        envelope.mutation.scopeKey = `bill:${envelope.mutation.recordId}`;
        return res.json(negotiateClarityContract(req, {
          id: envelope.mutation.recordId,
        }, mutationContract({
          envelope,
          precedingSnapshot,
          month: command.snapshotMonth,
          acceptedConstraints: BILL_ACCEPTED_CONSTRAINTS,
          record,
        })));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const { label, amount, category } = req.body;
    const info = await db
      .prepare('INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)')
      .run(req.user.id, label, Number(amount), category);
    return res.json({ id: info.lastInsertRowid });
  }
);

router.get('/emis', async (req, res) => {
  const rows = await db
    .prepare('SELECT id, label, amount, category FROM emis WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ emis: rows });
});

// Inline edit — change label / amount / category on an existing bill without
// deleting and re-adding. Partial updates allowed; only sent fields are
// touched. Scoped to the caller's own rows.
router.patch(
  '/emis/:id',
  [
    body('label').optional().isString().trim().isLength({ min: 1, max: 60 }),
    body('amount').optional().isFloat({ min: 0, max: 1e12 }),
    body('category').optional().isString().isIn(['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other']),
  ],
  async (req, res) => {
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeBillUpdateCommand(
          req.body,
          req.params.id
        );
        const precedingSnapshot = await snapshotBeforeMutation(
          req.user.id,
          command.snapshotMonth
        );
        const envelope = await salaryBillMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'bill.update',
          command,
          expectedRecordVersion,
        });
        const row = await loadBillRow(req.user.id, command.id);
        const record = billRecordFromRow(row);
        const legacyResponse = {
          ok: true,
          emi: {
            id: Number(row.id),
            label: row.label,
            amount: Number(row.amount),
            category: row.category,
          },
        };
        return res.json(negotiateClarityContract(req, legacyResponse, mutationContract({
          envelope,
          precedingSnapshot,
          month: command.snapshotMonth,
          acceptedConstraints: BILL_ACCEPTED_CONSTRAINTS,
          record,
        })));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const owned = await db.prepare('SELECT 1 AS ok FROM emis WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Not found' });
    const sets = [];
    const args = [];
    if (typeof req.body.label === 'string') { sets.push('label = ?'); args.push(req.body.label.trim()); }
    if (req.body.amount != null) { sets.push('amount = ?'); args.push(Number(req.body.amount)); }
    if (typeof req.body.category === 'string') { sets.push('category = ?'); args.push(req.body.category); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    args.push(id, req.user.id);
    await db.prepare(`UPDATE emis SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...args);
    const row = await db
      .prepare('SELECT id, label, amount, category FROM emis WHERE id = ?')
      .get(id);
    return res.json({ ok: true, emi: row });
  }
);

router.delete('/emis/:id', async (req, res) => {
  if (requestsClarityContract(req)) {
    try {
      const { command, expectedRecordVersion } = normalizeBillDeleteCommand(
        req.body,
        req.params.id
      );
      const precedingSnapshot = await snapshotBeforeMutation(
        req.user.id,
        command.snapshotMonth
      );
      const envelope = await salaryBillMutationService.execute({
        userId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        operation: 'bill.delete',
        command,
        expectedRecordVersion,
      });
      return res.json(negotiateClarityContract(req, { ok: true }, mutationContract({
        envelope,
        precedingSnapshot,
        month: command.snapshotMonth,
        acceptedConstraints: BILL_ACCEPTED_CONSTRAINTS,
        record: null,
      })));
    } catch (error) {
      if (sendMutationError(res, error)) return;
      throw error;
    }
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  await db.prepare('DELETE FROM emis WHERE id = ? AND user_id = ?').run(id, req.user.id);
  return res.json({ ok: true });
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
  const legacyResponse = {
    income,
    emiTotal,
    afterFixed,
    breakdown: { needs, wants, save },
    month,
    spentThisMonth,
    byCategory,
    tips,
  };

  const { clarityShadowCompare } = readServerFeatureFlags();
  const contractRequested = requestsClarityContract(req);
  if (!clarityShadowCompare && !contractRequested) {
    return res.json(legacyResponse);
  }

  let clarity = null;
  try {
    clarity = await clarityService.getSnapshot({
      userId: req.user.id,
      month,
      now: new Date(),
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    if (clarityShadowCompare) {
      logShadowMismatchCodes(['PLAN_CANONICAL_UNAVAILABLE']);
    }
    // Shadow work must never alter the selected legacy read path. During a
    // negotiated rollout, the unchanged top-level response also lets the old
    // UI continue safely if the additive snapshot is temporarily unavailable.
    return res.json(legacyResponse);
  }

  if (clarityShadowCompare) {
    logShadowMismatchCodes(planMismatchCodes(clarity, legacyResponse));
  }

  return res.json(negotiateClarityContract(req, legacyResponse, {
    schemaVersion: 1,
    clarity,
  }));
});

// ---------- Expense log ----------

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
    body('spentOn').optional().custom((v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const d = new Date(`${v}T00:00:00`);
      if (isNaN(d.getTime())) return false;
      // Reject nonsense like 2026-02-30 (where Date auto-rolls to March).
      if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== v) return false;
      const year = d.getFullYear();
      const nowYear = new Date().getFullYear();
      // Keep the range sane: last ~10 years, up to next year.
      return year >= nowYear - 10 && year <= nowYear + 1;
    }).withMessage('Pick a valid date in the last decade.'),
    clarityFinancialInputDataUseGate,
  ],
  async (req, res) => {
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeExpenseCreateCommand(req.body);
        const envelope = await expenseMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'expense.create',
          command,
          expectedRecordVersion,
        });
        const row = await loadExpenseRow(req.user.id, envelope.mutation.recordId);
        const record = expenseRecordFromRow(row);
        const legacyResponse = { id: record.id, month: record.month };
        return res.json(negotiateClarityContract(
          req,
          legacyResponse,
          expenseMutationContract({
            envelope,
            record,
            fallbackTransition: {
              type: 'create',
              status: 'confirmed',
              originalPeriod: null,
              resultingPeriod: record.month,
              originalCategory: null,
              resultingCategory: record.category,
              affectedPeriods: [record.month],
              affectedCategories: [record.category],
              affectedPartitions: [],
            },
          })
        ));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const allowed = await allowedCategoriesFor(req.user.id);
    if (!allowed.includes(req.body.category))
      return res.status(400).json({ error: 'Unknown category — add it in Settings first.' });
    const spentOn = req.body.spentOn || todayISO();
    const month = spentOn.slice(0, 7);
    const info = await db
      .prepare(
        'INSERT INTO expense_log (user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(req.user.id, month, req.body.category, Number(req.body.amount), req.body.note?.trim() || null, spentOn);
    res.json({ id: info.lastInsertRowid, month });
  }
);

// Logging streak: how many consecutive days (ending today in server TZ)
// the user has logged at least one expense, plus their longest-ever streak.
// Computed on the fly from distinct spent_on days — no new table needed.
// Intentionally skips materializeRecurring; the Dashboard's /plan call
// handles that, so a recurring auto-log counts toward the streak on the
// next page load. Keeps this endpoint read-only and cheap.
router.get('/streak', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT COALESCE(
                 spent_on,
                 substr(datetime(created_at,'+5 hours','+30 minutes'), 1, 10)
               ) AS day
         FROM expense_log
        WHERE user_id = ?
        GROUP BY day
        ORDER BY day DESC
        LIMIT 400`
    )
    .all(req.user.id);
  const days = rows.map((r) => String(r.day));
  const todayStr = todayISO();
  const yesterdayStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return todayISO(d);
  })();
  let current = 0;
  if (days[0] === todayStr || days[0] === yesterdayStr) {
    // Anchor streak to today when today has a log, else to yesterday so a
    // user who hasn't logged yet today still sees their streak until EOD.
    let cursor = days[0] === todayStr ? todayStr : yesterdayStr;
    for (const d of days) {
      if (d !== cursor) break;
      current++;
      // Build previous day via Date components (TZ-safe) rather than parsing
      // "YYYY-MM-DDT00:00:00", which Node interprets in local TZ.
      const [y, m, dd] = cursor.split('-').map(Number);
      const prev = new Date(y, m - 1, dd);
      prev.setDate(prev.getDate() - 1);
      cursor = todayISO(prev);
    }
  }
  // Longest streak: walk the sorted list and count runs of consecutive dates.
  let longest = 0;
  let run = 0;
  let prev = null;
  const sorted = [...days].sort(); // ascending
  for (const d of sorted) {
    if (prev === null) {
      run = 1;
    } else {
      const [py, pm, pd] = prev.split('-').map(Number);
      const prevDate = new Date(py, pm - 1, pd);
      prevDate.setDate(prevDate.getDate() + 1);
      run = todayISO(prevDate) === d ? run + 1 : 1;
    }
    if (run > longest) longest = run;
    prev = d;
  }
  res.json({ current, longest, days_logged: days.length });
});

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
    // Case-insensitive dedup on user_categories — SQLite's UNIQUE constraint
    // is case-sensitive by default, which would otherwise let "Pets" and
    // "pets" and "PETS" all exist for the same user.
    const dupe = await db
      .prepare('SELECT 1 AS ok FROM user_categories WHERE user_id = ? AND lower(name) = lower(?)')
      .get(req.user.id, name);
    if (dupe) return res.status(409).json({ error: 'You already have this category.' });
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

router.patch('/expenses/:id', async (req, res) => {
  try {
    const { command, expectedRecordVersion } = normalizeExpenseUpdateCommand(
      req.body,
      req.params.id
    );
    const envelope = await expenseMutationService.execute({
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'expense.update',
      command,
      expectedRecordVersion,
    });
    const row = await loadExpenseRow(req.user.id, command.id);
    const record = expenseRecordFromRow(row);
    const legacyResponse = { ok: true, expense: legacyExpenseRecord(record) };
    return res.json({
      ...legacyResponse,
      ...expenseMutationContract({
        envelope,
        record,
        fallbackTransition: {
          type: 'update',
          status: 'confirmed',
          originalPeriod: null,
          resultingPeriod: record.month,
          originalCategory: null,
          resultingCategory: record.category,
          affectedPeriods: [record.month],
          affectedCategories: [record.category],
          affectedPartitions: [],
        },
      }),
    });
  } catch (error) {
    if (sendMutationError(res, error)) return;
    throw error;
  }
});

router.put('/category-treatments/:category', async (req, res) => {
  try {
    const { command, expectedRecordVersion } = normalizeCategoryTreatmentSetCommand(
      req.body,
      req.params.category
    );
    const envelope = await expenseMutationService.execute({
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'category_treatment.set',
      command,
      expectedRecordVersion,
    });
    const row = await loadCategoryTreatmentRow(req.user.id, command.category);
    const record = categoryTreatmentRecordFromRow(row);
    const legacyResponse = {
      ok: true,
      category: record.category,
      treatment: record.treatment,
    };
    return res.json({
      ...legacyResponse,
      ...categoryTreatmentMutationContract({ envelope, record }),
    });
  } catch (error) {
    if (sendMutationError(res, error)) return;
    throw error;
  }
});

router.delete('/category-treatments/:category', async (req, res) => {
  try {
    const { command, expectedRecordVersion } = normalizeCategoryTreatmentDeleteCommand(
      req.body,
      req.params.category
    );
    const envelope = await expenseMutationService.execute({
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'category_treatment.remove',
      command,
      expectedRecordVersion,
    });
    const transition = envelope.mutation.result;
    const legacyResponse = {
      ok: true,
      category: command.category,
      treatment: transition?.resultingTreatment ?? null,
    };
    return res.json({
      ...legacyResponse,
      ...categoryTreatmentMutationContract({ envelope, record: null }),
    });
  } catch (error) {
    if (sendMutationError(res, error)) return;
    throw error;
  }
});

router.delete('/expenses/:id', async (req, res) => {
  if (requestsClarityContract(req)) {
    try {
      const { command, expectedRecordVersion } = normalizeExpenseDeleteCommand(
        req.body,
        req.params.id
      );
      const original = expenseRecordFromRow(await loadExpenseRow(req.user.id, command.id));
      const envelope = await expenseMutationService.execute({
        userId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        operation: 'expense.delete',
        command,
        expectedRecordVersion,
      });
      return res.json(negotiateClarityContract(
        req,
        { ok: true },
        expenseMutationContract({
          envelope,
          record: null,
          fallbackTransition: original ? {
            type: 'delete',
            status: 'confirmed',
            originalPeriod: original.month,
            resultingPeriod: null,
            originalCategory: original.category,
            resultingCategory: null,
            affectedPeriods: [original.month],
            affectedCategories: [original.category],
            affectedPartitions: [],
          } : null,
        })
      ));
    } catch (error) {
      if (sendMutationError(res, error)) return;
      throw error;
    }
  }

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
    const allowed = await allowedCategoriesFor(req.user.id);
    if (!allowed.includes(category))
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
function goalMutationContract({
  envelope,
  record,
  acceptedConstraints = GOAL_ACCEPTED_CONSTRAINTS,
}) {
  return {
    schemaVersion: envelope.schemaVersion,
    mutation: {
      ...envelope.mutation,
      acceptedConstraints,
      record,
      ...(envelope.mutation.result ? { goalTransition: envelope.mutation.result } : {}),
    },
    clarity: envelope.clarity,
  };
}

// Legacy (non-contract) goal requests keep their `{ error: string }` shape.
function sendLegacyGoalError(res, error) {
  if (!(error instanceof FinancialMutationError)) return false;
  res.status(error.httpStatus === 404 ? 404 : 400).json({ error: error.message });
  return true;
}

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
    clarityFinancialInputDataUseGate,
  ],
  async (req, res) => {
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeGoalCreateCommand(req.body);
        const envelope = await goalMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'goal.create',
          command,
          expectedRecordVersion,
        });
        const row = await loadGoalRow(db, req.user.id, envelope.mutation.recordId);
        return res.json(negotiateClarityContract(
          req,
          { id: envelope.mutation.recordId },
          goalMutationContract({ envelope, record: goalRecordFromRow(row) })
        ));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const created = await createGoalLegacy({ userId: req.user.id, body: req.body });
      return res.json(created);
    } catch (error) {
      if (sendLegacyGoalError(res, error)) return;
      throw error;
    }
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
    // Edits are corrections, so no data-use gate is declared here.
    if (requestsClarityContract(req)) {
      try {
        const { command, expectedRecordVersion } = normalizeGoalUpdateCommand(
          req.body,
          req.params.id
        );
        const envelope = await goalMutationService.execute({
          userId: req.user.id,
          idempotencyKey: req.get('Idempotency-Key'),
          operation: 'goal.update',
          command,
          expectedRecordVersion,
        });
        const row = await loadGoalRow(db, req.user.id, command.id);
        return res.json(negotiateClarityContract(
          req,
          { ok: true },
          goalMutationContract({ envelope, record: goalRecordFromRow(row) })
        ));
      } catch (error) {
        if (sendMutationError(res, error)) return;
        throw error;
      }
    }

    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const updated = await patchGoalLegacy({ userId: req.user.id, id, body: req.body });
      if (!updated) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (error) {
      if (sendLegacyGoalError(res, error)) return;
      throw error;
    }
  }
);

router.delete('/goals/:id', async (req, res) => {
  if (requestsClarityContract(req)) {
    try {
      const { command, expectedRecordVersion } = normalizeGoalDeleteCommand(
        req.body,
        req.params.id
      );
      const envelope = await goalMutationService.execute({
        userId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        operation: 'goal.delete',
        command,
        expectedRecordVersion,
      });
      return res.json(negotiateClarityContract(
        req,
        { ok: true },
        goalMutationContract({ envelope, record: null })
      ));
    } catch (error) {
      if (sendMutationError(res, error)) return;
      throw error;
    }
  }

  const id = Number(req.params.id);
  const info = await db
    .prepare('DELETE FROM savings_goals WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Always a new-use clarity submission, so the notice gate is declared like
// POST /salary/apply. Corrections of a wrong amount use PATCH, never a
// negative contribution.
router.post('/goals/:id/contributions', currentFinancialDataUseGate, async (req, res) => {
  try {
    const { command, expectedRecordVersion } = normalizeGoalContributionCommand(
      req.body,
      req.params.id
    );
    const envelope = await goalMutationService.execute({
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'goal.contribute',
      command,
      expectedRecordVersion,
    });
    const row = await loadGoalRow(db, req.user.id, command.id);
    return res.json({
      ok: true,
      goal: legacyGoalFromRow(row),
      ...goalMutationContract({
        envelope,
        record: goalRecordFromRow(row),
        acceptedConstraints: GOAL_CONTRIBUTION_ACCEPTED_CONSTRAINTS,
      }),
    });
  } catch (error) {
    if (sendMutationError(res, error)) return;
    throw error;
  }
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
    clarityFinancialInputDataUseGate,
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
  let s = String(v);
  // CSV formula-injection guard: Excel/Sheets treat =, +, -, @, and TAB as
  // formula triggers. Prefix with a single quote so the cell renders as text.
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/export.csv', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT spent_on, created_at, month, category, amount, note
         FROM expense_log WHERE user_id = ?
        ORDER BY COALESCE(spent_on, substr(created_at, 1, 10)) ASC, id ASC`
    )
    .all(req.user.id);
  const header = ['date', 'month', 'category', 'amount', 'note'];
  const lines = [header.join(',')];
  for (const r of rows) {
    // SQLite's CURRENT_TIMESTAMP is always UTC regardless of TZ env, so when
    // we fall back to created_at we parse through a Date so the server's
    // configured TZ (Asia/Kolkata) gives us the user's actual local day.
    let date = r.spent_on;
    if (!date && r.created_at) {
      const d = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
      if (!isNaN(d.getTime())) {
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
    const row = { date, month: r.month, category: r.category, amount: r.amount, note: r.note };
    lines.push(header.map((h) => csvEscape(row[h])).join(','));
  }
  const filename = `project-money-expenses-${todayISO()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n') + '\n');
});

export default router;
