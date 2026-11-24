// A small fake of what the Settings page and the Shell read and write while Quick Add is in play:
// `GET/PATCH /api/clarity/settings` (notice version 1 or 2, with the acknowledgement rule), the category hints,
// and the Memory_API deletes. Everything else answers an empty object, as the other page fakes do.
import { cleanup } from '@testing-library/react';
import { vi } from 'vitest';
import { memoryClient, type QuickAddHints } from '../clarity/quickAdd/memoryClient';
import type { ClaritySettings } from '../clarity/settings';
import { buildSettings } from './claritySettingsBuilder';
import { createApiResponse } from './test-utils';

const ACCESS = ['account_user', 'authorized_administrators', 'service_operators_and_processors'];

/** Notice version 2 as the server sends it while its Quick Add flag is on. */
export function buildVersionTwoSettings(acknowledgedVersion: 0 | 1 | 2): ClaritySettings {
  const settings = buildSettings({ acknowledgedVersion: Math.min(acknowledgedVersion, 1) });
  const notice = settings.dataUseNotice;
  notice.version = 2;
  const expenses = notice.categories.find((category) => category.key === 'expenses');
  expenses?.purposes.push('calculate and explain today\'s spending allowance, including whether an expense is counted against it');
  expenses?.outcomes.push('today_allowance');
  notice.categories.push({
    key: 'category_memory',
    purposes: ['suggest a category for notes you have typed before'],
    outcomes: ['category_suggestion'],
    accessRoles: ACCESS,
    sharing: 'private',
    retention: 'until_account_deletion',
  });
  notice.acknowledgedVersion = acknowledgedVersion;
  notice.acknowledgedAt = acknowledgedVersion > 0 ? '2026-01-10T05:00:00.000Z' : null;
  notice.acknowledgementRequired = acknowledgedVersion < 2;
  return settings;
}

export interface MemoryRow { id: number; noteKey: string; category: string; revision: number }

export const DEFAULT_MEMORY: MemoryRow[] = [
  { id: 12, noteKey: 'coffee', category: 'Food', revision: 2 },
  { id: 7, noteKey: 'metro', category: 'Transport', revision: 1 },
  { id: 3, noteKey: 'chai at the station', category: 'Food', revision: 1 },
];

export interface SettingsMemoryCall { method: string; path: string; body: unknown }

export interface SettingsMemoryServer {
  calls: SettingsMemoryCall[];
  memory: MemoryRow[];
  settings: () => ClaritySettings;
  /** Calls that are not reads. */
  writes: () => SettingsMemoryCall[];
  /** Calls to the Memory_API or the hints. */
  memoryCalls: () => SettingsMemoryCall[];
  hintReads: () => SettingsMemoryCall[];
  settingsReads: () => SettingsMemoryCall[];
}

const isMemoryRoute = (path: string) => /quick-add|category-memory/.test(path);

export function installSettingsMemoryServer(options: {
  settings: ClaritySettings;
  memory?: MemoryRow[];
}): SettingsMemoryServer {
  let state = options.settings;
  const memory = (options.memory ?? DEFAULT_MEMORY).map((row) => ({ ...row }));
  const calls: SettingsMemoryCall[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/clarity/settings') {
      if (method === 'GET') return createApiResponse({ body: state });
      const next = structuredClone(state);
      if (typeof body?.acknowledgedNoticeVersion === 'number' && body.acknowledgedNoticeVersion === next.dataUseNotice.version) {
        next.dataUseNotice.acknowledgedVersion = body.acknowledgedNoticeVersion;
        next.dataUseNotice.acknowledgedAt = '2026-02-01T05:00:00.000Z';
        next.dataUseNotice.acknowledgementRequired = false;
      }
      state = next;
      return createApiResponse({ body: state });
    }
    if (path === '/finance/quick-add/hints') {
      const hints: QuickAddHints = {
        schemaVersion: 1,
        memory: memory.map((row) => ({ ...row, updatedAt: '2026-11-10T07:12:03.121Z' })),
        history: [],
        limits: { memoryEntries: 500, historyDays: 90, historyKeys: 500 },
      };
      return createApiResponse({ body: hints });
    }
    if (method === 'DELETE' && path === '/finance/category-memory') {
      const deleted = memory.length;
      memory.length = 0;
      return createApiResponse({ body: { schemaVersion: 1, deleted } });
    }
    if (method === 'DELETE' && path.startsWith('/finance/category-memory/')) {
      const id = Number(path.split('/').pop());
      const index = memory.findIndex((row) => row.id === id);
      if (index >= 0) memory.splice(index, 1);
      return createApiResponse({ body: { schemaVersion: 1, deleted: index >= 0 ? 1 : 0, id } });
    }
    if (path === '/auth/sessions') return createApiResponse({ body: { current_sid: 1, sessions: [] } });
    if (path === '/finance/categories') return createApiResponse({ body: { defaults: ['Food', 'Transport', 'Other'], custom: [] } });
    return createApiResponse({ body: {} });
  });
  return {
    calls,
    memory,
    settings: () => state,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    memoryCalls: () => calls.filter((call) => isMemoryRoute(call.path)),
    hintReads: () => calls.filter((call) => call.path === '/finance/quick-add/hints'),
    settingsReads: () => calls.filter((call) => call.path === '/clarity/settings' && call.method === 'GET'),
  };
}

/**
 * Puts the shared memory client back as it was at load. The page is unmounted first: a mounted panel would read the
 * hints again the moment the cache is cleared and leave the answer for the next test.
 */
export function resetSharedMemoryClient(): void {
  cleanup();
  memoryClient.reset();
  memoryClient.cache.clear();
}
