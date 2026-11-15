import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, setAuth } from '../api/client.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
      setAuth(token, user);
      nav('/');
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
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
        <p className="text-white/60 mb-6 text-sm">Sign in to plan your month like a pro.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="text-rose text-sm">{err}</div>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-sm text-white/60 mt-6">
          New here? <Link className="link" to="/register">Create an account</Link>
        </p>
      </motion.div>
    </div>
  );
}
