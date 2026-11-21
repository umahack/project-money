import { FINANCIAL_CLARITY_TIME_ZONE } from '../domain/monthlyPlan.js';
import journeyRepository, { JOURNEY_DEFINITIONS } from '../repositories/journeyRepository.js';
import measurementRepository from '../repositories/measurementRepository.js';
import claritySettingsService, { ClaritySettingsError } from './claritySettings.js';

export const DESIRED_OUTCOMES = Object.freeze(Object.keys(JOURNEY_DEFINITIONS));
export const OUTCOME_KINDS = Object.freeze([
  'monthly_plan',
  'spending',
  'goal',
  'trip_summary',
  'trip',
]);
export const CLARITY_RESPONSES = Object.freeze(['yes', 'partly', 'no']);
export const ACTION_KEYS = Object.freeze([
  'review_bills',
  'address_needs_budget_excess',
  'address_wants_budget_excess',
  'revise_goal_target',
  'contribute_to_goal',
  'settle_trip_balance',
]);

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLITE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const isBoolean = (value) => typeof value === 'boolean';
const oneOf = (allowed) => (value) => typeof value === 'string' && allowed.includes(value);
const isInstant = (value) => typeof value === 'string'
  && value.length <= 24
  && INSTANT_PATTERN.test(value)
  && !Number.isNaN(Date.parse(value));
const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

/**
 * Closed schemas. Every field is required, has a fixed primitive type or enum,
 * and no free-text, numeric-amount, name, URL, or metadata field exists. A
 * value that is not an exact enum, UUID, boolean, positive ID, or instant is
 * rejected, so financial values and typed text cannot pass through a field.
 */
const EVENT_SCHEMAS = Object.freeze({
  journey_started: Object.freeze({
    journeyId: positiveId,
    desiredOutcome: oneOf(DESIRED_OUTCOMES),
    occurredAt: isInstant,
  }),
  first_outcome_displayed: Object.freeze({
    journeyId: positiveId,
    outcomeKind: oneOf(OUTCOME_KINDS),
    occurredAt: isInstant,
  }),
  clarity_response: Object.freeze({
    journeyId: positiveId,
    response: oneOf(CLARITY_RESPONSES),
    occurredAt: isInstant,
  }),
  recommended_action_completed: Object.freeze({
    journeyId: positiveId,
    recommendationInstanceId: isUuid,
    actionKey: oneOf(ACTION_KEYS),
    occurredAt: isInstant,
  }),
  financial_change_ui: Object.freeze({
    changeId: positiveId,
    causedReload: isBoolean,
    causedPageWideLoading: isBoolean,
    occurredAt: isInstant,
  }),
});

export const MEASUREMENT_EVENT_NAMES = Object.freeze(Object.keys(EVENT_SCHEMAS));

export class MeasurementError extends Error {
  constructor({ code, message, httpStatus, field }) {
    super(message);
    this.name = 'MeasurementError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (field !== undefined) this.field = field;
  }
}

function invalid(code, message, field) {
  return new MeasurementError({ code, message, httpStatus: 400, field });
}

/**
 * Validate one client event against its closed schema and return a new object
 * that contains only schema fields. Error details never echo client values or
 * unknown key names.
 */
export function validateMeasurementEvent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('INVALID_EVENT', 'Event must be a JSON object.');
  }

  const eventName = Object.hasOwn(input, 'event') ? input.event : undefined;
  if (typeof eventName !== 'string' || !Object.hasOwn(EVENT_SCHEMAS, eventName)) {
    throw invalid('UNKNOWN_EVENT', 'event must be one of the supported event names.', 'event');
  }

  const schema = EVENT_SCHEMAS[eventName];
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'event' && !Object.hasOwn(schema, key))) {
    throw invalid('UNKNOWN_EVENT_FIELD', 'Event contains a field that is not accepted.');
  }

  const normalized = { event: eventName };
  for (const [field, isValid] of Object.entries(schema)) {
    if (!Object.hasOwn(input, field)) {
      throw invalid('MISSING_EVENT_FIELD', 'Event is missing a required field.', field);
    }
    const value = input[field];
    if (value !== null && typeof value === 'object') {
      throw invalid('NESTED_EVENT_FIELD', 'Event fields must be single fixed values.', field);
    }
    if (!isValid(value)) {
      throw invalid('INVALID_EVENT_FIELD', 'Event field has an unsupported value.', field);
    }
    normalized[field] = field === 'recommendationInstanceId' ? value.toLowerCase() : value;
  }
  return normalized;
}

function toIsoInstant(value) {
  const normalized = SQLITE_TIMESTAMP_PATTERN.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const time = new Date(normalized);
  if (Number.isNaN(time.getTime())) throw new RangeError('Stored timestamp is invalid.');
  return time.toISOString();
}

/** Local calendar date and Monday-start week for an instant, in the configured zone. */
export function localPeriodFor(instant, timeZone = FINANCIAL_CLARITY_TIME_ZONE) {
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
  const [year, month, day] = localDate.split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (calendarDay.getUTCDay() + 6) % 7;
  const weekStart = new Date(calendarDay.getTime() - daysSinceMonday * 86_400_000);
  return { localDate, localWeekStart: weekStart.toISOString().slice(0, 10) };
}

