# Android emulator results

Smoke runs of the Android wrapper (`online.projectmoney.app`) on the `Pixel_7_2` AVD at API 34 (task 14.3) and on a hand-made `Pixel_7_2_api37` AVD (task 14.4, system image `android-37.0` `google_apis_playstore` `arm64-v8a`, WebView 145.0.7632.218). Release checks used `/tmp/aa141/out/app-release.apk` through `frontend/scripts/android/smoke.sh`.

## Checks run

| Check | API 34 (release) | API 37 (release) | API 37 (debug) |
| --- | --- | --- | --- |
| `smoke.sh`: device API level, `adb install -r`, `am start -W`, process running, MainActivity resumed, no `FATAL EXCEPTION` | pass | pass | n/a |
| Package is not `DEBUGGABLE`, `allowBackup` off | pass | pass | n/a |
| `run-as` refused on the release build | pass | pass | n/a |
| `dumpsys window` shows `SECURE` for the app window (FLAG_SECURE) | pass | pass | n/a |
| Back on the first screen minimises the app, no crash | pass | pass | n/a |
| Screenshot of release build is blank/empty (FLAG_SECURE proof) | empty file | black frame, 16 KB | n/a |
| Debug build: `dumpsys window` has **no** `SECURE` flag (`fl=` lacks it), screenshot works | n/a | n/a | pass |
| Rotate to landscape and back, dark mode on/off, no crash (manual) | pass | not repeated | not repeated |
| Network reachable from the emulator (ping 8.8.8.8, 0% loss) | pass | not run | not run |
| Landing page renders from the bundled assets (uiautomator dump + screenshot) | pass (dump) | pass (dump) | pass (screenshot) |
| Edge-to-edge: header below status bar, bottom content above the gesture bar | not checked | fail before the fix, see below | pass after the fix |
| Gradle: `:app:testDebugUnitTest` (14 tests: ManifestAndResourceHardeningTest 10, SecureWindowPolicyTest 4) and `:app:lintDebug` (0 errors, 14 warnings) | not run | not run | pass (after the fix) |

## Not tested

Anything that needs a real account against the live API was not exercised on either API level: OTP sign-up, sign-in, adding an expense, CSV and account-JSON export through the share sheet, the 60-second export-cache cleanup, kill-and-reopen showing sign-in, airplane mode, and back from a dialog or `/agreement`. These run in the next step against a local backend. Landscape insets (left/right cutout) were not checked on API 37.

## insetsHandling choice

`plugins.SystemBars.insetsHandling` stays `'css'` (the Capacitor 8 default, set explicitly in `capacitor.config.ts`). With WebView 140 or newer and `viewport-fit=cover`, Capacitor passes the system bar and cutout insets through to the WebView, and the page reserves the space with `env(safe-area-inset-*)`. The `native` mode would pad the decor view instead and is unnecessary because the stylesheet already uses `env()`. Measured on API 37 through DevTools: `env(safe-area-inset-top)` = 52 CSS px and `env(safe-area-inset-bottom)` = 24 CSS px, which match the 136 px status bar and 63 px gesture bar from `dumpsys window` at 2.625 dpr.

## API 37 result

`smoke.sh` against the release APK passed every check on API 37. Installing the debug APK (after uninstalling the release build, since the signatures differ) and checking the window flags showed no `SECURE` flag, and `screencap` returned the real screen.

The debug screenshot showed two layout defects that the release smoke test cannot see, because its screenshot is blank by design. The earlier uiautomator "action bar" was real, not a status bar spacer.

1. **Native action bar over the page.** An AppCompat `action_bar_container` titled "Project Money" (truncated to "Proje…") covered y 136 to 283 px and hid the web header. Cause: `MainActivity` calls `EdgeToEdge.enable(this)` before `super.onCreate`, which creates the window decor under the splash launch theme. Capacitor's `BridgeActivity` only calls `setTheme(R.style.AppTheme_NoActionBar)` after that, so AppCompat built the decor with an action bar. Changing `AppTheme.NoActionBarLaunch` (`windowActionBar` false, `windowNoTitle` true, `postSplashScreenTheme`) did not help, so that edit was reverted. Fix: `MainActivity` calls `setTheme(R.style.AppTheme_NoActionBar)` before `EdgeToEdge.enable(this)`. Result: no `action_bar_container` in the view hierarchy.
2. **Landing header under the status bar.** After fix 1 the logo and Sign in / Sign up buttons sat under the clock and status icons. Cause: in `frontend/src/styles.css`, the `@media (max-width: 420px)` rule `.auth-topbar { padding: 0.55rem 0.75rem; }` came after `padding-top: max(0.7rem, env(safe-area-inset-top, 44px))` and overwrote it (measured padding-top 8.8 px). Fix: the media rule now also sets `padding-top: max(0.55rem, env(safe-area-inset-top))`, as the `.topbar` rule already does. After the fix the header starts below the status bar.

