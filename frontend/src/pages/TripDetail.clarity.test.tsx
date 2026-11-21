import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripOutcomeValue } from '../clarity/contracts';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { DATA_USE_REASON_ID, DataUseGate } from '../components/clarity';
import { currentMonth, monthLabel } from '../money';
import { deferred } from '../test/clarity-fixtures';
import { buildSettings } from '../test/dataUseFixtures';
import {
  ASHA,
  MEERA,
  RAVI,
  dinnerOutcomeValue,
  invalidTripOutcome,
  jsonFailure,
  jsonOk,
  mockTripApi,
  readSnapshot,
  tripDetail,
  tripOutcomeItem,
  tripSnapshot,
  tripWrite,
} from '../test/tripFixtures';
import { axe, createTestQueryClient, createTestUser, renderAtRoute } from '../test/test-utils';
import { TripDetail } from './TripDetail';

const MONTH = currentMonth();
const pad = (value: number) => String(value).padStart(2, '0');
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
const TODAY_MONTH = monthLabel(TODAY.slice(0, 7));

const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const tab = (name: RegExp) => screen.getByRole('tab', { name });

function renderTrip(options: { gate?: boolean; route?: string } = {}) {
  const page = options.gate
    ? (
      <DataUseGateProvider enabled>
        <DataUseGate />
        <TripDetail />
      </DataUseGateProvider>
    )
    : <TripDetail />;
  return renderAtRoute(
    <FinancialClarityProvider>
      <MutationStatusProvider>{page}</MutationStatusProvider>
    </FinancialClarityProvider>,
    { path: '/trips/:id', route: options.route ?? '/trips/3', queryClient: createTestQueryClient(), user: createTestUser() },
  );
}

function baseRoutes() {
  return {
    'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH)),
    'GET /trips/3': tripDetail(),
  };
}

