# Project Money — Handoff Notes

Last updated: 2026-11-16 · HEAD: `498841f` on `main`

Single source of truth for anyone (human or AI) continuing the project.
Read alongside the repo.

---

## What this is

Full-stack personal-finance web app:

- **Plan** a monthly salary into 50 % needs / 30 % wants / 20 % save after fixed EMIs.
- **Track** daily spending with per-category budgets and smart insights.
- **Save** towards named goals with live progress.
- **Split** trips Splitwise-style, invite registered friends, share a read-only link with anyone.

### Live URLs
- **Web**: https://project-money.online (custom domain) · https://project-money-web.onrender.com (fallback)
- **API**: https://project-money-api.onrender.com (`api.project-money.online` planned)
- **Source**: https://github.com/umahack/project-money
- **Owner**: `umahack` · primary admin bootstrapped via `ADMIN_EMAILS` (currently `admin@pord.com`).

### Domain
- **project-money.online** purchased on **Hostinger** (₹99 first year).
- DNS at Hostinger:
  - `ALIAS @ → project-money-web.onrender.com` (Hostinger converts an attempted `CNAME @` to ALIAS; this is correct behaviour).
  - `CNAME www → project-money-web.onrender.com`
  - `CNAME api → project-money-api.onrender.com` *(planned)*
  - Resend records: `TXT resend._domainkey`, `CNAME rsend`, `CNAME send`, `TXT _dmarc`
- Render has verified the apex and `www`; **Let's Encrypt certificate issued** automatically.
- Hostinger's default `A @` and `CNAME www` were deleted — their defaults point to Hostinger's parking page.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite 8 + TypeScript + Framer Motion + Recharts |
| Backend | Node 20 + Express 4 (ESM) + `express-async-errors` |
| DB | **Turso (libsql)** — SQLite-compatible, serverless, free tier |
| Auth | HS256 JWT (30-min expiry) + bcrypt (cost 12) |
| **Email** | **Resend** — free tier (3000/mo, 100/day). Domain verified on `project-money.online`. |
| Hosting | Render.com — one web service (Node) + one static site; `render.yaml` blueprint |

**DB adapter** (`backend/src/db/index.js`) wraps `@libsql/client` with a
`prepare().get/all/run` shape so the route code reads like better-sqlite3
but every call is async.

**Mailer** (`backend/src/mailer.js`) wraps `Resend` SDK. If `RESEND_API_KEY`
is unset the code is logged to stdout — dev / smoke tests still work.

---

## Current feature list

### User-facing
- **Auth with OTP** —
  - Signup is 3-step: name/email/password → email a 6-digit code → verify → account created, 30-min session.
  - Login (email + password, unchanged behaviour; alias/handle logic was reverted).
  - Change password (self-service).
  - **Edit profile** — change name (immediate) or email (goes through OTP: `email-change-start` + `email-change-confirm`).
  - 30-min JWT; refresh via "Stay signed in" toast at 25-min mark.
  - Per-account 5-fail login lockout (independent from per-IP global limiter).
- **Device management** — only one session active per account; new login revokes the old with a specific 401 message. Devices panel in Settings with per-device sign-out.
- **Home** — enter salary + fixed EMIs → auto 50/30/20 donut + insights + recommendations.
- **Spending** — daily log, inline category budgets, 12-month history bar chart, smart insights (MoM delta, weekday pattern, category spike).
- **Plan** — line-by-line expense generator by category with a 6-month emergency-fund target.
- **Recurring** — Netflix / rent / gym; backend materializes them into `expense_log` on the configured day of month.
- **Goals** — savings goals with target amount, target date, contributions (positive or negative), progress bar.
- **Trips** — budget + members + Splitwise-style settle-up; invite registered friends by email; public read-only share links; TripDetail is a 4-tab layout (Expenses · Balances · People · Share).
- **Settings** — Profile · Devices · Custom categories · Change password · Export CSV.
- **Feedback** — logout-time modal with 5-star rating + optional message; thank-you toast on next login.
- **Onboarding** — 5-step first-visit modal; flag in localStorage.
- **PWA** — installable with manifest + maskable SVG icon.
- **Theme** — auto-follows OS `prefers-color-scheme` on first visit; manual toggle overrides and persists.
- **Landing preview** — on `/login`, a gradient hero + feature grid + testimonials, so visitors understand the app before signing up.
- **Session warning** — toast appears 5 min before token expiry with a "Stay signed in" button that calls `/auth/refresh`.
- **429 UX** — rate-limit errors show "Try again in N seconds" using the `Retry-After` header.

