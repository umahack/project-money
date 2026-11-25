# Project Money — Handoff

**Last updated**: 2026-11-18 · **`main` HEAD**: `3f56c25` · **active branch**: `dev`

Single source of truth for anyone (human or AI) picking this up cold.
Written so you can read this file, clone the repo, run locally, make a
change, and ship — in under an hour.

---

## 1. What this is

A full-stack personal-finance web app for Indian users (₹). Deployed as a
beta at **https://project-money.online**.

- **Plan** a monthly take-home salary into Needs 50 / Wants 30 / Save 20
  after fixed obligations (EMIs, rent, subscriptions).
- **Track** daily spending with per-category budgets and insights.
- **Save** towards named goals.
- **Split** trips Splitwise-style; invite friends by email or share a
  read-only link.

Owner: **@umahack** on GitHub. Admin bootstrap via `ADMIN_EMAILS` env var
on the API service.

---

## 2. Live URLs + accounts

| What | Where |
|---|---|
| Public site | https://project-money.online · https://www.project-money.online |
| API | https://project-money-api.onrender.com |
| Repo | https://github.com/umahack/project-money |
| Hosting | Render (`render.yaml` blueprint — one web + one static site) |
| DB | Turso (libsql) — plan: free |
| Email | Resend — domain `project-money.online` verified (SPF, DKIM, DMARC) |
| Domain | Hostinger (ALIAS `@` + CNAME `www` → Render) |
| Scheduled jobs | cron-job.org calling `POST /api/internal/cron/*` on 1st of month |

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite 8 + TypeScript · Framer Motion · plain CSS |
| Backend | Node 20 + Express 4 (ESM) + `express-async-errors` |
| Database | **Turso (libsql)** — serverless SQLite; `@libsql/client` adapter |
| Auth | HS256 JWT (30-min expiry) + bcrypt (cost 12) · per-session + token-version revocation |
| Email | Resend SDK; fallback-to-stdout when `RESEND_API_KEY` is unset |
| Hosting | Render (free tier) |
| Fonts | Outfit (sans), Fraunces (serif H1s on warm theme), JetBrains Mono |

Backend DB adapter (`backend/src/db/index.js`) wraps libsql with
`prepare().get/all/run` so routes read like better-sqlite3 but every call
is async.

---

## 4. Repo layout

```
backend/                          Node Express API
  src/
    server.js                     app wiring, CORS, helmet, rate limits, routers
    db/index.js                   libsql client + schema (idempotent CREATE IF NOT EXISTS)
    mailer.js                     Resend SDK + templates (register / resetPassword / emailChange / monthlyReview / alreadyRegistered)
    otp.js                        shared helpers: generate, bcrypt-hash, match, TTL
    sessions.js                   createSession() with FIFO cap-of-3 eviction
    audit.js                      audit_log writer
    middleware/
      auth.js                     authRequired — verifies JWT + session + token_version
      admin.js                    adminRequired + ADMIN_EMAILS helper
    routes/
      auth.js                     register/login/forgot/email-change/profile/sessions/account
      finance.js                  salary/emis/plan/expenses/budgets/recurring/goals/categories/streak/CSV
      trips.js                    trips + members + expenses + settlement + share
      admin.js                    users/salary override/password reset/trips/feedback/announcements/stats/audit
      feedback.js                 POST + GET /mine
      invites.js                  trip invites (constant-shape to prevent enumeration)
      visits.js                   POST /track (optional-auth; respects session revocation)
      public.js                   GET /public/trips/:token + announcement
      internal.js                 POST /internal/cron/monthly-review (secret-gated)
    jobs/
      monthlyReview.js            shared logic for monthly email job
  scripts/
    send-monthly-review.js        CLI runner for local invocation

frontend/                         React + Vite SPA
  src/
    main.tsx                      StrictMode + routes + font imports; theme default = 'light'
    App.tsx                       Routes + Guest/Private wrappers + marketing-landing fallback
    api.ts                        fetch wrapper, auth header, 401 kick-out, 403-is-admin cleanup
    state.tsx                     AuthProvider + ToastProvider; event bus for session expiry
    insights.ts                   browser-side math: health, spentOnNeeds, dailyLeft, overspent
    passwordRules.ts              shared PW_RULES (len/letter/digit/no-space)
    userViewPref.ts               session-scoped admin↔user view flag
    money.ts                      inr(), parseAmount(), monthKey(), monthLabel()
    pages/
      Dashboard.tsx               Home — overview only; QuickActions + hero + actual-vs-budget
      Plan.tsx                    editable pay+bills (via PlanInputs) + 50/30/20 lines + tips
      Spending.tsx                daily log, insights, history chart
      Recurring.tsx               auto-logged recurring expenses (hidden from sidebar; route still live)
      Goals.tsx, Trips.tsx, TripDetail.tsx, Settings.tsx
      MarketingLanding.tsx        public landing at '/' for logged-out visitors
      AuthPage.tsx                /login + /register — clean form pages with Back + CTA
      ForgotPassword.tsx          2-step reset flow
      AdminLogin.tsx              dedicated /admin-login portal
      Legal.tsx                   /privacy and /terms
      NotFound.tsx                adapts: public hero OR inside Shell when signed in
      admin/*.tsx                 Overview, Users, Feedback, Traffic, Broadcast, AdminAccount
      Arcade.tsx                  hidden from nav, still routed
      PublicTrip.tsx              read-only /share/trip/:token
    components/
      Shell.tsx                   signed-in layout — topbar (brand+clock+switch+signout) + sidebar + bottom tabs + outlet
      TopbarClock.tsx             macOS-style compact Wed · 18 Nov · 12:56 am
      QuickActions.tsx            4 tiles: Add expense / Plan month / Savings goal / Trip split
      StreakCard.tsx              logging streak (fetches /finance/streak)
      TodayStrip.tsx              month-progress band (compact)
      PlanInputs.tsx              Pay + Bills forms with inline edit per bill
      DevicesPanel.tsx, ChangePassword.tsx, DangerZone.tsx (export+delete)
      FeedbackModal.tsx           mandatory first time; skippable after
      InvitesInbox.tsx            trip-invite inbox + usePendingInvitesCount hook
      AnnouncementBanner.tsx, SessionWarning.tsx, OnboardingModal.tsx
      ui.tsx                      Card, PageTitle, Donut, Spinner, Skeleton, Modal, Field, Money, Empty
  .env.local.example              VITE_API_BASE=http://localhost:4000
  .env.local                      YOUR local config (gitignored)

render.yaml                       Blueprint — 2 services, CORS allowlist, JWT auto-generated, CRON_SECRET auto-generated
```

