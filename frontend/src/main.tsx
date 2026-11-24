import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fraunces';
import './styles.css';
import App from './App';
import { AuthProvider, ToastProvider } from './state';
import { queryClient } from './clarity/queryClient';
import { FinancialClarityProvider } from './clarity/FinancialClarityProvider';
import { MutationStatusProvider } from './clarity/MutationStatusProvider';
import { QuickAddProvider } from './clarity/quickAdd/QuickAddProvider';
import { RenderErrorBoundary } from './components/clarity/RenderErrorBoundary';
import { MotionPreferences } from './components/MotionPreferences';
import { Capacitor } from '@capacitor/core';

// Capacitor native-only setup. On Android 15 (API 35+) the system enables
// edge-to-edge by default — the status bar and camera cutout sit on top of
// the WebView unless we explicitly turn overlay off at runtime.
if (Capacitor.isNativePlatform()) {
  (async () => {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setOverlaysWebView({ overlay: false });
      await StatusBar.setBackgroundColor({ color: '#faf7f2' });
      await StatusBar.setStyle({ style: Style.Light });
    } catch (e) {
      console.warn('[capacitor] StatusBar setup skipped:', e);
    }
  })();
}

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
    <MotionPreferences>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AuthProvider>
              <FinancialClarityProvider>
                <MutationStatusProvider>
                  <QuickAddProvider>
                    {/* Last resort for failures outside the app shell (sign-in, public
                        pages). It sits inside the providers, so confirmed state survives. */}
                    <RenderErrorBoundary scope="app" label="Project Money">
                      <App />
                    </RenderErrorBoundary>
                  </QuickAddProvider>
                </MutationStatusProvider>
              </FinancialClarityProvider>
            </AuthProvider>
          </ToastProvider>
        </QueryClientProvider>
      </BrowserRouter>
    </MotionPreferences>
  </StrictMode>,
);
