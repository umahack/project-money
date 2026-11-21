import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  METRIC_DEFINITIONS,
  METRIC_NAMES,
  calculateMetricReport,
  classifySourceAvailability,
  classifyTarget,
  createPeriod,
  targetFor,
} from '../../src/domain/measurement.js';

/**
 * Feature: financial-clarity-experience, Property 30: Metric classifications and source failures are isolated.
 *
 * **Validates: Requirements 13.20, 13.21, 13.22, 13.23, 13.24, 13.25, 13.26, 13.27, 13.28, 13.29, 13.30, 13.31**
 *
 * The reference model is written from the requirements and does not call the production
 * helpers. It uses BigInt cross-multiplication for every rate target, the exact median
 * fraction for the 120 second target, its own local-clock calendar arithmetic, and a
 * boundary-point sweep (not interval merging) for outage coverage.
 *
 * Model conventions that match the 16.1 implementation decisions (as documented in
 * backend/src/domain/measurement.js and the 16.3 property test):
 * - Rate targets compare the unrounded ratio; the one-decimal display never decides a status.
 * - The sample size is the metric denominator (the count of durations for the median).
 *   Below the minimum sample the status is insufficient_data, with the observed counts kept.
 * - Cohort targets exist for 28-day periods only. Weekly cohort rows carry no target and a
 *   null targetStatus. Change targets (zero percent, minimum one change) apply to both types.
 * - The even-count median is the exact fraction (sum / 2) and is compared to 120000 exactly.
 * - A required-source outage overlapping the metric range at all makes only that metric
 *   unavailable. Outages are clipped to the range and merged per source; touching intervals
 *   merge. Unavailable rows have null values and a null targetStatus, never zero.
 * - Cohort metrics read [period start, period end). The action completion metric extends its
 *   range to the latest seven-day window end, capped at the generation instant.
 * - guided_journeys feeds the four cohort metrics only. financial_record_changes feeds the two
 *   change metrics only. product_measurement_events feeds all six.
 */

const NUM_RUNS_MIXED = 150;
const NUM_RUNS_BOUNDARY = 120;
const NUM_RUNS_ISOLATION = 120;
const NUM_RUNS_OUTAGE = 250;
const NUM_RUNS_CLASSIFY = 250;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const SEVEN_DAYS = 7;
const SOURCES = ['financial_record_changes', 'guided_journeys', 'product_measurement_events'];
const COHORT_METRICS = [
  'first_meaningful_outcome_rate',
  'median_time_to_first_meaningful_outcome',
  'clarity_confirmation_rate',
  'recommended_action_completion_rate',
];
const CHANGE_METRICS = ['financial_change_reload_rate', 'financial_change_page_wide_loading_rate'];

const stats = {
  reportCases: 0,
  weekly: 0,
  twentyEightDay: 0,
  statuses: new Set(),
  unavailableRows: 0,
  cohortOnlyUnavailable: 0,
  changeOnlyUnavailable: 0,
  allUnavailable: 0,
  actionOnlyUnavailable: 0,
  completeReports: 0,
  insufficientWithCounts: 0,
  weeklyNullTargets: 0,
  medianBoundary: 0,
  medianHalfMs: 0,
  unroundedMissWithRoundedHit: 0,
  outageCases: 0,
  outageOverlapping: 0,
  outageAdjacent: 0,
  outageDuplicate: 0,
  outageOutOfRange: 0,
  outageIgnoredSource: 0,
  outageMerged: 0,
  outageMultiSource: 0,
  isolationCases: 0,
  classifyCases: 0,
};

// ---------------------------------------------------------------------------
// Independent reference model
// ---------------------------------------------------------------------------

const REF_TARGETS = {
  first_meaningful_outcome_rate: { '28_day': { comparator: 'at_least', percent: 75, minimumSample: 100 } },
  median_time_to_first_meaningful_outcome: { '28_day': { comparator: 'at_most_ms', maxMs: 120_000, minimumSample: 100 } },
  clarity_confirmation_rate: { '28_day': { comparator: 'at_least', percent: 80, minimumSample: 50 } },
  recommended_action_completion_rate: { '28_day': { comparator: 'at_least', percent: 40, minimumSample: 100 } },
  financial_change_reload_rate: {
    weekly: { comparator: 'at_most', percent: 0, minimumSample: 1 },
    '28_day': { comparator: 'at_most', percent: 0, minimumSample: 1 },
  },
  financial_change_page_wide_loading_rate: {
    weekly: { comparator: 'at_most', percent: 0, minimumSample: 1 },
    '28_day': { comparator: 'at_most', percent: 0, minimumSample: 1 },
  },
};

const REF_SOURCES = {
  first_meaningful_outcome_rate: ['guided_journeys', 'product_measurement_events'],
  median_time_to_first_meaningful_outcome: ['guided_journeys', 'product_measurement_events'],
  clarity_confirmation_rate: ['guided_journeys', 'product_measurement_events'],
  recommended_action_completion_rate: ['guided_journeys', 'product_measurement_events'],
  financial_change_reload_rate: ['product_measurement_events', 'financial_record_changes'],
  financial_change_page_wide_loading_rate: ['product_measurement_events', 'financial_record_changes'],
};

function refPlusLocalDays(ms, days) {
  const local = new Date(ms + IST_OFFSET);
  return Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds()
  ) - IST_OFFSET;
}

function refTenths(numerator, denominator) {
  if (denominator === 0) return null;
  const scaled = BigInt(numerator) * 1000n;
  const d = BigInt(denominator);
  let quotient = scaled / d;
  if (2n * (scaled % d) >= d) quotient += 1n;
  return quotient;
}

function refDisplay(tenths) {
  return tenths === null ? null : `${tenths / 10n}.${tenths % 10n}`;
}

function refStatus(sample, minimum, meets) {
  if (sample < minimum) return 'insufficient_data';
  return meets ? 'met' : 'not_met';
}

