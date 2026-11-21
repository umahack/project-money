# Implementation Plan: Financial Clarity Experience

## Overview

This plan incrementally adds the Financial Clarity Experience to the existing JavaScript Express/libSQL backend and TypeScript React/Vite frontend. It establishes automated test foundations first, introduces integer-paise domain calculations and additive persistence without rewriting existing records, preserves legacy API and public-trip behavior during rollout, and then migrates Home, Plan, Spending, Goals, Trips, and the guided journey to canonical server-owned outcomes and scoped client mutations.

Every implementation step produces integrated code or automated tests. Required tests are not marked optional because safe migration, privacy, accessibility, and calculation correctness depend on them. No unrelated or genuinely deferrable enhancements are included.

## Tasks

- [x] 1. Establish automated test and compatibility foundations
  - [x] 1.1 Add the backend unit, property, and API test harness
    - Add `node:test` scripts and development dependencies for `fast-check` and `supertest` in `backend/package.json`.
    - Create isolated test-database and clock/time-zone helpers that cannot use production Turso credentials, and make the Express app importable without starting a listener.
    - Provide deterministic fixture builders for users, sessions, financial records, trips, and legacy rows.
    - _Requirements: 4.1, 5.1, 6.6, 7.1, 10.11, 11.12, 13.1_

  - [x] 1.2 Add the frontend unit, component, accessibility, and property test harness
    - Configure Vitest with jsdom, React Testing Library, `@testing-library/user-event`, `fast-check`, `axe-core`, and `vitest-axe` in `frontend`.
    - Add reusable authenticated-provider, router, query-client, fake-clock, and API-response render helpers.
    - Add non-watch `test` and `test:coverage` scripts alongside the existing build and typecheck scripts.
    - _Requirements: 10.1, 10.6, 12.2, 12.3, 12.4, 12.5, 12.15, 12.16_

  - [x] 1.3 Add the browser acceptance and responsive test harness
    - Configure Playwright with deterministic API fixtures and projects for 320, 360, 375, 390, 768, 820, 899, 1024, 1440, and 3840 CSS-pixel widths.
    - Add helpers for document identity, `window.location.reload` spying, focus tracking, reduced-motion emulation, overflow/clipping checks, and response-to-paint timing.
    - Keep browser tests isolated from production credentials, public links, and data.
    - _Requirements: 10.1, 10.6, 10.8, 12.3, 12.4, 12.5, 12.7, 12.8, 12.9_

  - [x] 1.4 Characterize legacy calculations and public/private contracts before migration
    - Add fixtures around `/api/finance/plan`, salary, bills, expenses, goals, authenticated trip detail, `GET /api/public/trips/:token`, and `monthlyReview.js`.
    - Capture existing top-level response fields, authorization failures, disabled-token 404 behavior, and representative empty/equal/excess/month-boundary records without snapshotting secrets or financial values in logs.
    - Add a browser characterization that demonstrates the current Plan reload and broad-loading/refetch paths so their later removal is measurable.
    - _Requirements: 4.2, 4.3, 4.4, 5.1, 6.10, 7.5, 7.15, 10.2, 10.8, 11.10, 11.11_

- [x] 2. Implement canonical money and monthly-plan calculations
  - [x] 2.1 Create integer-paise money parsing, validation, formatting metadata, and rounding primitives
    - Add `backend/src/domain/money.js` with decimal-string-to-paise parsing, safe-integer validation, exact sums, half-up division, ceiling division, and remainder adjustment.
    - Reject unsafe legacy numeric values at the calculation boundary without changing stored source rows.
    - Return precision and rounding metadata required by explanations; do not use database floating-point sums as canonical inputs.
    - _Requirements: 4.7, 4.8, 4.11, 6.9, 7.3, 7.4, 9.5_

  - [x] 2.2 Implement the pure monthly-plan calculator and transition deltas
    - Add `backend/src/domain/monthlyPlan.js` for exact-month salary and active-bill filtering, disposable income, shortfall, conserved 50/30/20 allocation, spendable budget, remaining spendable, inclusive-days daily guide, projected savings, and preceding-to-new deltas.
    - Inject local date and `Asia/Kolkata` rather than reading the process clock inside domain logic.
    - Emit ordered source and operation records for salary, bills, allocation, expenses, and daily guide.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.17, 5.6, 5.7, 5.8_

  - [x] 2.3 Write the property test for conserved monthly allocation
    - **Property 1: Monthly allocation is bounded and conserved**
    - Generate safe salaries, active/inactive bills, empty sets, equal totals, and over-salary totals for at least 100 cases.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9**

  - [x] 2.4 Write the property test for month isolation and explicit salary application
    - **Property 2: Monthly records are period-isolated**
    - Generate target and non-target records, then verify non-target changes are inert and an explicit copy affects only the target month.
    - **Validates: Requirements 4.14, 4.15, 4.16, 5.12, 5.13, 5.14**

  - [x] 2.5 Write the property test for canonical spending guidance formulas
    - **Property 3: Spending guidance follows the canonical formulas**
    - Compare remaining spendable, inclusive-day daily guide, and projected savings with an independent integer reference model.
    - **Validates: Requirements 4.10, 4.11, 5.6, 5.7, 5.8**

  - [x] 2.6 Write the property test for plan deltas and explanation order
    - **Property 4: Plan transitions report exact outcome deltas**
    - Generate preceding/resulting salary and bill states and verify exact deltas plus the required calculation-step order.
    - **Validates: Requirements 4.12, 4.13, 4.17**

