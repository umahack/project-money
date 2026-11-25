# Android App Release Design

## Overview

This feature turns the existing scaffolded Capacitor Android project (`frontend/android`) into a releasable app. The work is split across three layers:

1. **Shared TypeScript/TSX** (`frontend/src`): a `platform` module, a `tokenStore` module, a back-button policy, an export/share wrapper, a haptics wrapper, an offline/retry banner, and a build-mode-aware Capacitor/Vite configuration. All of this is behaviour-preserving on the web — every new code path is gated on `isNativePlatform()` being true, or is a pure refactor (token accessor) with no behaviour change.
2. **Native Java/Gradle/XML** (`frontend/android`): manifest hardening (backup, cleartext, exported components, permissions), a `SecureWindowPolicy` for `FLAG_SECURE`, edge-to-edge handling in `MainActivity`, release signing from a gitignored `keystore.properties`, ProGuard keep rules, and replacement of the stale `com.getcapacitor.myapp` example tests with real tests.
3. **Build and verification tooling** (`frontend/scripts/android`, npm scripts, a backend CORS test, documentation): a manifest auditor, a `npm run android:verify` pipeline, an Android-mode Vite build, and an emulator smoke checklist for the `Pixel_7_2` AVD at API 34 and API 37.

Nothing here changes the backend except one new test file proving the CORS allowlist is exact-match; nothing here changes the web application's behaviour when Capacitor is absent.

### Non-goals

Carried over from Requirements § Out of Scope: iOS, persistent ("stay signed in") sessions, biometrics/app lock, native Google Sign-In, certificate pinning, root/emulator detection, a screenshot-visibility setting, and performing the Play Console submission itself.

## Architecture

### Where the pieces live

```
frontend/src/
  platform.ts                     # Platform_Module
  tokenStore.ts                   # Token_Store
  native/
    backButton.ts                 # Back_Button_Policy (pure) + overlay registry + App listener wiring
    exportFile.ts                  # Export_Share_Wrapper
    haptics.ts                     # haptic wrapper (save/undo impulses, reduced-motion aware)
    systemBars.ts                  # theme -> SystemBars.setStyle wiring
    networkStatus.ts               # offline/online store + friendly-error mapper
  components/
    OfflineBanner.tsx              # Requirement 7 notice + retry
  vite.config.ts                   # extended: --mode android validation, CSP without GSI, console strip
  capacitor.config.ts              # extended: CAPACITOR_ENV-driven release/debug branching

frontend/android/
  app/src/main/AndroidManifest.xml            # hardened
  app/src/main/res/xml/network_security_config.xml
  app/src/debug/res/xml/network_security_config.xml   # debug overlay (10.0.2.2, localhost)
  app/src/main/res/xml/data_extraction_rules.xml
  app/src/main/res/xml/backup_rules.xml
  app/src/main/res/xml/file_paths.xml          # cache-path only
  app/src/main/java/online/projectmoney/app/MainActivity.java
  app/src/main/java/online/projectmoney/app/SecureWindowPolicy.java
  app/src/test/java/online/projectmoney/app/SecureWindowPolicyTest.java
  app/src/androidTest/java/online/projectmoney/app/MainActivityLaunchTest.java
  app/build.gradle                             # release signing, minify, proguard
  app/proguard-rules.pro
  keystore.properties.example
  android/.gitignore                            # + *.jks, *.keystore, keystore.properties, .env.android

frontend/scripts/android/
  auditManifest.mjs                # Manifest_Audit
  verify.mjs                       # Verify_Script (npm run android:verify)
  smoke.sh                         # adb-driven smoke script (Requirement 16.7)

backend/test/api/
  corsAllowlist.test.js            # Requirement 15

docs/
  android-play-store-checklist.md  # Play_Checklist
  android-emulator-results.md      # Smoke_Checklist results log
```

### Why a `platform` module and a `tokenStore` module

`Capacitor.isNativePlatform()` is already called directly in `main.tsx`. Every other new native-only branch (Google button, back button, export, haptics, system bars, offline banner) needs the same check. Centralising it in `frontend/src/platform.ts` means a test can mock one module (`vi.mock('../platform')`) instead of mocking `@capacitor/core` everywhere, which is also what the brief asks for ("a tiny `platform` module that also makes web tests easy to mock").

