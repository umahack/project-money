import { createClient } from '@libsql/client';
import { readDatabaseConfig } from './config.js';

const { url, authToken } = readDatabaseConfig();
const raw = createClient({ url, authToken });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS salary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    UNIQUE(user_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS emis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    effective_from_month TEXT,
    effective_to_month TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    destination TEXT,
    budget REAL NOT NULL CHECK (budget >= 0),
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS trip_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,
    UNIQUE(trip_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS trip_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    responded_at TEXT,
    UNIQUE(trip_id, invitee_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trip_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    payer TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    split_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS user_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS expense_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    note TEXT,
    spent_on TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_log_user_month ON expense_log(user_id, month)`,
  `CREATE TABLE IF NOT EXISTS category_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, category)
  )`,
  `CREATE TABLE IF NOT EXISTS recurring_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    active INTEGER NOT NULL DEFAULT 1,
    last_logged_month TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS savings_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL CHECK (target_amount > 0),
    saved_amount REAL NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
    target_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email TEXT,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
];

for (const stmt of SCHEMA) {
  await raw.execute(stmt);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe schema identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function addColumnIfMissing(table, column, definition) {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const tableInfo = await raw.execute(`PRAGMA table_info(${quotedTable})`);
  const columnExists = tableInfo.rows.some((row) => row.name === column);
  if (columnExists) return;

  try {
    await raw.execute(
      `ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${definition}`
    );
  } catch (error) {
    // Another initializer may have added the same column after our probe.
    if (!/duplicate column name/i.test(error?.message ?? '')) throw error;
  }
}

// Additive migrations for pre-existing databases. Defaults and nullable bounds
// preserve legacy semantics without updating or rewriting source rows.
await addColumnIfMissing('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing(
  'trip_members',
  'user_id',
  'INTEGER REFERENCES users(id) ON DELETE SET NULL'
);
await addColumnIfMissing('trips', 'public_token', 'TEXT');
await addColumnIfMissing('trips', 'public_enabled', 'INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing('salary_entries', 'updated_at', 'TEXT');
await addColumnIfMissing(
  'emis',
  'active',
  'INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))'
);
await addColumnIfMissing('emis', 'effective_from_month', 'TEXT');
await addColumnIfMissing('emis', 'effective_to_month', 'TEXT');
await addColumnIfMissing('emis', 'updated_at', 'TEXT');
await addColumnIfMissing('expense_log', 'updated_at', 'TEXT');
await addColumnIfMissing('trips', 'updated_at', 'TEXT');
await addColumnIfMissing('trips', 'trip_version', 'INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing('trip_expenses', 'updated_at', 'TEXT');

await raw.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_public_token ON trips(public_token) WHERE public_token IS NOT NULL');

// Lightweight page-visit log for the admin analytics panel.
await raw.execute(`CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
await raw.execute('CREATE INDEX IF NOT EXISTS idx_visits_created_at ON visits(created_at)');
await raw.execute('CREATE INDEX IF NOT EXISTS idx_visits_ip_hash ON visits(ip_hash)');

// token_version lets us invalidate every outstanding JWT for a user by bumping it (e.g. on password change).
await addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');

// Audit log: destructive admin actions get a row here. Append-only (no DELETE from code).
await raw.execute(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
await raw.execute('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');

// Sessions: one row per device login. New successful login revokes all
// prior rows for that user (single-device-at-a-time enforcement).
await raw.execute(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_reason TEXT
)`);
await raw.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
await raw.execute('CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id, revoked_at)');

// Financial Clarity companion state. Derived outcomes remain calculated on
// demand; these tables store only source links, versions, consent, and reports.
await raw.execute(`CREATE TABLE IF NOT EXISTS user_financial_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data_version INTEGER NOT NULL DEFAULT 0,
  data_use_notice_version INTEGER NOT NULL DEFAULT 0,
  data_use_acknowledged_at TEXT,
  analytics_enabled INTEGER NOT NULL DEFAULT 0 CHECK (analytics_enabled IN (0, 1)),
  analytics_consent_version INTEGER,
  analytics_changed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS guided_journeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  desired_outcome TEXT NOT NULL CHECK (desired_outcome IN
    ('plan_month','control_spending','fund_goal','settle_trip')),
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','abandoned')),
  current_step_key TEXT,
  completed_step_keys TEXT NOT NULL DEFAULT '[]',
  started_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  measurement_eligible INTEGER NOT NULL DEFAULT 0 CHECK (measurement_eligible IN (0, 1)),
  measurement_consent_version INTEGER,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_outcome_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
await raw.execute('CREATE INDEX IF NOT EXISTS idx_guided_journeys_user ON guided_journeys(user_id, status, id)');

await raw.execute(`CREATE TABLE IF NOT EXISTS expense_category_treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL COLLATE NOCASE,
  treatment TEXT NOT NULL CHECK (treatment IN ('needs','wants')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category)
)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS trip_expense_personal_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  trip_expense_id INTEGER NOT NULL REFERENCES trip_expenses(id) ON DELETE CASCADE,
  expense_log_id INTEGER NOT NULL REFERENCES expense_log(id) ON DELETE CASCADE,
  included_amount_minor INTEGER NOT NULL CHECK (included_amount_minor > 0),
  included_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, trip_expense_id),
  UNIQUE(expense_log_id)
)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS financial_record_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint_hmac TEXT NOT NULL,
  operation TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id INTEGER,
  record_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','reversed')),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, idempotency_key)
)`);
await raw.execute(`CREATE INDEX IF NOT EXISTS idx_financial_changes_user_time
  ON financial_record_changes(user_id, occurred_at)`);
// Competing commands for one record may read the same preceding version. This
// unique claim makes only one next version committable; the losing transaction
// rolls back its source, linked, receipt, and user-version writes together.
await raw.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_changes_record_version
  ON financial_record_changes(user_id, record_type, record_id, record_version)
  WHERE record_id IS NOT NULL`);

