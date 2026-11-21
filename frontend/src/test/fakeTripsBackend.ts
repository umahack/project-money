// A closed, in-memory stand-in for the trip endpoints and snapshot reads of the
// financial clarity contract (contract version 1). Counterpart of FakeGoalsBackend
// for trips, shared by Vitest (`installTripsFetch`) and, where useful, Playwright.
//
// It is transport-free: `handle()` takes a request and returns a status and a JSON body,
// and imports nothing from Vitest.
//
// Server rules reproduced here (see backend/src/domain/trips.js and services/tripService.js):
//
// - Integer paise throughout. An expense is allocated by weight; each share is rounded to the
//   nearest paisa with half-paisa upward, then one paisa at a time is added or removed in
//   confirmed member order until the shares sum to the expense. The difference between the
//   rounded and final share is the member's `roundingAdjustmentMinor`.
// - A balance is shared-expense payments made + settlement payments made - allocated shares -
//   settlement payments received. Balances always sum to zero. A settlement payment is a stored
//   expense whose description starts with "↔ Settlement: " and whose first split entry is the
//   recipient. Proposed transfers pair the largest debtor with the largest creditor, ties in
//   member order.
// - `GET /finance/clarity?month=` returns `{ schemaVersion, snapshot }` for the VIEWER: one
//   `trip:<id>` outcome for every trip the viewer owns or belongs to, the nearest-settlement
//   highlight (largest absolute own balance, earliest recorded trip record, name, id) and the
//   settle-trip action. The viewer's monthly spending moves only with the viewer's own
//   personal-share links.
// - Trip writes answer `{ id?, tripVersion, dataVersion, mutation, tripOutcome }` and no snapshot.
//   A member or expense write moves the trip version and every linked account's data version.
//   A personal-link write moves only the actor's data version.
// - Idempotency-Key: the same key and command replays the first receipt with `replayed: true`.
//   A different command with the same key is 409 IDEMPOTENCY_KEY_REUSED. A personal-link
//   include for an expense that is already included with the same values, and a withdraw with
//   nothing linked, change nothing and answer as replays.
// - `expectedTripVersion` that differs from the trip's version is 409 TRIP_VERSION_CONFLICT.
// - Share: owner-only status, create or rotate (a new 32-hex token each time), revoke, and the
//   disclosure. The public route serves the exact allowlisted projection only while enabled and
//   only for the current token; every other token is the constant 404 `{ error: 'Not found' }`.
import type {
  ActionableInsight,
  FinancialSnapshot,
  MoneyValue,
  Outcome,
  TripOutcomeValue,
} from '../clarity/contracts';
import { homeSnapshot, insight, planOutcome, spendingOutcome } from './homeSummaryFixtures';

/** The email of the user the Vitest harness signs in (createTestUser). */
export const TRIPS_VIEWER_EMAIL = 'test.user@example.test';
export const SETTLEMENT_PREFIX = '↔ Settlement: ';
const NEEDS_CATEGORIES = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);
const DAYS_REMAINING = 17;
const BASE_REMAINING_MINOR = 5_400_000;
const BASE_NEEDS_SPENT_MINOR = 600_000;
const BASE_WANTS_SPENT_MINOR = 400_000;

/** The fixed description of every public field. Same shape and wording as the server's PUBLIC_TRIP_DISCLOSURE. */
export const PUBLIC_TRIP_DISCLOSURE = Object.freeze({
  version: 1,
  groups: [
    {
      id: 'trip',
      title: 'Trip details',
      fields: [
        { path: 'trip.name', label: 'Trip name' },
        { path: 'trip.destination', label: 'Destination' },
        { path: 'trip.budget', label: 'Trip budget amount' },
        { path: 'trip.start_date', label: 'Start date' },
        { path: 'trip.end_date', label: 'End date' },
      ],
    },
    { id: 'members', title: 'People on the trip', fields: [{ path: 'members[].name', label: 'Each member’s display name' }] },
    {
      id: 'expenses',
      title: 'Shared expenses',
      fields: [
        { path: 'expenses[].payer', label: 'Who paid for each expense' },
        { path: 'expenses[].description', label: 'Each expense’s description' },
        { path: 'expenses[].amount', label: 'Each expense’s amount' },
        { path: 'expenses[].created_at', label: 'When each expense was added' },
        { path: 'expenses[].split[].name', label: 'Each person the expense is split between' },
        { path: 'expenses[].split[].share', label: 'Each person’s share weight in the split' },
      ],
    },
    {
      id: 'settlement',
      title: 'Balances and settle-up',
      fields: [
        { path: 'settlement.balances.*', label: 'Each named member’s balance (what they are owed or owe)' },
        { path: 'settlement.transactions[].from', label: 'Who pays in each suggested settle-up payment' },
        { path: 'settlement.transactions[].to', label: 'Who receives each suggested settle-up payment' },
        { path: 'settlement.transactions[].amount', label: 'The amount of each suggested settle-up payment' },
      ],
    },
  ],
  private: [
    'Your salary, bills, personal expenses and savings goals',
    'Your guided journeys, insights and analytics',
    'Email addresses of you and the other members',
    'Links between trip expenses and anyone’s personal spending',
    'Internal record numbers, notes, versions and sharing tokens',
  ],
});

export interface FakeTripMember {
  id: number;
  name: string;
  email: string | null;
}

export interface FakeTripExpense {
  id: number;
  payer: string;
  description: string;
  amountMinor: number;
  split: Array<{ name: string; share: number }>;
  createdAt: string;
}

export interface FakeTrip {
  id: number;
  name: string;
  destination: string;
  budget: number;
  startDate: string | null;
  endDate: string | null;
  ownerEmail: string;
  version: number;
  members: FakeTripMember[];
  expenses: FakeTripExpense[];
  share: { enabled: boolean; token: string | null };
}