- [x] 3. Add persistence, transaction, and repository boundaries safely
  - [x] 3.1 Add idempotent, additive schema migrations without rewriting existing records
    - Extend `backend/src/db/index.js` with bill activity/effective-month fields, `updated_at` fields, `user_financial_state`, `guided_journeys`, category treatments, trip personal links, financial change receipts, product events, and metric reports.
    - Preserve existing bills as active and open-ended, preserve existing public tokens, and add indexes and fixed-value constraints from the design.
    - Keep migrations probe-and-add/idempotent so a pre-feature database and a current database both initialize safely.
    - _Requirements: 4.15, 4.16, 5.11, 7.12, 7.13, 7.14, 11.6, 11.8, 13.20, 13.32_

  - [x] 3.2 Add a narrow transactional batch API to the libSQL adapter
    - Extend the existing `prepare/get/all/run` wrapper with write batches that commit all statements or none and normalize constraint failures consistently.
    - Support injected statement failure in tests and avoid exposing the raw client to routes.
    - Use the wrapper as the only persistence primitive for linked source rows, receipts, and version increments.
    - _Requirements: 3.15, 5.2, 5.3, 5.4, 6.13, 7.13, 7.14, 10.11, 11.8, 11.9_

  - [x] 3.3 Create financial, journey, and measurement repositories
    - Add repository modules that scope every private record lookup by `user_id`, retain existing trip owner/member checks, load exact periods, and convert each stored amount to paise before aggregation.
    - Add monotonic user `data_version`, trip version, fixed journey-step persistence, consent state, report checkpoint, and outage-source accessors.
    - Return explicit confirmed-empty collections instead of conflating empty and unavailable data.
    - _Requirements: 3.9, 3.10, 4.2, 4.14, 5.1, 7.5, 8.1, 9.2, 11.12, 13.30_

  - [x] 3.4 Test migration idempotency and legacy-row preservation
    - Initialize from a pre-feature schema, seed legacy bills, goals, malformed trip splits, timestamps, and public tokens, and run migrations twice.
    - Assert row counts and source values are unchanged, null bill bounds remain open-ended, and invalid legacy records remain exportable/correctable rather than silently normalized.
    - _Requirements: 4.2, 6.5, 7.17, 9.7, 11.5, 11.6_

  - [x] 3.5 Test transactional batch rollback and version atomicity
    - Inject failures at each batch position and verify source writes, linked rows, receipts, and version increments commit together or all roll back.
    - Verify concurrent version updates are monotonic and no partial account-deletion or personal-link state remains.
    - _Requirements: 3.15, 6.13, 7.13, 7.14, 10.11, 11.9_

- [x] 4. Implement expense, goal, and trip domain calculators
  - [x] 4.1 Implement immutable expense transitions and category treatment
    - Add `backend/src/domain/expenses.js` with create, update, move, delete, exact category totals, default Needs/Wants mapping, user overrides, and exceeded-bucket actions.
    - Model updates as removal of the original record ID followed by insertion of the confirmed result so both affected partitions recalculate exactly once.
    - Keep total spending and projected savings independent of Needs/Wants reclassification.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14_

  - [x] 4.2 Write the property test for expense transition reference-ledger equivalence
    - **Property 5: Expense transitions match a simple reference ledger**
    - Generate create/update/month/category moves and compare every affected partition with an independent map-by-ID ledger.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5**

  - [x] 4.3 Write the property test for idempotent expense deletion
    - **Property 6: Expense deletion is an idempotent inverse**
    - Verify delete and replay remove one record once and that create-then-delete restores the original canonical ledger.
    - **Validates: Requirements 5.4, 5.13, 5.14**

  - [x] 4.4 Write the property test for category reclassification conservation
    - **Property 7: Category reclassification conserves total spending**
    - Verify only Needs/Wants buckets move, total/projected spending stays fixed, and exceeded actions appear only with their exact excess.
    - **Validates: Requirements 5.9, 5.10, 5.11**

  - [x] 4.5 Implement strict goal validation, contributions, feasibility, and revisions
    - Add `backend/src/domain/goals.js` for nonblank names, amount/date bounds, funding gap, inclusive month opportunities, upward-rounded required contribution, funded/overdue states, and savings-target feasibility.
    - Produce one recomputed target amount or date for infeasible goals and identify the minimum missing monthly-plan input when feasibility is unavailable.
    - Keep invalid drafts separate from the preceding confirmed goal.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 6.15, 6.16, 6.17, 6.18, 6.19, 6.20_

  - [x] 4.6 Write the property test for goal gap, opportunity, and contribution calculations
    - **Property 8: Goal gap, opportunities, and required contribution are valid**
    - Generate valid and boundary goal dates/amounts and verify funded, active, and overdue postconditions.
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.19, 6.20**

  - [x] 4.7 Write the property test for bounded exactly-once goal contributions
    - **Property 9: Goal contribution is bounded and exactly once**
    - Verify dynamic bounds, rejected-state preservation, and idempotent replay against the current gap.
    - **Validates: Requirements 6.5, 6.11, 6.12, 6.13**

  - [x] 4.8 Write the property test for goal feasibility and proposed revisions
    - **Property 10: Goal feasibility and revision are internally consistent**
    - Recalculate every proposed revision and verify it fits the available savings target; verify missing plan inputs remain explicit.
    - **Validates: Requirements 6.14, 6.15, 6.16, 6.17, 6.18**

  - [x] 4.9 Implement canonical trip allocation, balance, settlement, and invalid-draft handling
    - Add `backend/src/domain/trips.js` using member IDs/order, integer-paise weighted allocation, deterministic remainder adjustment, zero-sum balances, and deterministic settlement transfers.
    - Represent shared expenses and settlement payments explicitly while preserving the existing stored payer-name and split JSON compatibility boundary.
    - Retain last confirmed outcomes for invalid/incomplete drafts and emit complete explanation operations and rounding adjustments.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.16, 7.17, 7.18_

  - [x] 4.10 Write the property test for deterministic trip allocation conservation
    - **Property 11: Trip allocation conserves each expense deterministically**
    - Generate ordered members and valid weights, then verify nonnegative shares, exact sums, half-up initial rounding, and stable one-paise adjustments.
    - **Validates: Requirements 7.1, 7.3, 7.4**

  - [x] 4.11 Write the property test for trip balance and settlement conservation
    - **Property 12: Trip balances and settlements conserve money**
    - Verify the ledger equation, zero-sum balances, sign labels, deterministic transfers, and all-zero post-settlement state.
    - **Validates: Requirements 7.2, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10**

  - [x] 4.12 Write the property test for invalid trip draft containment
    - **Property 13: Invalid trip drafts cannot replace confirmed outcomes**
    - Verify invalid drafts retain the last confirmed version or produce unavailable outcomes and that valid explanations enumerate all required records and adjustments.
    - **Validates: Requirements 7.11, 7.16, 7.17, 7.18**

