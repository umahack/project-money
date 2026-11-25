// Quick Add haptics through the real providers (task 5.8; Requirements 5.1, 5.2, 5.3, 5.4, 5.5).
//
// The Haptics plugin and the platform check are the only mocked pieces. The Shell, mutation runner, store, and actions
// are real and run against the transport-free FakeQuickAddBackend, as in quickAddFlows.test.tsx. The Shell itself is
// left out because a native platform would also register its hardware back-button listener.
//
// - one impulse per confirmed save (light) and one per confirmed undo (a different, medium one),
// - none while an entry is pending, failed, or when an undo fails or finds the entry already removed,
// - one for a confirmed same-key retry, none on the web, and a rejecting plugin leaves the saved row as it is.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementGateProvider } from '../../clarity/AgreementGateProvider';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../../clarity/DataUseGateProvider';
import { FinancialClarityProvider } from '../../clarity/FinancialClarityProvider';
import { MutationStatusProvider } from '../../clarity/MutationStatusProvider';
import { BUILT_IN_CATEGORIES } from '../../clarity/quickAdd/keywordRules';
import { resetServerTimeOffset } from '../../clarity/quickAdd/kolkata';
import { QuickAddProvider } from '../../clarity/quickAdd/QuickAddProvider';
import { createQuickAddStore, type QuickAddStore } from '../../clarity/quickAdd/quickAddStore';
import { buildSettings } from '../../test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../test/fakeQuickAddBackend';
import { installSpendingFetch, type SpendingFetch } from '../../test/fakeSpendingFetch';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../test/fakeSpendingBackend';
import { resetSharedMemoryClient } from '../../test/settingsMemoryServer';
import { createTestQueryClient, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { QuickAddPanel } from './QuickAddPanel';
import { QUICK_ADD_LABEL } from './QuickAddInput';
import { SAVED_TEXT } from './QuickAddEntries';

const mocks = vi.hoisted(() => ({
  native: true,
  impact: vi.fn<(options: { style: string }) => Promise<void>>(),
}));

vi.mock('../../platform', () => ({ isNativePlatform: () => mocks.native }));
vi.mock('@capacitor/haptics', () => ({
  Haptics: { impact: mocks.impact },
  ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
}));

const MONTH = '2026-11';
const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T06:30:00.000Z');
const EXPENSES = '/finance/expenses';
const HINTS = '/finance/quick-add/hints';
const SAVE_STYLE = 'LIGHT';
const UNDO_STYLE = 'MEDIUM';

/** The Spending fake with the category list and the data-use settings the gate reads. */
class HapticsBackend extends FakeQuickAddBackend {
  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') {
      return { status: 200, body: { defaults: [...BUILT_IN_CATEGORIES], custom: [] } };
    }
    if (request.path === '/clarity/settings' && get) {
      return { status: 200, body: buildSettings({ acknowledgedVersion: 1 }) };
    }
    return super.handle(request);
  }
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>;
  backend: HapticsBackend;
  net: SpendingFetch;
  store: QuickAddStore;
}

function mount(prepare?: (backend: HapticsBackend, net: SpendingFetch) => void): Harness {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
  vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
  sessionStorage.setItem(PROMISE_RENDERED_KEY, '4242');
  window.innerWidth = 1280;
  // The operating system does not ask for reduced motion.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  const backend = new HapticsBackend(MONTH, { categories: [...BUILT_IN_CATEGORIES] });
  backend.todayDate = TODAY;
  const net = installSpendingFetch(backend);
  prepare?.(backend, net);
  const store = createQuickAddStore();
  renderAuthenticated(
    <FinancialClarityProvider>
      <MutationStatusProvider>
        <QuickAddProvider store={store}>
          <DataUseGateProvider>
            <AgreementGateProvider>
              <Routes>
                <Route path="/" element={<QuickAddPanel variant="inline" headingLevel={2} />} />
              </Routes>
            </AgreementGateProvider>
          </DataUseGateProvider>
        </QuickAddProvider>
      </MutationStatusProvider>
    </FinancialClarityProvider>,
    { route: '/', queryClient: createTestQueryClient(), user: createTestUser({ is_admin: false }) },
  );
  return { user: userEvent.setup(), backend, net, store };
}

beforeEach(() => {
  mocks.native = true;
  mocks.impact.mockReset();
  mocks.impact.mockResolvedValue(undefined);
  vi.setSystemTime(NOW);
});
afterEach(() => {
  resetSharedMemoryClient();
  resetServerTimeOffset();
  delete (window.navigator as unknown as Record<string, unknown>).platform;
});

const input = () => screen.getByLabelText(QUICK_ADD_LABEL) as HTMLInputElement;
const rows = () => [...document.querySelectorAll<HTMLElement>('li.qa-entry')];
const impactStyles = () => mocks.impact.mock.calls.map((call) => call[0]?.style);

