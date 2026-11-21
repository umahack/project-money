import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/blockingStdout.js';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

let testDatabase;
let db;
let buildAccountDeletionStatements;
let financialRepository;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  db = testDatabase.db;
  ({ buildAccountDeletionStatements } = await import('../../src/db/accountDeletion.js'));
  ({ default: financialRepository } = await import('../../src/repositories/financialRepository.js'));
  await db.prepare(`CREATE TABLE injected_transaction_failures (
    id INTEGER PRIMARY KEY,
    allowed INTEGER NOT NULL CHECK (allowed = 1)
  )`).run();
});

after(async () => {
  await testDatabase?.cleanup();
});

async function insertUser(id, email = `transaction-${id}@example.test`) {
  await db.prepare(
    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, email, `Transaction User ${id}`, 'test-password-hash');
}

function injectedFailure(id) {
  return [
    'INSERT INTO injected_transaction_failures (id, allowed) VALUES (?, ?)',
    [id, 0],
  ];
}

async function count(sql, ...args) {
  const row = await db.prepare(sql).get(...args);
  return Number(row.count);
}

async function seedTrip({ userId, tripId, tripExpenseId }) {
  await db.batch([
    ['INSERT INTO trips (id, user_id, name, budget) VALUES (?, ?, ?, ?)',
      [tripId, userId, `Atomic trip ${tripId}`, 100]],
    ['INSERT INTO trip_members (trip_id, user_id, name) VALUES (?, ?, ?)',
      [tripId, userId, `Member ${userId}`]],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)',
      [tripExpenseId, tripId, `Member ${userId}`, 'Shared cost', 25, JSON.stringify([{ name: `Member ${userId}`, share: 1 }])]],
  ]);
}

function personalInclusionStatements({
  userId,
  tripId,
  tripExpenseId,
  expenseId,
  linkId,
  changeId,
}) {
  return [
    [`INSERT INTO expense_log
       (id, user_id, month, category, amount, note, spent_on)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [expenseId, userId, '2026-01', 'Travel', 25, null, '2026-01-15']],
    [`INSERT INTO trip_expense_personal_links
       (id, user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [linkId, userId, tripId, tripExpenseId, expenseId, 2500]],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
        record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [changeId, userId, `include-${changeId}`, `test-hmac-${changeId}`,
        'trip.personal_link.include', 'expense', expenseId, 1, 'confirmed']],
    [`INSERT INTO user_financial_state (user_id, data_version)
      VALUES (?, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        data_version = user_financial_state.data_version + 1,
        updated_at = CURRENT_TIMESTAMP`, [userId]],
  ];
}

function personalWithdrawalStatements({ userId, expenseId, linkId, changeId }) {
  return [
    ['DELETE FROM trip_expense_personal_links WHERE id = ? AND user_id = ?', [linkId, userId]],
    ['DELETE FROM expense_log WHERE id = ? AND user_id = ?', [expenseId, userId]],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
        record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [changeId, userId, `withdraw-${changeId}`, `test-hmac-${changeId}`,
        'trip.personal_link.withdraw', 'expense', expenseId, 2, 'reversed']],
    [`INSERT INTO user_financial_state (user_id, data_version)
      VALUES (?, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        data_version = user_financial_state.data_version + 1,
        updated_at = CURRENT_TIMESTAMP`, [userId]],
  ];
}

async function personalLinkSnapshot({ userId, tripExpenseId, expenseId, linkId }) {
  const [personalExpenseCount, linkCount, tripExpenseCount, receiptCount, state] = await Promise.all([
    count('SELECT COUNT(*) AS count FROM expense_log WHERE id = ? AND user_id = ?', expenseId, userId),
    count('SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE id = ? AND user_id = ?', linkId, userId),
    count('SELECT COUNT(*) AS count FROM trip_expenses WHERE id = ?', tripExpenseId),
    count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId),
    db.prepare('SELECT data_version FROM user_financial_state WHERE user_id = ?').get(userId),
  ]);
  return {
    personalExpenseCount,
    linkCount,
    tripExpenseCount,
    receiptCount,
    dataVersion: state ? Number(state.data_version) : null,
  };
}

