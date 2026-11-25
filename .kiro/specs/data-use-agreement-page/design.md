# Data Use Agreement Page Design

## Overview

Today, `DataUseGate` renders the full `DataUseNotice` card, the acknowledge button, and the paused-entries reason directly above every signed-in page inside `Shell`. This feature moves the full notice and the acknowledge action to a dedicated route, `/agreement`, and keeps `DataUseGate` as a small compact control plus a paused-entries banner. `DataUseGate` continues to be the `aria-describedby` target other pages already reference (`DATA_USE_REASON_ID`), so no other page changes.

The redirect to `/agreement` is driven entirely by the existing `Data_Use_Gate` (`useDataUseGate()`), with one new piece of state: an in-memory `Not_Now_Choice` that a user sets by choosing "Not now, just look around". Nothing is written to persistent storage. The feature is purely a frontend reorganization behind the existing `Rollout_Flag`; no backend route, schema, or contract changes.

### Goals

1. Give the user a readable, dedicated page for the data-use notice, reachable at `/agreement`, that reuses the existing `DataUseNotice` rendering and `dataUseLabels` text so no new legal claims are introduced.
2. Redirect signed-in navigation to `/agreement` only while required, and resume exactly where the user was heading once they agree.
3. Let a user who is not ready decide continue immediately with new entries paused, without losing access to viewing, correcting, exporting, or deleting their data, or to turning Product Analytics off.
4. Keep `/settings`, `/admin`, and `/agreement` itself always reachable so existing data rights are never blocked by the notice.
5. Change nothing when the `Rollout_Flag` is off, or when the notice is already acknowledged or disabled for the user.

### Non-goals

- No change to the server's notice content, version, or acknowledgement endpoint.
- No change to `Quick Add`, `financialInputsEnabled` semantics beyond adding the `Not_Now_Choice` input, or any money calculation.
- No persistence of the "Not now" choice across reloads or devices.

## Architecture

### Where the pieces live

| Part | Where it lives | New or changed |
|---|---|---|
| `Not_Now_Choice` state and the redirect decision | Lifted into a small provider that wraps both `Shell` and the Agreement_Page, e.g. `AgreementGateProvider` in `frontend/src/clarity/AgreementGateProvider.tsx` | New |
| `DataUseGateProvider` | `frontend/src/clarity/DataUseGateProvider.tsx` | Unchanged; now mounted once, above both `Shell` and the Agreement_Page |
| Route guard | `frontend/src/App.tsx`, inside `Private` | Changed: adds the redirect to `/agreement` and the new route |
| Agreement_Page | `frontend/src/pages/Agreement.tsx` | New |
| Compact gate + paused banner | `frontend/src/components/clarity/DataUseGate.tsx` | Changed: drops the full notice and acknowledge button, keeps the compact "Your data" control and the paused reason, adds a link to `/agreement` |
| Full notice rendering | `frontend/src/components/clarity/DataUseNotice.tsx` | Unchanged; reused by the Agreement_Page |
| Settings paused banner | `frontend/src/pages/Settings.tsx` | Changed: adds a paused-entries banner when applicable |

### Why `DataUseGateProvider` moves up

`DataUseGateProvider` is mounted inside `Shell` today. The Agreement_Page renders outside `Shell` (no top navigation, bottom navigation, or Core Promise strip) but still needs `useAuth()` and the query client, and both `Private` and the Agreement_Page need to read the same `Data_Use_Gate` value to decide on the redirect. `DataUseGateProvider` moves to wrap `Private` in `App.tsx`, above the route that renders either `Shell` or the Agreement_Page. This is a pure relocation: the provider's internal logic, the rollout check, and its `NOOP_VALUE` for the disabled case are unchanged.

### Not_Now_Choice and the redirect decision

