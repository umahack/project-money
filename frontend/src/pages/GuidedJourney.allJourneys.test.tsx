import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { JOURNEY_OUTCOMES, outcomeCopy, stepCopy } from '../clarity/journeys';
import { measurement } from '../clarity/measurement';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { buildSettings } from '../test/dataUseFixtures';
import { DEFINITIONS, FakeJourneyServer, installJourneyFetch, type DesiredOutcome } from '../test/journeyBackend';
import {
  MONTH,
  OPERATION_FAILED,
  financialWrites,
  heading2,
  liveStatus,
  renderJourney,
  routesFor,
} from '../test/journeyPage';
import { planSnapshot } from '../test/planFixtures';
import { createTestUser, renderAuthenticated } from '../test/test-utils';

/**
 * Task 15.6. All four guided journeys against empty and partially satisfied
 * records, driven through the real page, hosted forms and measurement client
 * with the fake journey server. The four outcomes come from the registry.
 */

const OUTCOMES = JOURNEY_OUTCOMES.map((outcome) => outcome.key as DesiredOutcome);
/** The first-value bound for each outcome, from the design table "First-session Guided Journey". */
const SPEC_REQUIRED_STEPS: Record<DesiredOutcome, number> = {
  plan_month: 1,
  control_spending: 2,
  fund_goal: 1,
  settle_trip: 3,
};
const MAX_REQUIRED_STEPS = 3;
/** Trip steps are saved on the Trips pages, so the journey itself writes nothing for them. */
const TRIP_STEPS = new Set(['trip', 'trip_members', 'trip_split']);

const required = (outcome: DesiredOutcome) => DEFINITIONS[outcome].required;
const optional = (outcome: DesiredOutcome) => DEFINITIONS[outcome].optional;
const plural = (count: number) => `${count} required step${count === 1 ? '' : 's'}`;

interface Scenario {
  label: string;
  outcome: DesiredOutcome;
  satisfied: string[];
}

/** Empty records, each prefix of the required steps, and everything (required and optional) satisfied. */
const SCENARIOS: Scenario[] = OUTCOMES.flatMap((outcome) => {
  const steps = required(outcome);
  const prefixes = steps.map((_, count) => ({
    label: `${outcome}: ${count === 0 ? 'empty records' : `${count} of ${steps.length} required steps already saved`}`,
    outcome,
    satisfied: steps.slice(0, count),
  }));
  const extras: Scenario[] = [
    { label: `${outcome}: every required and optional step already satisfied`, outcome, satisfied: [...steps, ...optional(outcome)] },
    { label: `${outcome}: required steps satisfied, optional steps missing`, outcome, satisfied: [...steps] },
  ];
  // A later record exists without the earlier one, for example an expense without pay.
  if (outcome === 'control_spending') extras.push({ label: `${outcome}: expense saved, pay missing`, outcome, satisfied: ['expense'] });
  if (outcome === 'settle_trip') extras.push({ label: `${outcome}: trip and people saved, no shared expense`, outcome, satisfied: ['trip', 'trip_members'] });
  return [...prefixes, ...extras];
});

let server: FakeJourneyServer;
beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  server = new FakeJourneyServer();
});
afterEach(() => {
  measurement.setAnalyticsConsent(false);
});

const patches = (calls: ReadonlyArray<{ method: string; body?: Record<string, unknown> }>) => calls.filter((call) => call.method === 'PATCH');
const rowState = (key: string) => document.querySelector(`[data-step="${key}"][data-state]`)?.getAttribute('data-state');
const progressText = () => document.querySelector('.journey-progress-text')?.textContent ?? '';
const slot = (scope: string) => document.querySelector(`[data-scope="${scope}"]`) as HTMLElement | null;

function expectedProgress(outcome: DesiredOutcome): string {
  const steps = required(outcome);
  const remaining = steps.filter((key) => !server.satisfied.has(key));
  return remaining.length === 0
    ? `All ${plural(steps.length)} done.`
    : `Step ${steps.indexOf(remaining[0] as string) + 1} of ${steps.length}; ${plural(remaining.length)} remaining.`;
}