---

## 5. Ship workflow

Render auto-deploys on push to `main`. Edit, commit, push — that's it.

```bash
git commit -am "fix X"
git push                            # Render redeploys
```

No local dev environment. All work hits prod on push. Prod data lives in
Turso (cloud); backend reads `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` from
Render env vars.

---

## 6. Features (current state)

### Public / landing
- `/` — Marketing landing (MarketingLanding.tsx) for logged-out visitors: hero + feature grid + live-preview donut + testimonials. Sign in + Sign up CTAs in topbar.
- `/login`, `/register` — clean form-only pages. Topbar carries Back (only when `window.history.state.idx > 0`) + the opposite-page CTA.
- `/forgot-password` — 2-step OTP reset.
- `/admin-login` — dedicated admin portal.
- `/privacy`, `/terms` — static legal pages.
- `/share/trip/:token` — public read-only trip view (owner enables public_token).

### Auth
- Signup → OTP email verification → account. Returns constant-shape response regardless of existence (prevents enumeration).
- Login → email + password, OR Sign in with Google (`POST /api/auth/google`). Google ID token verified server-side via `google-auth-library`; user is found/linked by `google_sub`, else by verified email, else created with sentinel `password_hash='!google'`. Password-login on a Google-only account returns a friendly "use Sign in with Google" message.
- Forgot password → OTP email.
- Email change → OTP to the new address. Bumps `token_version`, revokes other sessions.
- Password rules: ≥8 chars, letter, digit, no leading/trailing spaces. Shared `isStrongPassword()` on backend; `passwordRules.ts` on frontend.
- Session: 30-min JWT with "Stay signed in" refresh at 25-min; per-session `sid` revocation; mass `token_version` kill-switch on password/email change.
- **3-device cap** — FIFO eviction on 4th sign-in. `createSession` inserts first, then trims excess, closing the race.
- Admin accounts: `/admin-login`; last-admin guards on `/auth/account` self-delete AND on `/admin/users/:id` delete AND on demote.

### Home (Dashboard)
Overview only. No forms.
- **QuickActions** — Add expense / Plan month / Savings goal / Trip split.
- **StreakCard** — current + longest consecutive logging days.
- **Hero** —
  - Health badge (Excellent / Good / Tight / Critical; degrades a notch when spent > budget).
  - Monthly pay inline + ✏️ Edit link to `/plan#pay-form`.
  - Month-progress bar in header ("Day 18 of 30").
  - 50/30/20 donut (budget split).
  - **"Spent so far"** actual-vs-budget bars for Needs + Wants (red when over). "Save so far" row — green ≥ target, amber under.
  - "Left to spend per day" = `(needs+wants budget − spent) / daysRemaining` — reshapes with every expense.
- **"Open the plan →"** link for tips.
- Loading state is a shell + skeleton bars, not a full-page Spinner — Dashboard LCP paints the H1 instantly.

### Plan
- **PlanInputs** — editable Pay + editable Bills (inline edit on each row via ✏️, PATCH `/finance/emis/:id`).
- 50/30/20 line-by-line by category.
- Smart recommendations list.

### Spending
- Daily log, inline per-category budgets, 12-month history, MoM-delta / weekday-pattern / category-spike insights.

