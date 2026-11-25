# Implementation Plan: Android App Release

## Overview

This plan builds the shared TypeScript pieces first (platform module, token store, back button, export/share, haptics, system bars, network status), wires them into the existing components, then hardens the native Android project (manifest, Gradle, signing, secure window, native tests), adds the build/verification tooling and the backend CORS test, and closes with documentation and emulator verification. Every coding and testing task is required; none are marked optional, per the user's instruction that every test run. No task deploys, submits to Play Console, or runs a long-lived server — long commands (Gradle builds, emulator boot) are called out to run in the background with logs, since this machine runs one heavy process at a time and the shell tool output can come back empty.

## Tasks

- [x] 1. Add the platform module and token store
  - [x] 1.1 Create `frontend/src/platform.ts`
    - Export `isNativePlatform()` wrapping `Capacitor.isNativePlatform()` from `@capacitor/core`.
    - _Requirements: 2.1_
  - [x] 1.2 Create `frontend/src/tokenStore.ts`
    - Export `getToken`, `setToken`, `clearToken` over `sessionStorage` key `pm_token`, with `getToken` catching a read failure and returning `null`.
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.8_
  - [x] 1.3 Route `api.ts`, `useSessionWarning.ts`, `DangerZone.tsx`, and `ExportData.tsx` through the Token_Store
    - In `frontend/src/api.ts`, replace the local `TOKEN_KEY` sessionStorage reads/writes/removal for the token with calls to `getToken`/`setToken`/`clearToken` from `./tokenStore`, keeping `getToken`, `setAuth`, `clearAuth` exported with unchanged signatures.
    - In `frontend/src/hooks/useSessionWarning.ts:33`, replace `sessionStorage.getItem('pm_token')` with `getToken()` imported from `../tokenStore`.
    - In `frontend/src/components/DangerZone.tsx:96` and `:151`, and `frontend/src/components/ExportData.tsx:15`, replace `sessionStorage.getItem('pm_token') ?? ''` with `getToken() ?? ''` imported from `../tokenStore`.
    - _Requirements: 1.2, 1.6_
  - [x] 1.4 Write the property test for the token round trip
    - **Property 1: Token round trip and clearing**
    - Add `frontend/src/tokenStore.property.test.ts` using `assertProperty` (>= 100 cases) over generated token strings; comment `Feature: android-app-release, Property 1: Token round trip and clearing`.
    - **Validates: Requirements 1.3, 1.4**
  - [x] 1.5 Write unit tests for the token store edge case and the source scan
    - Add `frontend/src/tokenStore.test.ts` covering the `sessionStorage.getItem` throwing case returning `null`.
    - Add a source-scan test (e.g. in `frontend/src/tokenStore.test.ts` or a dedicated `frontend/src/test/tokenStoreUsage.test.ts`) that reads `api.ts`, `useSessionWarning.ts`, `DangerZone.tsx`, and `ExportData.tsx` from disk and asserts none contains the literal `sessionStorage.getItem('pm_token')`.
    - _Requirements: 1.1, 1.8_

