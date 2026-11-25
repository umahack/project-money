# Implementation Plan: Data Use Agreement Page

## Overview

This plan replaces the inline full data-use notice with a dedicated `/agreement` page, reusing the existing `DataUseGateProvider`, `DataUseNotice`, and `dataUseLabels` without introducing any backend or legal-content change. It starts by lifting `DataUseGateProvider` and adding the new in-memory `AgreementGateProvider`, then wires the route guard and the Agreement page, then trims `DataUseGate` to its compact form, then adds the Settings paused banner, and finishes by updating the existing tests and end-to-end specs that assert on the old expanded card. Every property from the design's Correctness Properties section is implemented as a required property test alongside the code it covers, so no test task is marked optional. No task deploys, runs a dev server, or touches production data.

## Tasks

- [x] 1. Lift the data-use gate and add the agreement gate provider
  - [x] 1.1 Move `DataUseGateProvider` out of `Shell` and into `App.tsx`
    - In `frontend/src/App.tsx`, wrap the `<Routes>` element with `<DataUseGateProvider>`, and remove the `<DataUseGateProvider>` wrapping from `frontend/src/components/Shell.tsx`'s `Shell()` return value, keeping every other line of `Shell` unchanged.
    - _Requirements: 1.5, 6.4_

  - [x] 1.2 Add `AgreementGateProvider`
    - Create `frontend/src/clarity/AgreementGateProvider.tsx` with `AgreementGateValue` (`notNow`, `setNotNow`, `mustAgree`), `useAgreementGate()`, and `AgreementGateProvider`, exactly as designed: `useState` only, a `useEffect` keyed on `user?.id` that resets `notNow` to `false` on any user-id change, and `mustAgree = gate.status === 'required' && !notNow`.
    - Mount `AgreementGateProvider` in `App.tsx` directly inside `DataUseGateProvider`, wrapping the same `<Routes>` element.
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7_

  - [x] 1.3 Write the property test for the user-change reset
    - **Property 8: `Not_Now_Choice` is reset exactly on a user change**
    - Generate sequences of {sign in as user A, set Not_Now_Choice, sign in as user B, sign out} and assert `notNow` is `false` immediately after any user-changing action and unaffected by any other action.
    - Run it through `assertProperty` from `frontend/src/test/propertyReport.ts` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 8: Not_Now_Choice is reset exactly on a user change`.
    - **Validates: Requirements 3.6, 3.7**

  - [x] 1.4 Write the property test for entries never enabled while required
    - **Property 7: Entries are never enabled while the notice is required**
    - Generate every `(status, notNow)` combination and assert `DataUseGateProvider`'s `financialInputsEnabled` is `false` whenever `status === 'required'`, independent of `notNow`, reusing `claritySettingsBuilder.ts`.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 7: Entries are never enabled while the notice is required`.
    - **Validates: Requirements 3.4**

