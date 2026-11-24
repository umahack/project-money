/**
 * Quick Add line parser.
 *
 * `parseQuickAddLine(line, today)` is pure: it reads no clock, locale, storage, network, or time zone, and it never
 * throws. Each stage is one left-to-right pass over at most 200 UTF-16 code units, so the parse is linear.
 *
 * Stages: length, quoted segments, tokens, classification (dates, `on N`, markers, amounts, note words), date
 * resolution, amount resolution and validation, note assembly. Every problem from the date, amount, and note stages
 * is collected so the User can correct them together.
 *
 * Requirements: 2.1 to 2.4, 2.6, 2.12 to 2.15, 2.19, 2.26 to 2.30, 2.34, 2.35, 3.7, 3.11, 17.1, 17.4, 17.7, 17.8.
 */

import {
  convertAmountCandidate,
  isCurrencyMarkerToken,
  readAmountCandidate,
  type AmountCandidate,
  type AmountSubcode,
} from './amount';
import {
  classifyDateToken,
  multipleDatesProblem,
  parseIsoDate,
  resolveDateToken,
  type DateToken,
} from './dates';

/** Longest accepted line, in UTF-16 code units as the input's `maxLength` counts them. */
export const MAX_LINE_LENGTH = 200;
/** Longest accepted note, in UTF-16 code units as the Expense_API counts them. */
export const MAX_NOTE_LENGTH = 120;

export type ParseProblemCode =
  | 'LINE_TOO_LONG'
  | 'MISSING_AMOUNT'
  | 'INVALID_AMOUNT'
  | 'MULTIPLE_AMOUNTS'
  | 'INVALID_DATE'
  | 'MULTIPLE_DATES'
  | 'NOTE_TOO_LONG';

export type ParseProblemSubcode = AmountSubcode | 'NOT_A_DATE' | 'OUT_OF_RANGE';

export interface ParseProblem {
  code: ParseProblemCode;
  subcode?: ParseProblemSubcode;
  /** The affected text exactly as typed, or '' for the whole line. */
  part: string;
  /** A plain sentence. */
  reason: string;
  /** A plain sentence stating an accepted form. */
  correction: string;
}

export interface ParsedEntry {
  /** Positive safe integer, at most 9_999_999_999_999. */
  amountMinor: number;
  /** `YYYY-MM-DD`, a real date inside the Accepted_Date_Range. */
  spentOn: string;
  /** As typed, whitespace runs collapsed to one space, trimmed. May be empty. */
  note: string;
}

export type ParseResult = { ok: true; entry: ParsedEntry } | { ok: false; problems: ParseProblem[] };

/* --------------------------------- stages --------------------------------- */

/** A piece of the line in order: a whitespace-delimited token or the contents of a quoted segment. */
type Item = { kind: 'token'; text: string } | { kind: 'quoted'; text: string };

const QUOTE = '"';
const TOKEN = /\S+/g;

/**
 * Splits the line into ordered items. A `"` that has a later closing `"` opens a quoted segment, a doubled `""`
 * inside it is one literal quote, and a `"` with no closing quote stays ordinary text (Requirements 2.26 to 2.28).
 * A quoted segment ends the token before it and starts a new token after it.
 */
function splitItems(line: string): Item[] {
  const n = line.length;
  // closeAt[p]: index of the closing quote for text scanned from p inside a quoted segment, or -1 when there is none.
  // Computed right to left, so it is linear. Indexes n and n + 1 are the "no closing quote" sentinels.
  const closeAt = new Int32Array(n + 2).fill(-1);
  for (let p = n - 1; p >= 0; p -= 1) {
    if (line[p] !== QUOTE) {
      closeAt[p] = closeAt[p + 1] as number;
    } else if (p + 1 < n && line[p + 1] === QUOTE) {
      closeAt[p] = closeAt[p + 2] as number;
    } else {
      closeAt[p] = p;
    }
  }

  const items: Item[] = [];
  let plainStart = 0;
  const flushPlain = (end: number): void => {
    const plain = line.slice(plainStart, end);
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(plain); match !== null; match = TOKEN.exec(plain)) {
      items.push({ kind: 'token', text: match[0] });
    }
  };

  let i = 0;
  while (i < n) {
    const close = line[i] === QUOTE ? (closeAt[i + 1] as number) : -1;
    if (close === -1) {
      i += 1;
      continue;
    }
    flushPlain(i);
    items.push({ kind: 'quoted', text: line.slice(i + 1, close).replace(/""/g, QUOTE) });
    i = close + 1;
    plainStart = i;
  }
  flushPlain(n);
  return items;
}