function refMeetsRate(target, numerator, denominator) {
  if (denominator === 0) return false;
  const lhs = BigInt(numerator) * 100n;
  const rhs = BigInt(target.percent) * BigInt(denominator);
  return target.comparator === 'at_least' ? lhs >= rhs : lhs <= rhs;
}

function refMedian(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  if (count % 2 === 1) return { numerator: sorted[(count - 1) / 2], divisor: 1 };
  return { numerator: sorted[count / 2 - 1] + sorted[count / 2], divisor: 2 };
}

/** Boundary-point sweep: per source, the clipped coverage of [rangeStart, rangeEnd). */
function refAvailability(outages, requiredSources, rangeStart, rangeEnd) {
  const entries = [];
  for (const name of [...new Set(requiredSources)].sort()) {
    const clipped = outages
      .filter((o) => o.source === name)
      .map((o) => [Math.max(o.start, rangeStart), Math.min(o.end, rangeEnd)])
      .filter(([s, e]) => s < e);
    if (clipped.length === 0) continue;
    const points = [...new Set(clipped.flat())].sort((a, b) => a - b);
    let open = null;
    for (let i = 0; i < points.length - 1; i += 1) {
      const lo = points[i];
      const hi = points[i + 1];
      if (!clipped.some(([s, e]) => s <= lo && lo < e)) continue;
      if (open && open.end === lo) {
        open.end = hi;
      } else {
        open = { name, start: lo, end: hi };
        entries.push(open);
      }
    }
  }
  if (entries.length === 0) {
    return {
      sourceStatus: 'complete',
      unavailableSources: [],
      unavailableSource: null,
      unavailableStart: null,
      unavailableEndExclusive: null,
    };
  }
  return {
    sourceStatus: 'unavailable',
    unavailableSources: entries.map((e) => ({
      sourceName: e.name,
      start: new Date(e.start).toISOString(),
      endExclusive: new Date(e.end).toISOString(),
    })),
    unavailableSource: [...new Set(entries.map((e) => e.name))].join(','),
    unavailableStart: new Date(Math.min(...entries.map((e) => e.start))).toISOString(),
    unavailableEndExclusive: new Date(Math.max(...entries.map((e) => e.end))).toISOString(),
  };
}

/**
 * Scenario: { periodType, startDate, startMs, endMs, generatedAtMs,
 *   users: [{ userId, startMs, durationMs|null, responses: string[], actionOffsets: number[] }],
 *   changes: [{ changeId, tMs, reload, pageWide }],
 *   outages: [{ source, start, end }] }.
 * Every user has one eligible, in-period starting journey whose id equals the user id.
 */
function refDisplays(scenario) {
  return scenario.users
    .filter((u) => u.durationMs !== null)
    .map((u) => ({ user: u, atMs: u.startMs + u.durationMs }));
}

function refLatestActionEnd(scenario) {
  let latest = scenario.endMs;
  for (const d of refDisplays(scenario)) {
    latest = Math.max(latest, Math.min(refPlusLocalDays(d.atMs, SEVEN_DAYS), scenario.generatedAtMs));
  }
  return latest;
}

function refValues(scenario) {
  const { periodType, startMs, endMs, generatedAtMs } = scenario;
  const cohortSize = scenario.users.length;
  const displays = refDisplays(scenario);

  let responses = 0;
  let yes = 0;
  for (const u of scenario.users) {
    responses += u.responses.length;
    yes += u.responses.filter((r) => r === 'yes').length;
  }

  let completedUsers = 0;
  for (const d of displays) {
    const windowEnd = refPlusLocalDays(d.atMs, SEVEN_DAYS);
    if (d.user.actionOffsets.some((o) => d.atMs + o >= d.atMs && d.atMs + o < windowEnd)) completedUsers += 1;
  }

  const byChange = new Map();
  scenario.changes
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.tMs >= startMs && c.tMs < endMs)
    .sort((a, b) => a.tMs - b.tMs || a.index - b.index)
    .forEach((c) => { if (!byChange.has(c.changeId)) byChange.set(c.changeId, c); });
  const changes = [...byChange.values()];

  const rateRow = (metric, numerator, denominator) => {
    const target = REF_TARGETS[metric][periodType] ?? null;
    const tenths = refTenths(numerator, denominator);
    return {
      numerator,
      denominator,
      percentageTenths: tenths === null ? null : Number(tenths),
      percentageDisplay: refDisplay(tenths),
      durationMs: null,
      durationExact: null,
      targetStatus: target
        ? refStatus(denominator, target.minimumSample, refMeetsRate(target, numerator, denominator))
        : null,
    };
  };

  const median = refMedian(displays.map((d) => d.user.durationMs));
  const medianTarget = REF_TARGETS.median_time_to_first_meaningful_outcome[periodType] ?? null;
  const medianRow = {
    numerator: null,
    denominator: displays.length,
    percentageTenths: null,
    percentageDisplay: null,
    durationMs: median === null
      ? null
      : Number((BigInt(median.numerator) + BigInt(median.divisor) / 2n) / BigInt(median.divisor)),
    durationExact: median,
    targetStatus: medianTarget === null
      ? null
      : refStatus(
        displays.length,
        medianTarget.minimumSample,
        median !== null && BigInt(median.numerator) <= BigInt(medianTarget.maxMs) * BigInt(median.divisor)
      ),
  };

  const rows = {
    first_meaningful_outcome_rate: rateRow('first_meaningful_outcome_rate', displays.length, cohortSize),
    median_time_to_first_meaningful_outcome: medianRow,
    clarity_confirmation_rate: rateRow('clarity_confirmation_rate', yes, responses),
    recommended_action_completion_rate: rateRow('recommended_action_completion_rate', completedUsers, displays.length),
    financial_change_reload_rate: rateRow(
      'financial_change_reload_rate',
      changes.filter((c) => c.reload).length,
      changes.length
    ),
    financial_change_page_wide_loading_rate: rateRow(
      'financial_change_page_wide_loading_rate',
      changes.filter((c) => c.pageWide).length,
      changes.length
    ),
  };

  const latestActionEnd = refLatestActionEnd(scenario);
  const expected = {};
  for (const metric of METRIC_NAMES) {
    const rangeEnd = metric === 'recommended_action_completion_rate' ? latestActionEnd : endMs;
    const availability = refAvailability(scenario.outages, REF_SOURCES[metric], startMs, rangeEnd);
    const unavailable = availability.sourceStatus === 'unavailable';
    expected[metric] = {
      ...availability,
      values: unavailable
        ? {
          numerator: null,
          denominator: null,
          percentageTenths: null,
          percentageDisplay: null,
          durationMs: null,
          durationExact: null,
          targetStatus: null,
        }
        : rows[metric],
    };
  }
  return { expected, generatedAtMs, observed: rows };
}