export interface FakePersonalLink {
  tripId: number;
  expenseId: number;
  category: string;
  spentOn: string;
  amountMinor: number;
  /** Id of the personal expense row created from the share. */
  expenseLogId: number;
}

export interface FakeTripsInit {
  /** The signed-in account. Defaults to `TRIPS_VIEWER_EMAIL`. */
  viewer?: string;
  trips: Array<{
    id: number;
    name: string;
    destination?: string;
    /** Rupees. */
    budget?: number;
    startDate?: string | null;
    endDate?: string | null;
    owner?: string;
    members: Array<{ id?: number; name: string; email?: string | null }>;
    expenses?: Array<{
      id?: number;
      payer: string;
      description: string;
      /** Rupees. */
      amount: number;
      split?: Array<{ name: string; share: number }>;
      createdAt?: string;
    }>;
  }>;
  /** Personal expense categories offered for a personal share. */
  categories?: string[];
}

export interface TripsBackendRequest {
  method: string;
  /** Path below `/api`, without the query string, such as `/trips/3/expenses`. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** Header names in lower case. Absent for transports that do not forward headers. */
  headers?: Record<string, string>;
}

export interface TripsBackendReply {
  status: number;
  body: unknown;
}

interface Receipt {
  fingerprint: string;
  operation: string;
  scopeKey: string;
  recordType: string;
  recordId: number | null;
  recordVersion: number;
  changeId: number;
  status: 'confirmed' | 'reversed';
  tripId: number;
  month?: string;
}

type CalculatedTrip =
  | { status: 'available'; value: TripOutcomeValue }
  | { status: 'invalid'; code: string; field: string; constraint: string; expenseId: number | null };

const money = (amountMinor: number): MoneyValue => ({ currency: 'INR', amountMinor });
const pad = (value: number) => String(value).padStart(2, '0');
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function fail(status: number, error: string, code?: string, extra: Record<string, unknown> = {}): TripsBackendReply {
  return { status, body: { error, ...(code ? { code } : {}), ...extra } };
}
const NOT_FOUND = (): TripsBackendReply => ({ status: 404, body: { error: 'Not found' } });

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

const paiseOf = (rupees: number) => Math.round(rupees * 100);

/** `round(amount * weight / total)` with half upward, on integers of any size. */
function roundedShare(amountMinor: number, weight: number, totalWeight: number): number {
  const numerator = BigInt(amountMinor) * BigInt(weight);
  const denominator = BigInt(totalWeight);
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) quotient += 1n;
  return Number(quotient);
}

/** One shared expense, allocated by weight in confirmed member order. */
export function allocateExpense(
  amountMinor: number,
  weights: Array<{ memberId: number; weight: number }>,
): Array<{ memberId: number; amountMinor: number; roundingAdjustmentMinor: number }> {
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const initial = weights.map((entry) => roundedShare(amountMinor, entry.weight, total));
  const final = [...initial];
  let difference = amountMinor - initial.reduce((sum, value) => sum + value, 0);
  const step = Math.sign(difference);
  while (difference !== 0) {
    let changed = false;
    for (let index = 0; index < final.length && difference !== 0; index += 1) {
      if (step < 0 && final[index] === 0) continue;
      final[index] = (final[index] as number) + step;
      difference -= step;
      changed = true;
    }
    if (!changed) throw new Error('Unable to describe the allocation remainder.');
  }
  return weights.map((entry, index) => ({
    memberId: entry.memberId,
    amountMinor: final[index] as number,
    roundingAdjustmentMinor: (final[index] as number) - (initial[index] as number),
  }));
}

function transfersFor(balances: Array<{ memberId: number; amountMinor: number }>) {
  const order = new Map(balances.map((balance, index) => [balance.memberId, index]));
  const byAmountThenOrder = (a: { remaining: number; memberId: number }, b: { remaining: number; memberId: number }) => (
    b.remaining - a.remaining || (order.get(a.memberId) as number) - (order.get(b.memberId) as number)
  );
  const creditors = balances.filter((b) => b.amountMinor > 0).map((b) => ({ memberId: b.memberId, remaining: b.amountMinor })).sort(byAmountThenOrder);
  const debtors = balances.filter((b) => b.amountMinor < 0).map((b) => ({ memberId: b.memberId, remaining: -b.amountMinor })).sort(byAmountThenOrder);
  const transfers: TripOutcomeValue['settlements'] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d] as { memberId: number; remaining: number };
    const creditor = creditors[c] as { memberId: number; remaining: number };
    const amount = Math.min(debtor.remaining, creditor.remaining);
    transfers.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, amount: money(amount) });
    debtor.remaining -= amount;
    creditor.remaining -= amount;
    if (debtor.remaining === 0) d += 1;
    if (creditor.remaining === 0) c += 1;
  }
  return transfers;
}

