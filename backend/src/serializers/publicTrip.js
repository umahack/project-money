function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Fixed plain-language description of every field `serializePublicTrip` emits.
 * It is the single source for the disclosure shown to the owner before a public
 * link is created or rotated, so the UI never keeps its own field list.
 *
 * `path` notation: `[]` marks one element of an array and `*` marks a key that
 * is a member's display name. A unit test compares this list with the keys the
 * serializer really emits, so adding a public field without describing it here
 * (or describing one that is not emitted) fails the build.
 */
export const PUBLIC_TRIP_DISCLOSURE = deepFreeze({
  version: 1,
  groups: [
    {
      id: 'trip',
      title: 'Trip details',
      fields: [
        { path: 'trip.name', label: 'Trip name' },
        { path: 'trip.destination', label: 'Destination' },
        { path: 'trip.budget', label: 'Trip budget amount' },
        { path: 'trip.start_date', label: 'Start date' },
        { path: 'trip.end_date', label: 'End date' },
      ],
    },
    {
      id: 'members',
      title: 'People on the trip',
      fields: [
        { path: 'members[].name', label: 'Each member’s display name' },
      ],
    },
    {
      id: 'expenses',
      title: 'Shared expenses',
      fields: [
        { path: 'expenses[].payer', label: 'Who paid for each expense' },
        { path: 'expenses[].description', label: 'Each expense’s description' },
        { path: 'expenses[].amount', label: 'Each expense’s amount' },
        { path: 'expenses[].created_at', label: 'When each expense was added' },
        { path: 'expenses[].split[].name', label: 'Each person the expense is split between' },
        { path: 'expenses[].split[].share', label: 'Each person’s share weight in the split' },
      ],
    },
    {
      id: 'settlement',
      title: 'Balances and settle-up',
      fields: [
        { path: 'settlement.balances.*', label: 'Each named member’s balance (what they are owed or owe)' },
        { path: 'settlement.transactions[].from', label: 'Who pays in each suggested settle-up payment' },
        { path: 'settlement.transactions[].to', label: 'Who receives each suggested settle-up payment' },
        { path: 'settlement.transactions[].amount', label: 'The amount of each suggested settle-up payment' },
      ],
    },
  ],
  private: [
    'Your salary, bills, personal expenses and savings goals',
    'Your guided journeys, insights and analytics',
    'Email addresses of you and the other members',
    'Links between trip expenses and anyone’s personal spending',
    'Internal record numbers, notes, versions and sharing tokens',
  ],
});

function parsePublicSplit(expense) {
  let entries = [];
  try {
    const parsed = Array.isArray(expense?.split)
      ? expense.split
      : JSON.parse(expense?.split_json);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // Malformed stored splits remain visible as an empty public split. The
    // canonical calculator withholds balances and settlements for this state.
  }

  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    if (typeof entry.name !== 'string') return [];
    const share = Number(entry.share);
    if (!Number.isFinite(share)) return [];
    return [{ name: entry.name, share }];
  });
}

function minorToMajor(amountMinor) {
  return amountMinor / 100;
}

function serializeSettlement(calculation, memberNameById) {
  if (calculation?.status !== 'available') {
    return { balances: {}, transactions: [] };
  }

  const balances = Object.fromEntries(
    calculation.value.balances.flatMap((balance) => {
      const name = memberNameById.get(balance.memberId);
      return name === undefined ? [] : [[name, minorToMajor(balance.amountMinor)]];
    })
  );
  const transactions = calculation.value.settlements.flatMap((settlement) => {
    const from = memberNameById.get(settlement.fromMemberId);
    const to = memberNameById.get(settlement.toMemberId);
    if (from === undefined || to === undefined) return [];
    return [{ from, to, amount: minorToMajor(settlement.amountMinor) }];
  });

  return { balances, transactions };
}

/**
 * Project a private stored trip and its canonical calculation into the exact
 * anonymous public contract. Every returned object is constructed from an
 * explicit field allowlist; internal IDs and private calculation metadata are
 * used only for joining display names and cannot enter the response.
 */
export function serializePublicTrip({ trip, members, expenses, calculation }) {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip)) {
    throw new TypeError('trip must be a stored trip record.');
  }
  if (!Array.isArray(members) || !Array.isArray(expenses)) {
    throw new TypeError('members and expenses must be arrays.');
  }

  const memberNameById = new Map(members.map((member) => [member.id, member.name]));

  return {
    trip: {
      name: trip.name,
      destination: trip.destination,
      budget: Number(trip.budget),
      start_date: trip.start_date,
      end_date: trip.end_date,
    },
    members: members.map((member) => ({ name: member.name })),
    expenses: expenses.map((expense) => ({
      payer: expense.payer,
      description: expense.description,
      amount: Number(expense.amount),
      created_at: expense.created_at,
      split: parsePublicSplit(expense),
    })),
    settlement: serializeSettlement(calculation, memberNameById),
  };
}
