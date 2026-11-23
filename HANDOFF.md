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
1. **Google Sign-In on Android** — needs `@codetrix-studio/capacitor-google-auth` + Android client ID + SHA-1 fingerprint registered.
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
