import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { measurement } from '../clarity/measurement';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { currentMonth } from '../money';
import { deferred } from '../test/clarity-fixtures';
import { goalEnvelope, goalSnapshot } from '../test/goalFixtures';
import { FakeJourneyServer, installJourneyFetch } from '../test/journeyBackend';
import { mutationEnvelope, planSnapshot } from '../test/planFixtures';
import { expenseEnvelope, spendingSnapshot } from '../test/spendingFixtures';
import { axe, renderAuthenticated } from '../test/test-utils';
import { GuidedJourneyPage } from './GuidedJourneyPage';

const MONTH = currentMonth();
const read = (snapshot: FinancialSnapshot) => ({ schemaVersion: 1, snapshot });
const failure = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const paise = (amount: number) => Math.round(amount * 100);

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderJourney(route = '/start') {
  return renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <Routes>
          <Route path="/start" element={<><Probe /><GuidedJourneyPage /></>} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route },
  );
}

const liveStatus = () => document.querySelector('.journey-status') as HTMLElement;
const location = () => screen.getByTestId('location').textContent;
const stepHeading = (name: string) => screen.findByRole('heading', { level: 2, name });

/** Finance routes a hosted pay form calls. Saving pay makes the server's record satisfy the step. */
function salaryRoutes(server: FakeJourneyServer, options: { pending?: Promise<{ status: number; body: unknown }> } = {}) {
  const confirmed = planSnapshot(MONTH, { dataVersion: 2, salaryMinor: paise(80000) });
  return {
    'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
    'GET /finance/salary': { salary: null },
    'POST /finance/salary': async () => {
      if (options.pending) await options.pending;
      server.satisfied.add('salary');
      return {
        status: 200,
        body: mutationEnvelope(confirmed, {
          scopeKey: `salary:${MONTH}`,
          operation: 'salary.upsert',
          recordType: 'salary',
          recordId: 5,
          changeId: 555,
        }),
      };
    },
  };
}

let server: FakeJourneyServer;

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  server = new FakeJourneyServer();
});

afterEach(() => {
  measurement.setAnalyticsConsent(false);
});

describe('outcome choice', () => {
  it('offers exactly the four fixed outcomes with plain-language descriptions', async () => {
    installJourneyFetch(server);
    renderJourney();

    expect(await screen.findByRole('heading', { level: 1, name: 'Guided journey' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Desired outcomes' });
    const titles = within(list).getAllByRole('button').map((button) => button.getAttribute('data-outcome'));
    expect(titles).toEqual(['plan_month', 'control_spending', 'fund_goal', 'settle_trip']);
    expect(within(list).getByRole('button', { name: 'Plan the month' })).toHaveAccessibleDescription(/monthly pay into a clear plan/);
    expect(within(list).getByRole('button', { name: 'Settle a trip' })).toHaveAccessibleDescription(/No salary is needed/);
    // Reading the page does not start anything.
    expect(server.startsCreated).toBe(0);
  });

  it('starts exactly one journey, sending only the outcome key, even on a double click', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    const button = await screen.findByRole('button', { name: 'Plan the month' });
    await userEvent.setup().dblClick(button);

    await stepHeading('Add your monthly pay');
    const posts = fetches.to('POST', '/clarity/journeys');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ desiredOutcome: 'plan_month' });
    expect(server.startsCreated).toBe(1);
  });

  it('shows the first required step, text progress, and moves focus to the step heading', async () => {
    installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Plan the month' }));
    const heading = await stepHeading('Add your monthly pay');
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Step 1 of 1; 1 required step remaining.')).toBeInTheDocument();
    const current = document.querySelector('[aria-current="step"]') as HTMLElement;
    expect(current).toHaveTextContent('Current step');
    expect(liveStatus()).toHaveTextContent('Started: Plan the month. Step 1 of 1; 1 required step remaining.');
    // The existing pay form is hosted with its purpose text and no duplicate heading level skip.
    expect(await screen.findByRole('textbox', { name: 'Monthly pay' })).toBeInTheDocument();
    expect(document.getElementById('purpose-salary')).toHaveTextContent('Required');
  });
});

