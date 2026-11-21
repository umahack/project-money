import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';
import {
  buildFinancialRecordFixtures,
  buildSessionFixture,
  buildUserFixture,
} from '../helpers/fixtures.js';

let testDatabase;
let server;
let fixtures;

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  const { db } = testDatabase;
  const user = buildUserFixture();
  const session = buildSessionFixture({ userId: user.id });
  const financialRecords = buildFinancialRecordFixtures({ userId: user.id });
  fixtures = { user, session, financialRecords };

  await db.prepare(
    `INSERT INTO users
      (id, email, name, password_hash, is_admin, token_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.email,
    user.name,
    user.password_hash,
    user.is_admin,
    user.token_version,
    user.created_at
  );
  await db.prepare(
    `INSERT INTO sessions
      (id, user_id, device_label, ip_hash, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.user_id,
    session.device_label,
    session.ip_hash,
    session.user_agent,
    session.created_at,
    session.last_seen_at
  );
  await db.prepare(
    'INSERT INTO salary_entries (id, user_id, month, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    financialRecords.salary.id,
    financialRecords.salary.user_id,
    financialRecords.salary.month,
    financialRecords.salary.amount,
    financialRecords.salary.created_at
  );
  for (const bill of financialRecords.bills) {
    await db.prepare(
      'INSERT INTO emis (id, user_id, label, amount, category, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bill.id, bill.user_id, bill.label, bill.amount, bill.category, bill.created_at);
  }

  const { createApp } = await import('../../src/app.js');
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

after(async () => {
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await testDatabase?.cleanup();
});

test('imported app serves API requests without starting its own listener', async () => {
  const health = await request(server)
    .get('/api/health')
    .set('Origin', 'http://127.0.0.1');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.headers['access-control-allow-origin'], 'http://127.0.0.1');

  const deniedOrigin = await request(server)
    .get('/api/health')
    .set('Origin', 'https://not-allowed.example.test');
  assert.equal(deniedOrigin.status, 403);

  const unauthorized = await request(server).get('/api/finance/plan');
  assert.equal(unauthorized.status, 401);

  const token = jwt.sign(
    {
      sub: String(fixtures.user.id),
      tv: fixtures.user.token_version,
      sid: fixtures.session.id,
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  const plan = await request(server)
    .get('/api/finance/plan')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(plan.status, 200);
  assert.equal(plan.body.income, fixtures.financialRecords.salary.amount);
  assert.equal(
    plan.body.emiTotal,
    fixtures.financialRecords.bills.reduce((total, bill) => total + bill.amount, 0)
  );
  assert.equal(plan.body.afterFixed, 97_500);

  // authRequired updates last_seen_at without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
});