### Admin (`/admin` sub-routes)
- **Overview** — eight stat tiles (users, admins, trips, EMIs, totals, feedback count, avg rating) + nav cards to each section.
- **Users** — searchable list + drill-down with reset-password, promote / demote, salary override, user delete.
- **Feedback** — list and delete.
- **Traffic** — 14-day visitor bar chart (daily salted IP hash — no raw IPs stored), top paths, latest 25 views, append-only audit log of privileged actions.
- **Broadcast** — write a banner (info / warn / ok) shown at the top of every page for all users and on the public login page.

---

## Deployed services (Render)

| Service | URL | Notes |
|---|---|---|
| `project-money-api` | https://project-money-api.onrender.com | Node Express API |
| `project-money-web` | https://project-money-web.onrender.com | Vite static build; also served at https://project-money.online |

### Required env vars on `project-money-api`
| Key | Notes |
|---|---|
| `JWT_SECRET` | Render-generated |
| `NODE_ENV` | **must be `production`** |
| `CORS_ORIGIN` | **comma-separated non-wildcard** — currently `https://project-money.online,https://www.project-money.online,https://project-money-web.onrender.com`. The server refuses to boot in prod otherwise. |
| `ADMIN_EMAILS` | Comma-separated emails promoted to admin on login/register |
| `TURSO_DATABASE_URL` | `libsql://project-money-umahack.aws-ap-south-1.turso.io` |
| `TURSO_AUTH_TOKEN` | Long `eyJ…` — rotate periodically |
| **`RESEND_API_KEY`** | `re_…` from https://resend.com/api-keys |
| **`MAIL_FROM`** | `Project Money <noreply@project-money.online>` |

### Required env vars on `project-money-web`
| Key | Notes |
|---|---|
| `VITE_API_BASE` | `https://project-money-api.onrender.com` (baked at build time; **Clear build cache & deploy** after changes). Will move to `https://api.project-money.online` once that subdomain goes live. |

### Known Render quirks
- Blueprint services don't always auto-deploy on push; use **Manual Deploy**.
- Static sites bake env vars at build time; must redeploy with cache cleared after any env change.
- Free tier has no persistent disk — SQLite file is ephemeral, so Turso is used for all persistence.
- Custom-domain certificate issuance by Let's Encrypt takes ~5–30 min after DNS verifies; purple "issuing" banner is normal.

---

## Database (Turso)

- URL: `libsql://project-money-umahack.aws-ap-south-1.turso.io`
- Plan: Free (9 GB, no expiry)
- Browse: https://app.turso.tech → database → **Edit Data**, or `turso db shell project-money` from CLI.

### Schema (auto-created on API boot)

**Core**
```
users                   (id, email UNIQUE, name, password_hash, is_admin,
                         token_version, created_at)
pending_registrations   (email UNIQUE, name, password_hash,
                         verify_code_hash, verify_expires_at,
                         verify_attempts, created_at)
pending_email_changes   (user_id UNIQUE, new_email, verify_code_hash,
                         verify_expires_at, verify_attempts, created_at)
salary_entries          (user_id, month, amount; UNIQUE(user_id, month))
emis                    (user_id, label, amount, category)
```

**Spending**
```
expense_log        (user_id, month, category, amount, note, spent_on)
category_budgets   (user_id, category, amount; UNIQUE)
recurring_expenses (user_id, label, amount, category, day_of_month,
                    active, last_logged_month)
user_categories    (user_id, name; UNIQUE)
```

