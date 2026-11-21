import { FINANCIAL_CLARITY_TIME_ZONE } from '../domain/monthlyPlan.js';
import {
  STEP_REGISTRY,
  buildJourneyFacts,
  planJourney,
} from '../domain/journeyPlan.js';
import financialRepository from '../repositories/financialRepository.js';
import journeyRepository, { JOURNEY_DEFINITIONS } from '../repositories/journeyRepository.js';
import claritySettingsService, { ClaritySettingsError } from './claritySettings.js';

export const JOURNEY_SCHEMA_VERSION = 1;
export const JOURNEY_ACTIONS = Object.freeze([
  'complete_step',
  'skip_step',
  'pause',
  'resume',
  'complete',
]);

const START_FIELDS = Object.freeze(['desiredOutcome']);
const COMMAND_FIELDS = Object.freeze({
  complete_step: Object.freeze(['action', 'stepKey', 'changeId']),
  skip_step: Object.freeze(['action', 'stepKey']),
  pause: Object.freeze(['action']),
  resume: Object.freeze(['action']),
  complete: Object.freeze(['action']),
});
const MAX_CANDIDATE_TRIPS = 10;

export class JourneyError extends Error {
  constructor({ code, message, httpStatus, details = {} }) {
    super(message);
    this.name = 'JourneyError';
    this.code = code;
    this.httpStatus = httpStatus;
    Object.assign(this, details);
  }
}

function journeyError(code, message, httpStatus, details = {}) {
  return new JourneyError({ code, message, httpStatus, details });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(body, allowedFields) {
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) {
      throw journeyError(
        'UNKNOWN_JOURNEY_FIELD',
        'The journey request contains a field that is not accepted. Steps and records are defined by the server.',
        400,
        { field: key, allowedFields: [...allowedFields] }
      );
    }
  }
}

/** Validate a start request. Only the four fixed desired outcomes are accepted. */
export function parseStartCommand(body) {
  if (!isPlainObject(body)) {
    throw journeyError('INVALID_JOURNEY_BODY', 'Journey request must be a JSON object.', 400);
  }
  rejectUnknownFields(body, START_FIELDS);
  const { desiredOutcome } = body;
  if (typeof desiredOutcome !== 'string' || !Object.hasOwn(JOURNEY_DEFINITIONS, desiredOutcome)) {
    throw journeyError(
      'INVALID_DESIRED_OUTCOME',
      'desiredOutcome must be one of the four fixed journey outcomes.',
      400,
      { field: 'desiredOutcome', allowedValues: Object.keys(JOURNEY_DEFINITIONS) }
    );
  }
  return { desiredOutcome };
}

/** Validate a transition request without consulting any journey or record. */
export function parseTransitionCommand(body) {
  if (!isPlainObject(body)) {
    throw journeyError('INVALID_JOURNEY_BODY', 'Journey request must be a JSON object.', 400);
  }
  const { action } = body;
  if (typeof action !== 'string' || !Object.hasOwn(COMMAND_FIELDS, action)) {
    throw journeyError(
      'INVALID_JOURNEY_ACTION',
      'action must be one of the fixed journey actions.',
      400,
      { field: 'action', allowedValues: [...JOURNEY_ACTIONS] }
    );
  }
  rejectUnknownFields(body, COMMAND_FIELDS[action]);

  const command = { action };
  if (action === 'complete_step' || action === 'skip_step') {
    if (typeof body.stepKey !== 'string' || !Object.hasOwn(STEP_REGISTRY, body.stepKey)) {
      throw journeyError(
        'INVALID_STEP_KEY',
        'stepKey must be a fixed journey step key.',
        400,
        { field: 'stepKey' }
      );
    }
    command.stepKey = body.stepKey;
  }
  if (action === 'complete_step' && body.changeId !== undefined) {
    if (!Number.isSafeInteger(body.changeId) || body.changeId <= 0) {
      throw journeyError(
        'INVALID_CHANGE_ID',
        'changeId must be a positive integer from a confirmed financial change.',
        400,
        { field: 'changeId' }
      );
    }
    command.changeId = body.changeId;
  }
  return command;
}

function localMonth(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FINANCIAL_CLARITY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((key) => right.includes(key));
}

function retryScope(journeyId, target) {
  return `journey:${journeyId}:${target}`;
}

export class JourneyService {
  #journeys;
  #financial;
  #consent;
  #clock;
  #locks = new Map();

