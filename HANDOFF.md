# Project Money — Handoff Notes

A summary for the next AI agent (or human teammate) picking up this project.

---

## What this is

A full-stack web app for personal budgeting + shared trip-expense splitting.
Hosted at **https://project-money-web.onrender.com**, source at
**https://github.com/umahack/project-money**.

**Owner:** umahack (GitHub). Primary admin email seeded in `ADMIN_EMAILS`.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend (**UI v2**, current) | React 18 + Vite 5 + TypeScript + plain CSS + Framer Motion + React Router | "Midnight vault" glass theme, light/dark toggle, bottom tab bar on phones, Arcade games. No Tailwind, no Recharts, fonts self-hosted. See **UI v2 and rollback** below |
| Frontend (UI v1, classic) | React 18 + Vite + Tailwind + Recharts | Kept in `frontend-v1/` and git tag `ui-v1-classic` for rollback |
| Backend | Node 20 + Express 4 (ESM) | `express-async-errors` patches async middleware |
| Database | **Turso (libsql)** | SQLite-compatible, hosted at `project-money-umahack.aws-ap-south-1.turso.io` |
| Auth | JWT (7-day) + bcrypt (cost 12) | Tokens in browser `sessionStorage` |
| Hosting | Render.com | Blueprint via `render.yaml` — one web service (Node) + one static site |

The DB client has a thin adapter (`backend/src/db/index.js`) that mimics
`better-sqlite3`'s `prepare(sql).get/all/run` API over libsql so route code
stays readable. All DB calls are **async** — `await db.prepare(...).run(...)`.

---

## UI v2 and rollback

The whole frontend was redesigned (branch `ui-v2`). **Backend, database and API are unchanged.** The new UI
talks to the same endpoints and uses the same `sessionStorage` keys (`pm_token`, `pm_user`), so signed-in
users survive a switch in either direction.

### Switch back to the classic UI (any of these)
1. **Render, no code change to the app:** in `render.yaml` set the `project-money-web` service
   `rootDir: frontend-v1` (it was `frontend`), commit, push, then **Clear build cache & deploy** on the web
   service. `frontend-v1/` is the complete old UI and builds on its own (`npm install && npm run build`).
2. **Git:** `git checkout ui-v1-classic` (tag on the last commit before the redesign) or
   `git revert` the v2 commit(s) on `main`.
3. Return to v2 any time: set `rootDir: frontend` again, or `git checkout ui-v2`.

### What each old page became
| Old page | v2 page | Notes |
|---|---|---|
| Login / Register | `/login`, `/register` (`AuthPage.tsx`) | Same routes, show/hide password, password checklist, friendly errors |
| Dashboard | Home `/` | Salary, EMI CRUD, donut, health, daily spend, recommendations. Recharts replaced by an SVG donut |
| Plan | `/plan` | Same line-by-line 50/30/20 generator plus emergency-fund target |
| Trips / TripDetail | `/trips`, `/trips/:id` | Equal or custom split, balances, settle-up, "Mark paid", "Add me" |
| Admin | `/admin` | Same actions; `prompt()`/`confirm()` replaced by dialogs; stats, search, per-user drill-down, feedback |
| Feedback modal on Logout | Sign out opens the same modal | Closing it (✕, Esc) now keeps you signed in; "Skip & sign out" leaves |
| (removed earlier) mini-game | `/arcade` | Coin Catcher and Snake Saver. Delete the route/tab in `App.tsx` and `Shell.tsx` if unwanted |

### Behaviours worth knowing (all because the API is unchanged)
- **Settlements** ("Mark paid") are saved as a normal expense whose description starts with
  `↔ Settlement: `, paid by the person paying back and split 100% to the receiver. The UI shows them as
  payments and leaves them out of "Spent". The classic UI shows them as ordinary expenses with that text.
- Trip members are still **names only**. The email field is a label, not an invite. The owner is not a member
  until added (v2 has an **Add me** button).
- The API only returns the **latest** salary entry, so v2 has no month switcher. It shows which month is on file.
- No API for editing/deleting trips, expenses or members, so v2 has no such buttons.
- The recommendation list = the API's tips plus extra insights computed in the browser (`insights.ts`).
  Amounts always come from the API.
- Production CSP is injected into `index.html` at build time by `vite.config.ts` (`script-src 'self'`, no
  inline script, no Google Fonts). `connect-src` allows only this site and the exact origin in `VITE_API_BASE`,
  so **VITE_API_BASE must be set at build time** or the browser will block API calls.

## Features implemented

1. **Auth** — register/login/logout, bcrypt + JWT, timing-equalized login,
   15-min rate limit on auth, 120 req/min global limit, body size cap 64 KB.
2. **Dashboard** — monthly salary input, 50/30/20 allocation chart (Recharts
   pie), EMI/Rent/Utility CRUD, personalized tips.
3. **Plan page** — line-by-line expense generator (rent, groceries, SIPs,
   emergency fund target) with per-item tips and a 6-month EF target.
