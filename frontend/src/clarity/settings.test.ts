import { describe, expect, it, vi } from 'vitest';
import { setAuth } from '../api';
import { buildSettings } from '../test/dataUseFixtures';
import { createApiResponse, createTestUser } from '../test/test-utils';
import {
  acknowledgeDataUseNotice,
  DATA_NOTICE_REQUIRED_EVENT,
  fetchClaritySettings,
  parseClaritySettings,
  setProductAnalyticsEnabled,
} from './settings';

describe('parseClaritySettings', () => {
  it('copies only the known fields', () => {
    const raw = { ...buildSettings(), extra: 'ignored' } as Record<string, unknown>;
    const parsed = parseClaritySettings(raw) as unknown as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed).toEqual(buildSettings());
  });

  it.each([
    ['an unsupported schema version', { ...buildSettings(), schemaVersion: 2 }],
    ['a missing notice', { schemaVersion: 1, timeZone: 'Asia/Kolkata', productAnalytics: buildSettings().productAnalytics }],
    ['a non-object', 'text'],
  ])('rejects %s', (_name, value) => {
    expect(() => parseClaritySettings(value)).toThrow(/unsupported format/);
  });
});

describe('settings client calls', () => {
  it('sends only the fixed fields for each update, with the session token', async () => {
    setAuth('session-token', createTestUser());
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async () => createApiResponse({ body: buildSettings({ acknowledgedVersion: 1 }) }));

    await fetchClaritySettings();
    await acknowledgeDataUseNotice(1);
    await setProductAnalyticsEnabled(false);

    const bodies = fetchMock.mock.calls.map(([, init]) => init?.body);
    expect(bodies).toEqual([
      undefined,
      JSON.stringify({ acknowledgedNoticeVersion: 1 }),
      JSON.stringify({ analyticsEnabled: false }),
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH', 'PATCH']);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/\/api\/clarity\/settings$/);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    }
  });

  it('announces a 428 DATA_NOTICE_REQUIRED rejection from any command', async () => {
    setAuth('session-token', createTestUser());
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(createApiResponse({
      status: 428,
      body: { error: { code: 'DATA_NOTICE_REQUIRED', message: 'Acknowledge the notice first.' } },
    }));
    const listener = vi.fn();
    window.addEventListener(DATA_NOTICE_REQUIRED_EVENT, listener);
    try {
      await expect(setProductAnalyticsEnabled(true)).rejects.toMatchObject({ status: 428, code: 'DATA_NOTICE_REQUIRED' });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(DATA_NOTICE_REQUIRED_EVENT, listener);
    }
  });
});