Bottom of the page (scrolled to the end): Privacy and Terms links sit above the gesture bar, with 24 CSS px of bottom padding.

Screenshots and dumps are in `/tmp/aa144/`: `api37-debug.png` (before, action bar), `api37-debug-fix2.png` (action bar gone, header under status bar), `api37-debug-fix3.png` (after both fixes), `api37-debug-bottom.png`, `ui37-debug.xml`, `dumpsys-window-before.txt`, `dumpsys-window-after.txt`.

The release APK in `/tmp/aa141/out` was built before these fixes. It has the same defects and must be rebuilt (`npm run android:sync` for the web bundle, then the release Gradle build) before the next release test run.

## On-device functional verification
Task 15, part 1. Debug build on `emulator-5584` (Pixel_7_2, API 34), run against a local backend. Evidence is in `/tmp/aa15/` (screenshots `NN-*.png`, logs `*.out`, `logcat-full.txt`).

### Setup
- Backend: `node src/server.js` from `backend/` with a cleared environment (`env -i`), `HOST=127.0.0.1`, `PORT=4000`, `NODE_ENV=development`, throwaway `JWT_SECRET` and `FINANCIAL_MUTATION_HMAC_KEY`, `QUICK_ADD_ENABLED=true`, `CORS_ORIGIN=https://localhost`, `TURSO_DATABASE_URL=file:/tmp/aa15/test.sqlite`, no `TURSO_AUTH_TOKEN`, no `RESEND_API_KEY`. `lsof` showed the only listener as `127.0.0.1:4000`. The emulator reached it through `adb reverse tcp:4000 tcp:4000`. The backend was stopped by PID afterwards, and `adb reverse` and `adb forward` were removed.
- Account: sign-up used the real `register-start` and `register-finish` routes. The mail fallback printed the OTP to the backend log. The user `aa15@example.test` exists only in the throwaway database.
- App: `VITE_API_BASE=http://localhost:4000 VITE_FINANCIAL_CLARITY_ENABLED=true VITE_QUICK_ADD_ENABLED=true npx vite build`, then `CAPACITOR_ENV=debug npx cap sync android`, then `./gradlew :app:assembleDebug`. The resolved debug config had `allowMixedContent: true`, `webContentsDebuggingEnabled: true`, and `allowNavigation` including `10.0.2.2` and `localhost`. The release APK from earlier runs had to be uninstalled first because the signatures differ.
- Driving: WebView DevTools socket forwarded to `127.0.0.1:9222`, Playwright `connectOverCDP`, `adb shell input keyevent KEYCODE_BACK`, and `adb exec-out screencap`.

