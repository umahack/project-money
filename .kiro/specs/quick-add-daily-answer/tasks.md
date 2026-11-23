# Implementation Plan: Quick Add and Daily Answer

## Overview

This plan incrementally adds Quick Add and the "You can spend ₹X today" headline to the existing JavaScript Express/libSQL backend and TypeScript React/Vite frontend. It starts with characterization tests so existing behavior is pinned, then builds the pure modules first (parser and formatter, Note_Key normalizer, category suggester, warning classifier, shortcut matcher, allowance domain). Additive migrations and repositories follow, then the expense field, the `todayAllowance` snapshot outcome, the Memory API, and the one-line exclusion mark in `materializeRecurring`. The frontend then adds the flags, the Asia/Kolkata calendar helper, the Quick Add store and actions, the user interface, the Home headline, the Spending and Settings changes, and accessibility and responsive coverage. Integration, end-to-end acceptance, and rollback tests close the plan.

Every implementation step produces integrated code or automated tests. Required tests are not marked optional because safe migration, money correctness, privacy, accessibility, and rollback depend on them, and the owner wants every test run. No deployment, manual verification, or unrelated enhancement is included.

## Tasks

- [x] 1. Establish characterization and shared test foundations
  - [x] 1.1 Characterize the expense, snapshot, export, deletion, and recurring behavior before changing it
    - Add tests that pin the complete expense record shape returned by create, update, delete, and the legacy list, the exact CSV header `date,month,category,amount,note`, the table list and descriptions of `GET /api/auth/export`, the account-deletion table list and probes, and the exact columns that `materializeRecurring` writes.
    - Capture one pre-change clarity snapshot fixture for a seeded user so later tests can assert that every existing field is byte-equal.
    - Keep the existing test `correcting and deleting a materialized recurring expense cannot materialize it twice` as written.
    - _Requirements: 16.4, 16.5, 16.6, 17.28, 18.20, 18.22, 18.25_

  - [x] 1.2 Add shared fixtures and generators for the new pure modules
    - Add `backend/test/fixtures/noteKey.json` with Latin, Devanagari, and Telugu strings, combining marks, joiners, mixed case, whitespace runs, NFC and NFD forms, 60-code-point and 61-code-point boundaries, and empty input.
    - Add fast-check generators for integer paise, valid and invalid calendar dates, month-end and leap-day dates, Asia/Kolkata midnight instants, grouped and ungrouped amounts, notes in several scripts, plans, ledgers with and without the mark, memory states up to 501 entries, and command interleavings.
    - Add an `Intl.DateTimeFormat`-based Asia/Kolkata reference helper for backend and frontend tests, and make shrunk counterexamples print structure and IDs only.
    - _Requirements: 17.1, 17.8, 17.25_

- [x] 2. Build the pure parser and formatter
  - [x] 2.1 Implement the amount grammar and Indian-grouping formatting
    - Add `frontend/src/clarity/quickAdd/amount.ts` with candidate detection, Indian and Western grouping rules, one-digit-as-tenths, Currency_Marker and `/-` handling, ASCII-only digits after NFKC, paise construction from the digit string with no floating-point step, and `formatInr`.
    - Return invalid-amount problems with subcodes for grouping, decimals, missing integer part, trailing point, zero, and size, and never round or truncate.
    - _Requirements: 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 2.31, 17.2, 17.3_

  - [x] 2.2 Implement calendar helpers and day-only date resolution
    - Add `frontend/src/clarity/quickAdd/dates.ts` with real-date validation, the Accepted_Date_Range, and resolution of `today`, `yesterday`, weekday names, `on N`, ordinals, `dd/mm`, `dd/mm/yy`, `dd/mm/yyyy`, and `yyyy-mm-dd` to the latest matching date on or before Today.
    - Skip months and years without the requested day, return invalid-date problems that name the token or the range, and never read the clock, locale, or process time zone.
    - _Requirements: 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 17.6, 17.7_

  - [x] 2.3 Implement `parseQuickAddLine`
    - Add `frontend/src/clarity/quickAdd/parser.ts` that applies the length check, quoted segments with doubled quotes, tokenization, classification, date and amount resolution, note assembly with the 120-unit limit, and collection of every problem, in one linear pass per stage.
    - Keep Note_Text exactly as typed with whitespace collapsed, treat digit-and-letter tokens such as `7up` as note text, and recognize markers, date words, `on`, and ordinal suffixes in ASCII English only.
    - Never throw, and return a non-empty problem list whenever no entry is returned.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.12, 2.13, 2.14, 2.15, 2.19, 2.26, 2.27, 2.28, 2.29, 2.30, 2.34, 2.35, 3.7, 3.11, 17.1, 17.4, 17.7, 17.8_

  - [x] 2.4 Implement `formatQuickAddLine`
    - Add `frontend/src/clarity/quickAdd/formatter.ts` that writes `₹<amount>` with Indian grouping and two fractional digits only when paise exist, then the `yyyy-mm-dd` date, then the note in double quotes with `""` for a literal quote.
    - _Requirements: 2.32, 2.33, 7.10_

  - [x] 2.5 Write the property test for total, deterministic, fully accounted parsing
    - **Property 1: Parsing is total, deterministic, and fully accounted**
    - Generate strings up to 300 characters and valid Today values for at least 100 cases, run each twice under different process time zones and locales, and compare with an independent character-accounting model.
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.6, 2.12, 2.13, 2.14, 2.15, 2.26, 2.27, 2.28, 2.30, 3.7, 3.11, 17.1, 17.4, 17.7, 17.8**

  - [x] 2.6 Write the property test for amount notation and grouping round trip
    - **Property 2: Amount notation and grouping round trip**
    - Write generated paise values with Indian, Western, and no grouping and every marker form, then generate invalid tokens and verify no rounding or truncation.
    - **Validates: Requirements 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 17.2, 17.3**

  - [x] 2.7 Write the property test for the formatter and parser round trip
    - **Property 3: Entry format and parse round trip**
    - Generate parsed entries with notes that contain digits, quotes, date words, and several scripts, and compare after whitespace collapse.
    - **Validates: Requirements 2.32, 2.33**

  - [x] 2.8 Write the property test for segment order
    - **Property 4: Segment order is irrelevant**
    - Reorder the amount, date, and note segments of lines that parse and verify an equivalent entry.
    - **Validates: Requirements 17.5**

  - [x] 2.9 Write the property test for day-only and relative dates
    - **Property 5: Day-only and relative dates resolve to the latest date on or before Today**
    - Compare every token form with a calendar model that scans back day by day, including 31 in 30-day months and 29 February.
    - **Validates: Requirements 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 17.6**

  - [x] 2.10 Write the property test for notes in any script and ASCII-only numerals
    - **Property 6: Notes in any script survive unchanged and only ASCII digits are numerals**
    - Generate Devanagari, Telugu, and Latin notes with combining marks and joiners, in either order with an amount, and tokens made only of non-ASCII digits.
    - **Validates: Requirements 2.31, 2.34, 2.35, 6.19**

  - [x] 2.11 Write parser example tests
    - Cover `120 coffee`, `swiggy 450 yesterday`, `rent 25,000 on 3rd`, `₹1,20,000/-`, `7up 40`, `450` alone, `coffee 5, tea 6`, `120 "lunch on 3rd"`, a 201-character line, a 121-character note, `on 45`, `31/02`, and a date outside the accepted range.
    - Assert each Parse_Problem names the affected part, the reason, and the accepted correction.
    - _Requirements: 2.3, 2.6, 2.11, 2.14, 2.19, 2.22, 2.23, 2.29, 17.18_

