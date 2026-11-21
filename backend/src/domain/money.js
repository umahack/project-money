const MINOR_UNITS_PER_MAJOR = 100;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const ROUNDING_DIRECTIONS = new Set(['exact', 'half_up', 'up']);

/**
 * Canonical INR formatting information shared by outcomes and explanations.
 * All calculations use integer paise; formatting is a presentation concern.
 */
export const MONEY_FORMAT_METADATA = Object.freeze({
  currency: 'INR',
  minorUnit: 'paise',
  minorUnitsPerMajor: MINOR_UNITS_PER_MAJOR,
  fractionDigits: 2,
  precisionMinor: 1,
});

function describe(label, message) {
  return `${label} ${message}`;
}

function safeBigIntToNumber(value, label) {
  if (value > MAX_SAFE_INTEGER_BIGINT || value < -MAX_SAFE_INTEGER_BIGINT) {
    throw new RangeError(describe(label, 'must resolve to a safe integer number of paise.'));
  }
  return Number(value);
}

/**
 * Validate an already-normalized integer-paise value.
 */
export function assertSafePaise(
  value,
  { allowNegative = true, label = 'amountMinor' } = {}
) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(describe(label, 'must be a safe integer number of paise.'));
  }
  if (!allowNegative && value < 0) {
    throw new RangeError(describe(label, 'must not be negative.'));
  }
  return value;
}

/**
 * Parse an API decimal amount without passing through floating-point arithmetic.
 * Accepted values use plain decimal notation with no more than two fraction digits.
 */
export function parseDecimalToPaise(
  value,
  { allowNegative = false, label = 'amount' } = {}
) {
  if (typeof value !== 'string') {
    throw new TypeError(describe(label, 'must be a decimal string.'));
  }

  const match = /^(?<sign>-?)(?<major>\d+)(?:\.(?<fraction>\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new TypeError(
      describe(label, 'must use plain decimal notation with at most two fraction digits.')
    );
  }

  const isNegative = match.groups.sign === '-';
  if (isNegative && !allowNegative) {
    throw new RangeError(describe(label, 'must not be negative.'));
  }

  const fraction = (match.groups.fraction ?? '').padEnd(2, '0');
  const magnitude = BigInt(match.groups.major) * 100n + BigInt(fraction || '0');
  const signedValue = isNegative ? -magnitude : magnitude;
  return safeBigIntToNumber(signedValue, label);
}

/**
 * Normalize one legacy database REAL value at a time. The source value is never
 * mutated, and values that cannot be represented exactly at paise precision are
 * rejected instead of entering canonical calculations.
 */
export function legacyNumberToPaise(
  value,
  { allowNegative = false, label = 'legacy amount' } = {}
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(describe(label, 'must be a finite number.'));
  }

  return parseDecimalToPaise(value.toString(), { allowNegative, label });
}

/**
 * Sum normalized values exactly and reject an unsafe aggregate.
 */
export function sumPaise(values, { allowNegative = true, label = 'amounts' } = {}) {
  if (!Array.isArray(values)) {
    throw new TypeError(describe(label, 'must be an array of integer-paise values.'));
  }

  let total = 0n;
  values.forEach((value, index) => {
    const normalized = assertSafePaise(value, {
      allowNegative,
      label: `${label}[${index}]`,
    });
    total += BigInt(normalized);
  });

  return safeBigIntToNumber(total, `${label} total`);
}

function assertPositiveDivisor(divisor, label = 'divisor') {
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new RangeError(describe(label, 'must be a positive safe integer.'));
  }
  return divisor;
}

/**
 * Divide integer values and round a half-unit away from zero. Financial inputs
 * are normally non-negative; signed support is needed for over-pace outcomes.
 */
export function divideHalfUp(dividend, divisor) {
  const normalizedDividend = assertSafePaise(dividend, { label: 'dividend' });
  const normalizedDivisor = assertPositiveDivisor(divisor);
  const negative = normalizedDividend < 0;
  const magnitude = BigInt(Math.abs(normalizedDividend));
  const divisorBigInt = BigInt(normalizedDivisor);
  let quotient = magnitude / divisorBigInt;
  const remainder = magnitude % divisorBigInt;

  if (remainder * 2n >= divisorBigInt) {
    quotient += 1n;
  }

  return safeBigIntToNumber(negative ? -quotient : quotient, 'rounded quotient');
}

/**
 * Divide a non-negative integer value and round any fractional paise upward.
 */
export function divideCeil(dividend, divisor) {
  const normalizedDividend = assertSafePaise(dividend, {
    allowNegative: false,
    label: 'dividend',
  });
  const normalizedDivisor = assertPositiveDivisor(divisor);
  const dividendBigInt = BigInt(normalizedDividend);
  const divisorBigInt = BigInt(normalizedDivisor);
  const quotient = (dividendBigInt + divisorBigInt - 1n) / divisorBigInt;

  return safeBigIntToNumber(quotient, 'rounded quotient');
}

/**
 * Build the explanation contract for a rounding operation.
 */
