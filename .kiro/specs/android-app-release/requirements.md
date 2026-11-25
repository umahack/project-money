# Requirements Document

## Introduction

Project Money already has a Capacitor 8 Android project in `frontend/android` (application id `online.projectmoney.app`, targetSdk 36, minSdk 24). It was scaffolded for development and is not safe or complete enough to ship. The audit found cleartext traffic allowed in every build, backups enabled, no network security configuration, release builds that are not minified or signed, stale example tests, a navigation allowlist of `*` in the generated Cordova `config.xml`, a Google Sign-In button that cannot work in an embedded WebView, account export and CSV export that use `URL.createObjectURL` and `<a download>` (which does nothing in a Capacitor Android WebView), no hardware back-button policy, and an edge-to-edge setup that stops working at targetSdk 36 on Android 16.

This feature makes the Android app releasable. It hardens the manifest, Gradle build, and Capacitor configuration; adds a release build that produces a signed AAB for Google Play and an installable signed APK; fixes the native behaviours that break (export, back button, keyboard, system bars, offline); hides the web Google button on native; and adds automated checks plus an emulator verification on the `Pixel_7_2` AVD at API 34 and API 37. Submitting to Google Play Console is an external step that the user performs; this feature documents it.

The web application keeps its current behaviour. Every change that touches shared code is gated on the native platform or is a behaviour-preserving refactor, and the full Vitest suite stays green.

Sign-in on Android matches the web: the 30-minute JWT stays in `sessionStorage` under `pm_token` with the user record under `pm_user`, so the user signs in again after the app process ends. The first release ships with Quick Add and Financial Clarity flags off.

### Out of Scope

- **iOS.** Android only.
- **"Stay signed in" on Android.** A backend refresh token held in secure storage (Android Keystore), with an optional biometric gate, is a later spec. It needs a backend refresh-token endpoint, revocation on password change and account deletion, and a threat model for a long-lived credential on a device. Version 1 does not store any credential outside `sessionStorage`.
- **Biometric or app lock.** Not in version 1.
- **Google Sign-In on Android.** Version 1 hides the web Google button. Native Google Sign-In (Credential Manager) is after version 1.
- **Certificate pinning.** Not added. Render rotates certificates on its own schedule, so a pin would lock every installed app out of the API after a rotation until users update. Protection comes from system trust anchors, HSTS on the API, and cleartext traffic being denied.
- **Root, jailbreak, and emulator detection.**
- **Screenshot or screen-recording settings toggle.** `FLAG_SECURE` is always on in release builds with no setting.
- **Play Console submission.** The user performs it. Requirement 17 lists the steps.
- **Quick Add and Financial Clarity in the first release.** Both flags ship off; this feature still keeps their native behaviour correct for when they are turned on.
- **Backend changes** other than one allowlist test.

## Glossary