- [x] 3. Build the Note_Key normalizer, category suggester, warning classifier, and shortcut matcher
  - [x] 3.1 Implement the Note_Key normalizer on both sides
    - Add `backend/src/domain/noteKey.js` and `frontend/src/clarity/quickAdd/noteKey.ts` using NFKC, whitespace collapse, `en-IN` lower-casing, trim, and the 60-code-point limit, returning none for empty or longer input.
    - Add one test per side that reads `backend/test/fixtures/noteKey.json` and asserts every expected key.
    - _Requirements: 6.19, 15.5, 17.25_

  - [x] 3.2 Write the property test for Note_Key normalization
    - **Property 9: Note_Key normalization is idempotent and agrees on both sides**
    - Compare both implementations on generated strings, check idempotence, case, normalization-form, and whitespace independence, and the 1 to 60 code-point bound.
    - **Validates: Requirements 6.19, 15.5, 17.25**

  - [x] 3.3 Implement the keyword rules and `suggestCategory`
    - Add `frontend/src/clarity/quickAdd/keywordRules.ts` with the frozen rule list that maps to built-in categories only, and `suggester.ts` with the precedence of empty note, memory, history, category name, keyword, and default.
    - Match whole words on the lowercased NFKC note, choose the longest phrase and then the earlier rule, skip unavailable categories, and produce fixed-template reasons.
    - _Requirements: 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.16, 5.17, 17.9_

  - [x] 3.4 Write the property test for category suggestion precedence
    - **Property 8: Category suggestion follows the source precedence and availability**
    - Compare with a reference function that evaluates the sources in order, over generated notes, categories, memory, history, and rules.
    - **Validates: Requirements 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.16, 5.17, 17.9**

  - [x] 3.5 Implement the entry warning classifier and its named constant
    - Add `frontend/src/clarity/quickAdd/warning.ts` with `classifyEntryWarning`, `BILL_MATCH_MIN_LABEL_LENGTH = 3` as the only place that literal appears, equality matching for any label length, and whole-word or whole-phrase containment for labels of at least 3 characters.
    - Return `none` unless the entry is dated Today, skip an unavailable cause without affecting saving, and compare integers only.
    - _Requirements: 17.23, 18.1, 18.2, 18.3, 18.8, 18.9, 18.10, 18.11, 18.26_

  - [x] 3.6 Write the property test for entry warning classification
    - **Property 18: Entry warning classification is exact and monotone**
    - Generate entries, dates, bill labels in several scripts and forms, and thresholds that may be absent, and verify exactness, case, normalization, whitespace independence, and monotonicity in the amount.
    - **Validates: Requirements 17.23, 18.1, 18.2, 18.3, 18.8, 18.9, 18.10, 18.11**

  - [x] 3.7 Implement the shortcut matcher and platform detection
    - Add `frontend/src/clarity/quickAdd/shortcut.ts` with `matchQuickAddShortcut(event, apple)` and `isApplePlatform()` that follow the design, ignoring repeat, composition, Shift, Alt, and the other platform's modifier.
    - _Requirements: 1.7, 1.15, 1.16, 1.18, 17.24_

  - [x] 3.8 Write the property test for the shortcut matcher
    - **Property 23: The shortcut matcher accepts exactly the defined combination**
    - Generate event shapes, platforms, and key layouts, and compare with a direct predicate.
    - **Validates: Requirements 1.7, 1.15, 1.16, 17.24**