async function createPersonalLinkGraph(base) {
  const graph = {
    userId: base + 1,
    tripId: base + 2,
    tripExpenseId: base + 3,
    expenseId: base + 4,
    linkId: base + 5,
    changeId: base + 6,
  };
  await insertUser(graph.userId);
  await seedTrip(graph);
  return graph;
}

test('personal expense inclusion commits source, link, receipt, and version together', async () => {
  const graph = await createPersonalLinkGraph(10_000);
  await db.batch(personalInclusionStatements(graph));

  assert.deepEqual(await personalLinkSnapshot(graph), {
    personalExpenseCount: 1,
    linkCount: 1,
    tripExpenseCount: 1,
    receiptCount: 1,
    dataVersion: 1,
  });
});

test('personal expense inclusion rolls back at every batch boundary', async (t) => {
  const statementCount = personalInclusionStatements({
    userId: 1, tripId: 1, tripExpenseId: 1, expenseId: 1, linkId: 1, changeId: 1,
  }).length;

  for (let position = 0; position <= statementCount; position += 1) {
    await t.test(`failure before position ${position}`, async () => {
      const graph = await createPersonalLinkGraph(11_000 + position * 20);
      const statements = personalInclusionStatements(graph);
      statements.splice(position, 0, injectedFailure(11_000 + position));

      await assert.rejects(
        db.batch(statements),
        (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
      );
      assert.deepEqual(await personalLinkSnapshot(graph), {
        personalExpenseCount: 0,
        linkCount: 0,
        tripExpenseCount: 1,
        receiptCount: 0,
        dataVersion: null,
      });
    });
  }
});

test('personal expense withdrawal preserves the trip and commits all linked changes', async () => {
  const graph = await createPersonalLinkGraph(12_000);
  await db.batch(personalInclusionStatements(graph));
  await db.batch(personalWithdrawalStatements({
    ...graph,
    changeId: graph.changeId + 1,
  }));

  assert.deepEqual(await personalLinkSnapshot(graph), {
    personalExpenseCount: 0,
    linkCount: 0,
    tripExpenseCount: 1,
    receiptCount: 2,
    dataVersion: 2,
  });
});

test('personal expense withdrawal rolls back at every batch boundary', async (t) => {
  const statementCount = personalWithdrawalStatements({
    userId: 1, expenseId: 1, linkId: 1, changeId: 1,
  }).length;

  for (let position = 0; position <= statementCount; position += 1) {
    await t.test(`failure before position ${position}`, async () => {
      const graph = await createPersonalLinkGraph(13_000 + position * 20);
      await db.batch(personalInclusionStatements(graph));
      const before = await personalLinkSnapshot(graph);
      const statements = personalWithdrawalStatements({
        ...graph,
        changeId: graph.changeId + 1,
      });
      statements.splice(position, 0, injectedFailure(13_000 + position));

      await assert.rejects(
        db.batch(statements),
        (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
      );
      assert.deepEqual(await personalLinkSnapshot(graph), before);
    });
  }
});

function goalContributionStatements({ userId, goalId, changeId }) {
  return [
    [`UPDATE savings_goals
         SET saved_amount = saved_amount + 10,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`, [goalId, userId]],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
        record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [changeId, userId, `goal-${changeId}`, `test-hmac-${changeId}`,
        'goal.contribute', 'goal', goalId, 1, 'confirmed']],
    [`INSERT INTO user_financial_state (user_id, data_version)
      VALUES (?, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        data_version = user_financial_state.data_version + 1,
        updated_at = CURRENT_TIMESTAMP`, [userId]],
  ];
}

async function goalSnapshot({ userId, goalId }) {
  const [goal, receiptCount, state] = await Promise.all([
    db.prepare('SELECT saved_amount FROM savings_goals WHERE id = ? AND user_id = ?').get(goalId, userId),
    count('SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?', userId),
    db.prepare('SELECT data_version FROM user_financial_state WHERE user_id = ?').get(userId),
  ]);
  return {
    savedAmount: Number(goal.saved_amount),
    receiptCount,
    dataVersion: state ? Number(state.data_version) : null,
  };
}

async function seedGoalContribution(base) {
  const graph = { userId: base + 1, goalId: base + 2, changeId: base + 3 };
  await insertUser(graph.userId);
  await db.prepare(
    `INSERT INTO savings_goals
      (id, user_id, name, target_amount, saved_amount, target_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(graph.goalId, graph.userId, 'Atomic goal', 100, 20, '2026-12-31');
  return graph;
}

test('goal contribution source, receipt, and version commit together', async () => {
  const graph = await seedGoalContribution(14_000);
  await db.batch(goalContributionStatements(graph));
  assert.deepEqual(await goalSnapshot(graph), {
    savedAmount: 30,
    receiptCount: 1,
    dataVersion: 1,
  });
});

test('goal contribution rolls back at every batch boundary', async (t) => {
  const statementCount = goalContributionStatements({ userId: 1, goalId: 1, changeId: 1 }).length;

  for (let position = 0; position <= statementCount; position += 1) {
    await t.test(`failure before position ${position}`, async () => {
      const graph = await seedGoalContribution(15_000 + position * 20);
      const before = await goalSnapshot(graph);
      const statements = goalContributionStatements(graph);
      statements.splice(position, 0, injectedFailure(15_000 + position));

      await assert.rejects(
        db.batch(statements),
        (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
      );
      assert.deepEqual(await goalSnapshot(graph), before);
    });
  }
});

test('concurrent data-version updates return a gap-free monotonic sequence', async () => {
  const userId = 16_001;
  await insertUser(userId);

  const updateCount = 32;
  const versions = await Promise.all(
    Array.from({ length: updateCount }, () => financialRepository.incrementDataVersion(userId))
  );

  assert.deepEqual(
    versions.toSorted((left, right) => left - right),
    Array.from({ length: updateCount }, (_, index) => index + 1)
  );
  assert.equal(await financialRepository.getDataVersion(userId), updateCount);
});

async function seedAccountDeletionGraph(base) {
  const userId = base + 1;
  const otherUserId = base + 2;
  const email = `delete-${userId}@example.test`;
  const tripId = base + 3;
  const tripExpenseId = base + 4;
  const expenseId = base + 5;
  const changeId = base + 6;
  const sessionId = base + 7;
  const journeyId = base + 8;
  const feedbackId = base + 9;
  const auditId = base + 10;
  const visitId = base + 11;

  await insertUser(userId, email);
  await insertUser(otherUserId);
  await db.batch([
    ['INSERT INTO sessions (id, user_id) VALUES (?, ?)', [sessionId, userId]],
    ['INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)', [userId, '2026-01', 100]],
    ['INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)', [userId, 'Rent', 10, 'Rent']],
    ['INSERT INTO expense_log (id, user_id, month, category, amount) VALUES (?, ?, ?, ?, ?)', [expenseId, userId, '2026-01', 'Travel', 25]],
    ['INSERT INTO category_budgets (user_id, category, amount) VALUES (?, ?, ?)', [userId, 'Food', 20]],
    ['INSERT INTO recurring_expenses (user_id, label, amount, category, day_of_month) VALUES (?, ?, ?, ?, ?)', [userId, 'Subscription', 5, 'Bills', 1]],
    ['INSERT INTO savings_goals (user_id, name, target_amount, saved_amount) VALUES (?, ?, ?, ?)', [userId, 'Delete goal', 100, 10]],
    ['INSERT INTO user_categories (user_id, name) VALUES (?, ?)', [userId, 'Custom']],
    ['INSERT INTO user_aliases (user_id, email) VALUES (?, ?)', [userId, `alias-${userId}@example.test`]],
    ['INSERT INTO trips (id, user_id, name, budget, public_token, public_enabled) VALUES (?, ?, ?, ?, ?, ?)', [tripId, userId, 'Delete trip', 100, userId.toString(16).padStart(32, '0'), 1]],
    ['INSERT INTO trip_members (trip_id, user_id, name) VALUES (?, ?, ?)', [tripId, userId, 'Deleting member']],
    ['INSERT INTO trip_invites (trip_id, inviter_id, invitee_id) VALUES (?, ?, ?)', [tripId, userId, otherUserId]],
    ['INSERT INTO trip_expenses (id, trip_id, payer, description, amount, split_json) VALUES (?, ?, ?, ?, ?, ?)', [tripExpenseId, tripId, 'Deleting member', 'Delete expense', 25, '[]']],
    ['INSERT INTO user_financial_state (user_id, data_version) VALUES (?, ?)', [userId, 4]],
    ['INSERT INTO guided_journeys (id, user_id, desired_outcome, status, current_step_key, started_session_id) VALUES (?, ?, ?, ?, ?, ?)', [journeyId, userId, 'plan_month', 'active', 'salary', sessionId]],
    ['INSERT INTO expense_category_treatments (user_id, category, treatment) VALUES (?, ?, ?)', [userId, 'Travel', 'wants']],
    [`INSERT INTO financial_record_changes
       (id, user_id, idempotency_key, request_fingerprint_hmac, operation,
        record_type, record_id, record_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [changeId, userId, `delete-seed-${changeId}`, `test-hmac-${changeId}`,
        'trip.personal_link.include', 'expense', expenseId, 1, 'confirmed']],
    [`INSERT INTO trip_expense_personal_links
       (user_id, trip_id, trip_expense_id, expense_log_id, included_amount_minor)
      VALUES (?, ?, ?, ?, ?)`, [userId, tripId, tripExpenseId, expenseId, 2500]],
    [`INSERT INTO product_measurement_events
       (event_id, user_id, event_name, journey_id, change_id, consent_version,
        occurred_at, local_date, local_week_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`delete-event-${userId}`, userId, 'financial_change_ui', journeyId, changeId, 1,
        '2026-01-15T06:30:00.000Z', '2026-01-15', '2026-01-12']],
    ['INSERT INTO pending_email_changes (user_id, new_email, verify_code_hash, verify_expires_at) VALUES (?, ?, ?, ?)', [userId, `new-${email}`, 'hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO pending_registrations (email, name, password_hash, verify_code_hash, verify_expires_at) VALUES (?, ?, ?, ?, ?)', [email, 'Pending delete', 'password-hash', 'hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO pending_password_resets (email, verify_code_hash, verify_expires_at) VALUES (?, ?, ?)', [email, 'hash', '2026-01-16T00:00:00.000Z']],
    ['INSERT INTO feedback (id, user_id, rating, message) VALUES (?, ?, ?, ?)', [feedbackId, userId, 5, 'Synthetic feedback']],
    ['INSERT INTO audit_log (id, actor_id, actor_email, action) VALUES (?, ?, ?, ?)', [auditId, userId, email, 'test.seed']],
    ['INSERT INTO visits (id, user_id, path, ip_hash) VALUES (?, ?, ?, ?)', [visitId, userId, '/plan', 'synthetic-ip-hash']],
  ]);

  return {
    userId,
    otherUserId,
    email,
    tripId,
    tripExpenseId,
    feedbackId,
    auditId,
    visitId,
  };
}

const ACCOUNT_COUNT_QUERIES = Object.freeze([
  ['userCount', 'SELECT COUNT(*) AS count FROM users WHERE id = ?'],
  ['sessionCount', 'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?'],
  ['salaryCount', 'SELECT COUNT(*) AS count FROM salary_entries WHERE user_id = ?'],
  ['billCount', 'SELECT COUNT(*) AS count FROM emis WHERE user_id = ?'],
  ['expenseCount', 'SELECT COUNT(*) AS count FROM expense_log WHERE user_id = ?'],
  ['budgetCount', 'SELECT COUNT(*) AS count FROM category_budgets WHERE user_id = ?'],
  ['recurringCount', 'SELECT COUNT(*) AS count FROM recurring_expenses WHERE user_id = ?'],
  ['goalCount', 'SELECT COUNT(*) AS count FROM savings_goals WHERE user_id = ?'],
  ['categoryCount', 'SELECT COUNT(*) AS count FROM user_categories WHERE user_id = ?'],
  ['aliasCount', 'SELECT COUNT(*) AS count FROM user_aliases WHERE user_id = ?'],
  ['tripCount', 'SELECT COUNT(*) AS count FROM trips WHERE user_id = ?'],
  ['memberCount', 'SELECT COUNT(*) AS count FROM trip_members WHERE user_id = ?'],
  ['inviteCount', 'SELECT COUNT(*) AS count FROM trip_invites WHERE inviter_id = ? OR invitee_id = ?'],
  ['stateCount', 'SELECT COUNT(*) AS count FROM user_financial_state WHERE user_id = ?'],
  ['journeyCount', 'SELECT COUNT(*) AS count FROM guided_journeys WHERE user_id = ?'],
  ['treatmentCount', 'SELECT COUNT(*) AS count FROM expense_category_treatments WHERE user_id = ?'],
  ['linkCount', 'SELECT COUNT(*) AS count FROM trip_expense_personal_links WHERE user_id = ?'],
  ['changeCount', 'SELECT COUNT(*) AS count FROM financial_record_changes WHERE user_id = ?'],
  ['eventCount', 'SELECT COUNT(*) AS count FROM product_measurement_events WHERE user_id = ?'],
  ['pendingEmailCount', 'SELECT COUNT(*) AS count FROM pending_email_changes WHERE user_id = ?'],
  ['visitCount', 'SELECT COUNT(*) AS count FROM visits WHERE user_id = ?'],
]);

async function accountDeletionSnapshot(graph) {
  const entries = await Promise.all(ACCOUNT_COUNT_QUERIES.map(async ([name, sql]) => {
    const args = name === 'inviteCount'
      ? [graph.userId, graph.userId]
      : [graph.userId];
    return [name, await count(sql, ...args)];
  }));
  const [pendingRegistrationCount, pendingResetCount, tripExpenseCount, feedback, audit, otherUserCount] = await Promise.all([
    count('SELECT COUNT(*) AS count FROM pending_registrations WHERE email = ?', graph.email),
    count('SELECT COUNT(*) AS count FROM pending_password_resets WHERE email = ?', graph.email),
    count('SELECT COUNT(*) AS count FROM trip_expenses WHERE id = ?', graph.tripExpenseId),
    db.prepare('SELECT user_id FROM feedback WHERE id = ?').get(graph.feedbackId),
    db.prepare('SELECT actor_id FROM audit_log WHERE id = ?').get(graph.auditId),
    count('SELECT COUNT(*) AS count FROM users WHERE id = ?', graph.otherUserId),
  ]);

  return {
    ...Object.fromEntries(entries),
    pendingRegistrationCount,
    pendingResetCount,
    tripExpenseCount,
    feedbackUserId: feedback?.user_id == null ? null : Number(feedback.user_id),
    auditActorId: audit?.actor_id == null ? null : Number(audit.actor_id),
    otherUserCount,
  };
}

test('account deletion removes or unlinks the complete user graph in one commit', async () => {
  const graph = await seedAccountDeletionGraph(20_000);
  await db.batch(buildAccountDeletionStatements(graph));
  const snapshot = await accountDeletionSnapshot(graph);

  for (const [name, value] of Object.entries(snapshot)) {
    if (name === 'otherUserCount') assert.equal(value, 1, name);
    else if (name === 'feedbackUserId' || name === 'auditActorId') assert.equal(value, null, name);
    else assert.equal(value, 0, name);
  }
});

test('account deletion rolls back the complete user graph at every batch boundary', async (t) => {
  const statementCount = buildAccountDeletionStatements({
    userId: 1,
    email: 'shape@example.test',
  }).length;

  for (let position = 0; position <= statementCount; position += 1) {
    await t.test(`failure before position ${position}`, async () => {
      const graph = await seedAccountDeletionGraph(21_000 + position * 100);
      const before = await accountDeletionSnapshot(graph);
      const statements = buildAccountDeletionStatements(graph);
      statements.splice(position, 0, injectedFailure(21_000 + position));

      await assert.rejects(
        db.batch(statements),
        (error) => error?.code === 'SQLITE_CONSTRAINT_CHECK'
      );
      assert.deepEqual(await accountDeletionSnapshot(graph), before);
    });
  }
});
