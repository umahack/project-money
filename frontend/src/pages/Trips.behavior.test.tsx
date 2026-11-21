// The trip pages, and Home beside them, rendered against a stateful fake API that
// implements the financial clarity contract for trips (snapshot reads with per-trip
// outcomes and the nearest-settlement highlight, trip writes that answer with trip and data
// versions, idempotent personal-share links, share status, disclosure, rotation, revocation
// and the public projection). It covers what Trips.clarity.test.tsx, TripDetail.clarity.test.tsx
// and ClarityTripShare.test.tsx do not, which use scripted per-route responses:
//
// - allocation, balances, and the settlement plan after each write, exactly once,
// - weighted rounding (half-paisa upward, then one paisa at a time in member order),
// - deterministic settlement and zero-sum labels after recorded settlement payments,
// - an invalid draft or invalid stored data keeps the last confirmed outcome,
// - personal include/withdraw: idempotent, replayed, and visible on Home only for the
//   linked member's own account,
// - responses that arrive in the opposite order from the requests,
// - one failing scope rolls back alone, with its draft kept and a retry under the same key,
// - Home and a trip page sharing one backend: an expense or payment updates Home's nearest
//   settlement in place, in the server's order (balance, time, name), and a failed write leaves Home alone,
// - the share flow: disclosure, cancel, create, rotate (the previous link stops), revoke (at once),
// - roles: a non-owner member cannot share or add people, and a payer records only their own payment,
// - feedback timing against a controlled clock, and axe in both themes.
//
// Timing in jsdom has no paint. A "frame" is 16 ms of fake time and every budget is checked
// against the fake clock; response-to-paint in a real browser is covered by e2e/trips.clarity.spec.ts.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { currentMonth, monthLabel } from '../money';
import {
  FakeTripsBackend,
  PUBLIC_TRIP_DISCLOSURE,
  TRIPS_VIEWER_EMAIL,
  pathsOf,
  publicAllowlistPaths,
  type FakeTripsInit,
} from '../test/fakeTripsBackend';
import { installTripsFetch } from '../test/fakeTripsFetch';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../test/test-utils';
import { Dashboard } from './Dashboard';
import { TripDetail } from './TripDetail';
import { Trips } from './Trips';

const MONTH = currentMonth();
const pad = (value: number) => String(value).padStart(2, '0');
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
const TODAY_MONTH = monthLabel(TODAY.slice(0, 7));
const RAVI_EMAIL = 'ravi@example.test';
const OUTSIDER_EMAIL = 'outsider@example.test';
const link = '/trips/3/expenses/11/personal-link';

type TripInit = FakeTripsInit['trips'][number];

/** ₹1,000.00 shared three ways. Asha (the signed-in user) paid: she is owed ₹666.66, Ravi and Meera owe ₹333.33. */
const GOA: TripInit = {
  id: 3,
  name: 'Goa weekend',
  destination: 'Goa',
  budget: 5000,
  startDate: '2026-01-09',
  endDate: '2026-01-12',
  members: [
    { id: 101, name: 'Asha', email: TRIPS_VIEWER_EMAIL },
    { id: 102, name: 'Ravi', email: RAVI_EMAIL },
    { id: 103, name: 'Meera' },
  ],
  expenses: [{ id: 11, payer: 'Asha', description: 'Beach dinner', amount: 1000, createdAt: `${MONTH}-02 12:00:00` }],
};

/**
 * Four members and unequal debts. Net balances: Asha +650, Ravi 0, Meera -550, Kiran -100.
 * The plan is Meera pays Asha 550, then Kiran pays Asha 100.
 */
const LADAKH: TripInit = {
  id: 4,
  name: 'Ladakh',
  members: [
    { id: 201, name: 'Asha', email: TRIPS_VIEWER_EMAIL },
    { id: 202, name: 'Ravi' },
    { id: 203, name: 'Meera' },
    { id: 204, name: 'Kiran' },
  ],
  expenses: [
    { id: 21, payer: 'Asha', description: 'Camp', amount: 1200, createdAt: `${MONTH}-02 09:00:00` },
    { id: 22, payer: 'Ravi', description: 'Fuel', amount: 400, createdAt: `${MONTH}-02 10:00:00` },
    { id: 23, payer: 'Kiran', description: 'Permits', amount: 300, split: [{ name: 'Asha', share: 1 }, { name: 'Meera', share: 1 }], createdAt: `${MONTH}-02 11:00:00` },
  ],
};

/** A two-person trip where Asha owes (Ravi paid) or is owed (Asha paid) `amount` rupees after the equal split. */
function pair(id: number, name: string, direction: 'owes' | 'owed', amount: number, recorded: string): TripInit {
  const payer = direction === 'owes' ? 'Ravi' : 'Asha';
  return {
    id,
    name,
    members: [{ id: id * 10 + 1, name: 'Asha', email: TRIPS_VIEWER_EMAIL }, { id: id * 10 + 2, name: 'Ravi' }],
    expenses: [{ payer, description: `${name} costs`, amount: amount * 2, createdAt: `${MONTH}-${recorded}` }],
  };
}

let navigateTo: (to: string) => void = () => undefined;
function NavProbe() {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return null;
}

interface SetupOptions {
  route?: string;
  home?: boolean;
  /** The signed-in account. Defaults to the owner of the trips. */
  viewer?: string;
}

function setup(init: FakeTripsInit, options: SetupOptions = {}) {
  const viewer = options.viewer ?? TRIPS_VIEWER_EMAIL;
  const backend = new FakeTripsBackend(MONTH, { ...init, viewer });
  const net = installTripsFetch(backend);
  const view = renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <NavProbe />
        {options.home ? <Dashboard /> : null}
        <Routes>
          <Route path="/trips" element={<Trips />} />
          <Route path="/trips/:id" element={<TripDetail />} />
          <Route path="*" element={null} />
        </Routes>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    {
      route: options.route ?? '/trips/3',
      queryClient: createTestQueryClient(),
      user: createTestUser({ email: viewer, name: viewer === TRIPS_VIEWER_EMAIL ? 'Test User' : 'Ravi' }),
    },
  );
  return { backend, net, ...view };
}

const statusOf = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement;
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const text = (element: Element | null | undefined) => element?.textContent ?? '';
const nonGet = (backend: FakeTripsBackend) => backend.log.filter((entry) => entry.method !== 'GET');
const region = (name: string) => document.querySelector(`[data-region="${name}"]`) as HTMLElement;
const homeTrip = () => screen.getByRole('article', { name: /^Nearest trip settlement:/ });
const homeRemaining = () => text(region('monthly-plan'));
const memberRow = (id: number) => document.querySelector(`[data-member-id="${id}"]`) as HTMLElement;
const allocations = (expense: string) => within(screen.getByRole('list', { name: `Each member’s share of ${expense}` })).getAllByRole('listitem');
const pay = (from: string, to: string, amount: string) => button(`Record payment: ${from} pays ${to} ${amount}`);
const planRows = () => Array.from(document.querySelectorAll('[data-transfer]')).map((row) => text(row).replace(/\s+/g, ' ').trim());