// ---------------------------------------------------------------------------
// Module inputs and comparison
// ---------------------------------------------------------------------------

function toInstantText(ms, selector) {
  const iso = new Date(ms).toISOString();
  if (ms % 1000 === 0 && selector % 3 === 0) return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  return iso;
}

function shuffled(items, seed) {
  const result = [...items];
  let state = (seed >>> 0) || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function moduleInput(scenario, shuffleSeed) {
  const journeys = [];
  const events = [];
  let nextId = 1;
  const push = (fields) => { events.push({ id: nextId, ...fields }); nextId += 1; };
  for (const u of scenario.users) {
    journeys.push({
      id: u.userId,
      userId: u.userId,
      startedAt: toInstantText(u.startMs, u.userId),
      measurementEligible: true,
    });
    const displayAt = u.durationMs === null ? null : u.startMs + u.durationMs;
    if (displayAt !== null) {
      push({
        userId: u.userId,
        eventName: 'first_outcome_displayed',
        journeyId: u.userId,
        occurredAt: toInstantText(displayAt, nextId),
      });
    }
    u.responses.forEach((response, k) => push({
      userId: u.userId,
      eventName: 'clarity_response',
      journeyId: u.userId,
      response,
      occurredAt: toInstantText(u.startMs + 10 + k, nextId),
    }));
    for (const offset of u.actionOffsets) {
      push({
        userId: u.userId,
        eventName: 'recommended_action_completed',
        journeyId: u.userId,
        occurredAt: toInstantText((displayAt ?? u.startMs) + offset, nextId),
      });
    }
  }
  for (const c of scenario.changes) {
    push({
      userId: 50_000 + c.changeId,
      eventName: 'financial_change_ui',
      changeId: c.changeId,
      causedReload: c.reload,
      causedPageWideLoading: c.pageWide,
      occurredAt: toInstantText(c.tMs, nextId),
    });
  }
  const outages = scenario.outages.map((o, index) => ({
    sourceName: o.source,
    unavailableStart: toInstantText(o.start, index),
    unavailableEndExclusive: toInstantText(o.end, index + 1),
  }));
  return {
    journeys: shuffled(journeys, shuffleSeed),
    events: shuffled(events, shuffleSeed + 2),
    outages: shuffled(outages, shuffleSeed + 3),
  };
}

const VALUE_FIELDS = [
  'numerator', 'denominator', 'percentageTenths', 'percentageDisplay',
  'durationMs', 'durationExact', 'targetStatus',
];

function projectValues(row) {
  return Object.fromEntries(VALUE_FIELDS.map((key) => [key, row[key]]));
}

function localDateText(day) {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function runReport(scenario, shuffleSeed, { withOutages = true } = {}) {
  const period = createPeriod(scenario.periodType, scenario.startDate);
  assert.equal(period.start, new Date(scenario.startMs).toISOString());
  assert.equal(period.endExclusive, new Date(scenario.endMs).toISOString());
  const input = moduleInput(withOutages ? scenario : { ...scenario, outages: [] }, shuffleSeed);
  const before = JSON.stringify(input);
  const rows = calculateMetricReport({
    period,
    generatedAt: new Date(scenario.generatedAtMs).toISOString(),
    ...input,
  });
  assert.equal(JSON.stringify(input), before, 'inputs are not mutated');
  return { period, rows };
}

function assertMetadata(row, scenario, period) {
  assert.equal(row.periodType, scenario.periodType);
  assert.equal(row.periodStart, period.start);
  assert.equal(row.periodEndExclusive, period.endExclusive);
  assert.equal(row.periodStartDate, scenario.startDate);
  const lengthDays = scenario.periodType === 'weekly' ? 7 : 28;
  assert.equal(row.periodEndDateInclusive, localDateText(Math.round(Date.parse(`${scenario.startDate}T00:00:00Z`) / DAY) + lengthDays - 1));
  assert.equal(row.timeZone, 'Asia/Kolkata');
  assert.equal(typeof row.populationDefinition, 'string');
  assert.ok(row.populationDefinition.length > 0);
  assert.ok(row.population && typeof row.population === 'object');
  assert.equal(row.generatedAt, new Date(scenario.generatedAtMs).toISOString());
  assert.ok(['complete', 'unavailable'].includes(row.sourceStatus));
  assert.ok(Array.isArray(row.unavailableSources));
  assert.ok(Number.isInteger(row.calculationVersion));
  for (const field of [...VALUE_FIELDS, 'unavailableSource', 'unavailableStart', 'unavailableEndExclusive']) {
    assert.ok(field in row, `row has ${field}`);
  }
}

function checkReport(scenario, shuffleSeed) {
  const { period, rows } = runReport(scenario, shuffleSeed);
  assert.deepEqual(rows.map((row) => row.metricName), [...METRIC_NAMES]);
  const { expected, observed } = refValues(scenario);
  const unavailable = new Set();

  for (const row of rows) {
    const exp = expected[row.metricName];
    assertMetadata(row, scenario, period);

    // Availability, affected source, and affected time range.
    assert.equal(row.sourceStatus, exp.sourceStatus, row.metricName);
    assert.deepEqual(row.unavailableSources, exp.unavailableSources, row.metricName);
    assert.equal(row.unavailableSource, exp.unavailableSource, row.metricName);
    assert.equal(row.unavailableStart, exp.unavailableStart, row.metricName);
    assert.equal(row.unavailableEndExclusive, exp.unavailableEndExclusive, row.metricName);

    // Values and classification.
    assert.deepEqual(projectValues(row), exp.values, row.metricName);

    const target = REF_TARGETS[row.metricName][scenario.periodType] ?? null;
    if (row.sourceStatus === 'unavailable') {
      unavailable.add(row.metricName);
      // Unavailable is never zero and never classified.
      assert.equal(row.targetStatus, null);
      assert.equal(row.numerator, null);
      assert.equal(row.denominator, null);
      assert.equal(row.durationMs, null);
      assert.equal(row.percentageTenths, null);
      continue;
    }
    if (target === null) {
      assert.equal(row.target, null);
      assert.equal(row.targetStatus, null);
      stats.weeklyNullTargets += 1;
    } else {
      assert.ok(['met', 'not_met', 'insufficient_data'].includes(row.targetStatus));
      stats.statuses.add(row.targetStatus);
      const sample = row.metricName === 'median_time_to_first_meaningful_outcome' ? row.denominator : row.denominator;
      assert.equal(row.targetStatus === 'insufficient_data', sample < target.minimumSample, row.metricName);
      if (row.targetStatus === 'insufficient_data') {
        // Observed counts are kept alongside the classification (13.29).
        assert.equal(typeof row.denominator, 'number');
        if (row.metricName !== 'median_time_to_first_meaningful_outcome') assert.equal(typeof row.numerator, 'number');
        stats.insufficientWithCounts += 1;
      }
      const obs = observed[row.metricName];
      if (obs.percentageTenths !== null && target.comparator === 'at_least' && obs.denominator >= target.minimumSample) {
        const roundedHit = BigInt(obs.percentageTenths) >= BigInt(target.percent) * 10n;
        if (roundedHit && !refMeetsRate(target, obs.numerator, obs.denominator)) {
          stats.unroundedMissWithRoundedHit += 1;
          assert.equal(row.targetStatus, 'not_met');
        }
      }
    }
  }

  // Dependency isolation: the unavailable set is exactly the metrics with an overlapping outage.
  for (const metric of METRIC_NAMES) {
    assert.equal(unavailable.has(metric), expected[metric].sourceStatus === 'unavailable');
  }
  const cohortDown = COHORT_METRICS.every((m) => unavailable.has(m));
  const changeDown = CHANGE_METRICS.every((m) => unavailable.has(m));
  if (unavailable.size === 0) stats.completeReports += 1;
  else if (unavailable.size === 6) stats.allUnavailable += 1;
  else if (cohortDown && unavailable.size === 4) stats.cohortOnlyUnavailable += 1;
  else if (changeDown && unavailable.size === 2) stats.changeOnlyUnavailable += 1;
  else if (unavailable.size === 1 && unavailable.has('recommended_action_completion_rate')) stats.actionOnlyUnavailable += 1;
  stats.unavailableRows += unavailable.size;

  const median = observed.median_time_to_first_meaningful_outcome.durationExact;
  if (median && Math.abs(median.numerator - 120_000 * median.divisor) <= 1) {
    stats.medianBoundary += 1;
    if (median.divisor === 2 && median.numerator % 2 === 1) stats.medianHalfMs += 1;
  }
  stats.reportCases += 1;
  stats[scenario.periodType === 'weekly' ? 'weekly' : 'twentyEightDay'] += 1;
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

const BASE_DAY_MIN = 19_000;
const BASE_DAY_MAX = 21_500;

function periodFrom(periodType, rawDay) {
  let day = rawDay;
  if (periodType === 'weekly') day -= ((day + 3) % 7 + 7) % 7;
  const lengthDays = periodType === 'weekly' ? 7 : 28;
  const startMs = day * DAY - IST_OFFSET;
  return {
    periodType,
    startDate: localDateText(day),
    startMs,
    endMs: startMs + lengthDays * DAY,
    lengthMs: lengthDays * DAY,
  };
}

const periodArb = fc.record({
  periodType: fc.constantFrom('weekly', '28_day', '28_day'),
  rawDay: fc.integer({ min: BASE_DAY_MIN, max: BASE_DAY_MAX }),
}).map(({ periodType, rawDay }) => periodFrom(periodType, rawDay));

const RESPONSE_VALUES = ['yes', 'partly', 'no'];

const rawAction = fc.record({
  sel: fc.integer({ min: 0, max: 7 }),
  rand: fc.integer({ min: 0, max: 10 * DAY }),
});
const rawUser = fc.record({
  startSel: fc.integer({ min: 0, max: 5 }),
  startRand: fc.integer({ min: 0, max: 2 ** 30 }),
  displaySel: fc.integer({ min: 0, max: 2 }),
  durationSel: fc.integer({ min: 0, max: 8 }),
  durationRand: fc.integer({ min: 0, max: 2 * DAY }),
  responses: fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }),
  actions: fc.array(rawAction, { maxLength: 3 }),
});
const rawChange = fc.record({
  changeId: fc.integer({ min: 1, max: 5 }),
  timeSel: fc.integer({ min: 0, max: 6 }),
  timeRand: fc.integer({ min: 0, max: 40 * DAY }),
  reload: fc.boolean(),
  pageWide: fc.boolean(),
  zeroFlags: fc.boolean(),
});
const rawOutage = fc.record({
  source: fc.integer({ min: 0, max: 2 }),
  startSel: fc.integer({ min: 0, max: 15 }),
  startRand: fc.integer({ min: 0, max: 60 * DAY }),
  lenSel: fc.integer({ min: 0, max: 5 }),
  lenRand: fc.integer({ min: 0, max: 20 * DAY }),
  shape: fc.integer({ min: 0, max: 5 }),
});

const mixedArb = fc.record({
  period: periodArb,
  users: fc.array(rawUser, { maxLength: 9 }),
  changes: fc.array(rawChange, { maxLength: 7 }),
  outages: fc.array(rawOutage, { maxLength: 8 }),
  generatedSel: fc.integer({ min: 0, max: 6 }),
  generatedRand: fc.integer({ min: 0, max: 45 * DAY }),
  shuffleSeed: fc.integer({ min: 1, max: 2 ** 31 }),
});

function generatedAfter(sel, rand) {
  return [0, 1, 3 * DAY, 7 * DAY, 8 * DAY, rand, rand][sel];
}

function buildChanges(rawChanges, period) {
  const { startMs, endMs, lengthMs } = period;
  return rawChanges.map((c) => ({
    changeId: c.changeId,
    tMs: [
      startMs - 1, startMs, endMs - 1, endMs,
      startMs + (c.timeRand % lengthMs), startMs + (c.timeRand % lengthMs),
      startMs - (c.timeRand % (5 * DAY)) - 1,
    ][c.timeSel],
    reload: c.zeroFlags ? false : c.reload,
    pageWide: c.zeroFlags ? false : c.pageWide,
  }));
}

function buildOutages(rawOutages, scenario, shapeAnchors) {
  const outages = [];
  for (const raw of rawOutages) {
    const prev = outages[outages.length - 1];
    let source = SOURCES[raw.source];
    let start = shapeAnchors[raw.startSel % shapeAnchors.length];
    let end = start + [1, 1000, 1 + (raw.lenRand % DAY), 1 + (raw.lenRand % (5 * DAY)), 1 + raw.lenRand, DAY][raw.lenSel];
    if (prev && raw.shape === 0) { // exact duplicate
      ({ source, start, end } = prev);
    } else if (prev && raw.shape === 1) { // adjacent after the previous outage, same source
      source = prev.source;
      start = prev.end;
      end = start + 1 + (raw.lenRand % (3 * DAY));
    } else if (prev && raw.shape === 2) { // overlapping the previous outage
      source = prev.source;
      start = prev.start + Math.floor((prev.end - prev.start) / 2);
      end = prev.end + 1 + (raw.lenRand % DAY);
    } else if (prev && raw.shape === 3) { // adjacent before the previous outage
      source = prev.source;
      end = prev.start;
      start = end - 1 - (raw.lenRand % (3 * DAY));
    }
    outages.push({ source, start, end });
  }
  return outages;
}

function buildMixed(raw) {
  const { period } = raw;
  const { startMs, endMs, lengthMs } = period;
  const users = raw.users.map((u, index) => {
    const userStart = startMs + [0, 1, lengthMs - 1, lengthMs - 5000, u.startRand % lengthMs, u.startRand % lengthMs][u.startSel];
    const hasDisplay = u.displaySel !== 0;
    const durationMs = hasDisplay
      ? [0, 1, 119_999, 120_000, 120_001, u.durationRand % 300_000, u.durationRand % 300_000, u.durationRand, u.durationRand % 3_600_000][u.durationSel]
      : null;
    return {
      userId: index + 1,
      startMs: userStart,
      durationMs,
      responses: u.responses.map((i) => RESPONSE_VALUES[i]),
      actionOffsets: u.actions.map((a) => [
        -1, 0, 1, SEVEN_DAYS * DAY - 1, SEVEN_DAYS * DAY, SEVEN_DAYS * DAY + 1, a.rand, a.rand % DAY,
      ][a.sel]),
    };
  });
  const base = {
    ...period,
    generatedAtMs: endMs + generatedAfter(raw.generatedSel, raw.generatedRand),
    users,
    changes: buildChanges(raw.changes, period),
    outages: [],
  };
  const latest = refLatestActionEnd(base);
  const anchors = [
    startMs - 2 * DAY, startMs - 1, startMs, startMs + 1, endMs - 1, endMs, endMs + 1, endMs + 3 * DAY,
    latest - 1, latest, latest + 1, base.generatedAtMs, base.generatedAtMs + 1,
    startMs + (raw.outages[0]?.startRand ?? 0) % lengthMs,
    endMs + (raw.outages[0]?.startRand ?? 0) % (10 * DAY),
    startMs - ((raw.outages[0]?.startRand ?? 0) % (30 * DAY)) - 1,
  ];
  return { ...base, outages: buildOutages(raw.outages, base, anchors) };
}

/** Large, boundary-focused cohort: counts sit within a few units of every target threshold. */
const boundaryArb = fc.record({
  period: periodArb,
  cohortSize: fc.integer({ min: 96, max: 140 }),
  shuffleSeed: fc.integer({ min: 1, max: 2 ** 31 }),
  displayMode: fc.integer({ min: 0, max: 3 }),
  displayShift: fc.integer({ min: -2, max: 2 }),
  displaySmall: fc.integer({ min: 0, max: 3 }),
  displayNear100: fc.integer({ min: 98, max: 102 }),
  medianShape: fc.integer({ min: 0, max: 2 }),
  medianX: fc.integer({ min: -50, max: 50 }),
  medianSumShift: fc.integer({ min: -1, max: 1 }),
  completionMode: fc.integer({ min: 0, max: 2 }),
  completionShift: fc.integer({ min: -2, max: 2 }),
  completionWide: fc.integer({ min: 0, max: 140 }),
  nonCompleterSel: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 140, maxLength: 140 }),
  responseSize: fc.integer({ min: 0, max: 4 }),
  yesShift: fc.integer({ min: -2, max: 1 }),
  changeCount: fc.integer({ min: 0, max: 5 }),
  reloads: fc.integer({ min: 0, max: 1 }),
  pageWides: fc.integer({ min: 0, max: 1 }),
  generatedSel: fc.integer({ min: 0, max: 6 }),
  generatedRand: fc.integer({ min: 0, max: 45 * DAY }),
});