`pm_token` is currently read directly in four places outside `api.ts` (`useSessionWarning.ts:33`, `DangerZone.tsx:96`, `DangerZone.tsx:151`, `ExportData.tsx:15`) in addition to `api.ts` itself. `tokenStore.ts` becomes the single place that touches the `sessionStorage` key; `api.ts` re-exports `getToken` from it unchanged so no caller signature changes. This is a pure refactor: the storage mechanism (`sessionStorage`, key `pm_token`) does not change in this feature, only the number of modules that touch it.

```typescript
// frontend/src/tokenStore.ts
const TOKEN_KEY = 'pm_token';

/** The only module that reads, writes, or clears the session token. */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
```

`api.ts` changes `const TOKEN_KEY = 'pm_token'` and its three direct `sessionStorage` calls to import `getToken as readToken, setToken, clearToken` from `./tokenStore` and keep exporting `getToken` (now a re-export), `setAuth`, and `clearAuth` with identical signatures. `useSessionWarning.ts`, `DangerZone.tsx`, and `ExportData.tsx` replace `sessionStorage.getItem('pm_token')` with `getToken()` imported from `../tokenStore` (or `../api`, which re-exports it — the design uses `../tokenStore` directly in non-`api.ts` modules to avoid a dependency cycle risk through `api.ts`'s other imports).

```typescript
// frontend/src/platform.ts
import { Capacitor } from '@capacitor/core';

/** The only application module that calls Capacitor.isNativePlatform(). */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
```

### Back button

`frontend/src/native/backButton.ts` exports a pure decision function and a small overlay registry, plus a hook that wires both to `@capacitor/app`'s `backButton` event only when `isNativePlatform()` is true.

```typescript
export type BackAction = 'close-overlay' | 'consume' | 'navigate-back' | 'minimize';

export interface OverlayEntry {
  /** Stable id so re-registering (e.g. React effect re-run) replaces, not stacks, the same overlay. */
  id: string;
  /** False for a locked/undismissable overlay (e.g. a mutation in flight). */
  closable: boolean;
  onClose: () => void;
}

export interface BackDecisionInput {
  pathname: string;
  mustAgree: boolean;      // Agreement_Gate.mustAgree
  hasInAppHistory: boolean;
  topOverlay: OverlayEntry | undefined;
}

const HOME_PATHS = new Set(['/', '/login']);

export function decideBackAction(input: BackDecisionInput): BackAction {
  const { pathname, mustAgree, hasInAppHistory, topOverlay } = input;
  if (topOverlay) return topOverlay.closable ? 'close-overlay' : 'consume';
  if (pathname === '/agreement' && mustAgree) return 'minimize';
  if (HOME_PATHS.has(pathname)) return 'minimize';
  return hasInAppHistory ? 'navigate-back' : 'minimize';
}
```

`OverlayRegistry` (same file) is a tiny stack keyed by `id`: `pushOverlay(entry)` / `popOverlay(id)` / `topOverlay()`. `QuickAddDialog`'s `Modal` usage registers itself on open and unregisters on close, passing `closable: !locked` so a locked (mutation-in-flight) dialog maps to `consume`. The Agreement page registers nothing — its own gate is read directly from `mustAgree`.

`useBackButtonHandler()` is the only caller of `App.addListener('backButton', …)`, called once from `App.tsx`, and is a no-op (adds no listener) when `isNativePlatform()` is false:

```typescript
export function useBackButtonHandler(mustAgree: boolean): void {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!isNativePlatform()) return undefined;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(({ App }) => {
      App.addListener('backButton', () => {
        const action = decideBackAction({
          pathname: location.pathname,
          mustAgree,
          hasInAppHistory: window.history.state?.idx > 0,
          topOverlay: topOverlay(),
        });
        if (action === 'close-overlay') topOverlay()?.onClose();
        else if (action === 'navigate-back') navigate(-1);
        else if (action === 'minimize') void App.minimizeApp();
        // 'consume': do nothing.
      }).then((h) => { remove = () => h.remove(); });
    });
    return () => remove?.();
  }, [mustAgree, location.pathname, navigate]);
}
```

`App.minimizeApp()` (not `App.exitApp()`) is used for every `minimize` outcome so the process and the session survive, matching Requirement 3.10 — this is the Android equivalent of pressing Home, not killing the task.

### Export and share

`frontend/src/native/exportFile.ts` wraps the platform branch so `DangerZone.tsx` and `ExportData.tsx` call one function instead of building an anchor tag:

```typescript
export interface ExportResult {
  outcome: 'downloaded' | 'shared' | 'cancelled' | 'failed';
}

export async function saveAndShare(blob: Blob, filename: string): Promise<ExportResult> {
  if (!isNativePlatform()) {
    downloadViaAnchor(blob, filename); // existing URL.createObjectURL + <a download> path, unchanged
    return { outcome: 'downloaded' };
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const base64Data = await blobToBase64(blob);
  try {
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64Data, directory: Directory.Cache });
    try {
      await Share.share({ url: uri, title: filename });
      scheduleCleanup(filename);
      return { outcome: 'shared' };
    } catch (shareError) {
      scheduleCleanup(filename);
      return isShareCancellation(shareError) ? { outcome: 'cancelled' } : { outcome: 'shared' };
    }
  } catch {
    return { outcome: 'failed' };
  }
}
```

`scheduleCleanup(filename)` sets a 60-second timer that calls `Filesystem.deleteFile({ path: filename, directory: Directory.Cache })` and swallows a "file not found" error. `sweepStaleExportFiles()` runs once at app start (from `main.tsx`, native-only): it lists `Directory.Cache`, and deletes any entry matching `/^project-money-(account|expenses)-.*\.(json|csv)$/`.

The Capacitor `Share.share` rejection on Android when the user dismisses the sheet is distinguished from a genuine failure by checking the plugin's error message/code (`isShareCancellation`); when the distinction is not available on a given plugin version, the design treats a `Share.share` rejection after a successful write as `shared` (file was offered; whether the user picked a target is not reliably knowable), so the user is never shown a false error toast for simply closing the sheet. The unit tests mock the plugin to produce both a clean dismissal signal and a real I/O failure to verify both branches once the plugin's actual cancellation signal is confirmed against `@capacitor/share` 8.x source during implementation.

`DangerZone.tsx`'s `exportJson` and `ExportData.tsx`'s `download` change their final steps from building the anchor to calling `saveAndShare(blob, filename)` and mapping the `ExportResult` to toast text: `shared`/`downloaded` → existing success wording (adjusted to say "Shared" on native, per Requirement 4.10), `cancelled` → no toast, `failed` → existing error wording.

### Haptics

`frontend/src/native/haptics.ts`:

```typescript
export type HapticKind = 'save' | 'undo';

export async function fireHaptic(kind: HapticKind): Promise<void> {
  if (!isNativePlatform() || prefersReducedMotion()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: kind === 'save' ? ImpactStyle.Light : ImpactStyle.Medium });
  } catch {
    /* ignore — never affects the save/undo result */
  }
}
```

`prefersReducedMotion()` reuses the existing `matchMedia('(prefers-reduced-motion: reduce)')` check already used by `useActionArrival.ts`, factored into a shared tiny helper so both call sites agree. `fireHaptic('save')` is called from the reducer effect (or the component effect that observes `entry.phase` transition into `'saved'`) in `quickAddStore`/`QuickAddEntries`; `fireHaptic('undo')` is called on the transition that corresponds to a completed undo (`'undone'` phase reached from `'removing'`).

### System bars and edge-to-edge

`MainActivity.java` drops `WindowCompat.setDecorFitsSystemWindows(getWindow(), true)` (the Android-14-style opt-out, which the audit confirms stops applying at targetSdk 36 on Android 16) and instead calls `EdgeToEdge.enable(this)` before `super.onCreate`, per the Capacitor 8 `SystemBars` guidance. `capacitor.config.ts` sets `plugins.SystemBars.insetsHandling` — the emulator evaluation task (6.2) decides between `'native'` and `'css'`; this design recommends starting from `'css'` (the Capacitor default, and the only option that also back-fills the `env(safe-area-inset-*)` values the stylesheet already reads) and downgrading to `'native'` only if the emulator run at API 34 shows the CSS variables disagreeing with the WebView's own `env()` values. The chosen value and the emulator evidence are recorded in `docs/android-emulator-results.md`.

`main.tsx`'s native-only block changes from `StatusBar.setOverlaysWebView`/`setBackgroundColor`/`setStyle` to a single `applySystemBarStyle(theme)` call from `native/systemBars.ts`:

```typescript
export async function applySystemBarStyle(theme: 'light' | 'dark'): Promise<void> {
  if (!isNativePlatform()) return;
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
  await SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
}
```

This is called once at startup and again from the existing theme-toggle code path (wherever `document.documentElement.dataset.theme` is written) so a runtime theme switch updates the icon style. `AndroidManifest.xml`'s `<activity>` entry adds `android:windowSoftInputMode="adjustResize"` so the Quick Add input is pushed above the keyboard; `@capacitor/keyboard` (already a dependency) is used only if the emulator check in Requirement 6.6 shows `adjustResize` alone is insufficient, in which case `Keyboard.setResizeMode({ mode: KeyboardResize.Body })` is added to the same startup block.

### Offline, slow network, and cold start

`frontend/src/native/networkStatus.ts` exposes a tiny store (`subscribe`/`getSnapshot`, consumable via `useSyncExternalStore`) that listens to `window.addEventListener('online'/'offline', …)` — available in both the WebView and a browser, so the banner logic is not gated on `isNativePlatform()` at the listener level, only the requirement to show it is scoped to native by the component that renders it (Requirement 7.8 keeps the web unaffected simply because the existing `Dashboard`/`RegionBoundary` error paths are untouched; the new `OfflineBanner` component is mounted from `App.tsx` only when `isNativePlatform()`).

```typescript
export function describeFetchFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === REQUEST_TIMEOUT_CODE) {
    return 'The server did not answer in time. Check your connection and retry.';
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return 'Could not reach the server. Check your connection and retry.';
  }
  return 'Something went wrong. Retry.';
}

export function shouldShowStaleDataNotice(input: { isOffline: boolean; lastFetchFailed: boolean; hasData: boolean }): boolean {
  return input.hasData && (input.isOffline || input.lastFetchFailed);
}
```

`OfflineBanner.tsx` renders when `isNativePlatform() && isOffline`, with a "Retry" button that calls `queryClient.refetchQueries({ type: 'active' })`; it also subscribes to the `online` event to clear itself and trigger the same refetch automatically (Requirement 7.3). A `CoReceiptBanner`-style "waking up" hint is layered onto the existing "If this takes a few seconds, the free API host is waking up" text already in `Dashboard.tsx` (line ~196): the design extends that existing conditional (`!snapshot && !query.isError`) to also require `query.isFetching` for at least 5 seconds, measured with a `setTimeout` guarding a `showColdStartHint` boolean, rather than introducing a second mechanism.

### Manifest audit and the allowed set

The Merged_Release_Manifest is audited against a fixed, strict allowlist (Requirements 9.6, 9.7, 14.1). The app declares `INTERNET` and `ACCESS_NETWORK_STATE` itself, two libraries add entries that the app does not write, and the design decides each one explicitly:

| Entry | Source | Decision |
|---|---|---|
| `uses-permission android.permission.ACCESS_NETWORK_STATE` | `AndroidManifest.xml` (declared by the app) | Allowed. Normal install-time permission with no user prompt. Without it the Android WebView always reports `navigator.onLine === true` and never fires `offline`, so the offline notice of Requirement 7 cannot appear in a release build. Found on a device during the emulator verification. |
| `uses-permission android.permission.VIBRATE` | `@capacitor/haptics` | Allowed. Normal install-time permission needed by the haptics feature (Requirement 5). |
| `permission` and `uses-permission` `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `androidx.core` | Allowed. The `<permission>` has `protectionLevel="signature"`, so only apps signed with the same key can hold it. |
| `receiver androidx.profileinstaller.ProfileInstallReceiver` (`exported="true"`, guarded by `android.permission.DUMP`) | `androidx.profileinstaller` | Removed. `AndroidManifest.xml` declares `xmlns:tools` and `<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver" tools:node="remove" />`. The receiver only lets `adb` trigger baseline-profile compilation. |

The allowed set is therefore exactly:

- `uses-permission`: `android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE`, `android.permission.VIBRATE`, and `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- `permission`: only `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, and only with `android:protectionLevel="signature"`.
- Exported components: only `MainActivity`. Any other component with `android:exported="true"` (receiver, service, provider, or activity) is a violation.

The audit stays strict: any other permission, a `permission` element with a different name or a non-signature protection level, or any other exported component is a violation. The `verify.mjs` badging check compares the APK's permission list to the same four-entry set.

### Build-mode configuration

`vite.config.ts` gains an `android` mode branch:

```typescript
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (mode === 'android') {
    const apiBase = env.VITE_API_BASE ?? '';
    if (!/^https:\/\//.test(apiBase)) {
      throw new Error('VITE_API_BASE must be an https:// URL when building with --mode android.');
    }
  }
  const isAndroid = mode === 'android';
  // ...
  return {
    plugins: [react(), csp(env.VITE_API_BASE || '', isAndroid), ...(isAndroid ? [stripConsolePlugin()] : [])],
    ...
  };
});
```

`csp(apiBase, isAndroid)` gets a second parameter: when `isAndroid` is true, the `script-src`/`style-src`/`img-src`/`connect-src`/`frame-src` entries that reference `accounts.google.com` are omitted, since Requirement 2.6 forbids loading that script on native and Requirement 8.6 narrows `connect-src` to `'self'` plus the API origin only. `stripConsolePlugin()` is a small esbuild-based plugin (`esbuild.drop: ['console']` applied only to the android-mode production build, via `build.rollupOptions`/`esbuild` options passed through Vite) satisfying Requirement 8.5; it is scoped to `mode === 'android'` so the default web build keeps any intentional `console.warn` (e.g. the one already in `main.tsx`'s Capacitor try/catch, which only ever runs on native anyway).

`package.json` gains:
```
"android:build": "vite build --mode android",
"android:sync": "npm run android:build && CAPACITOR_ENV=release npx cap sync android",
"android:sync:debug": "npm run build && CAPACITOR_ENV=debug npx cap sync android",
"android:release": "npm run android:sync && cd android && ./gradlew bundleRelease assembleRelease",
"android:verify": "node scripts/android/verify.mjs"
```

`capacitor.config.ts` becomes a function of `process.env.CAPACITOR_ENV`:

```typescript
const env = process.env.CAPACITOR_ENV === 'debug' ? 'debug' : 'release';
const isDebug = env === 'debug';
const config: CapacitorConfig = {
  appId: 'online.projectmoney.app',
  appName: 'Project Money',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: isDebug ? ['project-money-api.onrender.com', '10.0.2.2'] : ['project-money-api.onrender.com'],
  },
  android: {
    allowMixedContent: isDebug,
    webContentsDebuggingEnabled: isDebug,
    loggingBehavior: isDebug ? 'debug' : 'none',
  },
  plugins: { StatusBar: { /* legacy, kept only for pre-15 fallback */ }, SplashScreen: { ... }, SystemBars: { insetsHandling: 'css' } },
};
export default config;
```

The file imports nothing else local, so the Capacitor CLI (which `require`s this file directly, outside Vite) can load it (Requirement 10.6). No `server.url` is ever set in either branch — the app always loads its bundled `dist` via `https://localhost`, matching the user's CORS instruction.

## Components and Interfaces

### Token_Store (`tokenStore.ts`)
`getToken(): string | null`, `setToken(token: string): void`, `clearToken(): void`. No React dependency; pure wrapper over `sessionStorage`.

### Platform_Module (`platform.ts`)
`isNativePlatform(): boolean`.

### Back_Button_Policy (`native/backButton.ts`)
`decideBackAction(input: BackDecisionInput): BackAction`, `pushOverlay`, `popOverlay`, `topOverlay`, `useBackButtonHandler(mustAgree: boolean): void`.

### Export_Share_Wrapper (`native/exportFile.ts`)
`saveAndShare(blob: Blob, filename: string): Promise<ExportResult>`, `sweepStaleExportFiles(): Promise<void>`.

### Haptics (`native/haptics.ts`)
`fireHaptic(kind: 'save' | 'undo'): Promise<void>`.

### System bars (`native/systemBars.ts`)
`applySystemBarStyle(theme: 'light' | 'dark'): Promise<void>`.

### Network status (`native/networkStatus.ts`)
`subscribeOnlineStatus(cb): () => void`, `getOnlineStatusSnapshot(): boolean`, `describeFetchFailure(error: unknown): string`, `shouldShowStaleDataNotice(input): boolean`.

### `GoogleSignInButton` and `AuthDivider`, changed
Both components call `isNativePlatform()` at the top and return `null` immediately when it is true, before loading the GSI script or rendering the divider. `AuthPage.tsx` requires no change — it keeps rendering `<GoogleSignInButton .../>` and `<AuthDivider />` unconditionally; the components themselves decide to render nothing.

### `MainActivity.java`, changed
```java
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        if (SecureWindowPolicy.shouldSetSecureFlag(getApplicationInfo())) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
```

### `SecureWindowPolicy.java`, new
```java
public final class SecureWindowPolicy {
    private SecureWindowPolicy() {}
    public static boolean shouldSetSecureFlag(ApplicationInfo appInfo) {
        return (appInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0;
    }
}
```
`debuggable` is false only in a `release` build (`app/build.gradle`'s release block sets `debuggable false` explicitly even though it is Gradle's default, to make the invariant explicit next to `minifyEnabled true`), so this ties `FLAG_SECURE` to the build type without a second source of truth.

## Data Models

No persistent data model changes. In-memory shapes introduced:

```typescript
interface BackDecisionInput { pathname: string; mustAgree: boolean; hasInAppHistory: boolean; topOverlay: OverlayEntry | undefined; }
interface OverlayEntry { id: string; closable: boolean; onClose: () => void; }
interface ExportResult { outcome: 'downloaded' | 'shared' | 'cancelled' | 'failed'; }
```

`Android_Env_File` (`frontend/.env.android`, gitignored) holds `VITE_API_BASE`, `VITE_QUICK_ADD_ENABLED=false`, `VITE_FINANCIAL_CLARITY_ENABLED=false`; `.env.android.example` documents the same three keys with the Render URL as the example value.

`Keystore_Properties` (`frontend/android/keystore.properties`, gitignored) holds `storeFile`, `storePassword`, `keyAlias`, `keyPassword`; `keystore.properties.example` documents the four keys with placeholder values.

## Error Handling

- **Missing `VITE_API_BASE` / non-https in android mode**: `vite build --mode android` throws synchronously before bundling (Requirement 8.4).
- **Missing or incomplete `keystore.properties`**: `app/build.gradle`'s signing-config block throws a `GradleException` naming the missing file or property before any release task runs (Requirement 11.4), rather than silently falling back to the debug key (which Gradle would otherwise do for an unconfigured release signing config).
- **Missing or invalid `buildNumber`**: an invalid value (not a positive integer, or above 2100000000) throws during Gradle evaluation for every build. A missing value throws from `gradle.taskGraph.whenReady` when the task graph contains a release or signing task (`assembleRelease`, `bundleRelease`, `packageRelease`, and the bundle signing tasks), with a message naming `-PbuildNumber`, because Google Play rejects a reused `versionCode`. Debug builds default `versionCode` to 1 (Requirement 11.8).
- **`sessionStorage` throwing on read** (e.g. a WebView with storage disabled): `tokenStore.getToken()` catches and returns `null`, so the app falls back to the signed-out state instead of crashing.
- **Export write failure**: `saveAndShare` returns `{ outcome: 'failed' }`; the caller shows the existing error-toast wording and leaves no partial file (the `writeFile` call either fully succeeds or throws before a URI is returned).
- **Export share cancellation**: reported as `{ outcome: 'cancelled' }`; the caller shows no toast.
- **Haptics plugin rejection**: swallowed inside `fireHaptic`; never surfaces to the save/undo UI.
- **Offline / unreachable server**: `describeFetchFailure` maps every network-shaped error to one friendly, retryable message instead of the raw `TypeError: Failed to fetch` text; `OfflineBanner` offers Retry.
- **Manifest audit violations**: `auditManifest.mjs` prints every violation found (not just the first), including any permission or exported component outside the allowed set, and exits non-zero; a clean manifest exits 0.
- **Verify script step failure**: `verify.mjs` stops at the first failing step and exits non-zero, naming the step, rather than continuing to the next check on a broken artifact.

## Accessibility and Responsive Interface Contract

- The Google button's removal on native does not change tab order or labelling of the remaining email/password form; `AuthDivider`'s removal means the form's first focusable element becomes the email field directly, which is the existing behaviour when `VITE_GOOGLE_CLIENT_ID` is already unset (this code path already exists and is exercised by current tests).
- `OfflineBanner` is a `role="status"` live region (informational, not blocking) with a single documented "Retry" button; it never steals focus.
- The back-button handling has no visual component of its own; it does not change any existing focus-trap behaviour inside `Modal` (Escape-to-close keyboard behaviour on web is untouched since the listener only attaches on native).
- `adjustResize` plus the existing `env(safe-area-inset-*)` CSS keeps the Quick Add input and bottom tabs within the safe area at 320px-equivalent emulator density and in both themes; this is verified on-device per Requirement 6, not by a unit test, since it depends on real WebView layout.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Token round trip and clearing

For any string value used as a token, calling `setToken` with it and then `getToken` returns that exact string, and calling `clearToken` afterward makes `getToken` return `null`.

**Validates: Requirements 1.3, 1.4**

### Property 2: Google sign-in affordance appears exactly off native

For any combination of `mode` (`'login' | 'register'`) and `disabled` boolean passed to `GoogleSignInButton`, and any boolean returned by `isNativePlatform()`, the component (and the adjacent `AuthDivider`) renders no output when that boolean is true and renders its normal output when it is false.

**Validates: Requirements 2.2, 2.3**

### Property 3: The back-button decision is total and exact

For any pathname, any `mustAgree` boolean, any `hasInAppHistory` boolean, and any `topOverlay` value (present-and-closable, present-and-locked, or absent), `decideBackAction` returns exactly one of `close-overlay`, `consume`, `navigate-back`, `minimize`, and that result always equals the value computed by a reference implementation that checks, in order: an overlay present and closable → `close-overlay`; an overlay present and not closable → `consume`; pathname `/agreement` and `mustAgree` → `minimize`; pathname `/` or `/login` → `minimize`; `hasInAppHistory` → `navigate-back`; otherwise → `minimize`.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

### Property 4: Export write-then-share always targets the written file, and the file is always cleaned up

For any non-empty blob content and any valid export filename, on a simulated native platform with mocked `Filesystem` and `Share` plugins, `saveAndShare` always calls `Share.share` with the exact URI that `Filesystem.writeFile` returned for that call, and — for every one of `Share.share` resolving, rejecting with a cancellation signal, or rejecting with another error — a `Filesystem.deleteFile` call for that same path is scheduled exactly once.

**Validates: Requirements 4.1, 4.2**

### Property 5: Haptic feedback fires exactly on native, non-reduced-motion saves and undos, with distinct kinds

For any combination of platform (native or not), reduced-motion preference (on or off), and event kind (`'save'` or `'undo'`), `fireHaptic` calls the underlying `Haptics.impact` exactly when the platform is native and reduced motion is off, and the `ImpactStyle` it requests for `'save'` is always different from the one it requests for `'undo'`.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 6: Network failures are always described without leaking raw error text, and the stale-data notice is exactly the offline-or-failed case

For any generated error shape drawn from timeout errors, `TypeError`-style fetch failures, `AbortError`-style aborts, and arbitrary other `Error` instances with random messages, `describeFetchFailure` never returns a string containing the original `.message` text verbatim and always returns one of its three fixed, retry-oriented messages. Independently, for any combination of `isOffline`, `lastFetchFailed`, and `hasData` booleans, `shouldShowStaleDataNotice` returns true if and only if `hasData` is true and at least one of `isOffline` or `lastFetchFailed` is true.

**Validates: Requirements 7.5, 7.7**

### Property 7: The Android build mode rejects every non-https/missing API base and accepts every https one

For any string drawn from a generator of "bad" values (empty, `http://` URLs, `ftp://` URLs, whitespace, undefined) and any string drawn from a generator of valid `https://` URLs, building the Vite config validation for `mode: 'android'` throws for every bad value and does not throw for any valid value.

**Validates: Requirements 8.4**

### Property 8: The Android-mode Content-Security-Policy never references Google and always scopes `connect-src` to self and the API origin

For any valid `https://` API base URL, the CSP string produced for `mode: 'android'` contains `connect-src 'self' <origin>` for that URL's origin and contains no occurrence of `accounts.google.com`, while the CSP string produced for any other mode with the same URL is unchanged from its current content (including the Google entries).

**Validates: Requirements 2.6, 8.6**

### Property 9: The manifest audit flags exactly the configured violations

For any generated manifest-shaped object that independently varies `debuggable`, `usesCleartextTraffic`, `allowBackup`, the presence of a `networkSecurityConfig` reference, the set of exported components (any kind, including receivers, services, and providers), the set of `uses-permission` names, and the set of `permission` declarations (name and `protectionLevel`), `auditManifest`'s reported violation set exactly equals the set of rules that object actually breaks (per Requirement 14.1's list), and the script's exit status is 0 if and only if that set is empty. A component is allowed to be exported only when it is `MainActivity`. A `uses-permission` is allowed only when it is `android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE`, `android.permission.VIBRATE`, or `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. A `permission` is allowed only when it is `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` with `protectionLevel` `signature`.

**Validates: Requirements 14.1, 14.2, 14.3**

### Property 10: The CORS allowlist accepts exactly its configured origins

For any generated allowlist of distinct origin strings and any generated candidate origin (drawn half the time from the allowlist itself and half the time from near-miss variants — a different scheme, a different port, an added trailing slash, or a different host sharing a suffix with an allowlisted entry), `resolveCorsOrigin`'s callback allows the candidate if and only if the candidate is byte-for-byte a member of the allowlist.

**Validates: Requirements 15.1, 15.2, 15.3**

## Testing Strategy

**Unit and property tests (Vitest, frontend; `node:test`, backend)**:
- `tokenStore`: round-trip property (Property 1), plus example tests for the `sessionStorage`-throws edge case and a source-scan test asserting `api.ts`, `useSessionWarning.ts`, `DangerZone.tsx`, and `ExportData.tsx` contain no direct `sessionStorage.getItem('pm_token')` call.
- `platform.ts`: example test asserting it is the only module (besides itself) importing `Capacitor.isNativePlatform` directly (source scan over `frontend/src`, excluding `platform.ts`).
- `GoogleSignInButton`/`AuthDivider`: property test (Property 2) with `platform.ts` mocked; example test asserting no `<script src="https://accounts.google.com/gsi/client">` is appended when native.
- `backButton.ts`: totality/exactness property (Property 3); example tests for Quick Add dialog registering/unregistering as an overlay, for the web no-listener case, and for `minimize` calling `App.minimizeApp()` and never `App.exitApp()`.
- `exportFile.ts`: write-then-share-then-cleanup property (Property 4) with fake timers for the 60-second grace period; example tests for the startup sweep, the web anchor-download path being unchanged, the write-failure edge case, and the 401 session-expiry path in `DangerZone`/`ExportData` staying intact.
- `haptics.ts`: platform/reduced-motion/kind property (Property 5); example test for the plugin-rejection edge case not affecting the save/undo result.
- `networkStatus.ts`: error-description and stale-notice properties (Property 6); example tests for the online/offline event wiring, the Retry button, and the 5-second cold-start hint timing.
- `vite.config.ts`: android-mode validation property (Property 7) and CSP property (Property 8), run directly against the exported `csp()`/validation helpers refactored to be importable without booting Vite.
- `scripts/android/auditManifest.mjs`: violation-detection property (Property 9) against generated manifest objects, run with `node --test` or Vitest depending on the script's module system; example tests for a known-clean fixture manifest (exit 0, containing the three allowed `uses-permission` entries and the signature `permission`) and a known-violating fixture manifest (exit non-zero, all violations printed, including an exported receiver and a non-allowed permission).
- Backend `corsAllowlist.test.js`: allowlist exactness property (Property 10) against the exported `resolveCorsOrigin` (exported for testing from `app.js`, which already contains the pure logic); example tests for `https://localhost` specifically and for the `credentials: false` header behaviour.
- Native JUnit: `SecureWindowPolicyTest` covering both `debuggable` values; native instrumented `MainActivityLaunchTest` asserting the activity launches and the package name.

**Integration/manual verification (not property-based, per the PBT-applicability rules)**:
- `./gradlew lint assembleDebug bundleRelease assembleRelease` run clean.
- `npm run android:verify` (manifest audit on the merged release manifest, `apksigner verify`, `jarsigner -verify` on the AAB, `aapt2 dump badging` assertions, release-bundle console/origin checks).
- Emulator smoke checklist on `Pixel_7_2` at API 34 and API 37, recorded in `docs/android-emulator-results.md`.
- `frontend/scripts/android/smoke.sh` for the adb-driven install/launch/logcat check.

Every test task in `tasks.md` is required (none marked optional) per the user's instruction; all property tests use `assertProperty` from `frontend/src/test/propertyReport.ts` (frontend) or the backend twin `backend/test/helpers/propertyReport.js` (backend), with at least 100 generated cases each.