- **Android_App**: The Capacitor 8 Android application `online.projectmoney.app` built from `frontend/android`, loading the Release_Web_Bundle from `https://localhost` inside a WebView.
- **Web_App**: The same React application served in a browser. It must not change behaviour.
- **Native_Platform**: A runtime where `Capacitor.isNativePlatform()` is true.
- **Platform_Module**: The module `frontend/src/platform.ts` that wraps `Capacitor.isNativePlatform()` and is the only place the application reads it.
- **Token_Store**: The module `frontend/src/tokenStore.ts` that reads, writes, and clears the session token (`pm_token`) in `sessionStorage`.
- **Back_Button_Policy**: The pure function `decideBackAction` that maps the navigation state to one back-button action.
- **Overlay_Registry**: The in-memory stack where an open closable dialog registers a close handler, so the back button closes the top dialog first.
- **Agreement_Gate**: The condition that the data-use notice is required for the signed-in user (`useAgreementGate().mustAgree`), under which the `/agreement` page is shown.
- **Export_Share_Wrapper**: The module `frontend/src/native/exportFile.ts` that saves an export through the platform-appropriate path: a browser download on web, and cache file plus system share sheet on Native_Platform.
- **Export_File**: A file named `project-money-account-<date>.json` or `project-money-expenses-<date>.csv` produced by the account export or the expense export.
- **Release_Build**: A Gradle `release` build type output (AAB or APK).
- **Debug_Build**: A Gradle `debug` build type output.
- **Release_Web_Bundle**: The `frontend/dist` output of `vite build --mode android`.
- **Android_Env_File**: The gitignored file `frontend/.env.android` that holds the build-time variables for the Release_Web_Bundle.
- **API_Host**: `project-money-api.onrender.com`, the Render-hosted backend.
- **Merged_Release_Manifest**: The `AndroidManifest.xml` that Gradle produces for the release variant after manifest merging.
- **Manifest_Audit**: The script `frontend/scripts/android/auditManifest.mjs` that parses a manifest and reports violations of the hardening rules.
- **Keystore_Properties**: The gitignored file `frontend/android/keystore.properties` that names the upload keystore, its alias, and its passwords.
- **Upload_Keystore**: The Java keystore that signs Release_Builds. Google Play re-signs with the Play App Signing key.
- **Secure_Window_Policy**: The Java class `SecureWindowPolicy` that decides whether `MainActivity` sets `FLAG_SECURE`.
- **Verify_Script**: The npm script `android:verify` that runs the post-build checks (manifest audit, signature, badging, bundle).
- **Smoke_Checklist**: The documented list of manual and adb-driven emulator checks in Requirement 16.
- **Emulator**: The Android Virtual Device `Pixel_7_2`, run at system image API 34 and at API 37.
- **CORS_Allowlist**: The exact-match list of origins in the Render `CORS_ORIGIN` environment value that the backend accepts.
- **Cold_Start**: The delay of up to about a minute while the free Render instance wakes before it answers the first request.
- **Play_Checklist**: The document `docs/android-play-store-checklist.md` listing the Play Console steps the user performs.
- **System_Bars**: The Android status bar and navigation bar, configured through the Capacitor `SystemBars` core plugin.
- **Allowed_Permission_Set**: The only permissions the Merged_Release_Manifest may contain: the `uses-permission` entries `android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE` (declared so the WebView reports online and offline state for Requirement 7), `android.permission.VIBRATE` (added by `@capacitor/haptics` for Requirement 5), and `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (added by `androidx.core`), where the last one is also declared as a `<permission>` with `android:protectionLevel="signature"`, so only apps signed with the same key can hold it.

## Requirements

### Requirement 1: One token accessor

**User Story:** As a maintainer, I want every reader of the session token to go through one accessor, so that the storage mechanism can change later without touching each reader and the token never leaks into a second store.

#### Acceptance Criteria

1. THE Token_Store SHALL provide `getToken`, `setToken`, and `clearToken` and SHALL be the only module that reads, writes, or removes the `sessionStorage` key `pm_token`.
2. WHEN `api.ts`, `useSessionWarning`, `DangerZone` (account export and account deletion), or `ExportData` needs the session token, THE module SHALL obtain it through `getToken` from the Token_Store.
3. WHEN `setToken` is called with a token, THE Token_Store SHALL make `getToken` return that token until `clearToken` is called.
4. WHEN `clearToken` is called, THE Token_Store SHALL make `getToken` return null.
5. THE Token_Store SHALL keep the token in `sessionStorage` under the key `pm_token` and SHALL write nothing to `localStorage`, cookies, or native storage.
6. THE `api.ts` module SHALL keep exporting `getToken`, `setAuth`, `clearAuth`, and `getUser` with unchanged signatures and unchanged `pm_user` handling.
7. WHILE the Android_App process has ended and restarted, THE Android_App SHALL start without a session and show the sign-in screen.
8. IF `sessionStorage` throws on read, THEN THE Token_Store SHALL return null from `getToken`.

### Requirement 2: Platform module and the Google button

**User Story:** As an Android user, I want only sign-in methods that work in the app, so that I never tap a Google button that fails.

#### Acceptance Criteria

1. THE Platform_Module SHALL export `isNativePlatform()` returning the value of `Capacitor.isNativePlatform()` and SHALL be the only application module that imports `Capacitor.isNativePlatform`.
2. WHILE the runtime is a Native_Platform, THE `GoogleSignInButton` and its `AuthDivider` SHALL render nothing on the login and register forms.
3. WHILE the runtime is not a Native_Platform, THE `GoogleSignInButton` and `AuthDivider` SHALL render exactly as before this feature.
4. WHILE the runtime is a Native_Platform, THE Android_App SHALL keep email and password sign-in and the existing one-time-password (OTP) registration flow working.
5. WHERE the runtime is a Native_Platform, THE Android_App SHALL NOT load the script `https://accounts.google.com/gsi/client`.
6. WHEN the Release_Web_Bundle is built with `--mode android`, THE Content-Security-Policy meta tag SHALL omit the `accounts.google.com` entries.