**Trips**
```
trips          (user_id, name, destination, budget, start_date, end_date,
                public_token UNIQUE, public_enabled)
trip_members   (trip_id, user_id FK NULL, name, email; UNIQUE(trip_id, name))
trip_expenses  (trip_id, payer, description, amount, split_json)
trip_invites   (trip_id, inviter_id, invitee_id, status; UNIQUE(trip_id, invitee_id))
```

**Goals, security, admin**
```
savings_goals        (user_id, name, target_amount, saved_amount, target_date)
sessions             (user_id, device_label, ip_hash, user_agent,
                      last_seen_at, revoked_at, revoked_reason)
audit_log            (actor_id, actor_email, action, target, details, ip_hash)
visits               (user_id FK NULL, path, ip_hash, user_agent)
feedback             (user_id FK NULL, email, rating, message)
announcements        (message, kind, is_active, actor_email)
```

Child tables use `ON DELETE CASCADE` to users/trips. Idempotent migrations
in `db/index.js` handle existing DBs when columns are added.

---

## API routes

All non-public, non-auth routes require `Authorization: Bearer <jwt>`.

```
# public (no auth)
GET    /api/health
GET    /api/public/announcement
GET    /api/public/trips/:token
POST   /api/track

# OTP signup
POST   /api/auth/register-start           name + email + password → OTP email
POST   /api/auth/register-finish          code → create user + session JWT
POST   /api/auth/register-resend          resend the code

# auth (session)
POST   /api/auth/login
POST   /api/auth/password                 change own password
PATCH  /api/auth/profile                  name only (email changes use OTP)
POST   /api/auth/refresh                  slide the 30-min window
GET    /api/auth/sessions
DELETE /api/auth/sessions/:id             revoke one
DELETE /api/auth/sessions                 sign out everywhere else

# email change OTP
POST   /api/auth/email-change-start       OTP to the new address
POST   /api/auth/email-change-confirm     swap email + mint fresh JWT
GET    /api/auth/email-change-pending     UI resumability
DELETE /api/auth/email-change-pending     cancel in-flight change

# money
GET    /api/finance/salary
POST   /api/finance/salary
GET    /api/finance/emis
POST   /api/finance/emis
DELETE /api/finance/emis/:id
GET    /api/finance/plan
GET    /api/finance/insights
GET    /api/finance/history
GET    /api/finance/categories
POST   /api/finance/categories
DELETE /api/finance/categories/:id
GET    /api/finance/expenses
POST   /api/finance/expenses
DELETE /api/finance/expenses/:id
GET    /api/finance/budgets
PUT    /api/finance/budgets/:category
DELETE /api/finance/budgets/:category
GET    /api/finance/recurring
POST   /api/finance/recurring
PATCH  /api/finance/recurring/:id         toggle active
DELETE /api/finance/recurring/:id
GET    /api/finance/goals
POST   /api/finance/goals
PATCH  /api/finance/goals/:id             partial + addToSaved/setSaved
DELETE /api/finance/goals/:id
GET    /api/finance/export.csv

# trips
GET    /api/trips
POST   /api/trips
GET    /api/trips/:id
POST   /api/trips/:id/members
POST   /api/trips/:id/expenses
GET    /api/trips/:id/share               owner
POST   /api/trips/:id/share               create / rotate
DELETE /api/trips/:id/share
POST   /api/trips/:id/invite              owner
GET    /api/invites
POST   /api/invites/:id/accept
POST   /api/invites/:id/decline

# feedback
POST   /api/feedback

# admin
GET    /api/admin/stats
GET    /api/admin/users
GET    /api/admin/users/:id
PUT    /api/admin/users/:id/salary
PUT    /api/admin/users/:id/password
PUT    /api/admin/users/:id/admin
DELETE /api/admin/users/:id
DELETE /api/admin/emis/:id
DELETE /api/admin/trips/:id
GET    /api/admin/feedback
DELETE /api/admin/feedback/:id
GET    /api/admin/audit
GET    /api/admin/visits/stats
GET    /api/admin/announcements
POST   /api/admin/announcements
PUT    /api/admin/announcements/:id/active
DELETE /api/admin/announcements/:id
```