/**
 * The client timestamp never grants access. It only refines the stored time,
 * bounded to the window from the associated server record to server receipt.
 */
function boundOccurredAt(clientInstant, windowStart, receivedAt) {
  const upper = Date.parse(receivedAt);
  const lower = Math.min(Date.parse(windowStart), upper);
  const bounded = Math.min(Math.max(Date.parse(clientInstant), lower), upper);
  return new Date(bounded).toISOString();
}

function notFound() {
  return new MeasurementError({
    code: 'MEASUREMENT_REFERENCE_NOT_FOUND',
    message: 'The referenced record was not found.',
    httpStatus: 404,
  });
}

function referenceMismatch(field) {
  return new MeasurementError({
    code: 'MEASUREMENT_REFERENCE_MISMATCH',
    message: 'The event does not match the referenced record.',
    httpStatus: 422,
    field,
  });
}

export class MeasurementService {
  #repository;
  #journeys;
  #consent;
  #clock;
  #timeZone;

  constructor({
    repository = measurementRepository,
    journeys = journeyRepository,
    consent = claritySettingsService,
    clock = () => new Date(),
    timeZone = FINANCIAL_CLARITY_TIME_ZONE,
  } = {}) {
    if (!repository
      || typeof repository.recordConsentedEvent !== 'function'
      || typeof repository.getOwnedChangeReceipt !== 'function') {
      throw new TypeError('A measurement repository with event methods is required.');
    }
    if (!journeys || typeof journeys.getById !== 'function') {
      throw new TypeError('A journey repository with getById() is required.');
    }
    if (!consent || typeof consent.getAnalyticsConsent !== 'function') {
      throw new TypeError('A consent reader with getAnalyticsConsent() is required.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    if (timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
      throw new RangeError(`timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
    }
    this.#repository = repository;
    this.#journeys = journeys;
    this.#consent = consent;
    this.#clock = clock;
    this.#timeZone = timeZone;
  }

  async #analyticsEnabled(userId) {
    try {
      const consent = await this.#consent.getAnalyticsConsent({ userId });
      return consent.enabled === true && consent.consentVersion != null;
    } catch (error) {
      // A deleted account has no consent and must not receive events.
      if (error instanceof ClaritySettingsError && error.code === 'SETTINGS_NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Validate and record one event for the authenticated user and session.
   * Disabled analytics, retries after opt-out, and events from a session that
   * did not start the journey are accepted as no-ops. The final insert checks
   * consent again, so consent at receipt time decides the outcome.
   *
   * @returns {Promise<{ recorded: boolean, reason: string }>}
   */
  async ingest({ userId, sessionId, input }) {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new TypeError('userId must be a positive safe integer.');
    }
    const event = validateMeasurementEvent(input);

    if (!(await this.#analyticsEnabled(userId))) {
      return { recorded: false, reason: 'analytics_disabled' };
    }

    const receivedAt = this.#clock().toISOString();
    const fields = { eventName: event.event };
    let eventKey;
    let windowStart;

    if (event.event === 'financial_change_ui') {
      const receipt = await this.#repository.getOwnedChangeReceipt({
        userId,
        changeId: event.changeId,
      });
      if (!receipt) throw notFound();
      windowStart = toIsoInstant(receipt.occurredAt);
      fields.changeId = event.changeId;
      fields.causedReload = event.causedReload;
      fields.causedPageWideLoading = event.causedPageWideLoading;
      eventKey = `${userId}:${event.changeId}`;
    } else {
      const journey = await this.#journeys.getById({ userId, journeyId: event.journeyId });
      if (!journey) throw notFound();
      windowStart = toIsoInstant(journey.startedAt);
      fields.journeyId = journey.id;
      eventKey = `${userId}:${journey.id}`;

      if (event.event === 'journey_started' || event.event === 'first_outcome_displayed') {
        // Start and first-outcome events count only for the starting session.
        if (journey.startedSessionId == null || journey.startedSessionId !== sessionId) {
          return { recorded: false, reason: 'not_starting_session' };
        }
      }

      if (event.event === 'journey_started') {
        if (event.desiredOutcome !== journey.desiredOutcome) {
          throw referenceMismatch('desiredOutcome');
        }
        fields.desiredOutcome = event.desiredOutcome;
      } else if (event.event === 'first_outcome_displayed') {
        fields.outcomeKind = event.outcomeKind;
      } else if (event.event === 'clarity_response') {
        fields.response = event.response;
      } else {
        fields.actionKey = event.actionKey;
        fields.recommendationInstanceId = event.recommendationInstanceId;
        eventKey = `${eventKey}:${event.recommendationInstanceId}`;
      }
    }

    const occurredAt = boundOccurredAt(event.occurredAt, windowStart, receivedAt);
    const recorded = await this.#repository.recordConsentedEvent({
      ...fields,
      eventId: `${event.event}:${eventKey}`,
      userId,
      occurredAt,
      receivedAt,
      ...localPeriodFor(occurredAt, this.#timeZone),
    });
    return recorded
      ? { recorded: true, reason: 'recorded' }
      : { recorded: false, reason: 'not_recorded' };
  }
}

const measurementService = new MeasurementService();
export default measurementService;
