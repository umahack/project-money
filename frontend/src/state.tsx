import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, ApiError, clearAuth, getToken, getUser, setAuth } from './api';
import type { User } from './types';

// ---------- Toasts ----------
interface Toast {
  id: number;
  kind: 'ok' | 'err';
  text: string;
}
const ToastCtx = createContext<{ toast: (kind: Toast['kind'], text: string) => void }>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = next.current++;
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4800);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              className={`toast ${t.kind}`}
              initial={{ opacity: 0, y: 24, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60 }}
            >
              {t.kind === 'ok' ? '✓' : '⚠'} {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const errText = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong');

// ---------- Auth ----------
interface AuthState {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  registerStart: (name: string, email: string, password: string) => Promise<{ fallback: boolean }>;
  registerVerifyCode: (email: string, code: string) => Promise<void>;
  registerFinish: (email: string, code: string, handle: string) => Promise<void>;
  registerResend: (email: string) => Promise<{ fallback: boolean }>;
  logout: () => void;
}
const AuthCtx = createContext<AuthState | null>(null);
export const useAuth = (): AuthState => {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
};

interface AuthResponse {
  token: string;
  user: User;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // The session token lives in sessionStorage (cleared when the tab closes), exactly as in the classic UI.
  const [user, setUser] = useState<User | null>(() => (getToken() ? getUser() : null));

  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      async login(email, password) {
        const r = await api.post<AuthResponse>('/auth/login', { email, password }, false);
        setAuth(r.token, r.user);
        setUser(r.user);
      },
      async registerStart(name, email, password) {
        const r = await api.post<{ ok: true; mail?: { fallback?: boolean } }>(
          '/auth/register-start',
          { name, email, password },
          false,
        );
        return { fallback: !!r.mail?.fallback };
      },
      async registerVerifyCode(email, code) {
        await api.post('/auth/register-verify-code', { email, code }, false);
      },
      async registerFinish(email, code, handle) {
        const r = await api.post<AuthResponse>(
          '/auth/register-finish',
          { email, code, handle },
          false,
        );
        setAuth(r.token, r.user);
        setUser(r.user);
      },
      async registerResend(email) {
        const r = await api.post<{ ok: true; mail?: { fallback?: boolean } }>(
          '/auth/register-resend',
          { email },
          false,
        );
        return { fallback: !!r.mail?.fallback };
      },
      logout() {
        clearAuth();
        setUser(null);
      },
    }),
    [user],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
