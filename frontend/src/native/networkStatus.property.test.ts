import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { ApiError, REQUEST_TIMEOUT_CODE } from '../api';
import { assertProperty } from '../test/propertyReport';
import {
  MESSAGE_GENERIC,
  MESSAGE_TIMEOUT,
  MESSAGE_UNREACHABLE,
  describeFetchFailure,
  shouldShowStaleDataNotice,
} from './networkStatus';

const FIXED_MESSAGES: readonly string[] = [MESSAGE_TIMEOUT, MESSAGE_UNREACHABLE, MESSAGE_GENERIC];

type ErrorShape = 'timeout' | 'type-error' | 'abort' | 'gateway' | 'api-other' | 'plain-error' | 'non-error';

interface GeneratedFailure {
  shape: ErrorShape;
  error: unknown;
  /** The text that must never be echoed back, or undefined for values that carry none. */
  rawMessage: string | undefined;
  expected: string;
}

// Long enough that a short generated message cannot appear inside a fixed message by chance.
const rawMessages = fc.string({ minLength: 12, maxLength: 60 }).filter((text) => (
  FIXED_MESSAGES.every((fixed) => !fixed.includes(text))
));

const failures: fc.Arbitrary<GeneratedFailure> = fc.oneof(
  rawMessages.map((message): GeneratedFailure => ({
    shape: 'timeout',
    error: new ApiError(0, message, { code: REQUEST_TIMEOUT_CODE }),
    rawMessage: message,
    expected: MESSAGE_TIMEOUT,
  })),
  rawMessages.map((message): GeneratedFailure => ({
    shape: 'type-error',
    error: new TypeError(message),
    rawMessage: message,
    expected: MESSAGE_UNREACHABLE,
  })),
  rawMessages.map((message): GeneratedFailure => {
    const error = new Error(message);
    error.name = 'AbortError';
    return { shape: 'abort', error, rawMessage: message, expected: MESSAGE_UNREACHABLE };
  }),
  fc.tuple(rawMessages, fc.constantFrom(502, 503, 504)).map(([message, status]): GeneratedFailure => ({
    shape: 'gateway',
    error: new ApiError(status, message),
    rawMessage: message,
    expected: MESSAGE_UNREACHABLE,
  })),
  fc.tuple(
    rawMessages,
    fc.integer({ min: 0, max: 599 }).filter((status) => ![502, 503, 504].includes(status)),
    fc.option(fc.constantFrom('VALIDATION', 'NOT_FOUND', 'CONFLICT', 'UNKNOWN'), { nil: undefined }),
  ).map(([message, status, code]): GeneratedFailure => ({
    shape: 'api-other',
    error: new ApiError(status, message, code ? { code } : {}),
    rawMessage: message,
    expected: MESSAGE_GENERIC,
  })),
  rawMessages.map((message): GeneratedFailure => ({
    shape: 'plain-error',
    error: new Error(message),
    rawMessage: message,
    expected: MESSAGE_GENERIC,
  })),
  fc.oneof(
    rawMessages,
    fc.integer(),
    fc.constant(null),
    fc.constant(undefined),
    fc.record({ message: rawMessages }),
  ).map((value): GeneratedFailure => ({
    shape: 'non-error',
    error: value,
    rawMessage: typeof value === 'string' ? value : undefined,
    expected: MESSAGE_GENERIC,
  })),
);

describe('networkStatus properties', () => {
  // Feature: android-app-release, Property 6: Network failures are always described without leaking raw error text, and the stale-data notice is exactly the offline-or-failed case
  it('describes every failure with one fixed message and never the raw error text (Requirement 7.5)', () => {
    assertProperty(fc.property(failures, ({ error, rawMessage, expected }) => {
      const described = describeFetchFailure(error);
      if (!FIXED_MESSAGES.includes(described)) return false;
      if (described !== expected) return false;
      return rawMessage === undefined || !described.includes(rawMessage);
    }));
  });

  // Feature: android-app-release, Property 6: Network failures are always described without leaking raw error text, and the stale-data notice is exactly the offline-or-failed case
  it('shows the stale-data notice exactly when data is on screen and the device is offline or the last fetch failed (Requirement 7.7)', () => {
    assertProperty(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (isOffline, lastFetchFailed, hasData) => (
        shouldShowStaleDataNotice({ isOffline, lastFetchFailed, hasData })
          === (hasData && (isOffline || lastFetchFailed))
      ),
    ));
  });

  it('covers all eight input combinations of the stale-data notice', () => {
    const truthTable: Array<[boolean, boolean, boolean, boolean]> = [];
    for (const isOffline of [false, true]) {
      for (const lastFetchFailed of [false, true]) {
        for (const hasData of [false, true]) {
          truthTable.push([isOffline, lastFetchFailed, hasData, hasData && (isOffline || lastFetchFailed)]);
        }
      }
    }
    for (const [isOffline, lastFetchFailed, hasData, expected] of truthTable) {
      expect(shouldShowStaleDataNotice({ isOffline, lastFetchFailed, hasData })).toBe(expected);
    }
  });
});
