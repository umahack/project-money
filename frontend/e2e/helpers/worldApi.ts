// One connected, in-memory financial world for the final acceptance specs (task 17.5).
//
// The per-page fakes (FakeClarityBackend for pay and bills, FakeSpendingBackend, FakeGoalsBackend,
// FakeTripsBackend, FakeJourneyServer) each calculate their own page's outcomes and fill the rest of
// the snapshot with fixed placeholders. A first-session story crosses all of them, so this module
// composes them behind one `handle()`:
//
// - every request goes to the fake that owns the route, so each record rule is the fake's;
// - after every confirmed change one shared `dataVersion` moves forward by one for every fake, and the
//   fakes' derived inputs follow the confirmed records (the Needs and Wants budgets and the savings
//   target come from the confirmed pay and bills; a trip share included in monthly spending becomes an
//   expense row);
// - `GET /finance/clarity` and the snapshot inside every mutation response are one merged snapshot:
//   each region comes from the fake that owns it, the actions are ranked as the server ranks them
//   (earliest deadline, largest shortfall, largest absolute effect, label) and cut to three;
// - the data-use notice starts unacknowledged, and a new financial entry before it is acknowledged is
//   refused with 428 DATA_NOTICE_REQUIRED, as the server does.
//
// Nothing here reads a clock, the network, or a database. It adds no new financial rule: the arithmetic
// stays in the fakes that already play the server for each page.
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeClarityBackend, type FakeBackendInit } from '../../src/test/fakeClarityBackend';
import { FakeGoalsBackend, type FakeGoalsInit } from '../../src/test/fakeGoalsBackend';
import { FakeJourneyServer } from '../../src/test/fakeJourneyServer';
import { BILLS_ACTION, NEEDS_ACTION, WANTS_ACTION } from '../../src/test/homeSummaryFixtures';
import { FakeSpendingBackend, type FakeSpendingInit } from '../../src/test/fakeSpendingBackend';
import { FakeTripsBackend, type FakeTripsInit } from '../../src/test/fakeTripsBackend';
import type { ActionableInsight, FinancialSnapshot, MoneyValue } from '../../src/clarity/contracts';
import type { DeterministicApiFixtures, RecordedApiRequest } from '../fixtures/test';

export interface WorldInit {
  month: string;
  viewer: string;
  /** Categories offered to expenses and to a trip share included in monthly spending. */
  categories: string[];
  plan?: FakeBackendInit;
  spending?: FakeSpendingInit;
  goals?: FakeGoalsInit;
  trips: FakeTripsInit;
}

export interface WorldReply {
  status: number;
  body: unknown;
}

const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const FINANCIAL_WRITE = /^\/(?:finance|trips)(?:\/|$)/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The server's action order: a deadline first, then the larger shortfall, the larger effect, and the label. */
export function rankActions(actions: ActionableInsight[]): ActionableInsight[] {
  const absolute = (value?: MoneyValue) => Math.abs(value?.amountMinor ?? 0);
  return [...actions].sort((a, b) => {
    if (Boolean(a.deadline) !== Boolean(b.deadline)) return a.deadline ? -1 : 1;
    if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    const shortfall = absolute(b.shortfall) - absolute(a.shortfall);
    if (shortfall !== 0) return shortfall;
    const effect = absolute(b.effect) - absolute(a.effect);
    if (effect !== 0) return effect;
    return a.actionLabel.localeCompare(b.actionLabel, 'en');
  });
}

export class FakeWorld {
  readonly month: string;
  readonly plan: FakeClarityBackend;
  readonly spending: FakeSpendingBackend;
  readonly goals: FakeGoalsBackend;
  readonly trips: FakeTripsBackend;
  readonly journey = new FakeJourneyServer();
  /** The one data version every fake reports. */
  version = 1;
  noticeAcknowledged = false;
  analyticsEnabled = false;
  /** Product Analytics events the browser sent. The fixture user never opts in, so this stays empty. */
  readonly events: unknown[] = [];
  /** Every request the world answered, in order, as `METHOD path`. */
  readonly log: string[] = [];

  constructor(init: WorldInit) {
    this.month = init.month;
    this.plan = new FakeClarityBackend(init.month, init.plan ?? {});
    this.spending = new FakeSpendingBackend(init.month, { categories: init.categories, ...init.spending });
    this.goals = new FakeGoalsBackend(init.month, { savingsTarget: null, ...init.goals });
    this.trips = new FakeTripsBackend(init.month, { categories: init.categories, ...init.trips, viewer: init.viewer });
    this.sync();
  }

  // ---- derived state ----

