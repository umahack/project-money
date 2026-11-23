import fc from 'fast-check';

/**
 * Property runner whose failure message prints the structure of the shrunk
 * counterexample and its identifiers only. Amounts, notes, Note_Keys, and
 * category names are replaced by a type and length marker, so a failing run
 * cannot copy entry-like values into CI logs.
 *
 * The seed and path are printed so the run can be replayed:
 * `assertProperty(property, { seed, path })`.
 *
 * A twin of this file lives at `backend/test/helpers/propertyReport.js`.
 */

export const MIN_PROPERTY_RUNS = 100;

/** Keys whose values are identifiers or enumerations and so are printed as is. */
const PRINTABLE_KEY = /^(id|[a-z]+Id|ids|index|[a-z]+Index|indices|idempotencyKey|user|kind|status|source|script|form|grouping|marker|marks|dayKind|revision|stale)$/;
const MAX_LISTED_ITEMS = 12;
const MAX_DEPTH = 8;

/** Describes a generated value without printing entry values. */
export function describeStructure(value: unknown, key = '', depth = 0): string {
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
    case 'symbol':
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
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).map((name) => `${name}: ${describeStructure(record[name], name, depth + 1)}`);
  return `{ ${fields.join(', ')} }`;
}

interface FailedRun {
  numRuns: number;
  numShrinks: number;
  seed: number;
  path: string | null;
  counterexample: unknown[] | null;
  errorInstance: unknown;
}

export class PropertyFailure extends Error {
  readonly seed: number;
  readonly path: string | null;

  constructor(details: FailedRun) {
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

function finish(details: fc.RunDetails<unknown[]>): void {
  if (details.failed) throw new PropertyFailure(details as unknown as FailedRun);
}

/**
 * Runs a fast-check property with at least 100 cases. Returns undefined for a
 * synchronous property and a promise for an asynchronous one, so callers
 * `await` it either way.
 */
export function assertProperty<Ts extends unknown[]>(
  property: fc.IPropertyWithHooks<Ts> | fc.IAsyncPropertyWithHooks<Ts>,
  params: fc.Parameters<Ts> = {},
): void | Promise<void> {
  const numRuns = Math.max(MIN_PROPERTY_RUNS, params.numRuns ?? MIN_PROPERTY_RUNS);
  const run = fc.check(property as fc.IRawProperty<Ts>, { ...params, numRuns, verbose: 0 }) as unknown as
    fc.RunDetails<unknown[]> | Promise<fc.RunDetails<unknown[]>>;
  return run instanceof Promise ? run.then(finish) : finish(run);
}
