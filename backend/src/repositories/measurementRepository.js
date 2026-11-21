import db from '../db/index.js';
import {
  assertIsoInstant,
  assertPositiveId,
  confirmedCollection,
  confirmedRecord,
  requireDatabase,
  toSafeInteger,
} from './repositorySupport.js';

export const REPORT_PERIOD_TYPES = Object.freeze(['weekly', '28_day']);
export const MEASUREMENT_SOURCE_NAMES = Object.freeze([
  'guided_journeys',
  'product_measurement_events',
  'financial_record_changes',
]);

const REPORT_PERIOD_TYPE_SET = new Set(REPORT_PERIOD_TYPES);
const MEASUREMENT_SOURCE_NAME_SET = new Set(MEASUREMENT_SOURCE_NAMES);

function assertPeriodType(periodType) {
  if (!REPORT_PERIOD_TYPE_SET.has(periodType)) {
    throw new TypeError('periodType must be weekly or 28_day.');
  }
  return periodType;
}

function assertSourceName(sourceName) {
  if (!MEASUREMENT_SOURCE_NAME_SET.has(sourceName)) {
    throw new TypeError('sourceName must be a fixed measurement source.');
  }
  return sourceName;
}

function mapConsent(row) {
  if (!row) return null;
  return {
    userId: toSafeInteger(row.user_id, 'consent user id'),
    dataUseNoticeVersion: toSafeInteger(row.data_use_notice_version ?? 0, 'data-use notice version'),
    dataUseAcknowledgedAt: row.data_use_acknowledged_at ?? null,
    analyticsEnabled: Number(row.analytics_enabled) === 1,
    analyticsConsentVersion: row.analytics_consent_version == null
      ? null
      : toSafeInteger(row.analytics_consent_version, 'analytics consent version'),
    analyticsChangedAt: row.analytics_changed_at ?? null,
  };
}

function mapCheckpoint(row) {
  return {
    periodType: row.period_type,
    lastPeriodEndExclusive: row.last_period_end_exclusive,
    updatedAt: row.updated_at,
  };
}

function mapOutage(row) {
  return {
    id: toSafeInteger(row.id, 'measurement outage id'),
    sourceName: row.source_name,
    unavailableStart: row.unavailable_start,
    unavailableEndExclusive: row.unavailable_end_exclusive,
    recordedAt: row.recorded_at,
  };
}

function mapEvent(row) {
  return {
    id: toSafeInteger(row.id, 'measurement event id'),
    eventId: row.event_id,
    userId: toSafeInteger(row.user_id, 'measurement event user id'),
    eventName: row.event_name,
    journeyId: row.journey_id == null ? null : toSafeInteger(row.journey_id, 'event journey id'),
    outcomeKind: row.outcome_kind ?? null,
    desiredOutcome: row.desired_outcome ?? null,
    response: row.response ?? null,
    actionKey: row.action_key ?? null,
    recommendationInstanceId: row.recommendation_instance_id ?? null,
    changeId: row.change_id == null ? null : toSafeInteger(row.change_id, 'event change id'),
    causedReload: row.caused_reload == null ? null : Number(row.caused_reload) === 1,
    causedPageWideLoading: row.caused_page_wide_loading == null
      ? null
      : Number(row.caused_page_wide_loading) === 1,
    consentVersion: toSafeInteger(row.consent_version, 'event consent version'),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    localDate: row.local_date,
    localWeekStart: row.local_week_start,
  };
}

export class MeasurementRepository {
  #database;

  constructor(database) {
    this.#database = requireDatabase(database);
  }

