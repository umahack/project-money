# Requirements Document

## Introduction

The current data-use notice renders as a large expanded card above every signed-in page (`DataUseGate` inside `Shell`), and users find it hard to read in that position. This feature replaces the full notice and its acknowledgement control with a dedicated full page at route `/agreement`, reachable after login. The page shows a short plain-language summary, a "Read full details" expander with the complete notice, an optional Product Analytics toggle, links to `/terms` and `/privacy`, and a primary "I agree and continue" button that redirects to the destination the user originally requested.

While the notice is required (`Data_Use_Gate` status `required`), signed-in navigation redirects to the Agreement_Page, except for `/settings`, `/admin` and its sub-routes, and the Agreement_Page itself. A secondary "Not now, just look around" link lets the user continue immediately with new entries paused: existing data stays readable, and correction, export, deletion, and turning Product Analytics off stay available. The "Not now" choice is held only in memory for the current sign-in and is cleared on sign-out or when the signed-in user changes; a full page reload asks again. This feature changes no backend behavior and stays behind the existing Rollout_Flag: with the flag off, the application is unchanged and the Agreement_Page is not routed.

## Glossary

- **Agreement_Page**: The dedicated full page at route `/agreement`, rendered inside the signed-in session but outside `Shell` (no top navigation, bottom navigation, or Core Promise strip). It shows the plain-language summary, the "Read full details" expander, the optional Product Analytics toggle, the `/terms` and `/privacy` links, the primary "I agree and continue" button, and the secondary "Not now, just look around" link.
- **Data_Use_Gate**: The existing `DataUseGateProvider` context value (`status`, `settings`, `acknowledge`, `setAnalytics`, `reason`, and related fields) that reports whether the current notice is acknowledged. Its `status` is one of `disabled`, `loading`, `error`, `required`, or `acknowledged`.
- **Notice**: The versioned data-use notice content returned by the server as `settings.dataUseNotice`, rendered through the existing `DataUseNotice` component and `dataUseLabels` functions. The Agreement_Page introduces no new legal claims; its summary is derived only from this content.
- **Paused_Entries**: The state in which `Data_Use_Gate.status` is `required` and the user has chosen "Not now, just look around" for the current sign-in, so new financial-entry submission stays off while viewing, correcting, exporting, deleting, and Product Analytics opt-out stay available.
- **Rollout_Flag**: The existing `VITE_FINANCIAL_CLARITY_ENABLED` flag read by `selectFinancialClarityRollout()`. With it off, `Data_Use_Gate.status` is always `disabled` and this feature has no effect.
- **Not_Now_Choice**: The in-memory boolean recording that the signed-in user selected "Not now, just look around" during the current sign-in. It is never written to `sessionStorage`, `localStorage`, or any other persistent store, and it resets to false on sign-out, on a change of signed-in user, or on a full page reload.
- **Intended_Destination**: The signed-in route the user was navigating to, or attempting to stay on, when the redirect to the Agreement_Page occurred, carried in router navigation state.
- **Exempt_Route**: A signed-in route that the redirect to the Agreement_Page never applies to: `/settings`, `/admin`, every route under `/admin/`, and `/agreement` itself.

## Requirements

### Requirement 1: Dedicated Agreement Page

**User Story:** As a signed-in user who must acknowledge the data-use notice, I want a dedicated page that explains data use clearly, so that I can read it without a cluttered, hard-to-read card.

#### Acceptance Criteria

1. WHEN the Rollout_Flag is on and the Data_Use_Gate status is `required` for a signed-in user who navigates to a route other than an Exempt_Route, THE Agreement_Page SHALL render in place of that route with the attempted location carried as the Intended_Destination.
2. WHILE the Agreement_Page is rendered, THE Agreement_Page SHALL display a short plain-language summary derived from `settings.dataUseNotice`, a "Read full details" expander, a `/terms` link, a `/privacy` link, a primary "I agree and continue" control, and a secondary "Not now, just look around" control.
3. WHEN a user activates "Read full details", THE Agreement_Page SHALL expand to show the complete Notice content rendered by the existing `DataUseNotice` component.
4. WHERE the Data_Use_Gate reports Product Analytics as available, THE Agreement_Page SHALL display a Product Analytics toggle that reflects and updates the same setting as the existing Settings analytics control.
5. THE Agreement_Page SHALL render inside the authenticated session and outside the `Shell` layout, with no top navigation, bottom navigation, or Core Promise strip.
6. WHEN the Agreement_Page mounts, THE Agreement_Page SHALL move focus to its heading.

### Requirement 2: Agreeing Continues to the Intended Destination

**User Story:** As a signed-in user who agrees to the notice, I want to continue exactly where I was heading, so that agreeing does not interrupt what I came to do.

#### Acceptance Criteria

1. WHEN a user activates "I agree and continue" and the Data_Use_Gate acknowledgement succeeds, THE Agreement_Page SHALL navigate to the Intended_Destination.
2. IF the Agreement_Page was reached with no Intended_Destination recorded, THEN THE Agreement_Page SHALL navigate to the admin console for an admin user and to the signed-in home route for every other user, matching the existing `postAuthDestination` targets.
3. WHILE the acknowledgement request for "I agree and continue" is in progress, THE Agreement_Page SHALL disable the "I agree and continue" control and announce that the request is in progress.
4. IF the acknowledgement request for "I agree and continue" fails, THEN THE Agreement_Page SHALL display a retry option and SHALL NOT navigate away from the Agreement_Page.
5. THE "I agree and continue" control SHALL be at least 44 by 44 CSS pixels in its clickable area.

