import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOURNEY_OUTCOMES } from '../clarity/journeys';
import { MEASUREMENT_OUTCOME_KINDS, measurement } from '../clarity/measurement';
import { notifyFinancialStateCleared } from '../clarity/stateLifecycle';
import { FakeJourneyServer, installJourneyFetch, type DesiredOutcome } from '../test/journeyBackend';
import {
  OPERATION_FAILED,
  confirmedPlanRoutes,
  heading2,
  renderJourney,
  routesFor,
  salaryRoutes,
} from '../test/journeyPage';

/**
 * Task 15.6, Part A. The journey sends `journey_started` once when it starts a
 * journey and `first_outcome_displayed` once when the first result is on screen,
 * only while Product Analytics is on, and never in a way the page waits for.
 */

const EXPECTED_KIND: Record<DesiredOutcome, string> = {
  plan_month: 'monthly_plan',
  control_spending: 'spending',
  fund_goal: 'goal',
  settle_trip: 'trip',
};
const REQUIRED: Record<DesiredOutcome, string[]> = {
  plan_month: ['salary'],
  control_spending: ['salary', 'expense'],
  fund_goal: ['goal'],
  settle_trip: ['trip', 'trip_members', 'trip_split'],
};

let server: FakeJourneyServer;
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  server = new FakeJourneyServer();
});
afterEach(() => {
  measurement.setAnalyticsConsent(false);
});

const named = (events: ReadonlyArray<Record<string, unknown>>, name: string) => events.filter((event) => event.event === name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const savePay = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));
};