### Requirement 3: Hardware back button

**User Story:** As an Android user, I want the back button to behave like other Android apps, so that I can close dialogs and go back without leaving the app by accident or skipping the data-use agreement.

#### Acceptance Criteria

1. THE Back_Button_Policy SHALL return exactly one of `close-overlay`, `consume`, `navigate-back`, or `minimize` for every combination of pathname, Agreement_Gate state, history availability, and overlay state.
2. WHEN the back button is pressed while a closable overlay is open, THE Android_App SHALL close the top overlay and SHALL NOT change the route.
3. WHEN the back button is pressed while a locked overlay (one that cannot be dismissed) is open, THE Android_App SHALL leave the overlay open and the route unchanged.
4. WHEN the back button is pressed on the route `/agreement` while the Agreement_Gate requires acknowledgement and no overlay is open, THE Android_App SHALL minimise the app and SHALL NOT navigate.
5. WHEN the back button is pressed on the Home route `/` or the `/login` route with no overlay open, THE Android_App SHALL minimise the app.
6. WHEN the back button is pressed on any other route with in-app history available and no overlay open, THE Android_App SHALL navigate one entry back in history.
7. WHEN the back button is pressed on any other route with no in-app history and no overlay open, THE Android_App SHALL minimise the app.
8. WHEN the Quick Add dialog is open and the back button is pressed, THE Android_App SHALL close the Quick Add dialog before any navigation.
9. WHERE the runtime is not a Native_Platform, THE Web_App SHALL register no back-button listener.
10. WHEN the Back_Button_Policy minimises the app, THE Android_App SHALL keep the process and the session alive.

### Requirement 4: Export and download on Android

**User Story:** As an Android user, I want to export my expenses and my account data, so that I can keep or share a copy, which currently does nothing in the app.

#### Acceptance Criteria

1. WHILE the runtime is a Native_Platform, WHEN the user requests the account export or the expense CSV export and the server responds successfully, THE Export_Share_Wrapper SHALL write the Export_File to the app cache directory and open the system share sheet for that file.
2. WHEN the share sheet interaction ends, whether the user shared, cancelled, or the share failed, THE Export_Share_Wrapper SHALL delete the Export_File from the app cache directory after a grace period of 60 seconds.
3. WHEN the Android_App starts, THE Export_Share_Wrapper SHALL delete any leftover files in the app cache directory whose names match `project-money-(account|expenses)-*.json` or `.csv`.
4. IF writing the Export_File fails, THEN THE Export_Share_Wrapper SHALL report a failure to the caller, show an error toast with the existing wording style, and leave no file behind.
5. IF the user cancels the share sheet, THEN THE Export_Share_Wrapper SHALL report `cancelled`, and THE interface SHALL NOT show an error toast.
6. WHILE the runtime is not a Native_Platform, THE Export_Share_Wrapper SHALL use the existing `URL.createObjectURL` and anchor download behaviour and SHALL NOT call the Filesystem or Share plugins.
7. THE Android_App SHALL request no storage permission for exporting.
8. THE FileProvider path file `file_paths.xml` SHALL declare only a `cache-path` entry and SHALL NOT declare an `external-path` entry.
9. THE `package.json` SHALL declare `@capacitor/filesystem` and `@capacitor/share` with a Capacitor 8 compatible version range.
10. WHEN the export succeeds on Native_Platform, THE interface SHALL show the toast wording that names sharing instead of downloading.
11. IF the export request returns status 401, THEN THE `DangerZone` and `ExportData` components SHALL keep their existing session-expiry handling.

