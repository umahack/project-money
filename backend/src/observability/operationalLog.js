/**
 * Privacy-safe operational log seam (Requirements 1.11-1.13, 9.6, 9.11, 10.11,
 * 11.12, 13.30, 13.31; design "Failure Containment").
 *
 * Every operational log line in the clarity code paths goes through this
 * module. A call names a fixed event code plus optional fields. Only fields on
 * the allowlist below survive, and each allowlisted field also has a strict
 * value check, so a caller cannot smuggle a financial value, name, note, email,
 * token, request body, user-agent text, or a raw path through an allowed name.
 * A field that is unknown or fails its check is dropped and only counted
 * (`droppedFields`), never echoed. The logger never throws.
 *
 * Output is one JSON object per line:
 *   {"ts":"...","level":"warn","event":"REQUEST_COMPLETED","requestId":"...",...}
 *
 * The level comes from OPERATIONAL_LOG_LEVEL (debug|info|warn|error|silent).
 * It defaults to `info`, and to `silent` when NODE_ENV=test so test reporters
 * stay small; tests that assert on log output set the level explicitly.
 */

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

/** Fixed event codes. An unknown event is replaced by LOG_EVENT_REJECTED. */
export const LOG_EVENTS = Object.freeze([
  'REQUEST_COMPLETED',
  'REQUEST_UNEXPECTED_ERROR',
  'OUTCOME_CALCULATION_FAILED',
  'SHADOW_MISMATCH',
  'REPORT_PERIOD_GENERATED',
  'REPORT_GENERATION_FAILED',
  'REPORT_RETENTION_PURGE_FAILED',
  'JOURNEY_OPERATION_FAILED',
  'ACCOUNT_EXPORT_FAILED',
  'ACCOUNT_DELETION_INCOMPLETE',
  'MAIL_DELIVERY_FAILED',
  'BACKGROUND_TASK_FAILED',
  'JOB_LINE',
  'JOB_FAILED',
  'LOG_EVENT_REJECTED',
]);

const EVENT_SET = new Set(LOG_EVENTS);

export const DURATION_BUCKETS = Object.freeze([
  'lt_50ms',
  'lt_100ms',
  'lt_250ms',
  'lt_500ms',
  'lt_1s',
  'lt_5s',
  'gte_5s',
]);

export const OUTCOME_KINDS = Object.freeze([
  'success',
  'client_error',
  'conflict',
  'notice_required',
  'rate_limited',
  'server_error',
]);

export const RECORD_TYPES = Object.freeze([
  'goal',
  'trip',
  'expense',
  'bill',
  'recurring',
  'journey',
  'category_memory',
]);

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OUTCOME_KIND_SET = new Set(OUTCOME_KINDS);
const DURATION_SET = new Set(DURATION_BUCKETS);
const RECORD_TYPE_SET = new Set(RECORD_TYPES);
const OUTCOME_FAMILIES = new Set(['monthly_plan', 'spending', 'goal', 'trip', 'trip_summary']);
const PERIOD_TYPES = new Set(['weekly', '28_day']);
const SOURCE_STATUSES = new Set(['complete', 'unavailable']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,23}(?:\.[a-z][a-z0-9_]{0,23}){0,2}$/;
const ERROR_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,39}$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const ROUTE_LITERAL_SEGMENT = /^[a-z][a-z0-9_.-]{0,39}$/;
const ROUTE_PARAM_SEGMENT = /^:[A-Za-z][A-Za-z0-9]{0,29}$/;
// A job progress line: "[tag] words key=value ..." built only from letters,
// digits, spaces, and a few separators. It rejects "@", quotes, slashes,
// currency symbols, and anything else that would appear in a value or token.
const JOB_LINE_PATTERN = /^\[[a-z][a-z-]{0,31}\] [A-Za-z0-9_=·:. -]{1,160}$/;
const ROUTE_UNMATCHED = 'unmatched';

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * A route label is an Express route pattern such as `/api/finance/goals/:id`
 * or the literal `unmatched`. Concrete values never pass: literal segments
 * must be lowercase words (so a numeric id, a mixed-case token, or an email
 * is rejected) and variable segments must be `:name` placeholders.
 */
