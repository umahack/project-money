import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isNativePlatform } from '../platform';
import { decideBackAction, topOverlay } from './backButton';

/**
 * The only caller of `App.addListener('backButton', ...)`. On the web (`isNativePlatform()` false) it registers no
 * listener and does not load `@capacitor/app`. On native it maps the hardware back button to the Back_Button_Policy:
 * close the top overlay, do nothing for a locked overlay, go back one history entry, or minimise the app (never
 * `exitApp`, so the process and the session stay alive).
 *
 * The listener is registered once and reads the latest location, `mustAgree` and `navigate` through a ref, so it is
 * never torn down and re-added while the user navigates.
 */
export function useBackButtonHandler(mustAgree: boolean): void {
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef({ mustAgree, pathname: location.pathname, navigate });
  latest.current = { mustAgree, pathname: location.pathname, navigate };

  useEffect(() => {
    if (!isNativePlatform()) return undefined;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(({ App }) => {
      if (cancelled) return;
      void App.addListener('backButton', () => {
        const { mustAgree: gate, pathname, navigate: go } = latest.current;
        const top = topOverlay();
        const idx = (window.history.state as { idx?: number } | null)?.idx;
        const action = decideBackAction({
          pathname,
          mustAgree: gate,
          hasInAppHistory: typeof idx === 'number' && idx > 0,
          topOverlay: top,
        });
        if (action === 'close-overlay') top?.onClose();
        else if (action === 'navigate-back') go(-1);
        else if (action === 'minimize') void App.minimizeApp();
        // 'consume': a locked overlay stays open and the route does not change.
      }).then((handle) => {
        // Unmounted while the listener was being added: remove it right away.
        if (cancelled) void handle.remove();
        else remove = () => void handle.remove();
      });
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);
}