/** A confirmed outcome for the dinner plus a ₹300.00 taxi shared evenly. */
function withTaxi(): TripOutcomeValue {
  const base = dinnerOutcomeValue();
  return {
    ...base,
    tripVersion: 4,
    allocations: [
      ...base.allocations,
      ...[101, 102, 103].map((memberId) => ({ expenseId: 12, memberId, amount: { currency: 'INR' as const, amountMinor: 10000 }, roundingAdjustmentMinor: 0 })),
    ],
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

describe('flag off', () => {
  it('renders and behaves as the original page, with no clarity requests', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    const user = userEvent.setup();
    const api = mockTripApi({
      'GET /trips/3': tripDetail(),
      'POST /trips/3/expenses': { id: 12 },
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Goa weekend' })).toBeInTheDocument();
    expect(document.querySelector('.clarity-decision-header')).toBeNull();
    expect(screen.getByText('gets ₹666.66')).toBeInTheDocument();
    expect(screen.getAllByText('owes ₹333.33', { selector: '.balance-chip' })).toHaveLength(2);
    const markPaid = screen.getAllByRole('button', { name: 'Mark paid' });
    expect(markPaid).toHaveLength(2);
    await user.click(markPaid[0]!);
    await waitFor(() => expect(api.to('POST', '/trips/3/expenses')).toHaveLength(1));
    const [post] = api.to('POST', '/trips/3/expenses');
    expect(post?.body).toMatchObject({ payer: 'Ravi', amount: 333.33, split: [{ name: 'Asha', share: 1 }] });
    expect(post?.headers['Idempotency-Key']).toBeUndefined();
    expect(post?.headers['X-Clarity-Contract']).toBeUndefined();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(0);
  });
});

describe('canonical allocations, balances, and settlement', () => {
  it('shows each member’s allocation with its rounding adjustment, and no unconfirmed arithmetic', async () => {
    mockTripApi(baseRoutes());
    renderTrip();
    const allocations = await screen.findByRole('list', { name: 'Each member’s share of Beach dinner' });
    const rows = within(allocations).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Asha ₹333.34 (+₹0.01 rounding adjustment)');
    expect(rows[1]).toHaveTextContent('Ravi ₹333.33');
    expect(rows[1]).not.toHaveTextContent('rounding');
    expect(rows[2]).toHaveTextContent('Meera ₹333.33');
    expect(screen.getByText(/Asha paid · Equal split between 3/)).toBeInTheDocument();
  });

  it('labels balances in text and lists the deterministic settlement plan', async () => {
    mockTripApi(baseRoutes());
    renderTrip({ route: '/trips/3?tab=balances' });
    const card = await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(within(card).getByText('You are owed ₹666.66 (receivable).')).toBeInTheDocument();
    const members = within(card).getAllByRole('listitem').filter((item) => item.hasAttribute('data-member-id'));
    expect(members.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Receivable ₹666.66'),
      expect.stringContaining('Owed ₹333.33'),
      expect.stringContaining('Owed ₹333.33'),
    ]);
    const plan = within(card).getAllByRole('listitem').filter((item) => item.hasAttribute('data-transfer'));
    expect(plan).toHaveLength(2);
    expect(plan[0]).toHaveTextContent('Ravi pays Asha');
    expect(plan[0]).toHaveTextContent('₹333.33');
    expect(plan[1]).toHaveTextContent('Meera pays Asha');
    expect(card).toHaveTextContent('It is not a shared expense');
  });

  it('shows a settled member as text and an all-square trip without payments', async () => {
    const settled: TripOutcomeValue = {
      ...dinnerOutcomeValue(),
      balances: [101, 102, 103].map((memberId) => ({ memberId, amountMinor: 0, label: 'settled' as const })),
      settlements: [],
    };
    mockTripApi({
      ...baseRoutes(),
      'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH, { items: [tripOutcomeItem(MONTH, 1, settled)] })),
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    const card = await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(within(card).getByText('You are settled on this trip.')).toBeInTheDocument();
    expect(within(card).getAllByText('Settled')).toHaveLength(3);
    expect(within(card).getByText(/All square/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Record payment/ })).toBeNull();
  });

  it('opens and closes the generated explanation without moving focus away', async () => {
    const user = userEvent.setup();
    mockTripApi({
      ...baseRoutes(),
      'GET /finance/explanations/trip:3': {
        schemaVersion: 1,
        explanation: {
          schemaVersion: 1,
          outcomeId: 'trip:3',
          kind: 'trip',
          status: 'available',
          classification: 'calculated_result',
          dataVersion: 1,
          period: { month: MONTH, start: `${MONTH}-01`, endExclusive: `${MONTH}-28`, timeZone: 'Asia/Kolkata' },
          currency: 'INR',
          precisionMinor: 1,
          sourceRefs: [],
          operations: [{
            order: 1,
            operation: 'remainder_adjustment',
            operandRefs: [],
            result: { currency: 'INR', amountMinor: 100000 },
            explanationKey: 'trip.adjust_allocation_remainder',
          }],
          rounding: { precisionMinor: 1, direction: 'half_up', adjustmentMinor: 1 },
        },
      },
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    const toggle = await screen.findByRole('button', { name: 'How this was calculated for Balances and settlement' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(/Give any leftover paise to members one at a time/)).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('withholds new balances for invalid trip data and says which input to correct', async () => {
    mockTripApi({
      ...baseRoutes(),
      'GET /finance/clarity': readSnapshot(tripSnapshot(MONTH, { items: [invalidTripOutcome(MONTH, 1)] })),
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    const card = await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(card).toHaveTextContent('Needs correction');
    expect(card).toHaveTextContent('at least one member with a positive share');
    expect(screen.getByText(/Member balances and the settlement are unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record payment/ })).toBeNull();
  });
});

describe('scoped changes', () => {
  async function fillExpense(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('textbox', { name: 'What for?' });
    await user.type(screen.getByRole('textbox', { name: 'What for?' }), 'Taxi');
    await user.type(screen.getByRole('textbox', { name: 'Amount (₹)' }), '300');
  }

  it('acknowledges a new expense synchronously and keeps the confirmed outcome until the server confirms', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const api = mockTripApi({
      ...baseRoutes(),
      'POST /trips/3/expenses': () => pending.promise,
    });
    renderTrip();
    await fillExpense(user);
    act(() => {
      fireEvent.click(button('Add & split'));
    });
    // Pending is acknowledged before the request settles, and the last confirmed shares stay.
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: pending');
    expect(screen.getByRole('list', { name: 'Each member’s share of Beach dinner' })).toBeInTheDocument();
    const [post] = api.to('POST', '/trips/3/expenses');
    expect(post?.body).toEqual({
      payer: 'Asha',
      description: 'Taxi',
      amount: 300,
      split: [{ name: 'Asha', share: 1 }, { name: 'Ravi', share: 1 }, { name: 'Meera', share: 1 }],
    });
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['X-Clarity-Contract']).toBe('1');
    // No page-wide loading and no reload of the trip.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(api.to('GET', '/trips/3')).toHaveLength(1);
    await act(async () => {
      pending.resolve(jsonFailure(500, { error: 'Trip change could not be saved.', code: 'TRIP_MUTATION_FAILED' }));
    });
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
  });

  it('rolls back only the failed scope, keeps other tabs usable, and retries with the same key', async () => {
    const user = userEvent.setup();
    let saved = false;
    const afterTaxi = tripSnapshot(MONTH, { dataVersion: 2, items: [tripOutcomeItem(MONTH, 2, withTaxi())] });
    const api = mockTripApi({
      'GET /trips/3': tripDetail(),
      'GET /finance/clarity': () => jsonOk(readSnapshot(saved ? afterTaxi : tripSnapshot(MONTH))),
      'POST /trips/3/expenses': (_call, attempt) => {
        if (attempt === 1) return jsonFailure(500, { error: 'Trip change could not be saved.', code: 'TRIP_MUTATION_FAILED' });
        saved = true;
        return jsonOk(tripWrite({ id: 12, operation: 'trip.expense.create', recordType: 'trip_expense', scopeKey: 'trip-expense:12' }));
      },
      'POST /trips/3/members': () => jsonOk(tripWrite({ id: 13, operation: 'trip.member.create', recordType: 'trip_member', scopeKey: 'trip-member:13' })),
    });
    renderTrip();
    await fillExpense(user);
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('Your last confirmed values are unchanged.');
    // The entry is kept for the retry and the confirmed shares are untouched.
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('Taxi');
    expect(screen.queryByText('Taxi', { selector: 'strong' })).toBeNull();

    // Another tab and another scope still work while the expense scope is failed.
    await user.click(tab(/People/));
    await user.type(screen.getByRole('textbox', { name: /Friend's name/ }), 'Kiran');
    await user.click(button('Add label'));
    await waitFor(() => expect(statusOf('new-trip-member:3')).toHaveTextContent('Add Kiran: done'));
    expect(screen.getByText('Kiran', { selector: 'strong' })).toBeInTheDocument();
    await user.click(tab(/Expenses/));
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.');

    await user.click(button('Retry Add expense'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    const posts = api.to('POST', '/trips/3/expenses');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    // Added once, with the server's allocation for it, and the form is cleared.
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);
    expect(await screen.findByRole('list', { name: 'Each member’s share of Taxi' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('');
  });

  it('keeps a saved expense visible when the follow-up read fails and retries only the read', async () => {
    const user = userEvent.setup();
    let saved = false;
    let failReads = false;
    const afterTaxi = tripSnapshot(MONTH, { dataVersion: 2, items: [tripOutcomeItem(MONTH, 2, withTaxi())] });
    const api = mockTripApi({
      'GET /trips/3': tripDetail(),
      'GET /finance/clarity': () => (failReads
        ? jsonFailure(503, { error: 'Unavailable.', code: 'SERVICE_UNAVAILABLE' })
        : jsonOk(readSnapshot(saved ? afterTaxi : tripSnapshot(MONTH)))),
      'POST /trips/3/expenses': () => {
        saved = true;
        failReads = true;
        return jsonOk(tripWrite({ id: 12, operation: 'trip.expense.create', recordType: 'trip_expense', scopeKey: 'trip-expense:12' }));
      },
    });
    renderTrip();
    await fillExpense(user);
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('The change was saved, but the updated balances could not be loaded.');
    // The saved expense is listed once and the form is cleared, so it cannot be submitted again by mistake.
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('');
    expect(api.to('POST', '/trips/3/expenses')).toHaveLength(1);

    failReads = false;
    await user.click(button('Retry Add expense'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    // The retry read again and did not write again.
    expect(api.to('POST', '/trips/3/expenses')).toHaveLength(1);
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);
    expect(await screen.findByRole('list', { name: 'Each member’s share of Taxi' })).toBeInTheDocument();
  });

  it('keeps an invalid draft and the last confirmed outcome, with a correction beside the field', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({
      ...baseRoutes(),
      'POST /trips/3/expenses': () => jsonFailure(422, {
        error: 'Split required',
        code: 'INCOMPLETE_SPLIT',
        field: 'split',
        constraint: 'at least one trip member with a positive share',
      }),
    });
    renderTrip();
    await fillExpense(user);
    await user.click(button('Add & split'));
    const alert = await screen.findByText(/Split required\./);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Accepted: at least one trip member with a positive share.');
    // Every valid value stays and the shared status is not used for a field problem.
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('Taxi');
    expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('300');
    expect(statusOf('new-trip-expense:3')).not.toHaveTextContent('failed');
    expect(screen.getByRole('list', { name: 'Each member’s share of Beach dinner' })).toBeInTheDocument();
    expect(api.to('GET', '/finance/clarity')).toHaveLength(1);

    // A custom split that does not add up to the bill is caught before anything is sent.
    await user.click(button('Custom'));
    await user.type(screen.getByRole('textbox', { name: 'Share for Asha' }), '100');
    await user.type(screen.getByRole('textbox', { name: 'Share for Ravi' }), '100');
    await user.click(button('Add & split'));
    expect(await screen.findByText(/adds up to ₹200 but the bill is ₹300/)).toBeInTheDocument();
    expect(api.to('POST', '/trips/3/expenses')).toHaveLength(1);
  });

  it('records a settlement payment as its own change, apart from shared expenses', async () => {
    const user = userEvent.setup();
    let recorded = false;
    const afterPayment: TripOutcomeValue = {
      ...dinnerOutcomeValue(),
      tripVersion: 4,
      balances: [
        { memberId: 101, amountMinor: 33333, label: 'receivable' },
        { memberId: 102, amountMinor: 0, label: 'settled' },
        { memberId: 103, amountMinor: -33333, label: 'owed' },
      ],
      settlements: [{ fromMemberId: 103, toMemberId: 101, amount: { currency: 'INR', amountMinor: 33333 } }],
    };
    const api = mockTripApi({
      'GET /trips/3': tripDetail(),
      'GET /finance/clarity': () => jsonOk(readSnapshot(recorded
        ? tripSnapshot(MONTH, { dataVersion: 2, items: [tripOutcomeItem(MONTH, 2, afterPayment)] })
        : tripSnapshot(MONTH))),
      'POST /trips/3/expenses': () => {
        recorded = true;
        return jsonOk(tripWrite({ id: 12, operation: 'trip.expense.create', recordType: 'trip_expense', scopeKey: 'trip-expense:12' }));
      },
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    await user.click(await screen.findByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33' }));
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: done'));
    const [post] = api.to('POST', '/trips/3/expenses');
    expect(post?.body).toEqual({
      payer: 'Ravi',
      description: '↔ Settlement: Ravi → Asha',
      amount: 333.33,
      split: [{ name: 'Asha', share: 1 }],
    });
    // The plan and the balances come from the new confirmed outcome, and the success text stays after the transfer is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Record payment: Ravi pays Asha/ })).toBeNull());
    expect(screen.getByRole('button', { name: 'Record payment: Meera pays Asha ₹333.33' })).toBeInTheDocument();
    const ravi = document.querySelector('[data-member-id="102"]') as HTMLElement;
    expect(ravi).toHaveTextContent('Settled');

    await user.click(tab(/Expenses/));
    const payments = screen.getByRole('region', { name: /Settlement payments/ });
    expect(payments).toHaveTextContent('Ravi paid Asha');
    expect(payments).toHaveTextContent('They are not shared expenses');
    expect(screen.getAllByRole('list', { name: /Each member’s share of/ })).toHaveLength(1);
  });

  it('shows a failed settlement payment on its own scope and retries it with the same key', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({
      ...baseRoutes(),
      'POST /trips/3/expenses': (_call, attempt) => (attempt === 1
        ? jsonFailure(500, { error: 'Trip change could not be saved.', code: 'TRIP_MUTATION_FAILED' })
        : jsonOk(tripWrite({ id: 12, operation: 'trip.expense.create', recordType: 'trip_expense', scopeKey: 'trip-expense:12', replayed: true }))),
    });
    renderTrip({ route: '/trips/3?tab=balances' });
    await user.click(await screen.findByRole('button', { name: 'Record payment: Meera pays Asha ₹333.33' }));
    const scope = 'trip-settlement:3:103>101';
    await waitFor(() => expect(statusOf(scope)).toHaveTextContent('Payment from Meera to Asha: failed.'));
    // The other transfer is not blocked and the confirmed balances remain.
    expect(screen.getByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33' })).toBeEnabled();
    expect(screen.getByText('You are owed ₹666.66 (receivable).')).toBeInTheDocument();
    await user.click(button('Retry Payment from Meera to Asha'));
    await waitFor(() => expect(statusOf(scope)).toHaveTextContent('done (already saved)'));
    const posts = api.to('POST', '/trips/3/expenses');
    expect(posts[1]?.headers['Idempotency-Key']).toBe(posts[0]?.headers['Idempotency-Key']);
  });
});

describe('personal share', () => {
  const includeName = 'Include in my spending: Beach dinner';
  const withdrawName = 'Withdraw from my spending: Beach dinner';
  const link = 'PUT /trips/3/expenses/11/personal-link';
  const unlink = 'DELETE /trips/3/expenses/11/personal-link';
  const included = () => jsonOk(tripWrite({ id: 55, operation: 'trip.personal_link.include', recordType: 'trip_personal_link', recordId: 11, scopeKey: 'trip-personal-link:11' }));
  const personalRoutes = () => ({
    ...baseRoutes(),
    'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Travel', 'Other'], expenses: [] },
  });

  it('offers the share only to the linked member and confirms the exact amount, category, and month first', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({ ...personalRoutes(), [link]: included });
    renderTrip();
    const group = await screen.findByRole('group', { name: 'Your share of Beach dinner' });
    expect(group).toHaveTextContent('Your share: ₹333.34');
    // Nothing is sent until the confirmation.
    await user.click(button(includeName));
    const panel = await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
    expect(panel).toHaveTextContent(`Add ₹333.34 to Food spending for ${TODAY_MONTH}?`);
    expect(api.to('PUT', '/trips/3/expenses/11/personal-link')).toHaveLength(0);
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Category' }), 'Travel');
    expect(panel).toHaveTextContent(`Add ₹333.34 to Travel spending for ${TODAY_MONTH}?`);
    await user.click(within(panel).getByRole('button', { name: 'Confirm and include' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Include my share of Beach dinner: done'));
    const [put] = api.to('PUT', '/trips/3/expenses/11/personal-link');
    expect(put?.body).toEqual({ category: 'Travel', spentOn: TODAY });
    expect(put?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(group).toHaveTextContent(`Included in Travel spending for ${TODAY_MONTH}.`);
    expect(screen.queryByRole('button', { name: includeName })).toBeNull();
  });

  it('does not offer a personal share to a member who is not linked to the signed-in user', async () => {
    mockTripApi({
      ...personalRoutes(),
      'GET /trips/3': tripDetail({ members: [{ ...ASHA, email: 'someone.else@example.test' }, RAVI, MEERA] }),
    });
    renderTrip();
    await screen.findByRole('list', { name: 'Each member’s share of Beach dinner' });
    expect(screen.queryByRole('group', { name: 'Your share of Beach dinner' })).toBeNull();
  });

  it('retries an include with the same key, and withdraws once, with its own status', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({
      ...personalRoutes(),
      [link]: (_call, attempt) => {
        if (attempt === 1) throw new TypeError('Failed to fetch');
        return jsonOk(tripWrite({ id: 55, operation: 'trip.personal_link.include', recordType: 'trip_personal_link', recordId: 11, scopeKey: 'trip-personal-link:11', replayed: true }));
      },
      [unlink]: () => jsonOk(tripWrite({ operation: 'trip.personal_link.remove', recordType: 'trip_personal_link', recordId: 11, scopeKey: 'trip-personal-link:11' })),
    });
    renderTrip();
    await user.click(await screen.findByRole('button', { name: includeName }));
    await user.click(await screen.findByRole('button', { name: 'Confirm and include' }));
    const scope = 'trip-personal-link:11';
    await waitFor(() => expect(statusOf(scope)).toHaveTextContent('Include my share of Beach dinner: failed.'));
    // Still not included: the confirmed spending is unchanged and the confirmation stays open for the retry.
    expect(screen.getByRole('form', { name: 'Confirm including your share of Beach dinner' })).toBeInTheDocument();
    await user.click(button('Retry Include my share of Beach dinner'));
    await waitFor(() => expect(statusOf(scope)).toHaveTextContent('done (already saved)'));
    const puts = api.to('PUT', '/trips/3/expenses/11/personal-link');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.headers['Idempotency-Key']).toBe(puts[0]?.headers['Idempotency-Key']);

    // Withdrawal confirms the exact amount first, then removes the share once.
    await user.click(button(withdrawName));
    const confirmation = screen.getByRole('group', { name: 'Confirm withdrawing your share of Beach dinner' });
    expect(confirmation).toHaveTextContent('Remove ₹333.34 from your monthly spending?');
    expect(api.to('DELETE', '/trips/3/expenses/11/personal-link')).toHaveLength(0);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm and withdraw' }));
    await waitFor(() => expect(statusOf(scope)).toHaveTextContent('Withdraw my share of Beach dinner: done'));
    expect(api.to('DELETE', '/trips/3/expenses/11/personal-link')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Your share of Beach dinner' })).toHaveTextContent('Not included in your monthly spending.');
    expect(screen.queryByRole('button', { name: withdrawName })).toBeNull();
    expect(screen.getByRole('button', { name: includeName })).toBeInTheDocument();
  });

  it('shows a rejected category beside its field and sends nothing twice', async () => {
    const user = userEvent.setup();
    const api = mockTripApi({
      ...personalRoutes(),
      [link]: () => jsonFailure(400, { error: 'Unknown category — add it in Settings first.', code: 'UNKNOWN_PERSONAL_EXPENSE_CATEGORY', field: 'category' }),
    });
    renderTrip();
    await user.click(await screen.findByRole('button', { name: includeName }));
    await user.click(await screen.findByRole('button', { name: 'Confirm and include' }));
    const alert = await screen.findByText(/Unknown category/);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Category:');
    expect(statusOf('trip-personal-link:11')).not.toHaveTextContent('failed');
    expect(api.to('PUT', '/trips/3/expenses/11/personal-link')).toHaveLength(1);
  });
});

describe('data-use gate', () => {
  it('pauses new entries with a visible reason and never pauses withdrawing', async () => {
    const user = userEvent.setup();
    mockTripApi({
      'GET /clarity/settings': buildSettings(),
      ...baseRoutes(),
    });
    renderTrip({ gate: true });
    await screen.findByRole('list', { name: 'Each member’s share of Beach dinner' });
    await waitFor(() => expect(document.getElementById(DATA_USE_REASON_ID)).toBeInTheDocument());
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);

    const add = button('Add & split');
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    const include = button('Include in my spending: Beach dinner');
    expect(include).toBeDisabled();
    expect(include).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(button('Withdraw from my spending: Beach dinner')).not.toBeDisabled();

    await user.click(tab(/Balances/));
    const pay = await screen.findByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33' });
    expect(pay).toBeDisabled();
    expect(pay).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);

    await user.click(tab(/People/));
    expect(button('Add label')).toBeDisabled();
    expect(button('Add label')).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations on every trip tab in the %s theme', async (theme) => {
    const user = userEvent.setup();
    document.documentElement.dataset.theme = theme;
    try {
      mockTripApi({
        ...baseRoutes(),
        'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Other'], expenses: [] },
      });
      const { container } = renderTrip();
      await screen.findByRole('list', { name: 'Each member’s share of Beach dinner' });
      await user.click(button('Include in my spending: Beach dinner'));
      await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
      await user.click(button('Withdraw from my spending: Beach dinner'));
      const rules = { rules: { 'heading-order': { enabled: false } } };
      expect(await axe(container, rules)).toHaveNoViolations();
      await user.click(tab(/Balances/));
      await screen.findByRole('article', { name: 'Balances and settlement' });
      expect(await axe(container, rules)).toHaveNoViolations();
      await user.click(tab(/People/));
      expect(await axe(container, rules)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