### Goals, Trips, Settings, Recurring
- **Goals** — target amount + deadline + contributions.
- **Trips** — budget + members + weighted splits + settle-up (greedy minimum-transactions). Public share link (128-bit token). Only payer themselves (or trip owner) can post settlement expenses. Only owner can add new members.
- **Settings** — Profile (name + email change via OTP) · Devices · Categories (case-insensitive dedup) · ChangePassword · ExportData (CSV) · **DangerZone** (full JSON export + account delete with current-password + typed "DELETE").
- **Recurring** — hidden from sidebar (merged conceptually with Plan's Bills), but route and page still work for existing bookmarks.

### Admin
`/admin/*` pages (Overview, Users, Feedback, Traffic, Broadcast, AdminAccount). `visits` stats use IST-anchored SQLite date math. All destructive admin actions audit. `/admin/users/:id` delete does explicit cross-table cleanup.

### Scheduled jobs
- **Monthly review email** on 1st of each month at 09:00 IST — a cron-job.org trigger hits `POST /api/internal/cron/monthly-review` with an `x-cron-secret` header matching `CRON_SECRET` on the API. The endpoint runs `backend/src/jobs/monthlyReview.js` which walks every user, computes last-month totals, and sends via Resend. Idempotent per `(user_id, month)` via `monthly_review_log`.
- **DB backups** — Turso's native 24-hour snapshots with 30-day retention. No cron needed.

---

## 7. API routes (summary)

```
# public (no auth)
GET    /api/health
GET    /api/public/announcement
GET    /api/public/trips/:token
POST   /api/track                                      (optional-auth; validates session revocation)

# auth (unauthenticated OTP flows)
POST   /api/auth/register-start                         constant-shape response
POST   /api/auth/register-resend                        constant-shape
POST   /api/auth/register-finish                        per-email 429 limiter; dummy-bcrypt on wrong email
POST   /api/auth/login
POST   /api/auth/password-reset-start                   constant-shape + constant-bcrypt-time
POST   /api/auth/password-reset-finish                  per-email 429 limiter
POST   /api/auth/email-change-start   (authRequired)    per-user 3/hour limiter
POST   /api/auth/email-change-confirm                   bumps token_version
GET    /api/auth/email-change-pending
DELETE /api/auth/email-change-pending

# auth (session)
POST   /api/auth/password                               rotate password; kick other sessions
PATCH  /api/auth/profile                                name only; renames trip_members + trip_expenses.payer too
POST   /api/auth/refresh                                sliding window
GET    /api/auth/sessions
DELETE /api/auth/sessions/:id
DELETE /api/auth/sessions                               sign out everywhere else
GET    /api/auth/export                                 full JSON of your rows
DELETE /api/auth/account                                requires currentPassword + "DELETE" confirm; last-admin guard

# money
GET  /api/finance/salary                   POST /api/finance/salary
GET  /api/finance/emis                     POST /api/finance/emis
PATCH /api/finance/emis/:id                DELETE /api/finance/emis/:id
GET  /api/finance/plan                     GET /api/finance/insights
GET  /api/finance/history                  GET /api/finance/streak
GET  /api/finance/categories               POST /api/finance/categories
DELETE /api/finance/categories/:id
GET  /api/finance/expenses                 POST /api/finance/expenses
DELETE /api/finance/expenses/:id
GET  /api/finance/budgets                  PUT /api/finance/budgets/:category
DELETE /api/finance/budgets/:category
GET  /api/finance/recurring                POST /api/finance/recurring
PATCH /api/finance/recurring/:id           DELETE /api/finance/recurring/:id
GET  /api/finance/export.csv

# trips
GET /api/trips           POST /api/trips
GET /api/trips/:id       DELETE /api/trips/:id
POST /api/trips/:id/members                             owner-only
POST /api/trips/:id/expenses                            payer must be a current member;
                                                        settlements only by payer or owner
POST /api/trips/:id/share                               enable/rotate public token
DELETE /api/trips/:id/share                             disable + null the token

# invites
POST /api/trips/:id/invite                              constant-shape response
GET  /api/invites
POST /api/invites/:id/accept
POST /api/invites/:id/decline

# feedback
POST /api/feedback
GET  /api/feedback/mine                                 count of prior submissions

# admin  (all require authRequired + adminRequired)
GET /api/admin/users                                    aggregated single query
GET /api/admin/users/:id
PUT /api/admin/users/:id/salary                         year/month sanity bounds
PUT /api/admin/users/:id/password                       enforces shared isStrongPassword
PUT /api/admin/users/:id/admin                          last-admin demote guard
DELETE /api/admin/users/:id                             explicit cross-table cleanup
DELETE /api/admin/emis/:id                              audited
DELETE /api/admin/trips/:id                             audited
GET  /api/admin/feedback
DELETE /api/admin/feedback/:id                          audited
GET /api/admin/announcements        POST /api/admin/announcements
PUT /api/admin/announcements/:id/active
GET /api/admin/audit
GET /api/admin/stats                                    IST-anchored date math

# internal (secret-gated cron)
POST /api/internal/cron/monthly-review                  x-cron-secret header required
```

---

## 8. Database schema

Idempotent `CREATE TABLE IF NOT EXISTS` in `backend/src/db/index.js`. All
timestamps are SQLite `CURRENT_TIMESTAMP` (UTC). Server TZ pinned to
`Asia/Kolkata` for Node Date arithmetic, so `monthKey()` and
`spent_on` match the user's local day.

```
users                 (id, email UNIQUE, name, password_hash, is_admin,
                       token_version, created_at)
pending_registrations (email UNIQUE, name, password_hash, verify_code_hash,
                       verify_expires_at, verify_attempts, created_at)
pending_email_changes (user_id UNIQUE, new_email, verify_code_hash,
                       verify_expires_at, verify_attempts, created_at)
pending_password_resets (email UNIQUE, verify_code_hash, verify_expires_at,
                         verify_attempts, created_at)

salary_entries        (user_id, month, amount; UNIQUE(user_id, month))
emis                  (user_id, label, amount, category)
expense_log           (user_id, month, category, amount, note, spent_on, created_at)
category_budgets      (user_id, category, amount; UNIQUE)
recurring_expenses    (user_id, label, amount, category, day_of_month, active,
                       last_logged_month, updated_at)
user_categories       (user_id, name; UNIQUE)
savings_goals         (user_id, name, target_amount, saved_amount, target_date)

trips                 (user_id, name, destination, budget, start_date, end_date,
                       public_token UNIQUE, public_enabled)
trip_members          (trip_id, user_id NULL, name, email;
                       UNIQUE(trip_id, name))
trip_expenses         (trip_id, payer TEXT, description, amount, split_json, created_at)
trip_invites          (trip_id, inviter_id, invitee_id, status;
                       UNIQUE(trip_id, invitee_id))

sessions              (user_id, device_label, ip_hash, user_agent,
                       last_seen_at, revoked_at, revoked_reason)
audit_log             (actor_id NULL, actor_email, action, target, details, ip_hash)
visits                (user_id NULL, path, ip_hash, user_agent)
feedback              (user_id NULL, email, rating, message)
announcements         (message, kind, is_active, actor_email)
monthly_review_log    (user_id, month; PRIMARY KEY)
```

Foreign-key cascades are declared, but we don't rely on `PRAGMA foreign_keys = ON`.
Account delete (`/auth/account`) and admin user delete both do explicit
per-table cleanup inside a single handler.

---

## 9. Security posture

- **HS256 JWT pinned** everywhere it's verified (middleware/auth.js, visits.js). `token_version` + per-session `sid` revocation.
- **CORS**: refuses to boot in prod without a non-wildcard `CORS_ORIGIN` allowlist. Wrong-origin → 403 JSON. Any `/api/*` miss → JSON 404.
- **Helmet**: strict CSP (`default-src 'none'`), HSTS 1y + preload, no `x-powered-by`, body limit 64KB.
- **Rate limits**: global 120/min (prod) / 2000/min (dev); per-endpoint tighter limiters on login/OTP/send/password-reset-finish/register-finish. All send limiters skip 4xx.
- **No enumeration**: register-start / register-resend / register-finish / password-reset-start / password-reset-finish / email-change-start / `/trips/:id/invite` all return constant-shape responses. Timing attacks flattened with dummy-bcrypt on wrong-email paths.
- **CSV formula injection** defused in `csvEscape`.
- **IP addresses never stored raw** — only daily-salted sha256(ip)[0:24] in `visits.ip_hash` and `sessions.ip_hash`.
- **Password rules unified** — same `isStrongPassword()` on register, change, reset, and admin reset.
- **Trip integrity** — payer must be a current member; settlement expenses can only be posted by the payer themselves or the trip owner; non-owner members cannot add new members.
- **Admin last-safeguards** — can't delete the last admin via `/auth/account`, can't delete the last admin via `/admin/users/:id`, can't demote the last admin via `/admin/users/:id/admin`.
- **Visit attribution** respects session revocation (optionalUserId checks `revoked_at` and current `token_version`).
- **Pending OTP tables purged** — `sweepExpiredPending()` runs at the top of every OTP-start handler so bcrypt hashes don't accumulate.
- **`CRON_SECRET` auto-generated** by Render on first boot (`render.yaml` has `generateValue: true`); timing-safe compared on every internal cron hit; rate-limited; `requireCronSecret` runs *before* the limiter so bad probes can't burn legit quota.
- **4 rounds of audits** have been done. 55 findings surfaced, 39 fixed. See history section below for the complete rounds.

---

## 10. Environment variables

### Production — `project-money-api` (Render)
| Var | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | auto-generated by Render |
| `CORS_ORIGIN` | `https://project-money.online,https://www.project-money.online,https://project-money-web.onrender.com` |
| `ADMIN_EMAILS` | comma-separated emails auto-promoted to admin |
| `TURSO_DATABASE_URL` | `libsql://project-money-umahack.aws-ap-south-1.turso.io` |
| `TURSO_AUTH_TOKEN` | rotate periodically |
| `RESEND_API_KEY` | `re_...` |
| `MAIL_FROM` | `Project Money <noreply@project-money.online>` |
| `CRON_SECRET` | auto-generated by Render — the value is in Render's env tab; it's also in cron-job.org's `x-cron-secret` header |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web Application client ID from Google Cloud Console. Not secret (also baked into frontend). When unset, `/auth/google` returns 503 and the button hides itself. |
| `TZ` | `Asia/Kolkata` |

### Production — `project-money-web` (Render)
| Var | Notes |
|---|---|
| `VITE_API_BASE` | `https://project-money-api.onrender.com` (baked at build) |
| `VITE_GOOGLE_CLIENT_ID` | Same value as backend's `GOOGLE_CLIENT_ID`. Baked into the bundle. |

---

## Android release

Capacitor 8 wrapper in `frontend/android`: application id `online.projectmoney.app` (permanent once
published), minSdk 24, targetSdk 36. The WebView loads the bundled `dist` from `https://localhost`
(`server.androidScheme: 'https'`, no `server.url`) and calls the Render API over HTTPS. Submitting to
Google Play is a manual step for the owner: see [docs/android-play-store-checklist.md](docs/android-play-store-checklist.md).
Spec: `.kiro/specs/android-app-release/` (requirements, design, tasks). A shorter summary is in `README.md`.
Run every command from `frontend/` unless noted.

### Prerequisites

- **JDK 21.** `capacitor.build.gradle` sets source and target compatibility to Java 21. On this machine
  the Android Studio JBR 21 is the active JDK (`/usr/libexec/java_home -V` to check).
- **Android SDK** at `~/Library/Android/sdk` (override with `ANDROID_HOME`). `frontend/android/local.properties`
  has `sdk.dir` (gitignored). Build-tools 35.0.0 and 36.0.0 are installed; `verify.mjs` picks the newest.
  `adb`, `emulator`, `apksigner`, `aapt2` are not on `PATH`. Call them by full path
  (`~/Library/Android/sdk/platform-tools/adb`, `~/Library/Android/sdk/emulator/emulator`); the scripts do.
- **Emulator**: AVD `Pixel_7_2`, with system images for API 34 (`android-34/google_apis_playstore`) and
  API 37 (`android-37.0/google_apis_playstore`), both arm64.
- Run one heavy process at a time (Gradle, emulator, test suites). Log long commands to a file.

### Env file: `.env.android`

`cp .env.android.example .env.android` (gitignored together with `.env.android.local`).

| Key | Value | Rule |
|---|---|---|
| `VITE_API_BASE` | `https://project-money-api.onrender.com` | `https://` only, no trailing slash. `vite build --mode android` throws a message naming the variable if it is missing or not https. `capacitor.config.ts` also reads it (release throws too) to build `server.allowNavigation`. |
| `VITE_FINANCIAL_CLARITY_ENABLED` | `false` | Default. |
| `VITE_QUICK_ADD_ENABLED` | `false` | Default. Does nothing unless the clarity flag is `true`. |

Precedence: real environment, then `.env.android.local`, then `.env.android`. Nothing here is secret
(everything `VITE_*` ends up in the public bundle). Android mode also strips `console.*` and removes the
`accounts.google.com` entries from the CSP; `connect-src` is `'self'` plus the API origin.

### Commands (all in `frontend/package.json`)

| Script | Runs |
|---|---|
| `android:build` | `vite build --mode android` |
| `android:sync` | `android:build`, then `CAPACITOR_ENV=release npx cap sync android` |
| `android:sync:debug` | `vite build`, then `CAPACITOR_ENV=debug npx cap sync android` |
| `android:release` | `android:sync`, then `cd android && ./gradlew bundleRelease assembleRelease` |
| `android:verify` | `node scripts/android/verify.mjs` |
| `android` | `android:sync:debug`, then `cap open android` (Android Studio) |
| `android:run` | `android:sync:debug`, then `cap run android` |

- **Debug build**: `npm run android:sync:debug`, then `cd android && ./gradlew assembleDebug`
  (`app/build/outputs/apk/debug/app-debug.apk`). No keystore or build number needed. `CAPACITOR_ENV=debug`
  gives `allowMixedContent` and WebView debugging on, native logging `debug`, and `allowNavigation` for the API
  host plus `10.0.2.2` and `localhost`. The debug source set overlays `network_security_config.xml` to permit
  cleartext to `10.0.2.2` and `localhost` only. `FLAG_SECURE` is off, so screenshots work.
- **Release build**: `npm run android:release -- -PbuildNumber=N`. npm appends the argument to the end of the
  script, so Gradle receives `bundleRelease assembleRelease -PbuildNumber=N`. Outputs:
  `android/app/build/outputs/bundle/release/app-release.aab` and `.../apk/release/app-release.apk`.
- `CAPACITOR_ENV` is `release` when missing or unknown. Release: `allowMixedContent=false`,
  `webContentsDebuggingEnabled=false`, `loggingBehavior=none`, `allowNavigation=[API host]`.
  `capacitor.config.ts` imports no local module (the Capacitor CLI loads it outside Vite).
- Gradle checks (`app/build.gradle`): `versionName` = `frontend/package.json` `version`; `versionCode` =
  `buildNumber`, a positive integer up to 2100000000, from `-PbuildNumber=N` or `buildNumber=N` in
  `android/gradle.properties`. A release task (`assembleRelease`, `bundleRelease`, `packageRelease`, and the
  bundle signing tasks) fails without it, because Play rejects a reused `versionCode`. Debug defaults to 1.
  An invalid value fails every build. Bump it for every build you upload.
- Lint and the full set: `cd android && ./gradlew lint assembleDebug bundleRelease assembleRelease -PbuildNumber=N`.
  Native unit tests: `./gradlew testDebugUnitTest` (`SecureWindowPolicyTest`).

### Upload keystore and signing

```bash
mkdir -p ~/keys
keytool -genkeypair -v -keystore ~/keys/project-money-upload.jks -alias upload \
        -keyalg RSA -keysize 2048 -validity 10000
```

`frontend/android/keystore.properties` (gitignored; template `keystore.properties.example`):

```properties
storeFile=/absolute/path/to/project-money-upload.jks
storePassword=<store password>
keyAlias=upload
keyPassword=<key password>
```

- `storeFile` is absolute or relative to `frontend/android`. A missing file, a missing or empty key, or a
  `storeFile` that does not exist fails the release task with a message naming the problem. The release build
  is never signed with the debug key.
- **Never commit** the keystore or `keystore.properties` (`*.jks`, `*.keystore`, `keystore.properties` are in
  `.gitignore` and `frontend/android/.gitignore`). **Keep two offline copies** of the keystore and passwords in
  separate places (encrypted drive, password manager). Do not put them in the repo, a chat, or an unencrypted cloud folder.
- **Play App Signing**: enrol on the first upload. Google keeps the app signing key; this keystore is the upload
  key only. A lost upload key can be reset through Play Console support. Without enrolment, a lost signing key
  means the app can never be updated.

### Verify

`npm run android:verify` (optionally `-- --build-number N`, or `BUILD_NUMBER=N`; otherwise it reads
`buildNumber` from `android/gradle.properties`, and when neither exists it only checks that a `versionCode` is present).
Steps, in order, stopping at the first failure and naming it:

1. `auditManifest.mjs` on `app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml`.
2. `apksigner verify --verbose --print-certs` on the APK (a debug certificate is rejected).
3. `jarsigner -verify` on the AAB (a debug certificate is rejected).
4. `aapt2 dump badging`: package, `versionName`, `versionCode`, target 36, min 24, not debuggable, permissions exactly the allowed set.
5. The same audit on the manifest decoded from the APK.
6. Web bundle: no `accounts.google.com` (one known literal in a JS chunk is reported as a note), no `localhost:4000`,
   no `10.0.2.2`, no `http://` API URL, no `console.*` call (one known `console.error` in `@capacitor/core` is allowed),
   the API origin is present, and the CSP meta is present with `connect-src` limited to `'self'` and the API origin.

`node scripts/android/auditManifest.mjs <AndroidManifest.xml>` runs the audit alone; it prints every violation and
exits non-zero if there is one. Other `verify.mjs` flags: `--apk`, `--aab`, `--manifest`, `--web-dir`, `--api-base`,
`--help`, `--self-test`.

**Emulator smoke (`scripts/android/smoke.sh`).** `scripts/android/smoke.sh [apk]` uses AVD `Pixel_7_2` on emulator
port 5584 (so it does not collide with another emulator), boots it if needed, then: `adb install -r`, launch,
`MainActivity` resumed, no `FATAL EXCEPTION`, package not `DEBUGGABLE` and no `ALLOW_BACKUP`, `run-as` refused,
secure flag check through `dumpsys window`, and back on the first screen minimises the app. Env: `AVD_NAME`,
`SMOKE_EMULATOR_PORT`, `SMOKE_API_LEVEL` (34 or 37), `SMOKE_HEADLESS=1`, `SMOKE_BUILD_TYPE=debug`,
`SMOKE_STOP_EMULATOR=1`, `ANDROID_SERIAL`. It refuses a physical device unless `SMOKE_ALLOW_PHYSICAL_DEVICE=1`.
**Screenshots from a release build are blank because of `FLAG_SECURE`.** That is expected and counts as evidence
the flag works. For visual checks use `adb shell uiautomator dump` or a debug build.

Manual checklist, on API 34 and API 37: install and launch; OTP sign-up; sign-in; add an expense; export CSV and
account JSON through the share sheet; back button on Home, in a dialog, and on `/agreement`; rotate; dark mode;
airplane mode (offline banner, Retry); kill and reopen (shows sign-in). Confirm the export files are gone from the
cache about 60 seconds after sharing.

### Security posture

- **Cleartext off.** No `usesCleartextTraffic`; `network_security_config.xml` has `cleartextTrafficPermitted="false"`
  and trusts system CAs only (no user CAs). Only the debug overlay allows `10.0.2.2` and `localhost`.
- **Backup off.** `allowBackup="false"`, with `data_extraction_rules.xml` (Android 12+) and `backup_rules.xml`
  (Android 11 and lower) excluding every domain.
- **No certificate pinning, on purpose.** Render rotates certificates on its own schedule. A pin would lock every
  installed app out of the API after a rotation until users updated. Protection is system trust anchors, HSTS on the
  API, and cleartext being denied.
- **`FLAG_SECURE`** in release builds, set in `MainActivity` before `super.onCreate` when
  `SecureWindowPolicy.shouldSetSecureFlag` says the app is not debuggable. Hides screenshots, recording, and the
  recents thumbnail. No setting turns it off.
- **Permissions** (checked by the audit and by `aapt2 badging`): `android.permission.INTERNET`,
  `android.permission.ACCESS_NETWORK_STATE` (normal, no prompt; without it the Android WebView always reports
  `navigator.onLine === true`, so the offline banner never shows), `android.permission.VIBRATE`
  (from `@capacitor/haptics`), and
  `online.projectmoney.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (from `androidx.core`; declared with
  `protectionLevel="signature"`). Anything else fails the audit. No storage permission: exports use the FileProvider
  over the cache directory.
- **Exported components**: only `MainActivity`. `androidx.profileinstaller.ProfileInstallReceiver` (exported by a
  library) is removed in `AndroidManifest.xml` with `tools:node="remove"`. The FileProvider is `exported="false"`.
  `file_paths.xml` declares a `cache-path` only.
- **R8**: release has `minifyEnabled true`, `shrinkResources true`, `debuggable false`. `proguard-rules.pro` keeps
  Capacitor plugins and `@JavascriptInterface` members. `MainActivity` uses `android:windowSoftInputMode="adjustResize"`.
- Navigation is restricted with `server.allowNavigation`. The generated `res/xml/config.xml` (`<access origin="*"/>`)
  is Cordova compatibility output and is not edited.
- No analytics, ad, or crash-reporting SDK.
- Edge-to-edge: `MainActivity` calls `EdgeToEdge.enable(this)`; `SystemBars.insetsHandling` is `css`. The emulator
  runs at API 34 and 37 may switch it to `native`; record the result with the emulator notes.

### Behaviour notes

- **Sign-in ends when the app process ends.** Same as web: the 30-minute JWT is in `sessionStorage` (`pm_token`;
  user in `pm_user`), read only through `frontend/src/tokenStore.ts`. Nothing is stored in `localStorage`, cookies,
  or native storage. Killing the app means signing in again. Minimising keeps the process, and the session, while
  Android keeps the process alive.
- **Google Sign-In is hidden on native** (`GoogleSignInButton` and `AuthDivider` render nothing when
  `isNativePlatform()`; the GSI script never loads). Email and password and OTP registration work.
- **Export** (`frontend/src/native/exportFile.ts`): on native, the CSV and account JSON are written to the app cache
  and handed to the system share sheet, then deleted after 60 seconds; a start-up sweep removes leftovers named
  `project-money-(account|expenses)-*`. The toast says "Shared". On web the old anchor download is unchanged.
- **Back button** (`frontend/src/native/backButton.ts`): closes the top dialog (a locked dialog swallows it), on
  `/agreement` while the agreement is required it minimises the app (never navigates, so the notice cannot be skipped),
  on `/` and `/login` it minimises, elsewhere it goes back in history, and minimises when there is none. It uses
  `App.minimizeApp()`, never `exitApp()`. The web registers no listener.
- **Offline**: `OfflineBanner` (native only) shows a status notice with Retry and refetches on reconnect. After 5 seconds
  with no first response the Home page shows the "free server may be waking up" hint (up to a minute on Render's free tier).
- **Haptics**: one light impulse on Quick Add save, a different one on undo; none under reduced motion or on web.

### Render step: add the app origin to `CORS_ORIGIN`

The app's origin is `https://localhost`. On Render, `project-money-api`, Environment: append it to `CORS_ORIGIN` and redeploy.
The value is a comma-separated list; append `,https://localhost` to what is already there, for example:

```
CORS_ORIGIN=https://project-money.online,https://www.project-money.online,https://project-money-web.onrender.com,https://localhost
```

`resolveCorsOrigin` in `backend/src/app.js` splits on commas, trims, and accepts an origin only on an exact string match.
No wildcard, no trailing slash, no scheme or port variants (`http://localhost` and `https://localhost:3000` are rejected).
`credentials` stays `false`. Tests: `backend/test/api/corsAllowlist.test.js` and
`backend/test/property/corsAllowlist.property.test.js`. Check after the deploy (the first request may take up to a minute):

```bash
curl -s -I -H "Origin: https://localhost" https://project-money-api.onrender.com/api/health | grep -i access-control-allow-origin
curl -s -i -X OPTIONS https://project-money-api.onrender.com/api/health \
  -H "Origin: https://localhost" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization" | grep -i access-control-allow-origin
```

Both should print `access-control-allow-origin: https://localhost`. No output means the new value has not deployed or
does not match exactly.

### Flag order for Quick Add in the app

The first release has Quick Add and Financial Clarity off. To turn Quick Add on: (1) set `QUICK_ADD_ENABLED=true` on the
API and let it deploy (server first); (2) set `VITE_FINANCIAL_CLARITY_ENABLED=true` and `VITE_QUICK_ADD_ENABLED=true` in
`frontend/.env.android`; (3) rebuild with a higher `-PbuildNumber`, run `android:verify`, and upload the new AAB. Installed
apps keep the old flags until updated. Rollback: set `VITE_QUICK_ADD_ENABLED=false` and ship a new build; the server flag can
be flipped alone (see the Quick Add rollout section of `README.md`).

### Known limits

- Sessions end when the app process ends.
- No Google Sign-In on Android in version 1.
- The first release ships with Quick Add and Financial Clarity off.
- **"Stay signed in" is deferred.** It needs a backend refresh-token endpoint, revocation on password change and account
  deletion, secure storage (Android Keystore), an optional biometric gate, and a threat model for a long-lived credential on
  a device. Version 1 stores no credential outside `sessionStorage`.
- Release screenshots are blank (`FLAG_SECURE`); there is no toggle.
- Free-tier Render cold start of up to a minute on the first request.
- Without a network the app shows the offline notice; figures on screen may be out of date.
- `insetsHandling` (`css` now) is subject to the emulator evaluation.

### Out of scope

iOS; biometric or app lock; native Google Sign-In (after v1); certificate pinning; root, jailbreak, or emulator detection;
a screenshot setting; analytics or crash SDKs; Android CI; backend changes beyond the exported `resolveCorsOrigin`
and its tests; and the Play Console submission (the owner does it, using the checklist above).

---

## 11. Deferred / planned

Already shipped (ignore if you were about to add them):
- sendLimiter prod key-generator fix
- Forgot password
- Monthly email digest
- Account delete + data export
- Privacy / Terms pages
- 3-device cap
- Mandatory feedback on first sign-out
- Marketing landing (`/`)
- Warm minimal theme
- 404 page
- PWA icons
- Nightly backup — replaced by Turso's native 30-day backups
- Google Sign-In (web) — `POST /api/auth/google`, auto-link by verified email, no OTP for Google signups

Still open:
1. **Google Sign-In on Android (after v1)** — hidden on native in version 1; the Android release section above describes what ships. Native sign-in (Credential Manager) needs an Android OAuth client ID with the app's SHA-1 fingerprints registered (upload key and Play App Signing key) and a backend path that accepts the native ID token.
2. **Weekly digest email** — reuse the monthlyReview pattern (`backend/src/jobs/weeklyReview.js` + a second cron-job.org trigger).
3. **Trip chat (polling v1)** — `trip_messages` table + 4-s poll + unread badge on the Trips tab.
4. **Receipt photo upload / OCR** — needs object storage (Cloudinary / S3).
5. **Shared / joint accounts** — workspace-model refactor; wait for explicit asks.
6. **`api.project-money.online` custom subdomain** — then drop onrender.com from CORS_ORIGIN.
7. **Email-change batched DB transaction** when libSQL supports it cleanly.
8. **Proper Recurring + Bills merge** — schema reconciliation (currently distinct tables).

---

## 12. Caveats / gotchas

- `server.js` route mount order matters: `/api/public`, `/api/internal` and `/api/track` must sit BEFORE routers that call `router.use(authRequired)` globally (finance, trips, admin, feedback, invites).
- SQLite's `CURRENT_TIMESTAMP` is always UTC regardless of the `TZ` env. For user-local day math we use Node `new Date()` component builders (TZ-aware under the `TZ=Asia/Kolkata` env). Never use `toISOString().slice(0,10)` for day/month.
- `trip_expenses.payer` is a TEXT name. When a user renames themselves in `/auth/profile`, their `trip_members.name` + `trip_expenses.payer` in trips they're a member of are also renamed to keep balances attributed.
- `trip_expenses` has no `paid_by_user_id` column (common mistake — don't reference it). The `payer` field is a string.
- Hover transforms (`transform`, `scale`, `rotate`) are wrapped in `@media (hover: hover) and (pointer: fine)` with a global touch-device safety-net that neutralises them all. Don't add new hover-lift effects without this guard.
- Blueprint-managed Render services sometimes don't auto-deploy on push — use Render dashboard → Manual Deploy if a commit doesn't appear.
- All frontend tokens live in `sessionStorage` (per-tab). Don't change to localStorage without re-thinking XSS risk.
- Admin broadcast writes to a shared `announcements` table that affects every signed-in user. Be careful when smoke-testing — a stray test banner is visible site-wide.
- Instagram story PNGs + the user guide PDF are gitignored at `instagram-stories/` — don't commit.

---

## 13. Session / sprint history (chronological)

1. Initial scaffold React + Express + SQLite.
2. Line-by-line Plan page (replaces mini-game).
3. Switch to Turso (libsql) — codebase goes async with thin adapter.
4. Admin feature + `ADMIN_EMAILS` bootstrap.
5. Trip invites + public read-only share links.
6. Email aliases + OTP verification shipped then fully reverted. Alias/handle stays out.
7. Expense log + budgets + 12-month history + goals + CSV + onboarding + recurring.
8. Visitor tracking + landing preview.
9. Security hardening: HS256 pin, token_version, admin audit, strict CSP/HSTS/CORS, bcrypt 6.
10. Device management: sessions table, device panel.
11. Sidebar + page split; TripDetail 4-tab layout.
12. Session timeout toast; auto theme; custom categories; admin broadcast; 429 UX.
13. Profile editor.
14. **OTP sprint back in** (register/finish/resend + email-change-start/confirm). `pending_registrations` + `pending_email_changes` tables.
15. Custom domain `project-money.online` live; Let's Encrypt cert.
16. Marketing assets (Instagram stories, PDF guide, promotional poster).
17. Admin console separation (`/admin-login`, `/admin/account`, single `🔄` switch button).
18. 3-device concurrent cap (FIFO eviction with insert-first-then-trim).
19. Admin lands on `/admin` on sign-in; `pm_prefer_user_view` session flag.
20. Mobile overflow + hover sanity (narrow phones, touch-device safety net).
21. Warm minimal theme as default (cream + Fraunces serif + emerald accents).
22. Mandatory feedback on first sign-out.
23. Basic-plan sprint — forgot password, account delete + export, Privacy + Terms, CSV formula escape, send-limiter fix.
24. **4 rounds of audits** — 55 findings, 39 fixed. Highlights: timezone drift, account-delete crash, trip phantom balances, settlement forgery, enumeration oracles, LCP fix, HTML-escape monthly review template, CORS-not-500.
25. IA cleanup — Home overview-only, Pay+Bills forms on Plan, 5-tab nav.
26. Scheduled jobs off GitHub — monthly review via `POST /api/internal/cron/*` + cron-job.org; nightly backup replaced by Turso native.
27. Inline bill edit (PATCH `/api/finance/emis/:id`); marketing landing refresh with "Customise everything" tile.
28. Value-first onboarding + optimistic add/edit/delete + skeleton shells (kill loading flashes).

---

## 14. When continuing this project

1. Clone and read this file.
2. Edit on `main`. Commit, push. Render redeploys in ~2 min.
3. Hard-refresh the browser; check the new asset hash is live (`curl -L https://www.project-money.online/ | grep index-`).
4. Prefer forking an audit (Agent subagent_type `fork`) before shipping anything non-trivial. Rounds 1–4 have each caught 5+ real bugs.
5. Update this file whenever a sprint lands.

---

End of handoff.
