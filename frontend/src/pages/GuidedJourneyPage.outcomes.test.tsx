import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measurement } from '../clarity/measurement';
import { FakeJourneyServer, installJourneyFetch, type DesiredOutcome } from '../test/journeyBackend';
import {
  MONTH,
  OPERATION_FAILED,
  confirmedPlanRoutes,
  expenseRoutes,
  financialWrites,
  goalRoutes,
  heading2,
  liveStatus,
  paise,
  renderJourney,
  routesFor,
  salaryRoutes,
  tripRoutes,
} from '../test/journeyPage';
import { mutationEnvelope, planSnapshot } from '../test/planFixtures';
import { axe } from '../test/test-utils';

let server: FakeJourneyServer;

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  server = new FakeJourneyServer();
});

afterEach(() => {
  measurement.setAnalyticsConsent(false);
});

const patches = (calls: ReadonlyArray<{ method: string; body?: Record<string, unknown> }>) => calls.filter((call) => call.method === 'PATCH');
/** The first result also reports its own event, so the question's events are picked out by name. */
const answers = (events: ReadonlyArray<Record<string, unknown>>) => events.filter((event) => event.event === 'clarity_response');
const savePay = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));
};

describe('step outcome reveal', () => {
  it('plan the month: shows the confirmed plan as the first result, with labels, period and explanation', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    renderJourney();

    await heading2('Add your monthly pay');
    savePay();

    const ready = await heading2('Your first result is ready');
    await waitFor(() => expect(ready).toHaveFocus());
    expect(liveStatus()).toHaveTextContent('Step done: Add your monthly pay. All 1 required step done. Your first result is ready.');
    const card = await screen.findByRole('article', { name: /^Your plan for/ });
    // Values are the server's confirmed ones, labelled as entered or calculated, with the month named.
    expect(card).toHaveTextContent('80,000');
    expect(within(card).getAllByText('Entered fact').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('Calculated result').length).toBeGreaterThan(0);
    expect(within(card).getByText(/^Period:/)).toBeInTheDocument();
    const toggle = within(card).getByRole('button', { name: /How this was calculated for Your plan for/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Only the pay save and the journey step were sent. Nothing was recalculated or written by the client.
    expect(financialWrites(fetches.calls).map((call) => call.path)).toEqual(['/finance/salary']);
    expect(patches(fetches.calls)).toHaveLength(1);
  });

  it('control spending: shows the plan after pay with exactly one next step, then the spending result after the expense', async () => {
    server.open('control_spending');
    const fetches = installJourneyFetch(server, { ...salaryRoutes(server, 601), ...expenseRoutes(server) });
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add your monthly pay');
    savePay();
    const saved = await heading2('Saved: Add your monthly pay');
    await waitFor(() => expect(saved).toHaveFocus());
    expect(screen.getByText(/This unlocked: Your monthly plan/)).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: /^Your plan for/ })).toBeInTheDocument();
    // Exactly one next-step choice, and the form for the next step is not shown yet.
    expect(screen.getAllByRole('button', { name: /^Next:/ })).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your first result is ready' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next: Log one expense' }));
    const step = await heading2('Log one expense');
    await waitFor(() => expect(step).toHaveFocus());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Log expense' }));

    const ready = await heading2('Your first result is ready');
    await waitFor(() => expect(ready).toHaveFocus());
    const card = await screen.findByRole('article', { name: /^Spending for/ });
    expect(within(card).getByText('Remaining spendable')).toBeInTheDocument();
    expect(within(card).getByText('Daily spending guide')).toBeInTheDocument();
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([
      { action: 'complete_step', stepKey: 'salary', changeId: 601 },
      { action: 'complete_step', stepKey: 'expense', changeId: 702 },
    ]);
  });

  it('fund a goal: shows the goal result with its name, funding gap and required contribution', async () => {
    server.open('fund_goal');
    const fetches = installJourneyFetch(server, goalRoutes(server));
    renderJourney();

    await heading2('Add one savings goal');
    const future = `${new Date().getFullYear() + 1}-06-30`;
    fireEvent.change(await screen.findByRole('textbox', { name: 'Goal name' }), { target: { value: 'Trip fund' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Target amount' }), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('Target date'), { target: { value: future } });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));

    const ready = await heading2('Your first result is ready');
    await waitFor(() => expect(ready).toHaveFocus());
    const card = await screen.findByRole('article', { name: 'Trip fund' });
    expect(within(card).getByText('Funding gap')).toBeInTheDocument();
    expect(within(card).getByText('Required monthly contribution')).toBeInTheDocument();
    expect(within(card).getAllByText('Calculated result').length).toBeGreaterThan(0);
    expect(patches(fetches.calls)[0]?.body).toEqual({ action: 'complete_step', stepKey: 'goal', changeId: 803 });
  });

  it('settle a trip: reveals each step without salary, then the balance after the shared expense', async () => {
    server.open('settle_trip');
    const fetches = installJourneyFetch(server, tripRoutes(server));
    renderJourney();
    const user = userEvent.setup();

    await heading2('Create your trip');
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    server.satisfied.add('trip');
    await user.click(screen.getByRole('button', { name: 'I did this. Check my progress' }));
    await heading2('Saved: Create your trip');
    // This step has no outcome of its own, so the reveal says what it unlocked.
    expect(screen.getByText(/Your trip is created\. Add the people and one shared expense/)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next: Add the people on the trip' }));

    await heading2('Add the people on the trip');
    server.satisfied.add('trip_members');
    await user.click(screen.getByRole('button', { name: 'I did this. Check my progress' }));
    await heading2('Saved: Add the people on the trip');
    await user.click(screen.getByRole('button', { name: 'Next: Add one shared expense' }));

    await heading2('Add one shared expense');
    server.satisfied.add('trip_split');
    await user.click(screen.getByRole('button', { name: 'I did this. Check my progress' }));
    const ready = await heading2('Your first result is ready');
    await waitFor(() => expect(ready).toHaveFocus());
    const card = await screen.findByRole('article', { name: 'Your trip balance' });
    expect(within(card).getByText('Payments that settle the trip')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See who pays whom' })).toHaveAttribute('href', '/trips/3?tab=balances');
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([
      { action: 'complete_step', stepKey: 'trip' },
      { action: 'complete_step', stepKey: 'trip_members' },
      { action: 'complete_step', stepKey: 'trip_split' },
    ]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });
});

describe('optional steps', () => {
  it('are not offered before the first result, and nothing is skipped on the way', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, expenseRoutes(server));
    renderJourney();

    await heading2('Log one expense');
    expect(screen.queryByRole('heading', { name: 'Add monthly bills' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    expect(screen.queryByText('Optional', { selector: '.clarity-badge' })).toBeNull();
    expect(patches(fetches.calls)).toHaveLength(0);
  });

  it('appear after the first result, one at a time, with purpose, benefit preview and a skip', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    server.satisfied.add('expense');
    installJourneyFetch(server, { ...salaryRoutes(server), ...expenseRoutes(server) });
    renderJourney();

    // The first result is shown before the optional step.
    const ready = await heading2('Your first result is ready');
    const optional = await heading2('Add monthly bills');
    expect(ready.compareDocumentPosition(optional) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const purpose = document.getElementById('purpose-bill') as HTMLElement;
    expect(purpose).toHaveAttribute('data-requirement', 'optional');
    expect(within(purpose).getByText('Optional')).toBeInTheDocument();
    expect(document.getElementById('benefit-bill')).toBeInTheDocument();
    // Exactly one optional prompt, even though the journey has two.
    expect(screen.queryByRole('heading', { name: 'Choose Needs or Wants for a category' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Skip for now' })).toHaveLength(1);
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });

  const CASES: Array<{
    outcome: DesiredOutcome;
    satisfied: string[];
    skipped: string[];
    step: string;
    title: string;
    affected: string;
  }> = [
    { outcome: 'plan_month', satisfied: ['salary'], skipped: [], step: 'bills', title: 'Add monthly bills', affected: 'Disposable income' },
    { outcome: 'control_spending', satisfied: ['salary', 'expense'], skipped: ['bills'], step: 'category_treatment', title: 'Choose Needs or Wants for a category', affected: 'Daily spending guide' },
    { outcome: 'fund_goal', satisfied: ['goal'], skipped: [], step: 'monthly_plan', title: 'Add pay to check goal feasibility', affected: 'Goal feasibility' },
    { outcome: 'settle_trip', satisfied: ['trip', 'trip_members', 'trip_split'], skipped: [], step: 'personal_expense', title: 'Include your share in monthly spending', affected: 'Remaining spendable budget' },
  ];

  it.each(CASES)('$outcome: skipping "$title" names the unchanged outcome and writes nothing', async ({ outcome, satisfied, skipped, step, title, affected }) => {
    server.open(outcome);
    for (const key of satisfied) server.satisfied.add(key);
    for (const key of skipped) server.skipped.add(key);
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();

    await heading2(title);
    expect(screen.getByText(new RegExp(`If you skip: Nothing is saved or changed\\. ${affected} stays as it is`))).toBeInTheDocument();
    const firstResult = await screen.findByRole('article');
    const resultBefore = firstResult.textContent;
    const recordsBefore = [...server.satisfied];
    const callsBefore = fetches.calls.length;

    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip for now' }));

    const finish = await heading2('Finish your journey');
    await waitFor(() => expect(finish).toHaveFocus());
    const sent = fetches.calls.slice(callsBefore);
    expect(patches(sent).map((call) => call.body)).toEqual([{ action: 'skip_step', stepKey: step }]);
    // A skip is a financial no-op: no record is written and the confirmed records and result are the same.
    expect(financialWrites(fetches.calls)).toHaveLength(0);
    expect([...server.satisfied]).toEqual(recordsBefore);
    expect((await screen.findByRole('article')).textContent).toBe(resultBefore);
    expect(liveStatus()).toHaveTextContent(new RegExp(`Skipped: ${title}\\. Nothing is saved or changed\\. ${affected} stays as it is`));
    // The required steps stay done.
    expect(screen.getByText(/All \d required steps? done\./)).toBeInTheDocument();
  });

  it('can be skipped one after another without affecting the next step', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    server.satisfied.add('expense');
    const fetches = installJourneyFetch(server, { ...salaryRoutes(server), ...expenseRoutes(server) });
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add monthly bills');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    const next = await heading2('Choose Needs or Wants for a category');
    await waitFor(() => expect(next).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await heading2('Finish your journey');

    expect(patches(fetches.calls).map((call) => call.body)).toEqual([
      { action: 'skip_step', stepKey: 'bills' },
      { action: 'skip_step', stepKey: 'category_treatment' },
    ]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it('saves from the hosted form with the confirmed change id and shows the updated result', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const afterAdd = planSnapshot(MONTH, {
      dataVersion: 5,
      salaryMinor: paise(80000),
      bills: [{ id: 7, label: 'Gym', amountMinor: paise(1500) }],
    });
    const fetches = installJourneyFetch(server, {
      ...confirmedPlanRoutes(),
      'POST /finance/emis': () => {
        server.satisfied.add('bills');
        return {
          status: 200,
          body: mutationEnvelope(afterAdd, {
            scopeKey: 'bill:7',
            operation: 'bill.create',
            recordType: 'bill',
            recordId: 7,
            changeId: 910,
            record: { id: 7, label: 'Gym', amountMinor: paise(1500), category: 'Other', active: true, effectiveFromMonth: null, effectiveToMonth: null },
          }),
        };
      },
    });
    renderJourney();

    await heading2('Add monthly bills');
    fireEvent.change(screen.getByLabelText(/What is it/), { target: { value: 'Gym' } });
    fireEvent.change(screen.getByLabelText(/₹ per month/), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add bill' }));

    await heading2('Finish your journey');
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([{ action: 'complete_step', stepKey: 'bills', changeId: 910 }]);
    expect(liveStatus()).toHaveTextContent('Step done: Add monthly bills. All 1 required step done. Your result was updated.');
    expect(await screen.findByRole('article', { name: /^Your plan for/ })).toBeInTheDocument();
  });

  it('presents the pay form as optional in the goal journey', async () => {
    server.open('fund_goal');
    server.satisfied.add('goal');
    installJourneyFetch(server, goalRoutes(server));
    renderJourney();

    await heading2('Add pay to check goal feasibility');
    const purpose = document.getElementById('purpose-salary') as HTMLElement;
    expect(purpose).toHaveAttribute('data-requirement', 'optional');
    expect(within(purpose).getByText('Optional')).toBeInTheDocument();
    expect(within(purpose).queryByText('Required')).toBeNull();
    expect(await screen.findByRole('textbox', { name: 'Monthly pay' })).toBeInTheDocument();
  });
});

describe('finishing, the clarity question, and the summary', () => {
  function atFinish(routes: Parameters<typeof installJourneyFetch>[1] = confirmedPlanRoutes()) {
    server.open('plan_month');
    server.satisfied.add('salary');
    server.skipped.add('bills');
    return installJourneyFetch(server, routes);
  }

  it('offers exactly Yes, Partly and No plus a skip, and keeps finishing enabled', async () => {
    atFinish();
    renderJourney();

    await heading2('Finish your journey');
    const group = screen.getByRole('group', { name: /Did this make your financial position clearer\?/ });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Yes', 'Partly', 'No', 'Skip question']);
    const finish = screen.getByRole('button', { name: 'Finish journey' });
    expect(finish).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('link', { name: 'Open your plan' })).toHaveAttribute('href', '/plan');
  });

  it('sends one clarity_response with only the fixed fields when analytics is on', async () => {
    const fetches = atFinish();
    measurement.setAnalyticsConsent(true);
    renderJourney();
    const user = userEvent.setup();

    await heading2('Finish your journey');
    await user.click(screen.getByRole('button', { name: 'Partly' }));

    await waitFor(() => expect(answers(fetches.events)).toHaveLength(1));
    const [event] = answers(fetches.events);
    expect(Object.keys(event ?? {}).sort()).toEqual(['event', 'journeyId', 'occurredAt', 'response']);
    expect(event).toMatchObject({ event: 'clarity_response', journeyId: 1, response: 'partly' });
    expect(screen.getByText('Thanks. You answered: Partly.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(liveStatus()).toHaveTextContent('Thanks for your answer.');
    // The question never blocks the next action, and the answer is kept nowhere else.
    expect(screen.getByRole('button', { name: 'Finish journey' })).not.toHaveAttribute('aria-disabled');
    const dump = (storage: Storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`).join('\n');
    expect(dump(localStorage)).not.toMatch(/partly|clarity/i);
    expect(dump(sessionStorage)).not.toMatch(/partly|clarity_response/i);
    // Journey requests carry no answer.
    expect(fetches.calls.filter((call) => JSON.stringify(call.body ?? {}).includes('partly'))).toHaveLength(0);
  });

  it('sends nothing, and shows no error, when analytics is off', async () => {
    const fetches = atFinish();
    renderJourney();

    await heading2('Finish your journey');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Yes' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetches.events).toHaveLength(0);
    expect(screen.getByText('Thanks. You answered: Yes.')).toBeInTheDocument();
    expect(screen.queryAllByRole('alert').every((alert) => (alert.textContent ?? '') === '')).toBe(true);
  });

  it('sends nothing when the question is skipped, even with analytics on', async () => {
    const fetches = atFinish();
    measurement.setAnalyticsConsent(true);
    renderJourney();

    await heading2('Finish your journey');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip question' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(answers(fetches.events)).toHaveLength(0);
    expect(document.querySelector('.journey-question-result')).toHaveTextContent('Question skipped. Nothing was sent.');
    expect(liveStatus()).toHaveTextContent('Question skipped. Nothing was sent.');
  });

  it('completes without an answer and shows a summary that links to the fixed result and Home routes', async () => {
    const fetches = atFinish();
    measurement.setAnalyticsConsent(true);
    renderJourney();

    await heading2('Finish your journey');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finish journey' }));

    const done = await heading2('Journey finished');
    await waitFor(() => expect(done).toHaveFocus());
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([{ action: 'complete' }]);
    expect(answers(fetches.events)).toHaveLength(0);
    expect(liveStatus()).toHaveTextContent('Journey finished. Your summary is ready.');
    const list = screen.getByRole('list', { name: 'What happened to each step' });
    expect(within(list).getByText('Add your monthly pay').closest('li')).toHaveTextContent('Required. Done');
    expect(within(list).getByText('Add monthly bills').closest('li')).toHaveTextContent('Optional. Skipped. Nothing is saved or changed. Disposable income stays as it is');
    expect(screen.getByRole('link', { name: 'Open your plan' })).toHaveAttribute('href', '/plan');
    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/');
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it.each([
    ['control_spending', 'Open spending', '/spending'],
    ['fund_goal', 'Open goals', '/goals'],
    ['settle_trip', 'Open trips', '/trips'],
  ] as const)('links the %s summary to %s', async (outcome, label, href) => {
    server.open(outcome);
    for (const key of { control_spending: ['salary', 'expense'], fund_goal: ['goal'], settle_trip: ['trip', 'trip_members', 'trip_split'] }[outcome]) server.satisfied.add(key);
    for (const key of { control_spending: ['bills', 'category_treatment'], fund_goal: ['monthly_plan'], settle_trip: ['personal_expense'] }[outcome]) server.skipped.add(key);
    installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();

    await heading2('Finish your journey');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finish journey' }));
    await heading2('Journey finished');
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
  });

  it('lets the user stop optional steps and finish, leaving them as not added', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    server.satisfied.add('expense');
    installJourneyFetch(server, { ...salaryRoutes(server), ...expenseRoutes(server) });
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add monthly bills');
    await user.click(screen.getByRole('button', { name: 'Stop optional steps and finish' }));
    const finish = await heading2('Finish your journey');
    await waitFor(() => expect(finish).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Finish journey' }));
    await heading2('Journey finished');
    expect(screen.getByText('Add monthly bills').closest('li')).toHaveTextContent('Optional. Not added');
  });
});

describe('failures and retry', () => {
  it('shows a failed skip at the optional step, keeps progress, and retries the same request', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    server.failNext('PATCH skip_step', OPERATION_FAILED);
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add monthly bills');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    const alert = await screen.findByText(/Add monthly bills: failed\./);
    const slot = alert.closest('[data-scope]') as HTMLElement;
    expect(slot).toHaveAttribute('data-scope', 'step:bills');
    expect(slot).toHaveTextContent('Your confirmed records are unchanged.');
    expect(screen.getByText('All 1 required step done.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();

    await user.click(within(slot).getByRole('button', { name: 'Retry Add monthly bills' }));
    await heading2('Finish your journey');
    const sent = patches(fetches.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toEqual({ action: 'skip_step', stepKey: 'bills' });
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it('shows a failed finish beside the finish action, keeps the journey open, and retries the same request', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    server.skipped.add('bills');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    server.failNext('PATCH complete', OPERATION_FAILED);
    renderJourney();
    const user = userEvent.setup();

    await heading2('Finish your journey');
    await user.click(screen.getByRole('button', { name: 'Finish journey' }));

    const alert = await screen.findByText(/Finishing your journey: failed\./);
    const slot = alert.closest('[data-scope]') as HTMLElement;
    expect(slot).toHaveAttribute('data-scope', 'complete');
    expect(server.journey?.status).toBe('active');
    expect(screen.getByText('All 1 required step done.')).toBeInTheDocument();
    // The failure is not repeated in the journey controls.
    expect(document.querySelectorAll('[data-scope="complete"]')).toHaveLength(1);

    await user.click(within(slot).getByRole('button', { name: 'Retry Finishing your journey' }));
    await heading2('Journey finished');
    const sent = patches(fetches.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toEqual({ action: 'complete' });
  });

  it('keeps the first result and progress when saving an optional step fails', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, {
      ...confirmedPlanRoutes(),
      'POST /finance/emis': failure500(),
    });
    renderJourney();

    await heading2('Add monthly bills');
    fireEvent.change(screen.getByLabelText(/What is it/), { target: { value: 'Gym' } });
    fireEvent.change(screen.getByLabelText(/₹ per month/), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add bill' }));

    await waitFor(() => expect(fetches.to('POST', '/finance/emis')).toHaveLength(1));
    // The save failed, so the journey was not asked to complete the step and the result is still shown.
    await waitFor(() => expect(screen.getByText(/Add bill: failed/)).toBeInTheDocument());
    expect(patches(fetches.calls)).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Add monthly bills' })).toBeInTheDocument();
  });
});

function failure500() {
  return { status: 500, body: { error: { code: 'SERVER_ERROR', message: 'The server had a problem.' } } };
}

describe('resume and pause', () => {
  it('opens at the first result with the next optional step and does not steal focus', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    server.satisfied.add('expense');
    server.skipped.add('bills');
    installJourneyFetch(server, { ...salaryRoutes(server), ...expenseRoutes(server) });
    renderJourney();

    const optional = await heading2('Choose Needs or Wants for a category');
    const ready = await heading2('Your first result is ready');
    expect(ready).not.toHaveFocus();
    expect(optional).not.toHaveFocus();
    expect(screen.queryByRole('heading', { name: 'Add monthly bills' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull();
  });

  it('pauses during an optional step and resumes at the first result without asking again for saved data', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add monthly bills');
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    const paused = await heading2('Your journey is paused');
    await waitFor(() => expect(paused).toHaveFocus());
    expect(screen.getByText(/You will continue at: Add monthly bills\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    const ready = await heading2('Your first result is ready');
    await waitFor(() => expect(ready).toHaveFocus());
    await heading2('Add monthly bills');
    expect(screen.queryByRole('textbox', { name: 'Monthly pay' })).toBeNull();
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([{ action: 'pause' }, { action: 'resume' }]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it('leaves the step reveal behind when the journey is paused, and resumes at the next step', async () => {
    server.open('control_spending');
    installJourneyFetch(server, { ...salaryRoutes(server, 601), ...expenseRoutes(server) });
    renderJourney();
    const user = userEvent.setup();

    await heading2('Add your monthly pay');
    savePay();
    await heading2('Saved: Add your monthly pay');
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    await heading2('Your journey is paused');
    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    await heading2('Log one expense');
    expect(screen.queryByRole('heading', { name: 'Saved: Add your monthly pay' })).toBeNull();
  });

  it('keeps progress when the server cannot confirm a step right now', async () => {
    server.open('control_spending');
    server.satisfied.add('salary');
    installJourneyFetch(server, expenseRoutes(server));
    server.failNext('PATCH complete_step', OPERATION_FAILED);
    renderJourney();

    await heading2('Log one expense');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Log expense' }));
    await screen.findByText(/Log one expense: failed\./);
    // Progress is derived from the confirmed records and never goes back.
    expect(screen.getByText(/Step 2 of 2; 1 required step remaining\./)).toBeInTheDocument();
    expect(document.querySelector('[data-step="salary"]')).toHaveTextContent('Done');
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'])('has no axe violations on the first result with an optional step, the reveal, and the finish panel in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      server.open('control_spending');
      installJourneyFetch(server, { ...salaryRoutes(server, 601), ...expenseRoutes(server) });
      const { container } = renderJourney();
      const user = userEvent.setup();

      await heading2('Add your monthly pay');
      savePay();
      await heading2('Saved: Add your monthly pay');
      await screen.findByRole('article', { name: /^Your plan for/ });
      expect(await axe(container)).toHaveNoViolations();

      await user.click(screen.getByRole('button', { name: 'Next: Log one expense' }));
      await heading2('Log one expense');
      fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
      fireEvent.click(screen.getByRole('button', { name: '+ Log expense' }));
      await heading2('Add monthly bills');
      await screen.findByRole('article', { name: /^Spending for/ });
      expect(await axe(container)).toHaveNoViolations();

      await user.click(screen.getByRole('button', { name: 'Stop optional steps and finish' }));
      await heading2('Finish your journey');
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it('adds no animation of its own on the reveal or finish panel', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    server.skipped.add('bills');
    installJourneyFetch(server, confirmedPlanRoutes());
    const { container } = renderJourney();
    await heading2('Finish your journey');
    expect(container.querySelector('[style*="transition"], [style*="animation"]')).toBeNull();
  });
});