  constructor({
    journeys = journeyRepository,
    financial = financialRepository,
    consent = claritySettingsService,
    clock = () => new Date(),
  } = {}) {
    for (const method of [
      'create',
      'getById',
      'getResumable',
      'saveProgress',
      'pause',
      'getOwnedChangeReceipt',
      'getLatestConfirmedChangeId',
      'listPersonalLinkTripIds',
    ]) {
      if (!journeys || typeof journeys[method] !== 'function') {
        throw new TypeError(`journeys.${method}() is required.`);
      }
    }
    for (const method of [
      'loadPeriod',
      'loadGoals',
      'listAccessibleTrips',
      'loadAccessibleTripLedger',
    ]) {
      if (!financial || typeof financial[method] !== 'function') {
        throw new TypeError(`financial.${method}() is required.`);
      }
    }
    if (!consent || typeof consent.getAnalyticsConsent !== 'function') {
      throw new TypeError('consent.getAnalyticsConsent() is required.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#journeys = journeys;
    this.#financial = financial;
    this.#consent = consent;
    this.#clock = clock;
  }

  /** Serialize one user's journey writes so a retry cannot interleave with its original. */
  async #serialize(userId, task) {
    const previous = this.#locks.get(userId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#locks.set(userId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#locks.get(userId) === tail) this.#locks.delete(userId);
    }
  }

