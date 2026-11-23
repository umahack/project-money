/**
 * Keyword rules for the Quick Add category suggester.
 *
 * Data only. Each row maps a built-in category to the words and phrases that usually mean it. The table is written for
 * common Indian daily-life notes (food delivery, groceries, fuel, auto and cab, metro, recharge, rent, medicines, OTT).
 *
 * How to read and extend this table:
 * - Every key must be one of the ten built-in categories (`BUILT_IN_CATEGORIES`). Custom categories are never
 *   targets (Requirement 5.13). The unit tests compare the list with the backend's `EXPENSE_CATEGORIES`.
 * - Words and phrases are lower-case English in ASCII letters, digits, and single spaces only (Requirement 5.17).
 *   A note in Hindi, Telugu, or another script never matches a rule.
 * - A phrase matches whole words only, ignoring letter case and punctuation. `swiggy,` matches `swiggy`, and
 *   `grocery` does not match inside `grocerystore`.
 * - When several rules match one note, the longest phrase wins (counted in characters, with single spaces), so
 *   `amazon prime` (Entertainment) beats `amazon` (Shopping). Phrases of equal length go to the rule that appears
 *   first in `KEYWORD_RULES`, which follows the order of this table: category rows from top to bottom, then the
 *   phrases of a row from left to right. Put the more specific category first.
 * - Keep the table small. Add a row only with a test in `suggester.test.ts`.
 *
 * Requirements: 5.5, 5.6, 5.13, 5.17.
 */

/** The ten built-in expense categories, in the order the backend lists them. */
export const BUILT_IN_CATEGORIES: readonly string[] = Object.freeze([
  'Food',
  'Groceries',
  'Transport',
  'Shopping',
  'Entertainment',
  'Bills',
  'Health',
  'Travel',
  'Education',
  'Other',
]);

/** The category used when no source applies. */
export const DEFAULT_CATEGORY = 'Other';

export interface KeywordRule {
  /** A built-in category. */
  readonly category: string;
  /** Lower-case ASCII words separated by single spaces. */
  readonly phrase: string;
}

interface KeywordRow {
  readonly category: string;
  readonly phrases: readonly string[];
}

/** The rule table. Order matters: see the file comment. */
const KEYWORD_TABLE: readonly KeywordRow[] = [
  {
    category: 'Groceries',
    phrases: [
      'grocery', 'groceries', 'vegetables', 'veggies', 'sabzi', 'fruits', 'milk', 'curd', 'eggs', 'bread', 'atta',
      'dal', 'paneer', 'bigbasket', 'blinkit', 'zepto', 'instamart', 'dmart', 'kirana', 'supermarket',
    ],
  },
  {
    category: 'Food',
    phrases: [
      'coffee', 'tea', 'chai', 'breakfast', 'lunch', 'dinner', 'snack', 'snacks', 'swiggy', 'zomato', 'restaurant',
      'cafe', 'biryani', 'pizza', 'burger', 'dosa', 'idli', 'juice', 'meal', 'tiffin', 'thali', 'canteen',
      'food delivery', 'eating out',
    ],
  },
  {
    category: 'Transport',
    phrases: [
      'uber', 'ola', 'rapido', 'cab', 'taxi', 'auto', 'rickshaw', 'metro', 'bus', 'local train', 'petrol', 'diesel',
      'cng', 'fuel', 'parking', 'toll', 'fastag',
    ],
  },
  {
    category: 'Travel',
    phrases: ['flight', 'hotel', 'irctc', 'train ticket', 'airbnb', 'makemytrip', 'goibibo', 'holiday', 'visa'],
  },
  {
    category: 'Entertainment',
    phrases: [
      'movie', 'movies', 'netflix', 'spotify', 'hotstar', 'prime video', 'amazon prime', 'youtube premium', 'ott',
      'bookmyshow', 'concert', 'gaming',
    ],
  },
  {
    category: 'Shopping',
    phrases: ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'clothes', 'shoes', 'shirt', 'shopping', 'mall'],
  },
  {
    category: 'Bills',
    phrases: [
      'rent', 'electricity', 'light bill', 'water bill', 'gas cylinder', 'lpg', 'wifi', 'internet', 'broadband',
      'recharge', 'phone bill', 'mobile bill', 'emi', 'insurance', 'dth', 'credit card',
    ],
  },
  {
    category: 'Health',
    phrases: [
      'doctor', 'medicine', 'medicines', 'pharmacy', 'chemist', 'medical', 'hospital', 'clinic', 'dental', 'gym',
      'lab test',
    ],
  },
  {
    category: 'Education',
    phrases: ['course', 'tuition', 'school', 'college', 'books', 'udemy', 'exam', 'fees'],
  },
];

/** The frozen, flattened rule list that `suggestCategory` uses by default. */
export const KEYWORD_RULES: readonly KeywordRule[] = Object.freeze(
  KEYWORD_TABLE.flatMap((row) =>
    row.phrases.map((phrase) => Object.freeze({ category: row.category, phrase }))),
);
