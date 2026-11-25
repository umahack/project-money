import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assertProperty } from '../test/propertyReport';
import { buildCsp, validateAndroidApiBase } from '../../build/androidBuild';

const label = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);
const hostname = fc
  .tuple(fc.array(label, { minLength: 0, maxLength: 2 }), label, fc.constantFrom('com', 'dev', 'io', 'onrender.com'))
  .map(([subs, name, tld]) => [...subs, name, tld].join('.'));
const port = fc.option(fc.integer({ min: 1, max: 65535 }).filter((p) => p !== 443), { nil: undefined });
// Upper-case Q_ never occurs in a lower-cased hostname or in any CSP keyword, so a path hit is a real leak.
const pathSegment = fc.stringMatching(/^Q_[A-Za-z0-9]{1,8}$/);
const path = fc.array(pathSegment, { minLength: 0, maxLength: 3 }).map((segs) => segs.map((s) => '/' + s).join(''));

interface ApiBase {
  origin: string;
  path: string;
  value: string;
}

/** A valid https API base, with or without a trailing slash or a path. */
const httpsApiBase: fc.Arbitrary<ApiBase> = fc
  .tuple(hostname, port, path, fc.boolean())
  .map(([host, p, pathPart, trailingSlash]) => {
    const origin = `https://${host}${p === undefined ? '' : ':' + p}`;
    return { origin, path: pathPart, value: origin + pathPart + (trailingSlash ? '/' : '') };
  });

const badApiBase: fc.Arbitrary<string | undefined | null> = fc.oneof(
  fc.constantFrom<string | undefined | null>(undefined, null, '', ' ', '\t\n', 'https://', 'https:///', 'https://:443', 'https:// '),
  hostname.map((h) => `http://${h}`),
  hostname.map((h) => `ftp://${h}/files`),
  hostname.map((h) => `//${h}`),
  hostname.map((h) => ` https://${h}`),
  hostname.map((h) => h),
  fc.string().filter((s) => !s.startsWith('https://')),
);

describe('android build properties', () => {
  // Feature: android-app-release, Property 7: The Android build mode rejects every non-https/missing API base and accepts every https one
  // Validates: Requirements 8.4
  it('Property 7: accepts exactly https URLs with a hostname and rejects the rest naming VITE_API_BASE', () => {
    assertProperty(
      fc.property(httpsApiBase, ({ value }) => {
        expect(validateAndroidApiBase(value)).toBe(value);
      }),
    );
    assertProperty(
      fc.property(badApiBase, (value) => {
        let message = '';
        try {
          validateAndroidApiBase(value);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain('VITE_API_BASE');
      }),
    );
  });

  // Feature: android-app-release, Property 8: The Android-mode Content-Security-Policy never references Google and always scopes `connect-src` to self and the API origin
  // Validates: Requirements 2.6, 8.6
  it('Property 8: the Android CSP scopes connect-src to self and the API origin, with no Google and no unsafe-eval', () => {
    assertProperty(
      fc.property(httpsApiBase, ({ origin, path: pathPart, value }) => {
        const csp = buildCsp(value, true);
        const directives = csp.split('; ');
        expect(csp).toContain(`connect-src 'self' ${origin}`);
        expect(directives).toContain(`connect-src 'self' ${origin}`);
        expect(csp).not.toContain('accounts.google.com');
        expect(csp).not.toContain('unsafe-eval');
        expect(directives).toContain("frame-src 'none'");
        if (pathPart) expect(csp).not.toContain(pathPart);
      }),
    );
  });
});