- [x] 4. Implement the pure server allowance domain
  - [x] 4.1 Add Asia/Kolkata date helpers and the named threshold constants
    - Add `backend/src/domain/kolkataTime.js` with fixed +05:30 conversion from a UTC timestamp to a Kolkata date.
    - Export `LARGE_ENTRY_PERCENT = 25` and `LARGE_ENTRY_FLOOR_MINOR = 100000` from `backend/src/domain/allowance.js` as the only place those literals appear.
    - _Requirements: 10.2, 10.15, 18.26_

  - [x] 4.2 Implement `calculateTodayAllowance`
    - Complete `backend/src/domain/allowance.js` with Counted_Expense attribution, Today_Spent, Allowance_Basis, Today_Allowance with the zero floor and half-up rounding through the existing `divideHalfUp`, Left_Today, overToday, zero reasons, usedPermille with `BigInt`, the excluded-today count and total, the Large_Entry_Threshold, and the not-applicable result for another month.
    - Treat a record with no spending date and an unparseable creation time as attributed to no day, and read the mark as `value === 1`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13, 10.14, 10.15, 10.16, 10.20, 10.21, 10.22, 10.23, 10.24, 17.1, 18.12, 18.13_

  - [x] 4.3 Implement the ordered calculation explanation steps
    - Add the steps for spendable budget, expenses used with counted and excluded-today expenses listed separately, Remaining_Spendable, addition of Today_Spent, division with rounding metadata, floor at zero, subtraction of Today_Spent, and the reference to the Daily_Spending_Guide with source references for each Today expense mark.
    - _Requirements: 10.18, 10.19, 10.25_

  - [x] 4.4 Write the property test for the Today_Allowance reference model
    - **Property 12: Today_Allowance matches the reference model**
    - Compare `calculateTodayAllowance` with a day-by-day reference walk over generated plans, ledgers, and local dates for at least 100 cases.
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 17.14, 17.16**

  - [x] 4.5 Write the property test for counted expenses
    - **Property 13: Counted expenses move Left_Today and not Today_Allowance**
    - Create, update, and delete Counted_Expenses over generated ledgers and verify the allowance is unchanged and Left_Today moves by exactly the amount.
    - **Validates: Requirements 10.8, 17.14, 17.15**

  - [x] 4.6 Write the property test for the today-only exclusion mark
    - **Property 15: Allowance_Exclusion is a today-only mark**
    - Set and clear the mark over generated ledgers, compare the totals, buckets, projections, and guide, compare an expense dated Today with the same expense on another day, and verify the three-group partition and the reported count and total.
    - **Validates: Requirements 10.20, 10.21, 10.22, 17.20, 17.21, 17.22, 18.12, 18.13**

  - [x] 4.7 Write the property test for calendar, rounding, and boundary rules
    - **Property 16: Calendar, rounding, and boundary rules hold**
    - Generate instants around Asia/Kolkata midnight under several process time zones, month starts and ends, non-positive bases, zero budgets, and safe-integer extremes, and check the days remaining, zero reasons, progress bounds, and threshold formula.
    - **Validates: Requirements 10.2, 10.11, 10.12, 10.13, 10.14, 10.15, 10.23, 10.24**

  - [x] 4.8 Write allowance example tests
    - Cover a leap day, the first and last day of a month, the Asia/Kolkata midnight rollover, a zero spendable budget, an overspent month, an expense with no spending date, a past-month and a future-month entry, an entry saved with the mark and then undone, a Large_Entry equal to the threshold, and the minimum floor.
    - Add a source test that fails when the floor literal `100000` or `100_000`, a `* 25` threshold expression, or a comparison of a label length with a numeric literal appears outside `backend/src/domain/allowance.js` and `frontend/src/clarity/quickAdd/warning.ts`.
    - _Requirements: 17.18, 18.26_

- [x] 5. Add additive migrations and repositories
  - [x] 5.1 Add the additive migration for the exclusion column and the memory table
    - Extend `backend/src/db/index.js` with `addColumnIfMissing('expense_log', 'exclude_from_daily_allowance', 'INTEGER')`, `CREATE TABLE IF NOT EXISTS category_memory`, and `idx_category_memory_user_recency`, with no backfill and no change to any existing row.
    - _Requirements: 6.9, 16.6, 18.14, 18.22_

  - [x] 5.2 Map the exclusion column in the financial repository and expense records
    - Select `exclude_from_daily_allowance` in `financialRepository.loadPeriod`, map it to `excludeFromDailyAllowance` (`value === 1`), and return it as a boolean from `expenseRecordFromRow` and from the month's expense list, with `false` when absent.
    - _Requirements: 10.2, 18.14, 18.18_

  - [x] 5.3 Test migration idempotency and legacy-row preservation
    - Restore a pre-feature schema, seed legacy expenses and recurring definitions, run the migration twice, and assert row counts and values are unchanged, the new column is null for every old row, and legacy rows still export and correct.
    - _Requirements: 16.5, 16.6, 16.15_

  - [x] 5.4 Implement the category memory service
    - Add `backend/src/services/categoryMemory.js` with `list`, `upsert` with `expectedRevision`, one-statement `ON CONFLICT` upsert that increments the revision, same-batch eviction beyond 500 entries by `(updated_at, id)`, `remove` with the revision check, `removeAll`, `removeForCategory`, and `history` for the preceding 90 days limited to 500 Note_Keys.
    - Scope every statement by `user_id` and answer a missing or foreign record identically.
    - _Requirements: 5.3, 6.5, 6.6, 6.7, 6.9, 6.13, 15.3, 15.4, 16.10_

  - [x] 5.5 Write the property test for category memory invariants
    - **Property 10: Category memory keeps one entry per key, at most 500, per User**
    - Compare the service with a map-and-recency model over generated sequences of upserts, deletions, delete-alls, and custom-category deletions by several Users, including stale revisions and replays.
    - **Validates: Requirements 6.5, 6.6, 6.7, 6.9, 6.13, 15.3, 16.10, 17.10**

  - [x] 5.6 Cover category memory and the exclusion in export, deletion, and category removal
    - Add `category_memory` and its plain-language description to `GET /api/auth/export`, describe the exclusion in the `expenses` description, append `counted_in_daily_allowance` with `yes` or `no` as the last CSV column without changing the first five, and keep the formula-injection guard.
    - Add the `category_memory` delete statement, probe, and description to `backend/src/db/accountDeletion.js`, delete memory rows with a custom category in the same batch in `DELETE /categories/:id`, and add the `category_memory` record type to `operationalLog.js`.
    - _Requirements: 6.13, 6.15, 6.16, 6.17, 14.7, 18.19, 18.20, 18.22_

  - [x] 5.7 Write the property test for exports
    - **Property 27: Exports carry the exclusion exactly**
    - Generate expenses with and without the mark, parse the CSV back, and compare the JSON and CSV values, the final column, and the first five columns with the stored data.
    - **Validates: Requirements 17.26, 18.19, 18.20**

  - [x] 5.8 Write export, deletion, and cascade integration tests
    - Assert the JSON export holds a seeded `category_memory` row and the expense column, account deletion removes memory rows, an injected failure reports category memory through `ACCOUNT_DELETION_INCOMPLETE`, and deleting a custom category removes only its memory rows.
    - Update the existing export, deletion, and column-list tests for the new table and column.
    - _Requirements: 6.13, 6.15, 6.16, 6.17, 18.19, 18.20_

