import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../state';
import { FeedbackModal } from './FeedbackModal';
import { usePendingInvitesCount } from './InvitesInbox';

export function Background() {
  return (
    <div className="bg" aria-hidden="true">
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      <div className="grid-overlay" />
      {Array.from({ length: 14 }, (_, i) => (
        <span
          key={i}
          className="float-coin"
          style={{ left: `${(i * 73) % 100}%`, animationDelay: `${(i * 1.7) % 12}s`, animationDuration: `${14 + ((i * 3) % 9)}s`, fontSize: `${14 + ((i * 5) % 18)}px` }}
        >
          {i % 4 === 0 ? '₹' : '🪙'}
        </span>
      ))}
    </div>
  );
}

const TABS = [
  { to: '/', label: 'Home', icon: '🏠', end: true },
  { to: '/spending', label: 'Spending', icon: '📊', end: false },
  { to: '/plan', label: 'Plan', icon: '🧾', end: false },
  { to: '/recurring', label: 'Recurring', icon: '🔁', end: false },
  { to: '/goals', label: 'Goals', icon: '🎯', end: false },
  { to: '/trips', label: 'Trips', icon: '✈️', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙️', end: false },
];
// Admin + Arcade are appended conditionally below. Keep this list focused.

export function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [feedback, setFeedback] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('theme') === 'light' ? 'light' : 'dark'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0b1a' : '#f3f1ff');
  }, [theme]);

  const tabs = [
    ...TABS,
    { to: '/arcade', label: 'Arcade', icon: '🎮', end: false },
  ];
  const adminTabs = user?.is_admin
    ? [
        { to: '/admin', label: 'Overview', icon: '🛡️', end: true },
        { to: '/admin/users', label: 'Users', icon: '👥', end: false },
        { to: '/admin/feedback', label: 'Feedback', icon: '⭐', end: false },
        { to: '/admin/traffic', label: 'Traffic', icon: '👀', end: false },
      ]
    : [];
  // Mobile bottom bar: keep the primary tabs plus an Admin shortcut.
  const mobileTabs = user?.is_admin
    ? [...tabs, { to: '/admin', label: 'Admin', icon: '🛡️', end: false }]
    : tabs;
  const inviteCount = usePendingInvitesCount();

  const finishLogout = () => {
    setFeedback(false);
    logout();
    nav('/login', { replace: true });
  };

  return (
    <>
      <Background />
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Project Money home">
          <span className="brand-mark">₹</span>
          <span>Project&nbsp;Money</span>
          <span
            className="beta-badge"
            title="This app is in active development — features may change and bugs are expected."
            aria-label="Beta — under development"
          >
            BETA
          </span>
        </NavLink>
        <div className="top-actions">
          <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <span className="hello desktop-only">Hi, {user?.name.split(' ')[0]}</span>
          <button className="btn ghost sm" onClick={() => setFeedback(true)}>Sign out</button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="sidebar desktop-only" aria-label="Primary">
          <nav className="side-nav">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className="side-link">
                <span className="side-icon">{t.icon}</span>
                <span className="side-label">{t.label}</span>
                {t.to === '/trips' && inviteCount > 0 && (
                  <span className="pill info" style={{ marginLeft: 'auto' }} aria-label={`${inviteCount} pending invite${inviteCount === 1 ? '' : 's'}`}>
                    {inviteCount}
                  </span>
                )}
              </NavLink>
            ))}
            {adminTabs.length > 0 && (
              <>
                <div className="side-group">Admin</div>
                {adminTabs.map((t) => (
                  <NavLink key={t.to} to={t.to} end={t.end} className="side-link">
                    <span className="side-icon">{t.icon}</span>
                    <span className="side-label">{t.label}</span>
                  </NavLink>
                ))}
              </>
            )}
          </nav>
        </aside>

        <main className="container with-sidebar">
          <AnimatePresence mode="wait">
            <motion.div key={loc.pathname} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              <Outlet />
            </motion.div>
          </AnimatePresence>
          <footer className="foot muted tiny center">
            Project Money · UI v2 · Crafted with ♥ by <span className="signature">Umakanth</span>
          </footer>
        </main>
      </div>

      <nav className="bottom-tabs mobile-only" aria-label="Primary mobile">
        {mobileTabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="btab">
            <span className="btab-icon" style={{ position: 'relative' }}>
              {t.icon}
              {t.to === '/trips' && inviteCount > 0 && (
                <span
                  aria-label={`${inviteCount} pending invite${inviteCount === 1 ? '' : 's'}`}
                  style={{
                    position: 'absolute', top: -4, right: -8,
                    minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                    background: 'var(--accent, #7c6cff)', color: '#fff', fontSize: 10,
                    fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {inviteCount}
                </span>
              )}
            </span>
            <small>{t.label}</small>
          </NavLink>
        ))}
      </nav>

      <FeedbackModal open={feedback} onCancel={() => setFeedback(false)} onDone={finishLogout} />
    </>
  );
}