### Requirement 5: Haptic feedback

**User Story:** As an Android user, I want a light tap when a Quick Add entry is saved or undone, so that I get a physical confirmation.

#### Acceptance Criteria

1. WHILE the runtime is a Native_Platform and the operating system does not request reduced motion, WHEN a Quick Add entry reaches the saved state, THE Android_App SHALL trigger one light haptic impulse.
2. WHILE the runtime is a Native_Platform and the operating system does not request reduced motion, WHEN a Quick Add undo completes, THE Android_App SHALL trigger one light haptic impulse of a different kind than the save impulse.
3. WHILE the operating system requests reduced motion, THE Android_App SHALL trigger no haptic impulse.
4. WHILE the runtime is not a Native_Platform, THE Web_App SHALL trigger no haptic impulse and SHALL NOT call `navigator.vibrate`.
5. IF the haptics plugin rejects, THEN THE Android_App SHALL ignore the failure and SHALL NOT change the save or undo result shown to the user.

### Requirement 6: System bars, edge-to-edge layout, and the keyboard

**User Story:** As an Android user on any supported Android version, I want the header, bottom tabs, and Quick Add input to stay visible, so that nothing hides behind the status bar, navigation bar, or keyboard.

#### Acceptance Criteria

1. THE `MainActivity` SHALL enable edge-to-edge explicitly and SHALL NOT call `setDecorFitsSystemWindows(true)`.
2. THE Capacitor configuration SHALL set `SystemBars.insetsHandling` to a value chosen from the emulator evaluation (`native` or `css`) and SHALL document the choice in `design.md` and the README section.
3. THE `main.tsx` native setup SHALL NOT depend on `StatusBar.setOverlaysWebView` or `StatusBar.setBackgroundColor` and SHALL set the system bar icon style from the active theme through `SystemBars.setStyle`.
4. WHEN the user switches between the light and dark theme on Native_Platform, THE Android_App SHALL update the system bar icon style within 500 ms.
5. WHEN the Android_App runs on the Emulator at API 34 and at API 37, THE Home headline, the Quick Add input bar, the Quick Add floating button, the bottom tabs, the toast stack, and the `/agreement` page SHALL render fully inside the visible area, clear of the status bar, display cutout, and navigation bar.
6. WHILE the soft keyboard is open and the Quick Add input is focused, THE Quick Add input SHALL be fully visible above the keyboard on the Emulator at API 34 and at API 37.
7. THE `MainActivity` declaration in the manifest SHALL set `android:windowSoftInputMode` to `adjustResize`.
8. WHERE the layout needs a native-only inset adjustment, THE stylesheet SHALL apply the adjustment only under a native-platform class on the `html` element and SHALL leave the Web_App layout unchanged.

### Requirement 7: Offline, slow network, and Render Cold_Start

**User Story:** As an Android user on a poor connection, I want a clear message and a retry, so that I never read old money figures as if they were current.

#### Acceptance Criteria

