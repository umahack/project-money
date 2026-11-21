import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  METRIC_NAMES,
  calculateMedian,
  calculateMetricReport,
  calculateRate,
  createPeriod,
} from '../../src/domain/measurement.js';

/**
 * Feature: financial-clarity-experience, Property 29: Success metrics use exact populations and arithmetic.
 *
 * **Validates: Requirements 13.6, 13.7, 13.8, 13.9, 13.12, 13.14, 13.15, 13.16, 13.17, 13.18, 13.19**
 *
 * The reference model below is written from the requirements and does not import
 * or mirror the production helpers. It uses its own calendar arithmetic
 * (Date.UTC local-clock addition), BigInt long division for half-up rounding,
 * and BigInt cross-multiplication for target comparison.
 *
 * Model conventions that match the 16.1 implementation decisions:
 * - A first outcome counts only when it names the user's starting (earliest) journey and is
 *   not earlier than that journey's start; the earliest such display is used. Ingestion enforces
 *   the same-session rule, so event presence stands for it.
 * - Clarity responses are counted per submission on the starting journey and only for the
 *   values yes, partly, and no. Other values never enter the denominator.
 * - Action completions are matched by user alone inside [display, display + 7 local dates);
 *   a user contributes at most once however many completions fall in the window.
 * - The change population is the distinct change ids reported inside [start, end) whose two
 *   flags are real booleans; the earliest report of an id wins.
 * - Cohort events have no upper time bound; consent exclusion applies when analytics is off
 *   and the change time is unknown or earlier than the period end.
 * - The even-count median is carried as an exact fraction; durationMs is that value rounded half up.
 */

const NUM_RUNS_MIXED = 150;
const NUM_RUNS_BOUNDARY = 120;
const NUM_RUNS_ARITHMETIC = 200;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const SEVEN_DAYS = 7;
const RESPONSE_VALUES = ['yes', 'partly', 'no'];

const stats = {
  cases: 0,
  withMeasurableCohort: 0,
  withDisplays: 0,
  optedOut: 0,
  notEligibleExcluded: 0,
  duplicateChanges: 0,
  oddMedian: 0,
  evenMedian: 0,
  halfMillisecondMedian: 0,
  emptyMedian: 0,
  multiCompletionUsers: 0,
  outsideWindowCompletions: 0,
  openWindows: 0,
  invalidResponses: 0,
  nullRates: 0,
  statuses: new Set(),
  weekly: 0,
  twentyEightDay: 0,
  unroundedMissWithRoundedHit: 0,
};

// ---------------------------------------------------------------------------
// Independent reference model
// ---------------------------------------------------------------------------

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

/** Percentage tenths by long division: floor(1000 n / d), plus one when the remainder is at least half. */
function refTenths(numerator, denominator) {
  if (denominator === 0) return null;
  const scaled = BigInt(numerator) * 1000n;
  const d = BigInt(denominator);
  let quotient = scaled / d;
  if (2n * (scaled % d) >= d) quotient += 1n;
  return quotient;
}

function refDisplay(tenths) {
  if (tenths === null) return null;
  return `${tenths / 10n}.${tenths % 10n}`;
}

function refAtLeast(numerator, denominator, percent) {
  return BigInt(numerator) * 100n >= BigInt(percent) * BigInt(denominator);
}

function refAtMost(numerator, denominator, percent) {
  return BigInt(numerator) * 100n <= BigInt(percent) * BigInt(denominator);
}

function refStatus(sample, minimum, meets) {
  if (sample < minimum) return 'insufficient_data';
  return meets ? 'met' : 'not_met';
}

function refMedian(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  if (count % 2 === 1) return { numerator: sorted[(count - 1) / 2], divisor: 1 };
  return { numerator: sorted[count / 2 - 1] + sorted[count / 2], divisor: 2 };
}

function refRateRow(numerator, denominator, target) {
  const tenths = refTenths(numerator, denominator);
  let targetStatus = null;
  if (target) {
    const meets = denominator > 0
      && (target.comparator === 'at_least'
        ? refAtLeast(numerator, denominator, target.percent)
        : refAtMost(numerator, denominator, target.percent));
    targetStatus = refStatus(denominator, target.minimum, meets);
  }
  return {
    numerator,
    denominator,
    percentageTenths: tenths === null ? null : Number(tenths),
    percentageDisplay: refDisplay(tenths),
    durationMs: null,
    durationExact: null,
    targetStatus,
  };
}