4. **Trips** — budget + members + weighted splits + Splitwise-style greedy
   settle-up computed server-side.
5. **Feedback** — 5-star modal shown on Logout; one-time thank-you toast on
   next login (flag in localStorage); admin can view + delete.
6. **Admin dashboard** — users list w/ search, per-user drill-down (salaries,
   EMIs, trips), override salary, promote/demote admin, delete user / EMI /
   trip / feedback, aggregate stats including avg feedback rating.

### Admin bootstrap
Env var `ADMIN_EMAILS` (comma-separated, lowercase) on the API. Any user who
registers or logs in with a matching email is auto-promoted to admin.
Currently set to `admin@pord.com` (note the typo — kept intentionally so
existing registered user still matches).

---

## Deployed services (Render)

| Service | URL | What it runs |
|---|---|---|
| `project-money-api` | https://project-money-api.onrender.com | Node Express API |
| `project-money-web` | https://project-money-web.onrender.com | Vite static build |

Blueprint-managed from `render.yaml`. **Static-site plan field is omitted**
(Render static sites are always free). Node service is `plan: free`.

### Required env vars on `project-money-api`
- `JWT_SECRET` — generated by Render
- `NODE_ENV = production`
- `CORS_ORIGIN` — set to the web URL (currently `*` for simplicity)
- `ADMIN_EMAILS` — admin bootstrap list
- `TURSO_DATABASE_URL` — `libsql://project-money-umahack.aws-ap-south-1.turso.io`
- `TURSO_AUTH_TOKEN` — long `eyJ…` JWT from Turso dashboard

### Required env vars on `project-money-web`
- `VITE_API_BASE = https://project-money-api.onrender.com` (baked at build
  time; **Clear build cache & deploy** after any change)

### Known Render quirks encountered
- Blueprint services don't always auto-deploy on git push — use **Manual
  Deploy** on the service page.
- Free tier does **not** support persistent disks; disk block in
  `render.yaml` is commented out. Data lives in Turso instead.
- Static sites bake env vars at build time; must redeploy with cache cleared
  after an env change.

---

## Database (Turso)

- **URL:** `libsql://project-money-umahack.aws-ap-south-1.turso.io`
- **Plan:** Free (9 GB, no expiry)
- **Dashboard:** https://app.turso.tech — use the **Edit Data** tab to
  browse rows, or `turso db shell project-money` from CLI.

### Schema (auto-created on API boot)
`users (id, email, name, password_hash, is_admin, created_at)`
`salary_entries (id, user_id, month, amount, created_at, UNIQUE(user_id, month))`
`emis (id, user_id, label, amount, category, created_at)`
`trips (id, user_id, name, destination, budget, start_date, end_date, created_at)`
`trip_members (id, trip_id, name, email, UNIQUE(trip_id, name))`
`trip_expenses (id, trip_id, payer, description, amount, split_json, created_at)`
`feedback (id, user_id, email, rating, message, created_at)` — `user_id` can
be `NULL` (used on FK fallback or if user is deleted)

All child tables have `ON DELETE CASCADE` to users/trips. Idempotent
migration for the `is_admin` column handles pre-admin DBs.

---

## API routes

