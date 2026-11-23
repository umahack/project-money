import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CATEGORIES, KEYWORD_RULES, type KeywordRule } from './keywordRules';
import { normalizeNoteKey } from './noteKey';
import { REASON_NO_MATCH, REASON_NO_NOTE, suggestCategory } from './suggester';

const BUILT_IN = BUILT_IN_CATEGORIES;
const withCustom = (...custom: string[]) => [...BUILT_IN, ...custom];

function key(note: string): string {
  const value = normalizeNoteKey(note);
  if (value === null) throw new Error('test note has no Note_Key');
  return value;
}

function suggest(note: string, extra: Partial<Parameters<typeof suggestCategory>[0]> = {}) {
  return suggestCategory({ note, categories: BUILT_IN, ...extra });
}

describe('keyword rules data', () => {
  it('maps only to the built-in categories of the backend', () => {
    const source = readFileSync(
      resolve(process.cwd(), '..', 'backend', 'src', 'services', 'expenseMutations.js'),
      'utf8',
    );
    const block = /EXPENSE_CATEGORIES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '';
    const backend = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect([...BUILT_IN_CATEGORIES]).toEqual(backend);
    for (const rule of KEYWORD_RULES) expect(BUILT_IN).toContain(rule.category);
  });

  it('uses lower-case ASCII words with single spaces and no duplicate phrase', () => {
    const seen = new Set<string>();
    for (const { phrase } of KEYWORD_RULES) {
      expect(phrase).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
      expect(seen.has(phrase), phrase).toBe(false);
      seen.add(phrase);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(KEYWORD_RULES)).toBe(true);
  });
});

describe('suggestCategory keyword source', () => {
  const cases: Array<[string, string]> = [
    ['swiggy', 'Food'],
    ['Zomato dinner', 'Food'],
    ['chai', 'Food'],
    ['bigbasket', 'Groceries'],
    ['sabzi and milk', 'Groceries'],
    ['petrol', 'Transport'],
    ['fuel for bike', 'Transport'],
    ['auto to office', 'Transport'],
    ['Uber cab', 'Transport'],
    ['metro card', 'Transport'],
    ['Jio recharge', 'Bills'],
    ['rent', 'Bills'],
    ['electricity bill', 'Bills'],
    ['medicines', 'Health'],
    ['pharmacy', 'Health'],
    ['netflix', 'Entertainment'],
    ['hotstar', 'Entertainment'],
    ['flipkart order', 'Shopping'],
    ['flight to goa', 'Travel'],
    ['udemy course', 'Education'],
  ];

  it.each(cases)('maps %j to %s with the keyword source', (note, category) => {
    const result = suggest(note);
    expect(result.category).toBe(category);
    expect(result.source).toBe('keyword');
  });

  it('matches whole words only and ignores punctuation and case', () => {
    expect(suggest('SWIGGY,').source).toBe('keyword');
    expect(suggest('grocerystore')).toMatchObject({ category: 'Other', source: 'default' });
    expect(suggest('bussiness lunch')).toMatchObject({ category: 'Food' });
    expect(suggest('bussiness')).toMatchObject({ source: 'default' });
  });

  it('prefers the longest phrase over a shorter one', () => {
    expect(suggest('amazon prime')).toMatchObject({ category: 'Entertainment', source: 'keyword' });
    expect(suggest('amazon order')).toMatchObject({ category: 'Shopping' });
    expect(suggest('train ticket').category).toBe('Travel');
  });

  it('lets the earlier rule win when phrase lengths are equal', () => {
    const rules: KeywordRule[] = [
      { category: 'Health', phrase: 'abcd' },
      { category: 'Food', phrase: 'wxyz' },
    ];
    expect(suggest('wxyz abcd', { rules }).category).toBe('Health');
    expect(suggest('abcd wxyz', { rules: [...rules].reverse() }).category).toBe('Food');
  });

  it('skips a rule whose category is not available and tries the next', () => {
    const categories = BUILT_IN.filter((name) => name !== 'Entertainment');
    expect(suggestCategory({ note: 'amazon prime', categories })).toMatchObject({
      category: 'Shopping',
      source: 'keyword',
    });
  });

  it('names the matched words and the category in the reason', () => {
    expect(suggest('Swiggy, order').reason).toBe('"Swiggy" usually means Food.');
    expect(suggest('Swiggy dinner').reason).toBe('"dinner" usually means Food.');
    expect(suggest('my amazon prime renewal').reason).toBe('"amazon prime" usually means Entertainment.');
  });
});

describe('suggestCategory default and empty note', () => {
  it('suggests Other with a no-note reason for an empty or blank note', () => {
    for (const note of ['', '   ']) {
      expect(suggest(note, { memory: [{ noteKey: '', category: 'Food' }] })).toEqual({
        category: 'Other',
        source: 'default',
        reason: REASON_NO_NOTE,
      });
    }
  });

  it('suggests Other with a no-match reason when nothing applies', () => {
    expect(suggest('xyzzy plugh')).toEqual({ category: 'Other', source: 'default', reason: REASON_NO_MATCH });
  });

  it('uses the default for notes in other scripts unless memory, history, or a name matches', () => {
    expect(suggest('चाय')).toMatchObject({ category: 'Other', source: 'default' });
    expect(suggest('కాఫీ')).toMatchObject({ category: 'Other', source: 'default' });
    const note = 'चाय';
    expect(suggest(note, { memory: [{ noteKey: key(note), category: 'Food' }] })).toMatchObject({
      category: 'Food',
      source: 'memory',
    });
  });
});

