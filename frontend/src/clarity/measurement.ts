// Typed Product Analytics client for `POST /api/clarity/events` and the visit
// beacon (`POST /api/track`). It mirrors the backend's closed event schemas
// (`backend/src/services/measurementService.js`).
//
// Rules this module enforces:
// - Events are sent only while the confirmed Product Analytics setting is on
//   and the VITE_FINANCIAL_CLARITY_ENABLED rollout flag is on.
// - Every event function takes only the fields of its closed schema. Extra
//   fields are a type error and are never copied at runtime. No field can carry
//   an amount, name, note, URL, or other free text.
// - The client never sends user, session, consent, local-period, or receipt
//   fields. The server supplies them from the authenticated session. The
//   client supplies only `occurredAt`, taken from its own clock.
// - Sending is fire-and-forget. It never throws, never awaits in the caller,
//   and never changes the UI.
// - The queue is in memory only. Failed, offline, rejected (4xx), and
//   disabled-by-server (204) events are dropped and never retried.
// - Opting out clears the queue and aborts requests that are in flight.
import { getToken } from '../api';
import { readClientFeatureFlags } from './rollout';
import type { ClaritySettings } from './settings';
import { isPublicVisitRoute, type VisitRoute } from './visitRoutes';

export const MEASUREMENT_EVENTS_PATH = '/api/clarity/events';
export const VISIT_TRACK_PATH = '/api/track';

/** Largest number of events waiting to be sent. Further events are dropped. */
export const MAX_QUEUED_EVENTS = 20;

export const DESIRED_OUTCOMES = ['plan_month', 'control_spending', 'fund_goal', 'settle_trip'] as const;
export const MEASUREMENT_OUTCOME_KINDS = [
  'monthly_plan',
  'spending',
  'goal',
  'trip_summary',
  'trip',
] as const;
export const CLARITY_RESPONSES = ['yes', 'partly', 'no'] as const;
/** Fixed in-product action keys. These are not labels, routes, or user text. */
export const MEASUREMENT_ACTION_KEYS = [
  'review_bills',
  'address_needs_budget_excess',
  'address_wants_budget_excess',
  'revise_goal_target',
  'contribute_to_goal',
  'settle_trip_balance',
] as const;

export type MeasurementDesiredOutcome = (typeof DESIRED_OUTCOMES)[number];
export type MeasurementOutcomeKind = (typeof MEASUREMENT_OUTCOME_KINDS)[number];
export type ClarityResponse = (typeof CLARITY_RESPONSES)[number];
export type MeasurementActionKey = (typeof MEASUREMENT_ACTION_KEYS)[number];

// ---- Caller inputs. `occurredAt` is stamped here, so callers never pass it. ----

export interface JourneyStartedInput {
  readonly journeyId: number;
  readonly desiredOutcome: MeasurementDesiredOutcome;
}
export interface FirstOutcomeDisplayedInput {
  readonly journeyId: number;
  readonly outcomeKind: MeasurementOutcomeKind;
}
export interface ClarityResponseInput {
  readonly journeyId: number;
  readonly response: ClarityResponse;
}
export interface RecommendedActionCompletedInput {
  readonly journeyId: number;
  /** Opaque UUID of the recommendation instance. Never an action label or route. */
  readonly recommendationInstanceId: string;
  readonly actionKey: MeasurementActionKey;
}
export interface FinancialChangeUiInput {
  /** Id of the confirmed change receipt. Never the changed value. */
  readonly changeId: number;
  readonly causedReload: boolean;
  readonly causedPageWideLoading: boolean;
}

/**
 * Rejects any key that is not part of `Shape`. An object literal with an extra
 * property, or a variable whose type has one, no longer type-checks.
 */
export type Exact<Shape, Actual extends Shape> = Actual
  & Record<Exclude<keyof Actual, keyof Shape>, never>;

// ---- Wire payloads. These are the only shapes this module ever sends. ----

export type ProductMeasurementEventPayload =
  | (Readonly<JourneyStartedInput> & { readonly event: 'journey_started'; readonly occurredAt: string })
  | (Readonly<FirstOutcomeDisplayedInput> & { readonly event: 'first_outcome_displayed'; readonly occurredAt: string })
  | (Readonly<ClarityResponseInput> & { readonly event: 'clarity_response'; readonly occurredAt: string })
  | (Readonly<RecommendedActionCompletedInput> & { readonly event: 'recommended_action_completed'; readonly occurredAt: string })
  | (Readonly<FinancialChangeUiInput> & { readonly event: 'financial_change_ui'; readonly occurredAt: string });