/** The signed amounts of the member balances on screen, in paise. The labels carry the sign, as they do for a reader. */
function uiBalancesMinor(): number[] {
  return Array.from(document.querySelectorAll('[data-member-id]')).map((row) => {
    const chip = text(row.querySelector('.balance-chip'));
    if (/Settled/.test(chip)) return 0;
    const amount = Math.round(Number(chip.replace(/[^0-9.]/g, '')) * 100);
    return /Owed/.test(chip) ? -amount : amount;
  });
}
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function click(element: HTMLElement) {
  act(() => {
    fireEvent.click(element);
  });
}

type User = ReturnType<typeof userEvent.setup>;

async function fillExpense(user: User, what: string, amount: string) {
  await user.type(await screen.findByRole('textbox', { name: 'What for?' }), what);
  await user.type(screen.getByRole('textbox', { name: 'Amount (₹)' }), amount);
}

async function loaded(expense = 'Beach dinner') {
  await screen.findByRole('list', { name: `Each member’s share of ${expense}` });
}

const reload = vi.fn();
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('each write updates allocation, balances, and settlement once', () => {
  it('shows the server allocation for a new shared expense and the new balances, with one write and no reload', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] });
    await loaded();
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));

    const rows = allocations('Taxi');
    expect(rows.map((row) => text(row))).toEqual(['Asha ₹100', 'Ravi ₹100', 'Meera ₹100']);
    // The dinner keeps its own allocation, with the paisa of rounding on the first member.
    expect(allocations('Beach dinner')[0]).toHaveTextContent('Asha ₹333.34 (+₹0.01 rounding adjustment)');
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);

    await user.click(tab(/Balances/));
    expect(await screen.findByText('You are owed ₹866.66 (receivable).')).toBeInTheDocument();
    expect(memberRow(102)).toHaveTextContent('Owed ₹433.33');
    expect(memberRow(103)).toHaveTextContent('Owed ₹433.33');
    expect(sum(uiBalancesMinor())).toBe(0);
    expect(planRows()).toEqual([expect.stringContaining('Ravi pays Asha'), expect.stringContaining('Meera pays Asha')]);

    expect(backend.trip(3).expenses).toHaveLength(2);
    expect(net.to('POST', '/trips/3/expenses')).toHaveLength(1);
    // One read of the trip, and one snapshot read before and one after the write: no broad reload.
    expect(net.to('GET', '/trips/3')).toHaveLength(1);
    expect(net.to('GET', '/finance/clarity')).toHaveLength(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('rounds half a paisa upward, then removes one paisa at a time in member order, so the shares equal the bill', async () => {
    const user = userEvent.setup();
    setup({ trips: [GOA] });
    await loaded();
    await fillExpense(user, 'Sweet', '0.05');
    await user.click(screen.getByRole('checkbox', { name: 'Meera' }));
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    // 5 paise between two: 2.5 rounds up to 3 each (6 in all), so the first member gives one paisa back.
    const rows = allocations('Sweet');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Asha ₹0.02 (-₹0.01 rounding adjustment)');
    expect(rows[1]).toHaveTextContent('Ravi ₹0.03');
    expect(rows[1]).not.toHaveTextContent('rounding');
  });

  it('weights a custom split exactly and allocates nothing to a member who has no share', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [GOA] });
    await loaded();
    await fillExpense(user, 'Boat', '100');
    await user.click(button('Custom'));
    await user.click(screen.getByRole('checkbox', { name: 'Meera' }));
    await user.type(screen.getByRole('textbox', { name: 'Share for Asha' }), '33.33');
    await user.type(screen.getByRole('textbox', { name: 'Share for Ravi' }), '66.67');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    const rows = allocations('Boat');
    expect(rows.map((row) => text(row))).toEqual(['Asha ₹33.33', 'Ravi ₹66.67']);
    expect(text(screen.getByText(/Asha paid · Weighted split/))).toContain('Weighted split');
    expect(backend.trip(3).expenses.at(-1)?.split).toEqual([{ name: 'Asha', share: 33.33 }, { name: 'Ravi', share: 66.67 }]);
  });

  it('adds a member once, leaves balances alone, and splits the next equal expense four ways', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] });
    await loaded();
    await user.click(tab(/People/));
    await user.type(screen.getByRole('textbox', { name: /Friend's name/ }), 'Kiran');
    await user.click(button('Add label'));
    await waitFor(() => expect(statusOf('new-trip-member:3')).toHaveTextContent('Add Kiran: done'));
    expect(screen.getAllByText('Kiran', { selector: 'strong' })).toHaveLength(1);
    expect(backend.trip(3).members.map((member) => member.name)).toEqual(['Asha', 'Ravi', 'Meera', 'Kiran']);
    expect(net.to('POST', '/trips/3/members')).toHaveLength(1);

    await user.click(tab(/Balances/));
    const kiran = backend.trip(3).members[3]!.id;
    expect(memberRow(kiran)).toHaveTextContent('Settled');
    expect(memberRow(101)).toHaveTextContent('Receivable ₹666.66');
    expect(sum(uiBalancesMinor())).toBe(0);

    await user.click(tab(/Expenses/));
    await fillExpense(user, 'Lunch', '400');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    expect(allocations('Lunch').map((row) => text(row))).toEqual(['Asha ₹100', 'Ravi ₹100', 'Meera ₹100', 'Kiran ₹100']);
    expect(net.to('GET', '/trips/3')).toHaveLength(1);
  });

  it('records each settlement payment once as its own change and ends with every member settled', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances' });
    await user.click(await screen.findByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33' }));
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: done'));
    expect(memberRow(102)).toHaveTextContent('Settled');
    expect(memberRow(101)).toHaveTextContent('Receivable ₹333.33');
    expect(screen.getByText('You are owed ₹333.33 (receivable).')).toBeInTheDocument();
    expect(planRows()).toEqual([expect.stringContaining('Meera pays Asha')]);
    expect(sum(uiBalancesMinor())).toBe(0);

    await user.click(pay('Meera', 'Asha', '₹333.33'));
    await waitFor(() => expect(statusOf('trip-settlement:3:103>101')).toHaveTextContent('Payment from Meera to Asha: done'));
    expect(screen.getByText('You are settled on this trip.')).toBeInTheDocument();
    expect(screen.getAllByText('Settled', { selector: '.balance-chip' })).toHaveLength(3);
    expect(screen.getByText(/All square/)).toBeInTheDocument();
    expect(planRows()).toEqual([]);
    expect(sum(uiBalancesMinor())).toBe(0);
    expect(backend.trip(3).expenses.filter((expense) => expense.description.startsWith('↔ Settlement:'))).toHaveLength(2);
    expect(net.to('POST', '/trips/3/expenses')).toHaveLength(2);
    expect(net.to('GET', '/trips/3')).toHaveLength(1);

    // The payments are listed apart from shared expenses, and no shared expense was added.
    await user.click(tab(/Expenses/));
    const payments = screen.getByRole('region', { name: /Settlement payments/ });
    expect(within(payments).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('list', { name: /Each member’s share of/ })).toHaveLength(1);
  });
});

