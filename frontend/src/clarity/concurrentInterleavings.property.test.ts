import { describe, expect, it } from 'vitest';
import { fc } from '../test/test-utils';
import {
  deferred,
  makeEnvelope,
  makeSnapshot,
  tagPatch,
  type Deferred,
} from '../test/clarity-fixtures';
import type { MutationEnvelope } from './contracts';
import { createClarityStore } from './clarityStore';
import { createMutationStatusStore } from './mutationStatusStore';
import { isScopePending, selectVisibleSnapshot } from './patchReducer';

/**
 * Feature: financial-clarity-experience, Property 23: Concurrent mutation
 * interleavings are isolated.
 *
 * **Validates: Requirements 10.2, 10.3, 10.9, 10.10, 10.12, 10.15**
 *
 * The real clarity store and mutation status store are driven with generated
 * submissions, retries, refreshes, and out-of-order success/failure responses.
 * After every step the visible snapshot of each month is compared with an
 * independent reference model: the highest-version confirmed snapshot plus the
 * still-pending patches in submission order.
 */

const MONTHS = ['2026-01', '2026-02'] as const;
const SCOPES = ['goal:17', 'expense:9', 'salary:2026-01', 'trip:3'] as const;
const MONTH_FILTERS: ReadonlyArray<readonly string[] | undefined> = [
  undefined,
  ['2026-01'],
  ['2026-02'],
  ['2026-01', '2026-02'],
];
const INITIAL_VERSION = 3;

type Phase = 'pending' | 'success' | 'error';

interface Resolution {
  ok: boolean;
  month: number;
  version: number;
}

type Op =
  | { kind: 'submit'; scope: number; filter: number }
  | { kind: 'retry'; scope: number }
  | { kind: 'refresh'; month: number; version: number }
  | { kind: 'resolve'; pick: number; resolution: Resolution };

const resolutionArb: fc.Arbitrary<Resolution> = fc.record({
  ok: fc.boolean(),
  month: fc.nat(MONTHS.length - 1),
  // Spans below, equal to, and above the initial version so stale responses occur.
  version: fc.integer({ min: 1, max: 12 }),
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('submit' as const), scope: fc.nat(SCOPES.length - 1), filter: fc.nat(MONTH_FILTERS.length - 1) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('retry' as const), scope: fc.nat(SCOPES.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('refresh' as const), month: fc.nat(MONTHS.length - 1), version: fc.integer({ min: 1, max: 12 }) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('resolve' as const), pick: fc.nat(), resolution: resolutionArb }) },
);

const scenarioArb = fc.record({
  ops: fc.array(opArb, { minLength: 1, maxLength: 30 }),
  drain: fc.array(resolutionArb, { minLength: SCOPES.length, maxLength: SCOPES.length }),
  drainReversed: fc.boolean(),
});

// ---- Independent reference model -------------------------------------------

interface ModelConfirmed {
  version: number;
  tag: string;
}

interface ModelPending {
  scope: string;
  mark: string;
  months?: readonly string[];
}

class Model {
  confirmed = new Map<string, ModelConfirmed>();
  pending: ModelPending[] = [];
  phase = new Map<string, Phase>();
  /** Last submitted command per scope, kept only until it is confirmed. */
  commands = new Map<string, { mark: string; months?: readonly string[] }>();

  install(month: string, version: number, tag: string) {
    const current = this.confirmed.get(month);
    // Documented reducer behavior: only a strictly newer confirmed version blocks
    // an install; an equal version replaces the base.
    if (!current || version >= current.version) this.confirmed.set(month, { version, tag });
  }

  submit(scope: string, mark: string, months?: readonly string[]) {
    if (this.pending.some((item) => item.scope === scope)) return false;
    this.pending.push({ scope, mark, months });
    this.commands.set(scope, { mark, months });
    this.phase.set(scope, 'pending');
    return true;
  }

  retry(scope: string) {
    const command = this.commands.get(scope);
    if (!command || this.phase.get(scope) !== 'error') return false;
    return this.submit(scope, command.mark, command.months);
  }

  succeed(scope: string, month: string, version: number, tag: string) {
    this.install(month, version, tag);
    this.pending = this.pending.filter((item) => item.scope !== scope);
    this.commands.delete(scope);
    this.phase.set(scope, 'success');
  }

  fail(scope: string) {
    this.pending = this.pending.filter((item) => item.scope !== scope);
    this.phase.set(scope, 'error');
  }

  visible(month: string) {
    const base = this.confirmed.get(month);
    if (!base) return undefined;
    let tag = base.tag;
    for (const item of this.pending) {
      if (!item.months || item.months.includes(month)) tag += `+${item.mark}`;
    }
    return { version: base.version, tag };
  }
}

// ---- Harness driving the real stores ---------------------------------------

interface InFlight {
  scope: string;
  response: Deferred<MutationEnvelope>;
  done: Promise<unknown>;
}