function buildBoundary(raw) {
  const { period } = raw;
  const { startMs, endMs } = period;
  const n = raw.cohortSize;
  const clamp = (value, max) => Math.max(0, Math.min(max, value));

  let displayCount;
  if (raw.displayMode === 0) displayCount = clamp(Math.ceil(0.75 * n) + raw.displayShift, n);
  else if (raw.displayMode === 1) displayCount = clamp(n - raw.displaySmall, n);
  else if (raw.displayMode === 2) displayCount = clamp(raw.displayNear100, n);
  else displayCount = clamp(Math.ceil(0.75 * n) + raw.displayShift, n);

  // Sorted durations whose middle value(s) sit at 120 s (exact fraction on the even case).
  const sorted = new Array(displayCount);
  if (displayCount > 0) {
    if (displayCount % 2 === 1) {
      const mid = (displayCount - 1) / 2;
      const midValue = raw.medianShape === 0 ? 120_000 : 120_000 + raw.medianSumShift;
      for (let i = 0; i < displayCount; i += 1) {
        sorted[i] = i < mid ? midValue - (mid - i) : i === mid ? midValue : midValue + (i - mid);
      }
    } else {
      const lo = displayCount / 2 - 1;
      let a = 120_000 + raw.medianX;
      let b = 120_000 + raw.medianSumShift - raw.medianX;
      if (raw.medianShape === 0) { a = 120_000; b = 120_000; }
      if (a > b) [a, b] = [b, a];
      for (let i = 0; i < displayCount; i += 1) {
        sorted[i] = i <= lo ? (i === lo ? a : a - (lo - i)) : (i === lo + 1 ? b : b + (i - lo - 1));
      }
    }
  }
  const durationOrder = shuffled(sorted, raw.shuffleSeed + 11);

  const completionCount = raw.completionMode === 0
    ? clamp(raw.completionWide, displayCount)
    : clamp(Math.ceil(0.4 * displayCount) + raw.completionShift, displayCount);

  const totals = [0, 49, 50, 51, 2000];
  const total = totals[raw.responseSize];
  const yesCount = clamp(Math.ceil(total * 0.8) + raw.yesShift, total);
  const responses = Array.from({ length: n }, () => []);
  for (let k = 0; k < total; k += 1) {
    responses[k % n].push(k < yesCount ? 'yes' : (k % 2 === 0 ? 'partly' : 'no'));
  }

  const users = [];
  for (let i = 0; i < n; i += 1) {
    const displays = i < displayCount;
    const completes = displays && i < completionCount;
    let actionOffsets = [];
    if (completes) actionOffsets = [(i % 3) * 1000, SEVEN_DAYS * DAY - 1, SEVEN_DAYS * DAY + 5];
    else if (displays) {
      actionOffsets = [[], [SEVEN_DAYS * DAY], [-1], [SEVEN_DAYS * DAY + 1, -5]][raw.nonCompleterSel[i]];
    }
    users.push({
      userId: i + 1,
      startMs: startMs + (i + 1) * 1000,
      durationMs: displays ? durationOrder[i] : null,
      responses: responses[i],
      actionOffsets,
    });
  }

  const changes = [];
  for (let id = 1; id <= raw.changeCount; id += 1) {
    changes.push({
      changeId: id,
      tMs: startMs + id * 500,
      reload: id <= raw.reloads,
      pageWide: id > raw.changeCount - raw.pageWides,
    });
  }
  if (raw.changeCount > 0) {
    changes.push({ changeId: 1, tMs: startMs + 3 * DAY, reload: raw.reloads < 1, pageWide: true }); // later duplicate
    changes.push({ changeId: 99, tMs: endMs, reload: true, pageWide: true }); // outside the period
  }

  return {
    ...period,
    generatedAtMs: endMs + generatedAfter(raw.generatedSel, raw.generatedRand),
    users,
    changes,
    outages: [],
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test('Property 30: mixed metrics with overlapping, adjacent, duplicate, and out-of-range outages match the reference model', () => {
  fc.assert(
    fc.property(mixedArb, (raw) => {
      const scenario = buildMixed(raw);
      checkReport(scenario, raw.shuffleSeed);
    }),
    { numRuns: NUM_RUNS_MIXED }
  );
});

test('Property 30: sample-size and target boundaries classify met, not_met, and insufficient_data exactly', () => {
  fc.assert(
    fc.property(boundaryArb, (raw) => {
      checkReport(buildBoundary(raw), raw.shuffleSeed);
    }),
    { numRuns: NUM_RUNS_BOUNDARY }
  );
});

test('Property 30: a single failed source makes only its dependent metrics unavailable and leaves the rest unchanged', () => {
  const isolationArb = fc.record({
    base: mixedArb,
    source: fc.integer({ min: 0, max: 2 }),
    startRand: fc.integer({ min: 0, max: 2 ** 30 }),
    lenRand: fc.integer({ min: 0, max: 2 ** 30 }),
    fullPeriod: fc.boolean(),
  });
  fc.assert(
    fc.property(isolationArb, (raw) => {
      const clean = buildMixed({ ...raw.base, outages: [] });
      const { startMs, endMs, lengthMs } = clean;
      const start = raw.fullPeriod ? startMs : startMs + (raw.startRand % lengthMs);
      const end = raw.fullPeriod ? endMs : Math.min(endMs, start + 1 + (raw.lenRand % lengthMs));
      const source = SOURCES[raw.source];
      const scenario = { ...clean, outages: [{ source, start, end }] };

      const baseline = runReport(clean, raw.base.shuffleSeed).rows;
      const { rows } = runReport(scenario, raw.base.shuffleSeed);
      const expectedDown = METRIC_NAMES.filter((metric) => REF_SOURCES[metric].includes(source));
      if (source === 'guided_journeys') assert.deepEqual(expectedDown, COHORT_METRICS);
      if (source === 'financial_record_changes') assert.deepEqual(expectedDown, CHANGE_METRICS);
      if (source === 'product_measurement_events') assert.equal(expectedDown.length, 6);

      rows.forEach((row, index) => {
        if (expectedDown.includes(row.metricName)) {
          assert.equal(row.sourceStatus, 'unavailable', row.metricName);
          assert.equal(row.unavailableSource, source);
          assert.equal(row.unavailableStart, new Date(start).toISOString());
          assert.equal(row.unavailableEndExclusive, new Date(end).toISOString());
          assert.equal(row.targetStatus, null);
          for (const field of ['numerator', 'denominator', 'percentageTenths', 'percentageDisplay', 'durationMs', 'durationExact']) {
            assert.equal(row[field], null, `${row.metricName}.${field}`);
          }
        } else {
          // Unaffected metrics are identical to the report produced without any outage.
          assert.deepEqual(row, baseline[index], row.metricName);
          assert.equal(row.sourceStatus, 'complete');
        }
      });
      stats.isolationCases += 1;
    }),
    { numRuns: NUM_RUNS_ISOLATION }
  );
});

test('Property 30: classifySourceAvailability merges and clips outages per source like the reference sweep', () => {
  const outageArb = fc.record({
    source: fc.integer({ min: 0, max: 2 }),
    startSel: fc.integer({ min: 0, max: 7 }),
    startRand: fc.integer({ min: 0, max: 40 * DAY }),
    lenSel: fc.integer({ min: 0, max: 4 }),
    lenRand: fc.integer({ min: 0, max: 15 * DAY }),
    shape: fc.integer({ min: 0, max: 5 }),
  });
  const availabilityArb = fc.record({
    rangeStartRaw: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
    rangeLenSel: fc.integer({ min: 0, max: 3 }),
    rangeLenRand: fc.integer({ min: 1, max: 30 * DAY }),
    required: fc.subarray(SOURCES, { minLength: 1 }),
    outages: fc.array(outageArb, { maxLength: 12 }),
    shuffleSeed: fc.integer({ min: 1, max: 2 ** 31 }),
  });
  fc.assert(
    fc.property(availabilityArb, (raw) => {
      const rangeStart = raw.rangeStartRaw * 1000;
      const rangeEnd = rangeStart + [1, 1000, DAY, raw.rangeLenRand][raw.rangeLenSel];
      const length = rangeEnd - rangeStart;
      const anchors = [
        rangeStart - DAY, rangeStart - 1, rangeStart, rangeStart + 1,
        rangeEnd - 1, rangeEnd, rangeEnd + 1, rangeStart + (raw.outages[0]?.startRand ?? 0) % length,
      ];
      const outages = [];
      for (const o of raw.outages) {
        const prev = outages[outages.length - 1];
        let source = SOURCES[o.source];
        let start = anchors[o.startSel] + (o.shape === 5 ? o.startRand % 3 : 0);
        let end = start + [1, 1000, 1 + (o.lenRand % DAY), 1 + o.lenRand, DAY][o.lenSel];
        if (prev && o.shape === 0) ({ source, start, end } = prev); // duplicate
        else if (prev && o.shape === 1) { source = prev.source; start = prev.end; end = start + 1 + (o.lenRand % DAY); } // adjacent after
        else if (prev && o.shape === 2) { source = prev.source; start = prev.start + Math.floor((prev.end - prev.start) / 2); end = prev.end + 1 + (o.lenRand % DAY); } // overlapping
        else if (prev && o.shape === 3) { source = prev.source; end = prev.start; start = end - 1 - (o.lenRand % DAY); } // adjacent before
        outages.push({ source, start, end });
      }

      const reference = refAvailability(outages, raw.required, rangeStart, rangeEnd);
      const input = {
        outages: shuffled(outages.map((o, i) => ({
          sourceName: o.source,
          unavailableStart: toInstantText(o.start, i),
          unavailableEndExclusive: toInstantText(o.end, i + 1),
        })), raw.shuffleSeed),
        requiredSources: shuffled(raw.required, raw.shuffleSeed + 1),
        rangeStart: toInstantText(rangeStart, 1),
        rangeEndExclusive: toInstantText(rangeEnd, 1),
      };
      const before = JSON.stringify(input);
      const result = classifySourceAvailability(input);
      assert.equal(JSON.stringify(input), before, 'inputs are not mutated');
      assert.deepEqual(result, reference);

      // Per-source ranges never overlap or touch, and stay inside the range.
      const bySource = new Map();
      for (const entry of result.unavailableSources) {
        const list = bySource.get(entry.sourceName) ?? [];
        list.push([Date.parse(entry.start), Date.parse(entry.endExclusive)]);
        bySource.set(entry.sourceName, list);
      }
      for (const list of bySource.values()) {
        list.forEach(([s, e], i) => {
          assert.ok(s < e && s >= rangeStart && e <= rangeEnd);
          if (i > 0) assert.ok(list[i - 1][1] < s, 'merged ranges are separated by a gap');
        });
      }

      stats.outageCases += 1;
      const clippedFor = (o) => Math.max(o.start, rangeStart) < Math.min(o.end, rangeEnd);
      const relevant = outages.filter((o) => raw.required.includes(o.source));
      if (relevant.some(clippedFor)) stats.outageOverlapping += 1;
      if (outages.some((o, i) => outages.some((p, j) => i !== j && o.source === p.source && o.end === p.start))) stats.outageAdjacent += 1;
      if (outages.some((o, i) => outages.some((p, j) => i < j && o.source === p.source && o.start === p.start && o.end === p.end))) stats.outageDuplicate += 1;
      if (relevant.some((o) => o.end <= rangeStart || o.start >= rangeEnd)) stats.outageOutOfRange += 1;
      if (outages.some((o) => !raw.required.includes(o.source))) stats.outageIgnoredSource += 1;
      if (result.unavailableSources.length > 0 && relevant.filter(clippedFor).length > result.unavailableSources.length) stats.outageMerged += 1;
      if (new Set(result.unavailableSources.map((e) => e.sourceName)).size > 1) stats.outageMultiSource += 1;
    }),
    { numRuns: NUM_RUNS_OUTAGE }
  );
});

test('Property 30: classifyTarget returns insufficient_data below the minimum sample, otherwise met or not_met', () => {
  const classifyArb = fc.oneof(
    fc.record({
      minimumSample: fc.integer({ min: 1, max: 200 }),
      offset: fc.integer({ min: -2, max: 2 }),
      meetsTarget: fc.boolean(),
    }).map((r) => ({ ...r, sampleSize: Math.max(0, r.minimumSample + r.offset) })),
    fc.record({
      minimumSample: fc.integer({ min: 1, max: 200 }),
      sampleSize: fc.integer({ min: 0, max: 400 }),
      meetsTarget: fc.boolean(),
    })
  );
  fc.assert(
    fc.property(classifyArb, ({ sampleSize, minimumSample, meetsTarget }) => {
      const expected = sampleSize < minimumSample ? 'insufficient_data' : (meetsTarget ? 'met' : 'not_met');
      assert.equal(classifyTarget({ sampleSize, minimumSample, meetsTarget }), expected);
      stats.classifyCases += 1;
    }),
    { numRuns: NUM_RUNS_CLASSIFY }
  );
  assert.throws(() => classifyTarget({ sampleSize: 1, minimumSample: 0, meetsTarget: true }), TypeError);
  assert.throws(() => classifyTarget({ sampleSize: -1, minimumSample: 1, meetsTarget: true }), TypeError);
});

test('Property 30: metric definitions expose the required targets and thresholds per period type', () => {
  for (const metric of METRIC_NAMES) {
    for (const periodType of ['weekly', '28_day']) {
      assert.deepEqual(targetFor(metric, periodType), REF_TARGETS[metric][periodType] ?? null, `${metric} ${periodType}`);
    }
    assert.deepEqual([...METRIC_DEFINITIONS[metric].sources].sort(), [...REF_SOURCES[metric]].sort(), metric);
    assert.equal(typeof METRIC_DEFINITIONS[metric].populationDefinition, 'string');
  }
  assert.deepEqual(Object.keys(METRIC_DEFINITIONS).sort(), [...METRIC_NAMES].sort());
  assert.throws(() => targetFor('unknown_metric', '28_day'), RangeError);
  assert.throws(() => targetFor('first_meaningful_outcome_rate', 'daily'), TypeError);
});

test('Property 30: reference model anchors match the requirements', () => {
  assert.equal(refDisplay(refTenths(1599, 2000)), '80.0');
  assert.equal(refMeetsRate({ comparator: 'at_least', percent: 80 }, 1599, 2000), false);
  assert.equal(refMeetsRate({ comparator: 'at_most', percent: 0 }, 0, 3), true);
  assert.equal(refMeetsRate({ comparator: 'at_most', percent: 0 }, 1, 100000), false);
  assert.deepEqual(refMedian([4, 1, 2, 9]), { numerator: 6, divisor: 2 });
  const merged = refAvailability(
    [
      { source: 'guided_journeys', start: 0, end: 5 },
      { source: 'guided_journeys', start: 5, end: 9 },
      { source: 'guided_journeys', start: 20, end: 30 },
      { source: 'guided_journeys', start: 2, end: 3 },
    ],
    ['guided_journeys'],
    1,
    25
  );
  assert.deepEqual(merged.unavailableSources.map((e) => [Date.parse(e.start), Date.parse(e.endExclusive)]), [[1, 9], [20, 25]]);
});

after(() => {
  // Non-vacuity: the generators must exercise the cases the property is about.
  assert.ok(stats.reportCases >= 100, `generated ${stats.reportCases} report cases`);
  assert.ok(stats.reportCases + stats.outageCases + stats.isolationCases >= 100, 'total generated cases');
  assert.ok(stats.weekly >= 5 && stats.twentyEightDay >= 50, 'both period types');
  assert.ok(['met', 'not_met', 'insufficient_data'].every((s) => stats.statuses.has(s)), 'all target statuses');
  assert.ok(stats.insufficientWithCounts >= 10, 'insufficient data with observed counts');
  assert.ok(stats.weeklyNullTargets >= 5, 'weekly cohort rows without targets');
  assert.ok(stats.unavailableRows >= 20, 'unavailable rows');
  assert.ok(stats.cohortOnlyUnavailable + stats.changeOnlyUnavailable + stats.allUnavailable >= 1, 'isolated outage shapes');
  assert.ok(stats.completeReports >= 5, 'reports with no outage');
  assert.ok(stats.medianBoundary >= 10, 'medians next to 120 s');
  assert.ok(stats.medianHalfMs >= 1, 'half-millisecond medians next to 120 s');
  assert.ok(stats.outageOverlapping >= 50, 'overlapping outages');
  assert.ok(stats.outageAdjacent >= 10, 'adjacent outages');
  assert.ok(stats.outageDuplicate >= 10, 'duplicate outages');
  assert.ok(stats.outageOutOfRange >= 10, 'out-of-range outages');
  assert.ok(stats.outageIgnoredSource >= 10, 'outages of non-required sources');
  assert.ok(stats.outageMerged >= 10, 'merged outages');
  assert.ok(stats.outageMultiSource >= 5, 'multi-source outages');
  assert.ok(stats.isolationCases >= 100, 'isolation cases');
  assert.ok(stats.classifyCases >= 100, 'classifyTarget cases');
  console.log(`# measurement classification property coverage: ${JSON.stringify({ ...stats, statuses: [...stats.statuses] })}`);
});