describe('suggestCategory memory and history', () => {
  it('uses memory before history, category name, and keyword', () => {
    const note = 'Swiggy';
    const result = suggest(note, {
      memory: [{ noteKey: key(note), category: 'Entertainment' }],
      history: [{ noteKey: key(note), category: 'Health', lastSpentOn: '2025-01-10' }],
    });
    expect(result).toEqual({
      category: 'Entertainment',
      source: 'memory',
      reason: 'You corrected "Swiggy" to Entertainment before.',
    });
  });

  it('matches the Note_Key regardless of case, spacing, and Unicode form', () => {
    const result = suggest('  CAFÉ   Coffee ', {
      memory: [{ noteKey: key('café coffee'), category: 'Shopping' }],
    });
    expect(result.source).toBe('memory');
    expect(result.category).toBe('Shopping');
  });

  it('does not match a different note, so coffee and coffee with priya stay separate', () => {
    const memory = [{ noteKey: key('coffee'), category: 'Shopping' }];
    expect(suggest('coffee with priya', { memory })).toMatchObject({ category: 'Food', source: 'keyword' });
    expect(suggest('coffee', { memory })).toMatchObject({ category: 'Shopping', source: 'memory' });
  });

  it('uses the most recent history entry', () => {
    const note = 'office lunch';
    const result = suggest(note, {
      history: [
        { noteKey: key(note), category: 'Groceries', lastSpentOn: '2025-02-01' },
        { noteKey: key(note), category: 'Entertainment', lastSpentOn: '2025-03-01' },
        { noteKey: key('other note'), category: 'Health', lastSpentOn: '2025-04-01' },
      ],
    });
    expect(result).toEqual({
      category: 'Entertainment',
      source: 'history',
      reason: 'Your last "office lunch" expense was in Entertainment.',
    });
  });

  it('skips memory for a category that is no longer available and falls through', () => {
    const note = 'gym membership';
    const result = suggest(note, {
      memory: [{ noteKey: key(note), category: 'Pets' }],
      history: [{ noteKey: key(note), category: 'Shopping', lastSpentOn: '2025-02-01' }],
    });
    expect(result).toMatchObject({ category: 'Shopping', source: 'history' });
  });

  it('skips history whose most recent category is unavailable and uses the next source', () => {
    const note = 'gym membership';
    const result = suggest(note, { history: [{ noteKey: key(note), category: 'Pets', lastSpentOn: '2025-02-01' }] });
    expect(result).toMatchObject({ category: 'Health', source: 'keyword' });
  });

  it('skips memory and history for a note longer than 60 code points', () => {
    const note = `${'a'.repeat(61)} swiggy`;
    expect(normalizeNoteKey(note)).toBeNull();
    const result = suggest(note, { memory: [{ noteKey: note.toLowerCase(), category: 'Health' }] });
    expect(result).toMatchObject({ category: 'Food', source: 'keyword' });
  });
});

describe('suggestCategory category names', () => {
  it('matches a custom category name as a whole word, ignoring case', () => {
    const result = suggestCategory({ note: 'PETS vet visit', categories: withCustom('Pets') });
    expect(result).toEqual({ category: 'Pets', source: 'category_name', reason: '"PETS" is one of your categories.' });
  });

  it('matches a built-in category name before the keyword rules', () => {
    expect(suggest('health swiggy')).toMatchObject({ category: 'Health', source: 'category_name' });
  });

  it('matches a multi-word custom name and prefers the longest name', () => {
    const categories = withCustom('Dining', 'Dining Out');
    expect(suggestCategory({ note: 'dining out friday', categories })).toMatchObject({
      category: 'Dining Out',
      source: 'category_name',
    });
  });

  it('does not match inside a longer word', () => {
    expect(suggestCategory({ note: 'carpets', categories: withCustom('Pets') })).toMatchObject({ source: 'default' });
  });

  it('prefers a built-in name over an equally long custom name', () => {
    const result = suggestCategory({ note: 'pets food', categories: ['Pets', 'Food', 'Other'] });
    expect(result).toMatchObject({ category: 'Food', source: 'category_name' });
  });

  it('never returns an unavailable category', () => {
    const categories = ['Food', 'Other'];
    for (const note of ['rent', 'netflix', 'petrol', 'medicine']) {
      expect(categories).toContain(suggestCategory({ note, categories }).category);
    }
  });
});

describe('suggestCategory determinism', () => {
  it('returns equal results for equal inputs and does not change its inputs', () => {
    const memory = [{ noteKey: key('tea'), category: 'Health' }];
    const history = [{ noteKey: key('tea'), category: 'Food', lastSpentOn: '2025-01-01' }];
    const before = JSON.stringify({ memory, history });
    const first = suggest('tea', { memory, history });
    const second = suggest('tea', { memory, history });
    expect(second).toEqual(first);
    expect(JSON.stringify({ memory, history })).toBe(before);
  });
});