```typescript
// frontend/src/clarity/AgreementGateProvider.tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../state';
import { useDataUseGate } from './DataUseGateProvider';

export interface AgreementGateValue {
  /** True once the signed-in user chose "Not now, just look around" during this sign-in. */
  notNow: boolean;
  /** Records the choice. Memory only; never written to storage. */
  setNotNow: () => void;
  /**
   * True exactly when signed-in navigation to a non-exempt route should be
   * redirected to the Agreement_Page.
   */
  mustAgree: boolean;
}

const AgreementGateContext = createContext<AgreementGateValue>({
  notNow: false,
  setNotNow: () => {},
  mustAgree: false,
});

export function useAgreementGate(): AgreementGateValue {
  return useContext(AgreementGateContext);
}

export function AgreementGateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const gate = useDataUseGate();
  const [notNow, setNotNowFlag] = useState(false);
  // Resets on sign-out and on a change of signed-in user. Never reads or writes storage.
  const lastUserId = useRef(user?.id);
  useEffect(() => {
    if (lastUserId.current !== user?.id) {
      lastUserId.current = user?.id;
      setNotNowFlag(false);
    }
  }, [user?.id]);

  const setNotNow = useCallback(() => setNotNowFlag(true), []);
  const mustAgree = gate.status === 'required' && !notNow;

  return (
    <AgreementGateContext.Provider value={{ notNow, setNotNow, mustAgree }}>
      {children}
    </AgreementGateContext.Provider>
  );
}
```

`mustAgree` is `false` whenever `status` is `disabled`, `loading`, `error`, or `acknowledged` — the redirect fires only for `required`. `notNow` starts `false` on every mount, so a full page reload (a fresh mount of the whole provider tree) asks again, satisfying the "memory only, reload re-asks" requirement without any explicit reload handling.

### Routing

```typescript
// frontend/src/App.tsx (excerpt)
const EXEMPT_PATHS = ['/settings', '/agreement'];
function isExemptRoute(pathname: string): boolean {
  return EXEMPT_PATHS.includes(pathname) || pathname === '/admin' || pathname.startsWith('/admin/');
}

function Private() {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) {
    if (loc.pathname === '/') return <MarketingLanding />;
    return <Navigate to="/login" replace />;
  }
  if (user.is_admin && loc.pathname === '/' && !wantsUserView()) {
    return <Navigate to="/admin" replace />;
  }
  return <AgreementRedirect />;
}

function AgreementRedirect() {
  const loc = useLocation();
  const { mustAgree } = useAgreementGate();
  if (mustAgree && !isExemptRoute(loc.pathname)) {
    return <Navigate to="/agreement" replace state={{ from: loc }} />;
  }
  return <Shell />;
}
```

`App.tsx` wraps the `<Route element={<Private />}>` subtree's parent element with `AgreementGateProvider`, and `AgreementGateProvider` itself sits inside `DataUseGateProvider`, both now mounted once above the `<Routes>` element that contains `Private` and the `/agreement` route (added as a sibling route under the same wrapping, outside `Shell`):

```typescript
<DataUseGateProvider>
  <AgreementGateProvider>
    <Routes>
      {/* ...public routes unchanged... */}
      <Route path="/agreement" element={<RequireAuth><Agreement /></RequireAuth>} />
      <Route element={<Private />}>{/* ...existing signed-in routes... */}</Route>
    </Routes>
  </AgreementGateProvider>
</DataUseGateProvider>
```

`from` carries the `Intended_Destination` as a full `Location` (`pathname + search`), matching the shape React Router already uses for post-login redirects elsewhere in the app (`Guest` + `postAuthDestination`).

### Agreement_Page

```typescript
// frontend/src/pages/Agreement.tsx
import { useRef, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../state';
import { useDataUseGate } from '../clarity/DataUseGateProvider';
import { useAgreementGate } from '../clarity/AgreementGateProvider';
import { postAuthDestination } from '../clarity/journeys';
import { DataUseNotice } from '../components/clarity/DataUseNotice';
import { summarizeNotice } from '../clarity/dataUseLabels';

export function Agreement() {
  const { user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const gate = useDataUseGate();
  const { setNotNow } = useAgreementGate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const from = (loc.state as { from?: Location } | null)?.from;
  const fallback = postAuthDestination({ isAdmin: !!user?.is_admin, search: '', registered: false });
  const destination = from ? `${from.pathname}${from.search ?? ''}` : fallback;

  const agree = async () => {
    setAnnouncement('Saving your acknowledgement…');
    if (await gate.acknowledge()) nav(destination, { replace: true });
  };

  const notNow = () => {
    setNotNow();
    nav(destination, { replace: true });
  };

  // ...heading with ref, summary, expander, analytics toggle, /terms + /privacy links,
  // primary and secondary controls, status/alert regions — see Components below.
}
```