### Results
| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Sign in from the app, origin `https://localhost` accepted by CORS | PASS | `POST /api/auth/login` returned 200 and every API response carried `Access-Control-Allow-Origin: https://localhost`. No CORS or failed-request console errors. `pm_token` and `pm_user` were in `sessionStorage`. `s2.out`, `02-after-signin.png`. |
| 2 | Unacknowledged user goes to `/agreement`, BACK there does not leave the gate, "I agree and continue" lands on Home | PASS | After login the URL was `/agreement`. BACK sent the app to the launcher (`topResumedActivity` was the launcher, process 5421 still alive). Reopening showed `/agreement` again. Clicking "I agree and continue" landed on `/`. `07-agreement.png`, `08-agreement-reopened.png`, `s3.out`. |
| 3 | Home "You can spend today", Quick Add `120 coffee` + Enter, saved row, answer, Undo, haptic | PASS | Home showed "You can spend ₹8,000 today" after a ₹60,000 salary was added (a user with no salary sees "Add this month's pay"). `120 coffee` returned `POST /api/finance/expenses` 200, row "₹120 · Food · coffee", "Saved ₹120 to Food: coffee. ₹7,880 left today." Undo on a second entry (`50 tea`) sent `DELETE /api/finance/expenses/2` 200 and the allowance returned to ₹7,880. Logcat shows `Haptics.impact {"style":"LIGHT"}` and no crash. `13-quickadd-saved.png`, `14-after-undo.png`, `s5.out`, `s6.out`. |
| 4 | BACK closes a modal and stays on the page; BACK on Home minimises | PASS (with a note) | The Quick Add dialog (FAB on `/spending`): the first BACK hides the soft keyboard (Android consumes it before the app), the second closes the dialog and the URL stays `/spending`. BACK on Home put the launcher on top. The Settings "Delete my account" control is an inline panel with a Cancel button, not a modal, so it is not on the overlay registry; BACK there minimised the app, which matches Requirement 3.7. `s8.out`, `15-fab-dialog.png`, `17-fab-dialog-closed.png`. |
| 5 | Export CSV and JSON open the share sheet; cached file removed within about 60 s | PASS | Both buttons opened `com.android.intentresolver/.ChooserActivity` (`ACTION_CHOOSER` with a `content://` clip). `run-as ... ls cache` showed `project-money-expenses-2026-11-25.csv` and `project-money-account-2026-11-25.json` while the sheet was open. After cancel with BACK the files were still there at +10, +30 and +55 s and gone at +70 s. `21-share-csv.png`, `s11csv.out`, `s11json.out`. |
| 6 | Offline banner and Retry | FAIL, then PASS with an extra permission | Fixed by adding `ACCESS_NETWORK_STATE` to the manifest and the allowed set. See "Offline banner defect" below. |
| 7 | Layout at API 34: Home, Spending, Settings, `/agreement` | PASS after one fix | Header starts below the status bar and the bottom tabs sit above the gesture bar on all four pages (`30-home-top.png`, `30-spending-top.png`, `30-settings-top.png`, `31-*-bottom.png`, `07-agreement.png`). The Quick Add dialog started under the status bar before the fix (`16-after-back-dialog.png`) and clears it after (`20-quickadd-dialog-fixed.png`). |
| 8 | No `FATAL EXCEPTION` in logcat | PASS | `grep -c "FATAL EXCEPTION" /tmp/aa15/logcat-full.txt` is 0 for 16,800 lines from 16:45 (the buffer was cleared once before the Quick Add test, so the first sign-in minutes are not covered). |

### Defect fixed: Quick Add dialog under the status bar
`.modal-backdrop` has `padding: 1rem` with no inset, and `quickAddShell.css` top-aligns the Quick Add dialog so the keyboard leaves it in view. At API 34 the status bar inset is 52 CSS px (136 px), so the dialog started at y = 16 CSS px and its title row overlapped the clock and status icons. Fix in `frontend/src/components/quickAdd/quickAddShell.css`: `.modal-backdrop:has(.qa-dialog-body)` now sets `padding-top` and `padding-bottom` to `max(1rem, env(safe-area-inset-*, 0px))`. After the fix the dialog top is at 52 CSS px, the input is above the keyboard (`20-quickadd-dialog-fixed.png`), and `quickAddStyles.test.ts` still passes. Other modals (`.modal-backdrop` without `.qa-dialog-body`) are centred and were not changed.

### Offline banner defect (resolved)
With Wi-Fi and mobile data disabled (`svc wifi disable`, `svc data disable`, `dumpsys connectivity` reporting `Active default network: none`; `cmd connectivity airplane-mode enable` did not change anything on this emulator), the WebView kept `navigator.onLine === true` and `navigator.connection.type === 'unknown'`, so no banner appeared and the `offline` event never fired. Cause: the manifest declares only `INTERNET` and `VIBRATE`. Chromium's network-change notifier needs `android.permission.ACCESS_NETWORK_STATE`, and without it the WebView always reports online.
Experiment: a temporary debug-only overlay manifest added `ACCESS_NETWORK_STATE`. Then `navigator.onLine` became false, the banner "You're offline. The figures on screen may be out of date." with a Retry button appeared 826 ms after disabling the network, and it disappeared 805 ms after re-enabling (`22-offline.png`, `s12b.out`, `s13b.out`). The overlay was deleted afterwards.
Resolution: `<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />` is now declared in `frontend/android/app/src/main/AndroidManifest.xml` and is part of the Allowed_Permission_Set (`auditManifest.mjs` and its tests and fixtures, `verify.mjs`, the Gradle `ManifestAndResourceHardeningTest`, README, HANDOFF, the Play checklist and the spec). It is a normal install-time permission with no user prompt and no privacy impact, and Requirement 7.1 to 7.3 cannot be met in a release build without it. The allowed set is exactly `INTERNET`, `ACCESS_NETWORK_STATE`, `VIBRATE` and the signature-level `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. The fix is verified by the merged-manifest audit; the release APK still needs the on-device banner re-check after the final rebuild.

### Other observations
- The Quick Add floating button covers the right end of in-flow controls at some scroll positions (the Home "Save" button at scroll 0, "Send verification code" on Settings). Enter still saves. Not changed.
- Capacitor logged `Error injecting safe area CSS: TypeError: Cannot read properties of null (reading 'style')` once at process start (from Capacitor's SystemBars injection). The insets still resolved (`env(safe-area-inset-top)` = 52 px, bottom = 24 px at dpr 2.625).
- After the export share sheet is cancelled, the WebView logs `[object Object]` at console level (Share cancel). The app treats it as `cancelled` and shows no error.

### Release build warning
`npx cap sync android` regenerated the gitignored assets (`android/app/src/main/assets/public` and `capacitor.config.json`) with the debug web bundle pointing at `http://localhost:4000` and a debug Capacitor config. Run `npm run android:sync` (release mode, `--mode android`) before any release build. No `.env.android` or keystore was created.