export function createRoundingMetadata({
  direction = 'exact',
  adjustmentMinor = 0,
  adjustmentTarget,
} = {}) {
  if (!ROUNDING_DIRECTIONS.has(direction)) {
    throw new TypeError('direction must be exact, half_up, or up.');
  }
  assertSafePaise(adjustmentMinor, { label: 'adjustmentMinor' });
  if (adjustmentTarget !== undefined && typeof adjustmentTarget !== 'string') {
    throw new TypeError('adjustmentTarget must be a string when provided.');
  }

  return {
    precisionMinor: MONEY_FORMAT_METADATA.precisionMinor,
    direction,
    adjustmentMinor,
    ...(adjustmentTarget === undefined ? {} : { adjustmentTarget }),
  };
}

export function divideHalfUpWithMetadata(dividend, divisor) {
  const amountMinor = divideHalfUp(dividend, divisor);
  const exact = BigInt(dividend) % BigInt(divisor) === 0n;
  return {
    amountMinor,
    rounding: createRoundingMetadata({ direction: exact ? 'exact' : 'half_up' }),
  };
}

export function divideCeilWithMetadata(dividend, divisor) {
  const amountMinor = divideCeil(dividend, divisor);
  const exact = BigInt(dividend) % BigInt(divisor) === 0n;
  return {
    amountMinor,
    rounding: createRoundingMetadata({ direction: exact ? 'exact' : 'up' }),
  };
}

function normalizeOrder(order, length) {
  const normalizedOrder = order ?? Array.from({ length }, (_, index) => index);
  if (!Array.isArray(normalizedOrder) || normalizedOrder.length !== length) {
    throw new TypeError('order must contain every amount index exactly once.');
  }

  const seen = new Set();
  for (const index of normalizedOrder) {
    if (!Number.isInteger(index) || index < 0 || index >= length || seen.has(index)) {
      throw new TypeError('order must contain every amount index exactly once.');
    }
    seen.add(index);
  }
  return [...normalizedOrder];
}

/**
 * Conserve a target total by applying whole-paise adjustments in deterministic
 * order. Negative adjustments skip zero values so no result becomes negative.
 */
export function adjustRemainder(
  amounts,
  targetTotal,
  { order, direction = 'half_up', adjustmentTarget } = {}
) {
  if (!Array.isArray(amounts)) {
    throw new TypeError('amounts must be an array of integer-paise values.');
  }

  const original = amounts.map((amount, index) => assertSafePaise(amount, {
    allowNegative: false,
    label: `amounts[${index}]`,
  }));
  const target = assertSafePaise(targetTotal, {
    allowNegative: false,
    label: 'targetTotal',
  });
  const normalizedOrder = normalizeOrder(order, original.length);
  const initialTotal = sumPaise(original, { allowNegative: false, label: 'amounts' });
  const difference = target - initialTotal;

  if (!Number.isSafeInteger(difference)) {
    throw new RangeError('remainder adjustment must be a safe integer number of paise.');
  }
  if (original.length === 0 && difference !== 0) {
    throw new RangeError('a non-zero target cannot be allocated across an empty amount list.');
  }

  const adjusted = [...original];
  if (difference > 0) {
    const fullRounds = Math.floor(difference / adjusted.length);
    const trailingUnits = difference % adjusted.length;
    for (const index of normalizedOrder) {
      adjusted[index] = sumPaise([adjusted[index], fullRounds]);
    }
    for (let position = 0; position < trailingUnits; position += 1) {
      const index = normalizedOrder[position];
      adjusted[index] = sumPaise([adjusted[index], 1]);
    }
  } else if (difference < 0) {
    let unitsToRemove = -difference;
    while (unitsToRemove > 0) {
      const positiveIndices = normalizedOrder.filter((index) => adjusted[index] > 0);
      if (positiveIndices.length === 0) {
        throw new RangeError('remainder adjustment cannot make an amount negative.');
      }

      const completeRounds = Math.floor(unitsToRemove / positiveIndices.length);
      if (completeRounds > 0) {
        const rounds = Math.min(
          completeRounds,
          ...positiveIndices.map((index) => adjusted[index])
        );
        for (const index of positiveIndices) {
          adjusted[index] -= rounds;
        }
        unitsToRemove -= rounds * positiveIndices.length;
      } else {
        for (const index of positiveIndices) {
          if (unitsToRemove === 0) break;
          adjusted[index] -= 1;
          unitsToRemove -= 1;
        }
      }
    }
  }

  const adjustments = adjusted.map((amount, index) => amount - original[index]);
  if (sumPaise(adjusted, { allowNegative: false, label: 'adjusted amounts' }) !== target) {
    throw new Error('remainder adjustment failed to conserve the target total.');
  }

  return {
    amounts: adjusted,
    adjustments,
    rounding: createRoundingMetadata({
      direction: difference === 0 ? 'exact' : direction,
      adjustmentMinor: difference,
      adjustmentTarget,
    }),
  };
}
