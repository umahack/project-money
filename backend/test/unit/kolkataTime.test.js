import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KOLKATA_TIME_ZONE,
  KOLKATA_UTC_OFFSET_SECONDS,
  kolkataDateOf,
  kolkataMonthOf,
  parseTimestampMs,
} from '../../src/domain/kolkataTime.js';
import { FINANCIAL_CLARITY_TIME_ZONE } from '../../src/domain/monthlyPlan.js';

test('the offset is +05:30 and the zone is the existing product zone', () => {
  assert.equal(KOLKATA_UTC_OFFSET_SECONDS, 5.5 * 60 * 60);
  assert.equal(KOLKATA_TIME_ZONE, FINANCIAL_CLARITY_TIME_ZONE);
  assert.equal(KOLKATA_TIME_ZONE, 'Asia/Kolkata');
});

test('the Kolkata date changes at 18:30 UTC', () => {
  assert.equal(kolkataDateOf('2025-03-04T18:29:59.999Z'), '2025-03-04');
  assert.equal(kolkataDateOf('2025-03-04T18:30:00Z'), '2025-03-05');
  assert.equal(kolkataDateOf('2025-03-04T00:00:00Z'), '2025-03-04');
  assert.equal(kolkataDateOf('2025-03-04T23:59:59Z'), '2025-03-05');
});

test('month, year, and leap-day boundaries roll over', () => {
  assert.equal(kolkataDateOf('2025-01-31T18:30:00Z'), '2025-02-01');
  assert.equal(kolkataDateOf('2025-12-31T18:30:00Z'), '2026-01-01');
  assert.equal(kolkataDateOf('2024-02-28T18:30:00Z'), '2024-02-29');
  assert.equal(kolkataDateOf('2024-02-29T18:30:00Z'), '2024-03-01');
  assert.equal(kolkataDateOf('2025-02-28T18:30:00Z'), '2025-03-01');
  assert.equal(kolkataMonthOf('2025-04-30T18:30:00Z'), '2025-05');
  assert.equal(kolkataMonthOf('2025-04-30T18:29:59Z'), '2025-04');
});

test('SQLite timestamps without a zone are read as UTC', () => {
  assert.equal(kolkataDateOf('2025-03-04 18:30:00'), '2025-03-05');
  assert.equal(kolkataDateOf('2025-03-04 18:29:59'), '2025-03-04');
  assert.equal(kolkataDateOf('2025-03-04T18:30'), '2025-03-05');
});

test('an explicit offset is honoured before conversion', () => {
  assert.equal(kolkataDateOf('2025-03-05T00:00:00+05:30'), '2025-03-05');
  assert.equal(kolkataDateOf('2025-03-04T23:59:59+05:30'), '2025-03-04');
  assert.equal(kolkataDateOf('2025-03-04T20:00:00-05:00'), '2025-03-05');
  assert.equal(kolkataDateOf('2025-03-04T20:00:00-0500'), '2025-03-05');
});

test('Date objects and epoch milliseconds convert the same as strings', () => {
  const iso = '2025-06-30T18:30:00.000Z';
  assert.equal(kolkataDateOf(new Date(iso)), '2025-07-01');
  assert.equal(kolkataDateOf(Date.parse(iso)), '2025-07-01');
  assert.equal(parseTimestampMs(iso), Date.parse(iso));
});

test('unparseable or out-of-range values give null', () => {
  const invalid = [
    '', 'not a date', '2025-03-04', '2025-02-30T00:00:00Z', '2025-13-01T00:00:00Z',
    '2025-03-04T24:00:00Z', '2025-03-04T10:60:00Z', '2025-03-04T10:00:60Z',
    '2025-03-04T10:00:00+24:00', 'Tue Mar 04 2025 10:00:00', '2025-03-04T10:00:00Zjunk',
    null, undefined, {}, [], true, NaN, Infinity, new Date('x'), 8.64e15 + 1,
    Number.MAX_SAFE_INTEGER, 1.5,
  ];
  for (const value of invalid) {
    assert.equal(kolkataDateOf(value), null, `expected null for ${String(value)}`);
    assert.equal(kolkataMonthOf(value), null);
  }
});

test('the conversion does not depend on the process time zone', () => {
  const instants = [
    '2025-03-04T18:29:59Z', '2025-03-04T18:30:00Z', '2024-02-29T18:30:00Z',
    '2025-12-31T18:29:59Z', '2025-12-31T18:30:00Z', '2025-10-26T00:30:00Z',
  ];
  const expected = instants.map((instant) => kolkataDateOf(instant));
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      process.env.TZ = zone;
      assert.deepEqual(instants.map((instant) => kolkataDateOf(instant)), expected, zone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.deepEqual(expected, [
    '2025-03-04', '2025-03-05', '2024-03-01', '2025-12-31', '2026-01-01', '2025-10-26',
  ]);
});

test('fixed arithmetic agrees with the Intl calendar for Asia/Kolkata', () => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const start = Date.UTC(2023, 11, 25, 17, 0, 0);
  const stepMs = 37 * 60 * 1000 + 13_000;
  for (let index = 0; index < 4000; index += 1) {
    const instant = new Date(start + index * stepMs);
    assert.equal(kolkataDateOf(instant), formatter.format(instant), instant.toISOString());
  }
});