/** Saves what one required step asks for, the way a person would: a form, or the Trips pages and a progress check. */
async function saveStep(key: string) {
  switch (key) {
    case 'salary':
      fireEvent.change(await screen.findByRole('textbox', { name: 'Monthly pay' }), { target: { value: '80000' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save pay for/ }));
      break;
    case 'expense':
      fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '170' } });
      fireEvent.click(screen.getByRole('button', { name: '+ Log expense' }));
      break;
    case 'goal':
      fireEvent.change(await screen.findByRole('textbox', { name: 'Goal name' }), { target: { value: 'Trip fund' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Target amount' }), { target: { value: '50000' } });
      fireEvent.change(screen.getByLabelText('Target date'), { target: { value: `${new Date().getFullYear() + 1}-06-30` } });
      fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
      break;
    default:
      server.satisfied.add(key);
      await userEvent.setup().click(screen.getByRole('button', { name: 'I did this. Check my progress' }));
  }
}

function setRecords(satisfied: Iterable<string>) {
  for (const key of satisfied) server.satisfied.add(key);
}

describe('registry and bounds', () => {
  it('covers exactly the four registry outcomes, each within the first-value bound', () => {
    expect(OUTCOMES).toEqual(['plan_month', 'control_spending', 'fund_goal', 'settle_trip']);
    for (const outcome of OUTCOMES) {
      expect(required(outcome)).toHaveLength(SPEC_REQUIRED_STEPS[outcome]);
      expect(required(outcome).length).toBeLessThanOrEqual(MAX_REQUIRED_STEPS);
      // Every step the server may name has copy, and optional steps are never required ones.
      for (const key of [...required(outcome), ...optional(outcome)]) expect(stepCopy(key).host).not.toBe('none');
      expect(required(outcome).filter((key) => optional(outcome).includes(key))).toEqual([]);
    }
  });
});

describe('empty and partially satisfied records', () => {
  it.each(SCENARIOS)('$label', async ({ outcome, satisfied }) => {
    setRecords(satisfied);
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: outcomeCopy(outcome).title }));

    const steps = required(outcome);
    const remaining = steps.filter((key) => !server.satisfied.has(key));
    if (remaining.length > 0) await heading2(stepCopy(remaining[0] as string).title);
    else await heading2('Your first result is ready');

    // Satisfied required steps are shown as done and never asked again.
    expect(progressText()).toBe(expectedProgress(outcome));
    for (const key of steps) {
      const expected = !remaining.includes(key) ? 'Done' : key === remaining[0] ? 'Current step' : 'To do';
      expect(rowState(key)).toBe(expected);
    }
    expect(remaining.length).toBeLessThanOrEqual(SPEC_REQUIRED_STEPS[outcome]);

    // Ask for each remaining step in order, and only those.
    const asked: string[] = [];
    for (let index = 0; index < remaining.length; index += 1) {
      const key = remaining[index] as string;
      await heading2(stepCopy(key).title);
      asked.push(key);
      // Nothing optional is offered before the first result.
      expect(screen.queryByText('Optional', { selector: '.clarity-badge' })).toBeNull();
      for (const extra of optional(outcome)) expect(screen.queryByRole('heading', { name: stepCopy(extra).title })).toBeNull();
      await saveStep(key);
      const next = remaining[index + 1];
      if (next !== undefined) {
        const saved = await heading2(`Saved: ${stepCopy(key).title}`);
        await waitFor(() => expect(saved).toHaveFocus());
        expect(screen.queryByRole('heading', { name: 'Your first result is ready' })).toBeNull();
        // Exactly one next-step choice.
        expect(screen.getAllByRole('button', { name: /^Next:/ }).map((button) => button.textContent)).toEqual([`Next: ${stepCopy(next).title}`]);
        await user.click(screen.getByRole('button', { name: `Next: ${stepCopy(next).title}` }));
      }
    }
    expect(asked).toEqual(remaining);
    expect(asked.length).toBeLessThanOrEqual(SPEC_REQUIRED_STEPS[outcome]);
    expect(asked.length).toBeLessThanOrEqual(MAX_REQUIRED_STEPS);

    const ready = await heading2('Your first result is ready');
    if (remaining.length > 0) await waitFor(() => expect(ready).toHaveFocus());
    expect(progressText()).toBe(`All ${plural(steps.length)} done.`);
    expect(steps.every((key) => rowState(key) === 'Done')).toBe(true);

    // The server was asked to confirm exactly the steps that were pending, once each.
    expect(patches(fetches.calls).map((call) => call.body?.stepKey)).toEqual(remaining);
    // Saved records: one write per pending step that has a form here, never a repeat of a satisfied one.
    const writes = financialWrites(fetches.calls).map((call) => `${call.method} ${call.path}`);
    expect(writes).toHaveLength(remaining.filter((key) => !TRIP_STEPS.has(key)).length);
    expect(new Set(writes).size).toBe(writes.length);

    // Optional steps come after the first result, one at a time.
    const firstOptional = optional(outcome).find((key) => !server.satisfied.has(key));
    if (firstOptional) {
      const heading = await heading2(stepCopy(firstOptional).title);
      expect(ready.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Skip for now' })).toHaveLength(1);
    } else {
      await heading2('Finish your journey');
    }
  });
});