`summarizeNotice(notice)` is a new small pure function in `dataUseLabels.ts` that builds the short plain-language summary (data categories in one sentence, sharing default, retention, and the controls list) strictly from `settings.dataUseNotice` fields, using the same label lookups `DataUseNotice` already uses. It introduces no new wording that isn't already a label for existing server keys.

## Components and Interfaces

### `Agreement` page regions

- **Heading** (`<h1>`, `tabIndex={-1}`, focused on mount): "Review how Project Money uses your data".
- **Status region** (`role="status"`, `aria-live="polite"`): shows "Checking your data-use settings." while `gate.status === 'loading'`, and the in-progress / success announcements for "I agree and continue".
- **Error region** (`role="alert"`): shown when `gate.status === 'error'` (with a "Retry" button calling `gate.retry()`) or when `gate.acknowledgeError` is set (with a "Try again" affordance that re-enables "I agree and continue").
- **Summary**: `summarizeNotice(notice)` output, rendered as plain text, only when `notice` is available (`gate.status === 'required'`).
- **"Read full details" expander**: a disclosure button (`aria-expanded`, `aria-controls`) that reveals `<DataUseNotice notice={notice} />` when opened. Collapsed by default, so the page opens at the short summary.
- **Product Analytics toggle**: rendered only `WHERE notice.controls.productAnalytics.available` (via `gate.settings?.productAnalytics`), wired to `gate.setAnalytics` exactly as `AnalyticsControl` on Settings is, so both controls reflect one shared setting.
- **Legal links**: `<Link to="/terms">` and `<Link to="/privacy">`.
- **Primary control**: "I agree and continue" button, `min-height: 44px; min-width: 44px` via a shared `.btn-primary-lg` class, `aria-disabled` while `gate.acknowledging`, calling `agree()`.
- **Secondary control**: "Not now, just look around" link/button, calling `notNow()`. Always enabled, even while `gate.acknowledging`.

### `DataUseGate` (compact control), changed

`DataUseGate` keeps:
- The `status === 'disabled'` early return.
- The collapsed "Your data" toggle once `status === 'acknowledged' && !reason`.
- The `status === 'acknowledged'` disclosure that re-opens `DataUseNotice` (`DATA_USE_NOTICE_REVIEW_ID`), unchanged, so the existing Quick Add shortcut key check is unaffected.
- The `gate.reason` paused block (`DATA_USE_REASON_ID`) and the Product Analytics toggle, unchanged in markup and ids.

`DataUseGate` drops:
- The `status === 'required'` branch that rendered the full `DataUseNotice` and the "I have read this. Acknowledge version N" button. In its place, while `status === 'required'`, `DataUseGate` renders a short line ("Review and agree to the data-use notice to add new financial entries.") with a `<Link to="/agreement">` and, when `useAgreementGate().notNow` is true, the existing paused-entries reason block, unchanged, still keyed by `DATA_USE_REASON_ID`.

This keeps every page that asserts `DATA_USE_REASON_ID` as an `aria-describedby` target working unchanged, since that id and its presence condition (`gate.reason` truthy) do not change — only the content inside the formerly-`required` branch above it changes.

### `Settings` page, changed

Adds one line, rendered only `WHILE useAgreementGate().notNow && gate.status === 'required'`, immediately above the existing settings cards:

```tsx
{notNow && gate.status === 'required' && (
  <div className="clarity-gate-paused" aria-describedby={DATA_USE_REASON_ID}>
    New entries are paused. <Link to="/agreement">Review the data-use notice</Link> to turn them back on.
    Exporting, correcting, and deleting your data stay available below.
  </div>
)}
```

### `financialInputsEnabled`, changed

