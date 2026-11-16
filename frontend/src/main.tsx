import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fraunces';
import './styles.css';
import App from './App';
import { AuthProvider, ToastProvider } from './state';

// Default to warm-minimal (light) on first visit; honor stored preference otherwise.
document.documentElement.dataset.theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';

// Fire-and-forget: wake the Render free-tier API as early as possible so the
// Dashboard's parallel fetches aren't the thing waiting on cold-start.
try {
  const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
  if (base) fetch(`${base}/api/health`, { cache: 'no-store', keepalive: true }).catch(() => {});
} catch { /* ignore */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