- [x] 5. Build outcome, explanation, insight, and aggregate services
  - [x] 5.1 Implement typed outcome states and generated calculation explanations
    - Add `backend/src/domain/outcomes.js` for available, missing, invalid, stale, refresh-failed, and calculation-failed outcomes with minimal dependency failures.
    - Generate source references, ordered operations, intermediate results, period/version, precision, rounding direction/adjustment, classifications, and scoped retry metadata.
    - Keep source values restricted to authenticated authorized responses and expose a separate public-trip type.
    - _Requirements: 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 8.11, 8.12, 8.13, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.9, 9.10, 9.11, 9.12_

  - [x] 5.2 Implement deterministic goal, trip, and actionable-insight ranking
    - Add `backend/src/domain/insights.js` with overdue/date/gap/name goal ranking, balance/time/name trip ranking, total actionable-insight ordering, stable tie-breakers, the three-action cap, and no-action state.
    - Emit one action label, expected effect, fixed route/context, and informational-guidance disclaimer per candidate.
    - _Requirements: 4.5, 5.9, 5.10, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.14, 8.15, 9.8_

  - [x] 5.3 Write the property test for deterministic urgent goal and trip selection
    - **Property 15: Urgent goal and trip selection is deterministic**
    - Shuffle candidate inputs and verify the complete comparator order and stable ID tie-breakers.
    - **Validates: Requirements 8.4, 8.5, 8.6, 8.7**

  - [x] 5.4 Write the property test for total, stable, capped action ranking
    - **Property 16: Action ranking is total, stable, and capped**
    - Verify permutation invariance, deadline precedence, amount ordering, stable labels/keys, exact condition actions, and no-action output.
    - **Validates: Requirements 4.5, 5.9, 5.10, 8.8, 8.9, 8.14, 8.15**

  - [x] 5.5 Write the property test for isolated minimal outcome failures
    - **Property 17: Outcome dependency failures are isolated and minimal**
    - Generate missing/invalid source subsets and verify only dependent outcomes change and every correction identifies the minimum input, constraint, and unlock.
    - **Validates: Requirements 1.9, 1.10, 8.11, 8.12, 8.13, 9.7**

  - [x] 5.6 Write the property test for explanation reproducibility and version coherence
    - **Property 18: Explanations reproduce their outcomes**
    - Evaluate generated operations independently and verify exact value, period, version, rounding, and open-panel update coherence.
    - **Validates: Requirements 4.17, 7.11, 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.10, 9.12**

  - [x] 5.7 Implement the canonical financial clarity service
    - Add `backend/src/services/clarityService.js` to load confirmed exact-period records through repositories and build independent monthly, spending, goal, and trip outcomes plus ranked actions.
    - Include the configured time zone, period boundaries, inclusive days, generation time, and monotonic data version.
    - Catch calculator failures per outcome so sibling outcomes and confirmed facts remain available.
    - _Requirements: 4.14, 5.12, 6.18, 7.6, 8.1, 8.2, 8.3, 8.11, 9.6, 9.7, 9.11_

  - [x] 5.8 Route the monthly review through the canonical service with redacted shadow comparison
    - Replace duplicate monthly-plan/goal/category calculations in `backend/src/jobs/monthlyReview.js` with prior-month clarity-service results while preserving current email behavior.
    - Add shadow mismatch codes and record IDs only; never log amounts, names, notes, split JSON, emails, public tokens, or request bodies.
    - Keep the legacy path selectable until parity fixtures pass.
    - _Requirements: 4.1, 5.1, 6.14, 9.2, 11.12_