await raw.execute(`CREATE TABLE IF NOT EXISTS product_measurement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  journey_id INTEGER REFERENCES guided_journeys(id) ON DELETE CASCADE,
  outcome_kind TEXT,
  desired_outcome TEXT,
  response TEXT,
  action_key TEXT,
  recommendation_instance_id TEXT,
  change_id INTEGER REFERENCES financial_record_changes(id) ON DELETE CASCADE,
  caused_reload INTEGER CHECK (caused_reload IN (0, 1)),
  caused_page_wide_loading INTEGER CHECK (caused_page_wide_loading IN (0, 1)),
  consent_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  local_date TEXT NOT NULL,
  local_week_start TEXT NOT NULL
)`);
await raw.execute(`CREATE INDEX IF NOT EXISTS idx_measurement_events_period
  ON product_measurement_events(event_name, local_date)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS measurement_report_checkpoints (
  period_type TEXT PRIMARY KEY CHECK (period_type IN ('weekly','28_day')),
  last_period_end_exclusive TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS measurement_source_outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL CHECK (source_name IN
    ('guided_journeys','product_measurement_events','financial_record_changes')),
  unavailable_start TEXT NOT NULL,
  unavailable_end_exclusive TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (unavailable_start < unavailable_end_exclusive)
)`);
await raw.execute(`CREATE INDEX IF NOT EXISTS idx_measurement_source_outages_period
  ON measurement_source_outages(source_name, unavailable_start, unavailable_end_exclusive)`);

await raw.execute(`CREATE TABLE IF NOT EXISTS success_metric_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL CHECK (period_type IN ('weekly','28_day')),
  period_start TEXT NOT NULL,
  period_end_exclusive TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  numerator INTEGER,
  denominator INTEGER,
  percentage_tenths INTEGER,
  duration_ms INTEGER,
  target_status TEXT CHECK (target_status IN ('met','not_met','insufficient_data')),
  source_status TEXT NOT NULL CHECK (source_status IN ('complete','unavailable')),
  unavailable_source TEXT,
  unavailable_start TEXT,
  unavailable_end_exclusive TEXT,
  population_definition TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_type, period_start, period_end_exclusive, metric_name)
)`);

// Custom expense categories (per-user, on top of built-in defaults)
await raw.execute(`CREATE TABLE IF NOT EXISTS user_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
)`);

