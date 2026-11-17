import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Background } from '../components/Shell';
import { Card } from '../components/ui';
import { useAuth } from '../state';

export function NotFound() {
  const { user } = useAuth();
  const loc = useLocation();
  const homeHref = user ? (user.is_admin ? '/admin' : '/') : '/login';
  const homeLabel = user ? (user.is_admin ? 'Admin console' : 'Dashboard') : 'Sign in';
  // When rendered inside the Private route, Shell already owns the topbar
  // and background — only emit the inner card so we don't double up.
  const inShell = !!user;

  const card = (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '4.5rem', lineHeight: 1 }} aria-hidden="true">🧭</div>
        <h1 style={{ margin: '0.4rem 0' }}>Lost your way?</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          We couldn't find <code style={{ background: 'var(--glass)', padding: '0.1rem 0.4rem', borderRadius: 6 }}>{loc.pathname}</code>.
        </p>
        <p className="muted small">
          The link may have expired, been typed wrong, or the feature isn't ready yet.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <Link to={homeHref} className="btn primary">{homeLabel}</Link>
          <Link to="/" className="btn ghost">Project Money home</Link>
        </div>
      </Card>
      <p className="muted tiny center" style={{ marginTop: '1rem' }}>
        <Link className="link" to="/privacy">Privacy</Link> · <Link className="link" to="/terms">Terms</Link>
      </p>
    </motion.div>
  );

  if (inShell) {
    // Shell wraps us already; just center the card.
    return <div style={{ display: 'grid', placeItems: 'center', minHeight: '50vh' }}>{card}</div>;
  }
  return (
    <>
      <Background />
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Project Money home">
          <span className="brand-mark">₹</span>
          <span>Project&nbsp;Money</span>
        </Link>
        <div className="top-actions">
          <Link to={homeHref} className="btn ghost sm">{homeLabel}</Link>
        </div>
      </header>
      <main className="container" style={{ maxWidth: 640, display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        {card}
      </main>
    </>
  );
}