- [x] 6. Checkpoint - Ensure domain and persistence tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Introduce canonical APIs and mutation compatibility
  - [x] 7.1 Implement transactional, versioned, idempotent financial mutations
    - Add `backend/src/services/financialMutation.js` to validate ownership and expected versions, claim UUID idempotency keys, HMAC canonical request fingerprints, write source/linked rows, record changes, and increment versions atomically.
    - Replay the same key/body without a duplicate change; reject key reuse with a different command; calculate the confirmed snapshot after commit.
    - If calculation fails after commit, return the confirmed mutation with only dependent outcomes marked failed.
    - _Requirements: 1.11, 1.12, 1.13, 3.14, 3.15, 3.16, 5.2, 5.3, 5.4, 6.13, 10.5, 10.11, 10.13_

  - [x] 7.2 Add authenticated clarity read and explanation routes
    - Add and mount `GET /api/finance/clarity?month=YYYY-MM` and version-aware `GET /api/finance/explanations/:outcomeId` behind the existing `authRequired` middleware.
    - Validate exact periods and ownership, return `schemaVersion: 1`, and update superseded explanations atomically without introducing a listener or public access path.
    - Preserve existing finance routes and fields.
    - _Requirements: 1.8, 4.14, 8.1, 8.2, 8.3, 9.2, 9.3, 9.9, 9.10, 9.12_

  - [x] 7.3 Migrate salary and bill writes to canonical mutation envelopes
    - Delegate existing salary and `emis` create/edit/delete routes to the mutation service when `X-Clarity-Contract: 1` is present while retaining legacy top-level responses.
    - Add bill active/effective-month handling and `POST /api/finance/salary/apply` for explicit prior-month copying.
    - Return plan deltas, updated outcomes, receipt/v1111111122222221ersion metadata, and accepted constraints without changing legacy records implicitly.
    - _Requirements: 1.4, 2.1, 2.2, 4.1, 4.2, 4.4, 4.5, 4.12, 4.13, 4.15, 4.16_

  - [x] 7.4 Add expense correction and category-treatment mutation APIs
    - Add `PATCH /api/finance/expenses/:id` and Needs/Wants treatment PUT/DELETE routes, and route existing expense create/delete through exact transition logic.
    - Return original/resulting periods and categories, one confirmed snapshot, and structured field errors; preserve current legacy fields.
    - Keep recurring-expense materialization compatible while preventing duplicate transition accounting.
    - _Requirements: 2.3, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 5.11, 5.13, 5.14_

  - [x] 7.5 Enforce strict goal mutations and a bounded contribution endpoint
    - Route goal create/edit/delete through strict domain validation and add `POST /api/finance/goals/:id/contributions` with dynamic bounds, expected version, and idempotency.
    - Retain preceding confirmed rows on invalid drafts and keep legacy goal response fields during rollout.
    - Prevent negative withdrawal-style contributions from the new flow while leaving legacy data correctable.
    - _Requirements: 1.6, 2.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.11, 6.12, 6.13, 6.18, 6.20_

  - [x] 7.6 Canonicalize authenticated trip mutations and personal expense inclusion
    - Add `backend/src/services/tripService.js`, retain existing owner/member/payer authorization, and route member, expense, and settlement writes through the canonical trip calculator.
    - Add personal-link PUT/DELETE endpoints that atomically create/remove exactly one eligible personal expense for the authenticated linked member's allocated share.
    - Return confirmed trip and financial versions while retaining existing authenticated trip response fields.
    - _Requirements: 1.7, 2.5, 7.1, 7.2, 7.6, 7.10, 7.12, 7.13, 7.14, 7.16, 7.17, 7.18_

  - [x] 7.7 Write the property test for isolated, idempotent personal trip inclusion
    - **Property 14: Personal trip inclusion is isolated and idempotent**
    - Use a transactional test repository to verify include/replay/withdraw/replay behavior and an unchanged trip ledger.
    - **Validates: Requirements 7.12, 7.13, 7.14**

  - [x] 7.8 Replace duplicate public-trip math with an explicit allowlisted serializer
    - Route `backend/src/routes/public.js` through the canonical trip calculator, then project only the existing documented public fields.
    - Keep the 32-hex token, disabled/unknown/malformed constant 404 behavior, route path, and response compatibility unchanged.
    - Keep salary, bills, personal expenses, goals, IDs/linkage, journey, analytics, email, and personal-link data structurally impossible to serialize.
    - _Requirements: 7.1, 7.5, 7.10, 7.11, 7.15, 11.10, 11.11_

  - [x] 7.9 Write the property test for public-trip field minimization and revocation
    - **Property 24: Public trip serialization reveals only disclosed fields**
    - Generate private trip objects with extra sensitive fields and verify exact output keys plus private-state preservation after token revocation.
    - **Validates: Requirements 7.15, 11.10, 11.11**

  - [x] 7.10 Add feature flags, shadow mode, and backward-compatible contract negotiation
    - Add server/client flag readers for `CLARITY_SHADOW_COMPARE` and `VITE_FINANCIAL_CLARITY_ENABLED`, with clarity disabled by default until tests pass.
    - Preserve legacy routes and top-level response fields while the new header adds `clarity` and `mutation` envelopes.
    - Compare canonical and legacy results using mismatch codes only and make rollback select the old UI/read path without deleting feature data.
    - _Requirements: 4.1, 5.1, 7.15, 10.8, 11.15_

  - [x] 7.11 Add API and database integration coverage for canonical routes
    - Test valid/revoked sessions, wrong owners and trip roles, exact-origin CORS, body limits, mutation atomicity, idempotent replay/conflict, exact-month salary, expense moves, goal bounds, trip personal links, and public serializer compatibility.
    - Verify no wildcard origin, alternate authentication, listener, or private anonymous endpoint is introduced.
    - Compare monthly review and clarity output for the same fixture.
    - _Requirements: 3.15, 4.14, 5.5, 6.11, 7.13, 7.15, 9.7, 10.11, 11.10_

- [x] 8. Implement data-use, export/deletion, and analytics-ingress safeguards
  - [x] 8.1 Add versioned data-use and analytics settings APIs
    - Add authenticated settings reads/updates for notice version, acknowledgement timestamp, configured time zone, and disabled-by-default Product Analytics.
    - Reject financial commands with 428 only when their declared data use is newer than the acknowledged notice, while preserving read, export, correction, and deletion access.
    - Accept only fixed settings fields and make analytics disablement effective before the response returns.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.13, 11.14, 11.15_

  - [x] 8.2 Write the property test for notice versioning and minimal command schemas
    - **Property 25: Data-use versioning and command schemas minimize data**
    - Generate extra fields and notice versions, then verify fixed schemas, pre-processing rejection, and continued read/export/delete access.
    - **Validates: Requirements 11.3, 11.4**

  - [x] 8.3 Extend export and both account-deletion paths for every new user-linked record
    - Update `backend/src/routes/auth.js` and `backend/src/routes/admin.js` to include financial state, journeys, treatments, personal links, change receipts, sharing settings, Product Analytics settings/events, and user-linked visits.
    - Omit the internal HMAC fingerprint from export, add schema/table descriptions, revoke owned public links, delete linked personal expenses safely, and execute deletion as one transaction.
    - Return structured export failure or incomplete-deletion categories with the existing retry/support path; do not anonymize user-linked measurement rows during deletion.
    - _Requirements: 11.2, 11.6, 11.7, 11.8, 11.9, 11.11, 11.12_

  - [x] 8.4 Update account controls and test export/deletion failure containment
    - Update `frontend/src/components/DangerZone.tsx` to display unsuccessful export and incomplete-deletion states with scoped retry/support actions while preserving the user's records and active account after rollback.
    - Seed one row in every in-scope table, verify export coverage and prohibited fingerprint omission, and inject deletion failures at each dependency group.
    - Verify self-service and admin deletion stay aligned.
    - _Requirements: 11.6, 11.7, 11.8, 11.9_

  - [x] 8.5 Implement closed, consent-gated measurement event ingestion
    - Add fixed event validators and `measurementService.js` for journey start, first outcome, clarity response, linked action completion, and financial-change UI events.
    - Supply user, session, consent, local-period, and receipt fields on the server; reject unknown/nested/value-like fields and unauthorized references.
    - Make disabled analytics a 204 no-op, drop retries after opt-out, and update `routes/visits.js` to store only fixed route enums for consenting authenticated users.
    - _Requirements: 11.12, 11.13, 11.14, 11.15, 13.1, 13.4, 13.10, 13.11, 13.13, 13.14_

  - [x] 8.6 Write the property test for sensitive-data-free analytics schemas
    - **Property 26: Analytics accepts no sensitive or arbitrary data**
    - Fuzz nested objects, arrays, Unicode/prototype-like keys, raw paths, identity/value fields, and unauthorized IDs; assert no rejected event persists.
    - **Validates: Requirements 11.12**

  - [x] 8.7 Write the property test for immediate, financially independent opt-out
    - **Property 27: Analytics opt-out is immediate and financially independent**
    - Generate consent/event race sequences and verify receipt-time consent wins, subsequent events are absent, and financial/journey state is unchanged.
    - **Validates: Requirements 11.14, 11.15**

