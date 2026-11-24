// The recurring-payment hint of the preview (Requirement 3.14). Pure.
//
// The hint appears when the Note_Text contains the whole word `monthly`, `weekly`, `yearly`, or `recurring`, or the
// phrase `every month`. Matching ignores letter case and splits on anything that is not a letter, mark, or number, so
// `monthly,` matches and `bimonthly` does not.

export const RECURRING_HINT_TEXT = 'Quick Add saves one expense. To repeat a payment every month, add it as a bill in Plan.';

const WORDS = new Set(['monthly', 'weekly', 'yearly', 'recurring']);
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const PHRASE = /(?:^|[^\p{L}\p{M}\p{N}])every\s+month(?![\p{L}\p{M}\p{N}])/u;

export function hasRecurringHint(note: string): boolean {
  if (typeof note !== 'string' || note === '') return false;
  const folded = note.normalize('NFKC').toLocaleLowerCase('en-IN');
  for (const word of folded.match(WORD) ?? []) {
    if (WORDS.has(word)) return true;
  }
  return PHRASE.test(folded);
}
