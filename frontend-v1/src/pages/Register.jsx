import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, setAuth } from '../api/client.js';

const rules = [
  { key: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { key: 'letter', label: 'Contains a letter', test: (p) => /[A-Za-z]/.test(p) },
  { key: 'number', label: 'Contains a number', test: (p) => /\d/.test(p) },
  { key: 'space', label: 'No leading or trailing spaces', test: (p) => p === p.trim() && p.length > 0 },
];

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  const results = rules.map((r) => ({ ...r, ok: r.test(password) }));
  const allOk = results.every((r) => r.ok);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const canSubmit = name.trim().length >= 1 && emailOk && allOk && !loading;

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!canSubmit) {
      if (!name.trim()) return setErr('Please enter your name.');
      if (!emailOk) return setErr('That email looks off — check for typos.');
      const missing = results.filter((r) => !r.ok).map((r) => r.label);
      return setErr(`Your password needs: ${missing.join(', ')}.`);
    }
    setLoading(true);
    try {
      const { token, user } = await api('/auth/register', {
        method: 'POST',
        body: { name: name.trim(), email: email.trim(), password },
        auth: false,
      });
      setAuth(token, user);
      nav('/');
    } catch (e) {
      // Common server messages mapped to friendlier phrasing. Nothing server-internal is surfaced.
      const m = e.message || '';
      if (/already registered/i.test(m)) setErr('That email is already registered. Try signing in instead.');
      else if (/password/i.test(m)) setErr(m);
      else if (/couldn.?t reach/i.test(m)) setErr(m);
      else setErr(m || 'Something went wrong. Please try again.');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-[80vh] grid place-items-center">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="card w-full max-w-md"
      >
        <h1 className="text-3xl font-bold mb-1 bg-gradient-to-r from-mint via-orchid to-amber bg-clip-text text-transparent">
          Create your account
        </h1>
        <p className="text-white/80 mb-6 text-sm">Free, private, and lives on your device.</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label className="label">Name</label>
            <input className="input" required maxLength={60} autoComplete="name"
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required autoComplete="email" inputMode="email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email.length > 0 && !emailOk}
            />
            {email.length > 0 && !emailOk && (
              <p className="text-xs text-amber mt-1">Looks like your email is missing something (e.g. @ or .com).</p>
            )}
          </div>
          <div>
            <label className="label">Password</label>
            <div className="relative">
              <input className="input pr-16" type={show ? 'text' : 'password'} required
                autoComplete="new-password" minLength={8}
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-white/80 hover:text-white px-2 py-1 rounded-md bg-white/10 border border-white/15"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            <ul className="mt-2 grid grid-cols-1 gap-1 text-xs" aria-live="polite">
              {results.map((r) => (
                <li key={r.key} className={r.ok ? 'text-mint' : 'text-white/70'}>
                  <span className="inline-block w-4">{r.ok ? '✓' : '•'}</span> {r.label}
                </li>
              ))}
            </ul>
          </div>
          {err && (
            <div
              role="alert"
              className="text-sm text-rose-200 bg-rose-500/10 border border-rose-400/30 rounded-xl p-3"
            >
              {err}
            </div>
          )}
          <button className="btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed" disabled={!canSubmit}>
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="text-sm text-white/80 mt-6">
          Have an account? <Link className="link" to="/login">Sign in</Link>
        </p>
      </motion.div>
    </div>
  );
}