/** The canonical calculation for a trip's stored members and expenses. */
export function calculateTrip(trip: Pick<FakeTrip, 'id' | 'version' | 'members' | 'expenses'>): CalculatedTrip {
  const members = [...trip.members].sort((a, b) => a.id - b.id);
  const byName = new Map(members.map((member) => [member.name, member]));
  const paid = new Map(members.map((member) => [member.id, 0]));
  const owed = new Map(members.map((member) => [member.id, 0]));
  const allocations: TripOutcomeValue['allocations'] = [];
  const bad = (code: string, field: string, constraint: string, expenseId: number): CalculatedTrip => (
    { status: 'invalid', code, field, constraint, expenseId }
  );
  for (const expense of [...trip.expenses].sort((a, b) => a.id - b.id)) {
    const payer = byName.get(expense.payer);
    if (!payer) return bad('PAYER_NOT_TRIP_MEMBER', 'payer', 'a current trip member', expense.id);
    if (expense.description.startsWith(SETTLEMENT_PREFIX)) {
      const recipient = byName.get(expense.split[0]?.name ?? '');
      if (!recipient) return bad('INCOMPLETE_SPLIT', 'split', 'the member who received the payment', expense.id);
      paid.set(payer.id, (paid.get(payer.id) as number) + expense.amountMinor);
      owed.set(recipient.id, (owed.get(recipient.id) as number) + expense.amountMinor);
      continue;
    }
    const weights: Array<{ memberId: number; weight: number }> = [];
    for (const member of members) {
      const entry = expense.split.find((candidate) => candidate.name === member.name);
      const weight = entry ? Math.round(Number(entry.share) * 100) : 0;
      if (weight > 0) weights.push({ memberId: member.id, weight });
    }
    if (expense.split.some((entry) => !byName.has(entry.name))) {
      return bad('INVALID_SPLIT_ENTRY', 'split', 'only members of this trip', expense.id);
    }
    if (weights.length === 0) return bad('INCOMPLETE_SPLIT', 'split', 'at least one trip member with a positive share', expense.id);
    paid.set(payer.id, (paid.get(payer.id) as number) + expense.amountMinor);
    for (const share of allocateExpense(expense.amountMinor, weights)) {
      allocations.push({
        expenseId: expense.id,
        memberId: share.memberId,
        amount: money(share.amountMinor),
        roundingAdjustmentMinor: share.roundingAdjustmentMinor,
      });
      owed.set(share.memberId, (owed.get(share.memberId) as number) + share.amountMinor);
    }
  }
  const balances = members.map((member) => {
    const amountMinor = (paid.get(member.id) as number) - (owed.get(member.id) as number);
    return { memberId: member.id, amountMinor, label: (amountMinor > 0 ? 'receivable' : amountMinor < 0 ? 'owed' : 'settled') as 'receivable' | 'owed' | 'settled' };
  });
  return {
    status: 'available',
    value: { tripId: trip.id, tripVersion: trip.version, allocations, balances, settlements: transfersFor(balances) },
  };
}

function monthPeriod(month: string) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return {
    month,
    start: `${month}-01`,
    endExclusive: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10),
    timeZone: 'Asia/Kolkata' as const,
  };
}

interface Account {
  email: string;
  dataVersion: number;
  links: FakePersonalLink[];
}

export class FakeTripsBackend {
  readonly month: string;
  today: string;
  viewer: string;
  readonly trips: FakeTrip[];
  readonly categories: string[];
  /** Whether the viewer has acknowledged the data-use notice. A clarity-contract write needs it. */
  noticeAcknowledged = true;
  /** Every request this backend handled, in order. */
  readonly log: Array<{ method: string; path: string; body: unknown; idempotencyKey?: string; as: string }> = [];
  private readonly accounts = new Map<string, Account>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly injected = new Map<string, TripsBackendReply[]>();
  private readonly recordVersions = new Map<string, number>();
  private nextChangeId = 700;
  private nextLogId = 9000;
  private tokenCounter = 0;
  private clockTick = 0;

  constructor(month: string, init: FakeTripsInit) {
    this.month = month;
    this.today = `${month}-15`;
    this.viewer = (init.viewer ?? TRIPS_VIEWER_EMAIL).toLowerCase();
    this.categories = init.categories ?? ['Food', 'Travel', 'Other'];
    this.trips = init.trips.map((trip) => {
      let nextMemberId = Math.max(0, ...trip.members.map((member) => member.id ?? 0)) + 1;
      const members = trip.members.map((member) => ({
        id: member.id ?? nextMemberId++,
        name: member.name,
        email: member.email ? member.email.toLowerCase() : null,
      }));
      let nextExpenseId = Math.max(0, ...(trip.expenses ?? []).map((expense) => expense.id ?? 0)) + 1;
      const expenses = (trip.expenses ?? []).map((expense, index) => ({
        id: expense.id ?? nextExpenseId++,
        payer: expense.payer,
        description: expense.description,
        amountMinor: paiseOf(expense.amount),
        split: expense.split ?? members.map((member) => ({ name: member.name, share: 1 })),
        createdAt: expense.createdAt ?? `${month}-01 10:00:${pad(index)}`,
      }));
      return {
        id: trip.id,
        name: trip.name,
        destination: trip.destination ?? '',
        budget: trip.budget ?? 0,
        startDate: trip.startDate ?? null,
        endDate: trip.endDate ?? null,
        ownerEmail: (trip.owner ?? TRIPS_VIEWER_EMAIL).toLowerCase(),
        version: expenses.length + members.length,
        members,
        expenses,
        share: { enabled: false, token: null },
      };
    });
  }

  // ---- test controls ----

  /** The next request for `METHOD /path` fails with this reply, and no state changes. */
  failNext(method: string, path: string, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
    const key = `${method} ${path}`;
    this.injected.set(key, [...(this.injected.get(key) ?? []), fail(status, message, code, extra)]);
  }

  trip(id: number): FakeTrip {
    const found = this.trips.find((trip) => trip.id === id);
    if (!found) throw new Error(`No trip ${id}`);
    return found;
  }

  /** The viewer's account state. */
  account(email: string = this.viewer): Account {
    const key = email.toLowerCase();
    let account = this.accounts.get(key);
    if (!account) {
      account = { email: key, dataVersion: 1, links: [] };
      this.accounts.set(key, account);
    }
    return account;
  }

  /** Another client adds a shared expense: the trip version and every linked account's data version move on. */
  addExpenseElsewhere(tripId: number, expense: { payer: string; description: string; amount: number; split?: Array<{ name: string; share: number }>; createdAt?: string }): number {
    const trip = this.trip(tripId);
    const id = Math.max(0, ...trip.expenses.map((item) => item.id)) + 1;
    trip.expenses.push({
      id,
      payer: expense.payer,
      description: expense.description,
      amountMinor: paiseOf(expense.amount),
      split: expense.split ?? trip.members.map((member) => ({ name: member.name, share: 1 })),
      createdAt: expense.createdAt ?? this.timestamp(),
    });
    this.bumpTrip(trip);
    return id;
  }