- [x] 2. Add the Exempt_Route redirect guard
  - [x] 2.1 Implement `isExemptRoute` and `AgreementRedirect`
    - In `frontend/src/App.tsx`, add `isExemptRoute(pathname)` matching `/settings`, `/agreement`, `/admin`, and every path starting with `/admin/`, and an `AgreementRedirect` component that reads `useAgreementGate().mustAgree` and the current location, rendering `<Navigate to="/agreement" replace state={{ from: loc }} />` when `mustAgree` is true and the path is not exempt, and `<Shell />` otherwise.
    - Update `Private` to render `AgreementRedirect` instead of `<Shell />` for the signed-in, non-admin-default case, keeping the existing marketing-landing and admin-default branches unchanged.
    - _Requirements: 1.1, 5.1, 5.2, 5.3, 6.2, 6.3, 7.1, 7.2_

  - [x] 2.2 Write the property test for the redirect decision
    - **Property 1: The redirect decision is exactly `required AND not exempt AND not Not_Now_Choice AND rollout enabled`**
    - Generate every `(status, pathname, notNow, rolloutEnabled)` combination, including exempt and non-exempt pathnames, and assert `AgreementRedirect` renders the Agreement_Page if and only if `status === 'required' && !exempt(pathname) && !notNow` (and the provider tree reports `disabled` whenever `rolloutEnabled` is false).
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 1: The redirect decision is exactly required AND not exempt AND not Not_Now_Choice AND rollout enabled`.
    - **Validates: Requirements 1.1, 3.2, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2**

  - [x] 2.3 Write example tests for the rollout-off and acknowledged/disabled cases
    - Assert that with the Rollout_Flag off no route ever renders the Agreement_Page and `/agreement` itself is reachable only in a disabled no-op state consistent with the rest of the application; assert that `status === 'acknowledged'` and `status === 'disabled'` never redirect.
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 3. Build the Agreement page
  - [x] 3.1 Add `summarizeNotice` to `dataUseLabels.ts`
    - Add the `NoticeSummary` type and `summarizeNotice(notice: DataUseNoticeContent): NoticeSummary`, built only from `categoryLabel`, `sharingLabel`, `retentionLabel`, and `notice.controls`, with no text beyond what `DataUseNotice.tsx` already renders for the same fields.
    - _Requirements: 1.2_

  - [x] 3.2 Create `frontend/src/pages/Agreement.tsx`
    - Implement the heading (focused on mount), the status (`role="status"`) and error (`role="alert"`) regions, the `summarizeNotice` summary, the "Read full details" disclosure wrapping `<DataUseNotice notice={notice} />`, the Product Analytics toggle wired to `gate.setAnalytics` (rendered only where `productAnalytics.available`), the `/terms` and `/privacy` links, and the primary "I agree and continue" and secondary "Not now, just look around" controls as designed, including the `from`-based destination and the `postAuthDestination` fallback.
    - Give "I agree and continue" a minimum 44×44 CSS pixel hit area via a shared class.
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 7.3, 7.4, 8.4_

  - [x] 3.3 Register the `/agreement` route
    - In `frontend/src/App.tsx`, add `<Route path="/agreement" element={<RequireAuth><Agreement /></RequireAuth>} />` (or the equivalent existing auth-guard pattern) as a sibling of the `Private`-guarded route tree, outside `Shell`.
    - _Requirements: 1.1, 1.5, 6.1_

  - [x] 3.4 Write the property test for the Agreement page's required elements
    - **Property 2: The Agreement_Page always exposes its required elements**
    - Generate `ClaritySettings` values with `dataUseNotice.acknowledgementRequired === true` using `claritySettingsBuilder.ts` and assert the summary, "Read full details" control, `/terms` link, `/privacy` link, primary control, and secondary control are always present.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 2: The Agreement_Page always exposes its required elements`.
    - **Validates: Requirements 1.2**

  - [x] 3.5 Write the property test for "Read full details"
    - **Property 3: "Read full details" always reveals the complete notice**
    - Generate `DataUseNoticeContent` values and assert that opening the expander on the Agreement page renders the same category, sharing, retention, and controls content `DataUseNotice` renders directly for the same value.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 3: "Read full details" always reveals the complete notice`.
    - **Validates: Requirements 1.3**

  - [x] 3.6 Write the property test for agreeing to the recorded destination
    - **Property 4: Agreeing navigates to the recorded Intended_Destination**
    - Generate non-empty pathname and search pairs as `from`, assert a successful "I agree and continue" always navigates to that exact value, and assert a failed attempt never navigates away from the Agreement_Page.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 4: Agreeing navigates to the recorded Intended_Destination`.
    - **Validates: Requirements 2.1, 2.4**

  - [x] 3.7 Write the property test for the no-destination fallback
    - **Property 5: The no-destination fallback matches the existing post-login target**
    - Generate every `(isAdmin, rolloutEnabled)` combination, reach the Agreement page with no `from`, agree, and assert the navigation target equals `postAuthDestination({ isAdmin, search: '', registered: false })` for the same combination.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 5: The no-destination fallback matches the existing post-login target`.
    - **Validates: Requirements 2.2**

  - [x] 3.8 Write the property test for "Not now"
    - **Property 6: "Not now" navigates to the recorded Intended_Destination and sets the choice**
    - Generate non-empty pathname and search pairs as `from`, assert "Not now, just look around" always navigates to that exact value and leaves `notNow` true afterward.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 6: "Not now" navigates to the recorded Intended_Destination and sets the choice`.
    - **Validates: Requirements 3.1**

  - [x] 3.9 Write example tests for loading, error, and sizing
    - Cover: focus moves to the heading on mount; `status === 'loading'` shows the polite checking message; `status === 'error'` shows the retry control and does not navigate away; the primary control's rendered hit area is at least 44×44 CSS pixels; `gate.acknowledging` disables and announces progress on the primary control.
    - _Requirements: 1.6, 2.3, 2.5, 7.3, 7.4_