/** The input is on screen and the data-use gate and the Quick Add hints have been read. */
async function ready(h: Harness) {
  await screen.findByLabelText(QUICK_ADD_LABEL);
  await waitFor(() => expect(h.net.to('GET', '/clarity/settings').length).toBeGreaterThan(0));
  await waitFor(() => expect(h.net.to('GET', HINTS).length).toBeGreaterThan(0));
}
async function enter(h: Harness, line: string) {
  await h.user.type(input(), `${line}{Enter}`);
}
async function waitForPhase(h: Harness, expected: string) {
  await waitFor(() => expect(h.store.getState().entries.at(-1)?.phase).toBe(expected));
}
/** Lets the fire-and-forget haptic call (a dynamic import, then the plugin call) finish, to prove that none is coming. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe('Quick Add haptics on a native platform', () => {
  it('fires one light impulse for a confirmed save and one different impulse for a confirmed undo', async () => {
    const h = mount();
    await ready(h);

    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE]);

    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(2));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE, UNDO_STYLE]);
    expect(SAVE_STYLE).not.toBe(UNDO_STYLE);
  });

  it('fires one impulse per saved entry when several are saved', async () => {
    const h = mount();
    await ready(h);
    await enter(h, '10 tea');
    await waitForPhase(h, 'saved');
    await enter(h, '20 chai');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(2));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE, SAVE_STYLE]);
  });

  it('fires nothing while the save is pending and one impulse when the server confirms it', async () => {
    let gate: { release(): void } | undefined;
    const h = mount((_backend, net) => { gate = net.hold('POST', EXPENSES); });
    await ready(h);
    await enter(h, '120 coffee');
    await waitFor(() => expect(h.store.getState().entries.at(-1)?.phase).toBe('pending'));
    await settle();
    expect(mocks.impact).not.toHaveBeenCalled();

    gate?.release();
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE]);
  });

  it('fires nothing for a failed save, and one impulse when the same-key retry is confirmed', async () => {
    const h = mount((backend) => backend.failWith('POST', EXPENSES, { status: 503, code: 'UNAVAILABLE', message: 'Try again.' }));
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'failed');
    await settle();
    expect(mocks.impact).not.toHaveBeenCalled();

    await h.user.click(screen.getByRole('button', { name: 'Retry saving ₹120 coffee' }));
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE]);
  });

  it('fires nothing for a validation failure', async () => {
    const h = mount((backend) => backend.failWith('POST', EXPENSES, {
      status: 422, code: 'VALIDATION_ERROR', field: 'amountMinor', message: 'The amount is too large.',
    }));
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'failed');
    await settle();
    expect(mocks.impact).not.toHaveBeenCalled();
  });

  it('fires no undo impulse when the undo fails, and one when the retry is confirmed', async () => {
    const h = mount();
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    const expenseId = h.store.getState().entries[0]?.expenseId;
    h.backend.failWith('DELETE', `${EXPENSES}/${expenseId}`, { status: 500, code: 'INTERNAL_ERROR' });

    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undo_failed');
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE]);

    await h.user.click(screen.getByRole('button', { name: 'Retry undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(2));
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE, UNDO_STYLE]);
  });

  it('fires no undo impulse when the expense was already removed', async () => {
    const h = mount();
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    h.backend.removeElsewhere(h.store.getState().entries[0]?.expenseId ?? 0);

    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    expect(h.store.getState().entries[0]?.alreadyRemoved).toBe(true);
    await settle();
    expect(impactStyles()).toEqual([SAVE_STYLE]);
  });

  it('keeps the saved row and the saved state when the plugin rejects', async () => {
    mocks.impact.mockRejectedValue(new Error('Haptics unavailable'));
    const h = mount();
    await ready(h);
    await enter(h, '120 coffee');
    await waitForPhase(h, 'saved');
    await waitFor(() => expect(mocks.impact).toHaveBeenCalledTimes(1));
    await settle();
    expect(rows()[0]).toHaveAttribute('data-phase', 'saved');
    expect(rows()[0]).toHaveTextContent(SAVED_TEXT);
    expect(h.backend.expenses).toHaveLength(1);

    await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
    await waitForPhase(h, 'undone');
    expect(h.backend.expenses).toHaveLength(0);
  });
});

describe('Quick Add haptics on the web', () => {
  it('fires nothing for a save or an undo, and the flow is unchanged', async () => {
    mocks.native = false;
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });
    try {
      const h = mount();
      await ready(h);
      await enter(h, '120 coffee');
      await waitForPhase(h, 'saved');
      await h.user.click(screen.getByRole('button', { name: 'Undo ₹120 coffee' }));
      await waitForPhase(h, 'undone');
      await settle();
      expect(mocks.impact).not.toHaveBeenCalled();
      expect(vibrate).not.toHaveBeenCalled();
      expect(h.backend.expenses).toHaveLength(0);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).vibrate;
    }
  });
});
