import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('TURSO_DATABASE_URL not set. See README for setup.');
  process.exit(1);
}

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
    UNIQUE(user_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS emis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    destination TEXT,
    budget REAL NOT NULL CHECK (budget >= 0),
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_log_user_month ON expense_log(user_id, month)`,
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

// Idempotent migrations for columns added to pre-existing tables
try {
  await raw.execute('SELECT is_admin FROM users LIMIT 1');
} catch {
  await raw.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
try {
  await raw.execute('SELECT user_id FROM trip_members LIMIT 1');
} catch {
  await raw.execute('ALTER TABLE trip_members ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

function wrapRun(result) {
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid:
      result.lastInsertRowid != null ? Number(result.lastInsertRowid) : 0,
  };
}

const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const r = await raw.execute({ sql, args });
        return r.rows[0];
      },
      async all(...args) {
        const r = await raw.execute({ sql, args });
        return r.rows;
      },
      async run(...args) {
        try {
          const r = await raw.execute({ sql, args });
          return wrapRun(r);
        } catch (err) {
          // Normalize FK-constraint errors so handlers can detect them uniformly
          if (err?.message && /FOREIGN KEY/i.test(err.message)) {
            err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
          }
          throw err;
        }
      },
    };
  },
  async exec(sql) {
    const stmts = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) await raw.execute(stmt);
  },
  pragma() { /* Turso handles journaling/foreign keys itself */ },
};

export default db;
