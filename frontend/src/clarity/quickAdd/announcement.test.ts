import { describe, expect, it } from 'vitest';
import { answerResultSentence, buildSaveAnnouncement } from './announcement';
import type { AnswerLine, EntryAnswerModel } from './answer';
import { describeMonth } from './dates';

const money = (amountMinor: number) => ({ currency: 'INR' as const, amountMinor });

function answerOf(overrides: Partial<EntryAnswerModel> = {}, lines: AnswerLine[] = []): EntryAnswerModel {
  return {
    mode: 'saved',
    titleKey: 'answer.saved',
    dataVersion: 3,
    month: '2026-11',
    scope: 'current_month',
    countsTowardCurrentMonth: true,
    status: 'available',
    today: 'shown',
    bucket: null,
    saved: null,
    explanation: null,
    lines,
    actions: [],
    ...overrides,
  };
}

describe('describeMonth', () => {
  it('names a month key and leaves anything else as it is', () => {
    expect(describeMonth('2026-11')).toBe('November 2026');
    expect(describeMonth('2026-01-05')).toBe('January 2026');
    expect(describeMonth('nope')).toBe('nope');
    expect(describeMonth('2026-13')).toBe('2026-13');
  });
});

describe('save announcement (Requirement 9.18)', () => {
  it('states Left_Today from the server value', () => {
    const answer = answerOf({}, [{ key: 'answer.today.left', money: { leftToday: money(255_000) } }]);
    expect(buildSaveAnnouncement({ amountMinor: 12_000, category: 'Food', answer })).toBe('Saved ₹120 to Food. ₹2,550 left today.');
  });

  it('states the amount over today\'s allowance when the server says it is over', () => {
    const answer = answerOf({}, [
      { key: 'answer.today.spent', money: { todaySpent: money(1), todayAllowance: money(2) } },
      { key: 'answer.today.over', money: { overToday: money(40_000) } },
    ]);
    expect(buildSaveAnnouncement({ amountMinor: 50_000, category: 'Shopping', answer })).toBe(
      "Saved ₹500 to Shopping. Over today's allowance by ₹400.",
    );
  });

  it('names the month the entry counts toward when it is in another month', () => {
    const answer = answerOf({ month: '2026-10', scope: 'other_month', countsTowardCurrentMonth: false, today: 'not_applicable' });
    expect(buildSaveAnnouncement({ amountMinor: 12_000, category: 'Food', answer })).toBe('Saved ₹120 to Food. Counts toward October 2026.');
  });

  it.each(['not_provided', 'unavailable'] as const)('names the month when the Today values are %s', (today) => {
    expect(buildSaveAnnouncement({ amountMinor: 12_000, category: 'Food', answer: answerOf({ today }) })).toBe(
      'Saved ₹120 to Food. Counts toward November 2026.',
    );
  });

  it('does not read a Left_Today line that is not for today, and never makes a value of its own', () => {
    const answer = answerOf({ today: 'unavailable' }, [{ key: 'answer.today.left', money: { leftToday: money(1_000) } }]);
    expect(answerResultSentence(answer)).toBe('Counts toward November 2026.');
  });

  it('falls back to the month when the server line carries no money, and to the plain sentence with no answer or month', () => {
    expect(answerResultSentence(answerOf({}, [{ key: 'answer.today.left' }]))).toBe('Counts toward November 2026.');
    expect(buildSaveAnnouncement({ amountMinor: 12_000, category: 'Food' })).toBe('Saved ₹120 to Food.');
    expect(buildSaveAnnouncement({ amountMinor: 12_000, category: 'Food', answer: answerOf({ month: '', today: 'unavailable' }) })).toBe('Saved ₹120 to Food.');
  });
});
