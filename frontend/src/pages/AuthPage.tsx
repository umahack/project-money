import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card, Field } from '../components/ui';
import { Background } from '../components/Shell';
import { errText, useAuth } from '../state';

const RULES = [
  { key: 'len', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { key: 'letter', label: 'Contains a letter', test: (p: string) => /[A-Za-z]/.test(p) },
  { key: 'number', label: 'Contains a number', test: (p: string) => /\d/.test(p) },
  { key: 'space', label: 'No leading or trailing spaces', test: (p: string) => p.length > 0 && p === p.trim() },
];

function friendly(message: string, mode: 'login' | 'register'): string {
  if (/invalid credentials/i.test(message)) return 'Email or password is incorrect.';
  if (/too many/i.test(message)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (/already registered/i.test(message)) return 'That email is already registered. Try signing in instead.';
  return message || (mode === 'login' ? 'Could not sign you in. Please try again.' : 'Something went wrong. Please try again.');
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const checks = RULES.map((r) => ({ ...r, ok: r.test(password) }));
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'register') {
      if (!name.trim()) return setError('Please enter your name.');
      if (!emailOk) return setError('That email looks off. Check for typos.');
      const missing = checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase());
      if (missing.length) return setError(`Your password needs: ${missing.join(', ')}.`);
    }
    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(name.trim(), email.trim(), password);
      nav('/', { replace: true });
    } catch (err) {
      setError(friendly(errText(err), mode));
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';
  return (
    <>
      <Background />
      <div className="auth-wrap">
        <motion.div initial={{ opacity: 0, y: 30, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', damping: 20 }}>
          <Card className="auth-card" tilt>
            <div className="auth-logo">
              <motion.span className="brand-mark big" animate={{ rotateY: 360 }} transition={{ repeat: Infinity, duration: 5, ease: 'linear' }}>₹</motion.span>
              <h1>{isLogin ? 'Welcome back' : 'Create your account'}</h1>
              <p className="muted">{isLogin ? 'Sign in to plan your month like a pro.' : 'Plan your salary. Save smarter. Split trips fairly.'}</p>
            </div>

            <div className="segmented" role="tablist">
              <Link role="tab" aria-selected={isLogin} className={isLogin ? 'on' : ''} to="/login">Sign in</Link>
              <Link role="tab" aria-selected={!isLogin} className={!isLogin ? 'on' : ''} to="/register">Create account</Link>
            </div>

            <form onSubmit={submit} noValidate>
              {!isLogin && (
                <Field label="Your name">
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} required placeholder="Asha Rao" />
                </Field>
              )}
              <Field label="Email" hint={isLogin ? 'Your primary email or any linked alias.' : undefined}>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required placeholder="you@example.com" inputMode="email" aria-invalid={!isLogin && email.length > 0 && !emailOk} />
              </Field>
              <div className="field">
                <label htmlFor="pw" className="field-label">Password</label>
                <div className="pw-wrap">
                  <input
                    id="pw"
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    maxLength={128}
                    required
                    placeholder="••••••••"
                  />
                  <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
                    {show ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              {!isLogin && (
                <ul className="rules" aria-live="polite">
                  {checks.map((c) => (
                    <li key={c.key} className={c.ok ? 'ok' : ''}>
                      <span>{c.ok ? '✓' : '•'}</span> {c.label}
                    </li>
                  ))}
                </ul>
              )}
              {error && (
                <motion.p className="form-error" role="alert" initial={{ x: -8 }} animate={{ x: [0, -6, 6, -4, 4, 0] }}>
                  {error}
                </motion.p>
              )}
              <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy} type="submit">
                {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create my account'}
              </motion.button>
            </form>
          </Card>
        </motion.div>
      </div>
    </>
  );
}