- [x] 9. Build the frontend clarity data and component foundation
  - [x] 9.1 Add versioned frontend contracts, query caching, and API mutation metadata
    - Add TanStack Query, `frontend/src/clarity/contracts.ts`, query keys, and API support for `Idempotency-Key`, `X-Clarity-Contract: 1`, structured errors, and response versions.
    - Mount one `QueryClientProvider` in `main.tsx`, keep tokens in `sessionStorage`, keep financial snapshots in memory, and register query-cache clearing in `clearAuth()`.
    - Ignore older snapshot versions and retain the existing auth/session behavior.
    - _Requirements: 1.13, 9.9, 9.10, 10.6, 10.8, 10.11, 10.12_

  - [x] 9.2 Implement confirmed-plus-pending clarity and mutation status state
    - Add `FinancialClarityProvider`, pure ordered patch reducer, and `MutationStatusProvider` keyed by record scope.
    - Register pending state synchronously before awaiting network I/O, prevent duplicate same-scope submissions, allow independent scopes, install only newer confirmed snapshots, and remove only the completed/failed patch.
    - Keep retry bound to the original body/idempotency key and create a new key only after the user edits the draft.
    - _Requirements: 3.14, 3.15, 3.16, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [x] 9.3 Write the property test for single-scope rollback
    - **Property 22: A failed mutation rolls back only its own scope**
    - Generate confirmed snapshots and valid patches, then verify duplicate blocking, exact rollback, unrelated-value retention, and same-command retry.
    - **Validates: Requirements 10.4, 10.5, 10.11, 10.13, 11.5**

  - [x] 9.4 Write the property test for concurrent mutation interleavings
    - **Property 23: Concurrent mutation interleavings are isolated**
    - Generate submissions and out-of-order success/failure responses and compare visible state with the highest-version base plus ordered pending patches.
    - **Validates: Requirements 10.2, 10.3, 10.9, 10.10, 10.12, 10.15**

  - [x] 9.5 Create shared outcome, explanation, action, status, and region components
    - Add `OutcomeCard`, `CalculationExplanationPanel`, `ActionLink`, `DecisionActionHeader`, `ScopedMutationStatus`, `RegionBoundary`, and stable `RegionSkeleton` components.
    - Render entered/calculated/recommendation labels, periods, informational disclaimer, missing/invalid/stale/calculation-failed states, one scoped retry, and in-place version updates.
    - Add live outcome announcements, field-associated errors, stable focus, keyboard disclosure behavior, text-equivalent statuses, and reduced-motion handling.
    - _Requirements: 1.3, 1.11, 1.12, 1.13, 8.10, 9.1, 9.6, 9.7, 9.8, 9.10, 9.11, 9.12, 10.14, 10.15, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.14, 12.15, 12.16, 12.17_

  - [x] 9.6 Add component and accessibility coverage for shared clarity states
    - Test every outcome status, calculation refresh/failure, retry placement, live announcements, focus retention, keyboard operation, error association, status text, reduced motion, and light/dark axe checks.
    - Verify initial region failures preserve successfully loaded regions and navigation.
    - _Requirements: 9.6, 9.7, 9.9, 9.10, 9.11, 9.12, 10.14, 10.15, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16, 12.17_

- [x] 10. Deliver the product promise, request explanations, Home summary, and Plan first
  - [x] 10.1 Add the core promise and versioned data-use gate before financial inputs
    - Add `CorePromiseStrip`, `DataUseGate`, and `DataUseNotice` to the signed-in `Shell` before routed financial controls, preserving the current warm palette, typography, rounded forms, and admin/user navigation.
    - Show connected planning, spending, saving, and trip language; list categories, outcomes, access roles, sharing defaults, retention/deletion events, correction/export/deletion controls, and independent Product Analytics control.
    - Keep existing data readable and controls visible with a reason while gated; store only a session-rendered promise flag and server notice acknowledgement, never financial snapshots.
    - _Requirements: 1.1, 1.2, 11.1, 11.2, 11.3, 11.13, 12.1, 12.10_

  - [x] 10.2 Add the fixed purpose registry and input benefit previews
    - Add `frontend/src/clarity/purposeRegistry.ts`, `PurposeExplanation`, and `InputBenefitPreview` for Salary, Bill, Expense, Goal, and Trip inputs.
    - Mark required/optional before enabling submission, use confirmed existing values when present, otherwise use visibly labeled fixed examples, omit purposeless optional inputs, and provide skip text naming the unchanged/unavailable outcome.
    - Use plain-language first-use definitions and never accept server-provided HTML or arbitrary purpose copy.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 12.10_

  - [x] 10.3 Write the property test for optional input omission and skip no-ops
    - **Property 21: Optional input omission and skip are financial no-ops**
    - Generate optional definitions and confirmed states and verify omission, skip equality, outcome naming, and confirmed-value preview precedence.
    - **Validates: Requirements 2.7, 2.9, 2.11, 2.12, 3.6**

  - [x] 10.4 Apply decision/action headers and stable action context to all five page routes
    - Update Dashboard, Plan, Spending, Goals, Trips, and TripDetail page headers to name the required decision and highest relevant action before forms or generic descriptions.
    - Use fixed action keys and allowlisted route/query/hash context so action completion can return to the exact existing form without placing values or names in URLs.
    - Keep each page functional under the legacy feature-flag branch.
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 8.10, 9.8_

  - [x] 10.5 Replace Dashboard calculations with the unified Monthly Clarity Summary
    - Update `frontend/src/pages/Dashboard.tsx` to consume the clarity snapshot and render remaining spendable, daily guide, projected savings versus target, urgent goal, nearest trip settlement, and at most three ranked actions.
    - Show personalized outcomes before generic content, isolate missing/invalid regions, retain confirmed values during refresh, and show explicit no-action state.
    - Remove Home's salary mutation form from the clarity branch and route missing-input actions to the existing Plan form.
    - _Requirements: 1.3, 1.8, 1.9, 1.10, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15_

  - [x] 10.6 Migrate Plan and PlanInputs to canonical outcomes and scoped mutations
    - Update `frontend/src/pages/Plan.tsx` and `PlanInputs.tsx` to use exact-month outcomes, purpose/previews, bill activity periods, explicit prior-salary application, calculated deltas, and calculation explanations.
    - Replace `window.location.reload()` and component-wide saving with per-salary/per-bill statuses, optimistic patches, confirmed snapshot responses, independent controls, and scoped rollback/retry.
    - Retain current legacy page rendering under the rollout flag and do not clear confirmed inputs after calculation failure.
    - _Requirements: 1.4, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 2.1, 2.2, 4.3, 4.4, 4.5, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8, 10.9, 10.13_

  - [x] 10.7 Test Home and Plan user-visible behavior and mutation timing
    - Add component/API integration tests for personalized-first ordering, missing/invalid/calculation-failed regions, action routing, exact-month labels, bill shortfall action, deltas, explanation order, and unaffected sibling outcomes.
    - Use controlled promises and paint marks to verify pending feedback within 100 ms of submit and outcome/success feedback within 100 ms of response handling.
    - Assert no reload/document replacement, unrelated controls remain interactive, focus remains on the active control, and failed mutations preserve drafts and confirmed values.
    - _Requirements: 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 4.5, 4.12, 4.13, 8.11, 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8, 10.11, 10.12, 10.13, 12.3, 12.4_

