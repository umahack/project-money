import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, setAuth } from '../api/client.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email: email.trim(), password }, auth: false });
      setAuth(token, user);
      nav('/');
    } catch (e) {
      const m = e.message || '';
      if (/invalid credentials/i.test(m)) setErr('Email or password is incorrect.');
      else if (/too many/i.test(m)) setErr('Too many attempts. Please wait a few minutes and try again.');
      else setErr(m || 'Could not sign you in. Please try again.');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-[80vh] grid place-items-center">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="card w-full max-w-md"
      >
        <h1 className="text-3xl font-bold mb-1 bg-gradient-to-r from-mint via-orchid to-amber bg-clip-text text-transparent">
          Welcome back
        </h1>
        <p className="text-white/80 mb-6 text-sm">Sign in to plan your month like a pro.</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" autoComplete="email" inputMode="email" required
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <div className="relative">
              <input className="input pr-16" type={show ? 'text' : 'password'} autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-white/80 hover:text-white px-2 py-1 rounded-md bg-white/10 border border-white/15"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {err && (
            <div role="alert" className="text-sm text-rose-200 bg-rose-500/10 border border-rose-400/30 rounded-xl p-3">
              {err}
            </div>
          )}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-sm text-white/80 mt-6">
          New here? <Link className="link" to="/register">Create an account</Link>
        </p>
      </motion.div>
    </div>
  );
}
