import { legacyNumberToPaise } from '../domain/money.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function assertPositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function assertMonth(value, label = 'month') {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM format.`);
  }
  return value;
}

export function assertIsoInstant(value, label) {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a UTC ISO-8601 instant.`);
  }
  return value;
}

export function toSafeInteger(value, label) {
  const converted = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(converted)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  return converted;
}

export function confirmedCollection(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Confirmed repository records must be an array.');
  }
  return {
    status: 'confirmed',
    empty: records.length === 0,
    records,
  };
}

export function confirmedRecord(record) {
  return {
    status: 'confirmed',
    empty: record == null,
    record: record ?? null,
  };
}

/**
 * Remove legacy REAL amount fields and expose only integer-paise values to
 * calculation callers. Invalid historical values remain identifiable without
 * allowing floating-point values into an aggregate.
 */
export function normalizeStoredAmounts(row, mappings, { sourceType }) {
  const normalized = { ...row };
  const normalizationIssues = [];

  for (const { sourceField, targetField } of mappings) {
    const storedValue = normalized[sourceField];
    delete normalized[sourceField];
    try {
      normalized[targetField] = legacyNumberToPaise(storedValue, {
        label: `${sourceType}.${sourceField}`,
      });
    } catch (error) {
      normalized[targetField] = null;
      normalizationIssues.push({
        code: 'INVALID_STORED_AMOUNT',
        field: sourceField,
        message: error instanceof Error ? error.message : 'Stored amount is invalid.',
      });
    }
  }

  return { ...normalized, normalizationIssues };
}

export function requireDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A database adapter with prepare() is required.');
  }
  return database;
}