  /** Moves every fake to the shared version and recomputes the inputs that follow confirmed records. */
  private sync(): void {
    this.plan.dataVersion = this.version;
    this.spending.dataVersion = this.version;
    this.goals.dataVersion = this.version;
    this.trips.account().dataVersion = this.version;
    const planValue = this.plan.snapshot().outcomes.monthlyPlan.value;
    if (planValue) {
      this.spending.needsBudget = planValue.needsBudget.amountMinor / 100;
      this.spending.wantsBudget = planValue.wantsBudget.amountMinor / 100;
      this.goals.savingsTargetMinor = planValue.savingsTarget.amountMinor;
    } else {
      this.goals.savingsTargetMinor = null;
    }
    this.journey.satisfied.clear();
    if (this.plan.salary) this.journey.satisfied.add('salary');
    if (this.plan.bills.length > 0) this.journey.satisfied.add('bills');
    if (this.spending.expenses.length > 0) this.journey.satisfied.add('expense');
    if (this.goals.goals.length > 0) this.journey.satisfied.add('goal');
  }

  /** The confirmed snapshot: each region from the fake that owns it. */
  snapshot(): FinancialSnapshot {
    this.sync();
    const plan = this.plan.snapshot();
    const spending = this.spending.snapshot();
    const goals = this.goals.snapshot();
    const trips = this.trips.snapshot();
    const planOutcome = plan.outcomes.monthlyPlan;
    const planValue = planOutcome.value;
    const spendingValue = spending.outcomes.spending.value;
    let monthlyPlan = planOutcome;
    let spendingOutcome = plan.outcomes.spending;
    if (planValue && spendingValue) {
      // The spending fake plays a fixed 80,000 salary for projected savings; the world's pay and bills decide.
      const projected = Math.max(0, planValue.salary.amountMinor - planValue.activeBillsTotal.amountMinor - spendingValue.totalSpending.amountMinor);
      const value = {
        ...spendingValue,
        savingsTarget: planValue.savingsTarget,
        projectedSavings: money(projected),
        projectedSavingsDifference: money(projected - planValue.savingsTarget.amountMinor),
      };
      spendingOutcome = { ...spending.outcomes.spending, value };
      monthlyPlan = {
        ...planOutcome,
        value: {
          ...planValue,
          needsSpent: spendingValue.needsSpent,
          wantsSpent: spendingValue.wantsSpent,
          remainingSpendable: spendingValue.remainingSpendable,
          dailySpendingGuide: spendingValue.dailySpendingGuide,
          projectedSavings: money(projected),
        },
      };
    }
    const billsAction = plan.actions.filter((action) => action.id === BILLS_ACTION.id);
    const exceeded = (spendingOutcome.value?.exceededBudgetActions ?? []).map((entry) => ({
      ...(entry.bucket === 'needs' ? NEEDS_ACTION : WANTS_ACTION),
      shortfall: money(entry.excessMinor),
    }));
    const actions = rankActions([...billsAction, ...exceeded, ...goals.actions, ...trips.actions]).slice(0, 3);
    return {
      ...plan,
      dataVersion: this.version,
      highlights: {
        urgentGoal: goals.highlights?.urgentGoal ?? null,
        nearestTripSettlement: trips.highlights?.nearestTripSettlement ?? null,
      },
      outcomes: {
        monthlyPlan,
        spending: spendingOutcome,
        goals: goals.outcomes.goals,
        tripSummary: trips.outcomes.tripSummary,
      },
      actions,
    };
  }

  // ---- requests ----

  /** Returns null for a route no fake owns, so the browser fixture reports it as unhandled. */
  handle(request: { method: string; path: string; query?: URLSearchParams; body?: unknown }): WorldReply | null {
    const method = request.method.toUpperCase();
    const { path } = request;
    this.log.push(`${method} ${path}`);
    const body = asRecord(request.body);

    if (path === '/clarity/settings') return this.settings(method, body);
    if (path === '/clarity/events') {
      this.events.push(request.body);
      return { status: 204, body: {} };
    }
    if (path.startsWith('/clarity/journeys')) return this.journeyCall(method, path, request.body);
    if (path === '/invites') return { status: 200, body: { invites: [] } };
    if (path === '/finance/streak') return { status: 200, body: { current: 1, longest: 1, days_logged: 1 } };
    if (method === 'GET' && path === '/finance/clarity') {
      const requested = request.query?.get('month');
      if (requested && requested !== this.month) {
        return { status: 404, body: { error: { code: 'MONTH_NOT_FOUND', message: 'Only the fixture month is available.' } } };
      }
      return { status: 200, body: { schemaVersion: 1, snapshot: this.snapshot() } };
    }

    const owner = this.ownerOf(path);
    if (!owner) return null;
    this.sync();
    if (method !== 'GET' && method !== 'DELETE' && FINANCIAL_WRITE.test(path) && !this.noticeAcknowledged) {
      return {
        status: 428,
        body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Review and acknowledge the data-use notice before adding new entries.' } },
      };
    }
    if (method === 'GET') return owner.handle({ method, path, query: request.query, body: request.body });
    return this.mutate(owner, { method, path, query: request.query, body: request.body });
  }