1. WHILE the device reports it is offline and the runtime is a Native_Platform, THE Android_App SHALL show a persistent notice that states the device is offline and that the figures on screen may be out of date.
2. WHEN the device goes offline, THE Android_App SHALL show that notice within 1 second.
3. WHEN the device comes back online, THE Android_App SHALL remove the notice and refetch the active queries without user action.
4. WHEN the user activates the Retry control in the notice, THE Android_App SHALL refetch the active queries.
5. IF a request fails with no response (network error or request timeout), THEN THE Android_App SHALL show a message that the server could not be reached, with a Retry control, instead of the raw browser error text.
6. WHILE the first request of a session is pending for longer than 5 seconds, THE Android_App SHALL show text that the free server may be waking up and can take up to a minute.
7. THE Android_App SHALL NOT present a figure whose last refresh failed or whose device is offline without the out-of-date notice from criterion 1.
8. WHERE the runtime is not a Native_Platform, THE Web_App SHALL show no offline notice.

### Requirement 8: Release web bundle

**User Story:** As a maintainer, I want a reproducible web bundle for the app that talks only to the production API, so that a release cannot carry development settings.

#### Acceptance Criteria

1. THE repository SHALL provide `npm run android:build` that runs `vite build --mode android`, reading `frontend/.env.android`.
2. THE `.gitignore` files SHALL ignore `frontend/.env.android` and `frontend/.env.android.local`.
3. THE repository SHALL provide `frontend/.env.android.example` documenting `VITE_API_BASE=https://project-money-api.onrender.com`, `VITE_QUICK_ADD_ENABLED=false`, and `VITE_FINANCIAL_CLARITY_ENABLED=false`.
4. IF `VITE_API_BASE` is missing or does not start with `https://` when building with `--mode android`, THEN THE build SHALL fail with a message naming the variable.
5. WHEN the Release_Web_Bundle is built with `--mode android`, THE bundle SHALL contain no `console.*` call sites from application code.
6. THE Content-Security-Policy for `--mode android` SHALL allow `connect-src` to `'self'` and the API origin only.
7. THE Release_Web_Bundle SHALL contain the API origin and SHALL contain no `http://` API URL, no `10.0.2.2`, and no `localhost:4000`.
8. WHEN `vite build` runs without `--mode android`, THE output SHALL be identical in behaviour to the output before this feature.

### Requirement 9: Manifest and backup hardening

**User Story:** As a user whose financial data is on my phone, I want the app to refuse cleartext traffic and device backups, so that my data does not leave through weak settings.

#### Acceptance Criteria

1. THE `AndroidManifest.xml` SHALL set `android:allowBackup` to `false` and SHALL reference `@xml/data_extraction_rules` and `@xml/backup_rules` (`android:fullBackupContent`) that exclude every domain.
2. THE `AndroidManifest.xml` SHALL NOT declare `android:usesCleartextTraffic` and SHALL reference `@xml/network_security_config`.
3. THE main `network_security_config.xml` SHALL set `cleartextTrafficPermitted` to `false` and trust system certificate authorities only.
4. THE debug source set SHALL provide a `network_security_config.xml` overlay that permits cleartext only to `10.0.2.2` and `localhost`.
5. THE Merged_Release_Manifest SHALL contain no `android:debuggable="true"`, no `usesCleartextTraffic="true"`, and no `allowBackup="true"`.
6. THE Merged_Release_Manifest SHALL contain `MainActivity` as its only component with `android:exported="true"` and SHALL contain no exported receiver, service, or provider; THE `AndroidManifest.xml` SHALL remove the `androidx.profileinstaller.ProfileInstallReceiver` that a library adds as an exported receiver, using `tools:node="remove"`.
7. THE Merged_Release_Manifest SHALL declare no `uses-permission` and no `permission` element other than the Allowed_Permission_Set, and the only `permission` element SHALL be `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` with `android:protectionLevel="signature"`.
8. THE FileProvider SHALL remain `android:exported="false"` with `grantUriPermissions="true"`.
9. THE Android_App SHALL include no analytics, advertising, or crash-reporting SDK.

