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
import { applySystemBarStyle } from './native/systemBars';
import { sweepStaleExportFiles } from './native/exportFile';
import { isNativePlatform } from './platform';

// Delete export files left in the app cache by an earlier run (native only).
if (isNativePlatform()) void sweepStaleExportFiles();

// Default to warm-minimal (light) on first visit; honor stored preference otherwise.
document.documentElement.dataset.theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';

// Android 15+ (targetSdk 36) enforces edge-to-edge: the app draws behind the status and navigation
// bars, and StatusBar.setOverlaysWebView / setBackgroundColor are ignored. Layout is handled by the
// env(safe-area-inset-*) CSS; only the bar icon style is set here, and Shell sets it again on every
// theme change. No-op on the web.
void applySystemBarStyle(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

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
