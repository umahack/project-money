import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertProperty } from './test/propertyReport';
import { clearToken, getToken, setToken } from './tokenStore';

describe('tokenStore round trip', () => {
  /**
   * Feature: android-app-release, Property 1: Token round trip and clearing
   *
   * **Validates: Requirements 1.3, 1.4**
   *
   * For any token string, setToken followed by getToken returns that exact string, and clearToken
   * afterward makes getToken return null. Nothing is written to localStorage.
   */
  it('returns the stored token exactly and returns null after clearToken', () => {
    assertProperty(
      fc.property(fc.string({ maxLength: 512 }), (token) => {
        sessionStorage.clear();
        localStorage.clear();

        setToken(token);
        expect(getToken()).toBe(token);
        expect(sessionStorage.getItem('pm_token')).toBe(token);
        expect(localStorage.length).toBe(0);

        clearToken();
        expect(getToken()).toBeNull();
        expect(sessionStorage.getItem('pm_token')).toBeNull();
      }),
    );
  });
});