export function isRoutePattern(value) {
  if (value === ROUTE_UNMATCHED) return true;
  if (typeof value !== 'string' || value.length > 120 || !value.startsWith('/')) return false;
  const segments = value.split('/').slice(1);
  if (segments.length > 8) return false;
  if (segments.length === 1 && segments[0] === '') return true;
  return segments.every((segment, index) => (
    (segment === '' && index === segments.length - 1 && segments.length > 1)
    || ROUTE_LITERAL_SEGMENT.test(segment)
    || ROUTE_PARAM_SEGMENT.test(segment)
  ));
}

const FIELD_CHECKS = Object.freeze({
  requestId: (value) => typeof value === 'string' && UUID_PATTERN.test(value),
  route: isRoutePattern,
  method: (value) => typeof value === 'string' && HTTP_METHODS.has(value),
  status: (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  durationBucket: (value) => typeof value === 'string' && DURATION_SET.has(value),
  outcome: (value) => typeof value === 'string' && OUTCOME_KIND_SET.has(value),
  code: (value) => typeof value === 'string' && CODE_PATTERN.test(value),
  operation: (value) => typeof value === 'string' && OPERATION_PATTERN.test(value),
  recordType: (value) => typeof value === 'string' && RECORD_TYPE_SET.has(value),
  recordId: isPositiveSafeInteger,
  userId: isPositiveSafeInteger,
  outcomeKind: (value) => typeof value === 'string' && OUTCOME_FAMILIES.has(value),
  periodType: (value) => typeof value === 'string' && PERIOD_TYPES.has(value),
  sourceStatus: (value) => typeof value === 'string' && SOURCE_STATUSES.has(value),
  category: (value) => typeof value === 'string' && CATEGORY_PATTERN.test(value),
  errorName: (value) => typeof value === 'string' && ERROR_NAME_PATTERN.test(value),
  dataVersion: isNonNegativeSafeInteger,
  count: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000,
  retryable: (value) => typeof value === 'boolean',
  jobLine: (value) => typeof value === 'string' && JOB_LINE_PATTERN.test(value),
});

export const ALLOWED_LOG_FIELDS = Object.freeze(Object.keys(FIELD_CHECKS));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reduce caller fields to the allowlisted, value-checked subset. Returns the
 * safe record and the number of fields dropped. Dropped field names and values
 * are never reported.
 */
export function sanitizeLogFields(fields) {
  const record = {};
  let dropped = 0;
  if (!isPlainObject(fields)) return { record, dropped };

  for (const key of Object.keys(fields)) {
    if (key === 'event') continue;
    const check = Object.hasOwn(FIELD_CHECKS, key) ? FIELD_CHECKS[key] : null;
    let value;
    try {
      value = fields[key];
    } catch {
      dropped += 1;
      continue;
    }
    // An omitted optional field is not a violation.
    if (value === undefined) continue;
    if (check && check(value)) record[key] = value;
    else dropped += 1;
  }
  return { record, dropped };
}

/** Coarse duration label. Exact timings are not logged. */
export function durationBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'gte_5s';
  if (milliseconds < 50) return 'lt_50ms';
  if (milliseconds < 100) return 'lt_100ms';
  if (milliseconds < 250) return 'lt_250ms';
  if (milliseconds < 500) return 'lt_500ms';
  if (milliseconds < 1000) return 'lt_1s';
  if (milliseconds < 5000) return 'lt_5s';
  return 'gte_5s';
}

/** Map an HTTP status and optional error code to a fixed outcome kind. */
export function outcomeKindForStatus(status, code) {
  if (status >= 500) return 'server_error';
  if (status === 409 || code === 'RECORD_VERSION_CONFLICT') return 'conflict';
  if (status === 428) return 'notice_required';
  if (status === 429) return 'rate_limited';
  if (status >= 400) return 'client_error';
  return 'success';
}

/** Error class name when it is a plain identifier; otherwise omitted. */
export function safeErrorName(error) {
  const name = error?.name;
  return typeof name === 'string' && ERROR_NAME_PATTERN.test(name) ? name : undefined;
}