- [x] 6. Checkpoint - Ensure the pure modules and persistence tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Extend expense mutations and the clarity snapshot
  - [x] 7.1 Add `excludeFromDailyAllowance` to the expense create and update operations
    - Update the create and update normalizers in `backend/src/services/expenseMutations.js` to accept an optional boolean, reject any other type with 400 `INVALID_EXPENSE_EXCLUSION` that names the field, add the field to the normalized command only when `true`, and assign the column only when an update carries the field (`true` sets, `false` stores NULL).
    - Add the accepted constraint to `acceptedConstraints`, return the boolean on the mutation record, allow an update that carries only this field, and add `todayAllowance` to `affectedOutcomes` for the current month.
    - Leave the legacy create path and `legacyExpenseRecord` unchanged.
    - _Requirements: 4.6, 15.15, 16.4, 16.5, 18.7, 18.14, 18.17, 18.18_

  - [x] 7.2 Write expense field API tests
    - Assert create with and without the mark, replay returning the same change, non-boolean values returning 400 `INVALID_EXPENSE_EXCLUSION`, `PATCH` setting and clearing the mark with no change to any monthly outcome, an amount-only `PATCH` leaving the mark in place, and the legacy create route ignoring the field.
    - Update existing tests that compare a complete expense record so they expect the one added boolean.
    - _Requirements: 4.6, 15.15, 16.4, 16.5, 18.17, 18.18, 18.24_

  - [x] 7.3 Write the property test for parser output accepted by the server validator
    - **Property 7: Parsed entries are accepted by the server validator**
    - Import `normalizeExpenseCreateCommand` into a frontend test by relative path as test-only code, or write generated parser outputs to a fixture file that a backend test reads if the Vitest configuration refuses the path, and verify equal accepted values and parser limits no looser than the server.
    - **Validates: Requirements 4.1, 4.2, 4.3, 17.7**

  - [x] 7.4 Add the `todayAllowance` outcome and its explanation to the clarity service
    - Update `backend/src/services/clarityService.js` to build the sibling outcome `today-allowance:<month>` with `createDependentOutcome` and the same dependencies as `spending`, using the plan result the plan outcome produced, and to return `{ applicable: false, reason: 'not_current_month' }` with no explanation for any other month.
    - Add `today_allowance` to the outcome kinds in `outcomes.js`, accept `today-allowance:YYYY-MM` in the explanation route pattern and `explanationMonth`, and isolate a calculator exception to this outcome only.
    - _Requirements: 10.16, 10.17, 10.18, 10.19, 10.25, 11.10, 16.7_

  - [x] 7.5 Write the property test for non-counted changes and month isolation
    - **Property 14: Changes outside the counted set recalculate or are isolated**
    - Through `ClarityService`, change generated expenses that are not counted, expenses dated in other months, and snapshot months other than the current month, and compare with the expected Today values.
    - **Validates: Requirements 10.9, 10.10, 10.16, 17.17**

  - [x] 7.6 Write the property test for explanation reproduction
    - **Property 17: Explanations reproduce Today_Allowance**
    - Evaluate the stored calculation steps with the existing explanation evaluator and compare allowance, basis, and Left_Today, the separate listing of counted and excluded-today expenses, and the carried period and data version.
    - **Validates: Requirements 10.18, 10.19, 10.25**

  - [x] 7.7 Write snapshot compatibility and failure-isolation tests
    - Assert existing snapshot fields are byte-equal to the characterization fixture, `todayAllowance` is present for the current month and not applicable for other months, `monthlyPlan` and `spending` keep their values when only `todayAllowance` fails and the reverse, and missing or invalid salary and bill inputs mark it `missing_input` or `invalid_input` with the same corrective inputs.
    - Assert `GET /api/finance/explanations/today-allowance:<month>` reproduces the allowance and answers 400 for a malformed ID.
    - _Requirements: 9.12, 9.13, 9.14, 10.17, 10.23, 11.10, 16.5_

  - [x] 7.8 Write the property test for exactly-once saves under replay and concurrency
    - **Property 19: Quick Add saves exactly once under replay and concurrency**
    - Run generated entries with distinct keys, same-key replays, key reuse with a different body, and shuffled response orders against the real mutation service and compare with a reference ledger.
    - **Validates: Requirements 7.9, 7.14, 7.15, 17.11, 17.12**

  - [x] 7.9 Write the property test for save then undo
    - **Property 20: Save then undo restores the ledger and server outcomes**
    - Save generated entries, including entries with the mark and a category change in between, delete by the returned ID even when another expense has the same amount, note, and date, and compare the ledger and the server values with their values before the save.
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 8.13, 17.13, 18.21**

- [x] 8. Add the Memory API, hints, server flag, and notice version
  - [x] 8.1 Add the server flag and the flag-aware notice version
    - Add `quickAddEnabled` to `readServerFeatureFlags` in `backend/src/rollout/featureFlags.js`, make the current notice version in `claritySettings.js` 2 while the flag is on and 1 otherwise, and add the `category_memory` category and `category_suggestion` outcome to the version 2 notice.
    - Make the gate on the memory write read the required version from the settings service at request time, and leave every existing gate defaulting to the current version.
    - _Requirements: 6.18, 15.13, 16.18, 16.19, 16.20, 16.21, 16.22_

  - [x] 8.2 Implement the Memory API and hints routes
    - Add `backend/src/routes/quickAdd.js` behind `authRequired` with `GET /api/finance/quick-add/hints`, `PUT /api/finance/category-memory`, `DELETE /api/finance/category-memory/:id`, and `DELETE /api/finance/category-memory`, and mount it without changing the CORS allowlist, request-size limit, or authentication scheme.
    - Enforce the closed body schema, the 1 KB limit, the normalized Note_Key, an available category, the revision check (409 `MEMORY_REVISION_CONFLICT`), idempotent replay, eviction, the same 404 for missing and foreign IDs, `QUICK_ADD_DISABLED` for writes while the server flag is off, and the data-use gate for writes only.
    - _Requirements: 5.3, 6.5, 6.6, 6.7, 6.9, 6.13, 13.7, 14.7, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.13, 15.14, 16.8, 16.19_

  - [x] 8.3 Write the property test for closed, typed request schemas
    - **Property 25: Request schemas are closed and typed**
    - Fuzz Memory_API bodies and `excludeFromDailyAllowance` values with extra properties, wrong types, prototype-like keys, oversized strings, and Unicode controls, and verify every expense record and list row carries a boolean.
    - **Validates: Requirements 15.5, 15.6, 15.7, 15.8, 15.15, 18.18**

  - [x] 8.4 Write Memory API and notice integration tests
    - Cover authentication on every new route and the unchanged anonymous allowlist in the route inventory test, cross-User read, write, and delete attempts, the identical 404 for foreign and missing IDs, the 428 gate, the 404 `QUICK_ADD_DISABLED` answer, the revision check, replay, the 500-entry cap, delete-all, and hints that contain only the caller's data.
    - Assert the notice is version 1 with the flag off and version 2 with it on, a User who acknowledged only version 1 can still read, export, correct, and delete existing records and is blocked only from new inputs, and turning the flag off does not re-prompt a User who acknowledged version 2.
    - _Requirements: 6.9, 6.13, 14.7, 15.1, 15.2, 15.3, 15.4, 15.9, 15.10, 15.13, 15.14, 16.19, 16.20, 16.21, 16.22_

  - [x] 8.5 Write the property test for log redaction
    - **Property 26: Operational logs never contain entry values**
    - Generate amounts, notes, Note_Keys, and categories, run create, update, undo, memory write, and failure flows, capture the log output, and search it for every generated value.
    - **Validates: Requirements 14.4, 17.19**