const TARGETS = {
  first_meaningful_outcome_rate: { '28_day': { comparator: 'at_least', percent: 75, minimum: 100 } },
  clarity_confirmation_rate: { '28_day': { comparator: 'at_least', percent: 80, minimum: 50 } },
  recommended_action_completion_rate: { '28_day': { comparator: 'at_least', percent: 40, minimum: 100 } },
  financial_change_reload_rate: {
    weekly: { comparator: 'at_most', percent: 0, minimum: 1 },
    '28_day': { comparator: 'at_most', percent: 0, minimum: 1 },
  },
  financial_change_page_wide_loading_rate: {
    weekly: { comparator: 'at_most', percent: 0, minimum: 1 },
    '28_day': { comparator: 'at_most', percent: 0, minimum: 1 },
  },
};
const MEDIAN_TARGET = { '28_day': { maxMs: 120_000, minimum: 100 } };

/**
 * Facts use millisecond numbers. `scenario` = { periodType, startMs, endMs, generatedAtMs,
 * journeys: [{ id, userId, startMs, eligible }], consents: [{ userId, enabled, changedMs }],
 * events: [{ id, userId, name, journeyId, response, changeId, reload, pageWide, tMs }] }.
 */
function referenceReport(scenario) {
  const { periodType, startMs, endMs, generatedAtMs, journeys, consents, events } = scenario;

  // Cohort: each user's earliest journey (lowest start, then lowest id) over the full history.
  const earliest = new Map();
  for (const j of journeys) {
    const best = earliest.get(j.userId);
    if (!best || j.startMs < best.startMs || (j.startMs === best.startMs && j.id < best.id)) {
      earliest.set(j.userId, j);
    }
  }
  const consentOf = new Map(consents.map((c) => [c.userId, c]));
  let newUsers = 0;
  let excludedNotEligible = 0;
  let excludedOptedOut = 0;
  const cohort = [];
  for (const j of earliest.values()) {
    if (j.startMs < startMs || j.startMs >= endMs) continue;
    newUsers += 1;
    if (!j.eligible) {
      excludedNotEligible += 1;
      continue;
    }
    const consent = consentOf.get(j.userId);
    if (consent && !consent.enabled && (consent.changedMs === null || consent.changedMs < endMs)) {
      excludedOptedOut += 1;
      continue;
    }
    cohort.push(j);
  }

  // First outcome displays on the starting journey.
  const displays = [];
  for (const j of cohort) {
    const times = events
      .filter((e) => e.name === 'first_outcome_displayed' && e.userId === j.userId
        && e.journeyId === j.id && e.tMs >= j.startMs)
      .map((e) => e.tMs);
    if (times.length > 0) displays.push({ userId: j.userId, atMs: Math.min(...times), durationMs: Math.min(...times) - j.startMs });
  }

  // Clarity responses.
  let responses = 0;
  let yes = 0;
  let invalidResponses = 0;
  for (const j of cohort) {
    for (const e of events) {
      if (e.name !== 'clarity_response' || e.userId !== j.userId || e.journeyId !== j.id || e.tMs < j.startMs) continue;
      if (!RESPONSE_VALUES.includes(e.response)) {
        invalidResponses += 1;
        continue;
      }
      responses += 1;
      if (e.response === 'yes') yes += 1;
    }
  }

  // Action completions: one per user inside [display, display + 7 local dates).
  let completedUsers = 0;
  let openWindows = 0;
  let multiCompletionUsers = 0;
  let outsideWindowCompletions = 0;
  for (const d of displays) {
    const windowEnd = refPlusLocalDays(d.atMs, SEVEN_DAYS);
    if (windowEnd > generatedAtMs) openWindows += 1;
    const actions = events.filter((e) => e.name === 'recommended_action_completed' && e.userId === d.userId);
    const inside = actions.filter((e) => e.tMs >= d.atMs && e.tMs < windowEnd);
    if (inside.length > 0) completedUsers += 1;
    if (inside.length > 1) multiCompletionUsers += 1;
    outsideWindowCompletions += actions.length - inside.length;
  }

  // Financial changes: distinct ids reported inside the period, earliest report wins.
  const validChanges = events
    .filter((e) => e.name === 'financial_change_ui' && e.tMs >= startMs && e.tMs < endMs
      && Number.isSafeInteger(e.changeId) && typeof e.reload === 'boolean' && typeof e.pageWide === 'boolean')
    .sort((a, b) => a.tMs - b.tMs || a.id - b.id);
  const byChange = new Map();
  for (const e of validChanges) if (!byChange.has(e.changeId)) byChange.set(e.changeId, e);
  const changes = [...byChange.values()];
  const reloads = changes.filter((c) => c.reload).length;
  const pageWide = changes.filter((c) => c.pageWide).length;
  const changeEventCount = events.filter((e) => e.name === 'financial_change_ui').length;

  const median = refMedian(displays.map((d) => d.durationMs));
  const medianTarget = MEDIAN_TARGET[periodType] ?? null;
  const medianRow = {
    numerator: null,
    denominator: displays.length,
    percentageTenths: null,
    percentageDisplay: null,
    durationMs: median === null ? null : Number((BigInt(median.numerator) + BigInt(median.divisor) / 2n) / BigInt(median.divisor)),
    durationExact: median,
    targetStatus: medianTarget === null
      ? null
      : refStatus(
        displays.length,
        medianTarget.minimum,
        median !== null && BigInt(median.numerator) <= BigInt(medianTarget.maxMs) * BigInt(median.divisor)
      ),
  };
  const targetOf = (metric) => TARGETS[metric]?.[periodType] ?? null;
  const cohortPopulation = {
    newUsers,
    measurableUsers: cohort.length,
    excludedNotMeasurementEligible: excludedNotEligible,
    excludedOptedOut,
  };
  const expected = {
    first_meaningful_outcome_rate: {
      ...refRateRow(displays.length, cohort.length, targetOf('first_meaningful_outcome_rate')),
      population: cohortPopulation,
    },
    median_time_to_first_meaningful_outcome: { ...medianRow, population: cohortPopulation },
    clarity_confirmation_rate: {
      ...refRateRow(yes, responses, targetOf('clarity_confirmation_rate')),
      population: cohortPopulation,
    },
    recommended_action_completion_rate: {
      ...refRateRow(completedUsers, displays.length, targetOf('recommended_action_completion_rate')),
      population: { ...cohortPopulation, openActionWindows: openWindows },
    },
    financial_change_reload_rate: {
      ...refRateRow(reloads, changes.length, targetOf('financial_change_reload_rate')),
      population: { validFinancialChanges: changes.length },
    },
    financial_change_page_wide_loading_rate: {
      ...refRateRow(pageWide, changes.length, targetOf('financial_change_page_wide_loading_rate')),
      population: { validFinancialChanges: changes.length },
    },
  };
  return {
    expected,
    notes: {
      cohortSize: cohort.length,
      displays: displays.length,
      invalidResponses,
      multiCompletionUsers,
      outsideWindowCompletions,
      openWindows,
      validChanges: changes.length,
      changeEventCount,
      median,
    },
  };
}