All non-auth routes require `Authorization: Bearer <jwt>`.

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/finance/salary
POST   /api/finance/salary
GET    /api/finance/emis
POST   /api/finance/emis
DELETE /api/finance/emis/:id
GET    /api/finance/plan
GET    /api/trips
POST   /api/trips
GET    /api/trips/:id              (returns settlement too)
POST   /api/trips/:id/members
POST   /api/trips/:id/expenses
POST   /api/feedback
GET    /api/admin/stats            (admin)
GET    /api/admin/users            (admin)
GET    /api/admin/users/:id        (admin)
PUT    /api/admin/users/:id/salary (admin)
PUT    /api/admin/users/:id/admin  (admin)
DELETE /api/admin/users/:id        (admin)
DELETE /api/admin/emis/:id         (admin)
DELETE /api/admin/trips/:id        (admin)
GET    /api/admin/feedback         (admin)
DELETE /api/admin/feedback/:id     (admin)
GET    /api/health
```

---

## Session history / why we did what

1. **Initial scaffold.** Built React + Express + SQLite from scratch with
   auth, dashboard, trips, splits, and an animated mini-game.
2. **Removed the mini-game** and added a detailed Plan page per request.
3. **Fixed text contrast** across the dark theme (bumped `text-white/40–60`
   utilities and tightened pill/input colors).
4. **Pushed to GitHub** `umahack/project-money` (public), using the
   `umahack@users.noreply.github.com` email to keep the Amazon work email
   out of a public repo.
5. **Set up Render blueprint deploy.** Two false starts: (a) free tier
   doesn't allow `disk:` — removed; (b) static sites don't take `plan:` —
   removed.
6. **Debugged "Failed to fetch"** — root cause was `CORS_ORIGIN=*` being
   split into `['*']` array (literal match), not treated as wildcard. Fixed
   server-side.
7. **Hardened auth UX** — password checklist, show/hide toggle, mapped
   common server errors to friendly copy, friendly network-error message.
8. **Added admin dashboard** — `ADMIN_EMAILS` env var bootstraps admins on
   login/register. First confusion: user logged in before the admin-feature
   deploy, so JWT lacked flag. Fix: logout → login re-issues JWT.
9. **Added feedback modal + welcome-back toast + admin feedback panel.**
10. **Stale JWT bug** after Render redeploy wiped SQLite — tokens pointed
    to non-existent users, causing FK failures. Fixed by having
    `authRequired` verify the user still exists and returning 401
    "Session expired"; client auto-logs-out on 401. Feedback endpoint
    additionally falls back to anonymous insert on FK failure.
11. **Migrated to Turso** so data survives all future deploys. All route
    handlers and middleware converted to async; `express-async-errors`
    added. Verified end-to-end locally against production Turso DB.

12. **UI v2 redesign** (branch `ui-v2`). Replaced the Tailwind UI with a TypeScript, plain-CSS "midnight
    vault" UI across every page including Admin. Classic UI kept in `frontend-v1/` plus tag `ui-v1-classic`.
    Tested in headless Chrome against a throwaway local backend, never the production Turso DB.

---

## Known caveats / what the next agent should know

- **Turso token was pasted in chat during setup.** Rotate it in the Turso
  dashboard and update `TURSO_AUTH_TOKEN` on Render.
- **One stray test user** `turso-test@example.com` may still exist in Turso
  from local smoke test — clean up with
  `DELETE FROM users WHERE email = 'turso-test@example.com';`
  (cascade handles salary/EMI/trip/feedback).
- **Admin email typo (`admin@pord.com`)** — kept intentionally so the
  existing admin user still matches. Change `ADMIN_EMAILS` on Render + log
  out/in if you want to switch.
- **No password reset flow.** If a user forgets their password, an admin
  must delete and recreate them, or build the flow.
- **Bundle size warning** — frontend >500 KB after minify (Recharts +
  Framer). Not blocking; use dynamic imports if you want to shrink.
- **`npm audit` warnings** from bcrypt's old `tar` dep. Runtime-safe; worth
  cleaning if hardening.
- **Render free tier cold starts** add ~30 s to first request after idle.
  Starter ($7/mo) removes this.

---

## Suggested next improvements

1. **Password reset** via email magic-link (needs an email provider like
   Resend; free tier available).
2. **Export my data** button on Dashboard (JSON download of own records).
3. **Multi-month salary history view** instead of only the latest entry.
4. **Trip invites by email** that create real user accounts (currently
   `trip_members` are just name labels on an owner's trip).
5. **PWA manifest + service worker** so it installs on mobile.
6. **E2E tests** — Playwright against a Turso branch DB.
7. **Code-split the frontend** — dynamic `import()` the Admin and Trip
   pages so the auth bundle stays small.
8. **Rotate Turso token** (see caveat).

---

## Project layout

```
Project Money/
├─ render.yaml                     Blueprint for both services
├─ README.md                       Public-facing setup & security notes
├─ HANDOFF.md                      ← this file
├─ backend/
│  ├─ package.json                 @libsql/client, express, bcrypt, …
│  ├─ .env.example                 Required env vars
│  └─ src/
│     ├─ server.js                 Express app wiring + CORS + helmet
│     ├─ db/index.js               libsql adapter + schema init
│     ├─ middleware/{auth,admin}.js
│     └─ routes/{auth,finance,trips,admin,feedback}.js
├─ frontend/                       UI v2 (current)
│  ├─ package.json                 vite 5, react 18, react-router 6, framer-motion 11, typescript
│  ├─ vite.config.ts               dev/preview proxy (loopback) + build-time CSP injection
│  └─ src/
│     ├─ main.tsx, App.tsx         routes (public: /login /register; private: everything else)
│     ├─ api.ts                    fetch wrapper, Bearer token in sessionStorage, 401 auto-logout
│     ├─ state.tsx                 AuthProvider + toasts
│     ├─ insights.ts               derived health / daily spend / recommendations
│     ├─ money.ts, types.ts, styles.css
│     ├─ components/               Shell (nav), FeedbackModal, ui (Card, Modal, Donut, ...)
│     ├─ games/                    CoinCatcher, Snake
│     └─ pages/                    AuthPage, Dashboard, Plan, Trips, TripDetail, Arcade, Admin
└─ frontend-v1/                    UI v1 classic (Tailwind) kept for rollback
```

---

## Local dev quickstart

```bash
# backend
cd backend
cp .env.example .env
# edit .env — set JWT_SECRET, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
npm install
npm run dev            # http://localhost:4000

# frontend (second terminal)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

Both talk to the same Turso DB as production unless you point
`TURSO_DATABASE_URL` at a branch (`turso db create project-money-dev` →
copy its URL into `.env`).
