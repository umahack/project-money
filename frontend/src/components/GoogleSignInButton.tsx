import { useEffect, useRef, useState } from 'react';
import { isNativePlatform } from '../platform';

// Minimal GSI types — the library isn't on npm, so we just declare what we
// use. See https://developers.google.com/identity/gsi/web/reference/js-reference.
interface CredentialResponse {
  credential: string;
}
interface GsiButtonConfig {
  type: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill';
  logo_alignment?: 'left' | 'center';
  width?: number;
}
interface GsiIdApi {
  initialize: (opts: {
    client_id: string;
    callback: (r: CredentialResponse) => void;
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
    ux_mode?: 'popup' | 'redirect';
  }) => void;
  renderButton: (el: HTMLElement, config: GsiButtonConfig) => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiIdApi } };
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiPromise: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (gsiPromise) return gsiPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google?.accounts?.id) return Promise.resolve();
  gsiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsiPromise = null;
      reject(new Error('Could not load Google Sign-In script'));
    };
    document.head.appendChild(s);
  });
  return gsiPromise;
}

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

type GoogleSignInButtonProps = {
  onCredential: (credential: string) => void | Promise<void>;
  onError?: (message: string) => void;
  mode?: 'login' | 'register';
  disabled?: boolean;
};

/**
 * Google sign-in is web-only: on a native (Capacitor) runtime this renders
 * nothing and never mounts the inner component, so the GSI script is never
 * requested. The check lives in this wrapper so the inner component's hooks
 * always run in the same order.
 */
export function GoogleSignInButton(props: GoogleSignInButtonProps) {
  if (isNativePlatform()) return null;
  return <WebGoogleSignInButton {...props} />;
}

function WebGoogleSignInButton({
  onCredential,
  onError,
  mode = 'login',
  disabled = false,
}: GoogleSignInButtonProps) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!CLIENT_ID) {
      setErr('Google sign-in is not configured.');
      return;
    }
    let cancelled = false;
    void loadGsi()
      .then(() => {
        if (cancelled) return;
        const api = window.google?.accounts?.id;
        if (!api || !host.current) return;
        // Clear any previously-rendered button. StrictMode double-invokes this
        // effect in dev; without the clear, two buttons stack and produce a
        // "Sign up with GoogleSign up with Google" double label.
        host.current.innerHTML = '';
        api.initialize({
          client_id: CLIENT_ID,
          callback: (r) => {
            if (r?.credential) void onCredential(r.credential);
          },
          auto_select: false,
          use_fedcm_for_prompt: true,
        });
        api.renderButton(host.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: mode === 'register' ? 'signup_with' : 'signin_with',
          shape: 'pill',
          logo_alignment: 'left',
          width: 280,
        });
        setReady(true);
      })
      .catch((e: Error) => {
        setErr(e.message);
        onError?.(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (!CLIENT_ID) return null;  // silently hide if the env var isn't set
  return (
    <div style={{ display: 'grid', placeItems: 'center', margin: '0.6rem 0 0.9rem' }}>
      <div
        ref={host}
        style={{
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
          minHeight: ready ? 44 : 0,
          // Hard-cap the button container. When GSI falls back (e.g. the
          // Google Console origin doesn't match the current URL), its SVG
          // can otherwise balloon to the full card width.
          width: 280,
          maxWidth: '100%',
          overflow: 'hidden',
        }}
      />
      {err && <small className="muted">{err}</small>}
    </div>
  );
}

/** Divider — "or" between the Google button and the email form. */
export function AuthDivider() {
  if (isNativePlatform()) return null;
  if (!CLIENT_ID) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        color: 'var(--muted)',
        fontSize: '0.8rem',
        margin: '0.6rem 0',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'rgba(0,0,0,0.12)' }} />
      or
      <span style={{ flex: 1, height: 1, background: 'rgba(0,0,0,0.12)' }} />
    </div>
  );
}