// ---------------------------------------------------------------------------
// Module inputs and comparison
// ---------------------------------------------------------------------------

/** Alternate between the ISO and the SQLite timestamp forms the repositories can return. */
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
  const journeys = scenario.journeys.map((j) => ({
    id: j.id,
    userId: j.userId,
    startedAt: toInstantText(j.startMs, j.id),
    measurementEligible: j.eligible,
  }));
  const consents = scenario.consents.map((c) => ({
    userId: c.userId,
    analyticsEnabled: c.enabled,
    analyticsChangedAt: c.changedMs === null ? null : toInstantText(c.changedMs, c.userId),
  }));
  const events = scenario.events.map((e) => {
    const base = {
      id: e.id,
      userId: e.userId,
      eventName: e.name,
      occurredAt: toInstantText(e.tMs, e.id),
    };
    if (e.name === 'financial_change_ui') {
      return { ...base, changeId: e.changeId, causedReload: e.reload, causedPageWideLoading: e.pageWide };
    }
    if (e.name === 'clarity_response') return { ...base, journeyId: e.journeyId, response: e.response };
    return { ...base, journeyId: e.journeyId };
  });
  return {
    journeys: shuffled(journeys, shuffleSeed),
    consents: shuffled(consents, shuffleSeed + 1),
    events: shuffled(events, shuffleSeed + 2),
  };
}

