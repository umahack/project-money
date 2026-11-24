import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryClient,
  selectSuggestionSources,
  type MemoryClient,
  type QuickAddHints,
} from '../../clarity/quickAdd/memoryClient';
import { suggestCategory } from '../../clarity/quickAdd/suggester';
import { Settings } from '../../pages/Settings';
import { axe, createApiResponse, renderAuthenticated } from '../../test/test-utils';
import { CategoryMemoryPanel } from './CategoryMemoryPanel';

const css = readFileSync('src/components/clarity/categoryMemory.css', 'utf8');
const CATEGORIES = ['Food', 'Transport', 'Other'];

function hintsBody(memory: QuickAddHints['memory'] = [
  { id: 12, noteKey: 'coffee', category: 'Food', revision: 2, updatedAt: '2026-11-10T07:12:03.121Z' },
  { id: 7, noteKey: 'metro', category: 'Transport', revision: 1, updatedAt: '2026-11-09T07:12:03.121Z' },
  { id: 3, noteKey: 'chai at the station', category: 'Food', revision: 1, updatedAt: '2026-11-08T07:12:03.121Z' },
]): QuickAddHints {
  return {
    schemaVersion: 1,
    memory,
    history: [],
    limits: { memoryEntries: 500, historyDays: 90, historyKeys: 500 },
  };
}

interface Call { method: string; path: string; body: unknown }
type Reply = { status?: number; body: unknown } | 'network' | 'hang';

function fakeServer(handler: (call: Call, calls: Call[]) => Reply) {
  const calls: Call[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path: String(input).replace(/^\/api/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call, calls);
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if (reply === 'hang') return new Promise<Response>(() => undefined);
    return createApiResponse(reply);
  });
  return calls;
}