`DataUseGateProvider`'s derived `financialInputsEnabled` does not change: it is already `false` whenever `status !== 'acknowledged'`, which already covers `required` regardless of `Not_Now_Choice`. No change to `DataUseGateProvider.tsx` is needed for Paused_Entries to apply; `Not_Now_Choice` only changes whether the redirect fires, not whether entries are enabled.

## Data Models

No new server data model. The only new client-side type is the `AgreementGateValue` shown above, and the pure summary type:

```typescript
// frontend/src/clarity/dataUseLabels.ts (addition)
export interface NoticeSummary {
  categoriesSentence: string;
  sharingSentence: string;
  retentionSentence: string;
  controlsSentence: string;
}

export function summarizeNotice(notice: DataUseNoticeContent): NoticeSummary {
  // Built only from categoryLabel, sharingLabel, retentionLabel, and notice.controls,
  // the same lookups DataUseNotice.tsx already uses. No new claims.
}
```

## Error Handling

- **Settings query fails** (`status === 'error'`): Agreement_Page shows the retry control; it does not redirect away from itself (it is an Exempt_Route) and `AgreementGateProvider.mustAgree` is `false` for `error`, so no other route redirects either.
- **Acknowledge request fails**: `gate.acknowledgeError` is shown in the alert region; the button is re-enabled; no navigation occurs.
- **Analytics toggle request fails**: identical to the existing `AnalyticsControl` error handling, reusing `gate.analyticsError`.
- **User is admin and lands on `/agreement` with no `from`**: falls back to `/admin` via `postAuthDestination({ isAdmin: true, ... })`, matching existing post-login behavior.

## Accessibility and Responsive Interface Contract