  async getConsentState(userId) {
    assertPositiveId(userId, 'userId');
    const row = await this.#database.prepare(
      `SELECT account.id AS user_id,
              COALESCE(state.data_use_notice_version, 0) AS data_use_notice_version,
              state.data_use_acknowledged_at,
              COALESCE(state.analytics_enabled, 0) AS analytics_enabled,
              state.analytics_consent_version,
              state.analytics_changed_at
         FROM users account
         LEFT JOIN user_financial_state state ON state.user_id = account.id
        WHERE account.id = ?`
    ).get(userId);
    return row ? mapConsent(row) : null;
  }

  async acknowledgeDataUseNotice({ userId, noticeVersion }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(noticeVersion, 'noticeVersion');
    await this.#database.prepare(
      `INSERT INTO user_financial_state
        (user_id, data_use_notice_version, data_use_acknowledged_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         data_use_notice_version = MAX(
           user_financial_state.data_use_notice_version,
           excluded.data_use_notice_version
         ),
         data_use_acknowledged_at = CASE
           WHEN excluded.data_use_notice_version >= user_financial_state.data_use_notice_version
             THEN CURRENT_TIMESTAMP
           ELSE user_financial_state.data_use_acknowledged_at
         END,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, noticeVersion);
    return this.getConsentState(userId);
  }

  async setAnalyticsConsent({ userId, enabled, consentVersion = null }) {
    assertPositiveId(userId, 'userId');
    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    if (enabled) {
      assertPositiveId(consentVersion, 'consentVersion');
    } else if (consentVersion != null) {
      assertPositiveId(consentVersion, 'consentVersion');
    }

    await this.#database.prepare(
      `INSERT INTO user_financial_state
        (user_id, analytics_enabled, analytics_consent_version, analytics_changed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         analytics_enabled = excluded.analytics_enabled,
         analytics_consent_version = COALESCE(
           excluded.analytics_consent_version,
           user_financial_state.analytics_consent_version
         ),
         analytics_changed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, enabled ? 1 : 0, consentVersion);
    return this.getConsentState(userId);
  }

  /**
   * User-level measurement rows are available only through a user-scoped read.
   * Reporting services can add separate aggregate queries without exposing a
   * general cross-user event reader to request handlers.
   */
  async loadUserEvents({ userId, startInclusive, endExclusive }) {
    assertPositiveId(userId, 'userId');
    assertIsoInstant(startInclusive, 'startInclusive');
    assertIsoInstant(endExclusive, 'endExclusive');
    if (startInclusive >= endExclusive) {
      throw new RangeError('startInclusive must be earlier than endExclusive.');
    }

    const rows = await this.#database.prepare(
      `SELECT id, event_id, user_id, event_name, journey_id, outcome_kind,
              desired_outcome, response, action_key, recommendation_instance_id,
              change_id, caused_reload, caused_page_wide_loading, consent_version,
              occurred_at, received_at, local_date, local_week_start
         FROM product_measurement_events
        WHERE user_id = ?
          AND occurred_at >= ?
          AND occurred_at < ?
        ORDER BY occurred_at, id`
    ).all(userId, startInclusive, endExclusive);
    return confirmedCollection(rows.map(mapEvent));
  }

  /** Confirm that a financial change receipt belongs to the user. */
  async getOwnedChangeReceipt({ userId, changeId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(changeId, 'changeId');
    const row = await this.#database.prepare(
      'SELECT id, occurred_at FROM financial_record_changes WHERE id = ? AND user_id = ?'
    ).get(changeId, userId);
    return row
      ? { id: toSafeInteger(row.id, 'change id'), occurredAt: row.occurred_at }
      : null;
  }

  /**
   * Insert one closed-schema event only if analytics is enabled at the moment
   * the statement executes. Consent is evaluated inside the INSERT so an
   * opt-out that commits first always wins over an in-flight event. The
   * consent version is copied from that same consent row, never from the client.
   * A repeated event_id is ignored. Returns whether a row was inserted.
   */
  async recordConsentedEvent(event) {
    assertPositiveId(event.userId, 'userId');
    assertIsoInstant(event.occurredAt, 'occurredAt');
    assertIsoInstant(event.receivedAt, 'receivedAt');
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
      throw new TypeError('eventId must be a non-empty string.');
    }

    const result = await this.#database.prepare(
      `INSERT INTO product_measurement_events
        (event_id, user_id, event_name, journey_id, outcome_kind, desired_outcome,
         response, action_key, recommendation_instance_id, change_id, caused_reload,
         caused_page_wide_loading, consent_version, occurred_at, received_at,
         local_date, local_week_start)
       SELECT ?, state.user_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              state.analytics_consent_version, ?, ?, ?, ?
         FROM user_financial_state state
        WHERE state.user_id = ?
          AND state.analytics_enabled = 1
          AND state.analytics_consent_version IS NOT NULL
       ON CONFLICT(event_id) DO NOTHING`
    ).run(
      event.eventId,
      event.eventName,
      event.journeyId ?? null,
      event.outcomeKind ?? null,
      event.desiredOutcome ?? null,
      event.response ?? null,
      event.actionKey ?? null,
      event.recommendationInstanceId ?? null,
      event.changeId ?? null,
      event.causedReload == null ? null : (event.causedReload ? 1 : 0),
      event.causedPageWideLoading == null ? null : (event.causedPageWideLoading ? 1 : 0),
      event.occurredAt,
      event.receivedAt,
      event.localDate,
      event.localWeekStart,
      event.userId
    );
    return result.changes === 1;
  }

  /**
   * Store a visit for an authenticated user only while analytics is enabled.
   * Consent is checked by the same statement that inserts the row.
   */
  async recordConsentedVisit({ userId, route, ipHash, userAgent = null }) {
    assertPositiveId(userId, 'userId');
    const result = await this.#database.prepare(
      `INSERT INTO visits (user_id, path, ip_hash, user_agent)
       SELECT ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM user_financial_state
           WHERE user_id = ?
             AND analytics_enabled = 1
             AND analytics_consent_version IS NOT NULL
        )`
    ).run(userId, route, ipHash, userAgent, userId);
    return result.changes === 1;
  }

  /** Store a public-page visit that is not linked to any user. */
  async recordAnonymousVisit({ route, ipHash, userAgent = null }) {
    const result = await this.#database.prepare(
      'INSERT INTO visits (user_id, path, ip_hash, user_agent) VALUES (NULL, ?, ?, ?)'
    ).run(route, ipHash, userAgent);
    return result.changes === 1;
  }

  async getReportCheckpoint(periodType) {
    assertPeriodType(periodType);
    const row = await this.#database.prepare(
      `SELECT period_type, last_period_end_exclusive, updated_at
         FROM measurement_report_checkpoints
        WHERE period_type = ?`
    ).get(periodType);
    return confirmedRecord(row ? mapCheckpoint(row) : null);
  }

  async advanceReportCheckpoint({ periodType, periodEndExclusive }) {
    assertPeriodType(periodType);
    assertIsoInstant(periodEndExclusive, 'periodEndExclusive');
    const row = await this.#database.prepare(
      `INSERT INTO measurement_report_checkpoints
        (period_type, last_period_end_exclusive)
       VALUES (?, ?)
       ON CONFLICT(period_type) DO UPDATE SET
         last_period_end_exclusive = MAX(
           measurement_report_checkpoints.last_period_end_exclusive,
           excluded.last_period_end_exclusive
         ),
         updated_at = CURRENT_TIMESTAMP
       RETURNING period_type, last_period_end_exclusive, updated_at`
    ).get(periodType, periodEndExclusive);
    return mapCheckpoint(row);
  }

  async recordSourceOutage({ sourceName, unavailableStart, unavailableEndExclusive }) {
    assertSourceName(sourceName);
    assertIsoInstant(unavailableStart, 'unavailableStart');
    assertIsoInstant(unavailableEndExclusive, 'unavailableEndExclusive');
    if (unavailableStart >= unavailableEndExclusive) {
      throw new RangeError('unavailableStart must be earlier than unavailableEndExclusive.');
    }

    const row = await this.#database.prepare(
      `INSERT INTO measurement_source_outages
        (source_name, unavailable_start, unavailable_end_exclusive)
       VALUES (?, ?, ?)
       RETURNING id, source_name, unavailable_start, unavailable_end_exclusive, recorded_at`
    ).get(sourceName, unavailableStart, unavailableEndExclusive);
    return mapOutage(row);
  }

  async loadSourceOutages({ startInclusive, endExclusive, sourceNames = MEASUREMENT_SOURCE_NAMES }) {
    assertIsoInstant(startInclusive, 'startInclusive');
    assertIsoInstant(endExclusive, 'endExclusive');
    if (startInclusive >= endExclusive) {
      throw new RangeError('startInclusive must be earlier than endExclusive.');
    }
    if (!Array.isArray(sourceNames)) {
      throw new TypeError('sourceNames must be an array of fixed measurement sources.');
    }
    const uniqueSources = [...new Set(sourceNames)];
    uniqueSources.forEach(assertSourceName);
    if (uniqueSources.length === 0) return confirmedCollection([]);

    const placeholders = uniqueSources.map(() => '?').join(', ');
    const rows = await this.#database.prepare(
      `SELECT id, source_name, unavailable_start, unavailable_end_exclusive, recorded_at
         FROM measurement_source_outages
        WHERE source_name IN (${placeholders})
          AND unavailable_start < ?
          AND unavailable_end_exclusive > ?
        ORDER BY unavailable_start, id`
    ).all(...uniqueSources, endExclusive, startInclusive);
    return confirmedCollection(rows.map(mapOutage));
  }
}

const measurementRepository = new MeasurementRepository(db);
export default measurementRepository;