function createHarness() {
  const clarityStore = createClarityStore();
  const model = new Model();
  for (const month of MONTHS) {
    const snapshot = makeSnapshot(INITIAL_VERSION, month, `base-${month}`);
    clarityStore.dispatch({ type: 'install', snapshot });
    model.install(month, INITIAL_VERSION, `base-${month}`);
  }

  const inFlight: InFlight[] = [];
  const responses = new Map<string, Deferred<MutationEnvelope>>();
  let keyCounter = 0;
  const store = createMutationStatusStore({
    clarityStore,
    send: (request) => {
      const response = deferred<MutationEnvelope>();
      responses.set(request.path, response);
      return response.promise;
    },
    createIdempotencyKey: () => `key-${++keyCounter}`,
    now: () => 1000,
  });

  let markCounter = 0;
  let snapshotCounter = 0;
  const marks = new Map<string, string>();

  function track(scope: string, done: Promise<unknown>) {
    const response = responses.get(`/finance/${scope}`);
    if (!response) throw new Error(`send was not called for ${scope}`);
    responses.delete(`/finance/${scope}`);
    inFlight.push({ scope, response, done });
  }

  function submit(scopeIndex: number, filterIndex: number) {
    const scope = SCOPES[scopeIndex]!;
    const months = MONTH_FILTERS[filterIndex];
    const mark = `m${++markCounter}`;
    const accepted = model.submit(scope, mark, months);
    const done = store.submit({
      scopeKey: scope,
      label: `Saving ${scope}`,
      path: `/finance/${scope}`,
      method: 'PATCH',
      body: { mark },
      patch: tagPatch(mark),
      months,
    });
    if (accepted) {
      marks.set(scope, mark);
      track(scope, done);
    }
  }

  function retry(scopeIndex: number) {
    const scope = SCOPES[scopeIndex]!;
    const accepted = model.retry(scope);
    const done = store.retry(scope);
    if (accepted) track(scope, done);
  }

  async function resolve(pick: number, resolution: Resolution) {
    if (inFlight.length === 0) return;
    const [entry] = inFlight.splice(pick % inFlight.length, 1);
    if (!entry) return;
    const month = MONTHS[resolution.month]!;
    if (resolution.ok) {
      const tag = `s${++snapshotCounter}`;
      model.succeed(entry.scope, month, resolution.version, tag);
      entry.response.resolve(makeEnvelope(makeSnapshot(resolution.version, month, tag), entry.scope));
    } else {
      model.fail(entry.scope);
      entry.response.reject({ message: 'Server unavailable', status: 503 });
    }
    await entry.done;
  }

  function refresh(monthIndex: number, version: number) {
    const month = MONTHS[monthIndex]!;
    const tag = `r${++snapshotCounter}`;
    clarityStore.dispatch({ type: 'install', snapshot: makeSnapshot(version, month, tag) });
    model.install(month, version, tag);
  }

  function assertMatchesModel() {
    const state = clarityStore.getState();
    for (const month of MONTHS) {
      const visible = selectVisibleSnapshot(state, month);
      const expected = model.visible(month)!;
      expect(visible?.generatedAt).toBe(expected.tag);
      // Confirmed version tracks the reference and the visible base is never older than it.
      expect(state.confirmed[month]?.dataVersion).toBe(expected.version);
      expect(visible?.dataVersion).toBe(expected.version);
    }
    // Pending patches are exactly the model's, in submission order.
    expect(state.pending.map((item) => item.scopeKey)).toEqual(model.pending.map((item) => item.scope));
    for (const scope of SCOPES) {
      const modelPending = model.pending.some((item) => item.scope === scope);
      // Scopes with nothing pending stay available for new submissions (unrelated controls enabled).
      expect(isScopePending(state, scope)).toBe(modelPending);
      expect(store.getStatus(scope)?.phase).toBe(model.phase.get(scope));
    }
  }

  return { clarityStore, model, inFlight, submit, retry, resolve, refresh, assertMatchesModel };
}

describe('Property 23: Concurrent mutation interleavings are isolated', () => {
  it('visible state equals the highest-version base plus ordered pending patches for any interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ ops, drain, drainReversed }) => {
        const harness = createHarness();
        harness.assertMatchesModel();
        const seenVersions = new Map<string, number>(MONTHS.map((month) => [month, INITIAL_VERSION]));

        const checkStep = () => {
          harness.assertMatchesModel();
          // An older response never regresses a confirmed month.
          const state = harness.clarityStore.getState();
          for (const month of MONTHS) {
            const version = state.confirmed[month]!.dataVersion;
            expect(version).toBeGreaterThanOrEqual(seenVersions.get(month)!);
            seenVersions.set(month, version);
          }
        };

        for (const op of ops) {
          switch (op.kind) {
            case 'submit':
              harness.submit(op.scope, op.filter);
              break;
            case 'retry':
              harness.retry(op.scope);
              break;
            case 'refresh':
              harness.refresh(op.month, op.version);
              break;
            case 'resolve':
              await harness.resolve(op.pick, op.resolution);
              break;
          }
          checkStep();
        }

        // Resolve everything still in flight, optionally newest first.
        const order = drainReversed ? -1 : 0;
        let index = 0;
        while (harness.inFlight.length > 0) {
          const resolution = drain[index % drain.length]!;
          index += 1;
          await harness.resolve(order === -1 ? harness.inFlight.length - 1 : 0, resolution);
          checkStep();
        }

        // With nothing in flight, visible state is exactly the confirmed base.
        const state = harness.clarityStore.getState();
        expect(state.pending).toHaveLength(0);
        for (const month of MONTHS) {
          expect(selectVisibleSnapshot(state, month)).toBe(state.confirmed[month]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
