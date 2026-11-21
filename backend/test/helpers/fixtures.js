export const FIXTURE_TIMESTAMP = '2026-01-15T06:30:00.000Z';
export const FIXTURE_PASSWORD = 'Test-password-123!';

const FIXTURE_PASSWORD_HASH = '$2b$10$abcdefghijklmnopqrstuu.ziWKiBEv.kEQhAbdWjX/e/lgxp1M1e';

export function buildUserFixture(overrides = {}) {
  return {
    id: 101,
    email: 'user-101@example.test',
    name: 'Test User',
    password_hash: FIXTURE_PASSWORD_HASH,
    is_admin: 0,
    token_version: 1,
    created_at: FIXTURE_TIMESTAMP,
    ...overrides,
  };
}

export function buildSessionFixture({ userId = 101, ...overrides } = {}) {
  return {
    id: 201,
    user_id: userId,
    device_label: 'Test Browser on Test OS',
    ip_hash: 'test-ip-hash-000000000001',
    user_agent: 'ProjectMoneyTest/1.0',
    created_at: FIXTURE_TIMESTAMP,
    last_seen_at: FIXTURE_TIMESTAMP,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

export function buildFinancialRecordFixtures({
  userId = 101,
  month = '2026-01',
  salary: salaryOverrides = {},
  bills: billOverrides,
  expenses: expenseOverrides,
  goals: goalOverrides,
} = {}) {
  const defaultBills = [
    {
      id: 311,
      user_id: userId,
      label: 'Rent',
      amount: 20000,
      category: 'Rent',
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: 312,
      user_id: userId,
      label: 'Insurance',
      amount: 2500,
      category: 'Insurance',
      created_at: FIXTURE_TIMESTAMP,
    },
  ];
  const defaultExpenses = [
    {
      id: 321,
      user_id: userId,
      month,
      category: 'Groceries',
      amount: 1250.5,
      note: 'Weekly groceries',
      spent_on: `${month}-10`,
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: 322,
      user_id: userId,
      month,
      category: 'Entertainment',
      amount: 800,
      note: null,
      spent_on: `${month}-12`,
      created_at: FIXTURE_TIMESTAMP,
    },
  ];
  const defaultGoals = [
    {
      id: 331,
      user_id: userId,
      name: 'Emergency fund',
      target_amount: 120000,
      saved_amount: 30000,
      target_date: '2026-12-31',
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
  ];

  return {
    salary: {
      id: 301,
      user_id: userId,
      month,
      amount: 120000,
      created_at: FIXTURE_TIMESTAMP,
      ...salaryOverrides,
    },
    bills: (billOverrides ?? defaultBills).map((bill) => ({ ...bill })),
    expenses: (expenseOverrides ?? defaultExpenses).map((expense) => ({ ...expense })),
    goals: (goalOverrides ?? defaultGoals).map((goal) => ({ ...goal })),
  };
}

export function buildTripFixture({
  ownerId = 101,
  trip: tripOverrides = {},
  members: memberOverrides,
  expenses: expenseOverrides,
} = {}) {
  const trip = {
    id: 401,
    user_id: ownerId,
    name: 'Test Trip',
    destination: 'Pune',
    budget: 24000,
    start_date: '2026-02-01',
    end_date: '2026-02-03',
    public_token: null,
    public_enabled: 0,
    created_at: FIXTURE_TIMESTAMP,
    ...tripOverrides,
  };
  const defaultMembers = [
    {
      id: 411,
      trip_id: trip.id,
      user_id: ownerId,
      name: 'Test User',
      email: 'user-101@example.test',
    },
    {
      id: 412,
      trip_id: trip.id,
      user_id: null,
      name: 'Trip Friend',
      email: null,
    },
  ];
  const defaultExpenses = [
    {
      id: 421,
      trip_id: trip.id,
      payer: 'Test User',
      description: 'Hotel',
      amount: 6000,
      split_json: JSON.stringify([
        { name: 'Test User', share: 1 },
        { name: 'Trip Friend', share: 1 },
      ]),
      created_at: FIXTURE_TIMESTAMP,
    },
  ];

  return {
    trip,
    members: (memberOverrides ?? defaultMembers).map((member) => ({ ...member })),
    expenses: (expenseOverrides ?? defaultExpenses).map((expense) => ({ ...expense })),
  };
}

export function buildLegacyRowFixtures({ userId = 101, tripId = 901 } = {}) {
  return {
    openEndedBill: {
      id: 931,
      user_id: userId,
      label: 'Legacy rent',
      amount: 18000.75,
      category: 'Rent',
      created_at: '2024-04-01T00:00:00.000Z',
    },
    overfundedGoal: {
      id: 921,
      user_id: userId,
      name: 'Legacy overfunded goal',
      target_amount: 1000,
      saved_amount: 1250,
      target_date: null,
      created_at: '2024-04-01T00:00:00.000Z',
      updated_at: '2024-04-01T00:00:00.000Z',
    },
    sharedTrip: {
      id: tripId,
      user_id: userId,
      name: 'Legacy shared trip',
      destination: null,
      budget: 5000,
      start_date: null,
      end_date: null,
      public_token: '0123456789abcdef0123456789abcdef',
      public_enabled: 1,
      created_at: '2024-04-01T00:00:00.000Z',
    },
    malformedTripExpense: {
      id: 911,
      trip_id: tripId,
      payer: 'Legacy payer',
      description: 'Legacy malformed split',
      amount: 999.99,
      split_json: '{"legacy":"not-an-array"}',
      created_at: '2024-04-01T00:00:00.000Z',
    },
  };
}

export function buildFixtureGraph() {
  const user = buildUserFixture();
  return {
    user,
    session: buildSessionFixture({ userId: user.id }),
    financialRecords: buildFinancialRecordFixtures({ userId: user.id }),
    trip: buildTripFixture({ ownerId: user.id }),
    legacyRows: buildLegacyRowFixtures({ userId: user.id }),
  };
}

/**
 * Representative pre-migration records for legacy contract characterization.
 * Values are synthetic and deterministic; tests must assert shapes and
 * calculations directly rather than writing records or response bodies to logs.
 */
export function buildLegacyCharacterizationFixtures({
  userId = 101,
  memberUserId = 102,
  currentMonth = '2026-01',
  previousMonth = '2025-12',
  nextMonth = '2026-02',
} = {}) {
  const publicToken = 'abcdef0123456789abcdef0123456789';
  return {
    planCases: {
      empty: { salary: null, bills: [] },
      equal: {
        salary: { id: 501, user_id: userId, month: currentMonth, amount: 50_000, created_at: FIXTURE_TIMESTAMP },
        bills: [
          { id: 511, user_id: userId, label: 'Equal bill A', amount: 20_000, category: 'Rent', created_at: FIXTURE_TIMESTAMP },
          { id: 512, user_id: userId, label: 'Equal bill B', amount: 30_000, category: 'EMI', created_at: FIXTURE_TIMESTAMP },
        ],
      },
      excess: {
        salary: { id: 502, user_id: userId, month: currentMonth, amount: 50_000, created_at: FIXTURE_TIMESTAMP },
        bills: [
          { id: 513, user_id: userId, label: 'Excess bill', amount: 60_000, category: 'Rent', created_at: FIXTURE_TIMESTAMP },
        ],
      },
      monthBoundary: {
        salaries: [
          { id: 503, user_id: userId, month: previousMonth, amount: 48_000, created_at: FIXTURE_TIMESTAMP },
          { id: 504, user_id: userId, month: nextMonth, amount: 72_000, created_at: FIXTURE_TIMESTAMP },
        ],
        expenses: [
          { id: 521, user_id: userId, month: previousMonth, category: 'Food', amount: 700, note: null, spent_on: `${previousMonth}-28`, created_at: FIXTURE_TIMESTAMP },
          { id: 522, user_id: userId, month: currentMonth, category: 'Food', amount: 900, note: null, spent_on: `${currentMonth}-01`, created_at: FIXTURE_TIMESTAMP },
        ],
      },
    },
    fundedGoal: {
      id: 531,
      user_id: userId,
      name: 'Funded fixture goal',
      target_amount: 2_500,
      saved_amount: 2_500,
      target_date: `${nextMonth}-01`,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
    trip: buildTripFixture({
      ownerId: userId,
      trip: {
        id: 541,
        public_token: publicToken,
        public_enabled: 1,
      },
      members: [
        { id: 551, trip_id: 541, user_id: userId, name: 'Fixture Owner', email: 'owner@example.test' },
        { id: 552, trip_id: 541, user_id: memberUserId, name: 'Fixture Member', email: 'member@example.test' },
      ],
      expenses: [
        {
          id: 561,
          trip_id: 541,
          payer: 'Fixture Owner',
          description: 'Shared fixture expense',
          amount: 6_000,
          split_json: JSON.stringify([
            { name: 'Fixture Owner', share: 1 },
            { name: 'Fixture Member', share: 1 },
          ]),
          created_at: FIXTURE_TIMESTAMP,
        },
      ],
    }),
    publicToken,
  };
}
