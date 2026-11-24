/**
 * Quick Add amount grammar and Indian-grouping formatting.
 *
 * Pure and dependency-free: no clock, locale, `Intl`, storage, or network. All money is integer paise.
 * Paise are built from the digit string, so no floating-point step exists.
 */

/** Largest number of digits accepted before the decimal point (digits as typed, grouping commas excluded). */
export const MAX_INTEGER_DIGITS = 11;
/** ₹99,99,99,99,999.99 in paise. */
export const MAX_AMOUNT_MINOR = 9_999_999_999_999;
/** Accepted range, as it is stated in invalid-amount problems. */
export const AMOUNT_RANGE_TEXT = '₹0.01 to ₹99,99,99,99,999.99';

export type AmountSubcode =
  | 'BAD_GROUPING'
  | 'TOO_MANY_DECIMALS'
  | 'NO_INTEGER_PART'
  | 'TRAILING_POINT'
  | 'ZERO'
  | 'TOO_LARGE';

export type AmountResult =
  | { ok: true; amountMinor: number }
  | { ok: false; subcode: AmountSubcode; reason: string; correction: string };

/** A token that looks like an amount: optional marker, a number body, optional `/-` suffix. */
export interface AmountCandidate {
  /** The token exactly as typed (before NFKC), for Note_Text and for naming the part in problems. */
  raw: string;
  /** The number body after NFKC with marker and suffix removed, e.g. `1,20,000.50`. */
  body: string;
  /** True when a Currency_Marker was attached to the token or the caller said one directly precedes it. */
  hasMarker: boolean;
  /** True when the token ended with `/-`. */
  hasSuffix: boolean;
}

/** Marker prefixes, matched on the lower-cased NFKC token. Longest `rs.` is tried before `rs`. */
const MARKER_PREFIXES = ['₹', 'rs.', 'rs', 'inr'] as const;
const MARKER_TOKENS: ReadonlySet<string> = new Set(['₹', 'rs', 'rs.', 'inr']);

const BODY_SHAPE = /^[0-9,]*(\.[0-9]*)?$/;
const PLAIN_INTEGER = /^[0-9]+$/;
const INDIAN_GROUPING = /^[0-9]{1,2}(,[0-9]{2})*,[0-9]{3}$/;
const WESTERN_GROUPING = /^[0-9]{1,3}(,[0-9]{3})+$/;

/** NFKC and lower-case. ASCII letters matter only, so locale-independent `toLowerCase` is enough. */
function fold(token: string): string {
  return token.normalize('NFKC').toLowerCase();
}

/** True for a token that is only a Currency_Marker (`₹`, `Rs`, `Rs.`, `INR`, any letter case). */
export function isCurrencyMarkerToken(token: string): boolean {
  return MARKER_TOKENS.has(fold(token));
}

function isBody(body: string): boolean {
  return BODY_SHAPE.test(body) && /[0-9]/.test(body);
}

/**
 * Reads one token as an amount candidate, or returns null when the token is note text.
 * `precededByMarker` is set by the caller when the previous token was a lone Currency_Marker.
 * Only ASCII digits (after NFKC) count as digits, so Devanagari and Telugu numerals return null.
 */
export function readAmountCandidate(token: string, precededByMarker = false): AmountCandidate | null {
  const folded = token.normalize('NFKC');
  const lower = folded.toLowerCase();

  const tryRest = (rest: string, hasMarker: boolean): AmountCandidate | null => {
    let body = rest;
    let hasSuffix = false;
    if (body.endsWith('/-')) {
      body = body.slice(0, -2);
      hasSuffix = true;
    }
    if (!isBody(body)) return null;
    return { raw: token, body, hasMarker: hasMarker || precededByMarker, hasSuffix };
  };

  const bare = tryRest(folded, false);
  if (bare) return bare;
  for (const marker of MARKER_PREFIXES) {
    if (lower.startsWith(marker)) {
      // Prefixes are ASCII or `₹`; lower-casing and NFKC keep their length, so slicing `folded` is safe.
      const found = tryRest(folded.slice(marker.length), true);
      if (found) return found;
    }
  }
  return null;
}