Mount order matters: `/api/public` and `/api` (visits/invites) are
registered **before** auth-blanket routers so `/api/track` and the public
endpoints are reachable without a token.

---

## Security posture

- JWT signed and verified with **HS256 only** (algorithm pinned to prevent `alg: none` and confusion attacks).
- JWT payload: `{ sub, email, name, is_admin, tv, sid }` with 30-min `expiresIn`. `tv` is `users.token_version`; `sid` is `sessions.id`.
- `authRequired` middleware verifies: valid signature, user row exists, `tv` matches current column, session row exists and is not revoked. Touches `sessions.last_seen_at` on every call.
- **Single-active-session**: every successful login revokes all prior sessions for the user with reason `another_device`.
- Password change bumps `token_version` + revokes every session except the current one.
- Admin password reset also bumps `token_version` (user gets booted on every device).
- Per-account login throttle: 5 bad passwords in 15 min = 15-min lock, independent of per-IP rate limits.
- Global rate limiter: 120 req/min; auth routes 20 / 15 min; password change 10 / 15 min; feedback 20 / h; **OTP sends** (register-start / email-change-start) 10 / h. *Note: `sendLimiter` isn't firing reliably through Render's proxy chain — Resend sandbox mode is covering us in practice but a `trust proxy` adjustment is on the deferred list.*
- Helmet in strict mode: CSP `default-src 'none'`, HSTS 1 y with `includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, COOP `same-origin`.
- CORS strictly allowlisted in production (refuses to boot without `CORS_ORIGIN`).
- Prepared statements everywhere; no string interpolation of user input into SQL.
- OTP codes are **bcrypt-hashed** in `pending_registrations` and `pending_email_changes`; 15-min TTL; max 6 wrong attempts before forcing a resend. The `ON CONFLICT DO UPDATE` on pending rows means a resend invalidates the previous code.
- Audit log for destructive admin actions: password resets, user delete, promote / demote, announcement create / delete, self password change, profile edits, email changes.
- All visitor and audit IPs are stored as `sha256(day:salt:ip)[0:24]` — no raw IPs persisted.
- `npm audit` on backend + frontend: **0 vulnerabilities** everywhere (prod + dev).

### Known deferred security items
- **sendLimiter not firing reliably in prod** — `trust proxy` config needs tightening + the OTP limiter should use `keyGenerator` tied to the body's email, not just IP. Documented but not yet shipped. Impact: a bad actor could burn Resend quota; mitigated today by Resend sandbox-mode rejecting unverified recipients.
- **User enumeration via `/register-start`** — "already registered" vs "ok" responses reveal which emails have accounts. Standard trade-off. Left as-is.
- **Password reset self-service** — currently admin-driven. Needs email delivery (now available via Resend); planned for next sprint.

---

## Session / decision history (chronological)

Entries describe decisions, especially reverts, so future agents don't re-litigate them.

1. **Initial scaffold** — React + Express + SQLite. Deployed to Render.
2. **Removed the mini-game** and added a line-by-line Plan page.
3. **Switched to Turso** (libsql) after Render free tier wiped the ephemeral SQLite on every redeploy. Codebase went async end-to-end with a thin adapter.
4. **Admin feature + bootstrap via `ADMIN_EMAILS` env var.**
5. **Trip invites + public read-only share links.**
6. **Email aliases + OTP verification** — shipped, then **fully reverted** (AliasManager UI, `/api/aliases` routes, mailer, otp, Resend dep all removed). The alias/handle concept remains out; OTP came back later in a different form (see #14).
7. **Feedback-driven feature pack**: expense log + budgets + 12-month history chart + savings goals + CSV export + onboarding tour + recurring expenses + admin password reset.
8. **Visitor tracking + landing preview**: anonymous page-view tracker with hashed-per-day IP; marketing landing section on `/login`.
9. **Security hardening**: HS256 pin, `token_version`, admin audit log, per-account throttle, strict CSP + HSTS 1y, strict CORS in prod, bcrypt 6, vite 8 (both audits now 0 vulnerabilities).
10. **Device management**: `sessions` table, single-active-session, device panel.
11. **Sidebar + page split**: Dashboard split into Spending, Recurring, Goals, Settings; Admin split into Overview, Users, Feedback, Traffic, Broadcast; TripDetail into 4 URL-synced tabs.
12. **Polish sprint**: Session timeout toast (`/auth/refresh`), auto theme, custom expense categories, admin broadcast banner, 429 UX with retry-seconds.
13. **Profile editor (name + unverified email change)** — email changes were briefly allowed without verification, with a stub "OTP sprint later" note.
14. **OTP sprint (shipped)** — Resend wired back in. Signup becomes 3 steps (`register-start / finish / resend`). Email change in Settings now routes through `email-change-start → email-change-confirm`. PATCH `/auth/profile` was tightened to name-only. New tables: `pending_registrations`, `pending_email_changes`. Both OTP paths bcrypt-hash codes, 15-min TTL, 6-attempt lock. **Alias/handle is intentionally NOT part of this sprint** — stays out until explicitly requested again.
15. **Custom domain** `project-money.online` purchased on Hostinger. Render verified apex + `www`; Let's Encrypt cert issued. `CORS_ORIGIN` updated to include it. `VITE_API_BASE` will switch to `api.project-money.online` once that subdomain is set up.
16. **Marketing assets** — Instagram story PNGs, LinkedIn / WhatsApp copy, PDF user guide, promotional poster for an influencer friend (with QR + testimonials + how-it-works). Story PNGs are gitignored at `instagram-stories/`.

---

## Deferred (planned, not shipped)

Priority order:

1. **sendLimiter fix** — tighten `trust proxy`, add body-email-based keyGenerator so OTP throttle actually fires per-target-email in prod.
2. **Forgot-password self-service** — Resend is now live; same OTP pattern as the signup/email-change flows. Public endpoint sends code to a known user's email; verify-code + new password finish it.
3. **Weekly email digest** — Monday "You spent ₹X last week" summary. Reuse mailer; needs a cron trigger (GitHub Action hitting `/api/jobs/weekly-digest` with a shared secret).
4. **Admin: verify Resend domain reputation / warming** — once the volume grows, monitor Resend's dashboard for bounces + opens.
5. **Trip chat (polling v1)** — `trip_messages` table + 4-s poll + unread count on the Trips tab.
6. **Capacitor Android wrapper** — scaffolded plan only. Wait for 20+ MAU before investing.
7. **Receipt photo upload** — needs object storage (Cloudinary / Supabase).
8. **Shared / joint accounts** — large refactor to a workspace model. Wait for explicit tester asks.
9. **`api.project-money.online` custom domain for the API** — add in Render, update `VITE_API_BASE`, drop `onrender.com` from `CORS_ORIGIN` once nothing points there.

---

## Caveats / gotchas

- Route mount order in `server.js` matters: `/api/public` and `/api/track` must sit above the invites router (which has blanket `authRequired`).
- Blueprint-managed Render services don't always auto-deploy on git push; use **Manual Deploy** when a commit doesn't show up.
- Admin `/admin/broadcast` writes to a shared table — careful when smoke-testing; a previous test posted a banner that showed up for every user until cleaned.
- `instagram-stories/` is gitignored but exists locally for marketing drafts (story-1.png, promo, update, all-in-one poster).
- All tokens live in `sessionStorage` (per-tab, cleared on tab close). Never `localStorage` — do not change this without rethinking XSS risk.
- `/auth/refresh` is called by the "Stay signed in" toast. It validates the current token's session + token_version, so stale tokens still get 401'd rather than silently refreshed.
- **Resend sends only to the account email until a domain is verified.** We've verified `project-money.online` so all users can receive. Keep the DNS records at Hostinger intact (SPF, DKIM, DMARC) — removing any will tank deliverability.
- The dev-mode fallback (log OTP to stdout) still works if `RESEND_API_KEY` is unset — useful if Resend is ever down.

---

## Project layout

```
Project Money/
├─ render.yaml                     Blueprint for both services
├─ README.md                       Public setup notes
├─ HANDOFF.md                      ← this file
├─ USER_GUIDE.md                   Beta-tester guide
├─ Project-Money-User-Guide.pdf    Printable version of the guide
├─ instagram-stories/              Local marketing drafts (gitignored)
│   ├─ project-money-story.png     Original story (hero/features)
│   ├─ project-money-update.png    "Big update" domain-change announcement
│   └─ project-money-promo.png     Influencer-ready promo with QR + testimonials
├─ backend/
│  ├─ package.json                 @libsql/client, express, bcrypt, resend, …
│  ├─ .env.example                 Required env vars incl. RESEND_API_KEY + MAIL_FROM
│  └─ src/
│     ├─ server.js                 Express wiring, helmet, CORS, mounts
│     ├─ audit.js                  shared audit() helper
│     ├─ sessions.js               session helpers + daily IP hash
│     ├─ otp.js                    OTP code gen / hash / verify / expiry
│     ├─ mailer.js                 Resend wrapper + branded templates
│     ├─ db/index.js               libsql adapter + schema + migrations
│     ├─ middleware/{auth,admin}.js
│     └─ routes/
│        ├─ auth.js                register-start/finish/resend, login, refresh,
│        │                         password, profile, sessions,
│        │                         email-change-start/confirm/pending
│        ├─ finance.js             salary, emis, plan, insights, history,
│        │                         expenses, budgets, categories,
│        │                         recurring, goals, export.csv
│        ├─ trips.js               trips + members + expenses + share
│        ├─ invites.js             trip invites
│        ├─ feedback.js            POST feedback
│        ├─ admin.js               users, feedback, audit, visits/stats,
│        │                         announcements
│        ├─ visits.js              POST /track
│        └─ public.js              /public/announcement, /public/trips/:token
└─ frontend/
   ├─ package.json                 vite 8, react, react-router, framer-motion
   ├─ vite.config.ts
   ├─ index.html                   PWA meta tags
   ├─ public/
   │  ├─ favicon.svg, pwa-icon.svg, pwa-icon-maskable.svg
   │  └─ manifest.webmanifest
   └─ src/
      ├─ main.tsx
      ├─ App.tsx                   Routing (public + private + admin)
      ├─ api.ts                    fetch wrapper, 401 auto-logout, 429 retry-after
      ├─ state.tsx                 AuthProvider + ToastProvider,
      │                            listens for auth:changed; registerStart/Finish/Resend
      ├─ money.ts                  inr(), parseAmount, currentMonth, fmtDate
      ├─ insights.ts               buildInsights() helper
      ├─ types.ts
      ├─ styles.css                single stylesheet (dark + light)
      ├─ hooks/
      │  ├─ useVisitTracker.ts     fire POST /track on route change
      │  └─ useSessionWarning.ts   fires 5 min before JWT exp
      ├─ components/
      │  ├─ Shell.tsx              Sidebar + topbar + bottom-tabs (mobile)
      │  ├─ AnnouncementBanner.tsx Top-of-shell banner
      │  ├─ SessionWarning.tsx     "Stay signed in" toast
      │  ├─ ProfileSettings.tsx    Name save + email change OTP flow
      │  ├─ CategoryManager.tsx    Add/remove custom categories
      │  ├─ DevicesPanel.tsx       Active sessions + revoke
      │  ├─ ChangePassword.tsx     Self-service password change
      │  ├─ ExportData.tsx         CSV download button
      │  ├─ SpendingTracker.tsx    Log + inline budgets + category totals
      │  ├─ MonthlyHistoryChart.tsx 12-month CSS bar chart
      │  ├─ SmartInsights.tsx      MoM, weekday, spike detector
      │  ├─ RecurringExpenses.tsx  Create / pause / resume / delete
      │  ├─ SavingsGoals.tsx       Create / contribute / delete goals
      │  ├─ InvitesInbox.tsx       Dashboard trip-invites card
      │  ├─ TripShareLink.tsx      Owner's share-link control
      │  ├─ VisitorsPanel.tsx      Admin traffic widget
      │  ├─ AuditLogPanel.tsx      Admin audit widget
      │  ├─ LandingPreview.tsx     Hero + features on /login
      │  ├─ OnboardingModal.tsx    5-step first-visit tour
      │  ├─ FeedbackModal.tsx      Logout-time rating prompt
      │  └─ ui.tsx                 Card, Field, Donut, ProgressBar, Modal, …
      └─ pages/
         ├─ AuthPage.tsx           /login + /register with 3-step OTP signup
         ├─ Dashboard.tsx          /    (salary + plan hero)
         ├─ Spending.tsx           /spending
         ├─ Plan.tsx               /plan   (line-by-line budget)
         ├─ Recurring.tsx          /recurring
         ├─ Goals.tsx              /goals
         ├─ Settings.tsx           /settings
         ├─ Trips.tsx              /trips  (list)
         ├─ TripDetail.tsx         /trips/:id?tab=…  (4 URL-synced tabs)
         ├─ PublicTrip.tsx         /share/trip/:token  (no auth)
         ├─ Arcade.tsx             /arcade
         └─ admin/
            ├─ AdminOverview.tsx   /admin
            ├─ AdminUsers.tsx      /admin/users
            ├─ AdminFeedback.tsx   /admin/feedback
            ├─ AdminTraffic.tsx    /admin/traffic
            └─ AdminBroadcast.tsx  /admin/broadcast
