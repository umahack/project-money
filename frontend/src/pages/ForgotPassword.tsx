import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from '../components/ui';
import { Background } from '../components/Shell';
import { errText, useToast } from '../state';

type Step = 'email' | 'code';

import { PW_RULES as RULES } from '../passwordRules';

export function ForgotPassword() {
  const nav = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const checks = RULES.map((r) => ({ ...r, ok: r.test(password) }));
  const allOk = checks.every((c) => c.ok);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!emailOk) return setError('Enter a valid email.');
    setBusy(true);
    try {
      await api.post('/auth/password-reset-start', { email: email.trim() }, false);
      toast('ok', `If ${email.trim()} is on file, a code is on the way.`);
      setStep('code');
    } catch (err) {
      setError(errText(err) || 'Could not start reset. Try again.');
    } finally { setBusy(false); }
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code we emailed you.');
    const missing = checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase());
    if (missing.length) return setError(`Your new password needs: ${missing.join(', ')}.`);
    setBusy(true);
    try {
      await api.post('/auth/password-reset-finish', { email: email.trim(), code, newPassword: password }, false);
      toast('ok', 'Password reset. Please sign in.');
      nav('/login', { replace: true });
    } catch (err) {
      setError(errText(err) || 'Could not reset password.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <Background />
      <div className="auth-wrap">
        <motion.div initial={{ opacity: 0, y: 30, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', damping: 20 }}>
          <Card className="auth-card" tilt>
            <div className="auth-logo">
              <motion.span className="brand-mark big" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 8, ease: 'linear' }}>
                🔑
              </motion.span>
              <h1>Reset password</h1>
              <p className="muted">
                {step === 'email' ? 'Enter your email and we’ll send a 6-digit code.' : `Enter the code we sent to ${email.trim()} and pick a new password.`}
              </p>
            </div>

            {step === 'email' && (
              <form onSubmit={sendCode} noValidate>
                <Field label="Account email">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required placeholder="you@example.com" inputMode="email" />
                </Field>
                {error && <p className="form-error" role="alert">{error}</p>}
                <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy} type="submit">
                  {busy ? 'Sending…' : 'Send reset code'}
                </motion.button>
              </form>
            )}

            {step === 'code' && (
              <form onSubmit={finish} noValidate>
                <Field label="6-digit code">
                  <input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" required placeholder="123456" />
                </Field>
                <div className="field">
                  <label htmlFor="np" className="field-label">New password</label>
                  <div className="pw-wrap">
                    <input id="np" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} required />
                    <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)}>
                      {show ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <ul className="pw-rules" aria-live="polite">
                    {checks.map((c) => (
                      <li key={c.key} className={c.ok ? 'ok' : 'pending'}>{c.ok ? '✔' : '•'} {c.label}</li>
                    ))}
                  </ul>
                </div>
                {error && <p className="form-error" role="alert">{error}</p>}
                <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy || !allOk} type="submit">
                  {busy ? 'Resetting…' : 'Reset password'}
                </motion.button>
                <p className="muted small center" style={{ marginTop: '0.6rem' }}>
                  Didn't get it? <button type="button" className="link link-btn" onClick={() => { setStep('email'); setCode(''); }}>Use a different email</button>
                </p>
              </form>
            )}

            <p className="muted small center" style={{ marginTop: '1rem' }}>
              Remembered it? <Link className="link" to="/login">Back to sign in</Link>
            </p>
          </Card>
        </motion.div>
      </div>
    </>
  );
}
