# Project Money: Google Play Store checklist

**You perform these steps in Play Console. The android-app-release feature does not.** The feature produces the signed bundle (AAB) and this checklist. Nothing here is submitted, uploaded, or declared on your behalf.

- App name: **Project Money**
- Package name (application ID): **`online.projectmoney.app`** (from `frontend/capacitor.config.ts`). It is permanent once you publish.
- Web app: https://project-money.online · API: https://project-money-api.onrender.com (from `README.md`/`HANDOFF.md`)
- Contact email shown in the policy pages: hello@project-money.online

Anything marked **verify in Play Console** could not be confirmed from the repository or from Google's public help pages. Play Console wording and forms change, so read each screen as you go.

Sources used (paraphrased, not quoted):

- [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Understanding Google Play's app account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)

---

## 0. Things to fix or decide before you submit

These came from comparing the app with what Play asks for.

1. **The policy pages are in `frontend/src/pages/Legal.tsx`** (exports `Privacy` and `Terms`, routed at `/privacy` and `/terms` in `App.tsx`). There are no separate `Privacy.tsx`/`Terms.tsx` files.
2. **The privacy policy text may not match the app any more.** It was last updated 2026-11-16 and does not mention: the optional Product Analytics setting, the Android app, the category memory used by Quick Add (off in the first release), or that Play's "account deletion" request path exists. Read it against section 2 below and update it before you paste the URL into Play Console. Policy text must match your Data safety answers.
3. **Account deletion web link.** Play requires a web link where users can request account and data deletion (see section 2.4). The app has no public, logged-out page that is only about deletion. `/privacy` describes the steps (Settings, then Delete account), but the deletion itself needs a signed-in session. Decide whether `/privacy` is enough, or add a dedicated public page (for example `/delete-account`) that explains the steps and gives hello@project-money.online for users who cannot sign in. That is a code change and is out of scope for this checklist. **Verify in Play Console** that the URL you give is accepted.
4. **Google-only web accounts cannot delete themselves by password.** `DELETE /api/auth/account` requires `currentPassword`, and accounts created with Google Sign-In have the sentinel `'!google'` hash (see `backend/src/routes/auth.js`). Google Sign-In is not shown on Android in version 1, so Android users always have a password. Web users who signed up with Google can use "Forgot password" to set one, or email you. Mention this in the deletion page or policy.
5. **Quick Add and Financial Clarity ship off.** The Data safety answers in section 6 assume both are off (matches `render.yaml`, where `QUICK_ADD_ENABLED` and the `VITE_*` flags are `"false"`). Turning Quick Add on enables the category memory feature (remembered category per note), which stores a normalised note key. Re-check the Data safety form and the privacy policy before you enable it.
6. **Mini-games.** The app contains an Arcade page (`/arcade`, Coin Catcher and Snake). It is hidden from the navigation but reachable by URL. Mention it truthfully in the content rating questionnaire if the questions ask about games.

---

## 1. Accounts and prerequisites

### 1.1 Play Console developer account

- [ ] Create a Google Play developer account at https://play.google.com/console and pay the one-time registration fee. **Verify in Play Console** for the current fee and accepted payment methods.
- [ ] Complete identity verification (personal accounts: legal name, address, contact details, and a government ID; organisation accounts need a D-U-N-S number). **Verify in Play Console** for the documents currently required in your country.
- [ ] Choose **personal** or **organisation** deliberately. The testing rule in 1.5 applies only to personal accounts created after 13 November 2023.
- [ ] Add a public developer contact email. It appears on the store listing.

### 1.2 Create the upload keystore (once)

Run this once, outside the repository. The upload key signs the AAB you upload. Google re-signs the app that users download with the Play App Signing key.

```bash
mkdir -p ~/keys
keytool -genkeypair -v -keystore ~/keys/project-money-upload.jks -alias upload \
        -keyalg RSA -keysize 2048 -validity 10000
```

- [ ] Choose a strong store password and key password and store them in a password manager.
- [ ] Copy `frontend/android/keystore.properties.example` to `frontend/android/keystore.properties` (gitignored) and fill in `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.
- [ ] **Keep two offline copies of the `.jks` file** (for example two separate encrypted drives). Never commit the keystore or `keystore.properties`.
- [ ] Print the certificate fingerprint and keep it for later comparison with what Play Console shows:

  ```bash
  keytool -list -v -keystore ~/keys/project-money-upload.jks -alias upload
  ```

If you lose the upload key, you can request an upload key reset in Play Console, but only because Play App Signing is on (1.3). **Verify in Play Console** for the current reset process.

### 1.3 Play App Signing

- [ ] When you create the app and upload your first release, accept **Play App Signing** enrolment (it is the default for new apps). Google then holds the app signing key and you keep only the upload key.
- [ ] After the first upload, open **Test and release > App integrity** (name may vary) and note the app signing certificate SHA-256, in case you later need it for an API that checks the signing certificate. The app does not use one today.

### 1.4 Create the app and use the internal testing track first

- [ ] In Play Console, **Create app**: name `Project Money`, default language, **App** (not game), **Free**, accept the declarations.
- [ ] Complete the **Dashboard "Set up your app"** tasks (section 2 and 3 below). Internal testing is available before setup is complete, closed testing is not.
- [ ] Create an **internal testing** release, upload the AAB (section 4), add the testers' Google accounts (a small trusted list), and install from the opt-in link. Internal testing is optional but is the quickest way to put a Play-signed build on a real device.

### 1.5 Closed testing requirement for new personal accounts

Per Google's help page ([App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)) as read when this checklist was written:

- It applies to **personal** developer accounts created **after 13 November 2023**.
- You must run a **closed test** with **at least 12 testers** who have been **opted in continuously for at least 14 days** before you can apply for production access.
- Production access is then requested from the Play Console Dashboard, where you answer questions about your app, how you tested, and your production readiness.
- Production and pre-registration stay disabled until this is met. Open testing becomes available only after you have production access.

Steps:

- [ ] Finish **App content** (section 2) and the **store listing** (section 3). Closed testing is available after app setup is complete.
- [ ] Create a closed testing track, upload the AAB, and create a tester list (a Google Group or email list). Share the opt-in link.
- [ ] Get **12 or more** testers to opt in and keep them opted in for 14 days. Count only testers who actually opted in. Do not count invitations.
- [ ] Collect feedback and fix problems during the 14 days. Ship fixes as new builds with a higher build number (section 4.1).
- [ ] Apply for production access on the Dashboard.

**Verify in Play Console** before relying on these numbers. Google has changed this rule before, and an organisation account or an older personal account may not be subject to it. Google's page itself says what applies to your account.

---

## 2. App content declarations (Play Console > Policy and programs > App content)

### 2.1 Privacy policy URL

- [ ] Enter **`https://project-money.online/privacy`** (the real web host, from `README.md` and `HANDOFF.md`; the route is defined in `frontend/src/App.tsx`).
- [ ] Open it in a private browser window first. The page must load publicly with no sign-in.
- [ ] Confirm the policy covers the points in section 0, item 2.
- The `www.` host (`https://www.project-money.online/privacy`) also exists per `HANDOFF.md`. Use one consistently.

### 2.2 Data safety form

Play requires the form for any app on a closed, open, or production track. Apps that are only on the internal testing track are exempt. You are responsible for the accuracy of the declarations, and Google reviews them against app behaviour.

The answers below come from the real data practices in the repository:

| Real practice | Where it comes from |
| --- | --- |
| Sign-up with email, display name and password (password stored as a bcrypt hash) | `backend/src/routes/auth.js`, `Legal.tsx` |
| One-time email codes for sign-up, email change and password reset (hashed, short-lived), sent through Resend | `auth.js`, `backend/src/mailer.js`, `Legal.tsx` |
| Financial entries typed by the user: salary, EMIs/bills, expenses, category budgets, recurring expenses, savings goals, custom categories, trips and trip expenses | export query list in `auth.js` (`GET /api/auth/export`) |
| Names of trip members the user types in (other people) | `trip_members` in the export |
| Feedback form: rating, message, email | `backend/src/routes/feedback.js`, export |
| Device sessions: device label, user agent, timestamps, IP handling (per the policy, a daily-rotating hash rather than the raw IP) | `sessions` in the export, `Legal.tsx`, `visits.js` (`dailyIpHash`) |
| Page-visit counts by route (hashed IP, user agent, optionally linked to the user when consented) | `backend/src/routes/visits.js` |
| Optional Product Analytics, **off by default**, can be turned off, must not include amounts, names, free text, trip members or trip names | `claritySettings.js` (`productAnalytics`), `dataUseLabels.ts`, `AnalyticsControl.tsx` |
| Public trip links: off by default, enabled only after the user confirms | `claritySettings.js` `sharingDefaults`, `Legal.tsx` Terms |
| Data hosts: Render (API and web), Turso (database), Resend (email) | `render.yaml`, `Legal.tsx` |
| No ads, no ad SDK, no sale of data | `Legal.tsx` ("We don't sell your data, run advertising networks...") |
| Export: Settings > Account controls > "Download my data (JSON)", plus CSV export | `DangerZone.tsx`, `ExportData.tsx` |
| Deletion: Settings > Account controls > "Delete my account" (asks for the current password) | `DangerZone.tsx`, `DELETE /api/auth/account` |

The data-use notice categories shown in the app (version 1, the one shown while Quick Add is off) are: Salary, Bills, Expenses, Savings goals, Trips, Guided journey progress, Change receipts, Sharing settings, and Product Analytics (optional). Version 2 adds "Remembered category choices" and applies only while Quick Add is on.

**Answer summary** (full copy-paste table in section 6):

- **Does the app collect or share user data?** Collects: yes. Shares: no (see the service-provider note below).
- **Is all data encrypted in transit?** Yes. The release build talks only to an `https://` API origin and blocks cleartext traffic.
- **Can users request deletion?** Yes, in the app and through a web URL (2.4).
- **Data types collected:** Email address, Name, User IDs, Other financial info, Other user-generated content (feedback, trip names, free text notes), App interactions (page visits, optional analytics). See the table in section 6.
- **Not collected:** location, contacts, photos/files, audio, calendar, health, messages, web browsing, installed apps, advertising ID, crash logs or diagnostics (the app bundles no analytics, crash or ad SDK. Verify with the SDK check in 2.2.1).

**Sharing and service providers.** Transfers to a "service provider" that processes data on your behalf and under your instructions are not "sharing" in Google's definition ([Data safety help](https://support.google.com/googleplay/android-developer/answer/10787469)). Render (hosting), Turso (database) and Resend (email delivery) fit that description. A public trip link the user turns on after a confirmation is a user-initiated action. **Verify in Play Console** that you are comfortable declaring "no sharing" with these in mind. If in doubt, declare sharing for email address and name with purpose "App functionality".

#### 2.2.1 Before you submit the form

- [ ] Re-check the SDK list. Run `cd frontend && npm ls --prod` and look at `frontend/android/app/build.gradle` dependencies. Capacitor core, `@capacitor/haptics`, filesystem/share plugins and similar do not send data anywhere on their own. Anything that does must be added to the form. **Verify** after any new dependency.
- [ ] IP handling was checked against the code: `backend/src/sessions.js` (`createSession`, `dailyIpHash`) and `backend/src/routes/visits.js` both store a daily-rotating salted hash and never the raw IP, and the session keeps a device label and a user agent truncated to 240 characters. This matches the policy. Re-check if that code changes.
- [ ] Re-open this form every time you add a data type or flip the Quick Add or Financial Clarity flags.

### 2.3 Privacy policy and the policy page content

The existing policy states: data collected, why, which hosts see it, user rights (export, delete, correct), retention (backups cycle out within 30 days), security, a statement that the app is not intended for under 13s, and a change log date. Keep it consistent with 2.2 and section 0.

### 2.4 Account deletion (User Data policy)

Because users can create an account in the app, Google's [account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111) need two things:

1. **An in-app path.** It exists: sign in, open **Settings** (bottom/side navigation "Settings"), scroll to **Account controls**, tap **Delete my account**, and confirm with the current password. The deletion runs as a single batch, so a failure leaves the account intact and shows a retry screen (`DangerZone.tsx`, `backend/src/db/accountDeletion.js`).
2. **A web link** where users can request deletion of the account and its data. Enter it in the Data safety form under the data deletion questions.
   - [ ] Provide the URL. Options: `https://project-money.online/privacy` (describes the in-app path, see section 0, item 3), or a dedicated page you add. **Verify in Play Console.**
   - [ ] State on that page how someone who cannot sign in can ask for deletion (hello@project-money.online) and how long it takes.

Also decide whether you delete any data on deletion beyond the account. The policy says backups cycle out within 30 days. Say so in the form's deletion section. **Verify in Play Console** how that section phrases retention.

### 2.5 Target audience and content

- [ ] **Target age group.** The policy says the app is not intended for users under 13, and it is a personal-finance tool. Choose **18 and over** (or at minimum exclude under-13 groups). Do not select child age groups. Selecting children triggers the Families policy, which this app is not built for. **Verify in Play Console** the current age bands and decide.
- [ ] **Appeals to children?** No. The Arcade mini-games are casual but the app is not designed for children.

### 2.6 Content rating questionnaire (IARC)

- [ ] Category: pick the closest to a **utility/productivity/finance tool** (not a game). **Verify in Play Console** for the category names offered.
- [ ] Answer from the app's behaviour. Hints, all based on the repository:
  - Violence, blood, sexual content, profanity, drugs, hate: **none**.
  - Simulated or real-money gambling: **none**. The Arcade mini-games (Coin Catcher, Snake Saver) have no stakes or purchases.
  - In-app purchases: **none**. Ads: **none**.
  - User-generated content / user interaction: the app has feedback messages to the developer, trip member names, and public trip links the user can create. There is no chat and no public feed. Answer the "users can interact or share content" questions according to the wording of each question. A public trip link lets anyone with the URL view that trip, so **declare it where the form asks about sharing user-created content**. **Verify in Play Console.**
  - Shares user location: **no**.
  - Digital purchases or real-money transactions: **none** (see 2.8).
- [ ] Submit and note the ratings that result. Re-do the questionnaire when features change.

### 2.7 Ads declaration

- [ ] **Contains ads: No.** There is no ad SDK and the policy states there are no ad networks.

### 2.8 Financial features declaration

Play asks apps that touch finance to describe their features. **Verify in Play Console** for the exact options.

- [ ] State what the app is: **personal finance tracking and planning only**. It records the user's own salary, bills, expenses, goals, and trip expense splits, and calculates budgets and settlements as numbers.
- [ ] The app does **not**: offer loans or credit, move money, take payments, hold funds, connect to bank accounts, give investment advice, trade securities or crypto, or offer insurance. Trip "settlement" only calculates who owes whom. The payment happens outside the app.
- [ ] Choose the option that says the app has no financial services features, or the closest "personal finance management / tracking" option. Do not select loan, payment, banking or investing categories.
- [ ] The Terms page says the app is a planning tool and not professional financial advice. Keep that wording in the store description (section 3.3).

### 2.9 Permissions declaration

Verified against `frontend/android/app/src/main/AndroidManifest.xml` and the Allowed_Permission_Set of the spec:

| Permission | Where it comes from | Type | Declaration |
| --- | --- | --- | --- |
| `android.permission.INTERNET` | declared in the app manifest | Normal | Needed to reach the API. No declaration form. |
| `android.permission.ACCESS_NETWORK_STATE` | declared in the app manifest | Normal | Lets the WebView report online or offline, so the in-app offline banner appears. Granted at install, no prompt, no declaration form. Reads connectivity state only, no personal data, so the Data safety answers do not change. |
| `android.permission.VIBRATE` | added at build time by `@capacitor/haptics` | Normal | Used for short haptic feedback. No declaration form. |
| `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | added by `androidx.core` | Signature (only apps signed with the same key can hold it) | Internal to AndroidX. Not a user-facing permission. |

- [ ] There are **no** dangerous or restricted permissions (no location, camera, microphone, contacts, storage, SMS, call log, notifications, background location, or all-files access). No permission declaration forms are needed.
- [ ] `FileProvider` is used to share export files through the share sheet. It is not exported (`android:exported="false"`).
- [ ] Run `cd frontend && npm run android:verify` before each upload. It audits the merged release manifest and fails on any permission outside this set.

### 2.10 Other declarations to complete on the App content page

**Verify in Play Console** for the current list. Typical items: government apps (No), financial features (2.8), health (No), news (No), COVID-19 contact tracing (No), data safety (2.2), advertising ID (the app does not use it, answer No), and the app access instructions below.

- [ ] **App access.** All main features need an account. Give the reviewers a **test account** (email and password) that is pre-created and already past the email verification step, and say that sign-up needs an emailed one-time code. Use a throwaway account on the production API. Do not give reviewers an account holding real data.
- [ ] Cold start note for reviewers: the free Render API instance can take up to about a minute to wake on the first request.

---

## 3. Store listing

### 3.1 Assets

| Asset | Requirement (**verify in Play Console**) | Status |
| --- | --- | --- |
| App icon | 512 × 512 px, 32-bit PNG, up to 1 MB | You create it. The web icon `frontend/public/pwa-icon-512.png` is the same size and can be a starting point. Check how it looks on the Play background. |
| Feature graphic | 1024 × 500 px, JPG or 24-bit PNG | You create it. Not in the repository. |
| Phone screenshots | At least 2, JPG or 24-bit PNG, 16:9 or 9:16, min 320 px / max 3840 px per side | Capture as described below. |
| 7-inch and 10-inch tablet screenshots | Optional, recommended | Optional. |
| Short description | Up to 80 characters | Draft in 3.3. |
| Full description | Up to 4000 characters | Draft in 3.3. |
| App name | Up to 30 characters | `Project Money` |

**Screenshots and `FLAG_SECURE`.** Release builds set `FLAG_SECURE` on the app window with no setting to turn it off, so a screenshot or screen recording of a **release** build is blank or black. Capture store screenshots from:

- a **debug build** (`npm run android:run`, or `npm run android:sync:debug` and run from Android Studio), where the flag is off, or
- an emulator running the debug build (the `Pixel_7_2` AVD from the spec).

Use a throwaway account with realistic but invented numbers. Do not show your real finances or email. Capture light and dark mode if you want both.

### 3.2 Listing settings

- [ ] Category: **Finance**, or **Productivity** if you want to avoid finance-specific review attention. **Verify in Play Console** for the current category list and the policy implications of Finance.
- [ ] Tags: pick from the offered list.
- [ ] Contact details: website `https://project-money.online`, email hello@project-money.online.
- [ ] Privacy policy URL as in 2.1.

### 3.3 Description drafts

Only claim what the app does today. Quick Add and Financial Clarity are **off** in the first release, so do not mention Quick Add in the first listing. If you turn it on later, update the listing then. Rewrite freely, but keep the claims honest.

**Short description (80 characters or fewer):**

> Plan your month, track expenses, and see what you can spend today.

(65 characters. Check the count in Play Console. "see what you can spend today" depends on the daily-allowance feature being visible in the first release. Remove the phrase if it is not.)

**Full description draft:**

> Project Money is a personal-finance planner. You enter your monthly income, your fixed bills, and your spending, and the app works out simple numbers from them.
>
> What you can do
> - Build a monthly plan from your income and bills, with a needs, wants and savings split.
> - Log expenses by category and see your spending against the plan.
> - See a daily spending guide based on what is left this month and the days remaining.
> - Set savings goals and see how much each one needs per month.
> - Split costs on a trip with friends and see who owes whom. Public trip links are off until you turn one on.
> - Export your expenses as CSV and your whole account as JSON.
> - Delete your account and data from Settings at any time.
>
> Your data
> - You sign in with your email and a password. The first release does not offer Google Sign-In.
> - Your data is sent over HTTPS to our server. We do not run ads and we do not sell your data.
> - Optional Product Analytics is off by default.
>
> Good to know
> - Project Money is a planning tool, not financial advice. It does not connect to your bank, move money, or give loans.
> - It is in beta. The free server can take up to a minute to wake on the first request after a period of inactivity.
> - For your privacy, screenshots and screen recordings are blocked inside the app.

Notes on the draft:

- "Needs, wants and savings split", "daily spending guide" and "goals" match the labels in `frontend/src/clarity/dataUseLabels.ts` (needs budget, wants budget, savings target, daily spending guide, goal feasibility). Remove any line whose screen you cannot find in the build you ship. The app's own "Quick Add" and "today's allowance" are in notice version 2, which only applies when Quick Add is on, so they are **not** claimed above.
- "Screenshots are blocked" is true for release builds because of `FLAG_SECURE`. Keep or drop it.
- No claims about security certifications, "bank-grade" encryption, savings amounts, or user numbers. None are proven in the repository.

---

## 4. Release steps

### 4.1 Build number discipline

- `versionName` comes from `frontend/package.json` `"version"` (currently `2.0.0`).
- `versionCode` is the Gradle property `buildNumber`. **Play rejects an upload whose versionCode was already used**, on any track. A release build without `buildNumber` fails on purpose.
- [ ] Keep a log of the numbers you have uploaded (for example in `docs/android-emulator-results.md` or your own notes). Use a number higher than the highest one ever uploaded, even for builds that were never released.
- [ ] Bump `version` in `frontend/package.json` for user-visible releases (versionName). The build number alone is enough for a re-upload of a fix to the same version.

### 4.2 Build, verify, upload

- [ ] Create `frontend/.env.android` from `frontend/.env.android.example` with `VITE_API_BASE=https://project-money-api.onrender.com`. It is not committed.
- [ ] Confirm `frontend/android/keystore.properties` exists and points at your upload keystore (1.2).
- [ ] Build the signed release:

  ```bash
  cd frontend
  npm run android:release -- -PbuildNumber=N
  ```

  Replace `N` with the next unused number. It produces the bundle `frontend/android/app/build/outputs/bundle/release/app-release.aab` and a signed APK (`assembleRelease`) for local testing. Check the exact output path in the Gradle log.
- [ ] Run the verifier and fix anything it reports:

  ```bash
  npm run android:verify
  ```

- [ ] Install the signed APK on a real device or emulator and run through the smoke checklist (sign-up with OTP, sign-in, add an expense, exports, back button, rotate, dark mode, airplane mode, kill and reopen). Results from earlier runs are in `docs/android-emulator-results.md`.
- [ ] Complete the **CORS step before testing from Play**: add `https://localhost` to Render's `CORS_ORIGIN` (comma-separated with the existing origins), redeploy the API, and check the preflight:

  ```bash
  curl -s -I -H "Origin: https://localhost" https://project-money-api.onrender.com/api/health | grep -i access-control-allow-origin
  curl -s -i -X OPTIONS https://project-money-api.onrender.com/api/health \
    -H "Origin: https://localhost" -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: authorization" | grep -i access-control-allow-origin
  ```

  Each must print `access-control-allow-origin: https://localhost`. See `README.md` and `HANDOFF.md`, section "Android release", for the full step.
- [ ] In Play Console choose the track (internal, closed or production), **Create new release**, upload `app-release.aab`, and confirm Play App Signing is on.

### 4.3 Release notes

- [ ] Write short, truthful notes per language, for example: "First release of Project Money for Android. Plan your month, log expenses, set goals and split trip costs." Notes are limited in length. **Verify in Play Console** for the limit (it was 500 characters per language at the time of writing).

### 4.4 Pre-launch report

- [ ] After the upload, wait for the **pre-launch report** (automated device tests) and read it. Look for crashes, ANRs, permission issues and accessibility warnings. **Verify in Play Console** that it ran on your track. Note that the robo test cannot sign in without credentials, so add test credentials under **App content > App access** or the report will only exercise the sign-in screen.
- [ ] Fix blocking findings and upload a new build with a higher build number.

### 4.5 Staged rollout

- [ ] For production, start with a **staged rollout** (for example 10 to 20% of users), watch the metrics in section 5 for a few days, then increase. You can halt a staged rollout from the release page.
- [ ] Keep the previous web deployment and API compatible with the previous app build. Users on old app versions keep calling the API.

---

## 5. Post-release monitoring

- [ ] **Android vitals** (Play Console > Quality > Android vitals): watch crash rate and ANR rate. Compare against Google's bad-behaviour thresholds. **Verify in Play Console** for the current values.
- [ ] **Crash reports and ANRs** (Play Console > Quality > Crashes and ANRs): open the top clusters. The release build ships ProGuard/R8 rules; upload the mapping file (`frontend/android/app/build/outputs/mapping/release/mapping.txt`) so stack traces are readable. **Verify** that the Gradle log or Play Console reports the mapping file as included in the bundle.
- [ ] **Ratings and reviews**: reply to reviews. Questions about data go to hello@project-money.online.
- [ ] **CORS check**: if sign-in works on the web but not in the app (network error, no response), re-run the two `curl` checks in 4.2. The app origin is `https://localhost` and the value in Render's `CORS_ORIGIN` must match it exactly, with no trailing slash. Redeploy after any change.
- [ ] **Server cold start**: the free Render instance sleeps. A slow first request after inactivity is expected. The app shows a hint. If reviews complain, that is the cause.
- [ ] **Feature-flag order** when you turn Quick Add on later (from `render.yaml` comments): first set `QUICK_ADD_ENABLED=true` on the **API** (server half, data-use notice v2), then enable Financial Clarity and Quick Add in the web/client build (`VITE_FINANCIAL_CLARITY_ENABLED`, `VITE_QUICK_ADD_ENABLED`) and ship a new app build. The client half needs the clarity flag and the server flag. Before you do this, update the Data safety form and the privacy policy (section 0, item 5).
- [ ] **Data requests**: if a user emails for deletion because they cannot sign in, handle it within the time your policy states.
- [ ] Back up the upload keystore again after any change, and check both copies still open (`keytool -list -keystore ...`).
- [ ] Re-read Google's current requirements for target API level at least once a year and raise `targetSdkVersion` in `frontend/android/variables.gradle` when Play requires it (currently 36). **Verify in Play Console.**

---

## 6. Copy-paste table: Data safety answers

Purposes use Play's names. "Shared" is "No" because Render, Turso and Resend process data only on your behalf (service providers). **Verify in Play Console** for the current form wording, and re-check each row against the app before you submit.

### 6.1 Top-level questions

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes (collects) |
| Is all of the user data collected by your app encrypted in transit? | Yes (HTTPS only; the release build blocks cleartext and non-https API origins) |
| Do you provide a way for users to request that their data is deleted? | Yes |
| Data deletion: users can request deletion from within the app | Yes. Settings > Account controls > Delete my account (needs the current password) |
| Data deletion: web link to request deletion | `https://project-money.online/privacy` (or your dedicated deletion page, see section 0 item 3) |
| Do you delete some data when a user asks for account deletion (or keep some)? | All account-linked rows are deleted. Database backups cycle out within 30 days per the privacy policy. **Verify in Play Console** how to phrase this. |
| Independent security review (optional badge) | No |
| Follows Play Families policy | No (not a children's app) |
| Is data sold? / used for advertising or marketing? | No / No |

### 6.2 Data types

| Play category | Data type | Collected? | Shared? | Required or optional | Purposes | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Personal info | Email address | Yes | No | Required | Account management; App functionality | Sign-in, one-time codes, password reset. Also given in the optional feedback form. |
| Personal info | Name | Yes | No | Required | Account management; App functionality | Display name. Trip member names the user types are also names, including other people's. |
| Personal info | User IDs | Yes | No | Required | Account management; App functionality | Internal account ID and device session ID. |
| Personal info | Address, phone number, race/ethnicity, political or religious beliefs, sexual orientation, other info | No | n/a | n/a | n/a | Not collected. |
| Financial info | User payment info (card or bank numbers) | No | n/a | n/a | n/a | Not collected. The app never takes payments. |
| Financial info | Purchase history | No | n/a | n/a | n/a | No in-app purchases. Expenses the user logs are "Other financial info". |
| Financial info | Credit score | No | n/a | n/a | n/a | Not collected. |
| Financial info | Other financial info | Yes | No | Optional (user chooses what to enter) | App functionality | Salary, bills/EMIs, expenses, budgets, recurring expenses, savings goals, trip expenses. Calculated budgets are derived from these. |
| Messages, Photos and videos, Audio, Files and docs, Calendar, Contacts, Health and fitness, Location | All | No | n/a | n/a | n/a | Not collected. |
| App activity | App interactions | Yes | No | Optional | Analytics; Fraud prevention, security, and compliance | Page-visit counts by route with a daily-rotating hashed IP. Product Analytics (optional, off by default) measures whether features are understood. |
| App activity | In-app search history, installed apps, other actions | No | n/a | n/a | n/a | Not collected. |
| App activity | Other user-generated content | Yes | No | Optional | App functionality; Developer communications | Feedback messages and ratings, trip names, free-text notes. |
| Web browsing | Web browsing history | No | n/a | n/a | n/a | Not collected. |
| App info and performance | Crash logs, Diagnostics, Other app performance data | No | n/a | n/a | n/a | The app bundles no crash or analytics SDK. Server operational logs do not include financial values (verify against your Render logs). |
| Device or other IDs | Device or other IDs | No (verify) | n/a | n/a | n/a | No advertising ID or hardware ID. The session record keeps a device label and a user agent, and the daily IP hash is pseudonymous data. If you decide these count, declare "Device or other IDs" with purposes App functionality and Fraud prevention, security, and compliance. **Verify in Play Console.** |

### 6.3 Short answers for the "Security practices" section

| Question | Answer |
| --- | --- |
| Data is encrypted in transit | Yes |
| You can request that data be deleted | Yes |
| Committed to Google Play Families Policy | No |
| Independent security review | No |

### 6.4 Other quick answers

| Declaration | Answer |
| --- | --- |
| Contains ads | No |
| Target age | 18 and over (decide; see 2.5) |
| In-app purchases | None |
| Sensitive permissions | None (INTERNET, ACCESS_NETWORK_STATE and VIBRATE only; all normal permissions) |
| Financial features | Personal finance tracking and planning only. No loans, payments, banking, investing or crypto. |
| Government app / news / health / COVID-19 tracing | No |
| Advertising ID | Not used |
| App access | Account required. Provide a test account to reviewers. |

---

## 7. Final pre-submission check

- [ ] Upload keystore created, `keystore.properties` filled in, two offline copies made.
- [ ] Play Console developer account verified, app created, Play App Signing on.
- [ ] Privacy policy URL loads and matches the Data safety answers.
- [ ] Account deletion in-app path tested on the release build, and the web link works.
- [ ] Data safety form submitted, with the SDK and IP-handling checks done (2.2.1).
- [ ] Content rating done, target audience set, ads declared as none, financial features declared.
- [ ] Store listing complete, with screenshots taken from a debug build or emulator.
- [ ] `npm run android:release -- -PbuildNumber=N` and `npm run android:verify` pass, AAB uploaded to internal testing first.
- [ ] CORS origin `https://localhost` added to `CORS_ORIGIN` on Render and the preflight check passes.
- [ ] For a new personal account: closed test with at least 12 opted-in testers for 14 days, then production access applied for.

**Reminder:** you perform all of these steps in Play Console. This feature does not.