describe('optional steps and skipping', () => {
  it.each(OUTCOMES)('%s: each optional step is skipped without writing or changing anything', async (outcome) => {
    server.open(outcome);
    setRecords(required(outcome));
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();
    const user = userEvent.setup();
    const result = await screen.findByRole('article');
    const resultBefore = result.textContent;
    const recordsBefore = [...server.satisfied];
    for (const key of optional(outcome)) {
      await heading2(stepCopy(key).title);
      const before = fetches.calls.length;
      await user.click(screen.getByRole('button', { name: 'Skip for now' }));
      await waitFor(() => expect(patches(fetches.calls.slice(before)).map((call) => call.body)).toEqual([{ action: 'skip_step', stepKey: key }]));
      await waitFor(() => expect(liveStatus()).toHaveTextContent(`Skipped: ${stepCopy(key).title}.`));
    }
    await heading2('Finish your journey');
    expect(financialWrites(fetches.calls)).toHaveLength(0);
    expect([...server.satisfied]).toEqual(recordsBefore);
    expect((await screen.findByRole('article')).textContent).toBe(resultBefore);
    expect(screen.getByText(`All ${plural(required(outcome).length)} done.`)).toBeInTheDocument();
  });
});

describe('pause and resume', () => {
  it.each(OUTCOMES)('%s: resume recomputes from the records saved while the journey was paused', async (outcome) => {
    server.open(outcome);
    const steps = required(outcome);
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();
    const user = userEvent.setup();
    await heading2(stepCopy(steps[0] as string).title);
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    await heading2('Your journey is paused');
    expect(screen.getByText(new RegExp(`You will continue at: ${stepCopy(steps[0] as string).title}\\.`))).toBeInTheDocument();

    // The first step is saved elsewhere while paused.
    server.satisfied.add(steps[0] as string);
    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    if (steps.length > 1) {
      await heading2(stepCopy(steps[1] as string).title);
      expect(rowState(steps[0] as string)).toBe('Done');
      expect(rowState(steps[1] as string)).toBe('Current step');
      // The saved step is not asked again.
      expect(screen.queryByRole('heading', { name: stepCopy(steps[0] as string).title })).toBeNull();
    } else {
      await heading2('Your first result is ready');
    }
    expect(progressText()).toBe(expectedProgress(outcome));
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([{ action: 'pause' }, { action: 'resume' }]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  const DELETIONS = OUTCOMES.flatMap((outcome) => required(outcome).map((key) => ({ outcome, key })));
  it.each(DELETIONS)('$outcome: a "$key" record deleted while paused reopens that step', async ({ outcome, key }) => {
    server.open(outcome);
    setRecords(required(outcome));
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney();
    const user = userEvent.setup();
    await heading2('Your first result is ready');
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    await heading2('Your journey is paused');

    server.satisfied.delete(key);
    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    await heading2(stepCopy(key).title);
    expect(screen.queryByRole('heading', { name: 'Your first result is ready' })).toBeNull();
    expect(rowState(key)).toBe('Current step');
    for (const other of required(outcome).filter((item) => item !== key)) expect(rowState(other)).toBe('Done');
    expect(progressText()).toBe(expectedProgress(outcome));
    expect(progressText()).toContain('1 required step remaining.');
    // Optional steps are withdrawn again until the result is back.
    for (const extra of optional(outcome)) expect(screen.queryByRole('heading', { name: stepCopy(extra).title })).toBeNull();
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });
});

describe('failures keep progress and offer a scoped retry', () => {
  it.each(OUTCOMES)('%s: a failed start is reported with the choices and retried with the same request', async (outcome) => {
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    server.failNext('POST /clarity/journeys', OPERATION_FAILED);
    renderJourney();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: outcomeCopy(outcome).title }));
    await waitFor(() => expect(slot('start')).not.toBeNull());
    expect(server.startsCreated).toBe(0);
    expect(screen.getAllByRole('button', { name: /^(Plan the month|Control spending|Fund a goal|Settle a trip)$/ })).toHaveLength(4);
    await user.click(within(slot('start') as HTMLElement).getByRole('button', { name: 'Retry Starting your journey' }));
    await heading2(stepCopy(required(outcome)[0] as string).title);
    const posts = fetches.to('POST', '/clarity/journeys');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(server.startsCreated).toBe(1);
  });

  it.each(OUTCOMES)('%s: a failed step confirmation keeps the saved record and progress, and retries without a second record', async (outcome) => {
    server.open(outcome);
    const steps = required(outcome);
    const first = steps[0] as string;
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    server.failNext('PATCH complete_step', OPERATION_FAILED);
    renderJourney();
    await heading2(stepCopy(first).title);
    await saveStep(first);
    await waitFor(() => expect(slot(`step:${first}`)).toHaveTextContent('Your confirmed records are unchanged.'));
    // The journey did not move, and the saved record is still the only one.
    expect(progressText()).toBe(`Step 1 of ${steps.length}; ${plural(steps.length)} remaining.`);
    expect(rowState(first)).not.toBe('Done');
    await userEvent.setup().click(within(slot(`step:${first}`) as HTMLElement).getByRole('button', { name: `Retry ${stepCopy(first).title}` }));
    await waitFor(() => expect(progressText()).not.toBe(`Step 1 of ${steps.length}; ${plural(steps.length)} remaining.`));
    const sent = patches(fetches.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(financialWrites(fetches.calls)).toHaveLength(TRIP_STEPS.has(first) ? 0 : 1);
    expect(rowState(first)).toBe('Done');
  });

  it.each(OUTCOMES)('%s: a failed skip keeps the first result, and retries the same skip', async (outcome) => {
    server.open(outcome);
    setRecords(required(outcome));
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    server.failNext('PATCH skip_step', OPERATION_FAILED);
    renderJourney();
    const firstOptional = optional(outcome)[0] as string;
    await heading2(stepCopy(firstOptional).title);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(slot(`step:${firstOptional}`)).toHaveTextContent('Your confirmed records are unchanged.'));
    expect(screen.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    expect(screen.getByText(`All ${plural(required(outcome).length)} done.`)).toBeInTheDocument();
    await user.click(within(slot(`step:${firstOptional}`) as HTMLElement).getByRole('button', { name: `Retry ${stepCopy(firstOptional).title}` }));
    await waitFor(() => expect(patches(fetches.calls)).toHaveLength(2));
    expect(patches(fetches.calls)[1]).toEqual(patches(fetches.calls)[0]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it.each(OUTCOMES)('%s: a failed pause and a failed resume are reported for the journey and retried', async (outcome) => {
    server.open(outcome);
    setRecords(required(outcome).slice(0, -1));
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    server.failNext('PATCH pause', OPERATION_FAILED);
    renderJourney();
    const user = userEvent.setup();
    const pending = required(outcome).at(-1) as string;
    await heading2(stepCopy(pending).title);
    const before = progressText();
    await user.click(screen.getByRole('button', { name: 'Pause for now' }));
    await waitFor(() => expect(slot('journey')).toHaveTextContent('Your confirmed records are unchanged.'));
    expect(screen.getByRole('heading', { level: 2, name: stepCopy(pending).title })).toBeInTheDocument();
    expect(progressText()).toBe(before);
    await user.click(within(slot('journey') as HTMLElement).getByRole('button', { name: 'Retry Journey change' }));
    await heading2('Your journey is paused');

    server.failNext('PATCH resume', OPERATION_FAILED);
    await user.click(screen.getByRole('button', { name: 'Resume journey' }));
    await waitFor(() => expect(slot('journey')).toHaveTextContent('Your confirmed records are unchanged.'));
    expect(screen.getByRole('heading', { level: 2, name: 'Your journey is paused' })).toBeInTheDocument();
    await user.click(within(slot('journey') as HTMLElement).getByRole('button', { name: 'Retry Journey change' }));
    await heading2(stepCopy(pending).title);
    expect(patches(fetches.calls).map((call) => call.body?.action)).toEqual(['pause', 'pause', 'resume', 'resume']);
    expect(progressText()).toBe(before);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });

  it.each(OUTCOMES)('%s: a failed finish keeps the journey open and retries the same request', async (outcome) => {
    server.open(outcome);
    setRecords(required(outcome));
    for (const key of optional(outcome)) server.skipped.add(key);
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    server.failNext('PATCH complete', OPERATION_FAILED);
    renderJourney();
    const user = userEvent.setup();
    await heading2('Finish your journey');
    await user.click(screen.getByRole('button', { name: 'Finish journey' }));
    await waitFor(() => expect(slot('complete')).toHaveTextContent('Your confirmed records are unchanged.'));
    expect(server.journey?.status).toBe('active');
    expect(screen.getByRole('heading', { level: 2, name: 'Your first result is ready' })).toBeInTheDocument();
    await user.click(within(slot('complete') as HTMLElement).getByRole('button', { name: 'Retry Finishing your journey' }));
    await heading2('Journey finished');
    expect(patches(fetches.calls).map((call) => call.body)).toEqual([{ action: 'complete' }, { action: 'complete' }]);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
  });
});

describe('registration handoff', () => {
  it.each(OUTCOMES)('a valid intent for %s starts that journey once and leaves the address clean', async (outcome) => {
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney(`/start?start=${outcome}`);
    await heading2(stepCopy(required(outcome)[0] as string).title);
    expect(fetches.to('POST', '/clarity/journeys').map((call) => call.body)).toEqual([{ desiredOutcome: outcome }]);
    expect(server.startsCreated).toBe(1);
    expect(server.journey?.desiredOutcome).toBe(outcome);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/start$/));
  });

  it.each(OUTCOMES)('a valid intent for %s with every required record saved goes straight to the first result', async (outcome) => {
    setRecords(required(outcome));
    const fetches = installJourneyFetch(server, routesFor(outcome, server));
    renderJourney(`/start?start=${outcome}`);
    await heading2('Your first result is ready');
    expect(screen.getAllByText('Optional', { selector: '.clarity-badge' }).length).toBeGreaterThan(0);
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(1);
    expect(financialWrites(fetches.calls)).toHaveLength(0);
    for (const key of required(outcome)) expect(screen.queryByRole('heading', { name: stepCopy(key).title })).toBeNull();
  });

  const INVALID = [
    'start=bogus',
    'start=PLAN_MONTH',
    'start=%20plan_month',
    'start=plan_month%2Cfund_goal',
    'start=plan_month%00',
    'start=__proto__',
    'start=constructor',
    'start=',
    'start=plan_month&start=fund_goal',
    'start[]=plan_month',
  ];
  it.each(INVALID)('an invalid intent (%s) starts nothing and shows the four choices', async (query) => {
    const fetches = installJourneyFetch(server, routesFor('plan_month', server));
    renderJourney(`/start?${query}`);
    const list = await screen.findByRole('list', { name: 'Desired outcomes' });
    expect(within(list).getAllByRole('button')).toHaveLength(4);
    expect(fetches.to('POST', '/clarity/journeys')).toHaveLength(0);
    expect(server.startsCreated).toBe(0);
    await waitFor(() => expect(screen.getByTestId('location').textContent ?? '').not.toContain('start=bogus'));
    expect(screen.getByTestId('location').textContent).toMatch(/^\/start(\?start\[\]=plan_month)?$/);
  });
});

/* ------------------------- Rollout flag off: no journey route ------------------------- */

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

describe('rollout flag off', () => {
  it.each(OUTCOMES)('has no journey route or journey request for %s, signed in', async (outcome) => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', '');
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    const fetches = installJourneyFetch(server, {
      'GET /clarity/settings': buildSettings({ acknowledgedVersion: 1 }),
      'GET /finance/clarity': { schemaVersion: 1, snapshot: planSnapshot(MONTH, { salaryMinor: null }) },
      'GET /finance/salary': { salary: null },
      'GET /finance/emis': { emis: [] },
    });
    renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <App />
        </MutationStatusProvider>
      </FinancialClarityProvider>,
      { route: `/start?start=${outcome}`, user: createTestUser({ id: 77 }) },
    );
    expect(await screen.findByRole('complementary', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Guided journey' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Desired outcomes' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Start or continue a guided journey' })).toBeNull();
    expect(fetches.calls.filter((call) => call.path.startsWith('/clarity/journeys'))).toHaveLength(0);
    expect(server.startsCreated).toBe(0);
  });
});
