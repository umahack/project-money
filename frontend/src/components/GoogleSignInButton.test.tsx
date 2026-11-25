import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('../platform', () => ({ isNativePlatform: () => platform.native }));

const GSI_SRC = 'https://accounts.google.com/gsi/client';

/**
 * The component reads VITE_GOOGLE_CLIENT_ID and caches the script promise at
 * module scope, so each test imports a fresh copy of the module graph (React and
 * Testing Library included, so they share one React instance).
 */
async function loadFresh(clientId: string) {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  const rtl = await import('@testing-library/react');
  const mod = await import('./GoogleSignInButton');
  return { ...rtl, ...mod };
}

function gsiScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>('script')).filter((s) =>
    s.src.includes('accounts.google.com'),
  );
}

afterEach(() => {
  gsiScripts().forEach((s) => s.remove());
  platform.native = false;
});

describe('Google Identity Services script loading', () => {
  it('is never added to the document on a native platform', async () => {
    platform.native = true;
    const { render, cleanup, GoogleSignInButton, AuthDivider } = await loadFresh('test-client-id.apps.googleusercontent.com');

    const { container } = render(
      <>
        <GoogleSignInButton onCredential={() => undefined} mode="login" />
        <AuthDivider />
      </>,
    );
    await Promise.resolve();

    expect(container).toBeEmptyDOMElement();
    expect(gsiScripts()).toHaveLength(0);
    expect(document.querySelector(`script[src="${GSI_SRC}"]`)).toBeNull();
    cleanup();
  });

  it('is added to the document on web when a client id is configured', async () => {
    platform.native = false;
    const { render, cleanup, GoogleSignInButton } = await loadFresh('test-client-id.apps.googleusercontent.com');

    render(<GoogleSignInButton onCredential={() => undefined} mode="login" />);

    const scripts = gsiScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(GSI_SRC);
    cleanup();
  });

  it('is not added on web when no client id is configured', async () => {
    platform.native = false;
    const { render, cleanup, GoogleSignInButton } = await loadFresh('');

    render(<GoogleSignInButton onCredential={() => undefined} mode="login" />);

    expect(gsiScripts()).toHaveLength(0);
    cleanup();
  });
});
