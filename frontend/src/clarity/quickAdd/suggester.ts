/**
 * Category suggester for Quick Add.
 *
 * Pure and deterministic: no clock, randomness, network, or storage. Exactly one suggestion comes back, chosen by the
 * first source that applies:
 *
 *   1. empty note       -> Other, source `default`
 *   2. memory           -> the User's remembered category for the exact Note_Key
 *   3. history          -> the category of the most recent saved expense with the exact Note_Key
 *   4. category name    -> a whole word or phrase of the note equals an available category name
 *   5. keyword          -> the longest matching phrase of the keyword rules (earlier rule wins a tie)
 *   6. default          -> Other
 *
 * A source whose category is not available to the User is skipped. The reason is a fixed template that names the
 * source and the matched note, words, or category.
 *
 * Requirements: 4.4, 5.1 to 5.11, 5.13, 5.16, 5.17.
 */
import { BUILT_IN_CATEGORIES, DEFAULT_CATEGORY, KEYWORD_RULES, type KeywordRule } from './keywordRules';
import { normalizeNoteKey } from './noteKey';

export type CategorySuggestionSource = 'memory' | 'history' | 'category_name' | 'keyword' | 'default';

export interface CategorySuggestion {
  category: string;
  source: CategorySuggestionSource;
  reason: string;
}

export interface MemorySuggestionEntry {
  noteKey: string;
  category: string;
}

export interface HistorySuggestionEntry {
  noteKey: string;
  category: string;
  /** `YYYY-MM-DD`. Later dates are more recent. */
  lastSpentOn: string;
}

export interface SuggestCategoryInput {
  /** The Note_Text of the parsed entry. */
  note: string;
  /** Every category the User can use now: built-in first, then custom ones in creation order. */
  categories: readonly string[];
  memory?: readonly MemorySuggestionEntry[];
  history?: readonly HistorySuggestionEntry[];
  /** Defaults to the shipped `KEYWORD_RULES`. */
  rules?: readonly KeywordRule[];
}

export const REASON_NO_NOTE = 'No note, so this goes to Other.';
export const REASON_NO_MATCH = 'No match found, so this goes to Other.';

const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const BUILT_IN_FOLDED = new Set(BUILT_IN_CATEGORIES.map(fold));

function fold(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-IN');
}

interface Words {
  /** Words as typed (after NFKC). */
  shown: string[];
  /** Lower-cased words used for comparison. */
  folded: string[];
}

/** Splits on anything that is not a letter, mark, or number. */
function wordsOf(text: string): Words {
  const shown = text.normalize('NFKC').match(WORD_PATTERN) ?? [];
  return { shown, folded: shown.map((word) => word.toLocaleLowerCase('en-IN')) };
}

/** Index of the first place where `needle` occurs as a run of whole words in `haystack`, or -1. */
function findRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        same = false;
        break;
      }
    }
    if (same) return start;
  }
  return -1;
}

function suggestion(category: string, source: CategorySuggestionSource, reason: string): CategorySuggestion {
  return { category, source, reason };
}

export function suggestCategory(input: SuggestCategoryInput): CategorySuggestion {
  const { note, categories, memory = [], history = [], rules = KEYWORD_RULES } = input;
  const available = new Set(categories);
  const text = typeof note === 'string' ? note : '';

  // 1. Empty note.
  if (text.trim() === '') return suggestion(DEFAULT_CATEGORY, 'default', REASON_NO_NOTE);

  // 2 and 3. Memory and history use the exact Note_Key only. A note with no Note_Key skips both.
  const noteKey = normalizeNoteKey(text);
  if (noteKey !== null) {
    const remembered = memory.find((entry) => entry.noteKey === noteKey);
    if (remembered && available.has(remembered.category)) {
      return suggestion(remembered.category, 'memory', `You corrected "${text}" to ${remembered.category} before.`);
    }

    let latest: HistorySuggestionEntry | undefined;
    for (const entry of history) {
      if (entry.noteKey !== noteKey) continue;
      if (latest === undefined || entry.lastSpentOn > latest.lastSpentOn) latest = entry;
    }
    if (latest && available.has(latest.category)) {
      return suggestion(latest.category, 'history', `Your last "${text}" expense was in ${latest.category}.`);
    }
  }

  const words = wordsOf(text);

  // 4. Category name: the longest name wins, then built-in before custom, then the order of the list.
  let named: { category: string; length: number; builtIn: boolean; start: number; count: number } | undefined;
  for (const category of categories) {
    const nameWords = wordsOf(category).folded;
    const start = findRun(words.folded, nameWords);
    if (start < 0) continue;
    const candidate = {
      category,
      length: nameWords.join(' ').length,
      builtIn: BUILT_IN_FOLDED.has(fold(category)),
      start,
      count: nameWords.length,
    };
    if (
      named === undefined ||
      candidate.length > named.length ||
      (candidate.length === named.length && candidate.builtIn && !named.builtIn)
    ) {
      named = candidate;
    }
  }
  if (named) {
    const matched = words.shown.slice(named.start, named.start + named.count).join(' ');
    return suggestion(named.category, 'category_name', `"${matched}" is one of your categories.`);
  }

  // 5. Keyword rules: the longest phrase wins, and the earlier rule wins a tie.
  let keyword: { rule: KeywordRule; length: number; start: number; count: number } | undefined;
  for (const rule of rules) {
    if (!available.has(rule.category)) continue;
    const phraseWords = wordsOf(rule.phrase).folded;
    const start = findRun(words.folded, phraseWords);
    if (start < 0) continue;
    const length = phraseWords.join(' ').length;
    if (keyword === undefined || length > keyword.length) {
      keyword = { rule, length, start, count: phraseWords.length };
    }
  }
  if (keyword) {
    const matched = words.shown.slice(keyword.start, keyword.start + keyword.count).join(' ');
    return suggestion(keyword.rule.category, 'keyword', `"${matched}" usually means ${keyword.rule.category}.`);
  }

  // 6. Default.
  return suggestion(DEFAULT_CATEGORY, 'default', REASON_NO_MATCH);
}