describe('resume', () => {
  it('lands on the server\'s next step without asking for completed data again, and does not steal focus', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    installJourneyFetch(server, {
      'GET /finance/clarity': read(spendingSnapshot(MONTH, { expenses: [] })),
      'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Transport'], expenses: [] },
    });
    renderJourney();

    const heading = await stepHeading('Log one expense');
    expect(screen.getByText('Step 2 of 2; 1 required step remaining.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    const salaryRow = document.querySelector('[data-step="salary"]') as HTMLElement;
    expect(salaryRow).toHaveTextContent('Done');
    expect(heading).not.toHaveFocus();
    // Nothing was started or changed just by opening the page.
    expect(server.startsCreated).toBe(0);
  });

  it('shows a paused journey and resumes it on request', async () => {
    server.open('plan_month', 'paused');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    const heading = await screen.findByRole('heading', { level: 2, name: 'Your journey is paused' });
    expect(screen.getByText(/Your saved records are unchanged/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume journey' }));

    await stepHeading('Add your monthly pay');
    expect(fetches.to('PATCH', '/clarity/journeys/1')[0]?.body).toEqual({ action: 'resume' });
    expect(heading).not.toBeInTheDocument();
  });

  it('pauses on request and says so in the live status', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    await stepHeading('Add your monthly pay');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pause for now' }));
    const heading = await screen.findByRole('heading', { level: 2, name: 'Your journey is paused' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(fetches.to('PATCH', '/clarity/journeys/1')[0]?.body).toEqual({ action: 'pause' });
    expect(liveStatus()).toHaveTextContent('Journey paused. Your saved records are unchanged.');
  });

  it('treats a step already satisfied by existing records as done on start', async () => {
    server.satisfied.add('salary');
    installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Plan the month' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    expect(screen.getByText('All 1 required step done.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    // The optional step comes after the first result, and the result page stays one choice away.
    expect(await screen.findByRole('heading', { level: 2, name: 'Add monthly bills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop optional steps and finish' })).toBeInTheDocument();
  });
});

describe('hosted step forms', () => {
  it('advances the pay step only after the server confirms the save, using the confirmed change id', async () => {
    const hold = deferred<{ status: number; body: unknown }>();
    const fetches = installJourneyFetch(server, salaryRoutes(server, { pending: hold.promise }));
    renderJourney();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Plan the month' }));
    await stepHeading('Add your monthly pay');
    const pay = await screen.findByRole('textbox', { name: 'Monthly pay' });
    fireEvent.change(pay, { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));

    await waitFor(() => expect(fetches.to('POST', '/finance/salary')).toHaveLength(1));
    // The save is pending, so the journey has not moved and nothing was sent to it.
    expect(fetches.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeInTheDocument();

    await act(async () => {
      hold.resolve({ status: 200, body: {} });
    });
    const ready = await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' });
    await waitFor(() => expect(ready).toHaveFocus());
    const patches = fetches.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe('/clarity/journeys/1');
    // Only the fixed action, the fixed step key, and the confirmed change id. No amount, no steps.
    expect(patches[0]?.body).toEqual({ action: 'complete_step', stepKey: 'salary', changeId: 555 });
    expect(fetches.to('POST', '/finance/salary')).toHaveLength(1);
    expect(liveStatus()).toHaveTextContent('Step done: Add your monthly pay. All 1 required step done.');
  });

  it('moves from pay to the expense step and keeps focus on the new heading', async () => {
    server.open('control_spending');
    const confirmedPlan = planSnapshot(MONTH, { dataVersion: 2, salaryMinor: paise(80000) });
    const fetches = installJourneyFetch(server, {
      ...salaryRoutes(server),
      'GET /finance/clarity': read(spendingSnapshot(MONTH, { expenses: [] })),
      'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Transport'], expenses: [] },
      'POST /finance/salary': () => {
        server.satisfied.add('salary');
        return {
          status: 200,
          body: mutationEnvelope(confirmedPlan, { scopeKey: `salary:${MONTH}`, operation: 'salary.upsert', recordType: 'salary', recordId: 5, changeId: 601 }),
        };
      },
    });
    renderJourney();

    await stepHeading('Add your monthly pay');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));

    // The confirmed step shows what it unlocked and exactly one next step before moving on.
    const reveal = await stepHeading('Saved: Add your monthly pay');
    await waitFor(() => expect(reveal).toHaveFocus());
    expect(screen.getByText('Step 2 of 2; 1 required step remaining.')).toBeInTheDocument();
    expect(fetches.calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({ action: 'complete_step', stepKey: 'salary', changeId: 601 });
    expect(liveStatus()).toHaveTextContent('Next: Log one expense.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next: Log one expense' }));
    const next = await stepHeading('Log one expense');
    await waitFor(() => expect(next).toHaveFocus());
  });

  it('hosts the expense form and advances with the confirmed expense change id', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    const confirmed = spendingSnapshot(MONTH, { dataVersion: 2, expenses: [{ id: 4, category: 'Food', amount: 170 }] });
    const fetches = installJourneyFetch(server, {
      'GET /finance/clarity': read(spendingSnapshot(MONTH, { expenses: [] })),
      'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Transport'], expenses: [] },
      'POST /finance/expenses': () => {
        server.satisfied.add('expense');
        return {
          status: 200,
          body: expenseEnvelope(confirmed, {
            scopeKey: 'expense:4',
            operation: 'expense.create',
            recordType: 'expense',
            recordId: 4,
            changeId: 702,
            record: { id: 4, month: MONTH, category: 'Food', amountMinor: paise(170), note: null, spentOn: `${MONTH}-10` },
            transition: { type: 'create', originalPeriod: null, resultingPeriod: MONTH, originalCategory: null, resultingCategory: 'Food', affectedPeriods: [MONTH] },
          }),
        };
      },
    });
    renderJourney();

    await stepHeading('Log one expense');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Log expense' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    expect(fetches.to('POST', '/finance/expenses')[0]?.body).toEqual({ amountMinor: paise(170), category: 'Food' });
    expect(fetches.calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({ action: 'complete_step', stepKey: 'expense', changeId: 702 });
  });

  it('hosts the goal form and advances with the confirmed goal change id', async () => {
    server.open('fund_goal');
    const confirmed = goalSnapshot(MONTH, [{ id: 11 }], { dataVersion: 2 });
    const future = `${new Date().getFullYear() + 1}-06-30`;
    const fetches = installJourneyFetch(server, {
      'GET /finance/clarity': read(goalSnapshot(MONTH, [])),
      'GET /finance/goals': { goals: [] },
      'POST /finance/goals': () => {
        server.satisfied.add('goal');
        return {
          status: 200,
          body: goalEnvelope(confirmed, {
            operation: 'goal.create',
            goalId: 11,
            changeId: 803,
            record: { id: 11, name: 'Trip fund', targetAmountMinor: paise(50000), savedAmountMinor: 0, targetDate: future },
          }),
        };
      },
    });
    renderJourney();

    await stepHeading('Add one savings goal');
    expect(screen.getByText('Step 1 of 1; 1 required step remaining.')).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Goal name' }), { target: { value: 'Trip fund' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Target amount' }), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('Target date'), { target: { value: future } });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    expect(fetches.calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({ action: 'complete_step', stepKey: 'goal', changeId: 803 });
  });

  it('shows a field error beside the input and sends nothing to the journey for an invalid value', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    await stepHeading('Add your monthly pay');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Monthly pay' }), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));

    expect(await screen.findByRole('textbox', { name: 'Monthly pay' })).toHaveAttribute('aria-invalid', 'true');
    expect(fetches.to('POST', '/finance/salary')).toHaveLength(0);
    expect(fetches.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeInTheDocument();
  });
});

