import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Admin } from './pages/Admin';
import { Arcade } from './pages/Arcade';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/Dashboard';
import { Plan } from './pages/Plan';
import { TripDetail } from './pages/TripDetail';
import { Trips } from './pages/Trips';
import { useAuth } from './state';

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
  return (
    <Routes>
      <Route path="/login" element={<Guest><AuthPage mode="login" /></Guest>} />
      <Route path="/register" element={<Guest><AuthPage mode="register" /></Guest>} />
      <Route element={<Private />}>
        <Route index element={<Dashboard />} />
        <Route path="plan" element={<Plan />} />
        <Route path="trips" element={<Trips />} />
        <Route path="trips/:id" element={<TripDetail />} />
        <Route path="arcade" element={<Arcade />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