- [x] 11. Checkpoint - Ensure the first user-visible clarity slice passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Migrate Spending to canonical decisions and scoped feedback
  - [x] 12.1 Integrate expense corrections, category treatment, and spending outcomes
    - Update Spending and `SpendingTracker.tsx` to render canonical category totals, remaining spendable, daily guide, projected savings, Needs/Wants excess, purpose/previews, and calculation explanations.
    - Add edit support for amount/category/note/date, including original/resulting month refresh, and migrate create/edit/delete/treatment writes to per-record scoped mutation status.
    - Preserve independent pending changes, unrelated controls, valid drafts, and exact rollback without a page-wide busy state or broad refetch.
    - _Requirements: 1.5, 2.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 9.12, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [x] 12.2 Test Spending transitions, concurrency, accessibility, and timing
    - Exercise create/update/move/delete/reclassify success and failure with reversed response order and verify exact category/month outcomes.
    - Verify field-associated validation, live outcome updates, stable focus, separate mutation statuses, no reload/page-wide loading, and 100 ms acknowledgements.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.9, 5.10, 5.11, 5.13, 5.14, 10.1, 10.6, 10.8, 10.10, 10.11, 10.12, 12.3, 12.4, 12.15, 12.16, 12.17_

- [x] 13. Migrate Goals to feasible, bounded saving actions
  - [x] 13.1 Integrate canonical goal outcomes and contribution actions
    - Update Goals and `SavingsGoals.tsx` to enforce accepted name/amount/date bounds, show funding gap, inclusive opportunities, required contribution, feasibility/capacity difference, overdue/funded states, and one valid revision.
    - Replace generic and negative contribution handling with the bounded idempotent endpoint and scoped create/edit/contribute/delete statuses.
    - Preserve the preceding confirmed goal and all valid fields on validation/save failure; show missing monthly-plan inputs only in the feasibility region.
    - _Requirements: 1.6, 2.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 6.15, 6.16, 6.17, 6.18, 6.19, 6.20, 10.11, 12.15, 12.16, 12.17_

  - [x] 13.2 Test goal boundaries, revisions, failures, and Home integration
    - Cover same-month/future/overdue/funded goals, exact contribution bounds, retries, missing plan inputs, and revisions that recompute to feasible.
    - Verify urgent-goal ordering reaches the Home summary, open explanations update without closing, and keyboard/focus/error behavior remains intact.
    - _Requirements: 6.4, 6.9, 6.10, 6.11, 6.12, 6.14, 6.17, 6.18, 6.19, 6.20, 8.4, 8.5, 9.12, 12.4, 12.5, 12.16_

- [x] 14. Migrate Trips while preserving public sharing behavior
  - [x] 14.1 Integrate canonical allocations, balances, settlements, and personal inclusion
    - Update Trips and `TripDetail.tsx` to render ID-backed canonical allocations, owed/receivable/settled labels, proposed settlements, invalid-draft retention, and generated explanations.
    - Migrate member, expense, and settlement changes from broad reload callbacks/busy keys to independent scoped mutations; keep all unrelated tabs and controls usable.
    - Add explicit personal-share inclusion/withdrawal confirmation with exact amount/category/month before changing monthly spending.
    - _Requirements: 1.7, 2.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13, 7.14, 7.16, 7.17, 7.18, 10.2, 10.3, 10.10_

  - [x] 14.2 Add exact public-field disclosure before share creation or rotation
    - Update `TripShareLink.tsx` with a separate confirmation that lists every field emitted by the public serializer before enabling or rotating a link.
    - Keep sharing disabled by default, revoke immediately while retaining private trip data, and show scoped pending/success/error/retry states.
    - Ensure disclosed fields are sourced from the same fixed allowlist used by the server test contract.
    - _Requirements: 7.15, 11.2, 11.10, 11.11, 12.2, 12.5_

  - [x] 14.3 Test authenticated trip, public projection, revocation, and Home integration
    - Cover owner/member/payer permissions, weighted rounding, invalid drafts, settlement completion, personal include/withdraw replay, separate scoped statuses, and failed-operation rollback.
    - Diff the public response against its exact field allowlist, verify disabled/rotated/revoked tokens, and verify nearest-settlement ranking appears on Home.
    - _Requirements: 7.3, 7.4, 7.5, 7.10, 7.11, 7.13, 7.14, 7.15, 7.16, 7.17, 7.18, 8.6, 8.7, 11.10, 11.11_

