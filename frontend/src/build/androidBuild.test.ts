import { describe, expect, it } from 'vitest';
import { buildCsp, isAndroidMode } from '../../build/androidBuild';

// Literal copy of the policy `frontend/vite.config.ts` produced at HEAD before the Android feature
// (`git show HEAD:frontend/vite.config.ts`), for API base https://api.example.com.
const PREVIOUS_POLICY_WITH_API = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: https://*.googleusercontent.com https://accounts.google.com",
  "font-src 'self'",
  "connect-src 'self' https://accounts.google.com/gsi/ https://api.example.com",
  'frame-src https://accounts.google.com/gsi/',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const PREVIOUS_POLICY_NO_API = PREVIOUS_POLICY_WITH_API.replace(' https://api.example.com', '');

describe('non-android build helpers', () => {
  it('keeps the default CSP byte-for-byte identical to the previous policy', () => {
    expect(buildCsp('https://api.example.com')).toBe(PREVIOUS_POLICY_WITH_API);
    expect(buildCsp('https://api.example.com', false)).toBe(PREVIOUS_POLICY_WITH_API);
    expect(buildCsp('https://api.example.com/v1/')).toBe(PREVIOUS_POLICY_WITH_API);
  });

  it('keeps the previous policy when the API base is empty or malformed', () => {
    expect(buildCsp('')).toBe(PREVIOUS_POLICY_NO_API);
    expect(buildCsp('not a url')).toBe(PREVIOUS_POLICY_NO_API);
  });

  it('still allows the Google Identity Services origins', () => {
    const csp = buildCsp('https://api.example.com');
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).toContain('https://accounts.google.com/gsi/style');
    expect(csp).toContain('frame-src https://accounts.google.com/gsi/');
    expect(csp).toContain('https://*.googleusercontent.com');
  });

  it('is not android mode for production or development', () => {
    expect(isAndroidMode('production')).toBe(false);
    expect(isAndroidMode('development')).toBe(false);
    expect(isAndroidMode('android')).toBe(true);
  });
});