- [x] 9. Mark auto-posted recurring expenses
  - [x] 9.1 Add the exclusion mark to the `materializeRecurring` insert
    - In `backend/src/routes/finance.js`, add `exclude_from_daily_allowance` to the column list of the `INSERT INTO expense_log` statement and the literal `1` to its values, and change nothing else: the claim `UPDATE`, the month and day logic, the process clock, the note text, and the error logging stay as they are.
    - Write the mark regardless of the three flags, and leave expenses posted before this feature unmarked.
    - _Requirements: 18.15, 18.23, 18.25_

  - [x] 9.2 Write the property test for auto-posted recurring expenses
    - **Property 28: Auto-posted recurring expenses are marked and otherwise unchanged**
    - Generate active definitions, due days, and dates on the isolated test database, compare each posted row with the pre-feature output with the mark as the only difference, run a second time and verify nothing is created, and verify a row dated Today is outside Today_Spent and inside Remaining_Spendable.
    - **Validates: Requirements 17.27, 18.23, 18.25**

  - [x] 9.3 Write recurring integration tests
    - Assert a definition due today posts one marked expense, `GET /finance/clarity` lists it in `excludedToday` and lowers `todayAllowance` like the same expense on another day, its category total, bucket, total spending, and projected savings include it, an amount-only `PATCH` keeps the mark, clearing it makes the expense counted, and the same flow writes the mark with every flag off.
    - Run the existing recurring test and the recurring tests in the account, journey, and analytics suites and confirm their expectations are unchanged except for the one added value in complete-record comparisons.
    - _Requirements: 10.9, 17.18, 17.28, 18.23, 18.24, 18.25_

- [x] 10. Checkpoint - Ensure the backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Build the frontend flags, calendar, and shared plumbing
  - [ ] 11.1 Add the Quick_Add_Flag, the enabled state, and the contract types
    - Add `readQuickAddFlag` with the same fail-closed reading as the rollout flag, a `quickAddEnabled` value that requires both flags, and the `TodayAllowanceValue`, `MemoryEntry`, `HistoryEntry`, and expense mark types in `frontend/src/clarity/contracts.ts` as optional fields that old servers omit.
    - Keep every Quick Add surface, request, and the mark control behind this state.
    - _Requirements: 1.18, 1.19, 16.1, 16.2, 16.12, 16.13, 16.16_

  - [ ] 11.2 Add the per-request timeout for Quick Add commands
    - Add an optional `timeoutMs` to the API request helper in `frontend/src/api.ts` and to the mutation runner command, abort at 60 seconds, and surface a timeout as a failed command with same-key retry.
    - Leave every existing caller on its current no-timeout behavior.
    - _Requirements: 7.7, 7.13, 7.23_

  - [ ] 11.3 Implement the Asia/Kolkata calendar helper and apply it to `currentMonth()`
    - Add `frontend/src/clarity/quickAdd/kolkata.ts` with `kolkataToday`, `kolkataMonth`, `observeServerTime`, `kolkataNow`, `useKolkataToday`, and `useKolkataMonth`, re-evaluating every 30 seconds and when the page becomes visible.
    - Make `currentMonth()` in `frontend/src/money.ts` return the Kolkata month while the Rollout_Flag is on and keep the device-clock behavior while it is off, and make Home, Plan, Spending, Goals, and Trips read the month at render time so a rollover re-keys them without a reload.
    - _Requirements: 10.15, 11.18, 11.21, 11.22, 11.23_

  - [ ] 11.4 Write the property test for the Kolkata calendar helper
    - **Property 24: The Kolkata calendar helper agrees with the reference**
    - Compare the helper with `Intl.DateTimeFormat` for `Asia/Kolkata` over generated instants and device clock offsets under several process time zones, and verify use of the observed server offset.
    - **Validates: Requirements 11.18, 11.21**

  - [ ] 11.5 Add the confirmed-expense change bus
    - Add `frontend/src/clarity/quickAdd/expenseEvents.ts` with publish and subscribe for confirmed expense changes, and publish from the Quick Add actions only after the mutation runner confirms a result.
    - _Requirements: 7.17, 7.21_

  - [ ] 11.6 Write flag and month tests
    - Assert the flag reading for absent, malformed, `1`, `true`, and mixed-case values, that the Quick_Add_Flag has no effect while the Rollout_Flag is off, and that a device clock in a different month makes Home, Plan, Spending, Goals, and Trips request and show the Kolkata month with Quick Add on and off and the device month with the Rollout_Flag off.
    - Update the existing `rollout.test.ts` and `App.rolloutMatrix.test.tsx` for the new combinations.
    - _Requirements: 1.18, 11.22, 11.23, 16.1, 16.12, 16.13_

