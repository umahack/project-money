import db from '../db/index.js';
import {
  assertPositiveId,
  confirmedRecord,
  requireDatabase,
  toSafeInteger,
} from './repositorySupport.js';

const STATUS_VALUES = new Set(['active', 'paused', 'completed', 'abandoned']);

export const JOURNEY_DEFINITIONS = Object.freeze({
  plan_month: Object.freeze({
    requiredStepKeys: Object.freeze(['salary']),
    optionalStepKeys: Object.freeze(['bills']),
  }),
  control_spending: Object.freeze({
    requiredStepKeys: Object.freeze(['salary', 'expense']),
    optionalStepKeys: Object.freeze(['bills', 'category_treatment']),
  }),
  fund_goal: Object.freeze({
    requiredStepKeys: Object.freeze(['goal']),
    optionalStepKeys: Object.freeze(['monthly_plan']),
  }),
  settle_trip: Object.freeze({
    requiredStepKeys: Object.freeze(['trip', 'trip_members', 'trip_split']),
    optionalStepKeys: Object.freeze(['personal_expense']),
  }),
});

function getDefinition(desiredOutcome) {
  const definition = JOURNEY_DEFINITIONS[desiredOutcome];
  if (!definition) {
    throw new TypeError('desiredOutcome must be one of the four fixed journey outcomes.');
  }
  return definition;
}

function validateStatus(status) {
  if (!STATUS_VALUES.has(status)) {
    throw new TypeError('status must be a fixed journey status.');
  }
  return status;
}

function canonicalCompletedSteps(desiredOutcome, completedStepKeys) {
  if (!Array.isArray(completedStepKeys)) {
    throw new TypeError('completedStepKeys must be an array of fixed step keys.');
  }
  const definition = getDefinition(desiredOutcome);
  const allowed = [...definition.requiredStepKeys, ...definition.optionalStepKeys];
  const completed = new Set(completedStepKeys);
  if (completed.size !== completedStepKeys.length) {
    throw new TypeError('completedStepKeys must not contain duplicates.');
  }
  for (const stepKey of completed) {
    if (!allowed.includes(stepKey)) {
      throw new TypeError(`Step ${String(stepKey)} is not valid for ${desiredOutcome}.`);
    }
  }
  return allowed.filter((stepKey) => completed.has(stepKey));
}

function parseCompletedSteps(row) {
  let parsed;
  try {
    parsed = JSON.parse(row.completed_step_keys);
  } catch {
    throw new Error(`Journey ${row.id} contains invalid completed step persistence.`);
  }
  return canonicalCompletedSteps(row.desired_outcome, parsed);
}

function mapJourney(row) {
  if (!row) return null;
  const definition = getDefinition(row.desired_outcome);
  const completedStepKeys = parseCompletedSteps(row);
  const nextIncompleteStepKey = definition.requiredStepKeys.find(
    (stepKey) => !completedStepKeys.includes(stepKey)
  ) ?? null;

  if (row.current_step_key != null) {
    const allowed = [...definition.requiredStepKeys, ...definition.optionalStepKeys];
    if (!allowed.includes(row.current_step_key)) {
      throw new Error(`Journey ${row.id} contains an invalid current step.`);
    }
  }

  return {
    id: toSafeInteger(row.id, 'journey id'),
    userId: toSafeInteger(row.user_id, 'journey user id'),
    desiredOutcome: row.desired_outcome,
    status: validateStatus(row.status),
    currentStepKey: nextIncompleteStepKey,
    completedStepKeys,
    requiredStepKeys: [...definition.requiredStepKeys],
    optionalStepKeys: [...definition.optionalStepKeys],
    nextIncompleteStepKey,
    startedSessionId: row.started_session_id == null
      ? null
      : toSafeInteger(row.started_session_id, 'journey session id'),
    measurementEligible: Number(row.measurement_eligible) === 1,
    measurementConsentVersion: row.measurement_consent_version == null
      ? null
      : toSafeInteger(row.measurement_consent_version, 'measurement consent version'),
    startedAt: row.started_at,
    firstOutcomeAt: row.first_outcome_at ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at,
  };
}

const JOURNEY_SELECT = `SELECT id, user_id, desired_outcome, status, current_step_key,
  completed_step_keys, started_session_id, measurement_eligible,
  measurement_consent_version, started_at, first_outcome_at, completed_at, updated_at
  FROM guided_journeys`;

export class JourneyRepository {
  #database;

  constructor(database) {
    this.#database = requireDatabase(database);
  }

  async create({
    userId,
    desiredOutcome,
    startedSessionId = null,
    measurementEligible = false,
    measurementConsentVersion = null,
  }) {
    assertPositiveId(userId, 'userId');
    const definition = getDefinition(desiredOutcome);
    if (typeof measurementEligible !== 'boolean') {
      throw new TypeError('measurementEligible must be a boolean.');
    }
    if (measurementEligible) {
      assertPositiveId(measurementConsentVersion, 'measurementConsentVersion');
    } else if (measurementConsentVersion != null) {
      throw new TypeError('measurementConsentVersion requires measurement eligibility.');
    }

    if (startedSessionId != null) {
      assertPositiveId(startedSessionId, 'startedSessionId');
      const session = await this.#database.prepare(
        'SELECT id FROM sessions WHERE id = ? AND user_id = ?'
      ).get(startedSessionId, userId);
      if (!session) {
        throw new Error('Started session does not belong to the journey user.');
      }
    }