/** One entry of the classified line, in line order. */
type Part =
  | { kind: 'note'; text: string }
  | { kind: 'date'; token: DateToken }
  | { kind: 'amount'; candidate: AmountCandidate; display: string };

/**
 * Classifies every item. Precedence: quoted text, then date patterns, then a marker attached to an amount
 * candidate, then amount candidates, then note words (design, "Precedence, in one table").
 */
function classify(items: readonly Item[]): Part[] {
  const parts: Part[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i] as Item;
    if (item.kind === 'quoted') {
      parts.push({ kind: 'note', text: item.text });
      i += 1;
      continue;
    }
    const text = item.text;
    const next = items[i + 1];

    // `on N`: both tokens are consumed. With N above 31 the pair is not a date, so `on` stays a note word and
    // the number is classified on its own turn (Requirement 2.19).
    if (next !== undefined && next.kind === 'token' && text.normalize('NFKC').toLowerCase() === 'on') {
      const pair = classifyDateToken(`${text} ${next.text}`);
      if (pair) {
        parts.push({ kind: 'date', token: pair });
        i += 2;
        continue;
      }
    }

    const date = classifyDateToken(text);
    if (date) {
      parts.push({ kind: 'date', token: date });
      i += 1;
      continue;
    }

    // A lone marker attaches to the next token only when that token is an amount candidate.
    if (next !== undefined && next.kind === 'token' && isCurrencyMarkerToken(text)) {
      const marked = readAmountCandidate(next.text, true);
      if (marked) {
        parts.push({ kind: 'amount', candidate: marked, display: `${text} ${next.text}` });
        i += 2;
        continue;
      }
    }

    const candidate = readAmountCandidate(text, false);
    if (candidate) {
      parts.push({ kind: 'amount', candidate, display: text });
    } else {
      parts.push({ kind: 'note', text });
    }
    i += 1;
  }
  return parts;
}

function listQuoted(texts: readonly string[]): string {
  return texts.map((text) => `"${text}"`).join(', ');
}

/** Resolves the date. Zero date tokens mean Today, several mean one problem, one is resolved against Today. */
function resolveDate(parts: readonly Part[], today: string): { date: string } | { problem: ParseProblem } {
  const tokens: DateToken[] = [];
  for (const part of parts) if (part.kind === 'date') tokens.push(part.token);
  if (tokens.length === 0) return { date: today };
  if (tokens.length > 1) return { problem: multipleDatesProblem(tokens.map((token) => token.text)) };
  const resolution = resolveDateToken(tokens[0] as DateToken, today);
  if (resolution.ok) return { date: resolution.date };
  return { problem: resolution.problem };
}

interface AmountChoice {
  /** The chosen candidate, when exactly one could be chosen. */
  chosen: Extract<Part, { kind: 'amount' }> | null;
  problem: ParseProblem | null;
}

/**
 * Chooses the Amount_Token. One candidate is used. With several, exactly one carrying a Currency_Marker wins and
 * the others stay in the note. A `/-` suffix alone does not count as a marker, because Requirements 2.13 and 2.14
 * speak only of a Currency_Marker. Otherwise the line has multiple amounts, or none.
 */
function chooseAmount(parts: readonly Part[]): AmountChoice {
  const amounts = parts.filter((part): part is Extract<Part, { kind: 'amount' }> => part.kind === 'amount');
  if (amounts.length === 0) {
    return {
      chosen: null,
      problem: {
        code: 'MISSING_AMOUNT',
        part: '',
        reason: 'The line has no amount.',
        correction: 'Add an amount, like "120 coffee" or "coffee ₹120".',
      },
    };
  }
  if (amounts.length === 1) return { chosen: amounts[0] as Extract<Part, { kind: 'amount' }>, problem: null };

  const marked = amounts.filter((part) => part.candidate.hasMarker);
  if (marked.length === 1) return { chosen: marked[0] as Extract<Part, { kind: 'amount' }>, problem: null };

  const displays = amounts.map((part) => part.display);
  return {
    chosen: null,
    problem: {
      code: 'MULTIPLE_AMOUNTS',
      part: displays.join(' '),
      reason: `The line has more than one amount: ${listQuoted(displays)}.`,
      correction: 'Mark the amount with ₹, like "₹120", or put the other numbers in double quotes.',
    },
  };
}