describe('deterministic settlement and zero-sum labels', () => {
  it('proposes the largest debtor first, keeps balances at zero sum, and recomputes after each recorded payment', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [LADAKH] }, { route: '/trips/4?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(uiBalancesMinor()).toEqual([65000, 0, -55000, -10000]);
    expect(sum(uiBalancesMinor())).toBe(0);
    expect(memberRow(201)).toHaveTextContent('Receivable ₹650');
    expect(memberRow(202)).toHaveTextContent('Settled');
    expect(memberRow(203)).toHaveTextContent('Owed ₹550');
    expect(planRows()).toEqual([
      expect.stringMatching(/Meera pays Asha.*₹550/),
      expect.stringMatching(/Kiran pays Asha.*₹100/),
    ]);

    await user.click(pay('Meera', 'Asha', '₹550'));
    await waitFor(() => expect(statusOf('trip-settlement:4:203>201')).toHaveTextContent('done'));
    expect(uiBalancesMinor()).toEqual([10000, 0, 0, -10000]);
    expect(planRows()).toEqual([expect.stringMatching(/Kiran pays Asha.*₹100/)]);
    expect(sum(uiBalancesMinor())).toBe(0);

    await user.click(pay('Kiran', 'Asha', '₹100'));
    await waitFor(() => expect(statusOf('trip-settlement:4:204>201')).toHaveTextContent('done'));
    expect(uiBalancesMinor()).toEqual([0, 0, 0, 0]);
    expect(screen.getByText('You are settled on this trip.')).toBeInTheDocument();
    expect(screen.getByText(/All square/)).toBeInTheDocument();
    // The stored payments, replayed through the calculator, give the same zero balances.
    expect(sum(backend.snapshot().outcomes.tripSummary.items![0]!.value!.balances.map((balance) => balance.amountMinor))).toBe(0);
  });

  it('reports the nearest settlement from each viewer’s own balance, with opposite labels for the two sides', async () => {
    const { backend } = setup({ trips: [{ ...GOA, owner: TRIPS_VIEWER_EMAIL }] });
    await loaded();
    // Asha is owed ₹666.66 and Ravi owes his own ₹333.33 share: each snapshot is that account's view of the same trip.
    const asha = backend.snapshot(TRIPS_VIEWER_EMAIL).highlights!.nearestTripSettlement!;
    const ravi = backend.snapshot(RAVI_EMAIL).highlights!.nearestTripSettlement!;
    expect(asha).toMatchObject({ label: 'receivable', userBalance: { amountMinor: 66666 } });
    expect(ravi).toMatchObject({ label: 'owed', userBalance: { amountMinor: -33333 } });
  });
});

describe('invalid drafts and invalid stored data keep the last confirmed outcome', () => {
  it('rejects a draft the server cannot accept, keeps every entered value and the confirmed shares, and writes nothing', async () => {
    const user = userEvent.setup();
    const { backend, net, queryClient } = setup({ trips: [GOA] });
    await loaded();
    // Stored data goes bad elsewhere. The page still shows the last confirmed shares.
    backend.corruptExpense(3, 11);
    const versionBefore = backend.trip(3).version;
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));

    const alert = await screen.findByText(/Split required\./);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Accepted: at least one trip member with a positive share.');
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('Taxi');
    expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('300');
    expect(statusOf('new-trip-expense:3')).not.toHaveTextContent('failed');
    expect(allocations('Beach dinner')[0]).toHaveTextContent('Asha ₹333.34');
    expect(backend.trip(3).expenses).toHaveLength(1);
    expect(backend.trip(3).version).toBe(versionBefore);
    expect(net.to('POST', '/trips/3/expenses')).toHaveLength(1);

    // A fresh read now reports the stored data as invalid. Balances are withheld, and the last confirmed ones stay visible.
    await user.click(tab(/Balances/));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['clarity', MONTH] });
    });
    const card = await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(card).toHaveTextContent('Needs correction');
    expect(card).toHaveTextContent('at least one trip member with a positive share');
    const retained = screen.getByRole('heading', { name: 'Last confirmed balances' }).closest('section') as HTMLElement;
    expect(retained).toHaveTextContent('Receivable ₹666.66');
    expect(retained).toHaveTextContent('Owed ₹333.33');
    expect(screen.queryByRole('button', { name: /Record payment/ })).toBeNull();

    // The shares on the expense list stay the last confirmed ones, and nothing was rewritten by reading the invalid data.
    await user.click(tab(/Expenses/));
    expect(allocations('Beach dinner')[0]).toHaveTextContent('Asha ₹333.34 (+₹0.01 rounding adjustment)');
    expect(backend.trip(3).expenses[0]?.split).toEqual([]);
  });

  it('marks balances unavailable when invalid data was never confirmed', async () => {
    const corrupt: TripInit = { ...GOA, expenses: [{ ...GOA.expenses![0]!, split: [] }] };
    const { backend } = setup({ trips: [corrupt] }, { route: '/trips/3?tab=balances' });
    const card = await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(card).toHaveTextContent('Needs correction');
    expect(screen.getByText(/Member balances and the settlement are unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Last confirmed balances' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Record payment/ })).toBeNull();
    expect(backend.trip(3).expenses[0]?.split).toEqual([]);
  });
});