const MEMORY_PATH = '/finance/category-memory';
const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');
const hintReads = (calls: Call[]) => calls.filter((call) => call.path === '/finance/quick-add/hints');
const deleteEntry = (id: number) => ({ status: 200, body: { schemaVersion: 1, deleted: 1, id } });
const serverError = { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Server detail that must not be shown.' } } };

/** Serves the hints and answers each delete by id, or all at once, through `onDelete`. */
function memoryServer(onDelete: (call: Call, attempt: number) => Reply = (call) => (
  call.path === MEMORY_PATH ? { body: { schemaVersion: 1, deleted: 3 } } : deleteEntry(Number(call.path.split('/').pop()))
), hints: QuickAddHints = hintsBody()) {
  let attempts = 0;
  return fakeServer((call) => {
    if (call.path === '/finance/quick-add/hints') return { body: hints };
    if (call.method === 'DELETE') {
      attempts += 1;
      return onDelete(call, attempts);
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No route.' } } };
  });
}

const created: MemoryClient[] = [];
function isolated(isEnabled = true): { client: MemoryClient; cache: QueryClient } {
  const cache = new QueryClient();
  const client = createMemoryClient({ queryClient: cache, isEnabled: () => isEnabled });
  created.push(client);
  return { client, cache };
}

function renderPanel(options: { enabled?: boolean } = {}) {
  const { client, cache } = isolated(options.enabled ?? true);
  const view = renderAuthenticated(<CategoryMemoryPanel client={client} />);
  return { client, cache, ...view };
}

const forgetButton = (note: string) => screen.getByRole('button', { name: `Forget the remembered choice for ${note}` });
const heading = () => screen.getByRole('heading', { name: 'Remembered category choices' });

afterEach(() => {
  for (const client of created.splice(0)) client.dispose();
  document.documentElement.removeAttribute('data-theme');
});

describe('flag off', () => {
  it('renders nothing and sends no request while Quick_Add_Enabled is off', async () => {
    const calls = memoryServer();
    const { container } = renderPanel({ enabled: false });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.memory-panel')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('Settings page', () => {
  function settingsServer() {
    return fakeServer((call) => {
      if (call.path === '/finance/quick-add/hints') return { body: hintsBody() };
      if (call.path === '/auth/sessions') return { body: { current_sid: 1, sessions: [] } };
      if (call.path === '/finance/categories') return { body: { defaults: CATEGORIES, custom: [] } };
      return { body: {} };
    });
  }

  it('is unchanged and sends no Memory_API request while the flag is off', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', '');
    const calls = settingsServer();
    renderAuthenticated(<Settings />);
    await screen.findByRole('heading', { name: /Export my data/ });
    expect(screen.queryByRole('heading', { name: 'Remembered category choices' })).toBeNull();
    expect(calls.filter((call) => call.path.includes('category-memory') || call.path.includes('quick-add'))).toEqual([]);
  });

  it('shows the memory panel between Product Analytics and export while the flag is on', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', 'true');
    const calls = settingsServer();
    renderAuthenticated(<Settings />);
    expect(await screen.findByText('coffee')).toBeInTheDocument();
    const order = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent ?? '');
    const memory = order.findIndex((text) => text.includes('Remembered category choices'));
    const exportIndex = order.findIndex((text) => text.includes('Export my data'));
    expect(memory).toBeGreaterThan(-1);
    expect(memory).toBeLessThan(exportIndex);
    expect(hintReads(calls)).toHaveLength(1);
  });
});

describe('list and states', () => {
  it('shows loading, then every entry as note and category with the kept-data explanation', async () => {
    memoryServer();
    renderPanel();
    expect(screen.getByText('Loading your remembered choices…')).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Remembered category choices' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').replace('Forget', '').trim())).toEqual([
      'coffee goes in Food',
      'metro goes in Transport',
      'chai at the station goes in Food',
    ]);
    expect(screen.getByText(/3 remembered choices, newest change first\. Up to 500 are kept/)).toBeInTheDocument();

    // What is kept, where, who can see it, for how long, and how to export or delete it (Requirements 6.18, 14.7).
    expect(screen.getByText(/No amounts, dates, or links to your expenses/)).toBeInTheDocument();
    expect(screen.getByText('On the Project Money server, for your account only.')).toBeInTheDocument();
    expect(screen.getByText(/You, the account owner; Authorized Project Money administrators/)).toBeInTheDocument();
    expect(screen.getByText(/Private to you\. It is never part of public trip links or Product Analytics/)).toBeInTheDocument();
    expect(screen.getByText(/Kept until you delete your account, or until you forget it here/)).toBeInTheDocument();
    expect(screen.getByText(/included when you download your account data, and are deleted with your account/)).toBeInTheDocument();
  });

  it('shows a plain empty state when nothing is remembered, with no Forget all', async () => {
    memoryServer(undefined, hintsBody([]));
    renderPanel();
    expect(await screen.findByText(/Nothing is remembered yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget all' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says it could not load, reads only once, and shows no list when the read fails', async () => {
    const calls = fakeServer(() => serverError);
    renderPanel();
    expect(await screen.findByText(/could not be loaded\. Quick Add still saves your entries/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: /Forget/ })).toBeNull();
    expect(hintReads(calls)).toHaveLength(1);
  });

  it('keeps listing and forgetting entries after the server refused remembering new ones', async () => {
    const calls = fakeServer((call) => {
      if (call.path === '/finance/quick-add/hints') return { body: hintsBody() };
      if (call.method === 'PUT') return { status: 404, body: { error: { code: 'QUICK_ADD_DISABLED', message: 'off' } } };
      return deleteEntry(12);
    });
    const { client } = renderPanel();
    await screen.findByText('coffee');
    await act(async () => { await client.remember('other', { noteKey: 'tea', category: 'Food' }); });

    expect(await screen.findByText(/not saving new remembered choices right now/)).toBeInTheDocument();
    expect(screen.getByText('coffee')).toBeInTheDocument();
    await userEvent.click(forgetButton('coffee'));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(writes(calls).filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('renders notes and categories as plain text', async () => {
    memoryServer(undefined, hintsBody([
      { id: 1, noteKey: '<img src=x onerror=alert(1)>', category: '<b>Food</b>', revision: 1, updatedAt: '2026-11-10T07:12:03.121Z' },
    ]));
    const { container } = renderPanel();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img, b')).toBeNull();
  });
});

describe('forget one', () => {
  it('deletes by id, updates the list, stops suggesting the entry, and moves focus to the next item', async () => {
    const user = userEvent.setup();
    const calls = memoryServer();
    const { client } = renderPanel();
    await screen.findByText('coffee');
    expect(suggestCategory({ note: 'Coffee', categories: CATEGORIES, ...selectSuggestionSources(client.readView()) }))
      .toMatchObject({ category: 'Food', source: 'memory' });

    await user.click(forgetButton('coffee'));

    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: `${MEMORY_PATH}/12`, body: undefined }]);
    expect(forgetButton('metro')).toHaveFocus();
    expect(screen.getByText('Forgot the remembered choice for coffee.')).toBeInTheDocument();
    expect(screen.getByText(/2 remembered choices/)).toBeInTheDocument();
    // The next suggestion no longer uses the deleted entry (Requirement 6.11).
    expect(suggestCategory({ note: 'Coffee', categories: CATEGORIES, ...selectSuggestionSources(client.readView()) }))
      .not.toMatchObject({ source: 'memory' });
    expect(hintReads(calls)).toHaveLength(1);
  });

  it('moves focus to the previous item after the last one is forgotten, then to the heading after the only one', async () => {
    const user = userEvent.setup();
    memoryServer(undefined, hintsBody([
      { id: 12, noteKey: 'coffee', category: 'Food', revision: 2, updatedAt: '2026-11-10T07:12:03.121Z' },
      { id: 7, noteKey: 'metro', category: 'Transport', revision: 1, updatedAt: '2026-11-09T07:12:03.121Z' },
    ]));
    renderPanel();
    await screen.findByText('coffee');

    await user.click(forgetButton('metro'));
    await waitFor(() => expect(screen.queryByText('metro')).toBeNull());
    expect(forgetButton('coffee')).toHaveFocus();

    await user.click(forgetButton('coffee'));
    await screen.findByText(/Nothing is remembered yet/);
    expect(heading()).toHaveFocus();
  });

  it('does not take focus back from a control the user moved to', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const path = String(input).replace(/^\/api/, '');
      if (path === '/finance/quick-add/hints') return createApiResponse({ body: hintsBody() });
      expect(init?.method).toBe('DELETE');
      await gate;
      return createApiResponse(deleteEntry(12));
    });
    renderPanel();
    await screen.findByText('coffee');

    await user.click(forgetButton('coffee'));
    expect(await screen.findByText('Forgetting…')).toBeInTheDocument();
    forgetButton('metro').focus();
    release();

    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(forgetButton('metro')).toHaveFocus();
  });

  it('shows pending text on the row only, keeps Forget in place, and sends one request for a double activation', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Call[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const path = String(input).replace(/^\/api/, '');
      calls.push({ method: init?.method ?? 'GET', path, body: undefined });
      if (path === '/finance/quick-add/hints') return createApiResponse({ body: hintsBody() });
      await gate;
      return createApiResponse(deleteEntry(12));
    });
    renderPanel();
    await screen.findByText('coffee');

    await user.click(forgetButton('coffee'));
    await user.click(forgetButton('coffee'));
    const row = screen.getByText('coffee').closest('li') as HTMLElement;
    expect(within(row).getByText('Forgetting…')).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(forgetButton('coffee')).toHaveAttribute('aria-disabled', 'true');
    expect(within(screen.getByText('metro').closest('li') as HTMLElement).queryByText('Forgetting…')).toBeNull();
    release();

    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('keeps the entry on a failed delete, shows scoped text without server detail, and retries the same request', async () => {
    const user = userEvent.setup();
    const calls = memoryServer((call, attempt) => (attempt === 1 ? serverError : deleteEntry(Number(call.path.split('/').pop()))));
    renderPanel();
    await screen.findByText('coffee');

    await user.click(forgetButton('coffee'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not forgotten. Could not confirm that this choice was forgotten. Check your connection, then retry.');
    expect(alert).not.toHaveTextContent('Server detail');
    expect(screen.getByText('coffee')).toBeInTheDocument();
    expect(within(screen.getByText('metro').closest('li') as HTMLElement).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Retry forgetting the remembered choice for coffee' }));

    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE ${MEMORY_PATH}/12`,
      `DELETE ${MEMORY_PATH}/12`,
    ]);
  });

  it('offers no Retry for a refusal that resending cannot fix, and Forget stays available', async () => {
    const user = userEvent.setup();
    memoryServer((call, attempt) => (attempt === 1
      ? { status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'bad' } } }
      : deleteEntry(Number(call.path.split('/').pop()))));
    renderPanel();
    await screen.findByText('coffee');

    await user.click(forgetButton('coffee'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not forget this choice. Try again.');
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
    expect(forgetButton('coffee')).toHaveFocus();

    await user.click(forgetButton('coffee'));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
  });

  it('treats an entry that is already gone as forgotten', async () => {
    const user = userEvent.setup();
    memoryServer(() => ({ status: 404, body: { error: { code: 'MEMORY_NOT_FOUND', message: 'gone' } } }));
    renderPanel();
    await screen.findByText('coffee');
    await user.click(forgetButton('coffee'));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('forget all', () => {
  it('asks first, sends nothing until confirmed, and cancels with Keep them or Escape', async () => {
    const user = userEvent.setup();
    const calls = memoryServer();
    renderPanel();
    await screen.findByText('coffee');

    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    const group = screen.getByRole('group', { name: 'Forget all 3 remembered choices?' });
    expect(group).toHaveTextContent('Your saved expenses and their categories are not changed.');
    expect(screen.getByRole('button', { name: 'Keep them' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Forget all' })).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget all' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget all' })).toHaveFocus();

    expect(writes(calls)).toEqual([]);
    expect(screen.getByText('coffee')).toBeInTheDocument();
  });

  it('deletes every entry with one request, clears the list, and focuses the heading', async () => {
    const user = userEvent.setup();
    const calls = memoryServer();
    const { client } = renderPanel();
    await screen.findByText('coffee');

    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    await user.click(screen.getByRole('button', { name: 'Yes, forget all' }));

    expect(await screen.findByText(/Nothing is remembered yet/)).toBeInTheDocument();
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: MEMORY_PATH, body: undefined }]);
    expect(screen.queryByRole('group')).toBeNull();
    expect(heading()).toHaveFocus();
    expect(screen.getByText('Forgot all remembered choices.')).toBeInTheDocument();
    expect(client.readView().memory).toEqual([]);
    expect(suggestCategory({ note: 'metro', categories: CATEGORIES, ...selectSuggestionSources(client.readView()) }))
      .not.toMatchObject({ source: 'memory' });
  });

  it('keeps the entries on failure, shows the failure in the confirmation, and retries the same request', async () => {
    const user = userEvent.setup();
    const calls = memoryServer((_call, attempt) => (attempt === 1 ? 'network' : { body: { schemaVersion: 1, deleted: 3 } }));
    renderPanel();
    await screen.findByText('coffee');

    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    await user.click(screen.getByRole('button', { name: 'Yes, forget all' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not confirm that your remembered choices were forgotten');
    expect(screen.getByText('coffee')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveFocus();

    await user.click(retry);

    expect(await screen.findByText(/Nothing is remembered yet/)).toBeInTheDocument();
    expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE ${MEMORY_PATH}`, `DELETE ${MEMORY_PATH}`]);
    expect(heading()).toHaveFocus();
  });
});

