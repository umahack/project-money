import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertProperty } from '../test/propertyReport';
import { EXPORT_CLEANUP_GRACE_MS, saveAndShare } from './exportFile';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  share: vi.fn(),
}));

vi.mock('../platform', () => ({ isNativePlatform: () => true }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: mocks.writeFile, deleteFile: mocks.deleteFile, readdir: vi.fn() },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share } }));

type ShareOutcome = 'resolve' | 'cancel' | 'other';

const filenames = fc
  .tuple(
    fc.constantFrom('account', 'expenses'),
    fc.date({ min: new Date('2020-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
    fc.nat(9999),
  )
  .map(([kind, date, n]) => {
    const ext = kind === 'account' ? 'json' : 'csv';
    return `project-money-${kind}-${date.toISOString().slice(0, 10)}-${n}.${ext}`;
  });

const contents = fc.oneof(
  fc.string({ minLength: 1, maxLength: 200 }),
  fc.uint8Array({ minLength: 1, maxLength: 200 }).map((bytes) => new Uint8Array(bytes)),
);

const shareOutcomes = fc.constantFrom<ShareOutcome>('resolve', 'cancel', 'other');

function rejectionFor(outcome: Exclude<ShareOutcome, 'resolve'>): Error {
  return new Error(outcome === 'cancel' ? 'Share canceled' : 'Unable to open share target');
}

describe('export write-then-share-then-cleanup properties', () => {
  beforeEach(() => {
    // Only timers are faked: FileReader inside saveAndShare must keep running on real scheduling.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Feature: android-app-release, Property 4: Export write-then-share always targets the written file, and the file is always cleaned up
  // **Validates: Requirements 4.1, 4.2**
  it('writes once, shares the written uri once after the write, and deletes the file after the grace period in every share outcome', async () => {
    await assertProperty(
      fc.asyncProperty(filenames, contents, shareOutcomes, async (filename, content, outcome) => {
        vi.clearAllTimers();
        mocks.writeFile.mockReset();
        mocks.deleteFile.mockReset();
        mocks.share.mockReset();
        const uri = `file:///data/cache/${filename}`;
        mocks.writeFile.mockResolvedValue({ uri });
        mocks.deleteFile.mockResolvedValue(undefined);
        if (outcome === 'resolve') mocks.share.mockResolvedValue({ activityType: 'x' });
        else mocks.share.mockRejectedValue(rejectionFor(outcome));

        const result = await saveAndShare(new Blob([content as BlobPart]), filename);

        expect(result.outcome).toBe(outcome === 'cancel' ? 'cancelled' : 'shared');
        expect(mocks.writeFile).toHaveBeenCalledTimes(1);
        expect(mocks.writeFile.mock.calls[0]?.[0]).toMatchObject({ path: filename, directory: 'CACHE' });
        expect(mocks.share).toHaveBeenCalledTimes(1);
        expect(mocks.share.mock.calls[0]?.[0]).toMatchObject({ url: uri });
        expect(mocks.writeFile.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(mocks.share.mock.invocationCallOrder[0] ?? -1);

        // The file stays available to the share target for the whole grace period.
        await vi.advanceTimersByTimeAsync(EXPORT_CLEANUP_GRACE_MS - 1);
        expect(mocks.deleteFile).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
        expect(mocks.deleteFile).toHaveBeenCalledWith({ path: filename, directory: 'CACHE' });

        // Nothing further is scheduled once the file is deleted.
        await vi.advanceTimersByTimeAsync(EXPORT_CLEANUP_GRACE_MS * 2);
        expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
      }),
    );
  });
});