describe('scoped errors and retry', () => {
  it('reports a failed step save at that step and retries the same request without a second record', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    server.failNext('PATCH complete_step', failure(500, 'JOURNEY_OPERATION_FAILED', 'The journey change could not be saved. Your confirmed records were not changed. Try again.'));
    renderJourney();

    await stepHeading('Add your monthly pay');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));

    const alert = await screen.findByText(/Add your monthly pay: failed\./);
    const slot = alert.closest('[data-scope]') as HTMLElement;
    expect(slot).toHaveAttribute('data-scope', 'step:salary');
    expect(slot).toHaveTextContent('Your confirmed records are unchanged.');
    // The saved pay is still in the form, and the journey did not move.
    expect(screen.getByRole('textbox', { name: 'Monthly pay' })).toHaveValue('80000');
    expect(screen.getByText('Step 1 of 1; 1 required step remaining.')).toBeInTheDocument();

    await userEvent.setup().click(within(slot).getByRole('button', { name: 'Retry Add your monthly pay' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();

    const patches = fetches.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual(patches[0]);
    expect(patches[0]?.body).toEqual({ action: 'complete_step', stepKey: 'salary', changeId: 555 });
    expect(fetches.to('POST', '/finance/salary')).toHaveLength(1);
  });

  it('reports a failed start in the choice list and retries the same start', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    server.failNext('POST /clarity/journeys', failure(500, 'JOURNEY_OPERATION_FAILED', 'The journey change could not be saved. Your confirmed records were not changed. Try again.'));
    renderJourney();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Fund a goal' }));
    const alert = await screen.findByText(/Starting your journey: failed\./);
    expect(alert.closest('[data-scope]')).toHaveAttribute('data-scope', 'start');
    // The four choices stay available.
    expect(screen.getAllByRole('button', { name: /Plan the month|Control spending|Fund a goal|Settle a trip/ })).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Retry Starting your journey' }));
    await stepHeading('Add one savings goal');
    const posts = fetches.to('POST', '/clarity/journeys');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(server.startsCreated).toBe(1);
  });

  it('tells the user to acknowledge the data-use notice when the server asks for it, and retries after', async () => {
    const fetches = installJourneyFetch(server);
    server.failNext('POST /clarity/journeys', failure(428, 'DATA_NOTICE_REQUIRED', 'Acknowledge the notice first.'));
    renderJourney();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Plan the month' }));
    expect(await screen.findByText(/Review and acknowledge the data-use notice on this page, then try again\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry Starting your journey' }));
    await screen.findByRole('heading', { level: 2, name: 'Add your monthly pay' });
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(2);
    expect(server.startsCreated).toBe(1);
  });

  it('keeps the page usable and retries the read when the journey cannot be loaded', async () => {
    let calls = 0;
    const fetches = installJourneyFetch(server);
    const original = server.handle.bind(server);
    vi.spyOn(server, 'handle').mockImplementation((call) => {
      if (call.path === '/clarity/journeys/active' && calls++ < 2) return failure(500, 'SERVER_ERROR', 'The server had a problem.');
      return original(call);
    });
    renderJourney();

    expect(await screen.findByText(/Guided journey could not load\./, undefined, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry loading Guided journey' }));
    expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
    expect(fetches.to('GET', '/clarity/journeys/active').length).toBeGreaterThanOrEqual(2);
  });
});

describe('trip journey', () => {
  it('needs no salary, links to the existing trip pages, and asks the server to confirm progress', async () => {
    server.open('settle_trip');
    const fetches = installJourneyFetch(server);
    renderJourney();

    await stepHeading('Create your trip');
    expect(screen.getByText('Step 1 of 3; 3 required steps remaining.')).toBeInTheDocument();
    expect(screen.queryByText(/pay/i, { selector: 'h2' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Trips to create your trip' })).toHaveAttribute('href', '/trips?action=new-trip');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'I did this. Check my progress' }));
    const alert = await screen.findByText(/Create your trip: failed\./);
    expect(alert.closest('[data-scope]')).toHaveTextContent('This step has no confirmed record yet.');
    // The trip step has no receipt type, so no change id is sent.
    expect(fetches.calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({ action: 'complete_step', stepKey: 'trip' });

    server.satisfied.add('trip');
    await user.click(screen.getByRole('button', { name: 'Retry Create your trip' }));
    const next = await stepHeading('Add the people on the trip');
    await waitFor(() => expect(next).toHaveFocus());
    expect(screen.getByText('Step 2 of 3; 2 required steps remaining.')).toBeInTheDocument();
  });
});

describe('registration handoff', () => {
  it('starts the journey named by a valid intent once and removes it from the address', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney('/start?start=fund_goal');

    await stepHeading('Add one savings goal');
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(1);
    expect(fetches.to('POST', '/clarity/journeys')[0]?.body).toEqual({ desiredOutcome: 'fund_goal' });
    // The router applies the replace on its own schedule, so wait for it rather than assume it is done.
    await waitFor(() => expect(location()).toBe('/start'));
    expect(server.startsCreated).toBe(1);
  });

  it.each(['bogus', 'PLAN_MONTH', '__proto__', 'plan_month&start=fund_goal', ''])(
    'ignores the unknown intent %j and shows the choices',
    async (value) => {
      const fetches = installJourneyFetch(server);
      renderJourney(`/start?start=${value}`);

      expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
      await waitFor(() => expect(location()).toBe('/start'));
      expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
      expect(server.startsCreated).toBe(0);
    },
  );

  it('does not start a different journey while one is open, and says why', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney('/start?start=settle_trip');

    await stepHeading('Add your monthly pay');
    expect(screen.getByRole('note')).toHaveTextContent('Your “Plan the month” journey is still open, so “Settle a trip” was not started.');
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
    await waitFor(() => expect(location()).toBe('/start'));
  });

  it('resumes a paused journey that matches the intent without starting another', async () => {
    server.open('plan_month', 'paused');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney('/start?start=plan_month');

    await stepHeading('Add your monthly pay');
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
    expect(fetches.to('PATCH', '/clarity/journeys/1')[0]?.body).toEqual({ action: 'resume' });
    expect(server.startsCreated).toBe(0);
  });

  it('keeps tokens in session storage and stores nothing about the journey or money in browser storage', async () => {
    installJourneyFetch(server, salaryRoutes(server));
    renderJourney('/start?start=plan_month');
    await stepHeading('Add your monthly pay');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));
    await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' });

    const dump = (storage: Storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`).join('\n');
    expect(dump(localStorage)).not.toMatch(/journey|plan_month|80000|salary/i);
    expect(dump(sessionStorage)).not.toMatch(/journey|plan_month|80000|salary/i);
    expect(sessionStorage.getItem('pm_token')).not.toBeNull();
  });
});

describe('finishing', () => {
  it('finishes the journey on request and keeps every record', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Your first result is ready' });
    await user.click(await screen.findByRole('button', { name: 'Stop optional steps and finish' }));
    await user.click(await screen.findByRole('button', { name: 'Finish journey' }));
    const done = await screen.findByRole('heading', { level: 2, name: 'Journey finished' });
    await waitFor(() => expect(done).toHaveFocus());
    expect(fetches.to('PATCH', '/clarity/journeys/1')[0]?.body).toEqual({ action: 'complete' });
    expect(screen.getByText(/Your records are saved and nothing was removed\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose another goal' }));
    expect(await screen.findByRole('list', { name: 'Desired outcomes' })).toBeInTheDocument();
  });
});

describe('measurement', () => {
  async function startPlanMonth() {
    renderJourney();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Plan the month' }));
    await stepHeading('Add your monthly pay');
  }

  it('reports journey start with only the journey id and outcome key when analytics is on', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    await startPlanMonth();

    await waitFor(() => expect(fetches.events).toHaveLength(1));
    const [event] = fetches.events;
    expect(Object.keys(event ?? {}).sort()).toEqual(['desiredOutcome', 'event', 'journeyId', 'occurredAt']);
    expect(event).toMatchObject({ event: 'journey_started', journeyId: 1, desiredOutcome: 'plan_month' });
  });

  it('sends no event when analytics is off, and the journey still works', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    await startPlanMonth();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.events).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Add your monthly pay' })).toBeInTheDocument();
  });

  it('does not report a start for a journey that was already open', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    renderJourney('/start?start=plan_month');
    await stepHeading('Add your monthly pay');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.events).toHaveLength(0);
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'])('has no axe violations on the choice screen and a step in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      installJourneyFetch(server, salaryRoutes(server));
      const { container } = renderJourney();
      await screen.findByRole('list', { name: 'Desired outcomes' });
      expect(await axe(container)).toHaveNoViolations();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Plan the month' }));
      await stepHeading('Add your monthly pay');
      await screen.findByRole('textbox', { name: 'Monthly pay' });
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it('is operable by keyboard: a choice starts with Enter and the step heading takes focus', async () => {
    installJourneyFetch(server, salaryRoutes(server));
    renderJourney();
    const button = await screen.findByRole('button', { name: 'Control spending' });
    const user = userEvent.setup();
    await user.tab();
    button.focus();
    await user.keyboard('{Enter}');
    const heading = await stepHeading('Add your monthly pay');
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Step 1 of 2; 2 required steps remaining.')).toBeInTheDocument();
  });

  it('adds no animation of its own', async () => {
    installJourneyFetch(server);
    const { container } = renderJourney();
    await screen.findByRole('list', { name: 'Desired outcomes' });
    expect(container.querySelector('[style*="transition"], [style*="animation"]')).toBeNull();
  });
});