describe('personal share: include and withdraw', () => {
  const includeName = 'Include in my spending: Beach dinner';
  const withdrawName = 'Withdraw from my spending: Beach dinner';
  async function include(user: User, category = 'Travel') {
    await user.click(button(includeName));
    const panel = await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Category' }), category);
    await user.click(within(panel).getByRole('button', { name: 'Confirm and include' }));
  }

  it('changes Home’s spending by the exact share once on include and restores it once on withdraw', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { home: true });
    await loaded();
    await waitFor(() => expect(homeRemaining()).toContain('₹54,000'));
    const plan = region('monthly-plan');

    await user.click(button(includeName));
    const panel = await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
    expect(panel).toHaveTextContent(`Add ₹333.34 to Food spending for ${TODAY_MONTH}?`);
    // Nothing is sent, and Home is unchanged, until the confirmation.
    expect(net.to('PUT', link)).toHaveLength(0);
    expect(homeRemaining()).toContain('₹54,000');
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Category' }), 'Travel');
    await user.click(within(panel).getByRole('button', { name: 'Confirm and include' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Include my share of Beach dinner: done'));

    await waitFor(() => expect(homeRemaining()).toContain('₹53,666.66'));
    expect(region('monthly-plan')).toBe(plan);
    expect(backend.account().links).toEqual([expect.objectContaining({ category: 'Travel', spentOn: TODAY, amountMinor: 33334 })]);
    expect(net.to('PUT', link)).toHaveLength(1);
    expect(net.to('PUT', link)[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // The trip balance is not changed by the link.
    expect(backend.trip(3).version).toBe(4);
    expect(screen.getByRole('group', { name: 'Your share of Beach dinner' })).toHaveTextContent(`Included in Travel spending for ${TODAY_MONTH}.`);

    await user.click(button(withdrawName));
    const confirmation = screen.getByRole('group', { name: 'Confirm withdrawing your share of Beach dinner' });
    expect(confirmation).toHaveTextContent('Remove ₹333.34 from your monthly spending?');
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm and withdraw' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Withdraw my share of Beach dinner: done'));
    await waitFor(() => expect(homeRemaining()).toContain('₹54,000'));
    expect(backend.account().links).toEqual([]);
    expect(net.to('DELETE', link)).toHaveLength(1);
    expect(net.to('GET', '/finance/clarity')).toHaveLength(3);
    expect(reload).not.toHaveBeenCalled();
  });

  it('counts an include once when its response was lost and the retry is replayed, and a repeated withdraw changes nothing', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { home: true });
    await loaded();
    await waitFor(() => expect(homeRemaining()).toContain('₹54,000'));
    net.loseResponse('PUT', link);
    await include(user);
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Include my share of Beach dinner: failed.'));
    // The server applied it, but this page was not told: Home still shows the last confirmed spending.
    expect(backend.account().links).toHaveLength(1);
    expect(homeRemaining()).toContain('₹54,000');

    await user.click(button('Retry Include my share of Beach dinner'));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('done (already saved)'));
    await waitFor(() => expect(homeRemaining()).toContain('₹53,666.66'));
    const puts = net.to('PUT', link);
    expect(puts).toHaveLength(2);
    expect(puts[1]?.headers['idempotency-key']).toBe(puts[0]?.headers['idempotency-key']);
    expect(backend.account().links).toHaveLength(1);
    expect(backend.account().links[0]?.amountMinor).toBe(33334);

    // The same key again, and the same values under a new key, are replays that change nothing.
    const key = puts[0]!.headers['idempotency-key']!;
    const again = backend.handle({ method: 'PUT', path: link, body: { category: 'Travel', spentOn: TODAY }, headers: { 'idempotency-key': key } });
    expect(again.body).toMatchObject({ mutation: { replayed: true }, ok: true });
    const fresh = backend.handle({ method: 'PUT', path: link, body: { category: 'Travel', spentOn: TODAY }, headers: { 'idempotency-key': 'a-new-key-0001' } });
    expect(fresh.body).toMatchObject({ mutation: { replayed: true }, ok: true });
    expect(backend.account().links).toHaveLength(1);
    // Different values for an included share are a conflict and change nothing.
    const different = backend.handle({ method: 'PUT', path: link, body: { category: 'Food', spentOn: TODAY }, headers: { 'idempotency-key': 'a-new-key-0002' } });
    expect(different.status).toBe(409);
    expect(backend.account().links[0]?.category).toBe('Travel');

    await user.click(button(withdrawName));
    await user.click(within(screen.getByRole('group', { name: 'Confirm withdrawing your share of Beach dinner' })).getByRole('button', { name: 'Confirm and withdraw' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Withdraw my share of Beach dinner: done'));
    await waitFor(() => expect(homeRemaining()).toContain('₹54,000'));
    const dataVersion = backend.account().dataVersion;
    const repeated = backend.handle({ method: 'DELETE', path: link, headers: { 'idempotency-key': 'a-new-key-0003' } });
    expect(repeated.body).toMatchObject({ ok: true, mutation: { replayed: true, status: 'reversed' } });
    expect(backend.account().dataVersion).toBe(dataVersion);
    expect(backend.account().links).toEqual([]);
  });

  it('changes figures only for the linked member’s own account: another member’s include does not reach this Home', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [GOA] }, { home: true });
    await loaded();
    await waitFor(() => expect(homeRemaining()).toContain('₹54,000'));
    const ashaVersion = backend.account(TRIPS_VIEWER_EMAIL).dataVersion;
    const tripVersion = backend.trip(3).version;

    // Ravi (linked to his own member) includes his share, from his own account.
    const ravi = backend.handle({
      method: 'PUT',
      path: link,
      body: { category: 'Food', spentOn: TODAY },
      headers: { 'idempotency-key': 'ravi-include-0001' },
    }, RAVI_EMAIL);
    expect(ravi.status).toBe(200);
    expect(backend.account(RAVI_EMAIL).links).toEqual([expect.objectContaining({ amountMinor: 33333 })]);
    expect(backend.snapshot(RAVI_EMAIL).outcomes.spending.value!.remainingSpendable.amountMinor).toBe(5_400_000 - 33_333);
    // Asha's account, version, and the trip are untouched, so Asha's next snapshot is unchanged.
    expect(backend.account(TRIPS_VIEWER_EMAIL).links).toEqual([]);
    expect(backend.account(TRIPS_VIEWER_EMAIL).dataVersion).toBe(ashaVersion);
    expect(backend.trip(3).version).toBe(tripVersion);
    expect(backend.snapshot(TRIPS_VIEWER_EMAIL).outcomes.spending.value!.remainingSpendable.amountMinor).toBe(5_400_000);

    // Asha adds a trip expense. Her refreshed Home still shows only her own spending.
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    expect(homeRemaining()).toContain('₹54,000');
    expect(homeRemaining()).not.toContain('₹53,');

    // An account that is not on the trip cannot include a share, and learns nothing about the trip.
    const outsider = backend.handle({ method: 'PUT', path: link, body: { category: 'Food', spentOn: TODAY }, headers: { 'idempotency-key': 'outsider-0001' } }, OUTSIDER_EMAIL);
    expect(outsider.status).toBe(404);
    expect(outsider.body).toEqual({ error: 'Not found' });
    expect(backend.account(OUTSIDER_EMAIL).links).toEqual([]);
  });

  it('requires an Idempotency-Key, and refuses one key for two different commands', async () => {
    const { backend } = setup({ trips: [GOA] });
    await loaded();
    const missing = backend.handle({ method: 'PUT', path: link, body: { category: 'Food', spentOn: TODAY }, headers: {} });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    const first = backend.handle({ method: 'PUT', path: link, body: { category: 'Food', spentOn: TODAY }, headers: { 'idempotency-key': 'same-key-0001' } });
    expect(first.status).toBe(200);
    // The same key for a different command is refused, so a stale retry can never apply a different change.
    const reused = backend.handle({ method: 'PUT', path: link, body: { category: 'Travel', spentOn: TODAY }, headers: { 'idempotency-key': 'same-key-0001' } });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(backend.account().links).toHaveLength(1);
  });
});

describe('responses arrive in the opposite order from the requests', () => {
  it('keeps both payments and the newest balances when the older confirmed snapshot arrives last', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances', home: true });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    await screen.findByRole('article', { name: /^Nearest trip settlement:/ });
    expect(net.to('GET', '/finance/clarity')).toHaveLength(1);

    // First payment: its snapshot is read right after the write (version 2) and held.
    const older = net.holdResponse('GET', '/finance/clarity');
    await user.click(pay('Ravi', 'Asha', '₹333.33'));
    await waitFor(() => expect(net.to('GET', '/finance/clarity')).toHaveLength(2));
    // Second payment: its snapshot (version 3, both payments) is held as well.
    const newer = net.holdResponse('GET', '/finance/clarity');
    await user.click(pay('Meera', 'Asha', '₹333.33'));
    await waitFor(() => expect(net.to('GET', '/finance/clarity')).toHaveLength(3));
    expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('pending');
    expect(statusOf('trip-settlement:3:103>101')).toHaveTextContent('pending');
    // Nothing is confirmed on screen yet.
    expect(homeTrip()).toHaveTextContent('₹666.66');

    await act(async () => {
      newer.release();
    });
    await waitFor(() => expect(statusOf('trip-settlement:3:103>101')).toHaveTextContent('Payment from Meera to Asha: done'));
    await waitFor(() => expect(screen.getByText('You are settled on this trip.')).toBeInTheDocument());
    expect(screen.getByText('No trip settlement is pending.')).toBeInTheDocument();

    // The older snapshot (Meera still owing) arrives last and must not bring her debt back.
    await act(async () => {
      older.release();
    });
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: done'));
    expect(screen.getByText('You are settled on this trip.')).toBeInTheDocument();
    expect(screen.getAllByText('Settled', { selector: '.balance-chip' })).toHaveLength(3);
    expect(screen.getByText('No trip settlement is pending.')).toBeInTheDocument();
    expect(planRows()).toEqual([]);
    expect(backend.trip(3).expenses).toHaveLength(3);
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failed payment on its own scope and a confirmed one on the other, whichever answers first', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
    const first = net.hold('POST', '/trips/3/expenses');
    const second = net.hold('POST', '/trips/3/expenses');
    click(pay('Ravi', 'Asha', '₹333.33'));
    click(pay('Meera', 'Asha', '₹333.33'));
    await act(async () => {
      second.release();
    });
    // Whichever request reaches the server first takes the injected failure; the other is confirmed.
    await waitFor(() => expect(text(statusOf('trip-settlement:3:102>101')) + text(statusOf('trip-settlement:3:103>101'))).toMatch(/failed\./));
    await act(async () => {
      first.release();
    });
    await waitFor(() => expect(text(statusOf('trip-settlement:3:102>101')) + text(statusOf('trip-settlement:3:103>101'))).toMatch(/done/));
    expect(backend.trip(3).expenses).toHaveLength(2);
    expect(sum(uiBalancesMinor())).toBe(0);
  });
});

