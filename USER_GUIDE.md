# Project Money — User Guide (Beta)

Hey! Thanks for testing. This app helps you plan your month after your salary
hits, and split expenses with friends on trips. It's still in beta — the
amber pulsing **BETA** badge in the top-left is your reminder to expect the
occasional bug.

**Open:** https://project-money-web.onrender.com
Works on phone and laptop. On the first visit after a quiet period, the
server may take ~30 seconds to wake up — that's expected on the free tier.

---

## 1. Sign up (10 seconds)

- Click **Create an account**.
- Enter your name, a real email, and a password (≥ 8 characters, with at
  least one letter and one number).
- You're in. All your data stays on your account.

Later, you can sign in from the same button with the same email + password.
If you forget your password, there's no reset flow yet — just ping me.

---

## 2. The Home / Dashboard — plan your month

- **Credited monthly salary** → type what landed in your account this month
  and hit **Calculate plan**.
- **Fixed payments** → add rent, EMIs, insurance, subscriptions, utilities.
  Each one has a label, amount, and category.

Once salary + fixed payments are set, you'll see:
- **Left after fixed** — your actual disposable amount.
- A donut and a **50 / 30 / 20** split: **Needs**, **Wants**, **Save**.
- **Insights** — small nudges when your fixed obligations are too high or
  your saving % is too low.

### Pending trip invites
If someone invited you to a trip, you'll see a card at the top of the Home
page with the inviter's name and trip details, plus **Accept** / **Decline**.

---

## 3. The Plan page — line-by-line budget

Everything on the Dashboard, broken out further. Shows recommended rupee
amounts for:
- Essentials (rent, groceries, transport, utilities, insurance, …)
- Lifestyle (dining, shopping, subscriptions, …)
- Save & invest (emergency fund, SIPs, retirement, learning, …)
- A target **6-month emergency fund** amount for your fixed costs.

Great to screenshot and refer to all month.

---

## 4. Trips — budget + split expenses with friends

### Create a trip
- Go to **Trips** → **Create a trip**.
- Give it a name (`Goa`, `Himalayas`), destination, budget, start/end dates.

### Add people — two ways
Open the trip, scroll to **👥 Friends on this trip**:

**A. Invite a registered friend (recommended)**
- Enter their account email → **Send invite**.
- They see the invite at the top of **their** Home page on next refresh.
- When they **Accept**, they land inside the trip and can see all expenses +
  settlements, and add their own.

**B. Add an offline friend (label only)**
- For someone who doesn't have an account, enter their name (and optionally
  email). They appear as a label in splits but can't log in themselves.

The trip creator is auto-added, so you always show up.

### Add a shared expense
Scroll to **Add an expense**:
- Pick who paid, enter description + amount.
- Pick **who shares** — tick everyone involved. By default it splits equally
  between the chosen people. You can adjust share weights (1 = normal share;
  set 0 to exclude).
- Hit **Add**.

### Who owes whom
A **Settle up** card appears automatically. It picks the shortest list of
"X pays Y ₹Z" transactions to zero everyone out. Click **Mark paid** next
to any row to record the payback — it's stored as a tiny settlement expense,
so your balances update instantly.

### Progress bar
Shows how much of the trip budget you've already spent.

---

## 5. Logging out & feedback

- Click **Sign out** (top-right).
- A quick **"How was it?"** popup appears — 1-to-5 stars, optional message.
  Takes 10 seconds. Either submit it or hit **Skip**.
- Next time you log in, you'll see a tiny "thanks for the feedback" toast.

Please send feedback — it's the fastest way to shape what gets built next.

---

## 6. Theme & mobile

- 🌙 / ☀️ icon in the top-right toggles **dark/light** mode. Your choice is
  remembered.
- On mobile, nav tabs sit at the bottom of the screen for one-thumb use.
  A small badge appears on **Trips** when you have pending invites.

---

## 7. What to try (test checklist)

If you're testing, these are the paths most likely to catch issues:

- [ ] Create account; log out; log back in.
- [ ] Enter salary + 2 fixed payments; check the donut and 50/30/20 numbers.
- [ ] Open the **Plan** page; scroll — all amounts should look reasonable.
- [ ] Create a trip with budget ₹10,000 and 2 members.
- [ ] Invite a second account (your friend or a second email of yours).
  Confirm they see it on Home and can accept.
- [ ] As the invited user, add an expense and verify the settle-up updates
      on both sides.
- [ ] Mark a settlement as paid — confirm balances go to zero.
- [ ] Toggle theme; sign out; look at the feedback popup.
- [ ] Open on your phone — bottom tab bar should appear.

---

## 8. Known limits (beta reminders)

- No password reset flow yet.
- Only registered users can be invited to trips (by their account email).
- Email notifications aren't sent — pending invites only show inside the app.
- Trip owners can delete the trip; non-owners can view and contribute but
  not delete.

---

## 9. Something broken? Send me a note

- Click **Sign out** and leave a rating with a short message — I see every
  one.
- Or ping me directly with: what you did, what you expected, what happened.
  A screenshot helps a lot.

Thanks for testing — happy planning!
