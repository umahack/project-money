import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { AgreementGateProvider } from '../clarity/AgreementGateProvider';
import { DataUseGateProvider, PROMISE_RENDERED_KEY } from '../clarity/DataUseGateProvider';
import { DataUseGate } from '../components/clarity/DataUseGate';
import { installAgreementNetwork } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';
import { assertProperty } from '../test/propertyReport';
import { createTestUser, fc, renderAuthenticated, TEST_AUTH_TOKEN } from '../test/test-utils';
import { Agreement } from './Agreement';

/**
 * Feature: data-use-agreement-page, Property 9: No interaction with this feature writes to persistent storage or the console
 *
 * **Validates: Requirements 3.5, 8.5**
 *
 * One tree holds both surfaces of the feature: the Agreement page at `/agreement` and, on every other route, the
 * compact DataUseGate. Agreeing or choosing "Not now" leaves the page for `/`, where the compact gate is shown, so
 * a sequence can start on either surface and move between them. The providers, router, settings client, and
 * react-query are real. Only the network is replaced.
 *
 * Spies sit on `Storage.prototype` writes (setItem, removeItem, clear, which cover `sessionStorage` and
 * `localStorage`), on `document.cookie` writes, and on every `console` method.
 *
 * Writes that are NOT attributable to this feature are excluded explicitly, and nothing else is:
 * - `pm_promise_rendered`: the user-id-only session flag the Core Promise strip writes through `markPromiseShown`.
 *   It is older than this feature. The strip is not rendered here, so it is never written, but if it were it is
 *   not part of this feature and would not count.
 * - `pm_token` and `pm_user`: written by the test harness's own sign-in (`setAuth` in `renderAuthenticated`), with
 *   exactly the harness token and user. A different value under either key would still count.
 */

type Surface = 'agreement' | 'gate';
type Action = 'agree' | 'notNow' | 'toggle' | 'retry' | 'expand';

interface Case {
  surface: Surface;
  acknowledged: boolean;
  analyticsEnabled: boolean;
  get: 'ok' | 'error';
  patch: 'ok' | 'fail';
  actions: Action[];
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  surface: fc.constantFrom<Surface>('agreement', 'gate'),
  acknowledged: fc.boolean(),
  analyticsEnabled: fc.boolean(),
  get: fc.constantFrom<'ok' | 'error'>('ok', 'ok', 'ok', 'error'),
  patch: fc.constantFrom<'ok' | 'fail'>('ok', 'fail'),
  actions: fc.array(fc.constantFrom<Action>('agree', 'notNow', 'toggle', 'retry', 'expand'), {
    minLength: 1,
    maxLength: 6,
  }),
});

// -------------------------------- The spies --------------------------------

interface Spies {
  consoleCalls: unknown[][];
  storageWrites: Array<{ method: string; key: string; value: string }>;
  cookieWrites: string[];
  restore: () => void;
}

const CONSOLE_METHODS = [
  'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupCollapsed', 'assert',
] as const;

function installSpies(): Spies {
  const consoleCalls: unknown[][] = [];
  const storageWrites: Spies['storageWrites'] = [];
  const cookieWrites: string[] = [];
  const spies: MockInstance[] = [];

  for (const method of CONSOLE_METHODS) {
    spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); }));
  }

  const { setItem, removeItem, clear } = Storage.prototype;
  spies.push(
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemSpy(this: Storage, key: string, value: string) {
      storageWrites.push({ method: 'setItem', key, value: String(value) });
      setItem.call(this, key, value);
    }),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function removeItemSpy(this: Storage, key: string) {
      storageWrites.push({ method: 'removeItem', key, value: '' });
      removeItem.call(this, key);
    }),
    vi.spyOn(Storage.prototype, 'clear').mockImplementation(function clearSpy(this: Storage) {
      storageWrites.push({ method: 'clear', key: '', value: '' });
      clear.call(this);
    }),
  );

  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookie?.get?.call(document) as string,
    set: (value: string) => {
      cookieWrites.push(value);
      cookie?.set?.call(document, value);
    },
  });

  return {
    consoleCalls,
    storageWrites,
    cookieWrites,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      delete (document as unknown as Record<string, unknown>).cookie;
    },
  };
}

/** The storage writes this feature is answerable for: everything except the two exclusions named above. */
function attributable(writes: Spies['storageWrites'], userJson: string): Spies['storageWrites'] {
  return writes.filter((write) => {
    if (write.key === PROMISE_RENDERED_KEY) return false; // existing promise strip flag, not this feature
    if (write.method === 'setItem' && write.key === 'pm_token' && write.value === TEST_AUTH_TOKEN) return false;
    if (write.method === 'setItem' && write.key === 'pm_user' && write.value === userJson) return false;
    return true;
  });
}

// ------------------------------- Interactions -------------------------------