export type ProductMeasurementEventName = ProductMeasurementEventPayload['event'];

export const MEASUREMENT_EVENT_NAMES = [
  'journey_started',
  'first_outcome_displayed',
  'clarity_response',
  'recommended_action_completed',
  'financial_change_ui',
] as const satisfies readonly ProductMeasurementEventName[];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPositiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const oneOf = <T extends string>(allowed: readonly T[]) => (value: unknown): value is T => (
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
);
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

type FieldChecks<T> = { [K in keyof T]-?: (value: unknown) => boolean };

/** One validator per schema field. A payload has exactly these fields plus `event` and `occurredAt`. */
const FIELD_CHECKS: {
  [E in ProductMeasurementEventName]: FieldChecks<
    Omit<Extract<ProductMeasurementEventPayload, { event: E }>, 'event' | 'occurredAt'>
  >;
} = {
  journey_started: { journeyId: isPositiveId, desiredOutcome: oneOf(DESIRED_OUTCOMES) },
  first_outcome_displayed: { journeyId: isPositiveId, outcomeKind: oneOf(MEASUREMENT_OUTCOME_KINDS) },
  clarity_response: { journeyId: isPositiveId, response: oneOf(CLARITY_RESPONSES) },
  recommended_action_completed: {
    journeyId: isPositiveId,
    recommendationInstanceId: isUuid,
    actionKey: oneOf(MEASUREMENT_ACTION_KEYS),
  },
  financial_change_ui: { changeId: isPositiveId, causedReload: isBoolean, causedPageWideLoading: isBoolean },
};

/**
 * Builds the wire payload from only the schema fields of `event`, or returns
 * null when a field is missing or has an unsupported value. Extra properties
 * on `input` are ignored, so they can never reach the network.
 */