describe('a failing scope rolls back alone and keeps its draft', () => {
  it('fails the expense while a member and a payment are confirmed, then retries it once with the same key', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] });
    await loaded();
    backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('Your last confirmed values are unchanged.');
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('Taxi');
    expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('300');
    expect(backend.trip(3).expenses).toHaveLength(1);
    expect(screen.queryByText('Taxi', { selector: 'strong' })).toBeNull();

    // Other scopes still work: add a member, then record a payment.
    await user.click(tab(/People/));
    await user.type(screen.getByRole('textbox', { name: /Friend's name/ }), 'Kiran');
    await user.click(button('Add label'));
    await waitFor(() => expect(statusOf('new-trip-member:3')).toHaveTextContent('Add Kiran: done'));
    await user.click(tab(/Balances/));
    await user.click(await screen.findByRole('button', { name: 'Record payment: Ravi pays Asha ₹333.33' }));
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: done'));
    expect(memberRow(102)).toHaveTextContent('Settled');

    // The failed scope stays failed, with its retry, while the other scopes finished.
    await user.click(tab(/Expenses/));
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.');
    await user.click(button('Retry Add expense'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    const posts = net.to('POST', '/trips/3/expenses');
    expect(posts).toHaveLength(3);
    expect(posts[2]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[2]?.body).toEqual(posts[0]?.body);
    // Applied once: dinner, the payment, and the taxi.
    expect(backend.trip(3).expenses.map((expense) => expense.description)).toEqual(['Beach dinner', '↔ Settlement: Ravi → Asha', 'Taxi']);
    // The taxi was entered before Kiran joined, so it is split between the three who were on the trip.
    expect(allocations('Taxi')).toHaveLength(3);
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);
  });

  it('counts an expense once when its response was lost and the retry is replayed by the server', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { home: true });
    await loaded();
    await screen.findByRole('article', { name: /^Nearest trip settlement:/ });
    net.loseResponse('POST', '/trips/3/expenses');
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
    // The server saved it, but this page was not told: the confirmed outcome and Home are unchanged.
    expect(backend.trip(3).expenses).toHaveLength(2);
    expect(homeTrip()).toHaveTextContent('₹666.66');
    expect(screen.queryByText('Taxi', { selector: 'strong' })).toBeNull();

    await user.click(button('Retry Add expense'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('done (already saved)'));
    expect(backend.trip(3).expenses).toHaveLength(2);
    expect(net.to('POST', '/trips/3/expenses')).toHaveLength(2);
    expect(await screen.findByRole('list', { name: 'Each member’s share of Taxi' })).toBeInTheDocument();
    expect(screen.getAllByText('Taxi', { selector: 'strong' })).toHaveLength(1);
    await waitFor(() => expect(homeTrip()).toHaveTextContent('₹866.66'));
  });

  it('does not send a stale trip version twice, and answers a stale write with the current version', async () => {
    const { backend } = setup({ trips: [GOA] });
    await loaded();
    backend.addExpenseElsewhere(3, { payer: 'Ravi', description: 'Snacks', amount: 90 });
    const stale = backend.handle({
      method: 'POST',
      path: '/trips/3/members',
      body: { name: 'Kiran', expectedTripVersion: 1 },
      headers: { 'idempotency-key': 'stale-write-0001' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'TRIP_VERSION_CONFLICT', currentTripVersion: backend.trip(3).version });
    expect(backend.trip(3).members).toHaveLength(3);
    const fresh = backend.handle({
      method: 'POST',
      path: '/trips/3/members',
      body: { name: 'Kiran', expectedTripVersion: backend.trip(3).version },
      headers: { 'idempotency-key': 'stale-write-0002' },
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ tripVersion: backend.trip(3).version, tripOutcome: { status: 'available' } });
  });
});