- [x] 15. Implement the resumable first-session guided journey
  - [x] 15.1 Implement server-owned journey planning and transitions
    - Add `journeyService.js` and active/start/transition/skip routes using only the four fixed desired outcomes and fixed step keys.
    - Derive satisfied steps from current confirmed records, keep at most three required categories/steps, preserve the next incomplete step, and attach confirmed `changeId` values instead of copying financial data into journey state.
    - Snapshot session/measurement eligibility at start and allow settle-trip completion without salary.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.14, 3.15, 3.16_

  - [x] 15.2 Write the property test for journey first-value bounds and resume
    - **Property 19: Journey plans remain within the first-value bound**
    - Generate desired outcomes and subsets of valid records and verify required counts, progress partition, first-outcome ordering, resume, and salary-free trip settlement.
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9, 3.10, 3.11**

  - [x] 15.3 Write the property test for failed journey operation containment
    - **Property 20: Failed journey operations preserve confirmed progress**
    - Generate invalid/failed commands and retries and verify preceding records/steps remain unchanged and at most one record is created.
    - **Validates: Requirements 1.13, 3.12, 3.13, 3.14, 3.15, 3.16**

  - [x] 15.4 Add the protected GuidedJourneyPage and registration handoff
    - Add `/start` in `App.tsx`, navigate newly completed registrations there, allow existing users to start from Home, and resume active journeys without forcing returning users.
    - Render exactly four desired-outcome choices, the current/completed/remaining required steps, scoped save errors/retries, and existing-record auto-satisfaction.
    - Keep all drafts and confirmed records through route leave/return and feature-flag rollback.
    - _Requirements: 3.1, 3.2, 3.8, 3.9, 3.10, 3.12, 3.13, 3.14, 3.15, 3.16, 12.5, 12.6_

  - [x] 15.5 Add step outcome reveals, optional skips, and clarity confirmation
    - After every confirmed step, show the newly unlocked outcome and exactly one next-step choice; show the First Meaningful Outcome before optional prompts.
    - Pair every request with purpose/benefit content, make optional skips financial no-ops, and offer a nonblocking Yes/Partly/No question plus Skip after first outcome.
    - Keep the recommended action enabled; transmit the response only when Product Analytics is enabled.
    - _Requirements: 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 3.5, 3.6, 3.7, 13.10, 13.11_

  - [x] 15.6 Test all four guided journeys with empty and partially satisfied records
    - Add component/API/browser tests for exact labels, maximum step counts, progressive outcome reveal, optional skip, invalid/save failure, idempotent retry, pause/resume, and trip completion without salary.
    - Verify keyboard-only completion, focus/error behavior, no horizontal overflow, no page-wide loading, and no duplicated source records.
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 10.2, 12.5, 12.8, 12.9_

- [x] 16. Implement privacy-safe success measurement and reporting
  - [x] 16.1 Implement pure local-period, cohort, rate, median, and target calculations
    - Add `backend/src/domain/measurement.js` for Monday weeks, exact 28-local-date periods, seven-day local action windows, earliest-journey cohorts, same-session first outcomes, odd/even medians, one action completion per user, rational percentage rounding, thresholds, and source outages.
    - Use injected instants and configured `Asia/Kolkata`; compare unrounded rates to targets and include full report metadata.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17, 13.18, 13.19, 13.20, 13.21, 13.22, 13.23, 13.24, 13.25, 13.26, 13.27, 13.28, 13.29, 13.30, 13.31, 13.32_

  - [x] 16.2 Write the property test for local period and cohort boundaries
    - **Property 28: Local reporting periods and cohorts have exact boundaries**
    - Generate instants around midnight, Mondays, month/year boundaries, and offset changes and verify exact inclusion/exclusion and one cohort row per user.
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.13**

  - [x] 16.3 Write the property test for success metric populations and arithmetic
    - **Property 29: Success metrics use exact populations and arithmetic**
    - Generate cohorts/events and verify rate populations, action deduplication, medians, one-decimal display rounding, and unrounded target comparison.
    - **Validates: Requirements 13.6, 13.7, 13.8, 13.9, 13.12, 13.14, 13.15, 13.16, 13.17, 13.18, 13.19**

  - [x] 16.4 Write the property test for target and source-failure classification
    - **Property 30: Metric classifications and source failures are isolated**
    - Generate sample sizes, target boundaries, and overlapping outages and verify classification, omitted unavailable targets, unaffected metrics, and required report metadata.
    - **Validates: Requirements 13.20, 13.21, 13.22, 13.23, 13.24, 13.25, 13.26, 13.27, 13.28, 13.29, 13.30, 13.31**

  - [x] 16.5 Wire consent controls and typed client measurement events
    - Add `AnalyticsControl` to Settings, update `useVisitTracker.ts` to fixed route enums and consent state, and emit only typed journey/outcome/action/change events through a non-persistent queue.
    - Never put financial values, names, notes, identities, public tokens, raw URLs, or arbitrary metadata in event payloads; drop failed/offline events rather than replaying after opt-out.
    - Record recommendation completion only for fixed in-product action keys and opaque recommendation instance IDs.
    - _Requirements: 11.12, 11.13, 11.14, 11.15, 13.6, 13.7, 13.10, 13.11, 13.14, 13.16, 13.17_

  - [x] 16.6 Add completed-period report generation, retention, and aggregate admin reads
    - Add `clarityReports.js`, a secret-gated internal cron route following the existing middleware order, and an admin-authenticated aggregate-only read route.
    - Materialize each completed weekly and 28-day period exactly once, report outages per metric, persist numerator/denominator/duration/status metadata, and purge user-level events older than 13 months.
    - Keep report generation idempotent and never expose user-level or financial data through admin report output.
    - _Requirements: 11.12, 13.20, 13.21, 13.22, 13.23, 13.24, 13.25, 13.26, 13.27, 13.28, 13.29, 13.30, 13.31, 13.32_

  - [x] 16.7 Add measurement integration, redaction, opt-out race, and report tests
    - Verify disabled ingestion no-ops, enabled closed events persist, ownership/session rules hold, opt-out wins at receipt, and existing visits become consent-aware fixed enums.
    - Verify weekly/28-day backfill, period checkpoints, sample thresholds, source outage isolation, retention purge, and aggregate-only admin responses.
    - Assert request/application logs and event/report rows contain none of the prohibited financial or identity fields.
    - _Requirements: 11.12, 11.14, 11.15, 13.1, 13.5, 13.10, 13.11, 13.20, 13.29, 13.30, 13.31, 13.32_