  /** Stored trip data that the calculator cannot use (an expense with an empty split). The record is never rewritten by reads. */
  corruptExpense(tripId: number, expenseId: number): void {
    const trip = this.trip(tripId);
    const expense = trip.expenses.find((item) => item.id === expenseId);
    if (!expense) throw new Error(`No expense ${expenseId}`);
    expense.split = [];
    this.bumpTrip(trip);
  }

  linkedEmails(trip: FakeTrip): string[] {
    return [...new Set([trip.ownerEmail, ...trip.members.flatMap((member) => (member.email ? [member.email] : []))])];
  }

  private bumpTrip(trip: FakeTrip): void {
    trip.version += 1;
    for (const email of this.linkedEmails(trip)) this.account(email).dataVersion += 1;
  }

  private timestamp(): string {
    this.clockTick += 1;
    return `${this.today} 12:${pad(Math.floor(this.clockTick / 60) % 60)}:${pad(this.clockTick % 60)}`;
  }

  // ---- reads ----

  private accessOf(trip: FakeTrip, email: string): 'owner' | 'member' | null {
    if (trip.ownerEmail === email) return 'owner';
    return trip.members.some((member) => member.email === email) ? 'member' : null;
  }

  private linkedMember(trip: FakeTrip, email: string): FakeTripMember | undefined {
    const matches = trip.members.filter((member) => member.email === email);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private outcomeOf(trip: FakeTrip, dataVersion: number): Outcome<TripOutcomeValue> {
    const id = `trip:${trip.id}`;
    const period = monthPeriod(this.month);
    const base = {
      id,
      kind: 'trip' as const,
      classification: 'calculated_result' as const,
      dataVersion,
      period,
      sourceRefs: [],
    };
    const calculation = calculateTrip(trip);
    if (calculation.status === 'invalid') {
      return {
        ...base,
        status: 'invalid_input',
        invalid: [{ input: `trip:${trip.id}.${calculation.field}`, constraint: calculation.constraint, affects: ['trip'] }],
      };
    }
    return { ...base, status: 'available', value: calculation.value, explanationRef: { outcomeId: id, dataVersion } };
  }

  private spendingFor(email: string) {
    const links = this.account(email).links;
    let needs = BASE_NEEDS_SPENT_MINOR;
    let wants = BASE_WANTS_SPENT_MINOR;
    for (const link of links) {
      if (NEEDS_CATEGORIES.has(link.category)) needs += link.amountMinor;
      else wants += link.amountMinor;
    }
    const linked = links.reduce((sum, link) => sum + link.amountMinor, 0);
    const remaining = BASE_REMAINING_MINOR - linked;
    // Whole rupees, rounded down, as the seeded fixture value is.
    const daily = Math.floor(remaining / DAYS_REMAINING / 100) * 100;
    return { needs, wants, linked, remaining, daily };
  }

  /** The confirmed snapshot for an account. */
  snapshot(email: string = this.viewer): FinancialSnapshot {
    const dataVersion = this.account(email).dataVersion;
    const accessible = this.trips.filter((trip) => this.accessOf(trip, email)).sort((a, b) => a.id - b.id);
    const items = accessible.map((trip) => this.outcomeOf(trip, dataVersion));
    const ranked = accessible.flatMap((trip) => {
      const own = this.linkedMember(trip, email);
      const calculation = calculateTrip(trip);
      if (!own || calculation.status !== 'available') return [];
      const balance = calculation.value.balances.find((entry) => entry.memberId === own.id)?.amountMinor ?? 0;
      const earliest = trip.expenses.map((expense) => expense.createdAt).sort()[0];
      return balance !== 0 && earliest ? [{ trip, balance, earliest }] : [];
    }).sort((a, b) => (
      Math.abs(b.balance) - Math.abs(a.balance)
      || (a.earliest < b.earliest ? -1 : a.earliest > b.earliest ? 1 : 0)
      || a.trip.name.trim().toLocaleLowerCase('en-IN').localeCompare(b.trip.name.trim().toLocaleLowerCase('en-IN'), 'en')
      || a.trip.id - b.trip.id
    ));
    const nearest = ranked[0];
    const actions: ActionableInsight[] = nearest
      ? [insight('settle_trip_balance', {
          id: `action:settle_trip_balance:trip:${nearest.trip.id}`,
          conditionCode: nearest.balance > 0 ? 'trip_balance_receivable' : 'trip_balance_owed',
          observation: nearest.balance > 0
            ? `The trip “${nearest.trip.name}” has an unsettled receivable balance.`
            : `The trip “${nearest.trip.name}” has an unsettled owed balance.`,
          effect: money(nearest.balance),
          actionLabel: 'Settle trip balance',
          expectedEffect: 'Recording the proposed settlement clears the current trip balance.',
          route: `/trips/${nearest.trip.id}?tab=balances&action=settle`,
          context: { recordType: 'trip', recordId: nearest.trip.id },
        })]
      : [];
    const spending = this.spendingFor(email);
    const planValue = planOutcome(this.month, dataVersion).value!;
    const spendingValue = spendingOutcome(this.month, dataVersion).value!;
    const spendingChanges = {
      needsSpent: money(spending.needs),
      wantsSpent: money(spending.wants),
      remainingSpendable: money(spending.remaining),
      dailySpendingGuide: money(spending.daily),
    };
    const snapshot = homeSnapshot(this.month, {
      dataVersion,
      actions,
      highlights: {
        urgentGoal: null,
        nearestTripSettlement: nearest
          ? {
              tripId: nearest.trip.id,
              name: nearest.trip.name,
              userBalance: money(nearest.balance),
              label: nearest.balance > 0 ? 'receivable' : 'owed',
            }
          : null,
      },
      plan: { value: { ...planValue, ...spendingChanges } },
      spending: { value: { ...spendingValue, ...spendingChanges, totalSpending: money(1_000_000 + spending.linked) } },
      goals: [],
      trips: items,
    });
    return { ...snapshot, period: { ...snapshot.period, asOfDate: this.today, daysRemainingInclusive: DAYS_REMAINING } };
  }

  /** The anonymous public projection of a trip: only allowlisted fields, no ids. */
  publicProjection(trip: FakeTrip) {
    const calculation = calculateTrip(trip);
    const nameOf = new Map(trip.members.map((member) => [member.id, member.name]));
    const balances: Record<string, number> = {};
    const transactions: Array<{ from: string; to: string; amount: number }> = [];
    if (calculation.status === 'available') {
      for (const balance of calculation.value.balances) balances[nameOf.get(balance.memberId) as string] = balance.amountMinor / 100;
      for (const transfer of calculation.value.settlements) {
        transactions.push({ from: nameOf.get(transfer.fromMemberId) as string, to: nameOf.get(transfer.toMemberId) as string, amount: transfer.amount.amountMinor / 100 });
      }
    }
    return {
      trip: { name: trip.name, destination: trip.destination, budget: trip.budget, start_date: trip.startDate, end_date: trip.endDate },
      members: trip.members.map((member) => ({ name: member.name })),
      expenses: [...trip.expenses].sort((a, b) => b.id - a.id).map((expense) => ({
        payer: expense.payer,
        description: expense.description,
        amount: expense.amountMinor / 100,
        created_at: expense.createdAt,
        split: expense.split.map((entry) => ({ name: entry.name, share: entry.share })),
      })),
      settlement: { balances, transactions },
    };
  }

  private detailOf(trip: FakeTrip, email: string) {
    const calculation = calculateTrip(trip);
    const nameOf = new Map(trip.members.map((member) => [member.id, member.name]));
    const balances: Record<string, number> = Object.fromEntries(trip.members.map((member) => [member.name, 0]));
    if (calculation.status === 'available') {
      for (const balance of calculation.value.balances) balances[nameOf.get(balance.memberId) as string] = balance.amountMinor / 100;
    }
    return {
      trip: {
        id: trip.id,
        name: trip.name,
        destination: trip.destination,
        budget: trip.budget,
        start_date: trip.startDate,
        end_date: trip.endDate,
      },
      role: this.accessOf(trip, email),
      members: trip.members.map((member) => ({ id: member.id, name: member.name, email: member.email })),
      expenses: [...trip.expenses].sort((a, b) => b.id - a.id).map((expense) => ({
        id: expense.id,
        payer: expense.payer,
        description: expense.description,
        amount: expense.amountMinor / 100,
        created_at: expense.createdAt,
        split: expense.split,
      })),
      settlement: {
        balances,
        transactions: calculation.status === 'available'
          ? calculation.value.settlements.map((transfer) => ({
              from: nameOf.get(transfer.fromMemberId) as string,
              to: nameOf.get(transfer.toMemberId) as string,
              amount: transfer.amount.amountMinor / 100,
            }))
          : [],
      },
    };
  }

  // ---- requests ----

  /** Handles one request as `as` (default: the viewer). */
  handle(request: TripsBackendRequest, as: string = this.viewer): TripsBackendReply {
    const email = as.toLowerCase();
    const method = request.method.toUpperCase();
    const path = request.path;
    const headers = request.headers;
    const idempotencyKey = headers?.['idempotency-key'];
    this.log.push({ method, path, body: request.body, ...(idempotencyKey ? { idempotencyKey } : {}), as: email });
    const injected = this.injected.get(`${method} ${path}`)?.shift();
    if (injected) return injected;

    if (method === 'GET') return this.read(path, request.query, email);
    const clarityContract = headers?.['x-clarity-contract'] === '1';
    const body = asRecord(request.body);

    let match = /^\/trips\/(\d+)\/members$/.exec(path);
    if (match && method === 'POST') return this.addMember(Number(match[1]), body, email, idempotencyKey, clarityContract);
    match = /^\/trips\/(\d+)\/expenses$/.exec(path);
    if (match && method === 'POST') return this.addExpense(Number(match[1]), body, email, idempotencyKey, clarityContract);
    match = /^\/trips\/(\d+)\/expenses\/(\d+)\/personal-link$/.exec(path);
    if (match && method === 'PUT') return this.include(Number(match[1]), Number(match[2]), body, email, idempotencyKey, headers !== undefined);
    if (match && method === 'DELETE') return this.withdraw(Number(match[1]), Number(match[2]), email, idempotencyKey, headers !== undefined);
    match = /^\/trips\/(\d+)\/share$/.exec(path);
    if (match && method === 'POST') return this.createShare(Number(match[1]), email, clarityContract);
    if (match && method === 'DELETE') return this.revokeShare(Number(match[1]), email);
    return fail(404, `No fixture for ${method} ${path}.`, 'NOT_FOUND');
  }

  private read(path: string, query: URLSearchParams | undefined, email: string): TripsBackendReply {
    if (path === '/finance/clarity') return { status: 200, body: { schemaVersion: 1, snapshot: this.snapshot(email) } };
    if (path === '/finance/expenses') {
      const rows = this.account(email).links.map((link) => ({
        id: link.expenseLogId,
        month: link.spentOn.slice(0, 7),
        category: link.category,
        amount: link.amountMinor / 100,
        note: `Trip share: ${this.trip(link.tripId).expenses.find((item) => item.id === link.expenseId)?.description ?? ''}`,
        spent_on: link.spentOn,
        created_at: `${link.spentOn} 00:00:00`,
      }));
      return { status: 200, body: { month: query?.get('month') ?? this.month, categories: this.categories, expenses: rows.filter((row) => row.month === (query?.get('month') ?? this.month)) } };
    }
    if (path === '/trips') {
      const rows = this.trips
        .filter((trip) => this.accessOf(trip, email))
        .sort((a, b) => b.id - a.id)
        .map((trip) => ({
          id: trip.id,
          name: trip.name,
          destination: trip.destination,
          budget: trip.budget,
          start_date: trip.startDate,
          end_date: trip.endDate,
          role: this.accessOf(trip, email),
        }));
      return { status: 200, body: { trips: rows } };
    }
    let match = /^\/trips\/(\d+)$/.exec(path);
    if (match) {
      const trip = this.trips.find((item) => item.id === Number(match![1]));
      return trip && this.accessOf(trip, email) ? { status: 200, body: this.detailOf(trip, email) } : NOT_FOUND();
    }
    match = /^\/trips\/(\d+)\/share$/.exec(path);
    if (match) {
      const trip = this.ownedTrip(Number(match[1]), email);
      return trip ? { status: 200, body: { enabled: trip.share.enabled, token: trip.share.enabled ? trip.share.token : null } } : NOT_FOUND();
    }
    match = /^\/trips\/(\d+)\/share\/disclosure$/.exec(path);
    if (match) return this.ownedTrip(Number(match[1]), email) ? { status: 200, body: PUBLIC_TRIP_DISCLOSURE } : NOT_FOUND();
    match = /^\/public\/trips\/([^/]+)$/.exec(path);
    if (match) {
      const token = decodeURIComponent(match[1] as string);
      const trip = /^[a-f0-9]{32}$/.test(token)
        ? this.trips.find((item) => item.share.enabled && item.share.token === token)
        : undefined;
      return trip ? { status: 200, body: this.publicProjection(trip) } : NOT_FOUND();
    }
    return fail(404, `No fixture for GET ${path}.`, 'NOT_FOUND');
  }

  private ownedTrip(id: number, email: string): FakeTrip | undefined {
    const trip = this.trips.find((item) => item.id === id);
    return trip && trip.ownerEmail === email ? trip : undefined;
  }

  // ---- writes ----

  private noticeBlock(clarityContract: boolean): TripsBackendReply | null {
    return clarityContract && !this.noticeAcknowledged
      ? fail(428, 'Acknowledge the data-use notice before adding financial data.', 'DATA_NOTICE_REQUIRED')
      : null;
  }

  private staleVersion(trip: FakeTrip, expected: unknown): TripsBackendReply | null {
    if (expected === undefined || expected === trip.version) return null;
    return fail(409, 'Trip changed since it was last confirmed.', 'TRIP_VERSION_CONFLICT', { currentTripVersion: trip.version });
  }

  /** The stored receipt for this account and key, if any. A different command with the same key is rejected. */
  private replayOf(email: string, key: string | undefined, fingerprint: string): { receipt: Receipt } | TripsBackendReply | null {
    if (!key) return null;
    const receipt = this.receipts.get(`${email}|${key}`);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) {
      return fail(409, 'Idempotency key was already used for a different financial command.', 'IDEMPOTENCY_KEY_REUSED', { field: 'idempotencyKey' });
    }
    return { receipt };
  }

