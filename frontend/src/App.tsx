import type { ReactNode } from 'react';
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
import { useAuth } from './state';
import { useVisitTracker } from './hooks/useVisitTracker';

/** Signed-in users go straight to the app; everyone else sees the login or register page. */
function Guest({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user) return <Navigate to={user.is_admin ? '/admin' : '/'} replace />;
  return <>{children}</>;
}

const USER_VIEW_FLAG = 'pm_prefer_user_view';
export function markUserViewPreferred() {
  try { sessionStorage.setItem(USER_VIEW_FLAG, '1'); } catch { /* ignore */ }
}
export function clearUserViewPreference() {
  try { sessionStorage.removeItem(USER_VIEW_FLAG); } catch { /* ignore */ }
}
function wantsUserView() {
  try { return sessionStorage.getItem(USER_VIEW_FLAG) === '1'; } catch { return false; }
}

/** Everything inside the app shell needs a session. */
function Private() {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  // Admins default to the admin console on cold reopen. If they've explicitly
  // clicked "User view" during this session, respect that and let them land on
  // the user side instead.
  if (user.is_admin && loc.pathname === '/' && !wantsUserView()) {
    return <Navigate to="/admin" replace />;
  }
  return <Shell />;
}

export default function App() {
  useVisitTracker();
  return (
    <Routes>
      <Route path="/login" element={<Guest><AuthPage mode="login" /></Guest>} />
      <Route path="/register" element={<Guest><AuthPage mode="register" /></Guest>} />
      <Route path="/share/trip/:token" element={<PublicTrip />} />
      <Route path="/admin-login" element={<Guest><AdminLogin /></Guest>} />
      <Route path="/forgot-password" element={<Guest><ForgotPassword /></Guest>} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route element={<Private />}>
        <Route index element={<Dashboard />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