### Requirement 3: Read-Only Escape With Paused Entries

**User Story:** As a signed-in user who is not ready to decide, I want to look around while leaving new entries paused, so that I am not forced through the notice before I am ready.

#### Acceptance Criteria

1. WHEN a user activates "Not now, just look around" on the Agreement_Page, THE Agreement_Page SHALL set the Not_Now_Choice to true for the current sign-in and navigate to the Intended_Destination.
2. WHILE the Not_Now_Choice is true and the Data_Use_Gate status is `required`, THE application SHALL NOT redirect the signed-in user to the Agreement_Page.
3. WHILE Paused_Entries applies, THE application SHALL keep viewing of existing data, correction of existing records, export, account deletion, and turning Product Analytics off available.
4. WHILE Paused_Entries applies, THE Data_Use_Gate SHALL report financial-entry submission as not enabled.
5. THE Not_Now_Choice SHALL be held only in memory for the current sign-in and SHALL NOT be written to `sessionStorage`, `localStorage`, or any other persistent store.
6. WHEN the signed-in user signs out or the signed-in user changes, THE application SHALL reset the Not_Now_Choice to false.
7. WHEN the application performs a full page reload while the Data_Use_Gate status is `required`, THE application SHALL treat the Not_Now_Choice as false and redirect to the Agreement_Page again on the next navigation that is not an Exempt_Route.

### Requirement 4: Paused-Entries Explanation Elsewhere in the Application

**User Story:** As a signed-in user whose entries are paused, I want the rest of the application to explain the pause and offer a way back to the notice, so that I understand why entries are off and how to turn them on.

#### Acceptance Criteria

1. WHILE Paused_Entries applies, THE compact Data_Use_Gate control in `Shell` SHALL display a paused-entries explanation that links to the Agreement_Page.
2. WHILE Paused_Entries applies and the user is on `/settings`, THE Settings page SHALL display a paused-entries banner that links to the Agreement_Page.
3. THE paused-entries explanation and the paused-entries banner SHALL use the existing `DATA_USE_REASON_ID` association so controls that reference it as their described-by target are unaffected.

### Requirement 5: Settings and Admin Stay Reachable

**User Story:** As a signed-in user who needs to export my data, correct a record, delete my account, or turn off Product Analytics, I want those controls to stay reachable while the notice is required, so that the required notice never blocks my existing rights over my data.

#### Acceptance Criteria

1. WHILE the Data_Use_Gate status is `required`, THE application SHALL NOT redirect a signed-in user away from `/settings`.
2. WHILE the Data_Use_Gate status is `required`, THE application SHALL NOT redirect an admin user away from `/admin` or any route under `/admin/`.
3. WHILE the Data_Use_Gate status is `required`, THE application SHALL NOT redirect a signed-in user away from `/agreement`.
4. WHILE the Data_Use_Gate status is `required`, THE Settings page SHALL keep the existing export, account-deletion, and Product Analytics opt-out controls enabled.

### Requirement 6: Unchanged Behavior When Not Required

**User Story:** As a user whose account does not need the notice, or whose notice is already acknowledged, I want the application to behave exactly as it does today, so that this feature changes nothing for me.

#### Acceptance Criteria

1. WHERE the Rollout_Flag is off, THE application SHALL NOT route `/agreement` and SHALL NOT redirect any signed-in route to it.
2. WHILE the Data_Use_Gate status is `acknowledged`, THE application SHALL NOT redirect the signed-in user to the Agreement_Page.
3. WHILE the Data_Use_Gate status is `disabled`, THE application SHALL NOT redirect the signed-in user to the Agreement_Page.
4. THIS feature SHALL introduce no backend route, schema, or contract change.

### Requirement 7: Loading and Error Handling

**User Story:** As a signed-in user, I want the Agreement_Page to behave sensibly while settings are loading or fail to load, so that a slow or failed request does not strand me or force an incorrect redirect.

#### Acceptance Criteria

1. WHILE the Data_Use_Gate status is `loading`, THE application SHALL NOT redirect the signed-in user to the Agreement_Page.
2. WHILE the Data_Use_Gate status is `error`, THE application SHALL NOT redirect the signed-in user to the Agreement_Page.
3. WHILE the Agreement_Page is rendered and the Data_Use_Gate status is `loading`, THE Agreement_Page SHALL display a polite status indicating that settings are being checked.
4. IF the Agreement_Page is rendered and the Data_Use_Gate status is `error`, THEN THE Agreement_Page SHALL display a retry control and SHALL NOT redirect away from the Agreement_Page.

### Requirement 8: Accessibility and Responsive Behavior

**User Story:** As a user relying on assistive technology, a magnifier, dark mode, or a reduced-motion setting, I want the Agreement_Page to remain usable, so that the page works the same way the rest of the application does.

#### Acceptance Criteria

1. THE Agreement_Page SHALL remain usable at viewport widths from 320 to 3840 CSS pixels and at 200 percent browser text zoom with no loss of content or function.
2. THE Agreement_Page SHALL render correctly in both the light and dark themes already supported by the application.
3. WHERE the operating system requests reduced motion, THE Agreement_Page SHALL present its content with no motion-based transition.
4. WHEN the Agreement_Page displays a status or error message, THE Agreement_Page SHALL announce it through a `role="status"` or `role="alert"` region as appropriate.
5. THIS feature SHALL write no new value to browser storage and SHALL log no new value to the browser console.
6. THIS feature SHALL introduce no new analytics event name.