### Requirement 10: Capacitor configuration per build

**User Story:** As a maintainer, I want release builds to be locked down and debug builds to stay convenient, so that development shortcuts cannot reach users.

#### Acceptance Criteria

1. THE `capacitor.config.ts` SHALL build its configuration from the environment variable `CAPACITOR_ENV`, treating a missing or unknown value as `release`.
2. WHEN `CAPACITOR_ENV` is `release`, THE configuration SHALL set `android.allowMixedContent` to `false`, `android.webContentsDebuggingEnabled` to `false`, `loggingBehavior` to `none`, and SHALL define no `server.url` and no `server.cleartext`.
3. WHEN `CAPACITOR_ENV` is `debug`, THE configuration SHALL set `android.allowMixedContent` to `true` and `android.webContentsDebuggingEnabled` to `true`.
4. THE configuration SHALL set `server.allowNavigation` to the API_Host only for `release`, and to the API_Host plus `10.0.2.2` for `debug`.
5. THE configuration SHALL keep `server.androidScheme` as `https` and `appId` as `online.projectmoney.app`.
6. THE configuration builder SHALL be loadable by the Capacitor CLI without importing any other local TypeScript module.
7. THE restriction on navigation SHALL be implemented through `server.allowNavigation` and SHALL NOT edit the generated `res/xml/config.xml`.
8. THE `android:sync` script SHALL run with `CAPACITOR_ENV=release`, and a separate `android:sync:debug` script SHALL run with `CAPACITOR_ENV=debug`.

### Requirement 11: Release build, signing, and versioning

**User Story:** As the release owner, I want one command to produce a signed AAB and a signed APK, so that I can upload to Play and install on a device.

#### Acceptance Criteria

1. THE `app/build.gradle` release build type SHALL set `minifyEnabled` and `shrinkResources` to `true` and SHALL set `debuggable` to `false`.
2. THE `proguard-rules.pro` SHALL keep Capacitor plugin classes and methods, `@JavascriptInterface` members, and the application classes the Capacitor bridge loads by reflection.
3. THE release signing configuration SHALL read the store file, store password, key alias, and key password from the gitignored Keystore_Properties.
4. IF a Release_Build task runs and Keystore_Properties is absent or incomplete, THEN THE build SHALL fail with a message that names the missing file or key and SHALL NOT sign with the debug key.
5. THE `android/.gitignore` and the repository `.gitignore` SHALL ignore `*.jks`, `*.keystore`, `keystore.properties`, and `.env.android`.
6. THE `versionName` SHALL equal the `version` field of `frontend/package.json`.
7. THE `versionCode` SHALL equal the Gradle property `buildNumber`, given as `-PbuildNumber=<n>` or in `android/gradle.properties`.
8. IF `buildNumber` is missing or is not a positive integer no greater than 2100000000 when a Release_Build task runs, THEN THE build SHALL fail with a message naming `buildNumber`, because Google Play rejects a reused `versionCode`.
   - WHILE only Debug_Build tasks run and `buildNumber` is missing, THE build SHALL use `versionCode` 1.
9. THE command `./gradlew lint assembleDebug bundleRelease assembleRelease` SHALL complete with no lint error.
10. THE repository SHALL provide `npm run android:release` that builds the Release_Web_Bundle, runs `cap sync` with `CAPACITOR_ENV=release`, and runs `bundleRelease` and `assembleRelease`.

### Requirement 12: Secure window

**User Story:** As a user, I want the app content hidden from screenshots, screen recording, and the recent-apps thumbnail in the release app, so that my balances are not exposed.

#### Acceptance Criteria