describe('first_outcome_displayed', () => {
  it('is sent once with only the closed fields when the first result appears, and not before', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Plan the month' }));
    await heading2('Add your monthly pay');
    await waitFor(() => expect(named(fetches.events, 'journey_started')).toHaveLength(1));
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(0);

    savePay();
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
    const [event] = named(fetches.events, 'first_outcome_displayed');
    expect(Object.keys(event ?? {}).sort()).toEqual(['event', 'journeyId', 'occurredAt', 'outcomeKind']);
    expect(event).toMatchObject({ journeyId: 1, outcomeKind: 'monthly_plan' });
    // The start was reported first, and the result came after the confirmed save.
    const order = fetches.events.map((item) => item.event);
    expect(order[0]).toBe('journey_started');
    expect(order.at(-1)).toBe('first_outcome_displayed');
    expect(order.filter((name) => name !== 'financial_change_ui')).toEqual(['journey_started', 'first_outcome_displayed']);

    // Later optional steps and finishing do not report it again.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop optional steps and finish' }));
    await heading2('Finish your journey');
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1);
  });

  it.each(JOURNEY_OUTCOMES.map((outcome) => outcome.key))('%s: names the outcome kind of that journey', async (outcome) => {
    for (const key of REQUIRED[outcome]) server.satisfied.add(key);
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await userEvent.setup().click(await screen.findByRole('button', { name: JOURNEY_OUTCOMES.find((item) => item.key === outcome)?.title ?? '' }));
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
    const [event] = named(fetches.events, 'first_outcome_displayed');
    expect(event?.outcomeKind).toBe(EXPECTED_KIND[outcome]);
    expect(MEASUREMENT_OUTCOME_KINDS).toContain(event?.outcomeKind);
  });

  it('is sent when existing records already satisfy the journey, after the start event', async () => {
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    renderJourney('/start?start=plan_month');
    await heading2('Your first result is ready');
    await waitFor(() => expect(fetches.events).toHaveLength(2));
    expect(fetches.events.map((event) => event.event)).toEqual(['journey_started', 'first_outcome_displayed']);
  });

  it('is not sent again on re-render, pause and resume, or when the page is opened again', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    measurement.setAnalyticsConsent(true);
    const first = renderJourney();
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));

    const user = userEvent.setup();
    // Interacting with the result re-renders the page.
    await user.click(await screen.findByRole('button', { name: /How this was calculated for Your plan for/ }));
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    await heading2('Your journey is paused');
    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    await heading2('Your first result is ready');
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1);

    // Leaving the route and returning in the same session still reports it once.
    first.unmount();
    renderJourney();
    await heading2('Your first result is ready');
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1);
    expect(named(fetches.events, 'journey_started')).toHaveLength(0);
  });

  it('is not sent while the journey is paused with a result available, or before a step is confirmed', async () => {
    server.open('control_spending', 'paused');
    server.satisfied.add('salary');
    server.satisfied.add('expense');
    const fetches = installJourneyFetch(server, routesFor('control_spending', server));
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Your journey is paused');
    await settle();
    expect(fetches.events).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume journey' }));
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
  });

  it('is not sent for a result that needs more steps, even after a step is saved', async () => {
    server.open('control_spending');
    const fetches = installJourneyFetch(server, routesFor('control_spending', server));
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Add your monthly pay');
    savePay();
    await heading2('Saved: Add your monthly pay');
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(0);
  });

  it('is not sent when the confirmation of the last step fails, and is sent once the retry succeeds', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    server.failNext('PATCH complete_step', OPERATION_FAILED);
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Add your monthly pay');
    savePay();
    const alert = await screen.findByText(/Add your monthly pay: failed\./);
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(0);
    await userEvent.setup().click((alert.closest('[data-scope]') as HTMLElement).querySelector('button') as HTMLElement);
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
  });

  it('is never sent while analytics is off, and the result is shown anyway', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    renderJourney();
    await heading2('Your first result is ready');
    await settle();
    expect(fetches.events).toHaveLength(0);
    expect(screen.getByRole('article', { name: /^Your plan for/ })).toBeInTheDocument();
  });

  it('is reported when analytics is switched on while the result is still displayed, once', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    renderJourney();
    await heading2('Your first result is ready');
    await settle();
    expect(fetches.events).toHaveLength(0);
    act(() => measurement.setAnalyticsConsent(true));
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
    act(() => {
      measurement.setAnalyticsConsent(false);
      measurement.setAnalyticsConsent(true);
    });
    await settle();
    expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1);
  });

  it('is dropped when the rollout flag is off', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Your first result is ready');
    await settle();
    expect(fetches.events).toHaveLength(0);
  });

  it('never blocks or changes the page when sending fails', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    installJourneyFetch(server, confirmedPlanRoutes());
    const route = vi.mocked(globalThis.fetch).getMockImplementation();
    const sent: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/clarity/events')) {
        sent.push(String(init?.body));
        throw new TypeError('Failed to fetch');
      }
      return (route as typeof fetch)(input, init);
    });
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Your first result is ready');
    await waitFor(() => expect(sent).toHaveLength(1));
    await settle();
    expect(screen.queryAllByRole('alert').every((alert) => (alert.textContent ?? '') === '')).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Add monthly bills' })).toBeInTheDocument();
    // A failed send is dropped, not retried.
    expect(sent).toHaveLength(1);
  });

  it('is reported again for the next journey, and again after sign-out clears the session', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    const fetches = installJourneyFetch(server, confirmedPlanRoutes());
    measurement.setAnalyticsConsent(true);
    const view = renderJourney();
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(1));
    view.unmount();
    act(() => notifyFinancialStateCleared());
    renderJourney();
    await heading2('Your first result is ready');
    await waitFor(() => expect(named(fetches.events, 'first_outcome_displayed')).toHaveLength(2));
  });

  it('keeps nothing about it in browser storage', async () => {
    server.open('plan_month');
    server.satisfied.add('salary');
    installJourneyFetch(server, confirmedPlanRoutes());
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await heading2('Your first result is ready');
    await settle();
    const dump = (storage: Storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`).join('\n');
    expect(dump(localStorage)).not.toMatch(/journey|outcome|first/i);
    expect(dump(sessionStorage)).not.toMatch(/journey|outcome|first/i);
  });
});

describe('journey_started', () => {
  it('is sent once per started journey, even on a double click', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    renderJourney();
    await userEvent.setup().dblClick(await screen.findByRole('button', { name: 'Plan the month' }));
    await heading2('Add your monthly pay');
    await settle();
    expect(named(fetches.events, 'journey_started')).toEqual([
      expect.objectContaining({ journeyId: 1, desiredOutcome: 'plan_month' }),
    ]);
    expect(server.startsCreated).toBe(1);
  });

  it('is sent once when a failed start is retried, and not for the failed attempt', async () => {
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    server.failNext('POST /clarity/journeys', OPERATION_FAILED);
    measurement.setAnalyticsConsent(true);
    renderJourney();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Plan the month' }));
    await screen.findByText(/Starting your journey: failed\./);
    await settle();
    expect(fetches.events).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Retry Starting your journey' }));
    await heading2('Add your monthly pay');
    await waitFor(() => expect(named(fetches.events, 'journey_started')).toHaveLength(1));
    await settle();
    expect(named(fetches.events, 'journey_started')).toHaveLength(1);
  });

  it('is not sent for a journey that was already open, or while analytics is off', async () => {
    server.open('plan_month');
    const fetches = installJourneyFetch(server, salaryRoutes(server));
    measurement.setAnalyticsConsent(true);
    renderJourney('/start?start=plan_month');
    await heading2('Add your monthly pay');
    await settle();
    expect(fetches.events).toHaveLength(0);

    const offServer = new FakeJourneyServer();
    const offFetches = installJourneyFetch(offServer, salaryRoutes(offServer));
    measurement.setAnalyticsConsent(false);
    renderJourney('/start?start=plan_month');
    await screen.findAllByRole('heading', { level: 2, name: 'Add your monthly pay' });
    await settle();
    expect(offFetches.events).toHaveLength(0);
  });
});