  private ownerOf(path: string): FakeClarityBackend | FakeSpendingBackend | FakeGoalsBackend | FakeTripsBackend | null {
    if (/^\/finance\/(?:salary|emis)(?:\/|$)/.test(path)) return this.plan;
    if (/^\/finance\/(?:expenses|category-treatments|budgets|insights|history)(?:\/|$)/.test(path)) return this.spending;
    if (/^\/finance\/goals(?:\/|$)/.test(path)) return this.goals;
    if (/^\/trips(?:\/|$)/.test(path)) return this.trips;
    if (/^\/finance\/explanations\//.test(path)) return path.includes('goal%3A') || path.includes('goal:') ? this.goals : this.plan;
    return null;
  }

  private mutate(
    owner: FakeClarityBackend | FakeSpendingBackend | FakeGoalsBackend | FakeTripsBackend,
    request: { method: string; path: string; query?: URLSearchParams; body?: unknown },
  ): WorldReply {
    const personal = /^\/trips\/(\d+)\/expenses\/(\d+)\/personal-link$/.exec(request.path);
    const before = personal
      ? this.trips.account().links.find((link) => link.tripId === Number(personal[1]) && link.expenseId === Number(personal[2]))
      : undefined;
    const reply = owner.handle(request) as WorldReply;
    if (reply.status !== 200) return reply;

    this.version += 1;
    if (personal) this.bridgePersonalLink(Number(personal[1]), Number(personal[2]), request.method, before?.expenseLogId);
    this.sync();
    const envelope = asRecord(reply.body);
    if ('clarity' in envelope) return { status: 200, body: { ...envelope, clarity: this.snapshot() } };
    if (typeof envelope.dataVersion === 'number') return { status: 200, body: { ...envelope, dataVersion: this.version } };
    return reply;
  }

  /** A share included in monthly spending is one expense row, and withdrawing it removes that row. */
  private bridgePersonalLink(tripId: number, expenseId: number, method: string, removedLogId: number | undefined): void {
    const rows = this.spending.expenses;
    if (method === 'DELETE') {
      const index = rows.findIndex((row) => row.id === removedLogId);
      if (index >= 0) rows.splice(index, 1);
      return;
    }
    const link = this.trips.account().links.find((entry) => entry.tripId === tripId && entry.expenseId === expenseId);
    if (!link || rows.some((row) => row.id === link.expenseLogId)) return;
    rows.push({
      id: link.expenseLogId,
      month: link.spentOn.slice(0, 7),
      category: link.category,
      amountMinor: link.amountMinor,
      note: 'Trip share',
      spentOn: link.spentOn,
      version: 1,
    });
  }

  private settings(method: string, body: Record<string, unknown>): WorldReply {
    if (method === 'PATCH') {
      if (body.acknowledgedNoticeVersion === 1) this.noticeAcknowledged = true;
      if (typeof body.analyticsEnabled === 'boolean') {
        if (body.analyticsEnabled && !this.noticeAcknowledged) {
          return { status: 428, body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Acknowledge the notice first.' } } };
        }
        this.analyticsEnabled = body.analyticsEnabled;
      }
    }
    return { status: 200, body: buildSettings({ acknowledgedVersion: this.noticeAcknowledged ? 1 : 0, analyticsEnabled: this.analyticsEnabled }) };
  }

  private journeyCall(method: string, path: string, body: unknown): WorldReply | null {
    this.sync();
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const opensOrAdvances = method === 'POST' || (method === 'PATCH' && record?.action !== 'pause' && record?.action !== 'resume');
    if (opensOrAdvances && !this.noticeAcknowledged) {
      return { status: 428, body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Review and acknowledge the data-use notice first.' } } };
    }
    const reply = this.journey.handle({ method, path, body: record });
    return reply ? { status: reply.status, body: reply.body } : null;
  }
}

export interface WorldControl {
  world: FakeWorld;
  /** Holds the next `METHOD path` response until `release()`. The change is applied when it is released. */
  hold(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string): { release(): void };
}

/** Serves every API request the clarity pages make from one `FakeWorld`. Nothing leaves the browser fixture. */
export function installWorld(api: DeterministicApiFixtures, init: WorldInit): WorldControl {
  return installWorldFor(api, new FakeWorld(init));
}

/** Serves an existing world, so two browser origins (the flag-on and flag-off servers) can share one set of records. */
export function installWorldFor(api: DeterministicApiFixtures, world: FakeWorld): WorldControl {
  const respond = (request: RecordedApiRequest) => {
    const url = new URL(request.path, 'http://fixture.invalid');
    const reply = world.handle({
      method: request.method,
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: request.body,
    });
    if (reply === null) return null;
    return reply.status === 204 ? { status: 204 } : { status: reply.status, json: reply.body };
  };
  api.fallback(respond);
  return {
    world,
    hold(method, path) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.stubOnce(method, path, async (request) => {
        await gate;
        return respond(request) ?? { status: 404, json: { error: 'Not found' } };
      });
      return { release };
    },
  };
}