1. THE Secure_Window_Policy SHALL return true when the application is not debuggable and false when it is debuggable.
2. WHEN `MainActivity` is created in a Release_Build, THE Android_App SHALL set `FLAG_SECURE` on the window before the first frame is drawn.
3. WHEN `MainActivity` is created in a Debug_Build, THE Android_App SHALL leave `FLAG_SECURE` unset.
4. THE Android_App SHALL provide no setting to turn `FLAG_SECURE` off.

### Requirement 13: Native test code

**User Story:** As a maintainer, I want native tests that exercise this app, so that the stale scaffold tests do not mask real regressions.

#### Acceptance Criteria

1. THE repository SHALL contain no `ExampleUnitTest.java` or `ExampleInstrumentedTest.java` and no source under the package `com.getcapacitor.myapp`.
2. THE `app/src/test/java/online/projectmoney/app` directory SHALL contain a JUnit test for the Secure_Window_Policy covering the debuggable and non-debuggable flag values.
3. THE `app/src/androidTest/java/online/projectmoney/app` directory SHALL contain an instrumented test that launches `MainActivity` and asserts the package name `online.projectmoney.app` and that the WebView is created.
4. THE Gradle task `testDebugUnitTest` SHALL pass.

### Requirement 14: Automated verification

**User Story:** As the release owner, I want the hardening rules checked by a script, so that a later change cannot silently reintroduce a weak setting.

#### Acceptance Criteria

1. THE Manifest_Audit SHALL report a violation for each of: `android:debuggable="true"`, `usesCleartextTraffic="true"`, `allowBackup="true"` or absent, a missing `networkSecurityConfig`, any component with `android:exported="true"` other than `MainActivity` (including any exported receiver, service, or provider), any `uses-permission` outside the Allowed_Permission_Set, and any `permission` element other than `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` declared with `android:protectionLevel="signature"`.
2. WHEN the Manifest_Audit reads a manifest with no violation, THE Manifest_Audit SHALL exit with status 0.
3. WHEN the Manifest_Audit finds one or more violations, THE Manifest_Audit SHALL print each violation and exit with a non-zero status.
4. THE Verify_Script SHALL run, in order, the Manifest_Audit on the Merged_Release_Manifest, `apksigner verify --verbose` on the release APK, the AAB signature check with `jarsigner -verify`, an `aapt2 dump badging` check, and a Release_Web_Bundle check.
5. THE `aapt2 dump badging` check SHALL assert the package name `online.projectmoney.app`, `versionName` equal to the `package.json` version, `versionCode` equal to `buildNumber`, `targetSdkVersion` of 36, `minSdkVersion` of 24, and that the permissions it lists are exactly the Allowed_Permission_Set (`android.permission.INTERNET`, `android.permission.ACCESS_NETWORK_STATE`, `android.permission.VIBRATE`, and `online.projectmoney.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`).
6. THE Release_Web_Bundle check SHALL assert the conditions in Requirement 8, criteria 5 and 7.
7. IF any step of the Verify_Script fails, THEN THE Verify_Script SHALL stop and exit with a non-zero status naming the failing step.
8. THE Verify_Script SHALL resolve the Android SDK tools from `~/Library/Android/sdk` (or `ANDROID_HOME`) and SHALL NOT require them on `PATH`.

### Requirement 15: CORS allowlist and the Render step

**User Story:** As the release owner, I want proof that the backend accepts the app origin and nothing else unintended, so that the app can reach the API in production.

#### Acceptance Criteria

1. WHEN `CORS_ORIGIN` is set to a comma-separated list that includes `https://localhost`, THE backend SHALL answer a request with `Origin: https://localhost` with `Access-Control-Allow-Origin: https://localhost`.
2. WHEN a request carries an `Origin` that is not an exact member of the configured list, THE backend SHALL NOT send an `Access-Control-Allow-Origin` header for it.
3. THE backend test SHALL cover exact matching, including a different scheme (`http://localhost`), a different port (`https://localhost:3000`), a different host with the same suffix, and a trailing slash.
4. THE backend test work SHALL change no file under `backend/src` other than `backend/src/app.js`, and SHALL change `backend/src/app.js` only by adding the `export` keyword to the `resolveCorsOrigin` declaration, with no change to its behaviour.
5. THE README section SHALL tell the user to add `https://localhost` to the Render `CORS_ORIGIN` value, redeploy, and confirm with a documented `curl` preflight command.
6. THE backend SHALL keep `credentials` disabled in the CORS configuration.

