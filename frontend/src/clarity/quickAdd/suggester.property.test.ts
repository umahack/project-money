import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fc } from '../../test/test-utils';
import { assertProperty } from '../../test/propertyReport';
import { SCRIPT_WORD_ARBS, referenceNoteKey, whitespaceRunArb } from '../../test/quickAddGenerators';
import { BUILT_IN_CATEGORIES, KEYWORD_RULES, type KeywordRule } from './keywordRules';
import {
  suggestCategory,
  type CategorySuggestion,
  type HistorySuggestionEntry,
  type MemorySuggestionEntry,
  type SuggestCategoryInput,
} from './suggester';
/*
 * Feature: quick-add-daily-answer, Property 8: Category suggestion follows the source precedence and availability
 *
 * Validates: Requirements 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.16, 5.17, 17.9
 *
 * Statement (design.md): for any note, set of available categories, Category_Memory, Category_History, and rule list,
 * the suggester returns exactly one category from the available categories. Memory wins over history, history over
 * category name, category name over keyword, keyword over default. The longest keyword phrase wins and the earlier rule
 * wins a tie. Memory and history match only an equal Note_Key. An empty note gives the default. A note in another
 * script uses only memory, history, and category name before the default. An unavailable category is skipped. The same
 * inputs give the same output.
 *
 * `referenceSuggest` below is written from the requirements and the design text, not from `suggester.ts`. Decisions the
 * design leaves open, as set by the author of this task:
 * - memory and history match the exact `normalizeNoteKey` of the note (compared here with the independent
 *   `referenceNoteKey`); history uses only the most recent entry for the key and is skipped when that entry's category
 *   is not available (an older entry is not tried);
 * - category names match as whole-word runs; the longest name wins (counted as the matched words joined by single
 *   spaces), then a built-in name over a custom one, then list order;
 * - the longest keyword phrase is measured in characters with single spaces; ties go to the earlier rule; a rule whose
 *   category is unavailable is skipped before the comparison; `Other` is the default;
 * - words are runs of Unicode letters, combining marks, and numbers of the lowercased NFKC note (marks are kept so that
 *   Devanagari and Telugu words stay whole); rule phrases are ASCII lower-case only;
 * - the reason is one of five fixed templates.
 * Generated inputs keep one memory entry per key, and distinct dates among history entries of one key, because the
 * backend guarantees both and the design does not define a choice among equals. Counterexamples print structure only.
 */
const RUNS = 300;

/* ------------------------------------------------------------ built-in list */

// The built-in category list the generators and the reference use comes from the backend source, not from the frontend.
function readBackendCategories(): string[] {
  const source = readFileSync(
    resolve(process.cwd(), '..', 'backend', 'src', 'services', 'expenseMutations.js'),
    'utf8',
  );
  const block = /EXPENSE_CATEGORIES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}
const BACKEND_CATEGORIES: readonly string[] = Object.freeze(readBackendCategories());
const DEFAULT_NAME = 'Other';

/* --------------------------------------------------------- reference model */

function wordsOf(text: string): string[] {
  return text.normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u).filter((word) => word !== '');
}

const lower = (text: string): string => text.toLocaleLowerCase('en-IN');

function firstRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return start;
  }
  return -1;
}