- [x] 4. Checkpoint - Ensure the agreement page and routing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Trim `DataUseGate` to its compact form and add the paused-entries link
  - [x] 5.1 Remove the `required`-branch full notice and acknowledge button from `DataUseGate`
    - In `frontend/src/components/clarity/DataUseGate.tsx`, delete the `status === 'required'` block that rendered `<DataUseNotice>` and the "I have read this. Acknowledge version N" button, and the `acknowledge()` handler and its `headingRef`/`focusToggle` wiring that existed only to support it. Keep the `disabled` early return, the collapsed "Your data" toggle, the `acknowledged` disclosure (`DATA_USE_NOTICE_REVIEW_ID`), the `gate.reason` paused block (`DATA_USE_REASON_ID`), and the Product Analytics toggle exactly as they are.
    - In the same place the `required` block was, render a short line reading "Review and agree to the data-use notice to add new financial entries." with a `<Link to="/agreement">`, shown whenever `status === 'required'`.
    - _Requirements: 4.1, 4.3_

  - [x] 5.2 Write the property test for the paused-entries link
    - **Property 10: The paused-entries explanation always links to the Agreement_Page**
    - Generate `ClaritySettings` and `DataUseGateStatus` combinations for which `gate.reason` is non-null while `notNow` is true, and assert the rendered compact `DataUseGate` always contains a link to `/agreement` alongside the `DATA_USE_REASON_ID` reason text.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 10: The paused-entries explanation always links to the Agreement_Page`.
    - **Validates: Requirements 4.1**

  - [x] 5.3 Update existing `DataUseGate` tests for the trimmed markup
    - Update `frontend/src/components/clarity/dataUseGate.test.tsx` so assertions about the full notice and the "I have read this…" button move to the new `Agreement.tsx` tests, while the `DATA_USE_REASON_ID` association, the collapsed control, and the analytics toggle assertions remain against `DataUseGate`.
    - _Requirements: 4.1, 4.3_

- [x] 6. Add the Settings paused-entries banner
  - [x] 6.1 Render the banner in `Settings.tsx`
    - In `frontend/src/pages/Settings.tsx`, render the paused-entries banner (linking to `/agreement`, keyed by `DATA_USE_REASON_ID`) only `WHILE useAgreementGate().notNow && gate.status === 'required'`, above the existing settings cards, with no change to `ExportData`, `DangerZone`, `AnalyticsControl`, or `CategoryMemoryPanel`.
    - _Requirements: 4.2, 5.4_

  - [x] 6.2 Write example tests for the Settings banner and the always-reachable controls
    - Assert the banner renders only in the paused, required, not-now state and links to `/agreement`; assert `ExportData`, `DangerZone`, and the Product Analytics opt-out stay enabled regardless of `status`.
    - _Requirements: 4.2, 5.4_

- [x] 7. Checkpoint - Ensure the compact gate and Settings tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Cover storage, console, and messaging guarantees
  - [x] 8.1 Write the property test for no persistent storage or console writes
    - **Property 9: No interaction with this feature writes to persistent storage or the console**
    - Generate interaction sequences over the Agreement page and the compact `DataUseGate` (agree, not-now, toggle analytics, retry, expand details), spy on `sessionStorage`, `localStorage`, and `console.*`, and assert no call attributable to this feature occurs.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 9: No interaction with this feature writes to persistent storage or the console`.
    - **Validates: Requirements 3.5, 8.5**

  - [x] 8.2 Write the property test for live-region roles
    - **Property 11: Every message the Agreement_Page shows uses the correct live region role**
    - Drive the Agreement page through each message-producing state (checking settings, acknowledging, acknowledge failed, settings failed to load, analytics change failed), drawn with `fc.constantFrom` over those states, and assert the rendered region's role is `status` for informational messages and `alert` for error messages.
    - Run it through `assertProperty` (at least 100 generated cases) and add the comment `Feature: data-use-agreement-page, Property 11: Every message the Agreement_Page shows uses the correct live region role`.
    - **Validates: Requirements 8.4**

  - [x] 8.3 Write the reduced-motion example test and the analytics-event source scan
    - Assert the "Read full details" disclosure has no animated transition under a simulated `prefers-reduced-motion: reduce`; add a source-scan test asserting no new `measurement.*` event name appears anywhere in the diff introduced by this feature.
    - _Requirements: 8.3, 8.6_