const PROJECTED = [
  'numerator', 'denominator', 'percentageTenths', 'percentageDisplay',
  'durationMs', 'durationExact', 'targetStatus', 'population',
];

function project(row) {
  return Object.fromEntries(PROJECTED.map((key) => [key, row[key]]));
}

function checkScenario(scenario, shuffleSeed) {
  const period = createPeriod(scenario.periodType, scenario.startDate);
  // The reference bounds are computed independently of the production period helper.
  assert.equal(period.start, new Date(scenario.startMs).toISOString());
  assert.equal(period.endExclusive, new Date(scenario.endMs).toISOString());

  const input = moduleInput(scenario, shuffleSeed);
  const before = JSON.stringify(input);
  const rows = calculateMetricReport({
    period,
    generatedAt: new Date(scenario.generatedAtMs).toISOString(),
    ...input,
  });
  assert.equal(JSON.stringify(input), before, 'inputs are not mutated');
  assert.deepEqual(rows.map((row) => row.metricName), [...METRIC_NAMES]);

  const { expected, notes } = referenceReport(scenario);
  for (const row of rows) {
    assert.deepEqual(project(row), expected[row.metricName], row.metricName);
    assert.equal(row.sourceStatus, 'complete');
    // Rounding is display only: the status always follows the unrounded ratio.
    const exp = expected[row.metricName];
    if (exp.percentageTenths !== null && row.target && row.target.comparator === 'at_least'
      && exp.denominator >= row.target.minimumSample) {
      const roundedHit = BigInt(exp.percentageTenths) >= BigInt(row.target.percent) * 10n;
      const exactHit = refAtLeast(exp.numerator, exp.denominator, row.target.percent);
      if (roundedHit && !exactHit) {
        stats.unroundedMissWithRoundedHit += 1;
        assert.equal(row.targetStatus, 'not_met');
      }
    }
    if (exp.percentageTenths === null && exp.durationMs === null) {
      stats.nullRates += 1;
      assert.equal(row.percentageTenths, null);
      assert.equal(row.percentageDisplay, null);
      assert.equal(row.durationMs, null);
    }
    if (exp.targetStatus) stats.statuses.add(exp.targetStatus);
  }

  stats.cases += 1;
  stats[scenario.periodType === 'weekly' ? 'weekly' : 'twentyEightDay'] += 1;
  const pop = expected.first_meaningful_outcome_rate.population;
  if (pop.measurableUsers > 0) stats.withMeasurableCohort += 1;
  if (notes.displays > 0) stats.withDisplays += 1;
  if (pop.excludedOptedOut > 0) stats.optedOut += 1;
  if (pop.excludedNotMeasurementEligible > 0) stats.notEligibleExcluded += 1;
  if (notes.changeEventCount > notes.validChanges) stats.duplicateChanges += 1;
  if (notes.invalidResponses > 0) stats.invalidResponses += 1;
  if (notes.multiCompletionUsers > 0) stats.multiCompletionUsers += 1;
  if (notes.outsideWindowCompletions > 0) stats.outsideWindowCompletions += 1;
  if (notes.openWindows > 0) stats.openWindows += 1;
  if (notes.median === null) stats.emptyMedian += 1;
  else if (notes.median.divisor === 1) stats.oddMedian += 1;
  else {
    stats.evenMedian += 1;
    if (notes.median.numerator % 2 === 1) stats.halfMillisecondMedian += 1;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const BASE_DAY_MIN = 19_000; // 2022-01-08
const BASE_DAY_MAX = 21_500; // 2028-11-02

function periodFrom(periodType, rawDay) {
  let day = rawDay;
  if (periodType === 'weekly') day -= ((day + 3) % 7 + 7) % 7; // snap to Monday (1970-01-01 is Thursday)
  const lengthDays = periodType === 'weekly' ? 7 : 28;
  const startMs = day * DAY - IST_OFFSET;
  return {
    periodType,
    startDate: new Date(day * DAY).toISOString().slice(0, 10),
    startMs,
    endMs: startMs + lengthDays * DAY,
    lengthMs: lengthDays * DAY,
  };
}

const periodArb = fc.record({
  periodType: fc.constantFrom('weekly', '28_day', '28_day'),
  rawDay: fc.integer({ min: BASE_DAY_MIN, max: BASE_DAY_MAX }),
}).map(({ periodType, rawDay }) => periodFrom(periodType, rawDay));

const rawOutcome = fc.record({
  journeySel: fc.integer({ min: 0, max: 9 }),
  deltaSel: fc.integer({ min: 0, max: 7 }),
  deltaRand: fc.integer({ min: 0, max: 400_000 }),
});
const rawResponse = fc.record({
  journeySel: fc.integer({ min: 0, max: 9 }),
  deltaSel: fc.integer({ min: 0, max: 3 }),
  deltaRand: fc.integer({ min: 0, max: 3_600_000 }),
  valueSel: fc.integer({ min: 0, max: 6 }),
});
const rawAction = fc.record({
  anchorSel: fc.integer({ min: 0, max: 9 }),
  deltaSel: fc.integer({ min: 0, max: 8 }),
  deltaRand: fc.integer({ min: 0, max: 10 * DAY }),
});
const rawExtraJourney = fc.record({
  sel: fc.integer({ min: 0, max: 5 }),
  rand: fc.integer({ min: 0, max: 30 * DAY }),
  eligible: fc.boolean(),
});
const rawUser = fc.record({
  hasJourney: fc.integer({ min: 0, max: 9 }),
  startSel: fc.integer({ min: 0, max: 9 }),
  startRand: fc.integer({ min: 0, max: 2 ** 30 }),
  eligibleSel: fc.integer({ min: 0, max: 9 }),
  extraJourneys: fc.array(rawExtraJourney, { maxLength: 2 }),
  consentSel: fc.integer({ min: 0, max: 9 }),
  consentRand: fc.integer({ min: 0, max: 2 ** 30 }),
  outcomes: fc.array(rawOutcome, { maxLength: 3 }),
  responses: fc.array(rawResponse, { maxLength: 3 }),
  actions: fc.array(rawAction, { maxLength: 3 }),
  noise: fc.boolean(),
});
const rawChange = fc.record({
  changeId: fc.integer({ min: 1, max: 8 }),
  timeSel: fc.integer({ min: 0, max: 9 }),
  timeRand: fc.integer({ min: 0, max: 40 * DAY }),
  reloadSel: fc.integer({ min: 0, max: 7 }),
  pageSel: fc.integer({ min: 0, max: 7 }),
});

const mixedArb = fc.record({
  period: periodArb,
  users: fc.array(rawUser, { maxLength: 14 }),
  changes: fc.array(rawChange, { maxLength: 12 }),
  generatedAfterMs: fc.integer({ min: 0, max: 45 * DAY }),
  shuffleSeed: fc.integer({ min: 1, max: 2 ** 31 }),
});

function startOffset(sel, rand, lengthMs) {
  switch (sel) {
    case 0: return -1;
    case 1: return 0;
    case 2: return 1;
    case 3: return lengthMs - 1;
    case 4: return lengthMs;
    case 5: case 6: return rand % lengthMs;
    case 7: return -(rand % (20 * DAY)) - 1;
    case 8: return lengthMs + (rand % (20 * DAY));
    default: return rand % lengthMs;
  }
}

function buildMixed(raw) {
  const { period } = raw;
  const { startMs, endMs, lengthMs } = period;
  const journeys = [];
  const consents = [];
  const events = [];
  let nextJourneyId = 1;
  let nextEventId = 1;
  const addEvent = (fields) => {
    events.push({
      id: nextEventId++, journeyId: null, response: null, changeId: null, reload: null, pageWide: null, ...fields,
    });
  };

  raw.users.forEach((user, index) => {
    const userId = index + 1;
    const primaryStart = startMs + startOffset(user.startSel, user.startRand, lengthMs);
    const own = [];
    if (user.hasJourney > 0) {
      own.push({ id: nextJourneyId++, userId, startMs: primaryStart, eligible: user.eligibleSel !== 0 });
      for (const extra of user.extraJourneys) {
        const delta = [0, -1, -extra.rand, extra.rand, -(extra.rand % 3_600_000), 1][extra.sel];
        own.push({ id: nextJourneyId++, userId, startMs: primaryStart + delta, eligible: extra.eligible });
      }
      journeys.push(...own);
    }
    if (user.consentSel >= 5) {
      const changedChoices = [null, endMs - 1, endMs, endMs + 1, startMs + (user.consentRand % lengthMs)];
      const changedMs = changedChoices[user.consentSel % changedChoices.length];
      consents.push({ userId, enabled: user.consentSel === 9, changedMs });
    } else if (user.consentSel === 4) {
      consents.push({ userId, enabled: true, changedMs: startMs + (user.consentRand % lengthMs) });
    }

    const refJourney = (sel) => (sel >= 8 || own.length === 0 ? null : own[sel % own.length]);
    const outcomeTimes = [];
    for (const outcome of user.outcomes) {
      const target = refJourney(outcome.journeySel);
      const delta = [-1, 0, 1, 120_000, 120_001, 119_999, outcome.deltaRand, outcome.deltaRand][outcome.deltaSel];
      const tMs = (target ? target.startMs : primaryStart) + delta;
      outcomeTimes.push(tMs);
      addEvent({ userId, name: 'first_outcome_displayed', journeyId: target ? target.id : 888_888_888, tMs });
    }
    for (const response of user.responses) {
      const target = refJourney(response.journeySel);
      const delta = [-1, 0, response.deltaRand, response.deltaRand][response.deltaSel];
      const value = ['yes', 'yes', 'partly', 'no', 'yes', 'maybe', null][response.valueSel];
      addEvent({
        userId,
        name: 'clarity_response',
        journeyId: target ? target.id : 888_888_888,
        response: value,
        tMs: (target ? target.startMs : primaryStart) + delta,
      });
    }
    for (const action of user.actions) {
      const anchor = outcomeTimes.length > 0 && action.anchorSel < 8
        ? outcomeTimes[action.anchorSel % outcomeTimes.length]
        : primaryStart;
      const delta = [
        -1, 0, 1, SEVEN_DAYS * DAY - 1, SEVEN_DAYS * DAY, SEVEN_DAYS * DAY + 1,
        action.deltaRand, action.deltaRand % DAY, action.deltaRand % (2 * DAY),
      ][action.deltaSel];
      addEvent({
        userId,
        name: 'recommended_action_completed',
        journeyId: own.length > 0 ? own[0].id : 888_888_888,
        tMs: anchor + delta,
      });
    }
    if (user.noise && own.length > 0) {
      addEvent({ userId, name: 'journey_started', journeyId: own[0].id, tMs: own[0].startMs });
    }
  });

  for (const change of raw.changes) {
    const tMs = [
      startMs - 1, startMs, endMs - 1, endMs,
      startMs - (change.timeRand % (5 * DAY)) - 1, endMs + (change.timeRand % (5 * DAY)),
    ][change.timeSel] ?? startMs + (change.timeRand % lengthMs);
    addEvent({
      userId: 7000 + change.changeId,
      name: 'financial_change_ui',
      changeId: change.changeId,
      reload: change.reloadSel === 7 ? null : change.reloadSel < 3,
      pageWide: change.pageSel === 7 ? null : change.pageSel < 3,
      tMs,
    });
  }

  return {
    ...period,
    generatedAtMs: endMs + raw.generatedAfterMs,
    journeys,
    consents,
    events,
  };
}

/** Large, boundary-focused cohort: counts sit within a few units of every target threshold. */
const boundaryArb = fc.record({
  period: periodArb,
  cohortSize: fc.integer({ min: 98, max: 132 }),
  shuffleSeed: fc.integer({ min: 1, max: 2 ** 31 }),
  narrowDurations: fc.boolean(),
  durationSeeds: fc.array(fc.integer({ min: 0, max: 300_000 }), { minLength: 132, maxLength: 132 }),
  displayShift: fc.integer({ min: -2, max: 2 }),
  displayWide: fc.integer({ min: 0, max: 132 }),
  displayMode: fc.integer({ min: 0, max: 3 }),
  completionShift: fc.integer({ min: -2, max: 2 }),
  completionWide: fc.integer({ min: 0, max: 132 }),
  completionMode: fc.integer({ min: 0, max: 3 }),
  responseBig: fc.boolean(),
  responseTotalSmall: fc.integer({ min: 46, max: 54 }),
  responseTotalBig: fc.integer({ min: 1990, max: 2010 }),
  yesShift: fc.integer({ min: -2, max: 2 }),
  changeBig: fc.boolean(),
  changeSmall: fc.integer({ min: 0, max: 4 }),
  changeBigCount: fc.integer({ min: 2001, max: 2100 }),
  reloads: fc.integer({ min: 0, max: 2 }),
  pageWides: fc.integer({ min: 0, max: 2 }),
});

function buildBoundary(raw) {
  const { period } = raw;
  const { startMs, endMs } = period;
  const n = raw.cohortSize;
  const journeys = [];
  const events = [];
  let nextEventId = 1;
  const addEvent = (fields) => {
    events.push({
      id: nextEventId++, journeyId: null, response: null, changeId: null, reload: null, pageWide: null, ...fields,
    });
  };
  const clamp = (value, max) => Math.max(0, Math.min(max, value));

  for (let userId = 1; userId <= n; userId += 1) {
    journeys.push({ id: userId, userId, startMs: startMs + userId * 1000, eligible: true });
  }

  const displayCount = raw.displayMode === 0
    ? clamp(raw.displayWide, n)
    : clamp(Math.floor((3 * n) / 4) + raw.displayShift, n);
  const durations = [];
  for (let userId = 1; userId <= displayCount; userId += 1) {
    const seed = raw.durationSeeds[userId - 1];
    const duration = raw.narrowDurations ? 119_990 + (seed % 21) : seed;
    durations.push(duration);
    addEvent({ userId, name: 'first_outcome_displayed', journeyId: userId, tMs: startMs + userId * 1000 + duration });
    if (userId % 7 === 0) {
      // A later display for the same journey must not move the first display.
      addEvent({ userId, name: 'first_outcome_displayed', journeyId: userId, tMs: startMs + userId * 1000 + duration + 5000 });
    }
  }

  const completionCount = raw.completionMode === 0
    ? clamp(raw.completionWide, displayCount)
    : clamp(Math.floor((2 * displayCount) / 5) + raw.completionShift, displayCount);
  for (let userId = 1; userId <= displayCount; userId += 1) {
    const displayAt = startMs + userId * 1000 + durations[userId - 1];
    if (userId <= completionCount) {
      addEvent({ userId, name: 'recommended_action_completed', journeyId: userId, tMs: displayAt + (userId % 3) * 1000 });
      addEvent({ userId, name: 'recommended_action_completed', journeyId: userId, tMs: displayAt + SEVEN_DAYS * DAY - 1 });
    } else if (userId % 2 === 0) {
      addEvent({ userId, name: 'recommended_action_completed', journeyId: userId, tMs: displayAt + SEVEN_DAYS * DAY });
    }
  }

  const total = raw.responseBig ? raw.responseTotalBig : raw.responseTotalSmall;
  const yesCount = clamp(Math.ceil(total * 0.8) + raw.yesShift, total);
  for (let k = 0; k < total; k += 1) {
    const userId = (k % n) + 1;
    addEvent({
      userId,
      name: 'clarity_response',
      journeyId: userId,
      response: k < yesCount ? 'yes' : (k % 2 === 0 ? 'partly' : 'no'),
      tMs: startMs + userId * 1000 + 10 + k,
    });
  }

  const changeCount = raw.changeBig ? raw.changeBigCount : raw.changeSmall;
  for (let changeId = 1; changeId <= changeCount; changeId += 1) {
    addEvent({
      userId: 50_000 + (changeId % 17),
      name: 'financial_change_ui',
      changeId,
      reload: changeId <= raw.reloads,
      pageWide: changeId > changeCount - raw.pageWides,
      tMs: startMs + changeId * 500,
    });
  }
  if (changeCount > 0) {
    // A later duplicate report with opposite flags must be ignored.
    addEvent({
      userId: 50_001, name: 'financial_change_ui', changeId: 1, reload: raw.reloads < 1, pageWide: true, tMs: startMs + 7 * DAY / 8,
    });
  }

  return { ...period, generatedAtMs: endMs + 9 * DAY, journeys, consents: [], events };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test('Property 29: mixed cohorts, duplicates, out-of-window events, and opt-outs match the reference model', () => {
  fc.assert(
    fc.property(mixedArb, (raw) => {
      checkScenario(buildMixed(raw), raw.shuffleSeed);
    }),
    { numRuns: NUM_RUNS_MIXED }
  );
});

test('Property 29: counts at target thresholds use unrounded ratios and exact medians', () => {
  fc.assert(
    fc.property(boundaryArb, (raw) => {
      checkScenario(buildBoundary(raw), raw.shuffleSeed);
    }),
    { numRuns: NUM_RUNS_BOUNDARY }
  );
});

test('Property 29: rate rounding and medians equal exact reference arithmetic', () => {
  const rateArb = fc.oneof(
    fc.integer({ min: 0, max: 4000 }).chain((d) => fc.record({ d: fc.constant(d), n: fc.integer({ min: 0, max: d }) })),
    fc.integer({ min: 1, max: 2 ** 31 }).chain((k) => fc.constantFrom(16, 160, 1600, 8, 80).chain(
      (unit) => fc.record({ d: fc.constant(unit * k), n: fc.integer({ min: 0, max: unit * k }) })
    )).filter(({ d }) => Number.isSafeInteger(d)),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).chain((d) => fc.record({
      d: fc.constant(d),
      n: fc.oneof(fc.integer({ min: 0, max: d }), fc.constantFrom(0, 1, d - 1, d).map((value) => Math.max(0, Math.min(d, value)))),
    }))
  );
  fc.assert(
    fc.property(rateArb, ({ n, d }) => {
      const rate = calculateRate(n, d);
      const tenths = refTenths(n, d);
      if (d === 0) {
        assert.equal(rate.percentageTenths, null);
        assert.equal(rate.percentageDisplay, null);
      } else {
        assert.equal(BigInt(rate.percentageTenths), tenths);
        assert.equal(rate.percentageDisplay, refDisplay(tenths));
      }
    }),
    { numRuns: NUM_RUNS_ARITHMETIC }
  );

  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 41 }), (values) => {
      const copy = [...values];
      const median = calculateMedian(values);
      assert.deepEqual(values, copy);
      const expected = refMedian(values);
      if (expected === null) {
        assert.deepEqual(
          [median.count, median.numerator, median.divisor, median.value],
          [0, null, null, null]
        );
      } else {
        assert.equal(median.count, values.length);
        assert.equal(median.numerator, expected.numerator);
        assert.equal(median.divisor, expected.divisor);
        assert.equal(median.value, Number((BigInt(expected.numerator) + BigInt(expected.divisor) / 2n) / BigInt(expected.divisor)));
      }
    }),
    { numRuns: NUM_RUNS_ARITHMETIC }
  );
});

