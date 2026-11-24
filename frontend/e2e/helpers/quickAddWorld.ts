// A closed Quick Add world for the real-browser accessibility and layout specs (task 16.2).
//
// It serves the Home snapshot with the `todayAllowance` outcome, the expense list and the expense changes, the category list,
// the data-use settings, and the Memory_API routes from one in-memory `FakeQuickAddBackend`, the same fake the jsdom tests
// use. Nothing leaves the browser fixture. The real application runs against it unmodified, so these specs measure the real
// CSS and the real components.
//
// The fixed Playwright servers have the Quick Add flag off, so a spec that uses this world runs against a dedicated flag-on
// server (see playwright.quickadd.config.ts).
import { expect, installAuthenticatedSession, type DeterministicApiFixtures, type RecordedApiRequest } from '../fixtures/test';
import { buildSettings } from '../../src/test/claritySettingsBuilder';
import { FakeQuickAddBackend } from '../../src/test/fakeQuickAddBackend';
import type { SpendingBackendReply, SpendingBackendRequest } from '../../src/test/fakeSpendingBackend';
import type { FinancialSnapshot } from '../../src/clarity/contracts';
import type { Page } from '@playwright/test';

/** The built-in categories, in the order the server lists them. */
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Bills', 'Health', 'Entertainment', 'Education', 'Other'];

/** The Kolkata calendar date now, which is the date the browser (timezone Asia/Kolkata) and the app agree on. */
export function kolkataToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const TODAY = kolkataToday();
export const MONTH = TODAY.slice(0, 7);

export const EXPENSES_PATH = '/api/finance/expenses';

/** Mixed scripts with no break opportunities inside the long words. */
export const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis0123456789';
export const LONG_NOTE = `Reimbursed ${LONG_WORD} INV-2026-0042-INV-2026-0042-INV-2026-0042`.slice(0, 120);

export interface StreakState {
  current: number;
  longest: number;
  days_logged: number;
}
class World extends FakeQuickAddBackend {
  /** What `GET /finance/streak` answers. */
  streak: StreakState = { current: 12, longest: 31, days_logged: 120 };
  /**
   * True plays the server's streak: the first expense dated Today moves the streak on by one day, and removing the last
   * expense dated Today moves it back. Off by default, so the accessibility specs keep a fixed card.
   */
  dynamicStreak = false;
  private hasExpenseToday(): boolean {
    return this.expenses.some((expense) => expense.spentOn === TODAY);
  }
  /**
   * The base fake keeps a fixed allowance and never reports "over". The server reports the excess and the share used, so
   * this derives them from the same server fields, which lets the over-today state reach the screen.
   */
  override snapshot(month: string = this.month): FinancialSnapshot {
    const snapshot = super.snapshot(month);
    const outcome = snapshot.outcomes.todayAllowance;
    const value = outcome?.value;
    if (!outcome || !value || !value.applicable) return snapshot;
    const allowance = value.todayAllowance.amountMinor;
    const spent = value.todaySpent.amountMinor;
    const over = Math.max(0, spent - allowance);
    const next = {
      ...value,
      leftToday: { currency: 'INR' as const, amountMinor: Math.max(0, allowance - spent) },
      overToday: { currency: 'INR' as const, amountMinor: over },
      usedPermille: allowance === 0 ? 0 : Math.min(1000, Math.round((spent * 1000) / allowance)),
    };
    return { ...snapshot, outcomes: { ...snapshot.outcomes, todayAllowance: { ...outcome, value: next } } };
  }

  override handle(request: SpendingBackendRequest): SpendingBackendReply {
    const get = request.method.toUpperCase() === 'GET';
    if (get && request.path === '/finance/categories') return { status: 200, body: { defaults: CATEGORIES, custom: [{ id: 3, name: 'Pets and the long name of a custom category' }] } };
    if (get && request.path === '/clarity/settings') return { status: 200, body: buildSettings({ acknowledgedVersion: 1 }) };
    if (get && request.path === '/invites') return { status: 200, body: { invites: [] } };
    if (get && request.path === '/finance/streak') return { status: 200, body: { ...this.streak } };
    if (!this.dynamicStreak) return super.handle(request);
    const method = request.method.toUpperCase();
    const watched = (method === 'POST' && request.path === '/finance/expenses')
      || (method === 'DELETE' && /^\/finance\/expenses\/\d+$/.test(request.path));
    const before = this.hasExpenseToday();
    const reply = super.handle(request);
    if (watched && reply.status === 200) {
      const after = this.hasExpenseToday();
      if (!before && after) {
        const current = this.streak.current + 1;
        this.streak = { current, longest: Math.max(this.streak.longest, current), days_logged: this.streak.days_logged + 1 };
      } else if (before && !after) {
        this.streak = { ...this.streak, current: this.streak.current - 1, days_logged: this.streak.days_logged - 1 };
      }
    }
    return reply;
  }
}

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SeedExpense {
  category: string;
  amountMinor: number;
  note: string;
  /** `YYYY-MM-DD`. Defaults to Today. */
  spentOn?: string;
  /** The expense carries the Allowance_Exclusion mark, as a Recurring_Auto_Post does. */
  excluded?: boolean;
}

export interface QuickAddWorld {
  backend: World;
  /** Holds the next response to `METHOD path` until `release()`. The change is applied when it is released. */
  hold(method: WriteMethod, path: string): { release(): void };
  /**
   * The server applies the next `METHOD path` request at once and holds only its response until `release()`. Several
   * calls queue in the order the requests arrive, so releasing them in another order plays responses that come back out
   * of order, each carrying the snapshot the server had when it applied that request.
   */
  holdResponse(method: WriteMethod, path: string): { release(): void };
  /** The server applies the next `METHOD path` request, and the answer the browser gets is a failure (a lost response). */
  applyThenFail(method: WriteMethod, path: string): void;
  /** Puts an expense in place, as an earlier session or the recurring job would have. Returns its id. */
  seed(expense: SeedExpense): number;
}

