# Project Money

A full-stack, mobile-friendly budget planner.

- **Auth** — email + password, bcrypt, JWT, rate limited
- **Dashboard** — enter monthly salary; see 50/30/20 split after mandatory EMIs
- **Plan** — line-by-line expense generator (rent, groceries, SIPs, emergency fund target, etc.)
- **Trips** — budget + members + weighted splits + Splitwise-style settle-up
- **Theme** — dark gradient, Framer Motion animations, mobile-first

## UI versions and rollback
`frontend/` is **UI v2** (TypeScript, plain CSS, Framer Motion). The previous Tailwind UI is kept as
`frontend-v1/` and as git tag `ui-v1-classic`. The API and database are identical for both.

To roll back, set `rootDir: frontend-v1` for `project-money-web` in `render.yaml`, push, and redeploy with
**Clear build cache**. Set it back to `frontend` to return to v2. Details are in `HANDOFF.md`.

## Local dev

```bash
# Terminal 1 — backend
cd backend
cp .env.example .env     # then set JWT_SECRET to a long random string
npm install
npm run dev              # http://localhost:4000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev              # http://localhost:5173
```

## Deploy to Render (free)

The repo includes `render.yaml` describing two services (API + static web).

1. Push this repo to GitHub (already done if you got the link from the owner).
2. Go to **https://dashboard.render.com → New → Blueprint** and point it at this repo.
3. Render will detect `render.yaml` and show two services:
   - `project-money-api` (Node, with 1 GB persistent disk for SQLite)
   - `project-money-web` (static site)
4. Click **Apply**. First deploy takes 2–3 minutes.
5. After the API deploys, copy its URL (e.g. `https://project-money-api.onrender.com`) and set it on the web service as `VITE_API_BASE`. On the API service, set `CORS_ORIGIN` to the web URL (e.g. `https://project-money-web.onrender.com`). Trigger a redeploy of the web service so the Vite build picks up `VITE_API_BASE`.
6. Share the web URL with your friend. First hit after idle takes ~30 s on the free tier.

## Security defaults

- bcrypt cost 12, JWT 7-day, 20-req/15-min auth rate limit, 120-req/min global limit
- Helmet, body size cap 64 KB (returns 413 cleanly), `x-powered-by` disabled
- Prepared SQLite statements everywhere, trip-ownership guard on nested writes
- `sessionStorage` tokens (cleared on tab close)
- CSP meta + static-site security headers (X-Frame-Options, Referrer-Policy, Permissions-Policy)

## Verified edge cases

- SQLi payloads rejected (parameterized queries)
- Short/weak passwords → 400; unknown email login still runs bcrypt (timing safe)
- Oversized bodies → 413, bad JSON → 400
- User B GET on User A's trip → 404
