import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildSessionFixture, buildUserFixture } from './fixtures.js';

/**
 * Pre-Quick-Add clarity baseline (spec: quick-add-daily-answer, task 1.1).
 *
 * The baseline seeds one synthetic user, asks the real ClarityService for the
 * snapshot at a fixed instant, and compares it with a stored fingerprint. The
 * fingerprint holds SHA-256 digests of canonical JSON plus the snapshot's key
 * paths and value types. It holds no amount, label, or other record value, so
 * a failed comparison prints digests and key paths only.
 *
 * Later tasks assert that every field that existed before the feature is
 * byte-equal by calling `compareWithBaseline(fingerprint, baseline, options)`.
 * New outcomes such as `todayAllowance` are named in `options.ignoreOutcomes`.
 */

export const BASELINE_USER_ID = 9101;
export const BASELINE_SESSION_ID = 9201;
export const BASELINE_MONTH = '2026-01';
export const BASELINE_NOW_ISO = '2026-01-15T06:30:00.000Z';
export const BASELINE_FIXTURE_URL = new URL(
  '../fixtures/clarity-snapshot.pre-quick-add.json',
  import.meta.url
);

const CREATED = '2026-01-01T00:00:00.000Z';

/** Insert the synthetic baseline account and its records into an isolated database. */
export async function seedClarityBaseline(db) {
  const user = buildUserFixture({ id: BASELINE_USER_ID, email: 'baseline-owner@example.test' });
  const session = buildSessionFixture({ userId: BASELINE_USER_ID, id: BASELINE_SESSION_ID });
  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.is_admin, user.token_version, user.created_at);
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id, session.user_id, session.device_label, session.ip_hash, session.user_agent,
    session.created_at, session.last_seen_at, session.revoked_at, session.revoked_reason
  );

  const statements = [
    [`INSERT INTO user_financial_state (user_id, data_version, updated_at) VALUES (?, ?, ?)`,
      [BASELINE_USER_ID, 5, CREATED]],
    [`INSERT INTO salary_entries (id, user_id, month, amount, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [9301, BASELINE_USER_ID, BASELINE_MONTH, 90_000, CREATED, CREATED]],
    [`INSERT INTO emis
        (id, user_id, label, amount, category, active, effective_from_month, effective_to_month, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9311, BASELINE_USER_ID, 'Baseline rent', 24_000, 'Rent', 1, null, null, CREATED, CREATED]],
    [`INSERT INTO emis
        (id, user_id, label, amount, category, active, effective_from_month, effective_to_month, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9312, BASELINE_USER_ID, 'Baseline insurance', 3_100.5, 'Insurance', 1, BASELINE_MONTH, BASELINE_MONTH, CREATED, CREATED]],
    [`INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9321, BASELINE_USER_ID, BASELINE_MONTH, 'Groceries', 1_250.5, 'Baseline groceries', '2026-01-10', '2026-01-10T01:00:00.000Z', '2026-01-10T01:00:00.000Z']],
    [`INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9322, BASELINE_USER_ID, BASELINE_MONTH, 'Entertainment', 799, null, '2026-01-12', '2026-01-12T01:00:00.000Z', '2026-01-12T01:00:00.000Z']],
    [`INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9323, BASELINE_USER_ID, BASELINE_MONTH, 'Food', 310, 'Legacy row without a spending date', null, '2026-01-14T20:00:00.000Z', null]],
    [`INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9324, BASELINE_USER_ID, BASELINE_MONTH, 'Food', 450, 'Baseline today row', '2026-01-15', '2026-01-15T05:00:00.000Z', '2026-01-15T05:00:00.000Z']],
    [`INSERT INTO expense_log
        (id, user_id, month, category, amount, note, spent_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9325, BASELINE_USER_ID, '2025-12', 'Food', 275, 'Baseline other month', '2025-12-28', '2025-12-28T01:00:00.000Z', '2025-12-28T01:00:00.000Z']],
    // updated_at is explicit: its default is the wall clock, which would make
    // the snapshot differ from run to run.
    // The id is explicit as well: an autoincrement id would depend on which
    // tests ran earlier in the same process.
    [`INSERT INTO expense_category_treatments (id, user_id, category, treatment, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
      [9371, BASELINE_USER_ID, 'Entertainment', 'wants', CREATED]],
    [`INSERT INTO savings_goals
        (id, user_id, name, target_amount, saved_amount, target_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [9331, BASELINE_USER_ID, 'Baseline goal', 60_000, 15_000, '2099-12-31', CREATED, CREATED]],
    [`INSERT INTO trips (id, user_id, name, budget, start_date, end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [9341, BASELINE_USER_ID, 'Baseline trip', 20_000, '2026-01-05', '2026-01-08', CREATED]],
    [`INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)`,
      [9351, 9341, BASELINE_USER_ID, 'Baseline owner', user.email]],
    [`INSERT INTO trip_members (id, trip_id, user_id, name, email) VALUES (?, ?, ?, ?, ?)`,
      [9352, 9341, null, 'Baseline friend', null]],
    [`INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [9361, 9341, 'Baseline owner', 'Baseline stay', 4_000,
        JSON.stringify([{ name: 'Baseline owner', share: 1 }, { name: 'Baseline friend', share: 1 }]), CREATED]],
  ];
  await db.batch(statements);
}