function referenceSuggest(input: SuggestCategoryInput): CategorySuggestion {
  const { note, categories } = input;
  const memory = input.memory ?? [];
  const history = input.history ?? [];
  const rules = input.rules ?? KEYWORD_RULES;
  const available = (category: string): boolean => categories.includes(category);
  const builtInKeys = new Set(BACKEND_CATEGORIES.map((name) => wordsOf(lower(name.normalize('NFKC'))).join(' ')));

  // 1. Empty note.
  if (/^\s*$/.test(note)) return { category: DEFAULT_NAME, source: 'default', reason: 'No note, so this goes to Other.' };

  const key = referenceNoteKey(note);
  if (key !== null) {
    // 2. Memory: the entry with the equal key, if its category is available.
    const remembered = memory.find((entry) => entry.noteKey === key);
    if (remembered !== undefined && available(remembered.category)) {
      return {
        category: remembered.category,
        source: 'memory',
        reason: `You corrected "${note}" to ${remembered.category} before.`,
      };
    }
    // 3. History: only the most recent entry with the equal key counts.
    const sameKey = history.filter((entry) => entry.noteKey === key);
    if (sameKey.length > 0) {
      const latest = sameKey.reduce((best, entry) => (entry.lastSpentOn > best.lastSpentOn ? entry : best));
      if (available(latest.category)) {
        return {
          category: latest.category,
          source: 'history',
          reason: `Your last "${note}" expense was in ${latest.category}.`,
        };
      }
    }
  }

  const shown = wordsOf(note);
  const folded = shown.map(lower);

  // 4. Category name: longest name, then built-in over custom, then list order.
  const named = categories
    .map((category, index) => {
      const nameWords = wordsOf(lower(category.normalize('NFKC')));
      return {
        category,
        index,
        length: nameWords.join(' ').length,
        builtIn: builtInKeys.has(nameWords.join(' ')),
        start: firstRun(folded, nameWords),
        count: nameWords.length,
      };
    })
    .filter((candidate) => candidate.start >= 0)
    .sort((a, b) => b.length - a.length || Number(b.builtIn) - Number(a.builtIn) || a.index - b.index)[0];
  if (named !== undefined) {
    return {
      category: named.category,
      source: 'category_name',
      reason: `"${shown.slice(named.start, named.start + named.count).join(' ')}" is one of your categories.`,
    };
  }

  // 5. Keyword: longest phrase, earlier rule on a tie, rules with an unavailable category skipped.
  let best: { rule: KeywordRule; start: number; count: number } | undefined;
  for (const rule of rules) {
    if (!available(rule.category)) continue;
    const phraseWords = rule.phrase.split(' ');
    const start = firstRun(folded, phraseWords);
    if (start < 0) continue;
    if (best === undefined || rule.phrase.length > best.rule.phrase.length) best = { rule, start, count: phraseWords.length };
  }
  if (best !== undefined) {
    return {
      category: best.rule.category,
      source: 'keyword',
      reason: `"${shown.slice(best.start, best.start + best.count).join(' ')}" usually means ${best.rule.category}.`,
    };
  }

  // 6. Default.
  return { category: DEFAULT_NAME, source: 'default', reason: 'No match found, so this goes to Other.' };
}

/* -------------------------------------------------------------- generators */

const RANK: Readonly<Record<CategorySuggestion['source'], number>> = {
  memory: 0, history: 1, category_name: 2, keyword: 3, default: 4,
};

// Phrases for generated rule lists: equal lengths (tea, cab, bus; alpha beta, beta alpha, eating out) and phrases that
// contain other phrases (amazon, amazon prime; train, local train).
const PHRASE_POOL: readonly string[] = Object.freeze([
  'tea', 'cab', 'bus', 'amazon', 'amazon prime', 'prime video', 'prime', 'eating out', 'out', 'food delivery',
  'delivery', 'train', 'local train', 'alpha beta', 'beta alpha', 'alpha', 'gamma', 'coffee', 'swiggy',
]);
const PLAIN_WORDS: readonly string[] = Object.freeze([
  'lunch', 'with', 'team', 'bought', 'gift', 'hobby', 'trip', 'office', 'pneumonoultramicroscopic', 'delta',
]);
const CUSTOM_WORDS: readonly string[] = Object.freeze([
  'tea', 'coffee', 'metro', 'pets', 'gifts', 'cola', '2wheeler', 'eating', 'out', 'food', 'sports', 'hobby', 'cab',
  'alpha', 'beta',
]);
const NOTE_SEPARATORS: readonly string[] = Object.freeze([' ', ' ', ' ', '  ', ', ', ' - ', '\t', '/', '. ']);
const JOINERS: readonly string[] = Object.freeze([' ', ' ', ' & ', '-', '/']);
const SHIPPED_PHRASES: readonly string[] = Object.freeze(KEYWORD_RULES.map((rule) => rule.phrase));
const HISTORY_DATES: readonly string[] = Object.freeze([
  '2025-12-01', '2025-12-31', '2026-01-01', '2026-01-09', '2026-01-10', '2026-01-28', '2026-02-02', '2026-03-15',
]);
const GHOST_CATEGORY = 'Ghost Category';

const titleCase = (word: string): string => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
const caseArb = fc.constantFrom<'asis' | 'upper' | 'title'>('asis', 'asis', 'upper', 'title');
const withCase = (word: string, kind: 'asis' | 'upper' | 'title'): string =>
  kind === 'upper' ? word.toUpperCase() : kind === 'title' ? titleCase(word) : word;

const wordKey = (name: string): string => wordsOf(lower(name)).join(' ');

const customNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.constantFrom(...CUSTOM_WORDS), { minLength: 1, maxLength: 3 }),
    fc.array(fc.constantFrom(...JOINERS), { minLength: 2, maxLength: 2 }),
    caseArb,
  )
  .map(([words, joiners, kind]) =>
    words.map((word, index) => `${index === 0 ? '' : (joiners[index - 1] ?? ' ')}${withCase(word, kind)}`).join(''))
  .filter((name) => name.length <= 24 && wordKey(name) !== '');

interface Scenario {
  note: string;
  categories: string[];
  memory: MemorySuggestionEntry[];
  history: HistorySuggestionEntry[];
  rules: KeywordRule[] | undefined;
}

const OTHER_NAME_KEY = wordKey(DEFAULT_NAME);

/** Available categories: `Other`, a subset of the other built-ins, and up to four custom names, in list or shuffled order. */
const categoriesArb: fc.Arbitrary<string[]> = fc
  .tuple(
    fc.subarray(BACKEND_CATEGORIES.filter((name) => name !== DEFAULT_NAME)),
    fc.array(customNameArb, { minLength: 0, maxLength: 4 }),
    fc.boolean(),
    fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 16, maxLength: 16 }),
  )
  .map(([builtIns, customs, shuffled, sortKeys]) => {
    const taken = new Set(BACKEND_CATEGORIES.map(wordKey));
    const uniqueCustoms: string[] = [];
    for (const name of customs) {
      const key = wordKey(name);
      if (taken.has(key) || key === OTHER_NAME_KEY) continue;
      taken.add(key);
      uniqueCustoms.push(name);
    }
    const ordered = [...BACKEND_CATEGORIES.filter((name) => name === DEFAULT_NAME || builtIns.includes(name)), ...uniqueCustoms];
    if (!shuffled) return ordered;
    return ordered
      .map((name, index) => ({ name, index, sort: sortKeys[index % sortKeys.length] ?? 0 }))
      .sort((a, b) => a.sort - b.sort || a.index - b.index)
      .map(({ name }) => name);
  });

const rulesArb: fc.Arbitrary<KeywordRule[] | undefined> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<KeywordRule[] | undefined>(undefined) },
  {
    weight: 3,
    arbitrary: fc
      .array(
        fc.record({ category: fc.constantFrom(...BACKEND_CATEGORIES), phrase: fc.constantFrom(...PHRASE_POOL) }),
        { minLength: 0, maxLength: 10 },
      )
      .map((rules): KeywordRule[] | undefined => rules),
  },
);

const noteSeparatorArb = fc.constantFrom(...NOTE_SEPARATORS);

function tokenArb(categories: readonly string[]): fc.Arbitrary<string> {
  const nameWords = categories.flatMap((name) => wordsOf(name));
  const pool: Array<{ weight: number; arbitrary: fc.Arbitrary<string> }> = [
    { weight: 4, arbitrary: fc.constantFrom(...PHRASE_POOL) },
    { weight: 3, arbitrary: fc.constantFrom(...SHIPPED_PHRASES) },
    { weight: 3, arbitrary: fc.constantFrom(...PLAIN_WORDS) },
    { weight: 2, arbitrary: fc.constantFrom(...BACKEND_CATEGORIES.map(lower)) },
    { weight: 1, arbitrary: fc.constantFrom('7up', '3', '500', '!!!', '&', 'coffeeshop', 'teas') },
    { weight: 1, arbitrary: SCRIPT_WORD_ARBS.devanagari },
    { weight: 1, arbitrary: SCRIPT_WORD_ARBS.telugu },
  ];
  if (nameWords.length > 0) pool.push({ weight: 4, arbitrary: fc.constantFrom(...nameWords) });
  return fc.tuple(fc.oneof(...pool), caseArb).map(([token, kind]) => withCase(token, kind));
}

/** Mixed notes: keyword phrases, category words, plain words, punctuation, other scripts, and blank notes. */
function mixedNoteArb(categories: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom('', '   ', '\t\u00a0\u2003') },
    {
      weight: 9,
      arbitrary: fc
        .tuple(
          fc.array(tokenArb(categories), { minLength: 1, maxLength: 6 }),
          fc.array(noteSeparatorArb, { minLength: 6, maxLength: 6 }),
        )
        .map(([tokens, separators]) => tokens.map((token, index) => `${token}${index < tokens.length - 1 ? (separators[index] ?? ' ') : ''}`).join('')),
    },
  );
}