- [ ] 12. Build the Quick Add store, answer, memory client, and actions
  - [ ] 12.1 Implement the Entry_Answer builder
    - Add `frontend/src/clarity/quickAdd/answer.ts` with `buildEntryAnswer(envelope, entry, today)` returning a structured model of message keys and references to server money values for every row of the design's answer table, with no addition, subtraction, multiplication, or division of money.
    - Cover the current month, a saved mark, an unconfirmed mark, another month, missing pay with a link to the Plan pay form, invalid input, calculation failure with one recalculate action, a server without Today fields, and the result after undo.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.17, 9.19, 9.20, 16.7, 16.17_

  - [ ] 12.2 Write the property test for server-only answer values
    - **Property 22: Entry_Answer uses only server values**
    - Generate mutation responses in every outcome state and check that every money reference exists in the response, the over-text comes from server fields, and no value is invented.
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 9.10, 9.11**

  - [ ] 12.3 Implement the memory client and the hints query
    - Add `frontend/src/clarity/quickAdd/memoryClient.ts` with the hints read once per page load (`staleTime: Infinity`, updated in place after a change), memory writes and deletes with per-entry status, same-state retry, and the loading, unavailable, and disabled states.
    - Use the remembered choices only to suggest categories in Quick Add, and treat 404 `QUICK_ADD_DISABLED` as memory unavailable while suggesting from the remaining sources.
    - _Requirements: 5.14, 5.15, 6.5, 6.8, 6.11, 6.12, 6.14, 7.20, 13.7, 16.8_

  - [ ] 12.4 Implement the Quick Add store and provider
    - Add `frontend/src/clarity/quickAdd/quickAddStore.ts` and `QuickAddProvider` with the draft line, ordered entries, phases, undo deadlines with pause, memory status, announcements, five-pending submission limit, newest-snapshot-wins answers, and the 5-second waking-up text.
    - Keep everything in memory only, complete each save without a page reload or page-wide loading state, reset it through `subscribeToFinancialStateClear`, and mount the provider inside the existing financial and mutation providers.
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.12, 7.13, 7.14, 7.18, 7.19, 8.1, 8.9, 8.10, 8.11, 9.15, 9.16, 13.4, 13.5, 13.6_

  - [ ] 12.5 Implement the Quick Add actions
    - Add `frontend/src/clarity/quickAdd/useQuickAddActions.ts` with `submit`, `retry`, `edit`, `discard`, `undo`, `changeCategory`, `setExclusion`, `forgetMemory`, and `recalculate`, built on the existing mutation runner with scopes `new-expense:<cid>` and `expense:<id>`.
    - Send only the structured amount, category, note, `spentOn`, and the mark when requested, with a CSPRNG `Idempotency-Key` and the contract header, offer same-key retry except for validation failures, send undo without a version, restore memory by compensation with a revision check, handle 404 as already removed, and report each confirmed change through the existing measurement call only.
    - _Requirements: 4.5, 4.7, 4.8, 6.2, 6.3, 6.4, 6.5, 6.8, 7.1, 7.7, 7.8, 7.9, 7.10, 7.11, 7.16, 7.22, 7.23, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.12, 8.13, 13.8, 14.1, 14.6, 15.11, 15.12, 16.17, 18.7, 18.17_

  - [ ] 12.6 Write the property test for entry isolation and ordering
    - **Property 21: The entry store keeps entries isolated and ordered**
    - Drive the store with a fake clock through generated submissions, successes, failures, retries, undos, pauses, and out-of-order responses, and compare with a model of statuses, keys, deadlines, and the current answer.
    - **Validates: Requirements 7.12, 7.14, 8.9, 8.10, 9.15, 9.16, 13.5, 13.6**

  - [ ] 12.7 Write the property test for undo restoring category memory
    - **Property 11: Undo restores category memory unless it changed later**
    - Generate memory states and entries that created or replaced a key, undo with and without a later change, and verify restoration, removal, preservation of the newer change, and no effect on other keys.
    - **Validates: Requirements 8.6**

  - [ ] 12.8 Write store and action unit tests
    - Cover same-key retry and the new key after Edit, no retry for validation failures, the data-use notice answer with retry after review, the 5-second waking-up text and the 60-second timeout with fake timers, the Undo window with pause, expiry, and undo after a category change, already-removed undo, undo failure with retry, and the memory-not-remembered retry.
    - Assert no write to local storage, session storage, cookies, the address, or the console, and discarding of all state on sign-out.
    - _Requirements: 7.7, 7.8, 7.10, 7.13, 7.16, 7.18, 7.19, 7.23, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 14.3_

- [ ] 13. Build the Quick Add user interface
  - [ ] 13.1 Implement the input, preview, warning, and category choice
    - Add `frontend/src/components/quickadd/` with `QuickAddInput` (visible label, `aria-describedby` with examples, `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="none"`, `spellcheck="false"`, 200-character limit, Enter handling), `ParsedPreview`, `EntryWarning` with the two save buttons, and `CategoryChoice` as a native `<select>` with "Forget this".
    - Show the preview synchronously within 100 ms, keep it non-live, label Today, Future date, other month, No note, and Default, show the recurring-payment hint without blocking, render every note, category, and reason as plain text, and keep the input interactive before snapshot and hints load.
    - Keep the input editable and disable submission with the gate reason while the Data_Use_Gate pauses inputs, gating submissions in the same way as the existing expense form.
    - _Requirements: 1.9, 1.13, 1.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.12, 3.13, 3.14, 4.7, 5.12, 5.14, 5.15, 6.1, 6.12, 12.1, 12.2, 12.14, 12.15, 13.1, 14.3, 16.11, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.9_

  - [ ] 13.2 Implement entry status rows, the immediate answer, and the undo toast
    - Add `EntryStatusRow` and `EntryStatusList` for pending, saved, failed, removing, undone, and undo-failed states with Retry, Edit, Discard, Undo with static "available for 8 seconds" text and a shrinking bar only when motion is allowed, category change, exclusion action, and memory retry, with Undo named by amount and note.
    - Add `ImmediateAnswer` with the calculated-result labels and the Today_Allowance explanation control, and `UndoToast` for an entry inside its window when no Quick Add surface is mounted.
    - _Requirements: 6.3, 6.8, 7.2, 7.6, 7.8, 8.1, 8.3, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.14, 9.16, 9.17, 9.19, 9.20, 12.14, 13.4, 13.5_

  - [ ] 13.3 Implement the panel, dialog, floating action, and shortcut host and mount them in the shell
    - Add `QuickAddPanel` (variants `inline` and `dialog`) that composes the input, preview, warning, category choice, status list, and answer, then add `QuickAddDialog` on the existing `Modal`, `QuickAddFab` (at least 48 by 48 CSS pixels, clear of the tab bar, safe area, and toast area, publishing `--quick-add-fab-h`), and `QuickAddShortcutHost` with one `keydown` listener, the other-modal and Data_Use_Gate checks, `preventDefault` only when it opens or focuses Quick Add, and no listener while disabled or signed out.
    - Mount them in `frontend/src/components/Shell.tsx` for the User view only, move the toast stack above the floating action, show the shortcut text beside the input where the tab bar is not shown, set `aria-keyshortcuts` on every opener, keep an entry saving when the dialog closes, return focus to the previous element, and show the nonblocking failed-entries status with an action that opens Quick Add.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19, 12.5, 12.6_

  - [ ] 13.4 Write Quick Add component tests
    - Cover preview text for every state, parse-problem text tied to the input and announced without moving focus, no request on invalid submit, the empty-line Enter, the warning copy for bill, large, and both, the two save buttons and Enter behavior, the request body with and without the mark, the dialog open, close, focus return, and pending-entry continuation, and the shortcut from another text field, with the dialog open, with another modal open, with Shift held, during composition, and with the flag off.
    - Cover the answer text for each row of the design's answer table and the Retry, Edit, Discard, and Undo controls of the status rows.
    - _Requirements: 1.9, 1.10, 1.11, 1.15, 1.16, 1.17, 1.18, 3.2, 3.6, 3.7, 3.8, 3.9, 3.10, 3.12, 3.13, 3.14, 4.5, 7.1, 18.5, 18.6, 18.7_