- [x] 17. Complete rollout, responsive/accessibility validation, and end-to-end acceptance
  - [x] 17.1 Add privacy-safe operational observability and failure boundaries
    - Add request IDs, operation codes, record type/ID where needed, version conflicts, calculator failure codes, shadow mismatches, and report source status without logging bodies, amounts, names, notes, split JSON, email, tokens, or event payloads.
    - Verify calculation failures preserve committed inputs, stale/refresh failures preserve last confirmed values, and each retry remains scoped.
    - Add automated log-redaction assertions for success and every structured failure path.
    - _Requirements: 1.11, 1.12, 1.13, 9.6, 9.11, 10.11, 11.12, 13.30, 13.31_

  - [x] 17.2 Retire duplicate calculations and broad reload/loading paths only after parity
    - Remove browser-owned clarity math from `frontend/src/insights.ts`, retire `useCachedPlan` financial snapshots, remove `window.location.reload()`, and remove duplicate trip settlement/monthly-review formulas after canonical/legacy fixtures match.
    - Keep legacy response fields and the feature-flag rollback path until old clients are no longer served; do not delete or rewrite additive feature data during rollback.
    - Add a repository assertion that financial mutations cannot call document reload or activate a page-wide loading state.
    - _Requirements: 4.1, 5.1, 7.5, 10.2, 10.3, 10.8, 10.9, 13.16, 13.17_

  - [x] 17.3 Fix and test responsive navigation and outcome layouts from 320 to 3840 pixels
    - Update `frontend/src/styles.css` and `Shell.tsx` so the current 820–899 px transition has either a fully usable sidebar or bottom navigation, with no missing/overlapping navigation state.
    - Keep one-column layouts at 320 px, add outcome columns only when cards retain at least 280 px, wrap labels/currency safely, and prevent document or region horizontal scrolling, clipping, and overlap.
    - Run automated overflow/layout assertions at every configured viewport, including 320, 820, and 899 px, with both themes and long localized values.
    - _Requirements: 12.1, 12.8, 12.9_

  - [x] 17.4 Complete keyboard, focus, contrast, status-text, and reduced-motion acceptance coverage
    - Exercise every input, choice, navigation, skip, explanation, retry, share, and completion action using keyboard only across all clarity pages.
    - Verify reading-order focus, no unintended traps, active-control focus retention, live announcements, associated validation errors, adjacent status text, and reduced-motion static transitions.
    - Add automated token/element contrast assertions for normal text, large/bold text, controls, focus rings, status icons, and charts in light and dark themes; fix failing tokens without changing the warm visual language.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16, 12.17_

  - [x] 17.5 Add final automated end-to-end acceptance and rollback scenarios
    - Cover all four journeys, returning Home summary, Plan/Spending/Goals/Trips actions, concurrent out-of-order mutations, stale refresh, calculation/save failures, open explanation updates, export/deletion failure, sharing disclosure/revocation, analytics opt-out, and completed report generation.
    - Assert at most three Home actions and journey required steps, no reload/page-wide loading, 100 ms scoped feedback on the supported test profile, exact public fields, and no prohibited analytics/log data.
    - Run the same representative records through clarity enabled, shadow comparison, and rollback-to-legacy modes to prove source data and legacy behavior remain intact.
    - _Requirements: 1.1, 1.8, 3.3, 3.4, 3.5, 7.15, 8.8, 9.10, 10.1, 10.6, 10.8, 11.6, 11.8, 11.10, 11.14, 12.5, 12.8, 12.9, 13.20, 13.32_

- [x] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- The backend implementation language is JavaScript (ES modules); the frontend implementation language is TypeScript/TSX, matching the current repository and the completed design.
- Property tasks are required and each maps one-to-one to a numbered correctness property in `design.md`; each must run at least 100 generated cases and include the required property comment.
- Test tasks remain required because this feature changes financial calculations, persistence, public sharing, account deletion, accessibility, and product measurement. No optional enhancement tasks were added.
- New database changes are additive and idempotent. Existing records, public tokens, routes, and legacy response fields remain available through rollout and rollback.
- Automated browser tests must use isolated fixtures and non-production credentials; no task deploys or modifies production resources.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1"] },
    { "id": 2, "tasks": ["1.4", "2.2", "3.2"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "2.6", "3.3", "3.4", "3.5", "4.1", "4.5", "4.9"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.6", "4.7", "4.8", "4.10", "4.11", "4.12", "5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3", "5.4", "5.5", "5.6", "5.7", "7.1", "7.8"] },
    { "id": 6, "tasks": ["5.8", "7.2", "7.3", "7.6", "7.9", "7.10", "8.3"] },
    { "id": 7, "tasks": ["7.4", "7.7", "8.1", "8.4", "9.1"] },
    { "id": 8, "tasks": ["7.5", "8.2", "8.5", "9.2"] },
    { "id": 9, "tasks": ["7.11", "8.6", "8.7", "9.3", "9.4", "9.5", "16.1"] },
    { "id": 10, "tasks": ["9.6", "10.1", "10.2", "16.2", "16.3", "16.4"] },
    { "id": 11, "tasks": ["10.3", "10.4", "15.1", "16.5", "16.6"] },
    { "id": 12, "tasks": ["10.5", "15.2", "15.3", "16.7"] },
    { "id": 13, "tasks": ["10.6"] },
    { "id": 14, "tasks": ["10.7", "12.1"] },
    { "id": 15, "tasks": ["12.2", "13.1"] },
    { "id": 16, "tasks": ["13.2", "14.1"] },
    { "id": 17, "tasks": ["14.2"] },
    { "id": 18, "tasks": ["14.3", "15.4"] },
    { "id": 19, "tasks": ["15.5"] },
    { "id": 20, "tasks": ["15.6", "17.1"] },
    { "id": 21, "tasks": ["17.2", "17.3"] },
    { "id": 22, "tasks": ["17.4"] },
    { "id": 23, "tasks": ["17.5"] }
  ]
}
```