- [x] 2. Hide the Google sign-in affordance on native
  - [x] 2.1 Gate `GoogleSignInButton` and `AuthDivider` on `isNativePlatform()`
    - In `frontend/src/components/GoogleSignInButton.tsx`, make both exported components return `null` immediately when `isNativePlatform()` from `../platform` is true, before any GSI script loading.
    - _Requirements: 2.2, 2.3, 2.4, 2.5_
  - [x] 2.2 Write the property test for the Google button visibility
    - **Property 2: Google sign-in affordance appears exactly off native**
    - Add `frontend/src/components/GoogleSignInButton.property.test.tsx` mocking `../platform`, using `assertProperty` (>= 100 cases) over generated `mode`/`disabled`/native-boolean combinations; comment `Feature: android-app-release, Property 2: Google sign-in affordance appears exactly off native`.
    - **Validates: Requirements 2.2, 2.3**
  - [x] 2.3 Write the example test for the GSI script not loading on native
    - Extend `frontend/src/components/GoogleSignInButton.test.tsx` (or add a new test file) asserting that with `isNativePlatform()` mocked true, no `<script>` tag with `src` containing `accounts.google.com` is appended to `document.head`.
    - _Requirements: 2.5_
  - [x] 2.4 Narrow the Content-Security-Policy and strip console output for the Android build mode
    - In `frontend/vite.config.ts`, add validation that throws when `mode === 'android'` and `VITE_API_BASE` is missing or not `https://`-prefixed; extend `csp(apiBase, isAndroid)` to omit every `accounts.google.com` entry when `isAndroid` is true; add a console-stripping esbuild/plugin option applied only when `mode === 'android'`.
    - _Requirements: 2.6, 8.4, 8.5, 8.6_
  - [x] 2.5 Write the property test for Android-mode build validation
    - **Property 7: The Android build mode rejects every non-https/missing API base and accepts every https one**
    - Add `frontend/vite.config.test.ts` exporting/importing the validation helper directly, using `assertProperty` (>= 100 cases) over generated bad and good `VITE_API_BASE` values; comment `Feature: android-app-release, Property 7: The Android build mode rejects every non-https/missing API base and accepts every https one`.
    - **Validates: Requirements 8.4**
  - [x] 2.6 Write the property test for the Android-mode CSP
    - **Property 8: The Android-mode Content-Security-Policy never references Google and always scopes connect-src to self and the API origin**
    - Extend `frontend/vite.config.test.ts` using `assertProperty` (>= 100 cases) over generated valid `https://` URLs, checking both `mode: 'android'` and another mode's CSP output; comment `Feature: android-app-release, Property 8: The Android-mode Content-Security-Policy never references Google and always scopes connect-src to self and the API origin`.
    - **Validates: Requirements 2.6, 8.6**
  - [x] 2.7 Write the example test for non-android build behaviour staying unchanged
    - Extend `frontend/vite.config.test.ts` asserting that building the CSP or validation helper for `mode: 'production'`/`'development'` keeps today's output (Google entries present, no throw on missing `VITE_API_BASE`).
    - _Requirements: 8.8_

- [x] 3. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the back-button policy and wire it in
  - [x] 4.1 Create the pure back-button decision function and overlay registry
    - Add `frontend/src/native/backButton.ts` exporting `decideBackAction`, `OverlayEntry`, `pushOverlay`, `popOverlay`, `topOverlay`, per the design.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 4.2 Add `useBackButtonHandler` and wire it into `App.tsx`
    - In the same file or a sibling `frontend/src/native/useBackButtonHandler.ts`, add the hook that attaches `@capacitor/app`'s `backButton` listener only when `isNativePlatform()` is true, dispatching `close-overlay`/`navigate-back`/`minimize` as designed, and calling it once from `App.tsx` with the current `mustAgree` value.
    - _Requirements: 3.4, 3.8, 3.9, 3.10_
  - [x] 4.3 Register the Quick Add dialog as a closable overlay
    - In `frontend/src/components/quickAdd/QuickAddDialog.tsx`, call `pushOverlay`/`popOverlay` from `../../native/backButton` on open/close, passing `closable: !locked`.
    - _Requirements: 3.8_
  - [x] 4.4 Write the property test for the back-button decision
    - **Property 3: The back-button decision is total and exact**
    - Add `frontend/src/native/backButton.property.test.ts` using `assertProperty` (>= 100 cases) over generated pathnames, `mustAgree`, `hasInAppHistory`, and overlay states, compared against the reference predicate from the design; comment `Feature: android-app-release, Property 3: The back-button decision is total and exact`.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
  - [x] 4.5 Write unit tests for overlay wiring, the web no-listener case, and minimize semantics
    - Add `frontend/src/native/useBackButtonHandler.test.tsx` (mocking `@capacitor/app` and `../platform`) covering: no listener registered when `isNativePlatform()` is false; `App.minimizeApp()` called (never `App.exitApp()`) for every `minimize` outcome; the Quick Add dialog pushing/popping its overlay entry on open/close.
    - _Requirements: 3.9, 3.10_