    const currentStepKey = definition.requiredStepKeys[0] ?? null;
    const inserted = await this.#database.prepare(
      `INSERT INTO guided_journeys
        (user_id, desired_outcome, status, current_step_key, completed_step_keys,
         started_session_id, measurement_eligible, measurement_consent_version)
       VALUES (?, ?, 'active', ?, '[]', ?, ?, ?)
       RETURNING id`
    ).get(
      userId,
      desiredOutcome,
      currentStepKey,
      startedSessionId,
      measurementEligible ? 1 : 0,
      measurementConsentVersion
    );

    return this.getById({ userId, journeyId: toSafeInteger(inserted.id, 'journey id') });
  }

  async getById({ userId, journeyId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(journeyId, 'journeyId');
    const row = await this.#database.prepare(
      `${JOURNEY_SELECT} WHERE id = ? AND user_id = ?`
    ).get(journeyId, userId);
    return row ? mapJourney(row) : null;
  }

  async getResumable(userId) {
    assertPositiveId(userId, 'userId');
    const row = await this.#database.prepare(
      `${JOURNEY_SELECT}
        WHERE user_id = ? AND status IN ('active', 'paused')
        ORDER BY id DESC
        LIMIT 1`
    ).get(userId);
    return confirmedRecord(row ? mapJourney(row) : null);
  }

  async saveProgress({ userId, journeyId, completedStepKeys, status = 'active' }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(journeyId, 'journeyId');
    validateStatus(status);

    const existing = await this.getById({ userId, journeyId });
    if (!existing) return null;

    const canonicalSteps = canonicalCompletedSteps(existing.desiredOutcome, completedStepKeys);
    for (const priorStep of existing.completedStepKeys) {
      if (!canonicalSteps.includes(priorStep)) {
        throw new Error('Confirmed journey steps cannot be removed.');
      }
    }

    const nextIncompleteStepKey = existing.requiredStepKeys.find(
      (stepKey) => !canonicalSteps.includes(stepKey)
    ) ?? null;
    if (status === 'completed' && nextIncompleteStepKey != null) {
      throw new Error('A journey cannot complete while required steps remain.');
    }

    await this.#database.prepare(
      `UPDATE guided_journeys
          SET status = ?,
              current_step_key = ?,
              completed_step_keys = ?,
              completed_at = CASE
                WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
                ELSE completed_at
              END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`
    ).run(
      status,
      status === 'completed' || status === 'abandoned' ? null : nextIncompleteStepKey,
      JSON.stringify(canonicalSteps),
      status,
      journeyId,
      userId
    );

    return this.getById({ userId, journeyId });
  }

  async completeStep({ userId, journeyId, stepKey }) {
    const existing = await this.getById({ userId, journeyId });
    if (!existing) return null;
    const completedStepKeys = existing.completedStepKeys.includes(stepKey)
      ? existing.completedStepKeys
      : [...existing.completedStepKeys, stepKey];
    return this.saveProgress({
      userId,
      journeyId,
      completedStepKeys,
      status: 'active',
    });
  }

  async pause({ userId, journeyId }) {
    const existing = await this.getById({ userId, journeyId });
    if (!existing) return null;
    return this.saveProgress({
      userId,
      journeyId,
      completedStepKeys: existing.completedStepKeys,
      status: 'paused',
    });
  }

  async resume({ userId, journeyId }) {
    const existing = await this.getById({ userId, journeyId });
    if (!existing) return null;
    return this.saveProgress({
      userId,
      journeyId,
      completedStepKeys: existing.completedStepKeys,
      status: 'active',
    });
  }

  /**
   * Read-only, user-scoped lookup of one financial change receipt. A receipt
   * that belongs to another user is indistinguishable from a missing one.
   */
  async getOwnedChangeReceipt({ userId, changeId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(changeId, 'changeId');
    const row = await this.#database.prepare(
      `SELECT id, record_type, record_id, status
         FROM financial_record_changes
        WHERE id = ? AND user_id = ?`
    ).get(changeId, userId);
    return row
      ? {
        changeId: toSafeInteger(row.id, 'change id'),
        recordType: row.record_type,
        recordId: row.record_id == null ? null : toSafeInteger(row.record_id, 'record id'),
        status: row.status,
      }
      : null;
  }

  /** Newest confirmed receipt id for one of the user's records, or null. */
  async getLatestConfirmedChangeId({ userId, recordType, recordId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(recordId, 'recordId');
    if (typeof recordType !== 'string' || recordType === '') {
      throw new TypeError('recordType must be a non-empty string.');
    }
    const row = await this.#database.prepare(
      `SELECT id
         FROM financial_record_changes
        WHERE user_id = ? AND record_type = ? AND record_id = ? AND status = 'confirmed'
        ORDER BY id DESC
        LIMIT 1`
    ).get(userId, recordType, recordId);
    return row ? toSafeInteger(row.id, 'change id') : null;
  }

  /** Ids of the user's trips that include at least one personal-share link. */
  async listPersonalLinkTripIds(userId) {
    assertPositiveId(userId, 'userId');
    const rows = await this.#database.prepare(
      'SELECT DISTINCT trip_id FROM trip_expense_personal_links WHERE user_id = ?'
    ).all(userId);
    return rows.map((row) => toSafeInteger(row.trip_id, 'trip id'));
  }
}

const journeyRepository = new JourneyRepository(db);
export default journeyRepository;
