import fc from 'fast-check';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  analyticsConsentFromSettings,
  buildEventPayload,
  CLARITY_RESPONSES,
  createMeasurementClient,
  DESIRED_OUTCOMES,
  MAX_QUEUED_EVENTS,
  MEASUREMENT_ACTION_KEYS,
  MEASUREMENT_EVENT_NAMES,
  MEASUREMENT_EVENTS_PATH,
  MEASUREMENT_OUTCOME_KINDS,
  type FinancialChangeUiInput,
  type MeasurementClient,
  type MeasurementClientOptions,
  type ProductMeasurementEventPayload,
} from './measurement';
import { buildSettings } from '../test/dataUseFixtures';

const NOW = '2026-01-15T06:30:00.000Z';
const INSTANCE_ID = '3f2b8c1e-9d4a-4e7b-8a15-0c6d2f9e7a41';
const TOKEN = 'session.jwt.token';

/** The backend's closed schemas (`measurementService.js`): every field of every event. */
const SERVER_SCHEMA_FIELDS: Record<string, string[]> = {
  journey_started: ['journeyId', 'desiredOutcome', 'occurredAt'],
  first_outcome_displayed: ['journeyId', 'outcomeKind', 'occurredAt'],
  clarity_response: ['journeyId', 'response', 'occurredAt'],
  recommended_action_completed: ['journeyId', 'recommendationInstanceId', 'actionKey', 'occurredAt'],
  financial_change_ui: ['changeId', 'causedReload', 'causedPageWideLoading', 'occurredAt'],
};

/** Field names the server forbids a client from sending. */
const SERVER_OWNED_OR_VALUE_FIELDS = [
  'userId', 'user_id', 'sessionId', 'sid', 'consentVersion', 'consent', 'timeZone',
  'localDate', 'localWeekStart', 'receivedAt', 'eventId',
  'amount', 'amountMinor', 'currency', 'name', 'label', 'note', 'description',
  'email', 'member', 'trip', 'tripName', 'target', 'salary', 'bill', 'expense',
  'url', 'path', 'route', 'token', 'metadata', 'properties',
];

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function respond(status = 204): Response {
  return new Response(null, { status });
}

function setup(overrides: MeasurementClientOptions & { consent?: boolean } = {}) {
  const { consent = true, ...options } = overrides;
  const fetchMock: FetchMock = vi.fn<typeof fetch>(async () => respond());
  const client = createMeasurementClient({
    isRolloutEnabled: () => true,
    getToken: () => TOKEN,
    getFetch: () => fetchMock,
    isOnline: () => true,
    now: () => new Date(NOW),
    apiBase: () => 'https://api.example.test',
    ...options,
  });
  client.setAnalyticsConsent(consent);
  return { client, fetchMock };
}

const bodyOf = (fetchMock: FetchMock, index = 0): Record<string, unknown> => {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
};

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function sendEveryEvent(client: MeasurementClient) {
  client.journeyStarted({ journeyId: 7, desiredOutcome: 'plan_month' });
  client.firstOutcomeDisplayed({ journeyId: 7, outcomeKind: 'monthly_plan' });
  client.clarityResponse({ journeyId: 7, response: 'partly' });
  client.recommendedActionCompleted({
    journeyId: 7,
    recommendationInstanceId: INSTANCE_ID,
    actionKey: 'review_bills',
  });
  client.financialChangeUi({ changeId: 12, causedReload: false, causedPageWideLoading: true });
}

