import { Router } from 'express';
import db from '../db/index.js';
import { kolkataDateOf } from '../domain/kolkataTime.js';
import { NOTE_KEY_MAX_CODE_POINTS, normalizeNoteKey } from '../domain/noteKey.js';
import { authRequired } from '../middleware/auth.js';
import { createDataUseNoticeGate } from '../middleware/dataUse.js';
import { readServerFeatureFlags } from '../rollout/featureFlags.js';
import categoryMemoryService, {
  CategoryMemoryError,
  HISTORY_MAX_KEYS,
  HISTORY_WINDOW_DAYS,
  MEMORY_ENTRY_LIMIT,
} from '../services/categoryMemory.js';
import claritySettingsService from '../services/claritySettings.js';
import {
  EXPENSE_ACCEPTED_CONSTRAINTS,
  EXPENSE_CATEGORIES,
} from '../services/expenseMutations.js';

export const MEMORY_BODY_LIMIT_BYTES = 1024;

const MEMORY_WRITE_FIELDS = Object.freeze(['noteKey', 'category', 'expectedRevision']);
const MEMORY_WRITE_FIELD_SET = new Set(MEMORY_WRITE_FIELDS);
const PROTOTYPE_LIKE_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

export class QuickAddRequestError extends Error {
  constructor({ code, message, httpStatus, field, constraint }) {
    super(message);
    this.name = 'QuickAddRequestError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (field !== undefined) this.field = field;
    if (constraint !== undefined) this.constraint = constraint;
  }
}

function requestError(code, message, httpStatus, details = {}) {
  return new QuickAddRequestError({ code, message, httpStatus, ...details });
}

function invalidMemoryRequest(field) {
  return requestError(
    'INVALID_MEMORY_REQUEST',
    'Memory request must contain only noteKey, category, and optional expectedRevision fields with valid types.',
    400,
    field === undefined ? {} : { field }
  );
}

function invalidNoteKey() {
  return requestError(
    'INVALID_NOTE_KEY',
    `noteKey must be a normalized note of 1 to ${NOTE_KEY_MAX_CODE_POINTS} characters.`,
    400,
    { field: 'noteKey' }
  );
}

function payloadTooLarge() {
  return requestError(
    'PAYLOAD_TOO_LARGE',
    'Memory API request bodies must be at most 1 kilobyte.',
    413
  );
}

function memoryNotFound() {
  return requestError(
    'MEMORY_NOT_FOUND',
    'That remembered category choice does not exist.',
    404
  );
}

function unknownCategory() {
  return requestError(
    'UNKNOWN_EXPENSE_CATEGORY',
    'Unknown category — add it in Settings first.',
    422,
    { field: 'category', constraint: EXPENSE_ACCEPTED_CONSTRAINTS.category }
  );
}

function quickAddDisabled() {
  return requestError(
    'QUICK_ADD_DISABLED',
    'Quick Add category memory is unavailable.',
    404
  );
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsPrototypeLikeField(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || PROTOTYPE_LIKE_FIELDS.has(key)) return true;
    let child;
    try {
      child = value[key];
    } catch {
      return true;
    }
    if (containsPrototypeLikeField(child, seen)) return true;
  }
  return false;
}

function serializedBodyBytes(body) {
  if (body === undefined) return 0;
  try {
    const serialized = JSON.stringify(body);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Validate both the declared transport size and the parsed JSON value. */
export function validateMemoryBodySize({ contentLength, body }) {
  if (contentLength !== undefined) {
    if (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength)) throw invalidMemoryRequest();
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MEMORY_BODY_LIMIT_BYTES) {
      throw payloadTooLarge();
    }
  }
  if (serializedBodyBytes(body) > MEMORY_BODY_LIMIT_BYTES) throw payloadTooLarge();
}

/** Closed, typed schema for PUT /category-memory. */
export function validateMemoryWriteBody(body) {
  if (!isPlainRecord(body) || containsPrototypeLikeField(body)) throw invalidMemoryRequest();

  const keys = Object.keys(body);
  const unknown = keys.find((key) => !MEMORY_WRITE_FIELD_SET.has(key));
  // Keep the closed-schema error fixed. An unknown key is untrusted input and
  // must not be reflected into the response body.
  if (unknown !== undefined) throw invalidMemoryRequest();

  if (typeof body.noteKey !== 'string' || normalizeNoteKey(body.noteKey) !== body.noteKey) {
    throw invalidNoteKey();
  }
  if (typeof body.category !== 'string' || body.category.trim() === '') {
    throw invalidMemoryRequest('category');
  }
  if (Object.hasOwn(body, 'expectedRevision')
    && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) {
    throw invalidMemoryRequest('expectedRevision');
  }

  return {
    noteKey: body.noteKey,
    category: body.category,
    ...(Object.hasOwn(body, 'expectedRevision')
      ? { expectedRevision: body.expectedRevision }
      : {}),
  };
}

/** Closed query schema for DELETE /category-memory/:id. */
export function validateMemoryDeleteQuery(query) {
  if (!isPlainRecord(query) || containsPrototypeLikeField(query)) throw invalidMemoryRequest();
  const keys = Object.keys(query);
  if (keys.some((key) => key !== 'expectedRevision')) throw invalidMemoryRequest();
  if (!Object.hasOwn(query, 'expectedRevision')) return {};

  const raw = query.expectedRevision;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw invalidMemoryRequest('expectedRevision');
  }
  const expectedRevision = Number(raw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw invalidMemoryRequest('expectedRevision');
  }
  return { expectedRevision };
}