```

---

## Local dev quickstart

```bash
# backend
cd backend
cp .env.example .env         # set JWT_SECRET, TURSO_DATABASE_URL,
                             # TURSO_AUTH_TOKEN, optionally RESEND_API_KEY
                             # and MAIL_FROM. CORS_ORIGIN can stay * for dev.
npm install
npm run dev                  # http://localhost:4000

# frontend (new terminal)
cd frontend
npm install
npm run dev                  # http://localhost:5173
```

Without `RESEND_API_KEY` the server logs OTPs to stdout — you can finish
the signup / email-change flow locally without sending real email.

Both talk to the same **production** Turso DB. For a safer dev loop,
create a branch DB in Turso and point `TURSO_DATABASE_URL` at that in
your local `.env`.

### Smoke-test checklist after any backend change

```bash
# Health
curl -s http://localhost:4000/api/health

# OTP signup round-trip (dev / fallback mode)
curl -s -X POST http://localhost:4000/api/auth/register-start \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@test.com","name":"Dev","password":"supersecret1"}'
# Look at the server log for "Your 6-digit code: NNNNNN", then:
curl -s -X POST http://localhost:4000/api/auth/register-finish \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@test.com","code":"NNNNNN"}'
```

### Build before pushing
```bash
cd frontend && npm run build       # must emit "✓ built"
```

### Deploy on Render after push
1. **project-money-api → Manual Deploy → Deploy latest commit**.
2. **project-money-web → Manual Deploy → Clear build cache & deploy**.

---

## When continuing this project

- Keep **features on their own pages** with a `PageTitle`. Never pile new sections onto `/` — add a sidebar entry.
- Keep **destructive admin actions audited** (`audit(req, { action: ... })`).
- Keep **auth tokens in `sessionStorage`**; do not switch to localStorage without rethinking XSS.
- When shipping a new table, add it to the schema block in `db/index.js`. For adding a column to an existing table, add an idempotent `try { SELECT } catch { ALTER }` migration below the schema.
- When adding a new mutation endpoint, pick between `authRequired` + `adminRequired` as needed and consider auditing it.
- When adding a new email flow, reuse `backend/src/mailer.js` templates and `otp.js` helpers; new flows should respect `sendLimiter` + bcrypt-hashed codes + 15-min TTL.
- Smoke-test against Turso with a one-shot Node script before pushing; pattern used throughout the chat history.
- Keep the dev-mode mailer fallback working — it's a cheap safety net during Resend outages.

Owner / point of contact: **Umakanth** (GitHub `umahack`).
