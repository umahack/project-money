import { describe, expect, it } from 'vitest';
import { assertProperty } from '../../test/propertyReport';
import { fc } from '../../test/test-utils';
import { isApplePlatform, matchQuickAddShortcut, type KeyEventLike } from './shortcut';

const cmdK: KeyEventLike = { key: 'k', code: 'KeyK', metaKey: true };
const ctrlK: KeyEventLike = { key: 'k', code: 'KeyK', ctrlKey: true };

describe('matchQuickAddShortcut', () => {
  it('matches Cmd + K on Apple platforms and Ctrl + K elsewhere', () => {
    expect(matchQuickAddShortcut(cmdK, true)).toBe(true);
    expect(matchQuickAddShortcut(ctrlK, false)).toBe(true);
  });

  it('does not respond to the other platform modifier', () => {
    expect(matchQuickAddShortcut(ctrlK, true)).toBe(false);
    expect(matchQuickAddShortcut(cmdK, false)).toBe(false);
  });

  it('rejects both modifiers held together', () => {
    const both = { ...cmdK, ctrlKey: true };
    expect(matchQuickAddShortcut(both, true)).toBe(false);
    expect(matchQuickAddShortcut(both, false)).toBe(false);
  });

  it('rejects K without a modifier', () => {
    expect(matchQuickAddShortcut({ key: 'k', code: 'KeyK' }, true)).toBe(false);
    expect(matchQuickAddShortcut({ key: 'k', code: 'KeyK' }, false)).toBe(false);
  });

  it('ignores Shift, Alt, key repeat, and composition', () => {
    for (const apple of [true, false]) {
      const base = apple ? cmdK : ctrlK;
      expect(matchQuickAddShortcut({ ...base, shiftKey: true }, apple)).toBe(false);
      expect(matchQuickAddShortcut({ ...base, altKey: true }, apple)).toBe(false);
      expect(matchQuickAddShortcut({ ...base, repeat: true }, apple)).toBe(false);
      expect(matchQuickAddShortcut({ ...base, isComposing: true }, apple)).toBe(false);
    }
  });

  it('matches an uppercase K value when no Shift is reported (Caps Lock)', () => {
    expect(matchQuickAddShortcut({ key: 'K', code: 'KeyK', ctrlKey: true }, false)).toBe(true);
  });

  it('matches a Latin letter by its value, not its physical code', () => {
    // Dvorak: the physical KeyK position types "t", and the physical KeyV position types "k".
    expect(matchQuickAddShortcut({ key: 't', code: 'KeyK', ctrlKey: true }, false)).toBe(false);
    expect(matchQuickAddShortcut({ key: 'k', code: 'KeyV', ctrlKey: true }, false)).toBe(true);
  });

  it('matches a non-Latin layout by the physical KeyK code', () => {
    expect(matchQuickAddShortcut({ key: 'क', code: 'KeyK', metaKey: true }, true)).toBe(true);
    expect(matchQuickAddShortcut({ key: 'క', code: 'KeyK', ctrlKey: true }, false)).toBe(true);
    expect(matchQuickAddShortcut({ key: 'क', code: 'KeyJ', ctrlKey: true }, false)).toBe(false);
  });

  it('rejects other keys', () => {
    expect(matchQuickAddShortcut({ key: 'j', code: 'KeyJ', ctrlKey: true }, false)).toBe(false);
    expect(matchQuickAddShortcut({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, false)).toBe(false);
    expect(matchQuickAddShortcut({ key: 'Enter', code: 'Enter', metaKey: true }, true)).toBe(false);
  });

  it('does not throw on events with missing or non-string key fields', () => {
    expect(matchQuickAddShortcut({ ctrlKey: true }, false)).toBe(false);
    expect(matchQuickAddShortcut({ key: undefined, code: 'KeyK', ctrlKey: true }, false)).toBe(true);
    expect(matchQuickAddShortcut({ key: 5 as unknown as string, code: 'KeyJ', ctrlKey: true }, false)).toBe(false);
  });
});

/**
 * Independent reference for Requirement 17.24, written from the requirement text and not from the implementation:
 * the platform modifier alone (Meta on Apple, Control elsewhere), no Shift or Alt, no repeat, no composition, and
 * a key that is K by value when the value is one ASCII letter, or by physical code when it is anything else.
 */
function referenceAccepts(e: KeyEventLike, apple: boolean): boolean {
  const meta = e.metaKey === true;
  const ctrl = e.ctrlKey === true;
  const platformModifierAlone = apple ? meta && !ctrl : ctrl && !meta;
  const quiet = e.shiftKey !== true && e.altKey !== true && e.repeat !== true && e.isComposing !== true;
  const key = e.key;
  let isK: boolean;
  if (typeof key === 'string' && key.length === 1) {
    const unit = key.charCodeAt(0);
    const asciiLetter = (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122);
    isK = asciiLetter ? unit === 75 || unit === 107 : e.code === 'KeyK';
  } else {
    isK = e.code === 'KeyK';
  }
  return platformModifierAlone && quiet && isK;
}

const optionalFlagArb = fc.constantFrom<boolean | undefined>(true, false, undefined);

// Key values: K in both cases, other Latin letters (a layout that moved K), non-Latin letters, look-alikes of K that
// are not ASCII, named keys, multi-character values, and absent or empty values.
const keyArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom<string | undefined>('k', 'K') },
  { weight: 3, arbitrary: fc.constantFrom('a', 'j', 't', 'v', 'Z', 'q') },
  { weight: 3, arbitrary: fc.constantFrom('क', 'క', 'к', 'κ', 'ك') },
  { weight: 2, arbitrary: fc.constantFrom('\u212A', '\uFF4B', '\uFF2B', 'ķ', 'ǩ') },
  { weight: 2, arbitrary: fc.constantFrom('Control', 'Meta', 'Enter', 'Dead', 'Unidentified', 'kk', ' ', '', '5') },
  { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.string({ maxLength: 3 }) },
);

const codeArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant<string | undefined>('KeyK') },
  { weight: 3, arbitrary: fc.constantFrom('KeyJ', 'KeyV', 'KeyT', 'Enter', 'ControlLeft', 'MetaLeft', 'Digit5', '') },
  { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.string({ maxLength: 6 }) },
);

const keyEventArb: fc.Arbitrary<KeyEventLike> = fc
  .record({
    key: keyArb,
    code: codeArb,
    metaKey: optionalFlagArb,
    ctrlKey: optionalFlagArb,
    shiftKey: optionalFlagArb,
    altKey: optionalFlagArb,
    repeat: optionalFlagArb,
    isComposing: optionalFlagArb,
  })
  .map((event) => {
    const present: KeyEventLike = {};
    for (const [name, value] of Object.entries(event)) {
      if (value !== undefined) (present as Record<string, unknown>)[name] = value;
    }
    return present;
  });

describe('matchQuickAddShortcut properties', () => {
  // Feature: quick-add-daily-answer, Property 23: The shortcut matcher accepts exactly the defined combination
  // Validates: Requirements 1.7, 1.15, 1.16, 17.24
  it('accepts an event exactly when the reference predicate does, on either platform', () => {
    assertProperty(
      fc.property(keyEventArb, fc.boolean(), (event, apple) => {
        expect(matchQuickAddShortcut(event, apple)).toBe(referenceAccepts(event, apple));
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: quick-add-daily-answer, Property 23: The shortcut matcher accepts exactly the defined combination
  // Validates: Requirements 1.7, 1.15, 1.16, 17.24
  it('accepts a K event with the platform modifier alone and rejects every other modifier combination', () => {
    const flagsArb = fc.record({
      metaKey: fc.boolean(),
      ctrlKey: fc.boolean(),
      shiftKey: fc.boolean(),
      altKey: fc.boolean(),
      repeat: fc.boolean(),
      isComposing: fc.boolean(),
    });
    assertProperty(
      fc.property(flagsArb, fc.boolean(), fc.constantFrom('k', 'K'), (flags, apple, key) => {
        const accepted = matchQuickAddShortcut({ key, code: 'KeyK', ...flags }, apple);
        const exactlyDefined = apple
          ? flags.metaKey && !flags.ctrlKey
          : flags.ctrlKey && !flags.metaKey;
        const quiet = !flags.shiftKey && !flags.altKey && !flags.repeat && !flags.isComposing;
        expect(accepted).toBe(Boolean(exactlyDefined) && quiet);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: quick-add-daily-answer, Property 23: The shortcut matcher accepts exactly the defined combination
  // Validates: Requirements 1.7, 1.15, 1.16, 17.24
  it('follows the typed Latin letter and ignores the physical code, and follows the code for non-Latin keys', () => {
    const codes = fc.constantFrom('KeyK', 'KeyJ', 'KeyV', 'KeyT', 'Enter', '');
    assertProperty(
      fc.property(
        fc.constantFrom('a', 'b', 'j', 't', 'v', 'z', 'A', 'Z'),
        fc.constantFrom('क', 'క', 'к', 'ك', '\u212A', '\uFF4B'),
        codes,
        fc.boolean(),
        (otherLetter, nonLatin, code, apple) => {
          const modifier = apple ? { metaKey: true } : { ctrlKey: true };
          // A Latin letter other than K never matches, whatever the physical code says.
          expect(matchQuickAddShortcut({ key: otherLetter, code, ...modifier }, apple)).toBe(false);
          // A Latin K always matches, whatever the physical code says.
          expect(matchQuickAddShortcut({ key: 'k', code, ...modifier }, apple)).toBe(true);
          // A non-Latin key matches only on the physical K position.
          expect(matchQuickAddShortcut({ key: nonLatin, code, ...modifier }, apple)).toBe(code === 'KeyK');
        },
      ),
    );
  });

  // Feature: quick-add-daily-answer, Property 23: The shortcut matcher accepts exactly the defined combination
  // Validates: Requirements 1.7, 1.15, 1.16, 17.24
  it('is deterministic and does not modify the event', () => {
    assertProperty(
      fc.property(keyEventArb, fc.boolean(), (event, apple) => {
        const before = JSON.stringify(event);
        const first = matchQuickAddShortcut(event, apple);
        const second = matchQuickAddShortcut(event, apple);
        expect(second).toBe(first);
        expect(JSON.stringify(event)).toBe(before);
      }),
    );
  });
});

describe('isApplePlatform', () => {
  it('detects Apple platforms from navigator.platform', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ platform: 'iPhone' })).toBe(true);
    expect(isApplePlatform({ platform: 'iPad' })).toBe(true);
  });

  it('treats Windows, Linux, and Android as non-Apple', () => {
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false);
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isApplePlatform({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(false);
  });

  it('prefers userAgentData.platform over navigator.platform', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
  });

  it('falls back to the user agent when no platform string exists', () => {
    expect(isApplePlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(isApplePlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
  });

  it('returns false when no navigator is available', () => {
    expect(isApplePlatform(null)).toBe(false);
    expect(isApplePlatform({})).toBe(false);
  });
});
