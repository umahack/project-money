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
import { selectFinancialClarityRollout, selectQuickAddEnabled } from '../clarity/rollout';
import { CorePromiseStrip } from './clarity/CorePromiseStrip';
import { DataUseGate } from './clarity/DataUseGate';
import { RenderErrorBoundary } from './clarity/RenderErrorBoundary';
import { QuickAddFailedStatus } from './quickAdd/QuickAddFailedStatus';
import { QuickAddShellHost } from './quickAdd/QuickAddShellHost';
import { applySystemBarStyle } from '../native/systemBars';

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
  // hidden (the primary navigation is in the header then), which reports a height of 0.
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
    // Keep the Android status/navigation bar icons readable against the new theme (no-op on the web).
    void applySystemBarStyle(theme);
  }, [theme, userPickedTheme]);

  // Warm-minimal is the default experience; we no longer auto-follow the OS.
  // Users can still toggle dark via the sun/moon button in the topbar.

  const toggleTheme = () => {
    setUserPickedTheme(true);
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  const inAdmin = loc.pathname === '/admin' || loc.pathname.startsWith('/admin/');
  // Quick Add exists only for a signed-in User on the user view, and only while Quick_Add_Enabled (Requirements 1.18, 1.19).
  const quickAddOn = Boolean(user) && !inAdmin && selectQuickAddEnabled();
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
  // One list feeds both the header navigation (900px and wider) and the mobile bottom bar:
  // in admin mode the admin tabs, on the user side only the primary user tabs. The topbar
  // carries the single "🔄 Admin / 🔄 User" switch for moving between the two.
  const mobileTabs = inAdmin && adminTabs.length > 0 ? adminTabs : tabs;
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
        {/* Primary navigation for 900px and wider; the bottom bar below replaces it. It sits in the sticky
            header so it stays in view while the page scrolls. The active page is marked with aria-current
            and a bold, underlined label, never colour alone. */}
        <nav className="primary-nav desktop-only" aria-label="Primary">
          {mobileTabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className="primary-link">
              <span className="primary-icon" aria-hidden="true">{t.icon}</span>
              <span className="primary-label">{t.label}</span>
              {t.to === '/trips' && inviteCount > 0 && (
                <span className="pill info primary-badge" aria-label={`${inviteCount} pending invite${inviteCount === 1 ? '' : 's'}`}>
                  {inviteCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
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
        <main className={`container app-main${selectFinancialClarityRollout().enabled ? ' clarity-on' : ''}`}>
          {/* The promise and data-use gate come before routed financial controls.
              They render only in the user view and only when the clarity rollout flag is on. */}
          {!inAdmin && (
            <RenderErrorBoundary scope="region" label="The promise and data-use notice" resetKeys={[loc.pathname]}>
              {/* One row: the promise as a single line, and the compact "Your data" control after the notice is acknowledged. */}
              <div className="clarity-intro">
                <CorePromiseStrip />
                <DataUseGate />
              </div>
            </RenderErrorBoundary>
          )}
          {quickAddOn && (
            <RenderErrorBoundary scope="region" label="The entries status" resetKeys={[loc.pathname]}>
              <QuickAddFailedStatus />
            </RenderErrorBoundary>
          )}
          <AnimatePresence mode="wait">
            {/* With reduced motion the page fades only: no slide in, and no jump of 8px as the old page leaves (Requirement 12.7). */}
            <motion.div key={loc.pathname} initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }} transition={{ duration: 0.25 }}>
              {/* A render error in a page stays inside the main area. The header,
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

      {/* Quick Add: the shortcut, floating action, dialog, announcer, and Undo toast. User view only. */}
      {quickAddOn && (
        <RenderErrorBoundary scope="region" label="Quick Add" resetKeys={[loc.pathname]}>
          <QuickAddShellHost />
        </RenderErrorBoundary>
      )}

      <FeedbackModal open={feedback} onCancel={() => setFeedback(false)} onDone={finishLogout} />
    </>
  );
}
