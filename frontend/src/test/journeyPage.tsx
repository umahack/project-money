import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import type { FinancialSnapshot } from '../clarity/contracts';
import { FinancialClarityProvider } from '../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../clarity/MutationStatusProvider';
import { GuidedJourneyPage } from '../pages/GuidedJourneyPage';
import { currentMonth } from '../money';
import { goalEnvelope, goalRow, goalSnapshot } from './goalFixtures';
import type { DesiredOutcome, FakeJourneyServer } from './journeyBackend';
import { mutationEnvelope, planSnapshot } from './planFixtures';
import { expenseEnvelope, spendingSnapshot } from './spendingFixtures';
import { renderAuthenticated } from './test-utils';
import { TRIP_ID, tripSnapshot } from './tripFixtures';

/** Shared setup for the guided journey page tests. Task 15.6 builds on the same helpers. */

export const MONTH = currentMonth();
export const read = (snapshot: FinancialSnapshot) => ({ schemaVersion: 1, snapshot });
export const failure = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
export const OPERATION_FAILED = failure(
  500,
  'JOURNEY_OPERATION_FAILED',
  'The journey change could not be saved. Your confirmed records were not changed. Try again.',
);
export const paise = (amount: number) => Math.round(amount * 100);

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

export function renderJourney(route = '/start') {
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

export const liveStatus = () => document.querySelector('.journey-status') as HTMLElement;
export const heading2 = (name: string) => screen.findByRole('heading', { level: 2, name });

/** Finance routes for each journey. Saving a record makes the server's confirmed records satisfy the step. */
export function salaryRoutes(server: FakeJourneyServer, changeId = 555) {
  const confirmed = planSnapshot(MONTH, { dataVersion: 2, salaryMinor: paise(80000) });
  return {
    'GET /finance/clarity': read(planSnapshot(MONTH, { salaryMinor: null })),
    'GET /finance/salary': { salary: null },
    'GET /finance/emis': { emis: [] },
    'POST /finance/salary': () => {
      server.satisfied.add('salary');
      return {
        status: 200,
        body: mutationEnvelope(confirmed, {
          scopeKey: `salary:${MONTH}`,
          operation: 'salary.upsert',
          recordType: 'salary',
          recordId: 5,
          changeId,
        }),
      };
    },
  };
}

/** A confirmed plan with pay already saved, as a returning user's snapshot looks. */
export function confirmedPlanRoutes() {
  return {
    'GET /finance/clarity': read(planSnapshot(MONTH, { dataVersion: 3, salaryMinor: paise(80000) })),
    'GET /finance/salary': { salary: { month: MONTH, amount: 80000 } },
    'GET /finance/emis': { emis: [] },
  };
}

export function expenseRoutes(server: FakeJourneyServer, changeId = 702) {
  const confirmed = spendingSnapshot(MONTH, { dataVersion: 4, expenses: [{ id: 4, category: 'Food', amount: 170 }] });
  return {
    'GET /finance/clarity': read(spendingSnapshot(MONTH, { expenses: [] })),
    'GET /finance/expenses': { month: MONTH, categories: ['Food', 'Transport'], expenses: [] },
    'GET /finance/budgets': { budgets: {} },
    'GET /finance/emis': { emis: [] },
    'POST /finance/expenses': () => {
      server.satisfied.add('expense');
      return {
        status: 200,
        body: expenseEnvelope(confirmed, {
          scopeKey: 'expense:4',
          operation: 'expense.create',
          recordType: 'expense',
          recordId: 4,
          changeId,
          record: { id: 4, month: MONTH, category: 'Food', amountMinor: paise(170), note: null, spentOn: `${MONTH}-10` },
          transition: { type: 'create', originalPeriod: null, resultingPeriod: MONTH, originalCategory: null, resultingCategory: 'Food', affectedPeriods: [MONTH] },
        }),
      };
    },
  };
}

export function goalRoutes(server: FakeJourneyServer, changeId = 803) {
  const future = `${new Date().getFullYear() + 1}-06-30`;
  let created = false;
  return {
    'GET /finance/clarity': read(goalSnapshot(MONTH, [{ id: server.goalId }], { dataVersion: 2 })),
    'GET /finance/goals': () => ({
      status: 200,
      body: { goals: created || server.satisfied.has('goal') ? [goalRow(server.goalId, 'Trip fund', 50000, 0, future)] : [] },
    }),
    'GET /finance/salary': { salary: null },
    'POST /finance/goals': () => {
      created = true;
      server.satisfied.add('goal');
      return {
        status: 200,
        body: goalEnvelope(goalSnapshot(MONTH, [{ id: server.goalId }], { dataVersion: 3 }), {
          operation: 'goal.create',
          goalId: server.goalId,
          changeId,
          record: { id: server.goalId, name: 'Trip fund', targetAmountMinor: paise(50000), savedAmountMinor: 0, targetDate: future },
        }),
      };
    },
  };
}

export function tripRoutes(server: FakeJourneyServer) {
  server.tripId = TRIP_ID;
  return { 'GET /finance/clarity': read(tripSnapshot(MONTH)) };
}

/** Everything a journey can fetch. A route a journey does not use is simply never called. */
export function routesFor(outcome: DesiredOutcome, server: FakeJourneyServer) {
  switch (outcome) {
    case 'plan_month': return salaryRoutes(server);
    case 'control_spending': return { ...salaryRoutes(server), ...expenseRoutes(server) };
    case 'fund_goal': return goalRoutes(server);
    default: return tripRoutes(server);
  }
}

/** Every request that is not a read and not a journey request, such as a saved record. */
export function financialWrites(calls: ReadonlyArray<{ method: string; path: string }>) {
  return calls.filter((call) => call.method !== 'GET' && !call.path.startsWith('/clarity/journeys'));
}