/** Notes in Devanagari or Telugu only, joined by spaces or punctuation. */
function otherScriptNoteArb(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.array(fc.oneof(SCRIPT_WORD_ARBS.devanagari, SCRIPT_WORD_ARBS.telugu), { minLength: 1, maxLength: 4 }),
      fc.array(fc.constantFrom(' ', ', ', '  ', ' - '), { minLength: 4, maxLength: 4 }),
    )
    .map(([words, separators]) => words.map((word, index) => `${word}${index < words.length - 1 ? (separators[index] ?? ' ') : ''}`).join(''));
}

type KeyKind = 'exact' | 'exact' | 'upper' | 'padded' | 'prefix' | 'extended' | 'unrelated';
const keyKindArb = fc.constantFrom<KeyKind>('exact', 'exact', 'upper', 'padded', 'prefix', 'extended', 'unrelated');

function keyVariant(key: string | null, kind: KeyKind): string {
  const base = key ?? '';
  switch (kind) {
    case 'exact': return base;
    case 'upper': return base.toUpperCase();
    case 'padded': return ` ${base}`;
    case 'prefix': return base.slice(0, -1);
    case 'extended': return `${base} x`;
    default: return 'unrelated key';
  }
}

function hintsArb(
  note: string,
  categories: readonly string[],
): fc.Arbitrary<{ memory: MemorySuggestionEntry[]; history: HistorySuggestionEntry[] }> {
  const key = referenceNoteKey(note);
  const category = fc.constantFrom(...categories, GHOST_CATEGORY, GHOST_CATEGORY);
  const memoryEntry = fc.record({ noteKey: keyKindArb.map((kind) => keyVariant(key, kind)), category });
  const historyEntry = fc.record({
    noteKey: keyKindArb.map((kind) => keyVariant(key, kind)),
    category,
    lastSpentOn: fc.constantFrom(...HISTORY_DATES),
  });
  return fc
    .record({
      memory: fc.array(memoryEntry, { minLength: 0, maxLength: 4 }),
      history: fc.array(historyEntry, { minLength: 0, maxLength: 6 }),
    })
    .map(({ memory, history }) => {
      const memoryKeys = new Set<string>();
      const historyKeys = new Set<string>();
      return {
        // One memory entry per key, and one history entry per key and date.
        memory: memory.filter((entry) => !memoryKeys.has(entry.noteKey) && memoryKeys.add(entry.noteKey)),
        history: history.filter((entry) => {
          const id = `${entry.noteKey}\u0000${entry.lastSpentOn}`;
          return !historyKeys.has(id) && historyKeys.add(id);
        }),
      };
    });
}

function scenarioArb(noteFor: (categories: readonly string[]) => fc.Arbitrary<string>): fc.Arbitrary<Scenario> {
  return categoriesArb.chain((categories) =>
    fc.tuple(noteFor(categories), rulesArb).chain(([note, rules]) =>
      hintsArb(note, categories).map(({ memory, history }): Scenario => ({ note, categories, memory, history, rules }))));
}

const anyScenarioArb = scenarioArb(mixedNoteArb);
const otherScriptScenarioArb = scenarioArb(() => otherScriptNoteArb());

const inputOf = (scenario: Scenario, overrides: Partial<SuggestCategoryInput> = {}): SuggestCategoryInput => {
  const { note, categories, memory, history, rules } = scenario;
  return { note, categories, memory, history, ...(rules === undefined ? {} : { rules }), ...overrides };
};

function reorder<T>(items: readonly T[], sortKeys: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, index, sort: sortKeys[index % sortKeys.length] ?? 0 }))
    .sort((a, b) => a.sort - b.sort || a.index - b.index)
    .map(({ item }) => item);
}

/* ------------------------------------------------------------------- tests */

