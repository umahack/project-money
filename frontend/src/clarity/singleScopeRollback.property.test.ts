import { describe, expect, it, vi } from 'vitest';
import {
  deferred,
  makeEnvelope,
  makeSnapshot,
  tagPatch,
  type Deferred,
} from '../test/clarity-fixtures';
import { fc, propertyTestParameters } from '../test/test-utils';
import type { MutationEnvelope } from './contracts';
import { createClarityStore } from './clarityStore';
import {
  createMutationStatusStore,
  type MutationCommand,
  type MutationRequest,
} from './mutationStatusStore';
import { selectVisibleSnapshot } from './patchReducer';

/**
 * Feature: financial-clarity-experience, Property 22: A failed mutation rolls
 * back only its own scope.
 *
 * **Validates: Requirements 10.4, 10.5, 10.11, 10.13, 11.5**
 */

const MONTH = '2026-01';

// ---------------------------------------------------------------------------
// Independent reference model.
//
// It knows nothing about reducers, stores, or fingerprints. It tracks only an
// ordered list of pending scopes, the confirmed base version, and the Idempotency
// Key each scope is expected to use. The expected visible tag is the base tag
// followed by one `+mark` per pending scope, in submission order.
// ---------------------------------------------------------------------------
interface ScopeSpec {
  scopeKey: string;
  mark: string;
  amount: number;
  note: string;
}

class ReferenceModel {
  baseVersion: number;
  pendingOrder: string[] = [];
  private readonly marks = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly bodies = new Map<string, { amount: number; note: string }>();
  private nextKey = 1;

  constructor(baseVersion: number) {
    this.baseVersion = baseVersion;
  }

  submit(scope: ScopeSpec, body: { amount: number; note: string }, reuseKey: boolean) {
    expect(this.pendingOrder).not.toContain(scope.scopeKey);
    this.marks.set(scope.scopeKey, scope.mark);
    if (!reuseKey || !this.keys.has(scope.scopeKey)) {
      this.keys.set(scope.scopeKey, `key-${this.nextKey++}`);
    }
    this.bodies.set(scope.scopeKey, body);
    this.pendingOrder.push(scope.scopeKey);
  }

  fail(scopeKey: string) {
    this.pendingOrder = this.pendingOrder.filter((key) => key !== scopeKey);
  }

  confirm(scopeKey: string, version: number) {
    this.fail(scopeKey);
    this.keys.delete(scopeKey);
    this.baseVersion = Math.max(this.baseVersion, version);
  }

  keyOf(scopeKey: string): string {
    return this.keys.get(scopeKey)!;
  }

  bodyOf(scopeKey: string) {
    return this.bodies.get(scopeKey)!;
  }