// Pending signup — holds name/password hash + bcrypt-hashed OTP while a new
// user confirms the code sent to their email. Upserted on resend.
await raw.execute(`CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  verify_code_hash TEXT NOT NULL,
  verify_expires_at TEXT NOT NULL,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Pending email change — one in-flight per user; code sent to the new address.
await raw.execute(`CREATE TABLE IF NOT EXISTS pending_email_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL,
  verify_code_hash TEXT NOT NULL,
  verify_expires_at TEXT NOT NULL,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
)`);

// Pending password reset — upserted per email while the user enters the code.
// We key by email (not user_id) so the start endpoint can be constant-time
// regardless of whether the account exists.
await raw.execute(`CREATE TABLE IF NOT EXISTS pending_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  verify_code_hash TEXT NOT NULL,
  verify_expires_at TEXT NOT NULL,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Admin-authored announcement banners (one active row at a time)
await raw.execute(`CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  actor_email TEXT
)`);

function wrapRun(result) {
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid:
      result.lastInsertRowid != null ? Number(result.lastInsertRowid) : 0,
  };
}

const CONSTRAINT_CODE_PATTERNS = [
  [/FOREIGN KEY constraint failed/i, 'SQLITE_CONSTRAINT_FOREIGNKEY'],
  [/UNIQUE constraint failed/i, 'SQLITE_CONSTRAINT_UNIQUE'],
  [/NOT NULL constraint failed/i, 'SQLITE_CONSTRAINT_NOTNULL'],
  [/CHECK constraint failed/i, 'SQLITE_CONSTRAINT_CHECK'],
  [/PRIMARY KEY constraint failed/i, 'SQLITE_CONSTRAINT_PRIMARYKEY'],
];

function normalizeDatabaseError(error) {
  const message = String(error?.message ?? '');
  const existingCode = String(error?.code ?? '');
  const matchedCode = CONSTRAINT_CODE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1];
  const isConstraint =
    matchedCode != null ||
    /^SQLITE_CONSTRAINT(?:_|$)/i.test(existingCode) ||
    /\bconstraint failed\b/i.test(message);

  if (!isConstraint) return error;

  const normalizedCode = matchedCode ?? (
    /^SQLITE_CONSTRAINT(?:_|$)/i.test(existingCode)
      ? existingCode.toUpperCase()
      : 'SQLITE_CONSTRAINT'
  );

  if (error && typeof error === 'object') {
    try {
      error.code = normalizedCode;
      return error;
    } catch {
      // Fall through for non-extensible third-party errors.
    }
  }

  const normalized = new Error(message || 'Database constraint failed.', { cause: error });
  normalized.code = normalizedCode;
  return normalized;
}

async function execute(statement) {
  try {
    return await raw.execute(statement);
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}

function normalizeBatchStatement(statement, index) {
  let sql;
  let args;

  if (typeof statement === 'string') {
    sql = statement;
    args = [];
  } else if (Array.isArray(statement)) {
    if (statement.length < 1 || statement.length > 2) {
      throw new TypeError(`Batch statement ${index} must be [sql, args].`);
    }
    [sql, args = []] = statement;
  } else if (statement && typeof statement === 'object') {
    ({ sql, args = [] } = statement);
  } else {
    throw new TypeError(`Batch statement ${index} must be a SQL string, tuple, or statement object.`);
  }

  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new TypeError(`Batch statement ${index} must contain non-empty SQL.`);
  }
  if (!Array.isArray(args) && (!args || typeof args !== 'object')) {
    throw new TypeError(`Batch statement ${index} args must be an array or named-argument object.`);
  }

  return { sql, args };
}

const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const r = await execute({ sql, args });
        return r.rows[0];
      },
      async all(...args) {
        const r = await execute({ sql, args });
        return r.rows;
      },
      async run(...args) {
        const r = await execute({ sql, args });
        return wrapRun(r);
      },
    };
  },
  /**
   * Execute parameterized write statements atomically. Results intentionally
   * match prepare(...).run() so callers never receive the raw libSQL client or
   * driver-specific result objects.
   */
  async batch(statements, mode = 'write') {
    if (mode !== 'write') {
      throw new TypeError('Database batches support write mode only.');
    }
    if (!Array.isArray(statements)) {
      throw new TypeError('Database batch statements must be an array.');
    }
    if (statements.length === 0) return [];

    const normalizedStatements = statements.map(normalizeBatchStatement);
    try {
      const results = await raw.batch(normalizedStatements, 'write');
      return results.map(wrapRun);
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  },
  async exec(sql) {
    const stmts = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) await execute(stmt);
  },
  pragma() { /* Turso handles journaling/foreign keys itself */ },
  async close() {
    await raw.close();
  },
};

export default db;