- [x] 5. Implement export/share, haptics, system bars, and network status
  - [x] 5.1 Create the export/share wrapper
    - Add `frontend/src/native/exportFile.ts` exporting `saveAndShare` and `sweepStaleExportFiles`, branching on `isNativePlatform()` as designed, using `@capacitor/filesystem`'s `Directory.Cache` and `@capacitor/share`, and keeping the existing `URL.createObjectURL`/`<a download>` path on web.
    - Add `@capacitor/filesystem` and `@capacitor/share` to `frontend/package.json` at Capacitor-8-compatible versions and run the project's package manager install.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_
  - [x] 5.2 Wire `DangerZone.tsx` and `ExportData.tsx` to `saveAndShare`
    - Replace the anchor-building code in `DangerZone.tsx`'s `exportJson` and `ExportData.tsx`'s `download` with a call to `saveAndShare(blob, filename)`, mapping `ExportResult.outcome` to toast text (`shared`/`downloaded` → success wording naming sharing on native per Requirement 4.10, `cancelled` → no toast, `failed` → existing error wording), keeping the existing 401 session-expiry handling before the blob is read.
    - _Requirements: 4.1, 4.10, 4.11_
  - [x] 5.3 Restrict `file_paths.xml` to a cache path and call the startup sweep
    - Edit `frontend/android/app/src/main/res/xml/file_paths.xml` to declare only a `cache-path` entry, removing the `external-path` entry.
    - Call `sweepStaleExportFiles()` once from `frontend/src/main.tsx`'s existing native-only startup block.
    - _Requirements: 4.3, 4.8_
  - [x] 5.4 Write the property test for export write-then-share-then-cleanup
    - **Property 4: Export write-then-share always targets the written file, and the file is always cleaned up**
    - Add `frontend/src/native/exportFile.property.test.ts` mocking `@capacitor/filesystem` and `@capacitor/share`, using `assertProperty` (>= 100 cases) over generated blob contents, filenames, and share outcomes (resolve, cancellation-shaped rejection, other rejection), with fake timers to observe the scheduled cleanup; comment `Feature: android-app-release, Property 4: Export write-then-share always targets the written file, and the file is always cleaned up`.
    - **Validates: Requirements 4.1, 4.2**
  - [x] 5.5 Write unit tests for the sweep, the web path, write failure, and the 401 path
    - Add `frontend/src/native/exportFile.test.ts` covering: the startup sweep deleting only matching filenames from a mocked cache listing; the web branch still calling `URL.createObjectURL` and never the Filesystem/Share plugins; a `Filesystem.writeFile` rejection producing `{ outcome: 'failed' }` with no cleanup scheduled.
    - Extend `frontend/src/components/DangerZone.test.tsx` and add a test for `ExportData.tsx` covering the existing 401 session-expiry behaviour still firing before `saveAndShare` is reached.
    - _Requirements: 4.4, 4.6, 4.11_
  - [x] 5.6 Create the haptics wrapper and wire it into Quick Add save/undo
    - Add `frontend/src/native/haptics.ts` exporting `fireHaptic('save' | 'undo')`, gated on `isNativePlatform()` and a shared reduced-motion check (factored out of `useActionArrival.ts`'s existing `matchMedia` check into a small shared helper used by both).
    - Call `fireHaptic('save')` on the Quick Add entry reaching the `saved` phase and `fireHaptic('undo')` on an undo completing, from the existing reducer-adjacent effect in `frontend/src/clarity/quickAdd/quickAddStore.ts` or `QuickAddEntries.tsx`, whichever already observes that transition.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 5.7 Write the property test for haptic feedback
    - **Property 5: Haptic feedback fires exactly on native, non-reduced-motion saves and undos, with distinct kinds**
    - Add `frontend/src/native/haptics.property.test.ts` mocking `@capacitor/haptics`, `../platform`, and the reduced-motion helper, using `assertProperty` (>= 100 cases) over generated platform/reduced-motion/kind combinations; comment `Feature: android-app-release, Property 5: Haptic feedback fires exactly on native, non-reduced-motion saves and undos, with distinct kinds`.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  - [x] 5.8 Write the unit test for haptics plugin rejection and the `navigator.vibrate` non-call
    - Add to `frontend/src/native/haptics.test.ts`: a mocked `Haptics.impact` rejection leaving the caller's save/undo result unaffected; an assertion that `navigator.vibrate` is never called by this module.
    - _Requirements: 5.5_
  - [x] 5.9 Create the system-bars wrapper and update `MainActivity`/`main.tsx`
    - Add `frontend/src/native/systemBars.ts` exporting `applySystemBarStyle(theme)` using `SystemBars.setStyle` from `@capacitor/core`.
    - In `frontend/src/main.tsx`, replace the `StatusBar.setOverlaysWebView`/`setBackgroundColor`/`setStyle` calls with `applySystemBarStyle(theme)`, and call it again from the existing theme-toggle code path.
    - In `frontend/android/app/src/main/java/online/projectmoney/app/MainActivity.java`, remove the `WindowCompat.setDecorFitsSystemWindows(getWindow(), true)` call and call `EdgeToEdge.enable(this)` before `super.onCreate`.
    - Add `android:windowSoftInputMode="adjustResize"` to the `<activity>` entry in `AndroidManifest.xml`.
    - Set `plugins.SystemBars.insetsHandling` to `'css'` in `capacitor.config.ts` (subject to the emulator check in task 14).
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.7_
  - [x] 5.10 Write the unit test for the system-bars wiring
    - Add `frontend/src/native/systemBars.test.ts` mocking `@capacitor/core`'s `SystemBars`, asserting `setStyle` is called with the style matching each theme value and that `StatusBar.setOverlaysWebView`/`setBackgroundColor` are not called from `main.tsx`'s startup block (source-scan or spy-based).
    - _Requirements: 6.3, 6.4_
  - [x] 5.11 Create the network-status module and the offline banner
    - Add `frontend/src/native/networkStatus.ts` exporting `subscribeOnlineStatus`, `getOnlineStatusSnapshot`, `describeFetchFailure`, `shouldShowStaleDataNotice`.
    - Add `frontend/src/components/OfflineBanner.tsx` rendering only when `isNativePlatform()` and offline, with a `role="status"` region and a Retry button that calls `queryClient.refetchQueries({ type: 'active' })`; mount it once from `App.tsx`.
    - Extend `frontend/src/pages/Dashboard.tsx`'s existing cold-start hint condition (`!snapshot && !query.isError`) to also require `query.isFetching` for at least 5 seconds using a timeout-backed boolean, reusing the existing hint text.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8_
  - [x] 5.12 Write the property tests for network failure description and the stale-data notice
    - **Property 6: Network failures are always described without leaking raw error text, and the stale-data notice is exactly the offline-or-failed case**
    - Add `frontend/src/native/networkStatus.property.test.ts` using `assertProperty` (>= 100 cases) over generated error shapes and over generated `isOffline`/`lastFetchFailed`/`hasData` combinations; comment `Feature: android-app-release, Property 6: Network failures are always described without leaking raw error text, and the stale-data notice is exactly the offline-or-failed case`.
    - **Validates: Requirements 7.5, 7.7**
  - [x] 5.13 Write unit tests for the offline banner, retry, and the cold-start hint timing
    - Add `frontend/src/components/OfflineBanner.test.tsx` covering: the banner appearing within the test's simulated 1 second of an `offline` event, disappearing and triggering a refetch on `online`, and the Retry button triggering a refetch; extend `frontend/src/pages/Dashboard.test.tsx` (or add one) for the 5-second cold-start hint using fake timers; assert the banner never renders when `isNativePlatform()` is mocked false.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.8_

- [x] 6. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Harden the Android manifest, backup, and network security configuration
  - [x] 7.1 Add network security config, backup rules, and manifest hardening
    - Add `frontend/android/app/src/main/res/xml/network_security_config.xml` with `cleartextTrafficPermitted="false"` and system CA trust only.
    - Add `frontend/android/app/src/debug/res/xml/network_security_config.xml` permitting cleartext to `10.0.2.2` and `localhost` only.
    - Add `frontend/android/app/src/main/res/xml/data_extraction_rules.xml` and `frontend/android/app/src/main/res/xml/backup_rules.xml`, each excluding every domain.
    - Edit `frontend/android/app/src/main/AndroidManifest.xml`: set `android:allowBackup="false"`, remove `android:usesCleartextTraffic="true"`, add `android:networkSecurityConfig="@xml/network_security_config"`, `android:dataExtractionRules="@xml/data_extraction_rules"`, and `android:fullBackupContent="@xml/backup_rules"`.
    - In the same manifest, declare `xmlns:tools` and add `<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver" tools:node="remove" />` so the exported receiver that a library adds does not appear in the merged manifest. Declare `android.permission.INTERNET` and `android.permission.ACCESS_NETWORK_STATE` (the WebView needs the latter to report offline state, Requirement 7). Keep the library-added `android.permission.VIBRATE` and `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` entries, which the allowed set permits.
    - Run `./gradlew :app:processReleaseManifest` and confirm the merged manifest has `MainActivity` as its only `android:exported="true"` component and only the allowed permissions.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7_
  - [x] 7.2 Add the `keystore.properties`-driven release signing config, minification, and ProGuard rules
    - Edit `frontend/android/app/build.gradle`: load `keystore.properties` if present and fail the `release` build type's evaluation with a clear message naming the missing file or property if it is absent or incomplete; set the release build type's `minifyEnabled true`, `shrinkResources true`, `debuggable false`, and the ProGuard files.
    - Edit `frontend/android/app/proguard-rules.pro` to keep Capacitor plugin classes/methods, `@JavascriptInterface` members, and the Capacitor bridge's reflectively-loaded application classes.
    - Add `frontend/android/keystore.properties.example` documenting `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.
    - Add `*.jks`, `*.keystore`, `keystore.properties`, and `.env.android` to `frontend/android/.gitignore` and the repository root `.gitignore` (the root file already ignores `*.jks`/`*.keystore`; add `keystore.properties` and `.env.android`/`.env.android.local` there).
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [x] 7.3 Derive `versionName`/`versionCode` from `package.json` and a `buildNumber` property
    - Edit `frontend/android/app/build.gradle` to read `frontend/package.json`'s `version` field for `versionName`, and read the Gradle property `buildNumber` for `versionCode`. Fail evaluation with a message naming `buildNumber` when it is not a positive integer no greater than 2100000000. When `buildNumber` is missing, default `versionCode` to 1 for debug builds, and fail any build whose task graph contains a release or signing task (`assembleRelease`, `bundleRelease`, `packageRelease`) with a message naming `-PbuildNumber`.
    - Document the `-PbuildNumber=<n>` usage and the `android/gradle.properties` alternative in a short comment in `build.gradle`.
    - _Requirements: 11.6, 11.7, 11.8_
  - [x] 7.4 Implement `SecureWindowPolicy` and wire `FLAG_SECURE` into `MainActivity`
    - Add `frontend/android/app/src/main/java/online/projectmoney/app/SecureWindowPolicy.java` exporting `shouldSetSecureFlag(ApplicationInfo appInfo)` as designed.
    - Edit `MainActivity.java` to call `SecureWindowPolicy.shouldSetSecureFlag(getApplicationInfo())` and add `WindowManager.LayoutParams.FLAG_SECURE` to the window before `super.onCreate` when true.
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [x] 7.5 Remove the stale example tests and add real native tests
    - Delete `frontend/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java` and `frontend/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java` and their now-empty `com/getcapacitor/myapp` directories.
    - Add `frontend/android/app/src/test/java/online/projectmoney/app/SecureWindowPolicyTest.java` covering both `FLAG_DEBUGGABLE` states.
    - Add `frontend/android/app/src/androidTest/java/online/projectmoney/app/MainActivityLaunchTest.java` launching `MainActivity` and asserting the package name `online.projectmoney.app` and that a WebView is present.
    - _Requirements: 13.1, 13.2, 13.3_
  - [x] 7.6 Run the native unit test task and record the result
    - Run `./gradlew testDebugUnitTest` from `frontend/android` in the background with output logged to a file (this machine runs one heavy process at a time and the shell tool may return empty output on a long command); confirm it passes by reading the log.
    - _Requirements: 13.4_

- [x] 8. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Add the Android build mode scripts and the Capacitor per-build configuration
  - [x] 9.1 Add `frontend/.env.android.example` and the android npm scripts
    - Add `frontend/.env.android.example` documenting `VITE_API_BASE=https://project-money-api.onrender.com`, `VITE_QUICK_ADD_ENABLED=false`, `VITE_FINANCIAL_CLARITY_ENABLED=false`.
    - Add `android:build`, `android:sync`, `android:sync:debug`, `android:release`, and `android:verify` scripts to `frontend/package.json` as designed.
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 9.2 Make `capacitor.config.ts` a function of `CAPACITOR_ENV`
    - Edit `frontend/capacitor.config.ts` to branch on `process.env.CAPACITOR_ENV` (`'release'` by default) as designed: `android.allowMixedContent`, `android.webContentsDebuggingEnabled`, `loggingBehavior`, `server.allowNavigation`, and no `server.url`/`server.cleartext` in either branch, importing no other local module.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_
  - [x] 9.3 Write a unit test for the Capacitor config branching
    - Add `frontend/capacitor.config.test.ts` asserting the `release` and `debug` branches produce the documented `allowMixedContent`, `webContentsDebuggingEnabled`, `loggingBehavior`, and `allowNavigation` values, and that neither branch sets `server.url`.
    - _Requirements: 10.2, 10.3, 10.4_

- [x] 10. Add the manifest audit script and the verification pipeline
  - [x] 10.1 Implement `auditManifest.mjs`
    - Add `frontend/scripts/android/auditManifest.mjs` that parses a manifest XML file path given as an argument and reports a violation for each rule in Requirement 14.1, printing every violation found and exiting 0 only when none are found. The allowed `uses-permission` set is exactly `android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE`, `android.permission.VIBRATE`, and `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. The only allowed `permission` element is `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` with `protectionLevel` `signature`. The only allowed exported component is `MainActivity`, so an exported receiver, service, or provider is a violation. Any other permission or exported component is a violation.
    - _Requirements: 14.1, 14.2, 14.3_
  - [x] 10.2 Write the property test for the manifest audit
    - **Property 9: The manifest audit flags exactly the configured violations**
    - Add `frontend/scripts/android/auditManifest.property.test.mjs` (or `.test.ts` if the script is authored in TypeScript and compiled) using `assertProperty` (>= 100 cases) over generated manifest-shaped objects varying `debuggable`, `usesCleartextTraffic`, `allowBackup`, the `networkSecurityConfig` reference, exported components of every kind (activity, receiver, service, provider), `uses-permission` names, and `permission` declarations (name and `protectionLevel`), compared against a reference violation-set computation; comment `Feature: android-app-release, Property 9: The manifest audit flags exactly the configured violations`.
    - **Validates: Requirements 14.1, 14.2, 14.3**
  - [x] 10.3 Write example tests for a clean fixture and a violating fixture
    - Add two fixture manifest files (clean and violating) under `frontend/scripts/android/__fixtures__/` and a test asserting the clean one exits 0 and the violating one exits non-zero with every expected violation printed. The clean fixture contains the three allowed `uses-permission` entries, the signature `permission`, and `MainActivity` as the only exported component. The violating fixture contains an exported receiver (for example `ProfileInstallReceiver`), a non-allowed permission, and a `permission` with a non-signature protection level.
    - _Requirements: 14.2, 14.3_
  - [x] 10.4 Implement `verify.mjs` and `smoke.sh`
    - Add `frontend/scripts/android/verify.mjs` that runs, in order, the manifest audit against the merged release manifest, `apksigner verify --verbose` on the release APK, `jarsigner -verify` on the release AAB, an `aapt2 dump badging` check asserting package name, `versionName`, `versionCode`, `targetSdkVersion`, `minSdkVersion`, and that the permission list is exactly `android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE`, `android.permission.VIBRATE`, and `online.projectmoney.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, and a release-bundle check asserting no `console.*` call sites and no `http://`/`10.0.2.2`/`localhost:4000` strings in the built JS; stopping and exiting non-zero naming the first failing step; resolving SDK tools from `~/Library/Android/sdk` or `ANDROID_HOME` rather than requiring them on `PATH`.
    - Add `frontend/scripts/android/smoke.sh` that installs the release APK with `adb install`, launches it, and asserts the launch activity is resumed with no `FATAL EXCEPTION` in `logcat`, using `~/Library/Android/sdk/platform-tools/adb`.
    - _Requirements: 14.4, 14.5, 14.6, 14.7, 14.8, 16.7_

- [x] 11. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Add the backend CORS allowlist test
  - [x] 12.1 Export `resolveCorsOrigin` for testing and add the allowlist test
    - In `backend/src/app.js`, export `resolveCorsOrigin` (named export, additive — no behaviour change) so it is importable from a test without starting the server.
    - Add `backend/test/api/corsAllowlist.test.js` covering exact-match acceptance, the documented near-miss rejections (different scheme, different port, trailing slash, suffix-matching host), `https://localhost` specifically, and that no `Access-Control-Allow-Credentials` header is produced.
    - _Requirements: 15.1, 15.2, 15.3, 15.6_
  - [x] 12.2 Write the property test for the CORS allowlist
    - **Property 10: The CORS allowlist accepts exactly its configured origins**
    - Add the property test inside `backend/test/property/corsAllowlist.property.test.js` using the backend `assertProperty` helper from `backend/test/helpers/propertyReport.js` (>= 100 cases) over generated allowlists and candidate origins (half drawn from the allowlist, half near-miss variants); comment `Feature: android-app-release, Property 10: The CORS allowlist accepts exactly its configured origins`.
    - **Validates: Requirements 15.1, 15.2, 15.3**
  - [x] 12.3 Run the full backend test suite and confirm no other file changed
    - Run `npm test` in `backend` in the background with output logged to a file; confirm the suite passes and that `git diff --stat backend/src` shows only the additive export from task 12.1.
    - _Requirements: 15.4, 18.3_

- [x] 13. Write the documentation and the Play Store checklist
  - [x] 13.1 Add the `Android release` section to `README.md` and `HANDOFF.md`
    - Add a section to each covering: the Android_Env_File, build commands (`android:build`, `android:sync`, `android:release`, `android:verify`), Upload_Keystore creation (`keytool -genkeypair`), signing via `keystore.properties`, running the verify script, the CORS step (adding `https://localhost` to Render's `CORS_ORIGIN`, redeploying, and a documented `curl -I -H "Origin: https://localhost"` preflight check), the keystore backup instruction (two offline copies, never committed), and the known limits (sessions end when the app process ends; Google Sign-In is not available on Android in version 1; the first release ships with Quick Add and Financial Clarity off), plus the stated reasons certificate pinning is not used and "Stay signed in" is deferred.
    - _Requirements: 17.1, 17.2, 17.3, 17.6_
  - [x] 13.2 Write `docs/android-play-store-checklist.md`
    - List, as the user's own steps: create the upload keystore, enrol in Play App Signing, upload the AAB to the internal testing track, complete the Data safety form, provide the privacy policy URL `https://<web>/privacy`, provide the account-deletion URL, complete the content rating questionnaire, and set the target audience; state explicitly that the user performs these in Play Console and this feature does not.
    - _Requirements: 17.4, 17.5_

- [x] 14. Emulator build and verification
  - [x] 14.1 Build the Release_Web_Bundle and run the Gradle release tasks
    - Create `frontend/.env.android` locally (not committed) from `.env.android.example` with the real Render API base.
    - Run `npm run android:release -- -PbuildNumber=1` from `frontend` in the background with output logged to a file (or use the next unused number; a release build without `buildNumber` fails by design); confirm the log shows `BUILD SUCCESSFUL` for `bundleRelease` and `assembleRelease`.
    - Run `./gradlew lint assembleDebug bundleRelease assembleRelease` from `frontend/android` in the background with output logged to a file; confirm no lint error.
    - _Requirements: 11.9, 11.10_
  - [x] 14.2 Run `npm run android:verify` and resolve any failure
    - Run the verify script from `frontend` in the background with output logged to a file; if any step fails, fix the named step's cause and rerun until it passes.
    - _Requirements: 14.4, 14.5, 14.6, 14.7, 14.8_
  - [x] 14.3 Boot the `Pixel_7_2` AVD at API 34 and run the smoke checklist
    - Boot the emulator at the API 34 system image in the background (`~/Library/Android/sdk/emulator/emulator -avd Pixel_7_2`), logging output to a file; wait for `adb` (via `~/Library/Android/sdk/platform-tools/adb`) to report the device booted.
    - Install the signed release APK and run through the Smoke_Checklist (install/launch, OTP sign-up, sign-in, add an expense, export CSV and account JSON through the share sheet, back button on Home/a dialog/`/agreement`, rotate, dark mode, airplane mode, kill-and-reopen showing sign-in); confirm with `dumpsys window` that the secure flag is set for the release app window; confirm the export cache files are gone after the 60-second grace period.
    - Record the results, including the `insetsHandling` choice and its rationale (task 5.9/5.10's `css` default versus `native`), in `docs/android-emulator-results.md`.
    - _Requirements: 16.1, 16.2, 16.4, 16.6, 16.8, 6.2, 6.5, 6.6_
  - [x] 14.4 Boot the `Pixel_7_2` AVD at API 37 and run the smoke checklistDraft
    - Repeat task 14.3's boot and checklist against the API 37 system image; additionally install and run the Debug_Build once to confirm the secure flag is absent via `dumpsys window`.
    - Append the API 37 results to `docs/android-emulator-results.md`.
    - _Requirements: 16.3, 16.5, 16.6_

- [x] 15. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- No task is marked optional. Every test task is required and must be executed.
- Every property test uses `assertProperty` from `frontend/src/test/propertyReport.ts` (frontend) or `backend/test/helpers/propertyReport.js` (backend) with at least 100 generated cases, and carries the comment `Feature: android-app-release, Property <number>: <title>` exactly matching the property's title in `design.md`.
- Long-running commands (Gradle builds, `npm test`, emulator boot) must be run in the background with output redirected to a log file and read back afterward, since this machine runs one heavy process at a time and the shell tool can return empty output on a long foreground command.
- No task commits, pushes, or stashes changes; no task deletes production data or submits anything to the Google Play Console.
- The Android SDK's `adb` and `emulator` binaries are not on `PATH` on this machine; every task that uses them must call `~/Library/Android/sdk/platform-tools/adb` and `~/Library/Android/sdk/emulator/emulator` by full path.
- Tasks 14 and parts of task 7.6 depend on a real Android SDK/emulator environment and cannot be completed inside a sandboxed code-only session; if that environment is unavailable when a task is executed, the task should report which specific command could not be run rather than mark itself complete.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["1.4", "1.5"] },
    { "id": 3, "tasks": ["2.1", "2.4"] },
    { "id": 4, "tasks": ["2.2", "2.3", "2.5", "2.6", "2.7"] },
    { "id": 5, "tasks": ["3"] },
    { "id": 6, "tasks": ["4.1"] },
    { "id": 7, "tasks": ["4.2"] },
    { "id": 8, "tasks": ["4.3"] },
    { "id": 9, "tasks": ["4.4", "4.5"] },
    { "id": 10, "tasks": ["5.1", "5.6", "5.9", "5.11"] },
    { "id": 11, "tasks": ["5.2", "5.3", "5.7", "5.8", "5.10", "5.12", "5.13"] },
    { "id": 12, "tasks": ["5.4", "5.5"] },
    { "id": 13, "tasks": ["6"] },
    { "id": 14, "tasks": ["7.1", "7.2", "7.3", "7.4", "9.1", "9.2"] },
    { "id": 15, "tasks": ["7.5", "9.3"] },
    { "id": 16, "tasks": ["7.6", "10.1"] },
    { "id": 17, "tasks": ["10.2", "10.3", "10.4"] },
    { "id": 18, "tasks": ["8"] },
    { "id": 19, "tasks": ["11"] },
    { "id": 20, "tasks": ["12.1"] },
    { "id": 21, "tasks": ["12.2", "12.3"] },
    { "id": 22, "tasks": ["13.1", "13.2"] },
    { "id": 23, "tasks": ["14.1"] },
    { "id": 24, "tasks": ["14.2"] },
    { "id": 25, "tasks": ["14.3"] },
    { "id": 26, "tasks": ["14.4"] },
    { "id": 27, "tasks": ["15"] }
  ]
}
```