- [x] 9. Update end-to-end and integration coverage for the moved notice
  - [x] 9.1 Update Shell and Quick Add component tests
    - Update `frontend/src/components/Shell.quickAdd.test.tsx`, `Shell.quickAddHost.test.tsx`, `frontend/src/components/quickAdd/quickAddFlows.test.tsx`, and `frontend/src/App.quickAddRollout.test.tsx` so acknowledgement now happens by navigating to `/agreement` instead of finding the inline "Acknowledge version N" button, keeping `PROMISE_RENDERED_KEY` behavior unchanged.
    - _Requirements: 1.1, 2.1, 6.4_

  - [x] 9.2 Update accessibility, responsive, journey, and rollback end-to-end specs
    - Update `e2e/acceptance.clarity.spec.ts`, `e2e/top-navigation.clarity.spec.ts`, `e2e/a11y-*.clarity.spec.ts`, `e2e/responsive.clarity.spec.ts`, `e2e/journey.clarity.spec.ts`, and `e2e/rollout-rollback.spec.ts` to reach the notice through `/agreement`, and the helpers `e2e/helpers/a11y.ts`, `e2e/helpers/layout.ts`, `e2e/helpers/clarityApi.ts`, and `e2e/helpers/clarityScenarios.ts` to drive the new page.
    - Add new end-to-end coverage for: the redirect to `/agreement` for a user who must agree, `/settings` and `/admin` staying reachable without redirecting, the "Not now" escape leaving entries paused until a reload, and the Agreement page's layout at 320px, 3840px, and 200% zoom in both themes.
    - _Requirements: 1.1, 3.1, 3.2, 3.7, 5.1, 5.2, 5.3, 8.1, 8.2_

  - [x] 9.3 Update the Quick Add Playwright fixtures
    - Update `frontend/playwright.quickadd.config.ts` and `frontend/e2e/helpers/quickAddWorld.ts` so any fixture that expects the old inline expanded card instead reaches acknowledgement through `/agreement`.
    - _Requirements: 1.1, 6.4_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- The implementation language is TypeScript/TSX in the existing `frontend/` package, matching the repository and the completed design.
- All test tasks are required, including property tests, example tests, and end-to-end updates. No task is marked optional, because this feature changes a privacy-affecting gate and the redirect behavior around it, and the owner wants every test run.
- Property tasks are required and each maps one-to-one to a numbered property in `design.md`'s Correctness Properties section, Properties 1 through 11. Each runs through the `assertProperty` helper in `frontend/src/test/propertyReport.ts` with at least 100 generated cases, and carries the comment `Feature: data-use-agreement-page, Property <number>: <property title>`.
- No task deploys, starts a development server, or modifies production data; browser-based tests use the existing isolated fixtures and fake backends (`settingsMemoryServer.ts`, `dataUseFixtures.ts`, `claritySettingsBuilder.ts`, `fakeClarityBackend.ts`).
- This feature makes no backend, schema, or contract change; no backend task is included.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9"] },
    { "id": 4, "tasks": ["4"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.1"] },
    { "id": 7, "tasks": ["6.2"] },
    { "id": 8, "tasks": ["7"] },
    { "id": 9, "tasks": ["8.1", "8.2", "8.3", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3"] },
    { "id": 11, "tasks": ["10"] }
  ]
}
```
