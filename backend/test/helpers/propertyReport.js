import fc from 'fast-check';

/**
 * Property runner whose failure message prints the structure of the shrunk
 * counterexample and its identifiers only. Amounts, notes, Note_Keys, and
 * category names are replaced by a type and length marker, so a failing run
 * cannot copy entry-like values into CI logs (Requirement 17.19 spirit).
 *
 * The seed and path are printed so the run can be replayed:
 * `assertProperty(property, { seed, path })`.
 */

export const MIN_PROPERTY_RUNS = 100;

/** Keys whose values are identifiers or enumerations and so are printed as is. */
const PRINTABLE_KEY = /^(id|[a-z]+Id|ids|index|[a-z]+Index|indices|idempotencyKey|user|kind|status|source|script|form|grouping|marker|marks|dayKind|revision|stale)$/;
const MAX_LISTED_ITEMS = 12;
const MAX_DEPTH = 8;

/** Describes a generated value without printing entry values. */
export function describeStructure(value, key = '', depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const printable = PRINTABLE_KEY.test(key);
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'number':
      return printable ? String(value) : '<number>';
    case 'bigint':
      return '<bigint>';
    case 'string':
      return printable ? JSON.stringify(value) : `<string length=${[...value].length}>`;
    case 'function':
      return '<function>';
    default:
  }
  if (depth >= MAX_DEPTH) return '<nested>';
  if (Array.isArray(value)) {
    const listed = value.slice(0, MAX_LISTED_ITEMS).map((item) => describeStructure(item, key, depth + 1));
    const more = value.length > MAX_LISTED_ITEMS ? `, ...${value.length - MAX_LISTED_ITEMS} more` : '';
    return `[${value.length} items: ${listed.join(', ')}${more}]`;
  }
  if (value instanceof Date) return '<date>';
  const fields = Object.keys(value).map((name) => `${name}: ${describeStructure(value[name], name, depth + 1)}`);
  return `{ ${fields.join(', ')} }`;
}

export class PropertyFailure extends Error {
  constructor(details) {
    const counterexample = (details.counterexample ?? []).map((arg) => describeStructure(arg)).join(' | ');
    const cause = details.errorInstance instanceof Error
      ? `threw ${details.errorInstance.name}`
      : 'predicate returned false';
    super(
      `Property failed after ${details.numRuns} runs (seed ${details.seed}, path "${details.path}", `
      + `${details.numShrinks} shrinks); ${cause}. Counterexample structure: ${counterexample}`,
    );
    this.name = 'PropertyFailure';
    this.seed = details.seed;
    this.path = details.path;
  }
}

function finish(details) {
  if (details.failed) throw new PropertyFailure(details);
}

/**
 * Runs a fast-check property with at least 100 cases. Returns undefined for a
 * synchronous property and a promise for an asynchronous one, so callers
 * `await` it either way.
 */
export function assertProperty(property, params = {}) {
  const numRuns = Math.max(MIN_PROPERTY_RUNS, params.numRuns ?? MIN_PROPERTY_RUNS);
  const run = fc.check(property, { ...params, numRuns, verbose: 0 });
  return run instanceof Promise ? run.then(finish) : finish(run);
}