  private envelope(email: string, key: string | undefined, receipt: Receipt, replayed: boolean, extra: Record<string, unknown>): TripsBackendReply {
    const trip = this.trip(receipt.tripId);
    const calculation = calculateTrip(trip);
    return {
      status: 200,
      body: {
        ...extra,
        tripVersion: trip.version,
        dataVersion: this.account(email).dataVersion,
        mutation: {
          changeId: receipt.changeId,
          idempotencyKey: key ?? 'server-key',
          scopeKey: receipt.scopeKey,
          operation: receipt.operation,
          recordType: receipt.recordType,
          recordId: receipt.recordId,
          recordVersion: receipt.recordVersion,
          status: receipt.status,
          occurredAt: this.timestamp(),
          replayed,
        },
        tripOutcome: calculation.status === 'available'
          ? { status: 'available', value: calculation.value }
          : { status: 'invalid_input', invalid: [{ field: calculation.field, constraint: calculation.constraint }] },
      },
    };
  }

  private commit(email: string, key: string | undefined, receipt: Omit<Receipt, 'changeId'>): Receipt {
    const full: Receipt = { ...receipt, changeId: this.nextChangeId++ };
    this.receipts.set(`${email}|${key ?? `server-${full.changeId}`}`, full);
    return full;
  }

