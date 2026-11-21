# Client measurement events

Pages report product events through `useMeasurement()` (`src/hooks/useMeasurement.ts`).
The implementation is `src/clarity/measurement.ts`. The server contract is
`POST /api/clarity/events` (`backend/src/services/measurementService.js`).

## Using the hook

```tsx
const measurement = useMeasurement();

measurement.journeyStarted({ journeyId, desiredOutcome: 'plan_month' });
measurement.firstOutcomeDisplayed({ journeyId, outcomeKind: 'monthly_plan' });
measurement.clarityResponse({ journeyId, response: 'yes' });          // never for Skip
measurement.recommendedActionCompleted({ journeyId, recommendationInstanceId, actionKey: 'review_bills' });
measurement.financialChangeUi({ changeId, causedReload: false, causedPageWideLoading: false });
```

| Function | When to call it | Fields |
| --- | --- | --- |
| `journeyStarted` | Once, when a Guided_Journey is started. | `journeyId`, `desiredOutcome` |
| `firstOutcomeDisplayed` | When the First_Meaningful_Outcome is shown in the starting journey session. | `journeyId`, `outcomeKind` |
| `clarityResponse` | When the user submits Yes, Partly, or No. Not for Skip. | `journeyId`, `response` |
| `recommendedActionCompleted` | When the user completes an in-product action reached from an Actionable_Insight. | `journeyId`, `recommendationInstanceId` (opaque UUID), `actionKey` (fixed key) |
| `financialChangeUi` | After a confirmed Financial_Record_Change settles, with what the UI did. | `changeId` (confirmed receipt id), `causedReload`, `causedPageWideLoading` |

`journeyId` and `changeId` are the ids the server returned. `desiredOutcome`, `outcomeKind`,
`response`, and `actionKey` are fixed string unions exported from `measurement.ts`.

## Rules for callers

- Pass only the listed fields. An extra field is a type error, and it is never copied at runtime.
  There is no field for amounts, names, notes, URLs, paths, or tokens. Do not add one.
- Do not send user, session, consent, local-period, or receipt fields. The server supplies them.
  `occurredAt` is stamped by the client; callers do not pass it.
- The functions return `void`, never throw, and never wait on the network. Do not await or
  branch UI on them. `analyticsEnabled` from the hook is informational only.
- Call each function at the moment the thing happens, not on every render. Put calls in event
  handlers or in an effect guarded by a ref so a re-render or React StrictMode does not repeat them.
  The server also de-duplicates, but repeated calls are wasted requests.
- `recommendedActionCompleted` takes the `recommendationInstanceId` from the insight and only a fixed
  `actionKey`. Do not derive either from labels or routes.
- If analytics is off, the clarity question still works. Only the transmission is skipped.

## What the client does for you

- Sends only while the confirmed Product Analytics setting is on and
  `VITE_FINANCIAL_CLARITY_ENABLED` is on. Otherwise events are dropped.
- Keeps an in-memory queue (at most 20 events), sent one at a time. Nothing is persisted.
- Drops events that fail, time out, are rejected (4xx), or are accepted-and-ignored (204).
  Nothing is retried. Offline events are dropped.
- On opt-out, clears the queue and aborts requests in flight. This happens when the user asks for the
  opt-out, before the server confirms. If that request fails, sending stays paused until the
  confirmed setting changes or the page reloads.
- Turns off on sign-out (the data-use provider unmounts).

## Visit tracking

`useVisitTracker()` sends `POST /api/track` with `{ route }` where `route` comes from the fixed enum in
`src/clarity/visitRoutes.ts` (the same list as `backend/src/routes/visits.js`). Signed-out visitors
report public routes only. Signed-in visits are sent only while Product Analytics is confirmed on.
