import { useRef, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AdminOverview } from './pages/admin/AdminOverview';
import { AdminUsers } from './pages/admin/AdminUsers';
import { AdminFeedback } from './pages/admin/AdminFeedback';
import { AdminTraffic } from './pages/admin/AdminTraffic';
import { AdminBroadcast } from './pages/admin/AdminBroadcast';
import { AdminAccount } from './pages/admin/AdminAccount';
import { AdminLogin } from './pages/AdminLogin';
import { ForgotPassword } from './pages/ForgotPassword';
import { Privacy, Terms } from './pages/Legal';
import { NotFound } from './pages/NotFound';
import { Arcade } from './pages/Arcade';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/Dashboard';
import { Plan } from './pages/Plan';
import { TripDetail } from './pages/TripDetail';
import { Trips } from './pages/Trips';
import { Spending } from './pages/Spending';
import { Recurring } from './pages/Recurring';
import { Goals } from './pages/Goals';
import { Settings } from './pages/Settings';
import { PublicTrip } from './pages/PublicTrip';
import { MarketingLanding } from './pages/MarketingLanding';
import { GuidedJourneyPage } from './pages/GuidedJourneyPage';
import { Agreement } from './pages/Agreement';
import { AgreementGateProvider, useAgreementGate } from './clarity/AgreementGateProvider';
import { DataUseGateProvider } from './clarity/DataUseGateProvider';
import { postAuthDestination } from './clarity/journeys';
import { selectFinancialClarityRollout } from './clarity/rollout';
import { useAuth } from './state';
import { useVisitTracker } from './hooks/useVisitTracker';
import { wantsUserView } from './userViewPref';

/**
 * Signed-in users go straight to the app; everyone else sees the login or register page.
 * With the clarity rollout on, a sign-up that just finished goes to the guided journey, and
 * a valid `?start=<outcome>` intent starts that journey. With it off the target is unchanged.
 */
function Guest({ children, mode }: { children: ReactNode; mode?: 'login' | 'register' }) {
  const { user } = useAuth();
  const { search } = useLocation();
  // Someone who was already signed in when this page opened did not just register.
  const signedInOnArrival = useRef(!!user);
  if (user) {
    const registered = mode === 'register' && !signedInOnArrival.current;
    return <Navigate to={postAuthDestination({ isAdmin: user.is_admin, search, registered })} replace />;
  }
  return <>{children}</>;
}

const EXEMPT_PATHS: readonly string[] = ['/settings', '/agreement', '/terms', '/privacy'];

/**
 * Routes the redirect to the Agreement_Page never applies to, so export, correction, deletion and the analytics
 * opt-out stay reachable while the notice is required.
 */
export function isExemptRoute(pathname: string): boolean {
  return EXEMPT_PATHS.includes(pathname) || pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * While the data-use notice is required (and the user has not chosen "Not now"), signed-in navigation to a
 * non-exempt route goes to /agreement, carrying the attempted location so the page can return there. The gate
 * reports `required` only when the rollout flag is on, so with the flag off this always renders the Shell.
 */
export function AgreementRedirect() {
  const loc = useLocation();
  const { mustAgree } = useAgreementGate();
  if (mustAgree && !isExemptRoute(loc.pathname)) {
    return <Navigate to="/agreement" replace state={{ from: loc }} />;
  }
  return <Shell />;
}

/** Everything inside the app shell needs a session. */
function Private() {
  const { user } = useAuth();
  const loc = useLocation();
  // Non-authed visitors at "/" see the marketing landing, not an immediate
  // redirect to /login — gives them a chance to understand the app first.
  if (!user) {
    if (loc.pathname === '/') return <MarketingLanding />;
    return <Navigate to="/login" replace />;
  }
  // Admins default to the admin console on cold reopen. If they've explicitly
  // clicked "User view" during this session, respect that and let them land on
  // the user side instead.
  if (user.is_admin && loc.pathname === '/' && !wantsUserView()) {
    return <Navigate to="/admin" replace />;
  }
  return <AgreementRedirect />;
}

/** A signed-in session without the app shell: visitors without one go to sign-in. */
function RequireSession({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  useVisitTracker();
  // With the rollout off there is no /start or /agreement route at all, so each falls through to the catch-all.
  const guidedJourney = selectFinancialClarityRollout().enabled;
  return (
    <DataUseGateProvider>
      <AgreementGateProvider>
      <Routes>
        <Route path="/login" element={<Guest mode="login"><AuthPage mode="login" /></Guest>} />
        <Route path="/register" element={<Guest mode="register"><AuthPage mode="register" /></Guest>} />
        <Route path="/share/trip/:token" element={<PublicTrip />} />
        <Route path="/admin-login" element={<Guest><AdminLogin /></Guest>} />
        <Route path="/forgot-password" element={<Guest><ForgotPassword /></Guest>} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        {/* Inside the session but outside Shell: no navigation or Core Promise strip. */}
        {guidedJourney && <Route path="/agreement" element={<RequireSession><Agreement /></RequireSession>} />}
        <Route element={<Private />}>
          <Route index element={<Dashboard />} />
          {guidedJourney && <Route path="start" element={<GuidedJourneyPage />} />}
          <Route path="spending" element={<Spending />} />
          <Route path="plan" element={<Plan />} />
          <Route path="recurring" element={<Recurring />} />
          <Route path="goals" element={<Goals />} />
          <Route path="trips" element={<Trips />} />
          <Route path="trips/:id" element={<TripDetail />} />
          <Route path="settings" element={<Settings />} />
          <Route path="arcade" element={<Arcade />} />
          <Route path="admin" element={<AdminOverview />} />
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/feedback" element={<AdminFeedback />} />
          <Route path="admin/traffic" element={<AdminTraffic />} />
          <Route path="admin/broadcast" element={<AdminBroadcast />} />
          <Route path="admin/account" element={<AdminAccount />} />
          {/* Signed-in catch-all keeps the Shell (top navigation, admin switch, theme). */}
          <Route path="*" element={<NotFound />} />
        </Route>
        {/* Public catch-all for unauthenticated visitors. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
      </AgreementGateProvider>
    </DataUseGateProvider>
  );
}