describe('accessibility and layout', () => {
  async function auditStates(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    const user = userEvent.setup();
    memoryServer((_call, attempt) => (attempt === 1 ? serverError : deleteEntry(12)));
    const { container } = renderPanel();
    await screen.findByText('coffee');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(forgetButton('coffee'));
    await screen.findByRole('alert');
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Forget all' }));
    expect(await axe(container)).toHaveNoViolations();
  }

  it('has no axe violations in the list, failure, and confirmation states in the light theme', async () => {
    await auditStates('light');
  });

  it('has no axe violations in the list, failure, and confirmation states in the dark theme', async () => {
    await auditStates('dark');
  });

  it('has no axe violations while loading, empty, or unavailable', async () => {
    memoryServer(undefined, hintsBody([]));
    const first = renderPanel();
    expect(await axe(first.container)).toHaveNoViolations();
    await screen.findByText(/Nothing is remembered yet/);
    expect(await axe(first.container)).toHaveNoViolations();
    first.unmount();

    fakeServer(() => serverError);
    const second = renderPanel();
    await screen.findByText(/could not be loaded/);
    expect(await axe(second.container)).toHaveNoViolations();
  });

  it('operates by keyboard alone: Tab reaches Forget and Forget all, Enter activates, and focus never falls to the page', async () => {
    const user = userEvent.setup();
    memoryServer();
    renderPanel();
    await screen.findByText('coffee');

    await user.tab();
    expect(forgetButton('coffee')).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());
    expect(forgetButton('metro')).toHaveFocus();

    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Forget all' })).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Keep them' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Yes, forget all' })).not.toHaveFocus();
  });

  it('sizes every control to 44 CSS pixels, wraps long text, stays one column, and removes motion', () => {
    expect(css).toMatch(/\.memory-panel \.btn,\s*\.memory-panel \.btn\.sm\s*\{[^}]*min-height: 44px; min-width: 44px/);
    expect(css).toMatch(/\.memory-panel\s*\{[^}]*min-width: 0; overflow-wrap: anywhere/);
    expect(css).toMatch(/\.memory-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    // The two-column row exists only from 640 CSS pixels, so 320 to 639 stays a single column.
    expect(css).toMatch(/@media \(min-width: 640px\)\s*\{\s*\.memory-row\s*\{[^}]*minmax\(0, 1fr\) auto/);
    expect(css).not.toMatch(/(?<![\w-])width: \d+px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important; animation: none !important/);
  });

  it('never writes notes or categories to the console or to browser storage', async () => {
    const user = userEvent.setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    memoryServer((_call, attempt) => (attempt === 1 ? serverError : deleteEntry(12)));
    renderPanel();
    await screen.findByText('coffee');
    await user.click(forgetButton('coffee'));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /^Retry/ }));
    await waitFor(() => expect(screen.queryByText('coffee')).toBeNull());

    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/coffee|metro|Transport/);
    // Only the test sign-in is stored. No note, key, or category reaches browser storage.
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/coffee|metro|Transport|Food/);
  });
});