function validateEmptyBody(body) {
  if (body === undefined) return;
  if (!isPlainRecord(body) || containsPrototypeLikeField(body) || Object.keys(body).length !== 0) {
    throw invalidMemoryRequest();
  }
}

function validateEmptyQuery(query) {
  if (!isPlainRecord(query) || containsPrototypeLikeField(query) || Object.keys(query).length !== 0) {
    throw invalidMemoryRequest();
  }
}

function errorBody(error) {
  const responseError = { code: error.code, message: error.message };
  for (const field of ['field', 'constraint']) {
    if (Object.hasOwn(error, field)) responseError[field] = error[field];
  }
  return { error: responseError };
}

function sendKnownError(res, error) {
  if (!(error instanceof QuickAddRequestError) && !(error instanceof CategoryMemoryError)) return false;
  res.status(error.httpStatus).json(errorBody(error));
  return true;
}

function withValidation(validate) {
  return function quickAddRequestValidation(req, res, next) {
    try {
      validate(req);
      return next();
    } catch (error) {
      if (sendKnownError(res, error)) return undefined;
      return next(error);
    }
  };
}

function parseEntryId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw memoryNotFound();
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw memoryNotFound();
  return id;
}

/** Resolve a requested category to the caller's canonical built-in or custom category name. */
export async function availableCategoryFor(database, userId, requestedCategory) {
  const candidate = requestedCategory.normalize('NFKC').trim();
  const folded = candidate.toLocaleLowerCase('en-IN');
  const builtIn = EXPENSE_CATEGORIES.find(
    (category) => category.toLocaleLowerCase('en-IN') === folded
  );
  if (builtIn !== undefined) return builtIn;

  const row = await database.prepare(
    'SELECT name FROM user_categories WHERE user_id = ? AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1'
  ).get(userId, candidate);
  return row?.name ?? null;
}

export function createQuickAddRouter({
  service = categoryMemoryService,
  database = db,
  settingsService = claritySettingsService,
  readFeatureFlags = readServerFeatureFlags,
  now = () => new Date(),
} = {}) {
  if (!service
    || typeof service.list !== 'function'
    || typeof service.upsert !== 'function'
    || typeof service.remove !== 'function'
    || typeof service.removeAll !== 'function'
    || typeof service.history !== 'function') {
    throw new TypeError('A complete category memory service is required.');
  }
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A database with prepare() is required.');
  }
  if (typeof readFeatureFlags !== 'function') throw new TypeError('readFeatureFlags must be a function.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  const router = Router();
  const dataUseGate = createDataUseNoticeGate({ service: settingsService });

  router.use(authRequired);
  const memoryBodySizeGate = withValidation((req) => validateMemoryBodySize({
    contentLength: req.get('content-length'),
    body: req.body,
  }));

  router.get(
    '/quick-add/hints',
    memoryBodySizeGate,
    withValidation((req) => {
      validateEmptyBody(req.body);
      validateEmptyQuery(req.query);
    }),
    async (req, res) => {
      const today = kolkataDateOf(now());
      if (today === null) throw new RangeError('The Quick Add clock must return a valid instant.');
      const [memory, history] = await Promise.all([
        service.list(req.user.id),
        service.history(req.user.id, {
          today,
          days: HISTORY_WINDOW_DAYS,
          maxKeys: HISTORY_MAX_KEYS,
        }),
      ]);
      return res.json({
        schemaVersion: 1,
        memory,
        history,
        limits: {
          memoryEntries: MEMORY_ENTRY_LIMIT,
          historyDays: HISTORY_WINDOW_DAYS,
          historyKeys: HISTORY_MAX_KEYS,
        },
      });
    }
  );

  router.put(
    '/category-memory',
    memoryBodySizeGate,
    withValidation((req) => validateEmptyQuery(req.query)),
    function requireQuickAddEnabled(_req, res, next) {
      try {
        if (readFeatureFlags()?.quickAddEnabled !== true) {
          return res.status(404).json(errorBody(quickAddDisabled()));
        }
        return next();
      } catch (error) {
        return next(error);
      }
    },
    withValidation((req) => {
      req.categoryMemoryCommand = validateMemoryWriteBody(req.body);
    }),
    dataUseGate,
    async (req, res) => {
      try {
        const category = await availableCategoryFor(
          database,
          req.user.id,
          req.categoryMemoryCommand.category
        );
        if (category === null) throw unknownCategory();
        const result = await service.upsert(req.user.id, {
          ...req.categoryMemoryCommand,
          category,
        });
        return res.json({ schemaVersion: 1, ...result });
      } catch (error) {
        if (sendKnownError(res, error)) return undefined;
        throw error;
      }
    }
  );

  router.delete(
    '/category-memory/:id',
    memoryBodySizeGate,
    withValidation((req) => {
      validateEmptyBody(req.body);
      req.categoryMemoryDelete = {
        id: parseEntryId(req.params.id),
        ...validateMemoryDeleteQuery(req.query),
      };
    }),
    async (req, res) => {
      try {
        const { id, expectedRevision } = req.categoryMemoryDelete;
        await service.remove(req.user.id, id, { expectedRevision });
        return res.json({ schemaVersion: 1, deleted: true });
      } catch (error) {
        if (sendKnownError(res, error)) return undefined;
        throw error;
      }
    }
  );

  router.delete(
    '/category-memory',
    memoryBodySizeGate,
    withValidation((req) => {
      validateEmptyBody(req.body);
      validateEmptyQuery(req.query);
    }),
    async (req, res) => {
      const deleted = await service.removeAll(req.user.id);
      return res.json({ schemaVersion: 1, deleted });
    }
  );

  return router;
}

export default createQuickAddRouter();
