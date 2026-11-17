import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Card, Field } from '../components/ui';
import { Background } from '../components/Shell';
import { errText, useAuth, useToast } from '../state';
import { clearUserViewPreference } from '../userViewPref';

import { PW_RULES as RULES } from '../passwordRules';

function friendly(message: string, mode: 'login' | 'register'): string {
  if (/invalid credentials/i.test(message)) return 'Email or password is incorrect.';
  if (/too many/i.test(message)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (/already registered/i.test(message)) return 'That email is already registered. Try signing in instead.';
  return message || (mode === 'login' ? 'Could not sign you in. Please try again.' : 'Something went wrong. Please try again.');
}

type Step = 'form' | 'code';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, registerStart, registerFinish, registerResend } = useAuth();
  const { toast } = useToast();
  const nav = useNavigate();
  const isLogin = mode === 'login';

  useEffect(() => {
    try {
      const msg = sessionStorage.getItem('pm_kicked_msg');
      if (msg) { toast('err', msg); sessionStorage.removeItem('pm_kicked_msg'); }
    } catch { /* ignore */ }
  }, [toast]);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Register-only step state
  const [step, setStep] = useState<Step>('form');
  const [code, setCode] = useState('');

  const checks = RULES.map((r) => ({ ...r, ok: r.test(password) }));
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const u = await login(email.trim(), password);
      clearUserViewPreference();
      nav(u.is_admin ? '/admin' : '/', { replace: true });
    } catch (err) {
      setError(friendly(errText(err), 'login'));
      setBusy(false);
    }
  }

  async function submitStart(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!name.trim()) return setError('Please enter your name.');
    if (!emailOk) return setError('That email looks off. Check for typos.');
    const missing = checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase());
    if (missing.length) return setError(`Your password needs: ${missing.join(', ')}.`);
    setBusy(true);
    try {
      const r = await registerStart(name.trim(), email.trim(), password);
      toast('ok', r.fallback ? 'Code generated (check server log in dev)' : `Check ${email.trim()} for a 6-digit code. If this email already has an account, we've sent a sign-in reminder instead.`);
      setStep('code');
    } catch (err) {
      setError(friendly(errText(err), 'register'));
    } finally { setBusy(false); }
  }

  async function submitFinish(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code we emailed you.');
    setBusy(true);
    try {
      const u = await registerFinish(email.trim(), code);
      nav(u.is_admin ? '/admin' : '/', { replace: true });
    } catch (err) {
      setError(friendly(errText(err), 'register'));
      setBusy(false);
    }
  }

  async function resend() {
    try {
      const r = await registerResend(email.trim());
      toast('ok', r.fallback ? 'New code generated (check server log)' : 'New code sent');
    } catch (err) { toast('err', errText(err)); }
  }

  function startOver() {
    setStep('form');
    setCode('');
    setError('');
  }

  const subtitle = isLogin
    ? 'Sign in to plan your month like a pro.'
    : step === 'form'
      ? 'Plan your salary. Save smarter. Split trips fairly.'
      : `Enter the 6-digit code we emailed to ${email.trim()}.`;

  const title = isLogin
    ? 'Welcome back'
    : step === 'form' ? 'Create your account' : 'Verify your email';

  return (
    <>
      <Background />
      <header className="auth-topbar">
        <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          {/* Only show Back when the user actually navigated here from
              somewhere inside the app (not a direct link / tab open). */}
          {typeof window !== 'undefined' && window.history.state?.idx > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => nav(-1)}
              aria-label="Go back"
              title="Go back"
              style={{ padding: '0.3rem 0.55rem' }}
            >
              ← Back
            </button>
          )}
          <Link to="/" className="brand" aria-label="Project Money home">
            <span className="brand-mark">₹</span>
            <span>Project&nbsp;Money</span>
            <span
              className="beta-badge"
              title="This app is in active development — features may change and bugs are expected."
              aria-label="Beta — under development"
            >
              BETA
            </span>
          </Link>
        </div>
        <div className="top-actions">
          {/* Show only the OTHER page's button so clicking it always navigates. */}
          {isLogin ? (
            <Link to="/register" className="btn primary sm">Sign up</Link>
          ) : (
            <Link to="/login" className="btn primary sm">Sign in</Link>
          )}
        </div>
      </header>
      <div className="auth-wrap">
        <motion.div id="auth-card" initial={{ opacity: 0, y: 30, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', damping: 20 }}>
          <Card className="auth-card" tilt>
            <div className="auth-logo">
              <motion.span className="brand-mark big" animate={{ rotateY: 360 }} transition={{ repeat: Infinity, duration: 5, ease: 'linear' }}>₹</motion.span>
              <h1>{title}</h1>
              <p className="muted">{subtitle}</p>
            </div>

            <AnimatePresence mode="wait">
              {isLogin && (
                <motion.form key="login" onSubmit={submitLogin} noValidate initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <Field label="Email">
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required placeholder="you@example.com" inputMode="email" />
                  </Field>
                  <PasswordField value={password} onChange={setPassword} show={show} onToggle={() => setShow((v) => !v)} autoComplete="current-password" />
                  {error && <ErrorBox msg={error} />}
                  <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy} type="submit">
                    {busy ? 'Please wait…' : 'Sign in'}
                  </motion.button>
                  <p className="muted small center" style={{ marginTop: '0.6rem' }}>
                    <Link className="link" to="/forgot-password">Forgot password?</Link>
                  </p>
                  <p className="muted small center" style={{ marginTop: '0.4rem' }}>
                    New here? <Link className="link" to="/register">Create an account</Link>
                  </p>
                </motion.form>
              )}

              {!isLogin && step === 'form' && (
                <motion.form key="start" onSubmit={submitStart} noValidate initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} required placeholder="Asha Rao" /></Field>
                  <Field label="Email">
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required placeholder="you@example.com" inputMode="email" aria-invalid={email.length > 0 && !emailOk} />
                  </Field>
                  <PasswordField value={password} onChange={setPassword} show={show} onToggle={() => setShow((v) => !v)} autoComplete="new-password" />
                  <ul className="rules" aria-live="polite">
                    {checks.map((c) => (
                      <li key={c.key} className={c.ok ? 'ok' : ''}>
                        <span>{c.ok ? '✓' : '•'}</span> {c.label}
                      </li>
                    ))}
                  </ul>
                  {error && <ErrorBox msg={error} />}
                  <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy} type="submit">
                    {busy ? 'Sending code…' : 'Send verification code'}
                  </motion.button>
                  <p className="muted small center" style={{ marginTop: '0.6rem' }}>
                    Already have an account on this email? Check your inbox — we'll send a sign-in reminder instead of a signup code. Or just <Link className="link" to="/login">sign in here</Link>.
                  </p>
                </motion.form>
              )}

              {!isLogin && step === 'code' && (
                <motion.form key="code" onSubmit={submitFinish} noValidate initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <div className="info-banner" role="status" style={{
                    background: 'linear-gradient(135deg, rgba(124,108,255,0.14), rgba(24,224,181,0.12))',
                    border: '1px solid rgba(124,108,255,0.35)',
                    borderRadius: 12,
                    padding: '0.7rem 0.9rem',
                    marginBottom: '0.8rem',
                    fontSize: '0.9rem',
                    lineHeight: 1.45,
                  }}>
                    📬 <b>Check {email.trim() || 'your inbox'}.</b> If this email is new, you'll get a 6-digit code. If it already has a Project Money account, we sent a sign-in reminder — <Link className="link" to="/login">sign in</Link> or <Link className="link" to="/forgot-password">reset your password</Link>.
                  </div>
                  <Field label="6-digit code" hint="Code is valid for 15 minutes. No code? See the note above.">
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      style={{ letterSpacing: '0.4em', textAlign: 'center', fontSize: '1.3rem' }}
                      required
                    />
                  </Field>
                  {error && <ErrorBox msg={error} />}
                  <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy || code.length !== 6} type="submit">
                    {busy ? 'Verifying…' : 'Create account'}
                  </motion.button>
                  <div className="row-sm" style={{ marginTop: '0.6rem', justifyContent: 'space-between' }}>
                    <button type="button" className="btn ghost sm" onClick={startOver}>← Change details</button>
                    <button type="button" className="btn ghost sm" onClick={() => void resend()}>Resend code</button>
                  </div>
                  <p className="muted small center" style={{ marginTop: '0.8rem' }}>
                    No code arrived? If this email already has an account, we sent a sign-in reminder instead — <Link className="link" to="/login">sign in</Link> or <Link className="link" to="/forgot-password">reset your password</Link>.
                  </p>
                </motion.form>
              )}
            </AnimatePresence>
          </Card>
          <p className="auth-sig muted tiny center">
            Crafted with ♥ by <span className="signature">Umakanth</span>
          </p>
        </motion.div>
      </div>
    </>
  );
}

function PasswordField({ value, onChange, show, onToggle, autoComplete }: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete: string;
}) {
  return (
    <div className="field">
      <label htmlFor="pw" className="field-label">Password</label>
      <div className="pw-wrap">
        <input
          id="pw"
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          maxLength={128}
          required
          placeholder="••••••••"
        />
        <button type="button" className="pw-toggle" onClick={onToggle} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <motion.p className="form-error" role="alert" initial={{ x: -8 }} animate={{ x: [0, -6, 6, -4, 4, 0] }}>
      {msg}
    </motion.p>
  );
}