export function buildEventPayload(
  event: ProductMeasurementEventName,
  input: unknown,
  occurredAt: string,
): ProductMeasurementEventPayload | null {
  if (!Object.hasOwn(FIELD_CHECKS, event) || input === null || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const checks = FIELD_CHECKS[event] as Record<string, (value: unknown) => boolean>;
  const payload: Record<string, unknown> = { event };
  for (const [field, isValid] of Object.entries(checks)) {
    const value = Object.hasOwn(source, field) ? source[field] : undefined;
    if (!isValid(value)) return null;
    payload[field] = value;
  }
  payload.occurredAt = occurredAt;
  return payload as unknown as ProductMeasurementEventPayload;
}

/** True only when the confirmed settings say Product Analytics is available and on. */
export function analyticsConsentFromSettings(settings: ClaritySettings | null | undefined): boolean {
  const analytics = settings?.productAnalytics;
  return !!analytics && analytics.available && analytics.enabled && analytics.consentVersion !== null;
}

export interface MeasurementClientOptions {
  /** Defaults to the VITE_FINANCIAL_CLARITY_ENABLED rollout flag, read at send time. */
  isRolloutEnabled?: () => boolean;
  getToken?: () => string | null;
  getFetch?: () => typeof fetch;
  isOnline?: () => boolean;
  now?: () => Date;
  apiBase?: () => string;
}

export interface MeasurementClient {
  /** The user starts a Guided_Journey. Call once per started journey. */
  journeyStarted<T extends JourneyStartedInput>(input: Exact<JourneyStartedInput, T>): void;
  /** A First_Meaningful_Outcome was displayed during the starting journey session. */
  firstOutcomeDisplayed<T extends FirstOutcomeDisplayedInput>(input: Exact<FirstOutcomeDisplayedInput, T>): void;
  /** The user submitted Yes, Partly, or No. Never call this for Skip. */
  clarityResponse<T extends ClarityResponseInput>(input: Exact<ClarityResponseInput, T>): void;
  /** The user completed an in-product action linked from an Actionable_Insight. */
  recommendedActionCompleted<T extends RecommendedActionCompletedInput>(
    input: Exact<RecommendedActionCompletedInput, T>,
  ): void;
  /** Reports whether a confirmed Financial_Record_Change reloaded the page or showed a page-wide loader. */
  financialChangeUi<T extends FinancialChangeUiInput>(input: Exact<FinancialChangeUiInput, T>): void;
  /**
   * Sends one visit beacon `{ route }`. Signed-in visits need confirmed
   * Product Analytics consent. Signed-out visits send public routes only.
   * Returns whether a request was started.
   */
  trackVisit(route: VisitRoute): boolean;
  /** Applies the confirmed Product Analytics setting. `false` clears the queue and aborts in-flight sends. */
  setAnalyticsConsent(enabled: boolean): void;
  getAnalyticsConsent(): boolean;
  subscribe(listener: () => void): () => void;
  /** Number of events waiting to be sent. Used by tests. */
  queuedCount(): number;
}

export function createMeasurementClient(options: MeasurementClientOptions = {}): MeasurementClient {
  const isRolloutEnabled = options.isRolloutEnabled ?? (() => readClientFeatureFlags().financialClarityEnabled);
  const readToken = options.getToken ?? getToken;
  const readFetch = options.getFetch ?? (() => globalThis.fetch);
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const now = options.now ?? (() => new Date());
  const apiBase = options.apiBase
    ?? (() => ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, ''));

  let consent = false;
  let draining = false;
  const queue: string[] = [];
  const inFlight = new Set<AbortController>();
  const listeners = new Set<() => void>();

  const canSendEvents = () => consent && isRolloutEnabled();

  /** Starts one request, tracks it so an opt-out can abort it, and swallows every outcome. */
  async function post(path: string, body: string, token: string | null): Promise<void> {
    const controller = new AbortController();
    inFlight.add(controller);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      // The response is ignored. 204, 4xx, 5xx, and network failures all end here without a retry.
      await readFetch()(`${apiBase()}${path}`, {
        method: 'POST',
        headers,
        body,
        keepalive: true,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      // Dropped on purpose.
    } finally {
      inFlight.delete(controller);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const body = queue.shift() as string;
        const token = readToken();
        // Re-check the gate for every event, so an opt-out wins over anything queued earlier.
        if (!token || !canSendEvents() || !isOnline()) {
          queue.length = 0;
          break;
        }
        await post(MEASUREMENT_EVENTS_PATH, body, token);
      }
    } finally {
      draining = false;
    }
  }

  function emit(event: ProductMeasurementEventName, input: unknown): void {
    try {
      if (!canSendEvents() || !readToken() || !isOnline()) return;
      if (queue.length >= MAX_QUEUED_EVENTS) return;
      const payload = buildEventPayload(event, input, now().toISOString());
      if (!payload) return;
      queue.push(JSON.stringify(payload));
      void drain();
    } catch {
      // Measurement must never surface an error to the UI.
    }
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A faulty listener must not affect consent handling.
      }
    }
  };

  return {
    journeyStarted: (input) => emit('journey_started', input),
    firstOutcomeDisplayed: (input) => emit('first_outcome_displayed', input),
    clarityResponse: (input) => emit('clarity_response', input),
    recommendedActionCompleted: (input) => emit('recommended_action_completed', input),
    financialChangeUi: (input) => emit('financial_change_ui', input),

    trackVisit(route) {
      try {
        const token = readToken();
        if (token) {
          if (!canSendEvents() || !isOnline()) return false;
        } else if (!isPublicVisitRoute(route) || !isOnline()) {
          return false;
        }
        void post(VISIT_TRACK_PATH, JSON.stringify({ route }), token);
        return true;
      } catch {
        return false;
      }
    },

    setAnalyticsConsent(enabled) {
      const next = enabled === true;
      if (!next) {
        // Opt-out takes effect before anything else: nothing queued is sent and nothing in flight continues.
        queue.length = 0;
        for (const controller of [...inFlight]) controller.abort();
        inFlight.clear();
      }
      if (next === consent) return;
      consent = next;
      notify();
    },
    getAnalyticsConsent: () => consent,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    queuedCount: () => queue.length,
  };
}

/** Application-wide client. Pages reach it through `useMeasurement()`. */
export const measurement: MeasurementClient = createMeasurementClient();
