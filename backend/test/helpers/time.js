export const TEST_TIME_ZONE = 'Asia/Kolkata';
export const TEST_INSTANT = '2026-01-15T06:30:00.000Z';

function toValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Test clock requires a valid instant.');
  return date;
}

/** A small mutable clock for injecting deterministic time into domain code. */
export function createTestClock(initialInstant = TEST_INSTANT) {
  let current = toValidDate(initialInstant);

  return Object.freeze({
    now() {
      return new Date(current.getTime());
    },
    set(nextInstant) {
      current = toValidDate(nextInstant);
      return new Date(current.getTime());
    },
    advanceBy(milliseconds) {
      if (!Number.isFinite(milliseconds)) {
        throw new TypeError('Clock advance must be a finite number of milliseconds.');
      }
      current = new Date(current.getTime() + milliseconds);
      return new Date(current.getTime());
    },
  });
}

export function createTestTimeContext({ instant = TEST_INSTANT, timeZone = TEST_TIME_ZONE } = {}) {
  // Constructing a formatter validates the IANA zone without changing the
  // process-wide clock or relying on the machine's local zone.
  new Intl.DateTimeFormat('en-IN', { timeZone }).format(toValidDate(instant));
  return Object.freeze({ clock: createTestClock(instant), timeZone });
}