describe('Home beside a trip on one backend', () => {
  it('updates Home’s nearest settlement in place from a recorded payment and an expense, with no reload and no re-read of the trip', async () => {
    const user = userEvent.setup();
    const { net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances', home: true });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    await screen.findByRole('article', { name: 'Nearest trip settlement: Goa weekend' });
    const marker = document.body.appendChild(document.createElement('i'));
    const card = homeTrip();
    expect(card).toHaveTextContent('You are owed');
    expect(card).toHaveTextContent('₹666.66');

    await user.click(pay('Ravi', 'Asha', '₹333.33'));
    await waitFor(() => expect(homeTrip()).toHaveTextContent('₹333.33'));
    expect(homeTrip()).toBe(card);

    await user.click(tab(/Expenses/));
    await fillExpense(user, 'Taxi', '300');
    await user.click(button('Add & split'));
    await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: done'));
    // Asha paid ₹300 and owes ₹100 of it: +₹200 on top of ₹333.33.
    await waitFor(() => expect(homeTrip()).toHaveTextContent('₹533.33'));
    expect(homeTrip()).toBe(card);

    await user.click(tab(/Balances/));
    await user.click(pay('Meera', 'Asha', '₹433.33'));
    await waitFor(() => expect(statusOf('trip-settlement:3:103>101')).toHaveTextContent('done'));
    await waitFor(() => expect(homeTrip()).toHaveTextContent('₹100'));
    expect(net.to('GET', '/trips/3')).toHaveLength(1);
    expect(net.to('GET', '/finance/clarity')).toHaveLength(4);
    expect(marker.isConnected).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    marker.remove();
  });

  it('keeps Home on the confirmed settlement while a write is pending, and unchanged when it fails', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances', home: true });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    await screen.findByRole('article', { name: 'Nearest trip settlement: Goa weekend' });
    const card = homeTrip();
    const before = text(card);
    const reads = net.to('GET', '/finance/clarity').length;
    backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
    const gate = net.hold('POST', '/trips/3/expenses');
    click(pay('Ravi', 'Asha', '₹333.33'));
    expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('pending');
    expect(homeTrip()).toBe(card);
    expect(text(card)).toBe(before);

    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: failed.'));
    expect(homeTrip()).toBe(card);
    expect(text(card)).toBe(before);
    expect(memberRow(102)).toHaveTextContent('Owed ₹333.33');
    expect(backend.trip(3).expenses).toHaveLength(1);
    expect(net.to('GET', '/finance/clarity')).toHaveLength(reads);
    await user.click(within(statusOf('trip-settlement:3:102>101')).getByRole('button', { name: 'Retry Payment from Ravi to Asha' }));
    await waitFor(() => expect(homeTrip()).toHaveTextContent('₹333.33'));
  });

  it('moves Home through trips by balance, then earliest record, then name, as payments are recorded', async () => {
    const user = userEvent.setup();
    const trips: TripInit[] = [
      // Same balance and the same first record: the name decides. Aardvark before Beta.
      pair(11, 'Beta', 'owes', 500, '03 10:00:00'),
      pair(12, 'Alpha', 'owed', 500, '05 10:00:00'),
      pair(13, 'Aardvark', 'owes', 500, '03 10:00:00'),
      // The largest balance leads, whatever the time or name.
      pair(10, 'Zulu', 'owes', 900, '09 10:00:00'),
    ];
    const { net } = setup({ trips }, { route: '/trips/10?tab=balances', home: true });
    await screen.findByRole('article', { name: 'Nearest trip settlement: Zulu' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    const card = homeTrip();
    expect(card).toHaveTextContent('You owe');
    expect(card).toHaveTextContent('₹900');

    await user.click(pay('Asha', 'Ravi', '₹900'));
    // Balance 500 ties three ways. Beta and Aardvark were recorded first (the 3rd); Alpha on the 5th. Name breaks the tie.
    await screen.findByRole('article', { name: 'Nearest trip settlement: Aardvark' });
    expect(homeTrip()).toHaveTextContent('You owe');

    act(() => navigateTo('/trips/13?tab=balances'));
    await user.click(await screen.findByRole('button', { name: 'Record payment: Asha pays Ravi ₹500' }));
    await screen.findByRole('article', { name: 'Nearest trip settlement: Beta' });

    act(() => navigateTo('/trips/11?tab=balances'));
    await user.click(await screen.findByRole('button', { name: 'Record payment: Asha pays Ravi ₹500' }));
    // Alpha was recorded last, but it is the only unsettled trip left, and Asha is owed there.
    await screen.findByRole('article', { name: 'Nearest trip settlement: Alpha' });
    expect(homeTrip()).toHaveTextContent('You are owed');

    act(() => navigateTo('/trips/12?tab=balances'));
    await user.click(await screen.findByRole('button', { name: 'Record payment: Ravi pays Asha ₹500' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /^Nearest trip settlement:/ })).toBeNull());
    expect(screen.getByText('No trip settlement is pending.')).toBeInTheDocument();
    // Only one snapshot read per write, plus the first: nothing else was re-read.
    expect(net.to('GET', '/finance/clarity')).toHaveLength(5);
    expect(reload).not.toHaveBeenCalled();
  });

  it('lists trips in the server’s nearest-settlement order', async () => {
    const trips: TripInit[] = [
      pair(1, 'Small', 'owes', 100, '03 10:00:00'),
      pair(2, 'Large', 'owes', 800, '04 10:00:00'),
      pair(3, 'Middle', 'owed', 400, '05 10:00:00'),
    ];
    setup({ trips }, { route: '/trips' });
    const list = await screen.findByRole('list', { name: 'Trips, nearest settlement first' });
    await waitFor(() => expect(within(list).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Large'));
    expect(within(list).getAllByRole('heading', { level: 3 }).map((heading) => text(heading))).toEqual(['Large', 'Middle', 'Small']);
    expect(within(list).getByText('You owe ₹800 (owed)')).toBeInTheDocument();
  });
});

describe('roles', () => {
  it('shows a non-owner member only the tabs and payments they may use, and the server refuses what the page does not offer', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [{ ...GOA, owner: 'owner@example.test', members: [...GOA.members!, { id: 104, name: 'Owner', email: 'owner@example.test' }] }] }, { viewer: RAVI_EMAIL, route: '/trips/3?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    expect(screen.queryByRole('tab', { name: /Share/ })).toBeNull();
    // Ravi (a member linked to his own account) owes Asha. He may record his own payment, and not Meera's.
    expect(screen.getByText('You owe ₹250 (owed).')).toBeInTheDocument();
    expect(pay('Ravi', 'Asha', '₹250')).toBeEnabled();
    expect(pay('Meera', 'Asha', '₹250')).toBeDisabled();
    expect(screen.getByText('Only Meera or the trip owner can record this payment.')).toBeInTheDocument();
    await user.click(tab(/People/));
    expect(screen.queryByRole('form', { name: 'Add an offline friend' })).toBeNull();
    expect(screen.getByText('Only the trip owner can add people to this trip.')).toBeInTheDocument();

    // Direct requests: a member cannot add people or touch sharing, and cannot mark another member's payment.
    const member = backend.handle({ method: 'POST', path: '/trips/3/members', body: { name: 'Sneaky' }, headers: { 'idempotency-key': 'member-write-0001' } }, RAVI_EMAIL);
    expect(member.status).toBe(404);
    for (const [method, path] of [['POST', '/trips/3/share'], ['DELETE', '/trips/3/share'], ['GET', '/trips/3/share'], ['GET', '/trips/3/share/disclosure']] as const) {
      const reply = backend.handle({ method, path, headers: {} }, RAVI_EMAIL);
      expect(reply, `${method} ${path}`).toEqual({ status: 404, body: { error: 'Not found' } });
    }
    const forged = backend.handle({
      method: 'POST',
      path: '/trips/3/expenses',
      body: { payer: 'Meera', description: '↔ Settlement: Meera → Asha', amount: 250, split: [{ name: 'Asha', share: 1 }] },
      headers: { 'idempotency-key': 'forged-0001' },
    }, RAVI_EMAIL);
    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ code: 'SETTLEMENT_PAYER_NOT_AUTHORIZED' });
    expect(backend.trip(3).members).toHaveLength(4);
    expect(backend.trip(3).expenses).toHaveLength(1);

    await user.click(tab(/Balances/));
    await user.click(pay('Ravi', 'Asha', '₹250'));
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('Payment from Ravi to Asha: done'));
    expect(memberRow(102)).toHaveTextContent('Settled');
  });

  it('lets an outsider see nothing of the trip', async () => {
    const { backend } = setup({ trips: [GOA] }, { viewer: OUTSIDER_EMAIL });
    expect(await screen.findByText('Trip not found')).toBeInTheDocument();
    expect(backend.trip(3).expenses).toHaveLength(1);
  });
});

