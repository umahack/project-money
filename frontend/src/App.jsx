import { useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getToken, getUser, logout } from './api/client.js';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Trips from './pages/Trips.jsx';
import TripDetail from './pages/TripDetail.jsx';
import Plan from './pages/Plan.jsx';
import Admin from './pages/Admin.jsx';
import FeedbackModal from './components/FeedbackModal.jsx';

function Protected({ children }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return children;
}

function Nav() {
  const user = getUser();
  const nav = useNavigate();
  const loc = useLocation();
  const [showFeedback, setShowFeedback] = useState(false);
  if (!user || loc.pathname === '/login' || loc.pathname === '/register') return null;

  const doLogout = () => { logout(); nav('/login'); };

  return (
    <>
      <motion.header
        initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        className="sticky top-0 z-20 backdrop-blur bg-ink/60 border-b border-white/10"
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 group">
            <span className="text-2xl group-hover:animate-float">₹</span>
            <span className="font-bold tracking-tight bg-gradient-to-r from-mint via-orchid to-amber bg-clip-text text-transparent">
              Project Money
            </span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/plan">Plan</NavLink>
            <NavLink to="/trips">Trips</NavLink>
            {user.is_admin && <NavLink to="/admin">Admin</NavLink>}
            <button className="btn-ghost ml-2" onClick={() => setShowFeedback(true)}>Logout</button>
          </nav>
        </div>
      </motion.header>
      <FeedbackModal
        open={showFeedback}
        onClose={() => { setShowFeedback(false); doLogout(); }}
        onSubmitted={() => { setShowFeedback(false); doLogout(); }}
      />
    </>
  );
}

function NavLink({ to, children }) {
  const loc = useLocation();
  const active = loc.pathname === to;
  return (
    <Link
      to={to}
      className={`px-3 py-1.5 rounded-xl transition relative font-medium ${active ? 'text-white' : 'text-white/85 hover:text-white'}`}
    >
      {active && (
        <motion.span
          layoutId="nav-pill"
          className="absolute inset-0 rounded-xl bg-white/10 border border-white/10"
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      )}
      <span className="relative">{children}</span>
    </Link>
  );
}

export default function App() {
  const loc = useLocation();
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={loc.pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            <Routes location={loc}>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/" element={<Protected><Dashboard /></Protected>} />
              <Route path="/plan" element={<Protected><Plan /></Protected>} />
              <Route path="/trips" element={<Protected><Trips /></Protected>} />
              <Route path="/trips/:id" element={<Protected><TripDetail /></Protected>} />
              <Route path="/admin" element={<Protected><Admin /></Protected>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </main>
      <footer className="text-center text-xs text-white/70 py-6">
        Built with care · Your data stays on your machine.
      </footer>
    </div>
  );
}
