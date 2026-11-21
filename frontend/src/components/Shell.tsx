import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../state';
import { FeedbackModal } from './FeedbackModal';
import { usePendingInvitesCount } from './InvitesInbox';
import { SessionWarning } from './SessionWarning';
import { AnnouncementBanner } from './AnnouncementBanner';
import { TopbarClock } from './TopbarClock';
import { WhatWeStoreLink } from './WhatWeStore';
import { markUserViewPreferred, clearUserViewPreference } from '../userViewPref';
import { DataUseGateProvider } from '../clarity/DataUseGateProvider';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { CorePromiseStrip } from './clarity/CorePromiseStrip';
import { DataUseGate } from './clarity/DataUseGate';
import { RenderErrorBoundary } from './clarity/RenderErrorBoundary';

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
  { to: '/goals', label: 'Goals', icon: '🎯', end: false },
  { to: '/trips', label: 'Trips', icon: '✈️', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙️', end: false },
];
// Admin tabs are appended conditionally below. Recurring was merged into
// Plan's "Monthly bills" and Arcade was hidden to reduce nav clutter.

export function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const reduceMotion = useReducedMotion();
  const [feedback, setFeedback] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    // Warm minimal (light) is the new default experience.
    return 'light';
  });
  const [userPickedTheme, setUserPickedTheme] = useState<boolean>(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark';
  });

  // The bottom navigation wraps to more rows when text is enlarged. Publish its height so the
  // page and the toasts keep clear of it. Below 900px it is shown; at 900px and above it is
  // hidden, which reports a height of 0 and leaves the sidebar layout alone.
  const bottomNavRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = bottomNavRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) root.style.setProperty('--bottom-nav-h', `${height}px`);
      else root.style.removeProperty('--bottom-nav-h');
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--bottom-nav-h');
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (userPickedTheme) localStorage.setItem('theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0b1a' : '#faf7f2');
  }, [theme, userPickedTheme]);

  // Warm-minimal is the default experience; we no longer auto-follow the OS.
  // Users can still toggle dark via the sun/moon button in the topbar.

  const toggleTheme = () => {
    setUserPickedTheme(true);
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  const inAdmin = loc.pathname === '/admin' || loc.pathname.startsWith('/admin/');
  const tabs = TABS;
  const adminTabs = user?.is_admin
    ? [
        { to: '/admin', label: 'Overview', icon: '🛡️', end: true },
        { to: '/admin/users', label: 'Users', icon: '👥', end: false },
        { to: '/admin/feedback', label: 'Feedback', icon: '⭐', end: false },
        { to: '/admin/traffic', label: 'Traffic', icon: '👀', end: false },
        { to: '/admin/broadcast', label: 'Broadcast', icon: '📢', end: false },
        { to: '/admin/account', label: 'My account', icon: '🪪', end: false },
      ]
    : [];
  // Mobile bottom bar: in admin mode show the admin tabs so admins have
  // quick access to admin sections; on the user side keep only the primary
  // user tabs. The topbar carries the single "🔄 Admin / 🔄 User" switch for
  // moving between the two.
  const mobileTabs = inAdmin && adminTabs.length > 0 ? adminTabs : tabs;
  const inviteCount = usePendingInvitesCount();

  const finishLogout = () => {
    setFeedback(false);
    logout();
    nav('/login', { replace: true });
  };

  return (
    <DataUseGateProvider>
      <Background />
      <header className="topbar">
        {/* The name starts with what the link shows (the wordmark and the BETA badge's own label), so speech-input users can say what they see. */}
        <NavLink to="/" className="brand" aria-label="Project Money Beta — under development, home">
          <span className="brand-mark" aria-hidden="true">₹</span>
          <span>Project&nbsp;Money</span>
          {/* The space keeps the link's visible text "Project Money BETA" (it is not rendered between flex items), so it reads as the words the name starts with. */}
          {' '}
          <span
            className="beta-badge"
            title="This app is in active development — features may change and bugs are expected."
            aria-label="Beta — under development"
          >
            BETA
          </span>
        </NavLink>
        <div className="top-actions">
          <TopbarClock />
          {user?.is_admin && (
            <button
              className="btn ghost sm switch-btn"
              onClick={() => {
                if (inAdmin) { markUserViewPreferred(); nav('/'); }
                else { clearUserViewPreference(); nav('/admin'); }
              }}
              title={inAdmin ? 'Switch to user view' : 'Switch to admin console'}
              aria-label={inAdmin ? 'Switch to user view' : 'Switch to admin console'}
            >
              <span aria-hidden="true" style={{ marginRight: 4 }}>🔄</span>
              {inAdmin ? 'User' : 'Admin'}
            </button>
          )}
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <span className="hello desktop-only">Hi, {user?.name.split(' ')[0]}</span>
          <button className="btn ghost sm" onClick={() => setFeedback(true)}>Sign out</button>
        </div>
      </header>

      <AnnouncementBanner />
      <SessionWarning />
      <div className="app-shell">
        <aside className={`sidebar desktop-only ${inAdmin ? 'admin-mode' : ''}`} aria-label="Primary">
          <nav className="side-nav">
            {inAdmin && adminTabs.length > 0 ? (
              <>
                <div className="side-group">🛡️ Admin console</div>
                {adminTabs.map((t) => (
                  <NavLink key={t.to} to={t.to} end={t.end} className="side-link">
                    <span className="side-icon">{t.icon}</span>
                    <span className="side-label">{t.label}</span>
                  </NavLink>
                ))}
                <div className="side-group">Switch</div>
                <NavLink to="/" className="side-link" onClick={() => markUserViewPreferred()}>
                  <span className="side-icon">👤</span>
                  <span className="side-label">Exit to user view</span>
                </NavLink>
              </>
            ) : (
              <>
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
              </>
            )}
          </nav>
        </aside>

        <main className={`container with-sidebar${selectFinancialClarityRollout().enabled ? ' clarity-on' : ''}`}>
          {/* The promise and data-use gate come before routed financial controls.
              They render only in the user view and only when the clarity rollout flag is on. */}
          {!inAdmin && (
            <RenderErrorBoundary scope="region" label="The promise and data-use notice" resetKeys={[loc.pathname]}>
              <CorePromiseStrip />
              <DataUseGate />
            </RenderErrorBoundary>
          )}
          <AnimatePresence mode="wait">
            {/* With reduced motion the page fades only: no slide in, and no jump of 8px as the old page leaves (Requirement 12.7). */}
            <motion.div key={loc.pathname} initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }} transition={{ duration: 0.25 }}>
              {/* A render error in a page stays inside the main area. The sidebar,
                  bottom navigation, and every provider above stay mounted, so
                  confirmed data survives and the user can navigate or retry. */}
              <RenderErrorBoundary
                scope="page"
                label="This page"
                resetKeys={[loc.pathname]}
                focusAfterRetry={() => document.querySelector<HTMLElement>('main')}
              >
                <Outlet />
              </RenderErrorBoundary>
            </motion.div>
          </AnimatePresence>
          <footer className="foot muted tiny center">
            Project Money · UI v2 · Crafted with ♥ by <span className="signature">Umakanth</span>
            <br />
            <WhatWeStoreLink className="link" /> · <NavLink className="link" to="/settings">Export or delete</NavLink> · <NavLink className="link" to="/privacy">Privacy</NavLink> · <NavLink className="link" to="/terms">Terms</NavLink>
          </footer>
        </main>
      </div>

      <nav ref={bottomNavRef} className="bottom-tabs mobile-only" aria-label="Primary mobile">
        {mobileTabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className="btab"
            onClick={() => {
              if (!user?.is_admin) return;
              if (t.to.startsWith('/admin')) clearUserViewPreference();
              else markUserViewPreferred();
            }}
          >
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
    </DataUseGateProvider>
  );
}