describe('closed payload shape', () => {
  it('sends each event with exactly the server schema fields, to the events endpoint, with the session token', async () => {
    const { client, fetchMock } = setup();
    sendEveryEvent(client);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const names = fetchMock.mock.calls.map((_, index) => bodyOf(fetchMock, index).event);
    expect(names).toEqual([...MEASUREMENT_EVENT_NAMES]);

    fetchMock.mock.calls.forEach(([url, init], index) => {
      const body = bodyOf(fetchMock, index);
      const expected = SERVER_SCHEMA_FIELDS[String(body.event)] ?? [];
      expect(Object.keys(body).filter((key) => key !== 'event').sort()).toEqual([...expected].sort());
      expect(url).toBe(`https://api.example.test${MEASUREMENT_EVENTS_PATH}`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` });
      expect(body.occurredAt).toBe(NOW);
    });

    expect(bodyOf(fetchMock, 0)).toEqual({
      event: 'journey_started', journeyId: 7, desiredOutcome: 'plan_month', occurredAt: NOW,
    });
    expect(bodyOf(fetchMock, 3)).toEqual({
      event: 'recommended_action_completed',
      journeyId: 7,
      recommendationInstanceId: INSTANCE_ID,
      actionKey: 'review_bills',
      occurredAt: NOW,
    });
    expect(bodyOf(fetchMock, 4)).toEqual({
      event: 'financial_change_ui', changeId: 12, causedReload: false, causedPageWideLoading: true, occurredAt: NOW,
    });
  });

  it('covers every event name the server accepts', () => {
    expect([...MEASUREMENT_EVENT_NAMES].sort()).toEqual(Object.keys(SERVER_SCHEMA_FIELDS).sort());
  });

  it('never copies an extra, server-owned, or value-like field into a payload', () => {
    const extraKey = fc.constantFrom(...SERVER_OWNED_OR_VALUE_FIELDS);
    const extraValue = fc.oneof(
      fc.string(), fc.integer(), fc.double({ noNaN: true }), fc.boolean(),
      fc.constant(null), fc.array(fc.string()), fc.dictionary(fc.string(), fc.string()),
    );
    fc.assert(
      fc.property(fc.dictionary(extraKey, extraValue), fc.constantFrom(...MEASUREMENT_EVENT_NAMES), (extras, event) => {
        const valid: Record<string, Record<string, unknown>> = {
          journey_started: { journeyId: 3, desiredOutcome: 'fund_goal' },
          first_outcome_displayed: { journeyId: 3, outcomeKind: 'goal' },
          clarity_response: { journeyId: 3, response: 'yes' },
          recommended_action_completed: { journeyId: 3, recommendationInstanceId: INSTANCE_ID, actionKey: 'contribute_to_goal' },
          financial_change_ui: { changeId: 3, causedReload: true, causedPageWideLoading: false },
        };
        const input = { ...extras, ...valid[event] };
        const payload = buildEventPayload(event, input, NOW);
        expect(payload).not.toBeNull();
        expect(Object.keys(payload ?? {}).sort()).toEqual(['event', ...(SERVER_SCHEMA_FIELDS[event] ?? [])].sort());
      }),
      { numRuns: 100 },
    );
  });

  it('drops an event whose field has an unsupported value instead of sending it', async () => {
    const { client, fetchMock } = setup();
    const bad = (input: unknown) => (client.journeyStarted as (value: unknown) => void)(input);
    bad({ journeyId: 0, desiredOutcome: 'plan_month' });
    bad({ journeyId: 1.5, desiredOutcome: 'plan_month' });
    bad({ journeyId: '7', desiredOutcome: 'plan_month' });
    bad({ journeyId: 7, desiredOutcome: 'buy_a_house' });
    bad({ journeyId: 7 });
    bad(null);
    (client.recommendedActionCompleted as (value: unknown) => void)({
      journeyId: 7, recommendationInstanceId: 'Review the ₹40,000 rent', actionKey: 'review_bills',
    });
    (client.recommendedActionCompleted as (value: unknown) => void)({
      journeyId: 7, recommendationInstanceId: INSTANCE_ID, actionKey: 'Review monthly bills',
    });
    (client.financialChangeUi as (value: unknown) => void)({ changeId: 4, causedReload: 'false', causedPageWideLoading: 0 });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.queuedCount()).toBe(0);
  });

  it('keeps the enum lists aligned with the server schema', () => {
    expect([...DESIRED_OUTCOMES]).toEqual(['plan_month', 'control_spending', 'fund_goal', 'settle_trip']);
    expect([...MEASUREMENT_OUTCOME_KINDS]).toEqual(['monthly_plan', 'spending', 'goal', 'trip_summary', 'trip']);
    expect([...CLARITY_RESPONSES]).toEqual(['yes', 'partly', 'no']);
    expect([...MEASUREMENT_ACTION_KEYS]).toEqual([
      'review_bills',
      'address_needs_budget_excess',
      'address_wants_budget_excess',
      'revise_goal_target',
      'contribute_to_goal',
      'settle_trip_balance',
    ]);
  });
});

describe('types make extra and value-like fields unrepresentable', () => {
  it('accepts only the closed input shapes', () => {
    const { client } = setup({ consent: false });

    client.journeyStarted({ journeyId: 1, desiredOutcome: 'settle_trip' });
    client.financialChangeUi({ changeId: 1, causedReload: false, causedPageWideLoading: false });

    // @ts-expect-error amount is not a field of any event
    client.journeyStarted({ journeyId: 1, desiredOutcome: 'plan_month', amount: 1200 });
    // @ts-expect-error a name is not a field of any event
    client.firstOutcomeDisplayed({ journeyId: 1, outcomeKind: 'trip', tripName: 'Goa' });
    // @ts-expect-error free text is not a field of any event
    client.clarityResponse({ journeyId: 1, response: 'yes', note: 'because rent is high' });
    // @ts-expect-error a client-chosen timestamp is not a field; the client stamps it
    client.financialChangeUi({ changeId: 1, causedReload: false, causedPageWideLoading: false, occurredAt: NOW });
    // @ts-expect-error server-owned fields cannot be sent
    client.journeyStarted({ journeyId: 1, desiredOutcome: 'plan_month', userId: 5 });

    const wider = { journeyId: 1, response: 'yes' as const, localDate: '2026-01-15' };
    // @ts-expect-error a variable with an extra property is rejected too
    client.clarityResponse(wider);

    // @ts-expect-error outcome must be one of the fixed journey outcomes
    client.journeyStarted({ journeyId: 1, desiredOutcome: 'save_money' });
    // @ts-expect-error response must be Yes, Partly, or No
    client.clarityResponse({ journeyId: 1, response: 'maybe' });
    // @ts-expect-error action key must be a fixed key, not a label
    client.recommendedActionCompleted({ journeyId: 1, recommendationInstanceId: INSTANCE_ID, actionKey: 'Review monthly bills' });
    // @ts-expect-error a flag cannot be a number or text
    client.financialChangeUi({ changeId: 1, causedReload: 'no', causedPageWideLoading: 0 });
    // @ts-expect-error required fields cannot be omitted
    client.firstOutcomeDisplayed({ journeyId: 1 });
  });

  it('exposes one function per event with no return value to wait on', () => {
    expectTypeOf<MeasurementClient['journeyStarted']>().returns.toEqualTypeOf<void>();
    expectTypeOf<MeasurementClient['financialChangeUi']>().returns.toEqualTypeOf<void>();
    expectTypeOf<FinancialChangeUiInput>().toEqualTypeOf<{
      readonly changeId: number;
      readonly causedReload: boolean;
      readonly causedPageWideLoading: boolean;
    }>();
  });

  it('limits payload keys to the server schema', () => {
    type Payload<E extends ProductMeasurementEventPayload['event']> = Extract<ProductMeasurementEventPayload, { event: E }>;
    expectTypeOf<keyof Payload<'journey_started'>>().toEqualTypeOf<'event' | 'journeyId' | 'desiredOutcome' | 'occurredAt'>();
    expectTypeOf<keyof Payload<'clarity_response'>>().toEqualTypeOf<'event' | 'journeyId' | 'response' | 'occurredAt'>();
    expectTypeOf<keyof Payload<'recommended_action_completed'>>().toEqualTypeOf<
      'event' | 'journeyId' | 'recommendationInstanceId' | 'actionKey' | 'occurredAt'
    >();
    expectTypeOf<keyof Payload<'financial_change_ui'>>().toEqualTypeOf<
      'event' | 'changeId' | 'causedReload' | 'causedPageWideLoading' | 'occurredAt'
    >();
  });
});

describe('consent and rollout gates', () => {
  it('sends nothing while analytics is disabled', async () => {
    const { client, fetchMock } = setup({ consent: false });
    sendEveryEvent(client);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.queuedCount()).toBe(0);
  });

  it('sends nothing when the rollout flag is off, even with analytics enabled', async () => {
    const { client, fetchMock } = setup({ isRolloutEnabled: () => false });
    sendEveryEvent(client);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing without a session token or while offline', async () => {
    const signedOut = setup({ getToken: () => null });
    sendEveryEvent(signedOut.client);
    const offline = setup({ isOnline: () => false });
    sendEveryEvent(offline.client);
    await flush();
    expect(signedOut.fetchMock).not.toHaveBeenCalled();
    expect(offline.fetchMock).not.toHaveBeenCalled();
    expect(offline.client.queuedCount()).toBe(0);
  });

  it('reads consent only from confirmed settings', () => {
    expect(analyticsConsentFromSettings(null)).toBe(false);
    expect(analyticsConsentFromSettings(buildSettings({ analyticsEnabled: false }))).toBe(false);
    expect(analyticsConsentFromSettings(buildSettings({ analyticsEnabled: true }))).toBe(true);
    const unavailable = buildSettings({ analyticsEnabled: true });
    unavailable.productAnalytics.available = false;
    expect(analyticsConsentFromSettings(unavailable)).toBe(false);
    const noVersion = buildSettings({ analyticsEnabled: true });
    noVersion.productAnalytics.consentVersion = null;
    expect(analyticsConsentFromSettings(noVersion)).toBe(false);
  });

  it('notifies subscribers only when the consent value changes', () => {
    const { client } = setup({ consent: false });
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    client.setAnalyticsConsent(true);
    client.setAnalyticsConsent(true);
    client.setAnalyticsConsent(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    client.setAnalyticsConsent(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('opt-out and failure handling', () => {
  function pendingFetch() {
    const signals: AbortSignal[] = [];
    const fetchMock: FetchMock = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    return { fetchMock, signals };
  }

  it('opt-out aborts the request in flight and drops the queued events', async () => {
    const { fetchMock, signals } = pendingFetch();
    const { client } = setup({ getFetch: () => fetchMock });
    client.journeyStarted({ journeyId: 7, desiredOutcome: 'plan_month' });
    client.firstOutcomeDisplayed({ journeyId: 7, outcomeKind: 'monthly_plan' });
    client.clarityResponse({ journeyId: 7, response: 'yes' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.queuedCount()).toBe(2);

    client.setAnalyticsConsent(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(client.queuedCount()).toBe(0);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Turning analytics back on does not replay anything from before the opt-out.
    client.setAnalyticsConsent(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.queuedCount()).toBe(0);
  });

  it('events emitted after an opt-out are not sent', async () => {
    const { client, fetchMock } = setup();
    client.setAnalyticsConsent(false);
    sendEveryEvent(client);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends queued events in order, one at a time', async () => {
    const releases: Array<() => void> = [];
    const fetchMock: FetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve(respond()));
    }));
    const { client } = setup({ getFetch: () => fetchMock });
    client.journeyStarted({ journeyId: 7, desiredOutcome: 'plan_month' });
    client.firstOutcomeDisplayed({ journeyId: 7, outcomeKind: 'monthly_plan' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock, 0).event).toBe('journey_started');
    expect(bodyOf(fetchMock, 1).event).toBe('first_outcome_displayed');
    releases[1]?.();
    await flush();
    expect(client.queuedCount()).toBe(0);
  });

  it.each([
    ['accepted or disabled by the server (204)', () => respond(204)],
    ['rejected by the server (400)', () => respond(400)],
    ['rejected by the server (404)', () => respond(404)],
    ['a server error (500)', () => respond(500)],
    ['a network failure', () => { throw new TypeError('Failed to fetch'); }],
  ])('does not retry an event that ended as %s', async (_label, outcome) => {
    const fetchMock: FetchMock = vi.fn<typeof fetch>(async () => outcome());
    const { client } = setup({ getFetch: () => fetchMock });
    client.clarityResponse({ journeyId: 7, response: 'no' });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.queuedCount()).toBe(0);
  });

  it('never throws into the caller, even when fetch throws synchronously', async () => {
    const fetchMock: FetchMock = vi.fn<typeof fetch>(() => { throw new Error('boom'); });
    const { client } = setup({ getFetch: () => fetchMock });
    expect(() => sendEveryEvent(client)).not.toThrow();
    await flush();
    expect(client.queuedCount()).toBe(0);
  });

  it('bounds the in-memory queue and persists nothing', async () => {
    const { fetchMock } = pendingFetch();
    const { client } = setup({ getFetch: () => fetchMock });
    for (let i = 0; i < MAX_QUEUED_EVENTS + 10; i += 1) client.clarityResponse({ journeyId: 7, response: 'yes' });
    expect(client.queuedCount()).toBe(MAX_QUEUED_EVENTS);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    client.setAnalyticsConsent(false);
  });
});

describe('visit beacon', () => {
  const visitBody = (fetchMock: FetchMock) => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as unknown;

  it('sends exactly { route } and the token for a consenting signed-in user', () => {
    const { client, fetchMock } = setup();
    expect(client.trackVisit('plan')).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/api/track');
    expect(visitBody(fetchMock)).toEqual({ route: 'plan' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('does not report a signed-in visit without confirmed consent or with the rollout flag off', () => {
    const noConsent = setup({ consent: false });
    expect(noConsent.client.trackVisit('plan')).toBe(false);
    expect(noConsent.client.trackVisit('privacy')).toBe(false);
    const flagOff = setup({ isRolloutEnabled: () => false });
    expect(flagOff.client.trackVisit('plan')).toBe(false);
    expect(noConsent.fetchMock).not.toHaveBeenCalled();
    expect(flagOff.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps anonymous public-route tracking, without a token, regardless of consent or the flag', () => {
    const { client, fetchMock } = setup({ getToken: () => null, consent: false, isRolloutEnabled: () => false });
    expect(client.trackVisit('login')).toBe(true);
    expect(client.trackVisit('public_trip_share')).toBe(true);
    expect(visitBody(fetchMock)).toEqual({ route: 'login' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('never reports a signed-in route for a signed-out visitor', () => {
    const { client, fetchMock } = setup({ getToken: () => null });
    expect(client.trackVisit('home')).toBe(false);
    expect(client.trackVisit('admin_users')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opt-out aborts a visit beacon that is still in flight', () => {
    const signals: AbortSignal[] = [];
    const fetchMock: FetchMock = vi.fn<typeof fetch>((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    const { client } = setup({ getFetch: () => fetchMock });
    client.trackVisit('goals');
    client.setAnalyticsConsent(false);
    expect(signals[0]?.aborted).toBe(true);
  });
});
