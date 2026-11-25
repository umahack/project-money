import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { clearAuth, setAuth } from '../api';
import { AuthProvider } from '../state';
import { assertProperty } from '../test/propertyReport';
import { createTestUser, fc, propertyTestParameters, TEST_AUTH_TOKEN } from '../test/test-utils';
import { AgreementGateProvider, useAgreementGate } from './AgreementGateProvider';

/**
 * Feature: data-use-agreement-page, Property 8: Not_Now_Choice is reset exactly on a user change
 *
 * **Validates: Requirements 3.6, 3.7**
 *
 * Drives the real AuthProvider and AgreementGateProvider. Signing in or out goes
 * through the same session storage and `auth:changed` event the application uses.
 */

type Action = 'signInA' | 'setNotNow' | 'signInB' | 'signOut';

const USER_A = createTestUser({ id: 101, email: 'user.a@example.test' });
const USER_B = createTestUser({ id: 202, email: 'user.b@example.test' });

const actionArb = fc.constantFrom<Action>('signInA', 'setNotNow', 'signInB', 'signOut');
const actionsArb = fc.array(actionArb, { minLength: 1, maxLength: 20 });

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AgreementGateProvider>{children}</AgreementGateProvider>
    </AuthProvider>
  );
}

function signIn(user: typeof USER_A): void {
  setAuth(TEST_AUTH_TOKEN, user);
}

function signOut(): void {
  clearAuth();
  window.dispatchEvent(new Event('auth:changed'));
}

describe('AgreementGateProvider Not_Now_Choice reset', () => {
  beforeEach(() => clearAuth());
  afterEach(() => clearAuth());

  it('Property 8: Not_Now_Choice is reset exactly on a user change', () => {
    assertProperty(
      fc.property(actionsArb, (actions) => {
        clearAuth();
        const { result, unmount } = renderHook(() => useAgreementGate(), { wrapper });
        // The model starts signed out with the choice unset, matching the provider's initial state.
        let currentUserId: number | null = null;
        let expectedNotNow = false;
        let ok = result.current.notNow === false;

        for (const action of actions) {
          let userChanged = false;
          act(() => {
            if (action === 'setNotNow') {
              result.current.setNotNow();
              expectedNotNow = true;
              return;
            }
            const nextId = action === 'signInA' ? USER_A.id : action === 'signInB' ? USER_B.id : null;
            userChanged = nextId !== currentUserId;
            if (action === 'signOut') signOut();
            else signIn(action === 'signInA' ? USER_A : USER_B);
            currentUserId = nextId;
            if (userChanged) expectedNotNow = false;
          });
          // Reset immediately after any user-changing action; unchanged by every other action.
          if (userChanged && result.current.notNow !== false) ok = false;
          if (result.current.notNow !== expectedNotNow) ok = false;
        }

        unmount();
        return ok;
      }),
      propertyTestParameters,
    );
  });
});