/** Stable machine code carried by an error (for example `SQLITE_BUSY`), when valid. */
export function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && CODE_PATTERN.test(code) ? code : undefined;
}

function resolveLevelName(configured) {
  const fallback = process.env.NODE_ENV === 'test' ? 'silent' : 'info';
  const candidate = (configured ?? process.env.OPERATIONAL_LOG_LEVEL ?? fallback);
  const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : fallback;
  return Object.hasOwn(LOG_LEVELS, normalized) ? normalized : fallback;
}

function consoleSink(levelName, line) {
  const method = levelName === 'debug' ? 'log' : levelName;
  // Resolve the console method per call so captured or replaced consoles work.
  console[method](line);
}

/**
 * Create a logger. `sink(level, line)` receives the finished JSON line;
 * `clock()` supplies the timestamp; `level` overrides the environment level.
 */
export function createOperationalLogger({
  sink = consoleSink,
  clock = () => new Date(),
  level,
} = {}) {
  function write(levelName, fields) {
    try {
      if (LOG_LEVELS[levelName] < LOG_LEVELS[resolveLevelName(level)]) return null;
      const requested = isPlainObject(fields) ? fields.event : undefined;
      const known = typeof requested === 'string' && EVENT_SET.has(requested);
      const { record, dropped } = sanitizeLogFields(fields);
      const entry = {
        ts: clock().toISOString(),
        level: levelName,
        event: known ? requested : 'LOG_EVENT_REJECTED',
        ...record,
        ...(dropped > 0 ? { droppedFields: dropped } : {}),
      };
      sink(levelName, JSON.stringify(entry));
      return entry;
    } catch {
      // Logging must never change request or job behavior.
      return null;
    }
  }

  return Object.freeze({
    debug: (fields) => write('debug', fields),
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  });
}

/** Process-wide logger writing JSON lines to the console. */
export const operationalLogger = createOperationalLogger();

/**
 * Convert a legacy job progress line into an event. Lines that do not match
 * the strict job-line pattern are replaced by a fixed rejection event.
 */
export function logJobLine(line, logger = operationalLogger) {
  if (typeof line === 'string' && JOB_LINE_PATTERN.test(line)) {
    return logger.info({ event: 'JOB_LINE', jobLine: line });
  }
  return logger.warn({ event: 'LOG_EVENT_REJECTED' });
}

/** Contained, non-request failure (mailer, session touch, sweep, audit...). */
export function logBackgroundFailure(operation, error, extra = {}, logger = operationalLogger) {
  return logger.warn({
    event: 'BACKGROUND_TASK_FAILED',
    operation,
    errorName: safeErrorName(error),
    code: safeErrorCode(error),
    ...extra,
  });
}

/**
 * Report every outcome in a clarity snapshot whose calculation failed. Logs
 * only the outcome family, record type/id, and fixed failure code; never the
 * value, source references, or explanation.
 */
export function reportCalculationFailures(snapshot, logger = operationalLogger) {
  const failures = [];
  const outcomes = snapshot?.outcomes;
  if (!isPlainObject(outcomes)) return failures;

  const candidates = [
    outcomes.monthlyPlan,
    outcomes.spending,
    ...(Array.isArray(outcomes.goals) ? outcomes.goals : []),
    outcomes.tripSummary,
    ...(Array.isArray(outcomes.tripSummary?.items) ? outcomes.tripSummary.items : []),
  ];
  for (const outcome of candidates) {
    if (!isPlainObject(outcome) || outcome.status !== 'calculation_failed') continue;
    const idMatch = typeof outcome.id === 'string' ? /^(goal|trip):([1-9]\d{0,14})$/.exec(outcome.id) : null;
    const fields = {
      event: 'OUTCOME_CALCULATION_FAILED',
      outcomeKind: outcome.kind,
      code: 'CALCULATION_FAILED',
      ...(idMatch ? { recordType: idMatch[1], recordId: Number(idMatch[2]) } : {}),
      ...(Number.isSafeInteger(snapshot.dataVersion) ? { dataVersion: snapshot.dataVersion } : {}),
    };
    failures.push(logger.warn(fields));
  }
  return failures;
}