- Heading receives focus on mount (`tabIndex={-1}`, `ref.current.focus()` in a `useEffect`).
- All transient messages use `role="status"` (informational) or `role="alert"` (error) regions, matching the pattern already used in `DataUseGate` and `AnalyticsControl`.
- The primary control has a minimum 44×44 CSS pixel hit area via a shared class, consistent with existing `.btn.primary` sizing conventions in the app's `clarity.css`.
- Layout uses the same fluid, `clamp()`-based type scale and CSS custom properties (`--text`, `--muted`, `--border`, `--glass`, `--radius`) as `dataUse.css`, so it inherits the existing 320–3840px and 200%-zoom behavior, and both themes, without new breakpoints.
- Motion: the page mounts without `framer-motion`'s route-transition wrapper (it is outside `Shell`'s `AnimatePresence`), so there is no motion to suppress; any internal disclosure animation (the "Read full details" expander) follows the existing `prefers-reduced-motion` handling pattern used elsewhere (CSS transition disabled under `@media (prefers-reduced-motion: reduce)`).
- No `sessionStorage`, `localStorage`, or `console` call is added anywhere in this feature; `Not_Now_Choice` is `useState` only.
- No new `measurement.*` event name is introduced; the existing analytics consent and event vocabulary (`AnalyticsControl`'s toggle calls `gate.setAnalytics`, which is unchanged) is reused as-is.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: The redirect decision is exactly `required AND not exempt AND not Not_Now_Choice AND rollout enabled`

For any combination of `Data_Use_Gate.status` (`disabled`, `loading`, `error`, `required`, `acknowledged`), any pathname, and any `Not_Now_Choice` value, `AgreementRedirect` renders the Agreement_Page if and only if `status === 'required'`, the pathname is not an Exempt_Route, and `Not_Now_Choice` is `false`; in every other combination it renders `Shell` unchanged.

**Validates: Requirements 1.1, 3.2, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2**

### Property 2: The Agreement_Page always exposes its required elements

For any `ClaritySettings` value with `dataUseNotice.acknowledgementRequired === true`, rendering the Agreement_Page always produces a summary derived from that notice, a "Read full details" control, a `/terms` link, a `/privacy` link, a primary "I agree and continue" control, and a secondary "Not now, just look around" control.

**Validates: Requirements 1.2**

### Property 3: "Read full details" always reveals the complete notice

For any `DataUseNoticeContent` value, activating "Read full details" on the Agreement_Page always renders the same category, sharing, retention, and controls content that `DataUseNotice` renders directly for that value.

**Validates: Requirements 1.3**

### Property 4: Agreeing navigates to the recorded Intended_Destination

For any non-empty pathname and search string recorded as `from`, a successful "I agree and continue" always navigates to that exact pathname and search, and a failed attempt never navigates away from the Agreement_Page.

**Validates: Requirements 2.1, 2.4**

### Property 5: The no-destination fallback matches the existing post-login target

For any combination of `isAdmin` and rollout state, reaching the Agreement_Page with no recorded `from` and agreeing navigates to the same target that `postAuthDestination({ isAdmin, search: '', registered: false })` already returns for that combination.

**Validates: Requirements 2.2**

### Property 6: "Not now" navigates to the recorded Intended_Destination and sets the choice

For any non-empty pathname and search string recorded as `from`, activating "Not now, just look around" always navigates to that exact pathname and search and leaves `Not_Now_Choice` true for the remainder of the sign-in.

**Validates: Requirements 3.1**

### Property 7: Entries are never enabled while the notice is required

For any `Not_Now_Choice` value and any `Data_Use_Gate.status`, `financialInputsEnabled` is `false` whenever `status === 'required'`, independent of `Not_Now_Choice`.

**Validates: Requirements 3.4**

### Property 8: `Not_Now_Choice` is reset exactly on a user change

For any sequence of actions drawn from {sign in as user A, set Not_Now_Choice, sign in as user B, sign out}, `Not_Now_Choice` is `false` immediately after any action that changes or clears the signed-in user, and is unaffected by any action that does not.

**Validates: Requirements 3.6, 3.7**

### Property 9: No interaction with this feature writes to persistent storage or the console

For any sequence of interactions with the Agreement_Page and the compact `DataUseGate` (agree, not-now, toggle analytics, retry, expand details) drawn from a generated sequence, no call to `sessionStorage`, `localStorage`, or `console.*` attributable to this feature occurs.

**Validates: Requirements 3.5, 8.5**

### Property 10: The paused-entries explanation always links to the Agreement_Page

For any `ClaritySettings` and `DataUseGateStatus` combination for which `gate.reason` is non-null while `Not_Now_Choice` is true, the rendered compact `DataUseGate` contains a link to `/agreement` alongside the existing reason text keyed by `DATA_USE_REASON_ID`.

**Validates: Requirements 4.1**

### Property 11: Every message the Agreement_Page shows uses the correct live region role

For each of the Agreement_Page's message-producing states (checking settings, acknowledging, acknowledge failed, settings failed to load, analytics change failed), the rendered region's role is `status` for informational messages and `alert` for error messages.

**Validates: Requirements 8.4**

## Testing Strategy

Unit and component tests (Vitest + Testing Library) cover the Agreement_Page, the changed `DataUseGate`, the changed `Settings` banner, and `AgreementGateProvider` in isolation, using the existing `settingsMemoryServer.ts`, `dataUseFixtures.ts`, and `claritySettingsBuilder.ts` test helpers. Property tests use `fast-check`, following the existing `propertyTestParameters` (100 runs) convention in `frontend/src/test/test-utils.tsx`.

Example-based and integration tests cover: focus-on-mount, the 44×44 control size (a DOM/layout assertion), the Settings banner's fixed content, the reduced-motion disclosure, and a source-scan test asserting no new `measurement.*` event name is introduced. End-to-end (Playwright) tests update the existing clarity and quick-add specs that assert on the old expanded card (`e2e/acceptance.clarity.spec.ts`, `e2e/top-navigation.clarity.spec.ts`, `e2e/journey.clarity.spec.ts`, `e2e/rollout-rollback.spec.ts`, `e2e/a11y-*.clarity.spec.ts`, `e2e/responsive.clarity.spec.ts`, and the quick-add Playwright config/fixtures) to navigate through `/agreement` instead of acknowledging inline, and add new coverage for the redirect, the Exempt_Route list, and the "Not now" escape at 320px, 3840px, and 200% zoom in both themes.
