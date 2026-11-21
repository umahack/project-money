// The legacy (flag off) read and write routes, served from the same `FakeWorld` the clarity routes use.
//
// This is what rollback means on the server: the legacy routes read and write the same source rows
// (salary, bills, expenses, goals, trips), the clarity contract is not used, and the feature rows
// (journey, receipts, category treatments, personal trip links, measurement) are neither read nor
// changed. Like the real legacy routes, a legacy write changes source rows only: it writes no receipt
// and does not move the clarity data version (backend/test/api/rolloutRollback.integration.test.js).
import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';
import type { FakeWorld } from './worldApi';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const rupees = (minor: number) => minor / 100;

/** `GET /api/finance/plan` as the legacy route answers it. Whole-rupee rounding is the legacy rule. */
function legacyPlan(world: FakeWorld) {
  const income = rupees(world.plan.salary?.amountMinor ?? 0);
  const bills = world.plan.bills.filter((bill) => bill.active);
  const emiTotal = rupees(bills.reduce((sum, bill) => sum + bill.amountMinor, 0));
  const afterFixed = Math.max(income - emiTotal, 0);
  const needs = Math.round(afterFixed * 0.5);
  const wants = Math.round(afterFixed * 0.3);
  const rows = world.spending.expenses.filter((expense) => expense.month === world.month);
  const byCategory: Record<string, number> = {};
  for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + rupees(row.amountMinor);
  return {
    income,
    emiTotal,
    afterFixed,
    breakdown: { needs, wants, save: afterFixed - needs - wants },
    month: world.month,
    spentThisMonth: rows.reduce((sum, row) => sum + rupees(row.amountMinor), 0),
    byCategory,
    tips: ['Keep an emergency fund of 6 months of fixed expenses in a liquid account.'],
  };
}

/**
 * Installs the legacy API. A request the legacy client should never make (anything under `/clarity` or
 * `/finance/clarity`) is answered 404 and recorded by the fixture, so a spec can assert there were none.
 */
export function installLegacyWorld(api: DeterministicApiFixtures, world: FakeWorld): void {
  const respond = (request: RecordedApiRequest) => {
    const url = new URL(request.path, 'http://fixture.invalid');
    const path = url.pathname.replace(/^\/api/, '');
    const body = asRecord(request.body);
    const method = request.method;
    if (/^\/(?:clarity\/|finance\/clarity|finance\/explanations)/.test(path)) {
      return { status: 404, json: { error: 'Not found' } };
    }

    if (method === 'GET' && path === '/finance/plan') return { status: 200, json: legacyPlan(world) };
    if (method === 'POST' && path === '/finance/salary') {
      const amount = Number(body.amount);
      const month = typeof body.month === 'string' ? body.month : world.month;
      const existing = world.plan.salary;
      world.plan.salary = { id: existing?.id ?? 5, month, amountMinor: Math.round(amount * 100), version: existing?.version ?? 1 };
      return { status: 200, json: { ok: true, month, amount } };
    }
    if (method === 'POST' && path === '/finance/expenses') {
      const amount = Number(body.amount);
      const category = String(body.category);
      const id = Math.max(0, ...world.spending.expenses.map((row) => row.id)) + 1;
      const spentOn = typeof body.spentOn === 'string' ? body.spentOn : `${world.month}-10`;
      world.spending.expenses.push({
        id,
        month: spentOn.slice(0, 7),
        category,
        amountMinor: Math.round(amount * 100),
        note: typeof body.note === 'string' ? body.note : null,
        spentOn,
        version: 1,
      });
      return { status: 200, json: { id, month: spentOn.slice(0, 7) } };
    }
    const expense = /^\/finance\/expenses\/(\d+)$/.exec(path);
    if (method === 'DELETE' && expense) {
      const index = world.spending.expenses.findIndex((row) => row.id === Number(expense[1]));
      if (index < 0) return { status: 404, json: { error: 'Not found' } };
      world.spending.expenses.splice(index, 1);
      return { status: 200, json: { ok: true } };
    }
    const goal = /^\/finance\/goals\/(\d+)$/.exec(path);
    if (method === 'PATCH' && goal) {
      const row = world.goals.find(Number(goal[1]));
      if (!row) return { status: 404, json: { error: 'Not found' } };
      if (typeof body.addToSaved === 'number') {
        row.savedMinor = Math.min(row.targetMinor, Math.max(0, row.savedMinor + Math.round(body.addToSaved * 100)));
      }
      return { status: 200, json: { ok: true } };
    }

    // Every other legacy read is the shared source data, exactly as the fakes hold it.
    if (method === 'GET') {
      const reply = world.handle({ method, path, query: url.searchParams, body: request.body });
      return reply ? { status: reply.status, json: reply.body } : null;
    }
    return null;
  };
  api.fallback(respond);
}
