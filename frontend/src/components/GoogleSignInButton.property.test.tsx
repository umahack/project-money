import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertProperty } from '../test/propertyReport';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('../platform', () => ({ isNativePlatform: () => platform.native }));

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

type Loaded = Awaited<ReturnType<typeof loadFresh>>;

/**
 * The client id is read once at module scope, so the "present" and "absent"
 * variants each get their own module graph (React and Testing Library included,
 * so a graph has one React instance).
 */
async function loadFresh(clientId: string) {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  const rtl = await import('@testing-library/react');
  const mod = await import('./GoogleSignInButton');
  return { ...rtl, ...mod };
}

let withClientId: Loaded;
let withoutClientId: Loaded;

beforeAll(async () => {
  withClientId = await loadFresh(CLIENT_ID);
  withoutClientId = await loadFresh('');
});

afterAll(() => {
  document.querySelectorAll('script').forEach((s) => {
    if (s.src.includes('accounts.google.com')) s.remove();
  });
  vi.unstubAllEnvs();
});

describe('Google sign-in visibility', () => {
  /**
   * Feature: android-app-release, Property 2: Google sign-in affordance appears exactly off native
   *
   * **Validates: Requirements 2.2, 2.3**
   *
   * For any mode, disabled flag, native-platform result, and client-id configuration,
   * GoogleSignInButton and AuthDivider render nothing on native, and render their normal
   * output off native when a client id is configured (web without a client id is unchanged:
   * nothing). On native, no Google script is requested.
   */
  it('renders output exactly when the platform is not native (and a client id is configured)', () => {
    assertProperty(
      fc.property(
        fc.constantFrom<'login' | 'register'>('login', 'register'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (mode, disabled, isNative, clientIdPresent) => {
          const { render, cleanup, GoogleSignInButton, AuthDivider } = clientIdPresent ? withClientId : withoutClientId;
          platform.native = isNative;
          document.querySelectorAll('script').forEach((s) => s.remove());

          const button = render(<GoogleSignInButton onCredential={() => undefined} mode={mode} disabled={disabled} />);
          const buttonEmpty = button.container.innerHTML === '';
          cleanup();
          const divider = render(<AuthDivider />);
          const dividerText = divider.container.textContent;
          const dividerEmpty = divider.container.innerHTML === '';
          cleanup();

          const visible = !isNative && clientIdPresent;
          expect(buttonEmpty).toBe(!visible);
          expect(dividerEmpty).toBe(!visible);
          if (visible) expect(dividerText).toBe('or');
          if (isNative) expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
        },
      ),
    );
  });
});
