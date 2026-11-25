import test, { after, before } from 'node:test';
import fc from 'fast-check';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import { assertProperty } from '../helpers/propertyReport.js';

/*
 * Feature: android-app-release, Property 10: The CORS allowlist accepts exactly its configured origins
 *
 * Validates: Requirements 15.1, 15.2, 15.3
 *
 * Statement (design.md): for any generated allowlist of distinct origin strings and any generated candidate origin
 * (drawn half the time from the allowlist itself and half the time from near-miss variants: a different scheme, a
 * different port, an added trailing slash, or a different host sharing a suffix with an allowlisted entry),
 * `resolveCorsOrigin`'s callback allows the candidate if and only if the candidate is byte-for-byte a member of the
 * allowlist.
 *
 * The expected answer is computed from set membership of the generated entries, so a near-miss that happens to equal
 * another entry is correctly expected to be allowed.
 */
let testDatabase;
let resolveCorsOrigin;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  ({ resolveCorsOrigin } = await import('../../src/app.js'));
});

after(async () => {
  await testDatabase?.cleanup();
});

const labelArb = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);
const hostArb = fc.oneof(
  fc.constant('localhost'),
  fc.array(labelArb, { minLength: 1, maxLength: 3 }).map((labels) => labels.join('.')),
);
const schemeArb = fc.constantFrom('http', 'https');
const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });

const originArb = fc
  .record({ scheme: schemeArb, host: hostArb, port: portArb })
  .map(({ scheme, host, port }) => `${scheme}://${host}${port === undefined ? '' : `:${port}`}`);

/** Allowlist plus how its entries are written in the CORS_ORIGIN value. */
const allowlistArb = fc.record({
  entries: fc.uniqueArray(originArb, { minLength: 1, maxLength: 6 }),
  padding: fc.constantFrom('', ' '),
});

/** A near-miss variant of an allowlisted entry. */
function nearMiss(entry, kind, salt) {
  const url = new URL(entry);
  const scheme = url.protocol.slice(0, -1);
  switch (kind) {
    case 'scheme':
      return entry.replace(/^https?/, scheme === 'https' ? 'http' : 'https');
    case 'port':
      return `${scheme}://${url.hostname}:${url.port === '4000' ? '4001' : '4000'}`;
    case 'trailing-slash':
      return `${entry}/`;
    case 'suffix-host-prefix':
      return `${scheme}://${salt}.${url.host}`;
    case 'suffix-host-glued':
      return `${scheme}://${salt}${url.host}`;
    case 'suffix-host-tail':
      return `${entry}.${salt}.example`;
    case 'case':
      return entry.toUpperCase();
    default:
      return `${entry}${salt}`;
  }
}

const NEAR_MISS_KINDS = [
  'scheme',
  'port',
  'trailing-slash',
  'suffix-host-prefix',
  'suffix-host-glued',
  'suffix-host-tail',
  'case',
  'appended',
];

const candidateArb = (entries) =>
  fc.oneof(
    // Half: drawn from the allowlist itself.
    fc.constantFrom(...entries),
    // Half: near-miss variants, unrelated origins, and odd literals.
    fc
      .record({
        entryIndex: fc.nat({ max: entries.length - 1 }),
        kind: fc.constantFrom(...NEAR_MISS_KINDS),
        salt: labelArb,
      })
      .map(({ entryIndex, kind, salt }) => nearMiss(entries[entryIndex], kind, salt)),
  );

test('Property 10: the CORS allowlist accepts exactly its configured origins', () => {
  assertProperty(
    fc.property(
      allowlistArb.chain(({ entries, padding }) =>
        fc.record({
          entries: fc.constant(entries),
          padding: fc.constant(padding),
          candidates: fc.array(candidateArb(entries), { minLength: 4, maxLength: 12 }),
        }),
      ),
      ({ entries, padding, candidates }) => {
        const rawOrigin = entries.join(`${padding},${padding}`);
        const originCallback = resolveCorsOrigin(rawOrigin, true);
        const members = new Set(entries);

        for (const candidate of candidates) {
          let outcome;
          originCallback(candidate, (error, allowed) => {
            outcome = { error, allowed };
          });
          const expected = members.has(candidate);
          const allowed = outcome.error === null && outcome.allowed === true;
          if (allowed !== expected) return false;
          if (!expected && !(outcome.error instanceof Error)) return false;
        }
        return true;
      },
    ),
  );
});

test('Property 10: every configured entry is itself allowed and no wildcard is ever produced', () => {
  assertProperty(
    fc.property(allowlistArb, ({ entries, padding }) => {
      const originCallback = resolveCorsOrigin(entries.join(`${padding},${padding}`), true);
      for (const entry of entries) {
        let outcome;
        originCallback(entry, (error, allowed) => {
          outcome = { error, allowed };
        });
        if (outcome.error !== null || outcome.allowed !== true) return false;
      }
      // `null` and `*` are never members of a generated allowlist, so both are rejected.
      for (const literal of ['null', '*']) {
        let outcome;
        originCallback(literal, (error, allowed) => {
          outcome = { error, allowed };
        });
        if (!(outcome.error instanceof Error)) return false;
      }
      return true;
    }),
  );
});
