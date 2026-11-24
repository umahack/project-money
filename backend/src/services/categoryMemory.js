/**
 * Category memory for Quick Add: one remembered category per Note_Key per User, at most 500 entries per User.
 *
 * Every statement is parameterised and scoped by `user_id`. A record that is missing and a record that belongs to
 * another User are answered identically. Errors, and anything this module could log, never carry a note, a Note_Key,
 * or a category.
 *
 * Revision semantics (Requirements 5.3, 6.5 to 6.9, 8.6):
 *   - A new entry has revision 1.
 *   - A write that changes the category increments the revision and sets `updated_at`. A write that repeats the stored
 *     category changes nothing, so a replay after a lost response leaves the same state.
 *   - `expectedRevision`, when given, must equal the stored revision. Otherwise the write is refused with
 *     409 MEMORY_REVISION_CONFLICT and nothing changes. An entry that no longer exists also counts as a mismatch, so
 *     an undo never recreates an entry that the User deleted after the save.
 *
 * Requirements: 5.3, 6.5, 6.6, 6.7, 6.9, 6.13, 15.3, 15.4, 16.10.
 */
import db from '../db/index.js';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey } from '../domain/noteKey.js';
import { assertPositiveId, requireDatabase, toSafeInteger } from '../repositories/repositorySupport.js';

export const MEMORY_ENTRY_LIMIT = 500;
export const HISTORY_WINDOW_DAYS = 90;
export const HISTORY_MAX_KEYS = 500;
/** Upper bound on the rows read to build the history, as in the design's hints read. */
export const HISTORY_MAX_ROWS = 5000;
/** Defensive bound only. Availability of the category is checked by the caller. */
export const MEMORY_CATEGORY_MAX_LENGTH = 64;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export class CategoryMemoryError extends Error {
  constructor({ code, message, httpStatus, field }) {
    super(message);
    this.name = 'CategoryMemoryError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.statusCode = httpStatus;
    if (field !== undefined) this.field = field;
  }
}

function memoryError(code, message, httpStatus, field) {
  return new CategoryMemoryError({ code, message, httpStatus, field });
}

function notFound() {
  return memoryError('MEMORY_NOT_FOUND', 'That remembered category choice does not exist.', 404);
}

function revisionConflict() {
  return memoryError(
    'MEMORY_REVISION_CONFLICT',
    'That remembered category choice changed after it was read.',
    409,
    'expectedRevision'
  );
}

function normalizeUserId(userId) {
  return assertPositiveId(userId, 'userId');
}

function normalizeNoteKeyInput(noteKey) {
  if (typeof noteKey !== 'string' || normalizeNoteKey(noteKey) !== noteKey) {
    throw memoryError(
      'INVALID_NOTE_KEY',
      `noteKey must be a normalized note of 1 to ${NOTE_KEY_MAX_CODE_POINTS} characters.`,
      400,
      'noteKey'
    );
  }
  return noteKey;
}

function normalizeCategoryInput(category) {
  const trimmed = typeof category === 'string' ? category.trim() : '';
  if (trimmed === '' || trimmed.length > MEMORY_CATEGORY_MAX_LENGTH) {
    throw memoryError('INVALID_MEMORY_REQUEST', 'category must be a non-empty category name.', 400, 'category');
  }
  return trimmed;
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError(
      'INVALID_MEMORY_REQUEST',
      'expectedRevision must be a positive integer.',
      400,
      'expectedRevision'
    );
  }
  return value;
}

function entryFromRow(row) {
  return Object.freeze({
    id: toSafeInteger(row.id, 'category_memory.id'),
    noteKey: row.note_key,
    category: row.category,
    revision: toSafeInteger(row.revision, 'category_memory.revision'),
    updatedAt: row.updated_at,
  });
}

function parseDate(value, label) {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (match) {
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const date = new Date(time);
    if (date.toISOString().slice(0, 10) === value) return time;
  }
  throw new TypeError(`${label} must be a real YYYY-MM-DD date.`);
}

function formatDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/** The months (YYYY-MM) that overlap the inclusive date range, in ascending order. */
function monthsBetween(startDate, endDate) {
  const months = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const lastYear = Number(endDate.slice(0, 4));
  const lastMonth = Number(endDate.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Delete statement for custom-category removal, so the caller can run it in the same batch as the category delete. */
export function removeForCategoryStatement(userId, category) {
  return {
    sql: 'DELETE FROM category_memory WHERE user_id = ? AND category = ?',
    args: [normalizeUserId(userId), normalizeCategoryInput(category)],
  };
}

const UPSERT_SQL = `INSERT INTO category_memory (user_id, note_key, category, revision, created_at, updated_at)
  SELECT ?, ?, ?, 1, ?, ?
  WHERE ? IS NULL
     OR EXISTS (SELECT 1 FROM category_memory WHERE user_id = ? AND note_key = ?)
  ON CONFLICT(user_id, note_key) DO UPDATE SET
    revision = CASE WHEN category_memory.category <> excluded.category
                    THEN category_memory.revision + 1 ELSE category_memory.revision END,
    updated_at = CASE WHEN category_memory.category <> excluded.category
                      THEN excluded.updated_at ELSE category_memory.updated_at END,
    category = CASE WHEN category_memory.category <> excluded.category
                    THEN excluded.category ELSE category_memory.category END
  WHERE ? IS NULL OR category_memory.revision = ?`;

// Keeps the newest 500 entries. The key just written is ranked first, so it is never the one removed, even if the
// clock moved backwards. Ties on `updated_at` fall back to the ID.
const EVICT_SQL = `DELETE FROM category_memory
  WHERE user_id = ?
    AND id IN (
      SELECT id FROM category_memory WHERE user_id = ?
      ORDER BY (note_key = ?) DESC, updated_at DESC, id DESC
      LIMIT -1 OFFSET ${MEMORY_ENTRY_LIMIT}
    )`;

export class CategoryMemoryService {
  #db;
  #now;

  constructor({ database = db, now = () => new Date() } = {}) {
    this.#db = requireDatabase(database);
    this.#now = now;
  }

  /** The User's entries, most recently updated first. */
  async list(userId) {
    const id = normalizeUserId(userId);
    const rows = await this.#db.prepare(
      `SELECT id, note_key, category, revision, updated_at
         FROM category_memory
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`
    ).all(id, MEMORY_ENTRY_LIMIT);
    return rows.map(entryFromRow);
  }

  /**
   * Create or replace the entry for a Note_Key. The write and the eviction beyond 500 entries run in one batch.
   * @returns {{ entry, created: boolean, evicted: boolean }}
   */
  async upsert(userId, { noteKey, category, expectedRevision } = {}) {
    const id = normalizeUserId(userId);
    const key = normalizeNoteKeyInput(noteKey);
    const chosen = normalizeCategoryInput(category);
    const expected = normalizeExpectedRevision(expectedRevision);

    const before = await this.#db.prepare(
      'SELECT id FROM category_memory WHERE user_id = ? AND note_key = ?'
    ).get(id, key);

    const timestamp = this.#now().toISOString();
    const [upserted, evictedResult] = await this.#db.batch([
      {
        sql: UPSERT_SQL,
        args: [id, key, chosen, timestamp, timestamp, expected, id, key, expected, expected],
      },
      { sql: EVICT_SQL, args: [id, id, key] },
    ]);

    // With no expected revision the statement always writes. Zero changes therefore means a revision mismatch or an
    // entry that no longer exists.
    if (upserted.changes === 0) throw revisionConflict();

    const row = await this.#db.prepare(
      `SELECT id, note_key, category, revision, updated_at
         FROM category_memory WHERE user_id = ? AND note_key = ?`
    ).get(id, key);
    if (!row) throw revisionConflict();

    return { entry: entryFromRow(row), created: before === undefined, evicted: evictedResult.changes > 0 };
  }

  /** Delete one entry. A missing entry and another User's entry both answer 404. */
  async remove(userId, entryId, { expectedRevision } = {}) {
    const id = normalizeUserId(userId);
    const expected = normalizeExpectedRevision(expectedRevision);
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw notFound();

    const result = await this.#db.prepare(
      `DELETE FROM category_memory
        WHERE id = ? AND user_id = ? AND (? IS NULL OR revision = ?)`
    ).run(entryId, id, expected, expected);
    if (result.changes > 0) return;

    const existing = await this.#db.prepare(
      'SELECT id FROM category_memory WHERE id = ? AND user_id = ?'
    ).get(entryId, id);
    throw existing ? revisionConflict() : notFound();
  }

  /** Delete every entry of the User and return how many were deleted. */
  async removeAll(userId) {
    const id = normalizeUserId(userId);
    const result = await this.#db.prepare('DELETE FROM category_memory WHERE user_id = ?').run(id);
    return result.changes;
  }

  /** Delete the User's entries that map to a category (compared without regard to letter case). */
  async removeForCategory(userId, category) {
    const { sql, args } = removeForCategoryStatement(userId, category);
    const result = await this.#db.prepare(sql).run(...args);
    return result.changes;
  }

  /**
   * The category of the most recent expense per Note_Key over the preceding 90 days, newest first, at most 500 keys.
   * `today` is an Asia/Kolkata YYYY-MM-DD date supplied by the caller. Only the User's own expenses are read.
   */
  async history(userId, { today, days = HISTORY_WINDOW_DAYS, maxKeys = HISTORY_MAX_KEYS } = {}) {
    const id = normalizeUserId(userId);
    const todayTime = parseDate(today, 'today');
    if (!Number.isSafeInteger(days) || days < 1 || days > HISTORY_WINDOW_DAYS) {
      throw new RangeError(`days must be between 1 and ${HISTORY_WINDOW_DAYS}.`);
    }
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > HISTORY_MAX_KEYS) {
      throw new RangeError(`maxKeys must be between 1 and ${HISTORY_MAX_KEYS}.`);
    }

    const windowStart = formatDate(todayTime - days * DAY_MS);
    const months = monthsBetween(windowStart, today);
    const placeholders = months.map(() => '?').join(', ');
    const rows = await this.#db.prepare(
      `SELECT note, category, spent_on
         FROM expense_log
        WHERE user_id = ?
          AND month IN (${placeholders})
          AND spent_on >= ? AND spent_on <= ?
          AND note IS NOT NULL AND TRIM(note) <> ''
        ORDER BY spent_on DESC, id DESC
        LIMIT ?`
    ).all(id, ...months, windowStart, today, HISTORY_MAX_ROWS);

    const seen = new Map();
    for (const row of rows) {
      const key = normalizeNoteKey(row.note);
      if (key === null || seen.has(key)) continue;
      seen.set(key, Object.freeze({ noteKey: key, category: row.category, lastSpentOn: row.spent_on }));
      if (seen.size >= maxKeys) break;
    }
    return [...seen.values()];
  }
}

const categoryMemoryService = new CategoryMemoryService();
export default categoryMemoryService;
