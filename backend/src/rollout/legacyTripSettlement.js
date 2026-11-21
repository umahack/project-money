/**
 * ROLLBACK-ONLY legacy trip settlement.
 *
 * This is the floating-point settlement that the authenticated
 * `GET /api/trips/:id` response has always returned in its top-level
 * `settlement` field. The canonical implementation is
 * `calculateTripOutcome` in `../domain/trips.js`, which the public trip route,
 * the mutation envelopes, and the clarity snapshot already use.
 *
 * It is intentionally NOT delegated to the canonical calculator yet. The
 * parity test `test/unit/legacyCanonicalParity.test.js` pins where the two
 * agree and where they differ (unrounded float balances, a one-paise
 * remainder placement, and invalid/incomplete trips that the canonical
 * calculator withholds). Old clients still read these exact legacy fields, so
 * the function body below is byte-for-byte what the route used to contain.
 * Retire it only when old clients are no longer served.
 */
export function legacyTripSettlement(members, expenses) {
  const bal = {};
  const memberNames = new Set();
  for (const m of members) {
    bal[m.name] = 0;
    memberNames.add(m.name);
  }
  for (const e of expenses) {
    // Skip expenses with no split, no amount, or where every share is 0 —
    // adding `amount` only to the payer would phantom-credit them.
    const totalShare = e.split.reduce((a, b) => a + Math.max(0, Number(b.share) || 0), 0);
    if (!(e.amount > 0) || totalShare <= 0) continue;
    // If the payer isn't a current member (renamed/removed), credit the trip
    // owner implicitly by skipping — never create a new phantom balance key.
    if (!memberNames.has(e.payer)) continue;
    bal[e.payer] += e.amount;
    for (const s of e.split) {
      // Likewise skip split rows for members who no longer exist.
      if (!memberNames.has(s.name)) continue;
      const share = Math.max(0, Number(s.share) || 0);
      if (share <= 0) continue;
      bal[s.name] -= (e.amount * share) / totalShare;
    }
  }
  const creditors = [];
  const debtors = [];
  for (const [name, v] of Object.entries(bal)) {
    const rounded = Math.round(v * 100) / 100;
    if (rounded > 0.01) creditors.push({ name, amount: rounded });
    else if (rounded < -0.01) debtors.push({ name, amount: -rounded });
  }
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  const txns = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    txns.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(pay * 100) / 100 });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return { balances: bal, transactions: txns };
}
