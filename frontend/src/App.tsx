import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AdminOverview } from './pages/admin/AdminOverview';
import { AdminUsers } from './pages/admin/AdminUsers';
import { AdminFeedback } from './pages/admin/AdminFeedback';
import { AdminTraffic } from './pages/admin/AdminTraffic';
import { AdminBroadcast } from './pages/admin/AdminBroadcast';
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
  return user ? <Navigate to="/" replace /> : <>{children}</>;
}

/** Everything inside the app shell needs a session. */
function Private() {
  const { user } = useAuth();
  return user ? <Shell /> : <Navigate to="/login" replace />;
}

export default function App() {
  useVisitTracker();
  return (
    <Routes>
      <Route path="/login" element={<Guest><AuthPage mode="login" /></Guest>} />
      <Route path="/register" element={<Guest><AuthPage mode="register" /></Guest>} />
      <Route path="/share/trip/:token" element={<PublicTrip />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