describe('Property 8: Category suggestion follows the source precedence and availability', () => {
  it('uses the built-in list of the backend', () => {
    expect(BACKEND_CATEGORIES).toHaveLength(10);
    expect([...BUILT_IN_CATEGORIES]).toEqual([...BACKEND_CATEGORIES]);
    expect(BACKEND_CATEGORIES).toContain(DEFAULT_NAME);
  });

  it('equals the reference model that evaluates the sources in order', () => {
    assertProperty(
      fc.property(anyScenarioArb, (scenario) => {
        const input = inputOf(scenario);
        expect(suggestCategory(input)).toEqual(referenceSuggest(input));
      }),
      { numRuns: RUNS },
    );
  });

  it('reaches every source across the generated cases', () => {
    const seen = new Set<string>();
    assertProperty(
      fc.property(anyScenarioArb, (scenario) => {
        seen.add(suggestCategory(inputOf(scenario)).source);
      }),
      { numRuns: RUNS },
    );
    expect([...seen].sort()).toEqual(['category_name', 'default', 'history', 'keyword', 'memory']);
  });

  it('is deterministic, leaves its input unchanged, and gives one available category with a non-empty reason', () => {
    assertProperty(
      fc.property(anyScenarioArb, (scenario) => {
        const input = inputOf(scenario);
        const before = JSON.stringify(input);
        const first = suggestCategory(input);
        const second = suggestCategory(input);
        expect(second).toEqual(first);
        expect(JSON.stringify(input)).toBe(before);
        expect(scenario.categories).toContain(first.category);
        expect(first.reason.trim().length).toBeGreaterThan(0);
        expect(Object.keys(first).sort()).toEqual(['category', 'reason', 'source']);
        expect(first.source in RANK).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('does not depend on the order of memory entries or history entries', () => {
    const sortKeysArb = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 8, maxLength: 8 });
    assertProperty(
      fc.property(anyScenarioArb, sortKeysArb, sortKeysArb, (scenario, memoryKeys, historyKeys) => {
        const shuffled = inputOf(scenario, {
          memory: reorder(scenario.memory, memoryKeys),
          history: reorder(scenario.history, historyKeys),
        });
        expect(suggestCategory(shuffled)).toEqual(suggestCategory(inputOf(scenario)));
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps the result when only lower-priority sources are removed, and never moves to a higher source when higher ones are removed', () => {
    assertProperty(
      fc.property(anyScenarioArb, (scenario) => {
        const full = suggestCategory(inputOf(scenario));
        const rank = RANK[full.source];
        if (rank <= RANK.memory) expect(suggestCategory(inputOf(scenario, { history: [], rules: [] }))).toEqual(full);
        if (rank <= RANK.history) expect(suggestCategory(inputOf(scenario, { rules: [] }))).toEqual(full);
        if (rank <= RANK.category_name) expect(suggestCategory(inputOf(scenario, { rules: [] }))).toEqual(full);
        if (rank <= RANK.keyword) expect(suggestCategory(inputOf(scenario, { memory: [], history: [] })).source).not.toBe('memory');

        const withoutMemory = suggestCategory(inputOf(scenario, { memory: [] }));
        expect(RANK[withoutMemory.source]).toBeGreaterThanOrEqual(rank);
        const withoutHints = suggestCategory(inputOf(scenario, { memory: [], history: [] }));
        expect(RANK[withoutHints.source]).toBeGreaterThanOrEqual(RANK[withoutMemory.source]);
        const withoutRules = suggestCategory(inputOf(scenario, { memory: [], history: [], rules: [] }));
        expect(RANK[withoutRules.source]).toBeGreaterThanOrEqual(RANK[withoutHints.source]);
      }),
      { numRuns: RUNS },
    );
  });

  it('gives equal-length keyword phrases to the earlier rule and a longer phrase to its rule wherever it sits', () => {
    const tieGroups: string[][] = [
      ['tea', 'cab', 'bus'],
      ['alpha beta', 'beta alpha', 'eating out'],
      ['prime', 'train', 'alpha', 'gamma'],
      ['coffee', 'swiggy', 'amazon'],
    ];
    assertProperty(
      fc.property(
        fc.constantFrom(...tieGroups).chain((group) =>
          fc.tuple(
            fc.shuffledSubarray(group, { minLength: 2, maxLength: group.length }),
            fc.shuffledSubarray(group, { minLength: 2, maxLength: group.length }),
          )),
        fc.array(fc.constantFrom(...BACKEND_CATEGORIES), { minLength: 4, maxLength: 4 }),
        fc.constantFrom(' ', ', ', '  / '),
        fc.boolean(),
        ([ruleOrder, inNote], categories, separator, longerFirst) => {
          const rules: KeywordRule[] = ruleOrder.map((phrase, index) => ({ phrase, category: categories[index] as string }));
          const present = rules.filter((rule) => inNote.includes(rule.phrase));
          fc.pre(present.length > 0);
          const noteWords = inNote.join(separator);
          const input: SuggestCategoryInput = { note: noteWords, categories: BACKEND_CATEGORIES, rules };
          const expected = present[0] as KeywordRule;
          const result = suggestCategory(input);
          expect(result.source).toBe('keyword');
          expect(result.category).toBe(expected.category);
          expect(result).toEqual(referenceSuggest(input));

          // A strictly longer phrase wins from any position in the rule list.
          const longer: KeywordRule = { phrase: `${noteWords.replace(/[^a-z0-9]+/g, ' ')} plus`.trim(), category: 'Education' };
          fc.pre(longer.phrase.length > noteWords.length);
          const withLonger = longerFirst ? [longer, ...rules] : [...rules, longer];
          const longNote = `${noteWords} plus`;
          const longResult = suggestCategory({ note: longNote, categories: BACKEND_CATEGORIES, rules: withLonger });
          expect(longResult.source).toBe('keyword');
          expect(longResult.category).toBe('Education');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives equal-length category names to a built-in name, then to the earlier name in the list', () => {
    const customPool = ['Cola', 'Pets', 'Gifts', 'Metro', 'Hobby', 'Sports', 'Alpha', 'Gamma'];
    const builtInPool = ['Food', 'Bills', 'Health', 'Travel', 'Other'];
    assertProperty(
      fc.property(
        fc.shuffledSubarray(customPool, { minLength: 1, maxLength: 5 }),
        fc.shuffledSubarray(builtInPool, { minLength: 1, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 12, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 12, maxLength: 12 }),
        (customs, builtIns, listKeys, noteKeys) => {
          const categories = reorder([...BACKEND_CATEGORIES.filter((name) => name === 'Other' || builtIns.includes(name)), ...customs], listKeys);
          const note = reorder(categories.map(lower), noteKeys).join(' ');
          const input: SuggestCategoryInput = { note, categories };
          const result = suggestCategory(input);
          const longest = Math.max(...categories.map((name) => name.length));
          const top = categories.filter((name) => name.length === longest);
          const winner = top.find((name) => BACKEND_CATEGORIES.includes(name)) ?? (top[0] as string);
          expect(result).toEqual({ category: winner, source: 'category_name', reason: `"${lower(winner)}" is one of your categories.` });
          expect(result).toEqual(referenceSuggest(input));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives the default for an empty note whatever memory, history, and rules hold', () => {
    assertProperty(
      fc.property(
        anyScenarioArb,
        fc.constantFrom('', ' ', '\t', '\u00a0\u2003 ', '\n'),
        (scenario, blank) => {
          expect(suggestCategory(inputOf(scenario, { note: blank }))).toEqual({
            category: DEFAULT_NAME,
            source: 'default',
            reason: 'No note, so this goes to Other.',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('uses only memory, history, and category name before the default for a note in another script', () => {
    assertProperty(
      fc.property(otherScriptScenarioArb, (scenario) => {
        const input = inputOf(scenario);
        const result = suggestCategory(input);
        expect(['memory', 'history', 'category_name', 'default']).toContain(result.source);
        expect(result).toEqual(referenceSuggest(input));
      }),
      { numRuns: RUNS },
    );
  });

  it('matches memory and history only on an equal Note_Key, however the note is spaced or cased', () => {
    assertProperty(
      fc.property(
        fc.array(fc.constantFrom('coffee', 'tea', 'metro card', 'alpha'), { minLength: 1, maxLength: 3 }),
        fc.array(whitespaceRunArb, { minLength: 3, maxLength: 3 }),
        fc.constantFrom('upper', 'lower'),
        fc.constantFrom('Health', 'Education', 'Travel'),
        fc.constantFrom('history', 'memory'),
        (words, runs, kind, category, via) => {
          const base = words.join(' ');
          const typed = words.map((word, index) => `${index === 0 ? '' : (runs[index - 1] ?? ' ')}${word}`).join('');
          const note = kind === 'upper' ? typed.toUpperCase() : typed;
          const key = referenceNoteKey(base) as string;
          const hint = via === 'memory'
            ? { memory: [{ noteKey: key, category }], history: [] }
            : { memory: [], history: [{ noteKey: key, category, lastSpentOn: '2026-01-10' }] };
          const result = suggestCategory({ note, categories: BACKEND_CATEGORIES, ...hint });
          expect(result.source).toBe(via);
          expect(result.category).toBe(category);
          // A key that differs by one character never matches.
          const near = suggestCategory({
            note,
            categories: BACKEND_CATEGORIES,
            ...(via === 'memory'
              ? { memory: [{ noteKey: `${key}x`, category }], history: [] }
              : { memory: [], history: [{ noteKey: `${key}x`, category, lastSpentOn: '2026-01-10' }] }),
          });
          expect(near.source).not.toBe(via);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