export interface WorldOptions {
  /** Leave out the `todayAllowance` outcome, as an older server does. */
  withoutToday?: boolean;
  /** The logging streak moves with the expenses, as the server's does. */
  dynamicStreak?: boolean;
}

/** A date in the current month that is not Today, so a seeded expense counts in the month but not in Today. */
export const OTHER_DAY = TODAY.endsWith('-01') ? `${MONTH}-02` : `${MONTH}-01`;
let seededId = 700;

export function installQuickAddWorld(api: DeterministicApiFixtures, options: WorldOptions = {}): QuickAddWorld {
  const backend = new World(MONTH, { categories: [...CATEGORIES, 'Pets and the long name of a custom category'] });
  backend.todayDate = options.withoutToday ? null : TODAY;
  backend.dynamicStreak = options.dynamicStreak ?? false;
  const respond = (request: RecordedApiRequest) => {
    const url = new URL(request.path, 'http://fixture.invalid');
    const path = url.pathname.replace(/^\/api/, '');
    // Measurement events and visit beacons get the empty answer the real server gives when a setting is off.
    if (path === '/clarity/events' || path === '/finance/visits' || path === '/visits') return { status: 204 };
    const reply = backend.handle({
      method: request.method,
      path,
      query: url.searchParams,
      body: request.body,
      // The server's replay of an Idempotency-Key needs the key the browser sent.
      ...(request.idempotencyKey ? { headers: { 'idempotency-key': request.idempotencyKey } } : {}),
    });
    return { status: reply.status, json: reply.body };
  };
  // The Settings page reads these two besides the routes the fake serves.
  api.stub('GET', '/api/auth/email-change-pending', { json: { pending: null } });
  api.stub('GET', '/api/auth/sessions', { json: { current_sid: 1, sessions: [] } });
  api.fallback(respond);
  return {
    backend,
    hold(method, path) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.stubOnce(method, path, async (request) => {
        await gate;
        return respond(request);
      });
      return { release };
    },
    holdResponse(method, path) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.stubOnce(method, path, async (request) => {
        const reply = respond(request);
        await gate;
        return reply;
      });
      return { release };
    },
    applyThenFail(method, path) {
      api.stubOnce(method, path, (request) => {
        respond(request);
        return { status: failure.status, json: { error: { code: failure.code, message: failure.message } } };
      });
    },
    seed(expense) {
      const id = seededId++;
      const spentOn = expense.spentOn ?? TODAY;
      backend.expenses.push({
        id,
        month: spentOn.slice(0, 7),
        category: expense.category,
        amountMinor: expense.amountMinor,
        note: expense.note,
        spentOn,
        version: 1,
      });
      if (expense.excluded) backend.marks.set(id, true);
      backend.dataVersion += 1;
      return id;
    },
  };
}

/** Signs in and opens a page. Resolves once the page heading is on screen. */
export async function openPage(page: Page, path: string): Promise<void> {
  await installAuthenticatedSession(page);
  await page.goto(path);
  await expect(page.locator('main h1').first()).toBeVisible();
}

/** The one input of Quick Add that is on screen (the Home panel or the dialog's). */
export const quickAddInput = (page: Page) => page.getByLabel('Add an expense');

/** Types a line into the input and presses Enter. */
export async function submitLine(page: Page, line: string): Promise<void> {
  const input = quickAddInput(page);
  await input.fill(line);
  await input.press('Enter');
}

/** The Quick Add shortcut for the browser's platform: Cmd + K on Apple platforms, Ctrl + K elsewhere (Requirement 1.7). */
export async function shortcutKey(page: Page): Promise<'Meta+K' | 'Control+K'> {
  const apple = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  return apple ? 'Meta+K' : 'Control+K';
}

/** Opens the Quick Add dialog the way the width allows: the floating action below 900 px, the shortcut from 900 px. */
export async function openDialog(page: Page, width: number): Promise<void> {
  if (width < 900) await page.getByRole('button', { name: 'Quick add expense' }).click();
  else await page.keyboard.press(await shortcutKey(page));
  await expect(page.getByRole('dialog', { name: 'Quick Add' })).toBeVisible();
  await expect(quickAddInput(page)).toBeFocused();
}

export const failure = { status: 500, code: 'INTERNAL_ERROR', message: 'The server had a problem.' } as const;

/**
 * Puts every Quick Add surface on screen: a failed entry, a saved entry with its Undo and the answer, and a typed line
 * that raises the large-entry warning. The first save fails because the world is told to fail it.
 */
export async function composeEverything(page: Page, world: QuickAddWorld): Promise<void> {
  world.backend.failWith('POST', '/finance/expenses', failure);
  await submitLine(page, '10 tea');
  await expect(page.locator('li.qa-entry[data-phase="failed"]')).toBeVisible();
  await submitLine(page, '20 chai');
  await expect(page.locator('li.qa-entry[data-phase="saved"]')).toBeVisible();
  await expect(page.locator('.qa-answer')).toBeVisible();
  await quickAddInput(page).fill('1500 laptop');
  await expect(page.getByRole('button', { name: "Save, but don't count against today" })).toBeVisible();
}

/**
 * The Undo window pauses while the pointer is over its button, so a long audit does not lose the saved row it is measuring.
 * It stays paused until the pointer leaves.
 */
export async function holdUndoWindow(page: Page): Promise<void> {
  const undo = page.getByRole('button', { name: /^Undo/ }).first();
  await undo.hover();
  await expect(page.locator('.qa-undo[data-paused]').first()).toBeVisible();
}
