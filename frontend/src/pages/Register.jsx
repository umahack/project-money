import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, setAuth } from '../api/client.js';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (password.length < 8) return setErr('Password must be at least 8 characters');
    setLoading(true);
    try {
      const { token, user } = await api('/auth/register', {
        method: 'POST',
        body: { name, email, password },
        auth: false,
      });
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
          Create your account
        </h1>
        <p className="text-white/60 mb-6 text-sm">Free, private, and lives on your device.</p>
        <form onSubmit={submit} className="space-y-4">
          <div><label className="label">Name</label>
            <input className="input" required maxLength={60}
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div><label className="label">Email</label>
            <input className="input" type="email" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div><label className="label">Password</label>
            <input className="input" type="password" required minLength={8} autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs text-white/40 mt-1">At least 8 characters.</p>
          </div>
          {err && <div className="text-rose text-sm">{err}</div>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="text-sm text-white/60 mt-6">
          Have an account? <Link className="link" to="/login">Sign in</Link>
        </p>
      </motion.div>
    </div>
  );
}