/** Deterministic JSON text: object keys sorted, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function collectKeyPaths(value, path, into) {
  if (Array.isArray(value)) {
    into.add(`${path}[]:array`);
    for (const item of value) collectKeyPaths(item, `${path}[]`, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    into.add(`${path}:object`);
    for (const key of Object.keys(value)) collectKeyPaths(value[key], `${path}.${key}`, into);
    return;
  }
  into.add(`${path}:${value === null ? 'null' : typeof value}`);
}

/**
 * Reduce a clarity snapshot to digests and key paths. `topLevel` digests every
 * snapshot field except `outcomes`; `outcomes` digests each outcome on its own
 * so an added sibling outcome does not disturb the existing ones.
 */
export function fingerprintClaritySnapshot(snapshot) {
  const { outcomes = {}, ...rest } = snapshot;
  const keyPaths = new Set();
  collectKeyPaths(snapshot, 'snapshot', keyPaths);
  return {
    topLevel: Object.fromEntries(Object.keys(rest).sort().map((key) => [key, digest(rest[key])])),
    outcomes: Object.fromEntries(Object.keys(outcomes).sort().map((key) => [key, digest(outcomes[key])])),
    keyPaths: [...keyPaths].sort(),
  };
}

export async function loadBaselineFingerprint() {
  return JSON.parse(await readFile(BASELINE_FIXTURE_URL, 'utf8'));
}

/**
 * List the differences between a fingerprint and the baseline. An empty list
 * means every pre-feature field is byte-equal. Key paths under an ignored
 * outcome (for example `snapshot.outcomes.todayAllowance`) are skipped.
 */
export function compareWithBaseline(actual, baseline, { ignoreOutcomes = [] } = {}) {
  const ignored = new Set(ignoreOutcomes);
  const problems = [];
  for (const [key, expected] of Object.entries(baseline.topLevel)) {
    if (actual.topLevel[key] !== expected) problems.push(`topLevel.${key} differs`);
  }
  for (const key of Object.keys(actual.topLevel)) {
    if (!(key in baseline.topLevel)) problems.push(`topLevel.${key} is new`);
  }
  for (const [key, expected] of Object.entries(baseline.outcomes)) {
    if (actual.outcomes[key] !== expected) problems.push(`outcomes.${key} differs`);
  }
  for (const key of Object.keys(actual.outcomes)) {
    if (!ignored.has(key) && !(key in baseline.outcomes)) problems.push(`outcomes.${key} is new`);
  }
  const isIgnoredPath = (path) => [...ignored].some((name) => path.startsWith(`snapshot.outcomes.${name}`));
  const actualPaths = new Set(actual.keyPaths.filter((path) => !isIgnoredPath(path)));
  const baselinePaths = new Set(baseline.keyPaths);
  for (const path of baselinePaths) if (!actualPaths.has(path)) problems.push(`key path removed: ${path}`);
  for (const path of actualPaths) if (!baselinePaths.has(path)) problems.push(`key path added: ${path}`);
  return problems;
}