test('Property 29: reference model anchors match the requirements examples', () => {
  assert.equal(refDisplay(refTenths(1, 16)), '6.3'); // 6.25 rounds half up
  assert.equal(refDisplay(refTenths(1, 3)), '33.3');
  assert.equal(refDisplay(refTenths(2, 3)), '66.7');
  assert.equal(refDisplay(refTenths(1599, 2000)), '80.0'); // 79.95 displays as 80.0 but misses an 80 percent target
  assert.equal(refAtLeast(1599, 2000, 80), false);
  assert.equal(refDisplay(refTenths(0, 0)), null);
  assert.deepEqual(refMedian([5, 1, 3]), { numerator: 3, divisor: 1 });
  assert.deepEqual(refMedian([4, 1, 2, 9]), { numerator: 6, divisor: 2 });
  assert.equal(refMedian([]), null);
});

after(() => {
  // Non-vacuity: the generators must exercise the cases the property is about.
  assert.ok(stats.cases >= 100, `generated ${stats.cases} metric cases`);
  assert.ok(stats.withMeasurableCohort >= 50, 'measurable cohorts');
  assert.ok(stats.withDisplays >= 50, 'cohorts with first outcome displays');
  assert.ok(stats.optedOut >= 1, 'opted-out users');
  assert.ok(stats.notEligibleExcluded >= 1, 'ineligible earliest journeys');
  assert.ok(stats.duplicateChanges >= 5, 'duplicate change reports');
  assert.ok(stats.oddMedian >= 5 && stats.evenMedian >= 5, 'odd and even medians');
  assert.ok(stats.emptyMedian >= 1, 'empty median populations');
  assert.ok(stats.outsideWindowCompletions >= 5, 'action completions outside the window');
  assert.ok(stats.weekly >= 1 && stats.twentyEightDay >= 1, 'both period types');
  assert.ok(['met', 'not_met', 'insufficient_data'].every((s) => stats.statuses.has(s)), 'all target statuses');
  console.log(`# measurement metrics property coverage: ${JSON.stringify({ ...stats, statuses: [...stats.statuses] })}`);
});
