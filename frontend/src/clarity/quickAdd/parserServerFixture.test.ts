import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import {
  collapseWhitespace,
  noteArb,
  paiseArb,
  validDateArb,
} from '../../test/quickAddGenerators';
import { MAX_AMOUNT_MINOR } from './amount';
import {
  ACCEPTED_YEARS_AFTER,
  ACCEPTED_YEARS_BEFORE,
} from './dates';
import { formatQuickAddLine } from './formatter';
import {
  MAX_LINE_LENGTH,
  MAX_NOTE_LENGTH,
  parseQuickAddLine,
  type ParsedEntry,
} from './parser';
import { BUILT_IN_CATEGORIES } from './keywordRules';
import { suggestCategory } from './suggester';

const SEED = 7_300_417;
const GENERATED_CASES = 256;
const FIXTURE_PATH = resolve(
  process.cwd(),
  '..',
  'backend',
  'test',
  'fixtures',
  'parserServerContract.json',
);

interface FixtureInput {
  today: string;
  amountMinor: number;
  spentOn: string;
  note: string;
  customCategory: string;
  useSuggestion: boolean;
  excludeFromDailyAllowance: boolean;
}

interface FixtureCase {
  id: string;
  kind: 'generated' | 'boundary';
  line: string;
  today: string;
  validatorNow: string;
  category: string;
  categoryOrigin: 'generated' | `suggest:${string}`;
  excludeFromDailyAllowance: boolean;
  parsed: ParsedEntry;
}

const canonicalNoteArb = fc.oneof(
  { weight: 5, arbitrary: noteArb({ maxWords: 8, tricky: true }) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant('coffee') },
  { weight: 1, arbitrary: fc.constant('metro pass') },
  { weight: 1, arbitrary: fc.constant('चाय मित्र') },
  { weight: 1, arbitrary: fc.constant('టీ స్నేహితుడు') },
).map(collapseWhitespace).filter((note) => note.length <= MAX_NOTE_LENGTH);

const customCategoryArb = fc
  .tuple(
    fc.constantFrom('Daily', 'Family', 'Home', 'Pet', 'Gift', 'Work'),
    fc.integer({ min: 0, max: 99_999 }),
  )
  .map(([name, suffix]) => `${name} ${suffix}`);

const todayAndSpentOnArb = validDateArb({ minYear: 2000, maxYear: 2090 }).chain((today) => {
  const year = Number(today.slice(0, 4));
  return validDateArb({ minYear: year - ACCEPTED_YEARS_BEFORE, maxYear: year + ACCEPTED_YEARS_AFTER })
    .map((spentOn) => ({ today, spentOn }));
});

const fixtureInputArb: fc.Arbitrary<FixtureInput> = fc.record({
  dates: todayAndSpentOnArb,
  amountMinor: paiseArb,
  note: canonicalNoteArb,
  customCategory: customCategoryArb,
  useSuggestion: fc.boolean(),
  excludeFromDailyAllowance: fc.boolean(),
}).map(({ dates, ...rest }) => ({ ...dates, ...rest }));

const BOUNDARIES: readonly FixtureInput[] = Object.freeze([
  {
    today: '2026-06-15',
    amountMinor: 1,
    spentOn: '2026-06-15',
    note: '',
    customCategory: 'Daily 1',
    useSuggestion: true,
    excludeFromDailyAllowance: false,
  },
  {
    today: '2026-06-15',
    amountMinor: MAX_AMOUNT_MINOR,
    spentOn: '2026-06-15',
    note: 'n'.repeat(MAX_NOTE_LENGTH),
    customCategory: 'C'.repeat(24),
    useSuggestion: false,
    excludeFromDailyAllowance: true,
  },
  {
    today: '2026-06-15',
    amountMinor: 12_050,
    spentOn: '2016-01-01',
    note: 'coffee',
    customCategory: 'Family 2',
    useSuggestion: true,
    excludeFromDailyAllowance: true,
  },
  {
    today: '2026-06-15',
    amountMinor: 50_000,
    spentOn: '2027-12-31',
    note: 'चाय मित्र',
    customCategory: 'Home 3',
    useSuggestion: false,
    excludeFromDailyAllowance: false,
  },
]);

function fixtureCase(input: FixtureInput, index: number, kind: FixtureCase['kind']): FixtureCase {
  const line = formatQuickAddLine({
    amountMinor: input.amountMinor,
    spentOn: input.spentOn,
    note: input.note,
  });
  const result = parseQuickAddLine(line, input.today);
  if (!result.ok) {
    throw new Error(`Generated parser/server fixture case ${index} did not parse`);
  }
  const suggestion = suggestCategory({
    note: result.entry.note,
    categories: BUILT_IN_CATEGORIES,
  });
  const category = input.useSuggestion ? suggestion.category : input.customCategory;
  const categoryOrigin: FixtureCase['categoryOrigin'] = input.useSuggestion
    ? `suggest:${suggestion.source}`
    : 'generated';

  return {
    id: `${kind}-${index}`,
    kind,
    line,
    today: input.today,
    // 06:30 UTC is 12:00 in Asia/Kolkata, so the server validator derives the same current year as `today`.
    validatorNow: `${input.today}T06:30:00.000Z`,
    category,
    categoryOrigin,
    excludeFromDailyAllowance: input.excludeFromDailyAllowance,
    parsed: result.entry,
  };
}

function buildFixture() {
  const generated = fc.sample(fixtureInputArb, { seed: SEED, numRuns: GENERATED_CASES });
  const cases = [
    ...BOUNDARIES.map((input, index) => fixtureCase(input, index, 'boundary')),
    ...generated.map((input, index) => fixtureCase(input, index, 'generated')),
  ];
  return {
    feature: 'quick-add-daily-answer',
    property: 7,
    seed: SEED,
    generatedCases: GENERATED_CASES,
    parserLimits: {
      lineMaxUtf16Units: MAX_LINE_LENGTH,
      amountMinor: { min: 1, max: MAX_AMOUNT_MINOR },
      noteMaxUtf16Units: MAX_NOTE_LENGTH,
      spentOnYearOffsets: { min: -ACCEPTED_YEARS_BEFORE, max: ACCEPTED_YEARS_AFTER },
    },
    cases,
  };
}

// This test is also the frontend fixture-generation script. Run `npm run generate:parser-validator-fixture`
// after an intentional parser contract change; ordinary test runs only verify that the checked-in fixture is current.
describe('parser/server contract fixture', () => {
  it('contains the deterministic successful outputs of the current frontend parser', () => {
    const rendered = `${JSON.stringify(buildFixture(), null, 2)}\n`;
    if (process.env.UPDATE_PARSER_VALIDATOR_FIXTURE === '1') {
      writeFileSync(FIXTURE_PATH, rendered, 'utf8');
    }
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(rendered);
  });
});