  #now() {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('clock must return a valid Date.');
    }
    return now;
  }

  /** Load only the confirmed records the selected outcome can depend on. */
  async #loadFacts(userId, desiredOutcome, now) {
    const month = localMonth(now);
    if (desiredOutcome === 'settle_trip') {
      const trips = await this.#financial.listAccessibleTrips(userId);
      const tripLedgers = [];
      for (const trip of trips.records.slice(0, MAX_CANDIDATE_TRIPS)) {
        const ledger = await this.#financial.loadAccessibleTripLedger({
          userId,
          tripId: trip.id,
        });
        if (ledger) tripLedgers.push(ledger);
      }
      const personalLinkTripIds = await this.#journeys.listPersonalLinkTripIds(userId);
      return buildJourneyFacts({ month, tripLedgers, personalLinkTripIds });
    }
    const period = await this.#financial.loadPeriod({ userId, month });
    const goals = desiredOutcome === 'fund_goal'
      ? await this.#financial.loadGoals(userId)
      : null;
    return buildJourneyFacts({ month, period, goals });
  }

  async #plan(journey, now) {
    const facts = await this.#loadFacts(journey.userId, journey.desiredOutcome, now);
    return planJourney({
      desiredOutcome: journey.desiredOutcome,
      definition: JOURNEY_DEFINITIONS[journey.desiredOutcome],
      facts,
      storedCompletedStepKeys: journey.completedStepKeys,
    });
  }

  async #view(journey, plan) {
    const steps = [];
    for (const step of plan.steps) {
      const { recordRef, ...publicStep } = step;
      const confirmedChangeId = recordRef
        ? await this.#journeys.getLatestConfirmedChangeId({
          userId: journey.userId,
          recordType: recordRef.recordType,
          recordId: recordRef.recordId,
        })
        : null;
      steps.push({ ...publicStep, confirmedChangeId });
    }
    const completed = journey.status === 'completed';
    return {
      id: journey.id,
      desiredOutcome: journey.desiredOutcome,
      status: journey.status,
      startedAt: journey.startedAt,
      updatedAt: journey.updatedAt,
      completedAt: journey.completedAt,
      requiredStepKeys: plan.requiredStepKeys,
      optionalStepKeys: plan.optionalStepKeys,
      requiredCategories: plan.requiredCategories,
      currentStepKey: completed ? null : plan.currentStepKey,
      nextIncompleteStepKey: plan.nextIncompleteStepKey,
      completedRequiredStepKeys: plan.completedRequiredStepKeys,
      remainingRequiredStepKeys: plan.remainingRequiredStepKeys,
      progress: plan.progress,
      steps,
      firstOutcome: plan.firstOutcome,
      availableOutcomes: plan.firstOutcome.available
        ? [{ kind: plan.firstOutcome.kind, outcomeId: plan.firstOutcome.outcomeId }]
        : [],
      optionalOffered: plan.optionalOffered,
      nextChoice: completed ? null : plan.nextChoice,
      clarityConfirmation: {
        available: plan.firstOutcome.available && !completed,
        completed,
      },
    };
  }

  /**
   * Persist the union of stored and record-satisfied steps. Progress only grows:
   * the repository rejects any removal, and one UPDATE statement makes the write
   * atomic, so a failure leaves the previous progress untouched.
   */
  async #persist(journey, plan, { status = journey.status, extraStepKeys = [] } = {}) {
    const stepKeys = plan.completedStepKeysToPersist.slice();
    for (const key of extraStepKeys) if (!stepKeys.includes(key)) stepKeys.push(key);
    if (status === journey.status && sameSet(stepKeys, journey.completedStepKeys)) {
      return journey;
    }
    return this.#journeys.saveProgress({
      userId: journey.userId,
      journeyId: journey.id,
      completedStepKeys: stepKeys,
      status,
    });
  }

  async #requireJourney(userId, journeyId) {
    const journey = await this.#journeys.getById({ userId, journeyId });
    if (!journey) {
      throw journeyError('JOURNEY_NOT_FOUND', 'Journey was not found.', 404);
    }
    return journey;
  }

  #requireOpen(journey) {
    if (journey.status === 'completed' || journey.status === 'abandoned') {
      throw journeyError(
        'JOURNEY_NOT_ACTIVE',
        'This journey is no longer active.',
        409,
        { status: journey.status }
      );
    }
  }

  #requireActive(journey) {
    this.#requireOpen(journey);
    if (journey.status === 'paused') {
      throw journeyError(
        'JOURNEY_PAUSED',
        'Resume the journey before changing its steps.',
        409,
        { status: journey.status }
      );
    }
  }

  async getActive({ userId }) {
    const resumable = await this.#journeys.getResumable(userId);
    const journey = resumable.record;
    if (!journey) return null;
    const plan = await this.#plan(journey, this.#now());
    return this.#view(journey, plan);
  }

  async #analyticsEligibility(userId) {
    try {
      const consent = await this.#consent.getAnalyticsConsent({ userId });
      const eligible = consent.enabled === true && consent.consentVersion != null;
      return {
        measurementEligible: eligible,
        measurementConsentVersion: eligible ? consent.consentVersion : null,
      };
    } catch (error) {
      if (error instanceof ClaritySettingsError && error.code === 'SETTINGS_NOT_FOUND') {
        return { measurementEligible: false, measurementConsentVersion: null };
      }
      throw error;
    }
  }

  /**
   * Start one of the four fixed journeys. Records the starting session and
   * measurement eligibility, then skips ahead over steps current records
   * already satisfy. A repeated start for the same outcome returns the open
   * journey instead of creating a duplicate.
   *
   * @returns {Promise<{ journey: object, created: boolean }>}
   */
  async start({ userId, sessionId = null, body }) {
    const { desiredOutcome } = parseStartCommand(body);
    return this.#serialize(userId, async () => {
      const now = this.#now();
      const existing = (await this.#journeys.getResumable(userId)).record;
      if (existing) {
        if (existing.desiredOutcome !== desiredOutcome) {
          throw journeyError(
            'JOURNEY_ALREADY_ACTIVE',
            'Finish or pause the current journey before starting a different one.',
            409,
            {
              activeJourneyId: existing.id,
              activeDesiredOutcome: existing.desiredOutcome,
            }
          );
        }
        const plan = await this.#plan(existing, now);
        const synced = await this.#persist(existing, plan, { status: 'active' });
        return { journey: await this.#view(synced, plan), created: false };
      }

      const eligibility = await this.#analyticsEligibility(userId);
      const created = await this.#journeys.create({
        userId,
        desiredOutcome,
        startedSessionId: sessionId,
        ...eligibility,
      });
      const plan = await this.#plan(created, now);
      const synced = await this.#persist(created, plan);
      return { journey: await this.#view(synced, plan), created: true };
    });
  }

  /** Dispatch one validated transition command. */
  async apply({ userId, journeyId, body }) {
    const command = parseTransitionCommand(body);
    return this.#serialize(userId, async () => {
      const journey = await this.#requireJourney(userId, journeyId);
      const now = this.#now();
      switch (command.action) {
        case 'complete_step':
          return this.#completeStep(journey, command, now);
        case 'skip_step':
          return this.#skipStep(journey, command, now);
        case 'pause':
          return this.#pause(journey, now);
        case 'resume':
          return this.#resume(journey, now);
        default:
          return this.#complete(journey, now);
      }
    });
  }

  transition({ userId, journeyId, stepKey, changeId }) {
    return this.apply({
      userId,
      journeyId,
      body: { action: 'complete_step', stepKey, ...(changeId === undefined ? {} : { changeId }) },
    });
  }

  skipOptional({ userId, journeyId, stepKey }) {
    return this.apply({ userId, journeyId, body: { action: 'skip_step', stepKey } });
  }

  #assertStepBelongs(journey, stepKey) {
    const allowed = [...journey.requiredStepKeys, ...journey.optionalStepKeys];
    if (!allowed.includes(stepKey)) {
      throw journeyError(
        'INVALID_STEP_KEY',
        'stepKey is not a step of this journey.',
        400,
        { field: 'stepKey' }
      );
    }
  }

  async #assertConfirmedChange(userId, stepKey, changeId) {
    const receipt = await this.#journeys.getOwnedChangeReceipt({ userId, changeId });
    if (!receipt) {
      throw journeyError('CHANGE_NOT_FOUND', 'The financial change was not found.', 404, {
        field: 'changeId',
      });
    }
    if (receipt.status !== 'confirmed') {
      throw journeyError(
        'CHANGE_NOT_CONFIRMED',
        'The financial change is not a confirmed change.',
        422,
        { field: 'changeId' }
      );
    }
    if (!STEP_REGISTRY[stepKey].changeRecordTypes.includes(receipt.recordType)) {
      throw journeyError(
        'CHANGE_STEP_MISMATCH',
        'The financial change does not belong to this step.',
        422,
        { field: 'changeId', stepKey }
      );
    }
  }

  /**
   * Advance a step only when current confirmed records satisfy it. When they do
   * not, the journey is returned unchanged with a scoped retry key so the
   * client can retry that step without re-entering earlier steps.
   */
  async #completeStep(journey, { stepKey, changeId }, now) {
    this.#requireActive(journey);
    this.#assertStepBelongs(journey, stepKey);
    if (changeId !== undefined) {
      await this.#assertConfirmedChange(journey.userId, stepKey, changeId);
    }

    const plan = await this.#plan(journey, now);
    const step = plan.steps.find(({ key }) => key === stepKey);
    if (step.status !== 'satisfied') {
      throw journeyError(
        'STEP_NOT_CONFIRMED',
        'This step has no confirmed record yet. Save it again to continue.',
        409,
        {
          stepKey,
          retryScopeKey: retryScope(journey.id, stepKey),
          journey: await this.#view(journey, plan),
        }
      );
    }

    const saved = await this.#persist(journey, plan);
    const view = await this.#view(saved, plan);
    return {
      journey: view,
      transition: {
        action: 'complete_step',
        stepKey,
        unlocks: STEP_REGISTRY[stepKey].unlocks,
        confirmedChangeId: view.steps.find(({ key }) => key === stepKey).confirmedChangeId,
      },
    };
  }

  /** Skipping an optional step writes no financial data; it only resolves the prompt. */
  async #skipStep(journey, { stepKey }, now) {
    this.#requireActive(journey);
    this.#assertStepBelongs(journey, stepKey);
    if (journey.requiredStepKeys.includes(stepKey)) {
      throw journeyError(
        'STEP_NOT_OPTIONAL',
        'Required steps cannot be skipped.',
        422,
        { field: 'stepKey', stepKey }
      );
    }

    const plan = await this.#plan(journey, now);
    const step = plan.steps.find(({ key }) => key === stepKey);
    let saved = journey;
    if (step.status === 'pending') {
      if (!plan.firstOutcome.available) {
        throw journeyError(
          'FIRST_OUTCOME_PENDING',
          'Optional steps are offered after the first outcome is available.',
          409,
          { stepKey }
        );
      }
      saved = await this.#persist(journey, plan, { extraStepKeys: [stepKey] });
    } else {
      saved = await this.#persist(journey, plan);
    }
    const afterPlan = await this.#plan(saved, now);
    return {
      journey: await this.#view(saved, afterPlan),
      transition: {
        action: 'skip_step',
        stepKey,
        unlocks: null,
        confirmedChangeId: null,
        availableOutcomeKind: plan.firstOutcome.kind,
      },
    };
  }

  async #pause(journey, now) {
    this.#requireOpen(journey);
    const saved = journey.status === 'paused'
      ? journey
      : await this.#journeys.pause({ userId: journey.userId, journeyId: journey.id });
    const plan = await this.#plan(saved, now);
    return { journey: await this.#view(saved, plan), transition: { action: 'pause' } };
  }

  /** Resume re-evaluates current records and returns the next incomplete step. */
  async #resume(journey, now) {
    this.#requireOpen(journey);
    const plan = await this.#plan(journey, now);
    const saved = await this.#persist(journey, plan, { status: 'active' });
    return {
      journey: await this.#view(saved, plan),
      transition: { action: 'resume', nextStepKey: plan.currentStepKey },
    };
  }

  /** Clarity confirmation: close the journey once the first outcome exists. */
  async #complete(journey, now) {
    if (journey.status === 'abandoned') this.#requireOpen(journey);
    const plan = await this.#plan(journey, now);
    if (journey.status === 'completed') {
      return {
        journey: await this.#view(journey, plan),
        transition: { action: 'complete' },
      };
    }
    this.#requireActive(journey);
    if (!plan.firstOutcome.available) {
      throw journeyError(
        'FIRST_OUTCOME_PENDING',
        'Complete the remaining required steps before finishing the journey.',
        409,
        {
          retryScopeKey: retryScope(journey.id, plan.nextIncompleteStepKey ?? 'complete'),
          journey: await this.#view(journey, plan),
        }
      );
    }
    const saved = await this.#persist(journey, plan, { status: 'completed' });
    return {
      journey: await this.#view(saved, plan),
      transition: { action: 'complete' },
    };
  }
}

const journeyService = new JourneyService();
export default journeyService;
