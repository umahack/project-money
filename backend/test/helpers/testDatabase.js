import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_ENV_KEYS = [
  'NODE_ENV',
  'TZ',
  'HOST',
  'PORT',
  'JWT_SECRET',
  'FINANCIAL_MUTATION_HMAC_KEY',
  'CLARITY_SHADOW_COMPARE',
  'CORS_ORIGIN',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CRON_SECRET',
];

let databaseCreated = false;

function captureEnvironment() {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous) {
  for (const key of TEST_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

export function assertIsolatedTestDatabaseEnvironment(environment = process.env) {
  if (environment.NODE_ENV !== 'test') {
    throw new Error('The isolated database helper requires NODE_ENV=test.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(environment.TURSO_DATABASE_URL);
  } catch {
    throw new Error('The isolated database helper requires a valid file: database URL.');
  }

  if (parsedUrl.protocol !== 'file:') {
    throw new Error('The isolated database helper refuses remote Turso database URLs.');
  }
  if (environment.TURSO_AUTH_TOKEN?.trim()) {
    throw new Error('The isolated database helper refuses Turso authentication tokens.');
  }
  if (environment.RESEND_API_KEY?.trim()) {
    throw new Error('The isolated database helper refuses email-service credentials.');
  }
}

/**
 * Create one temporary, file-backed libSQL database for the current test
 * process. Node's test runner isolates test files; callers can use reset()
 * between cases in the same file.
 */
export async function createIsolatedTestDatabase(testContext) {
  if (databaseCreated) {
    throw new Error('Only one isolated database may be created per test process. Use reset() between cases.');
  }
  databaseCreated = true;

  const previousEnvironment = captureEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'project-money-test-'));
  const databasePath = join(directory, 'data.sqlite');
  const databaseUrl = pathToFileURL(databasePath).href;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    TZ: 'Asia/Kolkata',
    HOST: '127.0.0.1',
    PORT: '0',
    JWT_SECRET: 'test-only-jwt-secret-at-least-24-characters',
    FINANCIAL_MUTATION_HMAC_KEY: '',
    CLARITY_SHADOW_COMPARE: 'false',
    CORS_ORIGIN: 'http://127.0.0.1',
    TURSO_DATABASE_URL: databaseUrl,
    // Keep credential variables present and empty so dotenv cannot restore
    // developer or production service credentials during module loading.
    TURSO_AUTH_TOKEN: '',
    RESEND_API_KEY: '',
    MAIL_FROM: '',
    CRON_SECRET: '',
  });
  assertIsolatedTestDatabaseEnvironment();

  let db;
  let cleanedUp = false;

  const cleanupFiles = async () => {
    const expectedPrefix = `${tmpdir()}${sep}project-money-test-`;
    if (!directory.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  };

  try {
    ({ default: db } = await import('../../src/db/index.js'));
  } catch (error) {
    await cleanupFiles();
    restoreEnvironment(previousEnvironment);
    throw error;
  }

  const reset = async () => {
    const tables = [
      'success_metric_reports',
      'measurement_source_outages',
      'measurement_report_checkpoints',
      'product_measurement_events',
      'financial_record_changes',
      'trip_expense_personal_links',
      'expense_category_treatments',
      'guided_journeys',
      'user_financial_state',
      'audit_log',
      'announcements',
      'pending_email_changes',
      'pending_password_resets',
      'pending_registrations',
      'feedback',
      'trip_invites',
      'trip_expenses',
      'trip_members',
      'trips',
      'category_budgets',
      'recurring_expenses',
      'expense_log',
      'salary_entries',
      'emis',
      'user_aliases',
      'user_categories',
      'sessions',
      'visits',
      'users',
    ];
    for (const table of tables) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
  };

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await db.close();
    } finally {
      await cleanupFiles();
      restoreEnvironment(previousEnvironment);
    }
  };

  if (testContext?.after) testContext.after(cleanup);

  return Object.freeze({ db, databasePath, databaseUrl, reset, cleanup });
}