  private addMember(tripId: number, body: Record<string, unknown>, email: string, key: string | undefined, clarityContract: boolean): TripsBackendReply {
    const trip = this.trips.find((item) => item.id === tripId);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 40) return fail(400, 'Invalid value', 'INVALID_TRIP_MEMBER', { field: 'name' });
    const emailValue = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
    if (emailValue !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailValue)) {
      return fail(400, 'Member email is invalid.', 'INVALID_MEMBER_EMAIL', { field: 'email' });
    }
    const blocked = this.noticeBlock(clarityContract);
    if (blocked) return blocked;
    const fingerprint = stable({ op: 'member', email, tripId, name, emailValue, expected: body.expectedTripVersion });
    const replay = this.replayOf(email, key, fingerprint);
    if (replay && 'receipt' in replay) return this.envelope(email, key, replay.receipt, true, { id: replay.receipt.recordId });
    if (replay) return replay;
    if (!trip || trip.ownerEmail !== email) return NOT_FOUND();
    const stale = this.staleVersion(trip, body.expectedTripVersion);
    if (stale) return stale;
    if (trip.members.some((member) => member.name === name)) return fail(409, 'Member with that name exists', 'TRIP_MEMBER_EXISTS');
    const id = Math.max(0, ...trip.members.map((member) => member.id)) + 1;
    trip.members.push({ id, name, email: emailValue });
    this.bumpTrip(trip);
    const receipt = this.commit(email, key, {
      fingerprint, operation: 'trip.member.create', scopeKey: `trip-member:${id}`, recordType: 'trip_member', recordId: id, recordVersion: 1, status: 'confirmed', tripId,
    });
    return this.envelope(email, key, receipt, false, { id });
  }

  private addExpense(tripId: number, body: Record<string, unknown>, email: string, key: string | undefined, clarityContract: boolean): TripsBackendReply {
    const trip = this.trips.find((item) => item.id === tripId);
    const payer = typeof body.payer === 'string' ? body.payer.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const amount = body.amount;
    if (payer.length < 1 || payer.length > 40 || description.length < 1 || description.length > 100) {
      return fail(400, 'Invalid value', 'INVALID_TRIP_EXPENSE', { field: payer.length < 1 || payer.length > 40 ? 'payer' : 'description' });
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) return fail(400, 'Invalid value', 'INVALID_TRIP_AMOUNT', { field: 'amount' });
    if (!Array.isArray(body.split) || body.split.length < 1) {
      return fail(400, 'Split required', 'INCOMPLETE_SPLIT', { field: 'split', constraint: 'at least one trip member with a positive share' });
    }
    const amountMinor = paiseOf(amount);
    if (amountMinor <= 0 || Math.abs(amountMinor / 100 - amount) > 1e-9) {
      return fail(400, 'Amount must be greater than zero with at most two decimals.', 'INVALID_TRIP_AMOUNT', { field: 'amount', constraint: 'greater than 0 with at most 2 decimals' });
    }
    const split = (body.split as unknown[]).map((entry) => ({ name: String(asRecord(entry).name ?? ''), share: Number(asRecord(entry).share) }));
    if (split.some((entry) => !entry.name)) return fail(422, 'Each split entry must identify a member.', 'INVALID_SPLIT_ENTRY', { field: 'split' });
    if (split.some((entry) => !Number.isFinite(entry.share) || entry.share < 0)) return fail(422, 'Split shares must be non-negative numbers.', 'INVALID_SPLIT_SHARE', { field: 'split' });
    const blocked = this.noticeBlock(clarityContract);
    if (blocked) return blocked;
    const fingerprint = stable({ op: 'expense', email, tripId, payer, description, amount, split, expected: body.expectedTripVersion });
    const replay = this.replayOf(email, key, fingerprint);
    if (replay && 'receipt' in replay) return this.envelope(email, key, replay.receipt, true, { id: replay.receipt.recordId });
    if (replay) return replay;
    if (!trip || !this.accessOf(trip, email)) return NOT_FOUND();
    const stale = this.staleVersion(trip, body.expectedTripVersion);
    if (stale) return stale;
    const payerMember = trip.members.find((member) => member.name === payer);
    if (!payerMember) return fail(400, 'Payer must be a trip member.', 'PAYER_NOT_TRIP_MEMBER', { field: 'payer' });
    const isSettlement = description.startsWith(SETTLEMENT_PREFIX);
    if (isSettlement && trip.ownerEmail !== email && this.linkedMember(trip, email)?.id !== payerMember.id) {
      return fail(403, 'Only the payer or the trip owner can mark a settlement.', 'SETTLEMENT_PAYER_NOT_AUTHORIZED');
    }
    const id = Math.max(0, ...trip.expenses.map((item) => item.id)) + 1;
    const candidate: FakeTripExpense = { id, payer, description, amountMinor, split, createdAt: this.timestamp() };
    const candidateTrip = { ...trip, version: trip.version + 1, expenses: [...trip.expenses, candidate] };
    const calculation = calculateTrip(candidateTrip);
    if (calculation.status === 'invalid') {
      return fail(422, calculation.code === 'INCOMPLETE_SPLIT' ? 'Split required' : 'Trip expense is invalid.', calculation.code, {
        field: calculation.field,
        constraint: calculation.constraint,
        tripOutcome: { status: 'invalid_input', invalid: [{ field: calculation.field, constraint: calculation.constraint }] },
      });
    }
    trip.expenses.push(candidate);
    this.bumpTrip(trip);
    const receipt = this.commit(email, key, {
      fingerprint, operation: 'trip.expense.create', scopeKey: `trip-expense:${id}`, recordType: 'trip_expense', recordId: id, recordVersion: 1, status: 'confirmed', tripId,
    });
    return this.envelope(email, key, receipt, false, { id });
  }

  private validIsoDate(value: unknown): value is string {
    const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
    const real = new Date(Date.UTC(year, month - 1, day));
    return real.getUTCMonth() === month - 1 && real.getUTCDate() === day;
  }

  /** The signed-in member's allocated share of one shared expense, in paise. Fail-closed when there is none. */
  private eligibleShare(trip: FakeTrip, email: string, expenseId: number): { amountMinor: number } | TripsBackendReply {
    const own = this.linkedMember(trip, email);
    if (!own) return fail(403, 'Your account must be linked to exactly one trip member before including a personal share.', 'PERSONAL_MEMBER_LINK_REQUIRED');
    const calculation = calculateTrip(trip);
    const expense = trip.expenses.find((item) => item.id === expenseId);
    if (!expense || expense.description.startsWith(SETTLEMENT_PREFIX)) return NOT_FOUND();
    if (calculation.status !== 'available') return fail(422, 'Trip data must be corrected first.', 'TRIP_DATA_INVALID', { field: 'split' });
    const share = calculation.value.allocations.find((item) => item.expenseId === expenseId && item.memberId === own.id);
    if (!share || share.amount.amountMinor <= 0) return fail(403, 'You have no share of this expense to include.', 'PERSONAL_SHARE_NOT_AVAILABLE');
    return { amountMinor: share.amount.amountMinor };
  }

  private nextRecordVersion(email: string, expenseId: number): number {
    const key = `${email}|${expenseId}`;
    const next = (this.recordVersions.get(key) ?? 0) + 1;
    this.recordVersions.set(key, next);
    return next;
  }

  private include(tripId: number, expenseId: number, body: Record<string, unknown>, email: string, key: string | undefined, enforceKey: boolean): TripsBackendReply {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (category.length < 1 || category.length > 24 || !this.validIsoDate(body.spentOn)) {
      return fail(400, 'Invalid value', category.length < 1 || category.length > 24 ? 'INVALID_PERSONAL_EXPENSE_CATEGORY' : 'INVALID_PERSONAL_EXPENSE_DATE', {
        field: category.length < 1 || category.length > 24 ? 'category' : 'spentOn',
      });
    }
    const spentOn = body.spentOn as string;
    if (enforceKey && !key) return fail(400, 'A valid Idempotency-Key header is required.', 'INVALID_IDEMPOTENCY_KEY');
    const blocked = this.noticeBlock(true);
    if (blocked) return blocked;
    if (!this.categories.includes(category)) {
      return fail(400, 'Unknown category — add it in Settings first.', 'UNKNOWN_PERSONAL_EXPENSE_CATEGORY', { field: 'category' });
    }
    const fingerprint = stable({ op: 'include', email, tripId, expenseId, category, spentOn });
    const replay = this.replayOf(email, key, fingerprint);
    const month = spentOn.slice(0, 7);
    if (replay && 'receipt' in replay) {
      const link = this.account(email).links.find((item) => item.tripId === tripId && item.expenseId === expenseId);
      return this.envelope(email, key, replay.receipt, true, { ok: true, id: link?.expenseLogId ?? null, month });
    }
    if (replay) return replay;
    const trip = this.trips.find((item) => item.id === tripId);
    if (!trip || !this.accessOf(trip, email)) return NOT_FOUND();
    const eligible = this.eligibleShare(trip, email, expenseId);
    if ('status' in eligible) return eligible;
    const account = this.account(email);
    const existing = account.links.find((item) => item.tripId === tripId && item.expenseId === expenseId);
    if (existing) {
      if (existing.category !== category || existing.spentOn !== spentOn || existing.amountMinor !== eligible.amountMinor) {
        return fail(409, 'This trip expense is already included with different personal expense details.', 'PERSONAL_LINK_EXISTS');
      }
      const receipt = this.commit(email, key, {
        fingerprint, operation: 'trip.personal_link.include', scopeKey: `trip-personal-link:${expenseId}`, recordType: 'trip_personal_link', recordId: expenseId,
        recordVersion: this.nextRecordVersion(email, expenseId), status: 'confirmed', tripId,
      });
      return this.envelope(email, key, receipt, true, { ok: true, id: existing.expenseLogId, month: existing.spentOn.slice(0, 7) });
    }
    const link: FakePersonalLink = { tripId, expenseId, category, spentOn, amountMinor: eligible.amountMinor, expenseLogId: this.nextLogId++ };
    account.links.push(link);
    account.dataVersion += 1;
    const receipt = this.commit(email, key, {
      fingerprint, operation: 'trip.personal_link.include', scopeKey: `trip-personal-link:${expenseId}`, recordType: 'trip_personal_link', recordId: expenseId,
      recordVersion: this.nextRecordVersion(email, expenseId), status: 'confirmed', tripId,
    });
    return this.envelope(email, key, receipt, false, { ok: true, id: link.expenseLogId, month });
  }

  private withdraw(tripId: number, expenseId: number, email: string, key: string | undefined, enforceKey: boolean): TripsBackendReply {
    if (enforceKey && !key) return fail(400, 'A valid Idempotency-Key header is required.', 'INVALID_IDEMPOTENCY_KEY');
    const fingerprint = stable({ op: 'withdraw', email, tripId, expenseId });
    const replay = this.replayOf(email, key, fingerprint);
    if (replay && 'receipt' in replay) return this.envelope(email, key, replay.receipt, true, { ok: true });
    if (replay) return replay;
    const trip = this.trips.find((item) => item.id === tripId);
    if (!trip || !this.accessOf(trip, email)) return NOT_FOUND();
    if (!this.linkedMember(trip, email)) {
      return fail(403, 'Your account must be linked to exactly one trip member before withdrawing a personal share.', 'PERSONAL_MEMBER_LINK_REQUIRED');
    }
    const account = this.account(email);
    const index = account.links.findIndex((item) => item.tripId === tripId && item.expenseId === expenseId);
    const common = {
      fingerprint, operation: 'trip.personal_link.remove', scopeKey: `trip-personal-link:${expenseId}`, recordType: 'trip_personal_link', recordId: expenseId,
      recordVersion: this.nextRecordVersion(email, expenseId), status: 'reversed' as const, tripId,
    };
    if (index < 0) return this.envelope(email, key, this.commit(email, key, common), true, { ok: true });
    account.links.splice(index, 1);
    account.dataVersion += 1;
    return this.envelope(email, key, this.commit(email, key, common), false, { ok: true });
  }

  private createShare(tripId: number, email: string, clarityContract: boolean): TripsBackendReply {
    const blocked = this.noticeBlock(clarityContract);
    if (blocked) return blocked;
    const trip = this.ownedTrip(tripId, email);
    if (!trip) return NOT_FOUND();
    this.tokenCounter += 1;
    const token = this.tokenCounter.toString(16).padStart(8, '0').repeat(4);
    trip.share = { enabled: true, token };
    return { status: 200, body: { token } };
  }

  private revokeShare(tripId: number, email: string): TripsBackendReply {
    const trip = this.ownedTrip(tripId, email);
    if (!trip) return NOT_FOUND();
    trip.share = { enabled: false, token: null };
    return { status: 200, body: { ok: true } };
  }
}

/** Every path a public projection may contain, from the fixed disclosure. `[]` is an array element and `*` a member name. */
export function publicAllowlistPaths(): string[] {
  return PUBLIC_TRIP_DISCLOSURE.groups.flatMap((group) => group.fields.map((field) => field.path));
}

/** The distinct dotted paths of every key in a value, with `[]` for array elements and `*` for member-name keys under `settlement.balances`. */
export function pathsOf(value: unknown): string[] {
  return [...new Set(walk(value, ''))];
}

function walk(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => walk(item, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const segment = prefix === 'settlement.balances' ? '*' : key;
      return walk(child, prefix ? `${prefix}.${segment}` : segment);
    });
  }
  return [prefix];
}
