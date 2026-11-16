import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, clearAuth, setAuth } from '../api';
import type { User } from '../types';
import { Card, Field } from '../components/ui';
import { Background } from '../components/Shell';
import { errText, useToast } from '../state';

/**
 * Dedicated entry point for admins. Reuses the regular /auth/login endpoint,
 * then verifies the returned user has is_admin===true. Non-admins get a
 * specific error and are kicked back out (we clear their just-written session
 * so they can't bypass by landing on /admin via URL).
 */
export function AdminLogin() {
  const nav = useNavigate();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const msg = sessionStorage.getItem('pm_kicked_msg');
      if (msg) { toast('err', msg); sessionStorage.removeItem('pm_kicked_msg'); }
    } catch { /* ignore */ }
  }, [toast]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r = await api.post<{ token: string; user: User }>(
        '/auth/login',
        { email: email.trim(), password },
        false,
      );
      if (!r.user?.is_admin) {
        clearAuth();
        setError('This portal is for administrators only. Use the regular sign-in page.');
        setBusy(false);
        return;
      }
      setAuth(r.token, r.user);
      nav('/admin', { replace: true });
    } catch (err) {
      setError(errText(err) || 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <>
      <Background />
      <div className="auth-wrap">
        <motion.div
          id="auth-card"
          initial={{ opacity: 0, y: 30, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', damping: 20 }}
        >
          <Card className="auth-card" tilt>
            <div className="auth-logo">
              <motion.span
                className="brand-mark big"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 8, ease: 'linear' }}
              >
                🛡️
              </motion.span>
              <h1>Admin Console</h1>
              <p className="muted">Sign in with your administrator account.</p>
            </div>

            <form onSubmit={submit} noValidate>
              <Field label="Admin email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  maxLength={254}
                  required
                  placeholder="admin@yourdomain.com"
                  inputMode="email"
                />
              </Field>
              <div className="field">
                <label htmlFor="pw" className="field-label">Password</label>
                <div className="pw-wrap">
                  <input
                    id="pw"
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                  <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)}>
                    {show ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              {error && (
                <motion.p
                  className="form-error"
                  role="alert"
                  initial={{ x: -8 }}
                  animate={{ x: [0, -6, 6, -4, 4, 0] }}
                >
                  {error}
                </motion.p>
              )}
              <motion.button
                className="btn primary block"
                whileTap={{ scale: 0.97 }}
                disabled={busy}
                type="submit"
              >
                {busy ? 'Please wait…' : 'Enter Admin Console'}
              </motion.button>
            </form>

            <p className="muted small center" style={{ marginTop: '1rem' }}>
              Not an admin? <Link className="link" to="/login">Go to user sign-in</Link>.
            </p>
          </Card>
          <p className="auth-sig muted tiny center">
            Admin portal · Built by <span className="signature">Umakanth</span>
          </p>
        </motion.div>
      </div>
    </>
  );
}