- [ ] 14. Deliver the Home headline
  - [ ] 14.1 Implement `TodayHeadline`
    - Add `frontend/src/components/dashboard/TodayHeadline.tsx` that shows "You can spend ₹X today", Left_Today beside it with "left today", Today_Spent and the date, a decorative progress bar plus a text label from `usedPermille`, the over-today text, the zero state with each reason, the "not counted today" line, "How this was calculated" that stays open while values update, the calculated-result labels, and the missing-pay, invalid-input, calculation-failed, server-without-field, stale, loading, and region-error states.
    - Format server values only and never calculate money in the browser.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.16, 11.17, 11.20, 16.7_

  - [ ] 14.2 Integrate the headline and Quick Add into the clarity Home
    - Update `frontend/src/pages/Dashboard.tsx` so that, while Quick_Add_Enabled, the order is the page decision header, `TodayHeadline`, the inline Quick Add panel, the quick-action tiles, and the existing monthly summary with the unchanged Daily spending guide, with the month from `useKolkataMonth()`.
    - Re-read the snapshot within 60 seconds of a date change and when Home becomes visible, update the headline within 100 ms of a confirmed save, correction, or undo, and leave the headline unchanged for an entry in another month.
    - _Requirements: 1.1, 9.7, 11.1, 11.13, 11.14, 11.15, 11.18, 11.19, 11.21, 13.1_

  - [ ] 14.3 Write headline and Home tests
    - Cover the available, over, zero with each reason, missing pay, invalid input, calculation failed, region loading, region error, stale, server-without-field, and marked-entry states, the Home order at 320, 390, 768, 1024, and 1440 CSS pixels, the unchanged Daily spending guide, and the midnight and month rollover re-read.
    - Update `Dashboard.clarity.test.tsx` for the new order and flags.
    - _Requirements: 1.1, 11.1, 11.2, 11.3, 11.4, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.14, 11.15, 11.19, 11.20_

- [ ] 15. Integrate Spending and Settings
  - [ ] 15.1 Show and edit the exclusion on the Spending page and update mounted views
    - Update `frontend/src/components/spending/ExpenseRows.tsx` and `frontend/src/clarity/spendingInputs.ts` to show "Not counted in daily allowance" beside each marked expense, including each auto-posted one, add the labelled checkbox with the note that it affects only the day the expense is dated, and send the field through the existing update operation only when it changed, while Quick_Add_Enabled.
    - Subscribe the Spending list in `useSpendingChanges.ts` and the logging streak card to the change bus so a Quick Add confirmation updates them without a refetch.
    - _Requirements: 7.17, 7.21, 16.1, 18.15, 18.16, 18.17, 18.24_

  - [ ] 15.2 Add the category memory panel and notice labels
    - Add `CategoryMemoryPanel` to `frontend/src/pages/Settings.tsx` while Quick_Add_Enabled, listing each note and category with delete one and delete all, and add the `category_memory` and `category_suggestion` labels to `frontend/src/clarity/dataUseLabels.ts`.
    - Make the next suggestion stop using a deleted entry, and show nothing when the flag is off.
    - _Requirements: 6.10, 6.11, 6.18, 14.7, 16.1, 16.3_

  - [ ] 15.3 Write Spending and Settings tests
    - Assert the badge text, the checkbox, a request body that contains only changed fields, the Spending list and streak card updates from a Quick Add confirmation without a refetch, the memory panel list, delete one and delete all, and the notice labels.
    - Update `Spending.clarity.test.tsx`, `Spending.behavior.test.tsx`, and the Shell tests for the new elements and the flag-off snapshots.
    - _Requirements: 6.10, 6.11, 7.17, 7.21, 16.1, 18.15, 18.16, 18.17_

- [ ] 16. Complete accessibility and responsive behavior
  - [ ] 16.1 Add Quick Add and headline styles and the announcer
    - Add the styles for the panel, preview, warning, status rows, floating action, dialog, and headline in `frontend/src/styles.css` and component CSS, using existing theme tokens for light and dark, at least 44 by 44 CSS pixel controls, `overflow-wrap: anywhere`, one-column layout from 320 to 3840 CSS pixels, and 200 percent text without overlap.
    - Add the single polite announcer that announces a confirmed save, undo, and error once each and never announces typing or pending states, and static Undo text with no movement under reduced motion.
    - _Requirements: 1.3, 11.5, 12.3, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 9.18_

  - [ ] 16.2 Write accessibility and responsive tests
    - Run axe on the panel, preview, warning, status rows, headline, and memory panel, verify keyboard-only operation of typing, saving, choosing a category, Undo, retry, edit, discard, and closing, focus order and containment, and focus retention while values change.
    - Add contrast assertions in both themes, reduced-motion checks, and layout checks at 320, 390, 768, 1024, 1440, and 3840 CSS pixels and at 200 percent text, using the existing contrast and layout specs.
    - _Requirements: 1.2, 1.3, 1.14, 11.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15_