## Final rebuild
Task 15, part B. The release build was redone from scratch after the last fixes (`MainActivity` theme, `.auth-topbar` padding, Quick Add dialog safe-area padding, `ACCESS_NETWORK_STATE`). Evidence is in `/tmp/aa15e/`.
### Build
- `npm run android:sync` (release mode) regenerated the web bundle and `capacitor.config.json`. Then `./gradlew :app:testDebugUnitTest :app:lintRelease :app:bundleRelease :app:assembleRelease -PbuildNumber=1` finished with BUILD SUCCESSFUL.
- Unit tests: 15 tests in 2 result files, 0 failures, 0 errors, 0 skipped. Lint (release): 0 errors, 13 warnings.
- `npm run android:verify -- --build-number 1`: RESULT PASS. The manifest audit accepted the allowed set `INTERNET`, `ACCESS_NETWORK_STATE`, `VIBRATE` plus the signature-level `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. `aapt2 dump permissions` on the APK lists the same three permissions.
- The APK, AAB and `mapping.txt` were copied to `/tmp/aa141/out/`, signed with a throwaway key.
- `git diff --stat` for `capacitor.build.gradle` and `capacitor.settings.gradle` shows only the added `capacitor-filesystem` and `capacitor-share` entries.
### Release APK on emulators
| Check | API 37 (`Pixel_7_2_api37`, `emulator-5586`) | API 34 (`Pixel_7_2`, `emulator-5584`) |
| --- | --- | --- |
| `smoke.sh` | PASS (13 checks). See the note below. | PASS (13 checks) |
| Install permissions granted (`dumpsys package`) | `INTERNET`, `ACCESS_NETWORK_STATE`, `VIBRATE` and the app's own signature permission | Same |
| Action bar node in `uiautomator dump` | None (`action_bar_root` is only the layout container) | None |
| Header text top | Brand 141 px, brand mark 154 px, buttons' labels 160 px (status bar is 136 px) | Same |
| Offline (Wi-Fi and data disabled, 15 s) | Banner "You're offline. The figures on screen may be out of date." at top 160 px, with a Retry button | Same |
| Online again (15 s) | Banner gone | Banner gone |
Notes:
- The first API 37 `smoke.sh` run failed only the back-button check. The cold-booted emulator was overloaded and a "System UI isn't responding" dialog was on top, so the back key went to the dialog. After dismissing it with "Wait" and letting the emulator settle, `smoke.sh` passed with a 30 s settle time and the dumps above were taken from that second run. The failed run is kept in `/tmp/aa15e/smoke-api37.log`.
- API 37 lists an extra requested permission, `android.permission.ACCESS_LOCAL_NETWORK` (runtime, granted by the platform). It is not in the APK manifest, so the platform adds it for apps that target an older SDK.
- The clickable boxes of the "Sign in" and "Sign up" buttons start at 133 px, because the accessibility bounds include padding. Their labels start at 160 px.
- On API 37 the first `uiautomator dump` after launch showed an empty WebView (no action bar node, but no page text either). The WebView content appeared in the later dumps, so the API 37 header bounds come from the dump taken after connectivity was restored, and the banner from the offline dump. On API 34 the first dump already showed the content.