  expectedTag(tagOfBase = `v${this.baseVersion}`): string {
    return tagOfBase + this.pendingOrder.map((key) => `+${this.marks.get(key)}`).join('');
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const scopeKeyArb = fc
  .tuple(fc.constantFrom('goal', 'expense', 'bill', 'salary', 'trip'), fc.integer({ min: 1, max: 99 }))
  .map(([kind, id]) => `${kind}:${id}`);

const scopesArb = fc
  .uniqueArray(scopeKeyArb, { minLength: 2, maxLength: 5 })
  .chain((keys) =>
    fc
      .tuple(
        ...keys.map(() => fc.record({
          amount: fc.integer({ min: 0, max: 10_000_000 }),
          note: fc.string({ maxLength: 12 }),
        })),
      )
      .map((bodies): ScopeSpec[] => keys.map((scopeKey, index) => ({
        scopeKey,
        mark: `m${index}`,
        amount: bodies[index]!.amount,
        note: bodies[index]!.note,
      }))),
  );

const failureArb = fc.record({
  message: fc.string({ minLength: 1, maxLength: 30 }).filter((text) => text.trim().length > 0),
  status: fc.option(fc.constantFrom(400, 409, 422, 500, 503), { nil: undefined }),
  code: fc.option(fc.constantFrom('INVALID', 'CONFLICT', 'UNAVAILABLE'), { nil: undefined }),
});

interface Failure {
  message: string;
  status: number | undefined;
  code: string | undefined;
}
type NextAttempt = 'retry' | 'resubmit_same_draft' | 'resubmit_edited_draft';

const scenarioArb = fc.record({
  baseVersion: fc.integer({ min: 1, max: 1000 }),
  scopes: scopesArb,
  targetIndex: fc.nat(),
  duplicateIndexes: fc.uniqueArray(fc.nat(), { maxLength: 4 }),
  duplicateAmount: fc.integer({ min: 0, max: 10_000_000 }),
  failures: fc.array(failureArb, { minLength: 1, maxLength: 3 }),
  nextAttempts: fc.array(
    fc.constantFrom<NextAttempt>('retry', 'resubmit_same_draft', 'resubmit_edited_draft'),
    { minLength: 3, maxLength: 3 },
  ),
  confirmedBump: fc.integer({ min: 1, max: 20 }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function createHarness(baseVersion: number) {
  const clarityStore = createClarityStore();
  clarityStore.dispatch({ type: 'install', snapshot: makeSnapshot(baseVersion) });
  const calls: Array<{ request: MutationRequest; response: Deferred<MutationEnvelope> }> = [];
  const onConfirmed = vi.fn();
  let keyCounter = 0;
  const store = createMutationStatusStore({
    clarityStore,
    send: (request) => {
      const response = deferred<MutationEnvelope>();
      calls.push({ request, response });
      return response.promise;
    },
    onConfirmed,
    createIdempotencyKey: () => `key-${++keyCounter}`,
    now: () => 1000,
  });
  const visible = () => selectVisibleSnapshot(clarityStore.getState(), MONTH);
  return { clarityStore, store, calls, onConfirmed, visible };
}

function commandFor(scope: ScopeSpec, body: { amount: number; note: string }): MutationCommand {
  return {
    scopeKey: scope.scopeKey,
    label: `Saving ${scope.scopeKey}`,
    path: `/finance/${scope.scopeKey.replace(':', '/')}`,
    method: 'PATCH',
    body,
    patch: tagPatch(scope.mark),
  };
}

function rejection(failure: Failure): Error {
  return Object.assign(new Error(failure.message), { status: failure.status, code: failure.code });
}

describe('Property 22: a failed mutation rolls back only its own scope', () => {
  it('blocks duplicates, restores exact confirmed values, keeps unrelated scopes, and retries the same command', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { baseVersion, scopes } = scenario;
        const target = scopes[scenario.targetIndex % scopes.length]!;
        const others = scopes.filter((scope) => scope !== target);
        const model = new ReferenceModel(baseVersion);
        const { clarityStore, store, calls, onConfirmed, visible } = createHarness(baseVersion);
        const confirmedBefore = clarityStore.getState().confirmed;
        const pristineBase = makeSnapshot(baseVersion);

        const expectVisible = () => {
          // The visible snapshot is exactly the confirmed base with the tag the model predicts;
          // no other field may differ.
          expect(visible()).toEqual({ ...pristineBase, generatedAt: model.expectedTag() });
        };

        // --- Submit every scope. Pending state and patch exist before any response. ---
        const submissions = new Map<string, ReturnType<typeof store.submit>>();
        for (const scope of scopes) {
          const body = { amount: scope.amount, note: scope.note };
          model.submit(scope, body, false);
          submissions.set(scope.scopeKey, store.submit(commandFor(scope, body)));
          expect(store.getStatus(scope.scopeKey)?.phase).toBe('pending');
          expectVisible();
        }
        expect(calls).toHaveLength(scopes.length);
        scopes.forEach((scope, index) => {
          expect(calls[index]!.request.idempotencyKey).toBe(model.keyOf(scope.scopeKey));
        });

        // --- Duplicate submissions to a pending scope are blocked and send nothing. ---
        const duplicateScopes = [...new Set(scenario.duplicateIndexes.map((index) => scopes[index % scopes.length]!))];
        for (const scope of duplicateScopes) {
          const result = await store.submit(
            commandFor(scope, { amount: scope.amount === scenario.duplicateAmount ? scope.amount + 1 : scenario.duplicateAmount, note: 'dup' }),
          );
          expect(result).toEqual({ outcome: 'duplicate' });
        }
        expect(calls).toHaveLength(scopes.length);
        expect(clarityStore.getState().pending.map((item) => item.scopeKey)).toEqual(model.pendingOrder);
        expectVisible();

        // --- Fail the target repeatedly; each time only the target scope rolls back. ---
        const otherStatusesBefore = new Map(others.map((scope) => [scope.scopeKey, store.getStatus(scope.scopeKey)]));
        let currentTargetCall = scopes.indexOf(target);
        let targetBody = { amount: target.amount, note: target.note };
        let latestTargetPromise: ReturnType<typeof store.submit> | undefined;

        for (let round = 0; round < scenario.failures.length; round += 1) {
          const failure = scenario.failures[round]!;
          const pendingTargetPromise = round === 0
            ? submissions.get(target.scopeKey)!
            : latestTargetPromise!;
          calls[currentTargetCall]!.response.reject(rejection(failure));
          const result = await pendingTargetPromise;

          model.fail(target.scopeKey);
          expect(result).toEqual({
            outcome: 'failed',
            error: { message: failure.message, status: failure.status, code: failure.code, field: undefined },
          });
          // Exact rollback: the target's patch is gone and nothing else moved.
          expect(clarityStore.getState().confirmed).toBe(confirmedBefore);
          expect(clarityStore.getState().pending.map((item) => item.scopeKey)).toEqual(model.pendingOrder);
          expect(clarityStore.getState().pending.some((item) => item.scopeKey === target.scopeKey)).toBe(false);
          expectVisible();
          expect(onConfirmed).not.toHaveBeenCalled();
          // Retry affordance data is present beside the affected scope only.
          expect(store.getStatus(target.scopeKey)).toMatchObject({
            phase: 'error',
            scopeKey: target.scopeKey,
            error: { message: failure.message },
          });
          for (const scope of others) {
            // Unrelated scopes keep the very same pending status object and were never re-sent.
            expect(store.getStatus(scope.scopeKey)).toBe(otherStatusesBefore.get(scope.scopeKey));
          }
          expect(calls).toHaveLength(scopes.length + round);

          // --- Next attempt: same command (same key and body) unless the draft was edited. ---
          if (round === scenario.failures.length - 1) break;
          const kind = scenario.nextAttempts[round]!;
          const callsBefore = calls.length;
          const keyBefore = model.keyOf(target.scopeKey);
          if (kind === 'retry') {
            model.submit(target, targetBody, true);
            latestTargetPromise = store.retry(target.scopeKey);
          } else if (kind === 'resubmit_same_draft') {
            // Same draft with members in a different order must still be the same command.
            model.submit(target, targetBody, true);
            latestTargetPromise = store.submit({
              ...commandFor(target, { note: targetBody.note, amount: targetBody.amount }),
            });
          } else {
            targetBody = { amount: targetBody.amount + 1, note: `${targetBody.note}!` };
            model.submit(target, targetBody, false);
            latestTargetPromise = store.submit(commandFor(target, targetBody));
          }
          currentTargetCall = calls.length - 1;
          expect(calls).toHaveLength(callsBefore + 1);
          const resent = calls[currentTargetCall]!.request;
          expect(resent.idempotencyKey).toBe(model.keyOf(target.scopeKey));
          expect(resent.body).toEqual(targetBody);
          expect(resent.path).toBe(calls[scopes.indexOf(target)]!.request.path);
          if (kind === 'resubmit_edited_draft') {
            expect(resent.idempotencyKey).not.toBe(keyBefore);
          } else {
            expect(resent.idempotencyKey).toBe(keyBefore);
          }
          expect(store.getStatus(target.scopeKey)?.phase).toBe('pending');
          // The re-registered patch is applied last; every other pending patch stays in place.
          expectVisible();
        }

        // --- Final retry of the original command succeeds; others remain pending. ---
        const finalKind = scenario.nextAttempts[scenario.failures.length - 1]!;
        const keyBeforeFinal = model.keyOf(target.scopeKey);
        if (finalKind === 'resubmit_edited_draft') {
          targetBody = { amount: targetBody.amount + 1, note: `${targetBody.note}?` };
          model.submit(target, targetBody, false);
          latestTargetPromise = store.submit(commandFor(target, targetBody));
        } else {
          model.submit(target, targetBody, true);
          latestTargetPromise = finalKind === 'retry'
            ? store.retry(target.scopeKey)
            : store.submit(commandFor(target, targetBody));
        }
        const finalCall = calls[calls.length - 1]!;
        expect(finalCall.request.idempotencyKey).toBe(model.keyOf(target.scopeKey));
        expect(finalCall.request.body).toEqual(targetBody);
        expect(finalCall.request.idempotencyKey === keyBeforeFinal).toBe(finalKind !== 'resubmit_edited_draft');
        expectVisible();

        const confirmedVersion = baseVersion + scenario.confirmedBump;
        const confirmedSnapshot = makeSnapshot(confirmedVersion, MONTH, `v${confirmedVersion}`);
        finalCall.response.resolve(makeEnvelope(confirmedSnapshot, target.scopeKey, finalCall.request.idempotencyKey));
        await expect(latestTargetPromise).resolves.toMatchObject({ outcome: 'confirmed' });
        model.confirm(target.scopeKey, confirmedVersion);

        expect(store.getStatus(target.scopeKey)).toMatchObject({ phase: 'success', replayed: false });
        expect(onConfirmed).toHaveBeenCalledTimes(1);
        expect(onConfirmed).toHaveBeenCalledWith(confirmedSnapshot);
        expect(clarityStore.getState().pending.map((item) => item.scopeKey)).toEqual(model.pendingOrder);
        expect(visible()).toEqual({ ...confirmedSnapshot, generatedAt: model.expectedTag(`v${confirmedVersion}`) });
        for (const scope of others) {
          expect(store.getStatus(scope.scopeKey)).toBe(otherStatusesBefore.get(scope.scopeKey));
        }

        // Settle the untouched requests so no promise is left dangling.
        for (const scope of others) calls[scopes.indexOf(scope)]!.response.reject(new Error('settled by test'));
        await Promise.all(others.map((scope) => submissions.get(scope.scopeKey)));
      }),
      propertyTestParameters,
    );
  });
});