function toProblem(problem: {
  code: ParseProblemCode;
  subcode?: ParseProblemSubcode;
  part: string;
  reason: string;
  correction: string;
}): ParseProblem {
  const result: ParseProblem = {
    code: problem.code,
    part: problem.part,
    reason: problem.reason,
    correction: problem.correction,
  };
  if (problem.subcode !== undefined) result.subcode = problem.subcode;
  return result;
}

/** Joins the unclaimed text in line order, collapses whitespace runs to one space, and trims. */
function assembleNote(parts: readonly Part[], chosen: Extract<Part, { kind: 'amount' }> | null): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.kind === 'note') {
      pieces.push(part.text);
    } else if (part.kind === 'amount' && part !== chosen) {
      // A candidate that is not the Amount_Token is note text (Requirement 2.13).
      pieces.push(part.display);
    }
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------- entry point ------------------------------- */

/**
 * Converts a Quick_Add_Line and Today (`YYYY-MM-DD`, Asia/Kolkata) into a Parse_Result.
 *
 * Never throws. A `today` that is not a real `YYYY-MM-DD` date, which is a caller error, returns one
 * `INVALID_DATE` problem instead of reaching the date helpers that would throw. The result has a non-empty
 * problem list whenever it has no entry.
 */
export function parseQuickAddLine(line: string, today: string): ParseResult {
  const text = typeof line === 'string' ? line : '';

  // 1. Length. This is the only early exit that skips the other stages.
  if (text.length > MAX_LINE_LENGTH) {
    return {
      ok: false,
      problems: [
        {
          code: 'LINE_TOO_LONG',
          part: '',
          reason: `The line is ${text.length} characters long and the limit is ${MAX_LINE_LENGTH}.`,
          correction: `Shorten the line to ${MAX_LINE_LENGTH} characters or fewer.`,
        },
      ],
    };
  }

  if (typeof today !== 'string' || parseIsoDate(today) === null) {
    return {
      ok: false,
      problems: [
        {
          code: 'INVALID_DATE',
          subcode: 'NOT_A_DATE',
          part: '',
          reason: "Today's date is not available.",
          correction: 'Reload the page so that the date can be read again.',
        },
      ],
    };
  }

  // 2 to 4. Quoted segments, tokens, classification.
  const parts = classify(splitItems(text));

  // 5 to 7. Date, then amount.
  const problems: ParseProblem[] = [];
  const dateResult = resolveDate(parts, today);
  if ('problem' in dateResult) problems.push(toProblem(dateResult.problem));

  const choice = chooseAmount(parts);
  let amountMinor = 0;
  if (choice.problem) {
    problems.push(choice.problem);
  } else if (choice.chosen) {
    const converted = convertAmountCandidate(choice.chosen.candidate);
    if (converted.ok) {
      amountMinor = converted.amountMinor;
    } else {
      problems.push({
        code: 'INVALID_AMOUNT',
        subcode: converted.subcode,
        part: choice.chosen.candidate.raw,
        reason: converted.reason,
        correction: converted.correction,
      });
    }
  }

  // 8. Note. When no amount could be chosen, every candidate stays in the note text that is measured.
  const note = assembleNote(parts, choice.chosen);
  if (note.length > MAX_NOTE_LENGTH) {
    problems.push({
      code: 'NOTE_TOO_LONG',
      part: '',
      reason: `The note is ${note.length} characters long and the limit is ${MAX_NOTE_LENGTH}.`,
      correction: `Shorten the note to ${MAX_NOTE_LENGTH} characters or fewer.`,
    });
  }

  // 9. Result.
  if (problems.length > 0 || !('date' in dateResult)) {
    return { ok: false, problems };
  }
  return { ok: true, entry: { amountMinor, spentOn: dateResult.date, note } };
}