- [ ] 17. Checkpoint - Ensure the frontend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Complete integration, end-to-end acceptance, and rollback validation
  - [ ] 18.1 Add end-to-end acceptance scenarios for Quick Add and the headline
    - Add Playwright specs and fixtures that cover typing, preview, Enter, the saved row, the answer, and Undo from Home and from the dialog on another page, five concurrent entries with in-order and out-of-order responses, one failed entry that leaves the others untouched, retry with the same key, Edit with a new key, the warning flow with both save buttons, a recurring expense dated Today that is outside the headline's spent amount, the Home order and floating action geometry, and the Spending page and streak card updating without a reload.
    - Assert no document reload, no page-wide loading state, and 100 ms scoped feedback on the supported test profile, using only isolated fixtures and non-production credentials.
    - _Requirements: 7.2, 7.3, 7.6, 7.12, 7.14, 7.15, 8.1, 8.2, 8.5, 9.3, 9.19, 11.1, 11.20, 13.2, 13.3, 13.4, 13.5, 18.5, 18.6, 18.7, 18.23_

  - [ ] 18.2 Add rollout, rollback, and old-server tests
    - Cover the four client flag combinations with the two server flag states, with Quick Add off showing no Quick Add request, no element, and Home, Spending, Settings, and navigation equal to the pre-feature snapshots except for the Kolkata month rule.
    - Flip on to off and off to on and assert saved expenses, marks, and memory rows remain, monthly totals, the guide, exports, the monthly review, and the logging streak are identical, and use old-server fixtures with no `todayAllowance`, no memory routes, and no mark support to assert the unavailable headline, memory-free suggestions, and the saved-and-counted message with the update action.
    - _Requirements: 16.1, 16.2, 16.3, 16.5, 16.7, 16.8, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17, 16.19_

  - [ ] 18.3 Add privacy, request-count, and measurement assertions
    - Assert the browser calls no host other than the API base, writes no entry value to storage, cookies, the address, or the console, sends at most one expense write and one memory write per entry, reads hints once per page load, and never polls.
    - Assert no new Product_Analytics event name, the existing value-free event only when analytics is enabled, unchanged saves, answers, and headline when analytics is disabled, and the existing reload and page-wide-loading measurements staying at zero.
    - _Requirements: 7.18, 7.20, 13.7, 13.8, 14.1, 14.2, 14.3, 14.5, 14.6, 14.8_

  - [ ] 18.4 Keep the legacy and existing contract suites green
    - Run and update where the one new property, export table, or CSV column requires it the existing suites `legacyContracts`, `legacyPlanParity`, `canonicalRoutes.integration`, `rolloutRollback.integration`, `expenseMutations`, `clarityRoutes`, `accountDataControls`, `migrations`, and `claritySettings` on the backend, and `Dashboard.clarity`, `Shell.*`, `Spending.*`, and `App.rolloutMatrix` on the frontend.
    - Assert that no existing expectation about legacy field names, request behavior, or response behavior changed.
    - _Requirements: 16.4, 16.5, 17.28, 18.18, 18.20_

- [ ] 19. Update configuration and documentation for the new flags
  - [ ] 19.1 Document and configure the flags
    - Add `VITE_QUICK_ADD_ENABLED=false` with a comment to `frontend/.env.production.example`, add `QUICK_ADD_ENABLED=false` with a comment to `backend/.env.example`, and add both keys with the value `"false"` to `render.yaml` next to the existing rollout flags.
    - Update `README.md` with both flags and their defaults, the release order of server flag first and client flag second, the rollback steps for each, the notice version change, the Kolkata month rule, the recurring-expense mark, the CSV column, and the named threshold constants.
    - _Requirements: 16.9, 16.13, 16.18, 18.26_

- [ ] 20. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- The backend implementation language is JavaScript (ES modules); the frontend implementation language is TypeScript/TSX, matching the current repository and the completed design.
- Property tasks are required and each maps one-to-one to a numbered correctness property in `design.md`, Properties 1 through 28; each must run at least 100 generated cases and carry the comment `Feature: quick-add-daily-answer, Property <number>: <property title>`.
- Test tasks remain required because this feature changes money calculations, persistence, privacy, and accessibility, and the owner wants every test run. No optional enhancement tasks were added.
- Database changes are additive and idempotent. Existing records, routes, and legacy response fields remain available through rollout and rollback, and nothing is backfilled.
- The Large_Entry percentage and floor are named constants in `backend/src/domain/allowance.js`, and the Bill_Match minimum label length is a named constant in `frontend/src/clarity/quickAdd/warning.ts`. Each is the only place its literal appears.
- Automated browser tests must use isolated fixtures and non-production credentials; no task deploys or modifies production resources.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "2.2", "3.7", "4.1"] },
    { "id": 1, "tasks": ["2.3", "2.4", "3.1", "3.8", "4.2", "5.1"] },
    { "id": 2, "tasks": ["2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "3.2", "3.3", "3.5", "4.3", "4.4", "4.5", "4.6", "5.2", "5.3", "5.4"] },
    { "id": 3, "tasks": ["3.4", "3.6", "4.7", "4.8", "5.5", "5.6"] },
    { "id": 4, "tasks": ["5.7", "5.8"] },
    { "id": 5, "tasks": ["6"] },
    { "id": 6, "tasks": ["7.1", "8.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4", "7.8", "8.2"] },
    { "id": 8, "tasks": ["7.5", "7.6", "7.7", "7.9", "8.3", "8.4", "8.5", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3"] },
    { "id": 10, "tasks": ["10"] },
    { "id": 11, "tasks": ["11.1", "11.2", "11.3", "11.5"] },
    { "id": 12, "tasks": ["11.4", "11.6", "12.1", "12.3", "14.1"] },
    { "id": 13, "tasks": ["12.2", "12.4", "15.2"] },
    { "id": 14, "tasks": ["12.5"] },
    { "id": 15, "tasks": ["12.6", "12.7", "12.8", "13.1", "15.1"] },
    { "id": 16, "tasks": ["13.2", "15.3"] },
    { "id": 17, "tasks": ["13.3"] },
    { "id": 18, "tasks": ["13.4", "14.2"] },
    { "id": 19, "tasks": ["14.3", "16.1"] },
    { "id": 20, "tasks": ["16.2"] },
    { "id": 21, "tasks": ["17"] },
    { "id": 22, "tasks": ["18.1", "18.2", "18.3", "19.1"] },
    { "id": 23, "tasks": ["18.4"] },
    { "id": 24, "tasks": ["20"] }
  ]
}
```
