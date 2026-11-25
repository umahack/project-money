import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import request from 'supertest';
import { createIsolatedTestDatabase } from '../helpers/testDatabase.js';

/*
 * Requirement 15: the backend accepts the Capacitor Android WebView origin
 * (`https://localhost`, androidScheme https) and the production web origin, and
 * no other origin. Matching is exact and byte for byte.
 */
const ANDROID_ORIGIN = 'https://localhost';
const WEB_ORIGIN = 'https://project-money.online';
const CONFIGURED = `${ANDROID_ORIGIN},${WEB_ORIGIN}`;

const REJECTED_ORIGINS = [
  ['different scheme', 'http://localhost'],
  ['different port', 'https://localhost:3000'],
  ['explicit default port', 'https://localhost:443'],
  ['trailing slash', 'https://localhost/'],
  ['trailing slash on the web origin', `${WEB_ORIGIN}/`],
  ['host that starts with an allowed host', 'https://localhost.evil.com'],
  ['host that ends with an allowed host', 'https://evil-localhost'],
  ['host sharing the web origin suffix', 'https://evil.project-money.online'],
  ['allowed host as a subdomain of another host', 'https://project-money.online.evil.example'],
  ['foreign host', 'https://evil.example'],
  ['upper-case scheme', 'HTTPS://localhost'],
  ['upper-case host', 'https://LOCALHOST'],
  ['upper-case web host', 'https://Project-Money.online'],
  ['literal null origin', 'null'],
  ['wildcard string', '*'],
  ['leading whitespace', ' https://localhost'],
  ['trailing whitespace', 'https://localhost '],
  ['userinfo trick', 'https://localhost@evil.example'],
  ['comma-joined pair', CONFIGURED],
  ['capacitor scheme', 'capacitor://localhost'],
];

let testDatabase;
let server;
let resolveCorsOrigin;
let createApp;

/** Runs the origin callback and reports whether it allowed the origin. */
function decide(originCallback, origin) {
  let outcome;
  originCallback(origin, (error, allowed) => {
    outcome = { error, allowed };
  });
  assert.ok(outcome, 'the origin callback must answer synchronously');
  return outcome;
}

before(async () => {
  testDatabase = await createIsolatedTestDatabase();
  process.env.CORS_ORIGIN = CONFIGURED;
  ({ createApp, resolveCorsOrigin } = await import('../../src/app.js'));
  server = createApp().listen(0, '127.0.0.1');
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

test('allowlist accepts exactly the configured origins, including https://localhost', () => {
  const originCallback = resolveCorsOrigin(CONFIGURED, true);
  assert.equal(typeof originCallback, 'function');
  for (const origin of [ANDROID_ORIGIN, WEB_ORIGIN]) {
    const outcome = decide(originCallback, origin);
    assert.equal(outcome.error, null, origin);
    assert.equal(outcome.allowed, true, origin);
  }
});

test('allowlist entries are trimmed and empty entries are ignored', () => {
  const originCallback = resolveCorsOrigin(` ${ANDROID_ORIGIN} , ,${WEB_ORIGIN},`, true);
  assert.equal(decide(originCallback, ANDROID_ORIGIN).allowed, true);
  assert.equal(decide(originCallback, WEB_ORIGIN).allowed, true);
  assert.ok(decide(originCallback, '').allowed, 'an absent Origin (curl, server-to-server) stays allowed');
  assert.ok(decide(originCallback, ' ').error instanceof Error, 'a blank Origin is not an allowlist entry');
});

for (const [label, origin] of REJECTED_ORIGINS) {
  test(`allowlist rejects ${label}: ${JSON.stringify(origin)}`, () => {
    const outcome = decide(resolveCorsOrigin(CONFIGURED, true), origin);
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /^CORS: origin not allowed$/);
    assert.notEqual(outcome.allowed, true);
  });
}

test('a single-entry allowlist for the web origin does not accept https://localhost', () => {
  const outcome = decide(resolveCorsOrigin(WEB_ORIGIN, true), ANDROID_ORIGIN);
  assert.ok(outcome.error instanceof Error);
});

test('an allowlist never turns into a wildcard match', () => {
  // A literal "*" entry beside real entries matches only an Origin that is the
  // literal string "*", never every origin.
  const originCallback = resolveCorsOrigin(`${ANDROID_ORIGIN},*`, true);
  assert.ok(decide(originCallback, 'https://evil.example').error instanceof Error);
  assert.ok(decide(originCallback, 'null').error instanceof Error);
  assert.equal(decide(originCallback, ANDROID_ORIGIN).allowed, true);
});

test('production refuses to boot without a specific allowlist', () => {
  for (const value of [undefined, '', '*']) {
    assert.throws(
      () => resolveCorsOrigin(value, true),
      /CORS_ORIGIN must be set to a specific allowlist in production\. Refusing to boot\./,
      `value ${JSON.stringify(value)}`,
    );
  }
  // Outside production the unset value keeps its permissive development behaviour.
  assert.equal(resolveCorsOrigin(undefined, false), true);

  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.CORS_ORIGIN;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGIN;
    assert.throws(() => createApp(), /CORS_ORIGIN must be set to a specific allowlist in production/);
    process.env.CORS_ORIGIN = '*';
    assert.throws(() => createApp(), /CORS_ORIGIN must be set to a specific allowlist in production/);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    process.env.CORS_ORIGIN = previousCorsOrigin;
  }
});

test('a simple request from https://localhost gets Access-Control-Allow-Origin: https://localhost', async () => {
  const response = await request(server).get('/api/health').set('Origin', ANDROID_ORIGIN);
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], ANDROID_ORIGIN);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('a preflight from https://localhost is answered with that exact origin and no credentials header', async () => {
  const response = await request(server)
    .options('/api/auth/login')
    .set('Origin', ANDROID_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,authorization');
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], ANDROID_ORIGIN);
  assert.notEqual(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('the production web origin keeps working beside https://localhost', async () => {
  const response = await request(server).get('/api/health').set('Origin', WEB_ORIGIN);
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], WEB_ORIGIN);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

for (const [label, origin] of REJECTED_ORIGINS.filter(([, value]) => !/\s/.test(value))) {
  test(`HTTP: ${label} (${JSON.stringify(origin)}) gets no Access-Control-Allow-Origin header`, async () => {
    const simple = await request(server).get('/api/health').set('Origin', origin);
    assert.equal(simple.status, 403);
    assert.equal(simple.headers['access-control-allow-origin'], undefined);
    assert.equal(simple.headers['access-control-allow-credentials'], undefined);

    const preflight = await request(server)
      .options('/api/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  });
}

test('a request without an Origin header is still served and carries no CORS headers', async () => {
  const response = await request(server).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});