function problem(subcode: AmountSubcode, token: string, reason: string, correction: string): AmountResult {
  return { ok: false, subcode, reason: `"${token}" ${reason}`, correction };
}

/**
 * Validates a number body and converts it to paise. `token` only names the text in problem sentences.
 * Check order: integer part (missing, grouping), fraction (trailing point, too many digits), size, zero.
 * The value is never rounded or truncated.
 */
export function convertAmountBody(body: string, token: string = body): AmountResult {
  const point = body.indexOf('.');
  const intPart = point === -1 ? body : body.slice(0, point);
  const fraction = point === -1 ? null : body.slice(point + 1);

  if (!/[0-9]/.test(intPart)) {
    return problem(
      'NO_INTEGER_PART',
      token,
      'has no digit before the decimal point.',
      'Write the amount like 120 or 0.50.',
    );
  }
  const grouped = intPart.includes(',');
  if (grouped ? !(INDIAN_GROUPING.test(intPart) || WESTERN_GROUPING.test(intPart)) : !PLAIN_INTEGER.test(intPart)) {
    return problem(
      'BAD_GROUPING',
      token,
      'uses commas in a way that is not Indian or three-digit grouping.',
      'Write 1,20,000 or 120,000, or leave the commas out.',
    );
  }
  if (fraction !== null && fraction.length === 0) {
    return problem('TRAILING_POINT', token, 'has a decimal point with no digits after it.', 'Write 120 or 120.50.');
  }
  if (fraction !== null && (fraction.length > 2 || !PLAIN_INTEGER.test(fraction))) {
    return problem(
      'TOO_MANY_DECIMALS',
      token,
      'has more than two digits after the decimal point.',
      'Use at most two digits after the point, like 120.50.',
    );
  }
  const intDigits = grouped ? intPart.replace(/,/g, '') : intPart;
  if (intDigits.length > MAX_INTEGER_DIGITS) {
    return problem('TOO_LARGE', token, 'is too large.', `Use an amount from ${AMOUNT_RANGE_TEXT}.`);
  }
  // One fractional digit is tenths of a rupee: 120.5 is 12,050 paise.
  const paiseDigits = (fraction ?? '').padEnd(2, '0');
  // At most 13 digits, so parsing the digit string as an integer is exact.
  const amountMinor = Number.parseInt(`${intDigits}${paiseDigits}`, 10);
  if (amountMinor === 0) {
    return problem('ZERO', token, 'is zero.', `Use an amount from ${AMOUNT_RANGE_TEXT}.`);
  }
  return { ok: true, amountMinor };
}

/** Converts a candidate returned by `readAmountCandidate`. */
export function convertAmountCandidate(candidate: AmountCandidate): AmountResult {
  return convertAmountBody(candidate.body, candidate.raw);
}

/** Groups an integer digit string the Indian way: the last three digits, then pairs. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  let head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const parts: string[] = [];
  while (head.length > 2) {
    parts.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head.length > 0) parts.unshift(head);
  return `${parts.join(',')},${tail}`;
}

/**
 * Formats integer paise with Indian digit grouping and no currency sign: `1,20,000`, `120.50`.
 * Two fractional digits appear only when the amount has paise. Negative values get a leading `-`.
 * Throws RangeError for a value that is not a safe integer, because money is never guessed.
 */
export function formatInrDigits(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Amount must be a safe integer number of paise.');
  }
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const whole = groupIndian(String(rupees));
  return `${sign}${whole}${paise === 0 ? '' : `.${String(paise).padStart(2, '0')}`}`;
}

/** Formats integer paise as `₹` plus Indian digit grouping. A negative value is written `-₹…`. */
export function formatInr(amountMinor: number): string {
  const digits = formatInrDigits(amountMinor);
  return digits.startsWith('-') ? `-₹${digits.slice(1)}` : `₹${digits}`;
}
