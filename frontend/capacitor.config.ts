import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wrapper config. The React build in `dist/` is copied into the
 * native project by `npx cap sync android`. Updates to React code need:
 *   npm run build && npx cap sync android
 * before they appear in the Android app.
 *
 * `appId` is the Google Play package name — permanent after first publish.
 */
const config: CapacitorConfig = {
  appId: 'online.projectmoney.app',
  appName: 'Project Money',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // In dev you can point the Android WebView at the Mac's localhost by
    // uncommenting the two lines below. 10.0.2.2 is the Android emulator's
    // alias for the host machine's localhost.
    //
    //   url: 'http://10.0.2.2:5173',
    //   cleartext: true,
  },
  android: {
    // Permit http://10.0.2.2:4000 (dev backend on the Mac) when running on
    // the emulator. Harmless on release builds that only talk to https prod.
    allowMixedContent: true,
  },
  plugins: {
    // Keep the WebView BELOW the Android status bar / camera hole-punch so
    // the auth top-bar isn't eaten by the notch. Status bar background
    // matches the warm-minimal theme on first boot; the frontend's
    // meta[name=theme-color] updates it dynamically when the user toggles
    // theme at runtime.
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#faf7f2',
    },
    SplashScreen: {
      launchShowDuration: 500,
      backgroundColor: '#faf7f2',
      showSpinner: false,
    },
  },
};

export default config;