function visible<T extends Element>(element: T | null | undefined): T | null {
  return element && !element.closest('[hidden]') ? element : null;
}

function button(text: RegExp): HTMLButtonElement | null {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) => text.test(candidate.textContent ?? ''));
  return visible(found);
}

function perform(action: Action): void {
  switch (action) {
    case 'agree': {
      const control = button(/^I agree and continue$/);
      if (control && control.getAttribute('aria-disabled') !== 'true') fireEvent.click(control);
      return;
    }
    case 'notNow': {
      const control = button(/^Not now, just look around$/);
      if (control) fireEvent.click(control);
      return;
    }
    case 'toggle': {
      const box = visible(document.querySelector<HTMLInputElement>('input[type="checkbox"]'));
      if (box && !box.disabled) fireEvent.click(box);
      return;
    }
    case 'retry': {
      const control = button(/^(Retry loading settings|Try again)$/);
      if (control) fireEvent.click(control);
      return;
    }
    case 'expand': {
      const control = button(/Read full details/) ?? button(/Review the data-use notice/) ?? button(/Your data$/);
      if (control) fireEvent.click(control);
    }
  }
}

/** Lets the settings request, react-query's notifications, and any navigation finish. */
async function settle(ticks = 3): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < ticks; tick += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  });
}

async function checkCase(testCase: Case): Promise<void> {
  // The harness setup clears storage before each test, but a property runs many cases in one test.
  sessionStorage.clear();
  localStorage.clear();
  const spies = installSpies();
  try {
    const user = createTestUser();
    const settings = buildSettings({
      acknowledgedVersion: testCase.acknowledged ? 1 : 0,
      analyticsEnabled: testCase.analyticsEnabled,
    });
    const network = installAgreementNetwork({ settings, get: testCase.get, patch: testCase.patch });

    renderAuthenticated(
      <DataUseGateProvider enabled>
        <AgreementGateProvider>
          <Routes>
            <Route path="/agreement" element={<Agreement />} />
            <Route path="*" element={<DataUseGate />} />
          </Routes>
        </AgreementGateProvider>
      </DataUseGateProvider>,
      { route: testCase.surface === 'agreement' ? '/agreement' : '/spending', user },
    );
    // Both surfaces say so while the settings load, and stop saying so once they have loaded or failed.
    await waitFor(
      () => expect(document.body.textContent ?? '').not.toContain('Checking your data-use settings'),
      { timeout: 20_000 },
    );

    for (const action of testCase.actions) {
      perform(action);
      await settle();
    }
    await settle();
    expect(network.gets()).toBeGreaterThanOrEqual(1);

    // Nothing this feature did reached persistent storage, cookies, or the console.
    expect(attributable(spies.storageWrites, JSON.stringify(user))).toEqual([]);
    expect(spies.cookieWrites).toEqual([]);
    expect(spies.consoleCalls).toEqual([]);
    // And what is stored afterwards is nothing but the harness sign-in and (if ever present) the promise flag.
    expect(localStorage.length).toBe(0);
    const sessionKeys = Object.keys({ ...sessionStorage }).filter((key) => (
      key !== 'pm_token' && key !== 'pm_user' && key !== PROMISE_RENDERED_KEY
    ));
    expect(sessionKeys).toEqual([]);
  } finally {
    cleanup();
    spies.restore();
  }
}

// ----------------------------------- Tests -----------------------------------

describe('Property 9: No interaction with this feature writes to persistent storage or the console', () => {
  it('records writes the spies are meant to catch (negative control)', () => {
    const spies = installSpies();
    try {
      sessionStorage.setItem('x', '1');
      localStorage.setItem('y', '2');
      sessionStorage.removeItem('x');
      document.cookie = 'z=1';
      console.error('boom');
      console.warn('careful');
      expect(spies.storageWrites.map((write) => `${write.method}:${write.key}`)).toEqual([
        'setItem:x', 'setItem:y', 'removeItem:x',
      ]);
      expect(spies.cookieWrites).toEqual(['z=1']);
      expect(spies.consoleCalls).toEqual([['boom'], ['careful']]);
      // The promise strip's own flag is excluded, and a harness token with a different value is not.
      expect(attributable([
        { method: 'setItem', key: PROMISE_RENDERED_KEY, value: '4242' },
        { method: 'setItem', key: 'pm_token', value: TEST_AUTH_TOKEN },
        { method: 'setItem', key: 'pm_token', value: 'other' },
      ], '{}')).toEqual([{ method: 'setItem', key: 'pm_token', value: 'other' }]);
    } finally {
      spies.restore();
    }
  });

  it('writes nothing to storage, cookies, or the console for any interaction sequence', async () => {
    await assertProperty(
      fc.asyncProperty(caseArb, async (testCase) => {
        await checkCase(testCase);
      }),
    );
  }, 300_000);
});