describe('sharing', () => {
  const shareRoute = '/trips/3?tab=share';
  const publicPath = (token: string) => `/public/trips/${token}`;
  const publicGet = (backend: FakeTripsBackend, token: string) => backend.handle({ method: 'GET', path: publicPath(token) }, 'anonymous@example.invalid');

  it('shows the fixed public fields before anything is enabled, and cancelling changes and sends nothing', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: shareRoute });
    await screen.findByText(/Sharing is off\./);
    const trigger = button('Create public link');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Create a public link' });
    await within(dialog).findByText('Trip name');
    const shown = within(dialog).getAllByRole('listitem').filter((item) => item.hasAttribute('data-field')).map((item) => item.getAttribute('data-field'));
    expect(shown).toEqual(publicAllowlistPaths());
    const labels = PUBLIC_TRIP_DISCLOSURE.groups.flatMap((group) => group.fields.map((field) => field.label));
    for (const label of labels) expect(within(dialog).getByText(label)).toBeInTheDocument();
    expect(within(within(dialog).getByRole('list', { name: 'Stays private' })).getAllByRole('listitem').map((item) => text(item))).toEqual([...PUBLIC_TRIP_DISCLOSURE.private]);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(net.calls.filter((call) => call.method === 'POST' && call.path === '/trips/3/share')).toHaveLength(0);
    expect(backend.trip(3).share).toEqual({ enabled: false, token: null });
  });

  it('creates one link on confirmation that serves exactly the disclosed fields, and nothing private', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] }, { route: shareRoute });
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Create public link' }));
    const field = await screen.findByRole('textbox', { name: /Public link/ });
    expect(net.to('POST', '/trips/3/share')).toHaveLength(1);
    const token = backend.trip(3).share.token!;
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(field).toHaveValue(`${window.location.origin}/share/trip/${token}`);
    expect(field).toHaveFocus();

    const response = publicGet(backend, token);
    expect(response.status).toBe(200);
    const emitted = pathsOf(response.body);
    const allowed = new Set(publicAllowlistPaths());
    expect(emitted.filter((path) => !allowed.has(path))).toEqual([]);
    expect([...allowed].filter((path) => !emitted.includes(path))).toEqual([]);
    const serialized = JSON.stringify(response.body);
    for (const secret of [TRIPS_VIEWER_EMAIL, RAVI_EMAIL, token, '"id"', 'tripVersion', 'dataVersion', 'personal', 'user_id', 'public_token']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('rotates the link: the previous link stops working at once and the new one serves the same fields', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [GOA] }, { route: shareRoute });
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create public link' }));
    await screen.findByRole('textbox', { name: /Public link/ });
    const first = backend.trip(3).share.token!;
    expect(publicGet(backend, first).status).toBe(200);

    await user.click(button('Rotate link'));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the public link' });
    await within(dialog).findByText('Trip name');
    expect(dialog).toHaveTextContent('The previous link stops working');
    // Opening and cancelling the rotation keeps the link as it was.
    expect(publicGet(backend, first).status).toBe(200);
    await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
    await waitFor(() => expect(backend.trip(3).share.token).not.toBe(first));
    const second = backend.trip(3).share.token!;
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${second}`));
    expect(publicGet(backend, first)).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(publicGet(backend, second).status).toBe(200);
    expect(pathsOf(publicGet(backend, second).body).every((path) => publicAllowlistPaths().includes(path))).toBe(true);
  });

  it('revokes at once, keeps the private trip data, and answers every old and unknown token the same way', async () => {
    const user = userEvent.setup();
    const { backend } = setup({ trips: [GOA] }, { route: shareRoute });
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create public link' }));
    await screen.findByRole('textbox', { name: /Public link/ });
    const token = backend.trip(3).share.token!;
    expect(publicGet(backend, token).status).toBe(200);

    await user.click(button('Revoke link'));
    await waitFor(() => expect(screen.getByText(/Public link revoked\. Your trip data is unchanged\./)).toBeInTheDocument());
    const gone = publicGet(backend, token);
    expect(gone).toEqual({ status: 404, body: { error: 'Not found' } });
    // A token that never existed, and a malformed one, give the identical answer.
    expect(publicGet(backend, 'f'.repeat(32))).toEqual(gone);
    expect(publicGet(backend, 'not-a-token')).toEqual(gone);
    expect(backend.trip(3).share).toEqual({ enabled: false, token: null });
    expect(backend.trip(3).members).toHaveLength(3);
    expect(backend.trip(3).expenses).toHaveLength(1);
    // The owner still sees the trip and its balances.
    await user.click(tab(/Balances/));
    expect(await screen.findByText('You are owed ₹666.66 (receivable).')).toBeInTheDocument();
  });

  it('does not change the public fields when authenticated writes add personal links, members, and payments', async () => {
    const { backend } = setup({ trips: [GOA] }, { route: '/trips/3' });
    await loaded();
    backend.handle({ method: 'POST', path: '/trips/3/share', body: {} });
    const token = backend.trip(3).share.token!;
    const before = pathsOf(publicGet(backend, token).body).sort();
    backend.handle({ method: 'POST', path: '/trips/3/members', body: { name: 'Kiran', email: 'kiran@example.test' }, headers: { 'idempotency-key': 'allow-0001' } });
    backend.handle({ method: 'PUT', path: link, body: { category: 'Food', spentOn: TODAY }, headers: { 'idempotency-key': 'allow-0002' } });
    backend.handle({
      method: 'POST',
      path: '/trips/3/expenses',
      body: { payer: 'Ravi', description: '↔ Settlement: Ravi → Asha', amount: 333.33, split: [{ name: 'Asha', share: 1 }] },
      headers: { 'idempotency-key': 'allow-0003' },
    });
    const after = publicGet(backend, token);
    expect(pathsOf(after.body).sort()).toEqual(before);
    expect(JSON.stringify(after.body)).not.toMatch(/kiran@example\.test|personal|tripVersion|dataVersion|"id"/);
  });
});

describe('focus and keyboard', () => {
  it('leaves focus where the user moved it while a payment is pending, and on a control, not the page, when its own button goes away', async () => {
    const user = userEvent.setup();
    const { net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    const gate = net.hold('POST', '/trips/3/expenses');
    const ravi = pay('Ravi', 'Asha', '₹333.33');
    ravi.focus();
    await user.keyboard('{Enter}');
    expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('pending');
    // The user moves on to the other payment while the first is pending.
    const meera = pay('Meera', 'Asha', '₹333.33');
    meera.focus();
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(statusOf('trip-settlement:3:102>101')).toHaveTextContent('done'));
    expect(meera).toHaveFocus();

    // The keyboard user who stays on a payment and confirms it: that button leaves the plan, and focus must not fall to the page.
    pay('Meera', 'Asha', '₹333.33').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(statusOf('trip-settlement:3:103>101')).toHaveTextContent('done'));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('#trip-balances')).not.toBeNull();
  });

  it('keeps focus on a control after including and withdrawing a personal share by keyboard', async () => {
    const user = userEvent.setup();
    setup({ trips: [GOA] });
    await loaded();
    const trigger = button('Include in my spending: Beach dinner');
    trigger.focus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
    await user.click(within(panel).getByRole('button', { name: 'Confirm and include' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Include my share of Beach dinner: done'));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('.trip-personal')).not.toBeNull();

    const withdraw = button('Withdraw from my spending: Beach dinner');
    withdraw.focus();
    await user.keyboard('{Enter}');
    await user.click(within(screen.getByRole('group', { name: 'Confirm withdrawing your share of Beach dinner' })).getByRole('button', { name: 'Confirm and withdraw' }));
    await waitFor(() => expect(statusOf('trip-personal-link:11')).toHaveTextContent('Withdraw my share of Beach dinner: done'));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('.trip-personal')).not.toBeNull();
  });

  it('keeps focus on the submit button while an expense is pending and after a rejected draft, and moves it only when the user does', async () => {
    const user = userEvent.setup();
    const { backend, net } = setup({ trips: [GOA] });
    await loaded();
    await fillExpense(user, 'Taxi', '300');
    const gate = net.hold('POST', '/trips/3/expenses');
    backend.failNext('POST', '/trips/3/expenses', 422, 'INCOMPLETE_SPLIT', 'Split required', { field: 'split', constraint: 'at least one trip member with a positive share' });
    const submit = button('Add & split');
    submit.focus();
    await user.keyboard('{Enter}');
    expect(statusOf('new-trip-expense:3')).toHaveTextContent('pending');
    expect(submit).toHaveFocus();
    await act(async () => {
      gate.release();
    });
    // A rejected value is announced beside its field without moving focus.
    await screen.findByText(/Split required\./);
    expect(submit).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'What for?' })).toHaveValue('Taxi');
  });
});

describe('feedback timing on a controlled clock', () => {
  const FRAME_MS = 16;
  const BUDGET_MS = 100;

  /** Turns on the fake clock after the page has loaded, so loading itself is not what is measured. */
  function controlClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Fake milliseconds from now until `ready()` is true, checked after every 16 ms frame. Infinity when it is not true within the budget. */
  async function elapsedUntil(ready: () => boolean, budgetMs = BUDGET_MS): Promise<number> {
    const start = performance.now();
    await advance(0);
    for (;;) {
      if (ready()) return performance.now() - start;
      if (performance.now() - start >= budgetMs) return Number.POSITIVE_INFINITY;
      await advance(FRAME_MS);
    }
  }

  it('shows an expense as pending at submit, holds that for a slow server, then confirms the outcome within 100 ms of the response', async () => {
    const user = userEvent.setup();
    const { net } = setup({ trips: [GOA] }, { home: true });
    await loaded();
    await screen.findByRole('article', { name: /^Nearest trip settlement:/ });
    await fillExpense(user, 'Taxi', '300');
    controlClock();
    const gate = net.hold('POST', '/trips/3/expenses');

    const submit = button('Add & split');
    submit.focus();
    click(submit);
    // Submit to feedback with no clock movement at all.
    expect(text(statusOf('new-trip-expense:3'))).toContain('Add expense: pending');
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(await elapsedUntil(() => text(statusOf('new-trip-expense:3')).includes('pending'))).toBeLessThanOrEqual(BUDGET_MS);
    expect(submit).toHaveFocus();

    // A slow server (30 s) does not time the feedback out or confirm anything early.
    await advance(30_000);
    expect(text(statusOf('new-trip-expense:3'))).toContain('pending');
    expect(screen.queryByRole('list', { name: 'Each member’s share of Taxi' })).toBeNull();
    expect(homeTrip()).toHaveTextContent('₹666.66');

    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf('new-trip-expense:3')).includes('Add expense: done')
      && screen.queryByRole('list', { name: 'Each member’s share of Taxi' }) !== null
      && text(homeTrip()).includes('₹866.66')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a failed payment within 100 ms of the failed response, with the confirmed balances and a retry', async () => {
    const { backend, net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    controlClock();
    backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
    const gate = net.hold('POST', '/trips/3/expenses');
    click(pay('Ravi', 'Asha', '₹333.33'));
    expect(text(statusOf('trip-settlement:3:102>101'))).toContain('Payment from Ravi to Asha: pending');

    await act(async () => {
      gate.release();
    });
    const failed = await elapsedUntil(() => text(statusOf('trip-settlement:3:102>101')).includes('Payment from Ravi to Asha: failed.'));
    expect(failed).toBeLessThanOrEqual(BUDGET_MS);
    expect(within(statusOf('trip-settlement:3:102>101')).getByRole('button', { name: 'Retry Payment from Ravi to Asha' })).toBeInTheDocument();
    expect(memberRow(102)).toHaveTextContent('Owed ₹333.33');
    expect(pay('Meera', 'Asha', '₹333.33')).toBeEnabled();
  });

  it('shows a payment’s new balances within 100 ms of its response', async () => {
    const { net } = setup({ trips: [GOA] }, { route: '/trips/3?tab=balances' });
    await screen.findByRole('article', { name: 'Balances and settlement' });
    controlClock();
    const gate = net.hold('POST', '/trips/3/expenses');
    click(pay('Ravi', 'Asha', '₹333.33'));
    expect(text(statusOf('trip-settlement:3:102>101'))).toContain('pending');
    await act(async () => {
      gate.release();
    });
    const confirmed = await elapsedUntil(() => (
      text(statusOf('trip-settlement:3:102>101')).includes('Payment from Ravi to Asha: done')
      && text(memberRow(102)).includes('Settled')
    ));
    expect(confirmed).toBeLessThanOrEqual(BUDGET_MS);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  async function withTheme(run: () => Promise<void>) {
    document.documentElement.dataset.theme = theme;
    try {
      await run();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  }
  const rules = { rules: { 'heading-order': { enabled: false } } };

  it('has no violations on the expenses tab with an open personal-share confirmation and a failed expense', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { backend, container } = setup({ trips: [GOA] });
      await loaded();
      backend.failNext('POST', '/trips/3/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
      await fillExpense(user, 'Taxi', '300');
      await user.click(button('Add & split'));
      await waitFor(() => expect(statusOf('new-trip-expense:3')).toHaveTextContent('Add expense: failed.'));
      await user.click(button('Include in my spending: Beach dinner'));
      await screen.findByRole('form', { name: 'Confirm including your share of Beach dinner' });
      expect(await axe(container, rules)).toHaveNoViolations();
    });
  });

  it('has no violations on the balances tab with a pending payment, a failed payment, and a recorded one', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { backend, net, container } = setup({ trips: [LADAKH] }, { route: '/trips/4?tab=balances' });
      await screen.findByRole('article', { name: 'Balances and settlement' });
      await user.click(pay('Meera', 'Asha', '₹550'));
      await waitFor(() => expect(statusOf('trip-settlement:4:203>201')).toHaveTextContent('done'));
      backend.failNext('POST', '/trips/4/expenses', 500, 'TRIP_MUTATION_FAILED', 'Trip change could not be saved.');
      await user.click(pay('Kiran', 'Asha', '₹100'));
      await waitFor(() => expect(statusOf('trip-settlement:4:204>201')).toHaveTextContent('failed.'));
      expect(await axe(container, rules)).toHaveNoViolations();
      net.hold('POST', '/trips/4/expenses');
      click(within(statusOf('trip-settlement:4:204>201')).getByRole('button', { name: 'Retry Payment from Kiran to Asha' }));
      expect(statusOf('trip-settlement:4:204>201')).toHaveTextContent('pending');
      expect(await axe(container, rules)).toHaveNoViolations();
    });
  });

  it('has no violations in the share dialog and with a live link', async () => {
    await withTheme(async () => {
      const user = userEvent.setup();
      const { container } = setup({ trips: [GOA] }, { route: '/trips/3?tab=share' });
      await user.click(await screen.findByRole('button', { name: 'Create public link' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Trip name');
      // The dialog is portaled outside the page's landmarks, so the page-level landmark rule does not apply to it.
      expect(await axe(document.body, { rules: { ...rules.rules, region: { enabled: false } } })).toHaveNoViolations();
      await user.click(within(dialog).getByRole('button', { name: 'Create public link' }));
      await screen.findByRole('textbox', { name: /Public link/ });
      expect(await axe(container, rules)).toHaveNoViolations();
    });
  });
});