### Requirement 16: Emulator verification

**User Story:** As the release owner, I want the signed APK verified on a running Android environment, so that I know the minified release build works before Play sees it.

#### Acceptance Criteria

1. WHEN the Emulator is booted from the `Pixel_7_2` AVD, THE documented procedure SHALL install the signed release APK with `adb install` and launch it.
2. THE Smoke_Checklist SHALL cover: install and launch, sign up with OTP, sign in, add an expense, export CSV and account JSON through the share sheet, back button on Home, a dialog, and `/agreement`, rotate, dark mode, airplane mode, and kill-and-reopen showing the sign-in screen.
3. THE Smoke_Checklist SHALL be run on API 34 and on API 37 and the results SHALL be recorded in `docs/android-emulator-results.md`.
4. WHEN the Release_Build runs on the Emulator, THE `dumpsys window` output SHALL show the secure flag set for the app window.
5. WHEN the Debug_Build runs on the Emulator, THE app window SHALL NOT have the secure flag.
6. THE Smoke_Checklist SHALL note that screenshots of a Release_Build are blank because of `FLAG_SECURE`, and SHALL use `uiautomator dump` or a Debug_Build for visual checks.
7. WHERE an adb-driven script is feasible, THE repository SHALL provide `frontend/scripts/android/smoke.sh` that installs the APK, launches it, and asserts the launch activity is resumed with no `FATAL EXCEPTION` in logcat.
8. THE cache directory SHALL contain no Export_File after the 60-second grace period following an export on the Emulator.

### Requirement 17: Documentation and Play Store checklist

**User Story:** As the release owner, I want the steps written down, so that I can repeat the release and complete the Play Console submission myself.

#### Acceptance Criteria

1. THE `README.md` and `HANDOFF.md` SHALL each contain an `Android release` section covering: the Android_Env_File, build commands, Upload_Keystore creation, signing, verification, the CORS step, and known limits.
2. THE known limits SHALL state that sessions end when the app process ends, that Google Sign-In is not available on Android in version 1, and that the first release has Quick Add and Financial Clarity off.
3. THE documentation SHALL state the reason certificate pinning is not used and the reason "Stay signed in" is deferred, as given in the Out of Scope list.
4. THE Play_Checklist SHALL list: create the upload keystore, enrol in Play App Signing, upload the AAB to the internal testing track, complete the Data safety form with answers derived from the app (data collected, purpose, encryption in transit, deletion available), provide the privacy policy URL `https://<web>/privacy`, provide the account-deletion URL, complete the content rating questionnaire, and set the target audience.
5. THE Play_Checklist SHALL contain the sentence that the user performs these steps in Play Console and that this feature does not.
6. THE documentation SHALL record the keystore backup instruction: keep two offline copies and never commit the keystore or `keystore.properties`.

### Requirement 18: Web behaviour preserved

**User Story:** As a web user, I want nothing to change for me, so that the Android work cannot break the site.

#### Acceptance Criteria

1. THE full frontend Vitest suite SHALL pass after this feature without changing the expectations of any existing test other than the tests that read `pm_token` directly.
2. WHERE Capacitor is absent (browser or jsdom), THE application SHALL behave exactly as before this feature.
3. THE backend test suite SHALL pass after this feature and SHALL contain exactly one new test file group (the CORS allowlist tests).
4. THE `npm run typecheck` command SHALL pass.
5. THE Android_App SHALL request no permission beyond the Allowed_Permission_Set.
