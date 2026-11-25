import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: true,
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  readdir: vi.fn(),
  share: vi.fn(),
  pluginFactoryRuns: 0,
}));

vi.mock('../platform', () => ({ isNativePlatform: () => mocks.native }));
vi.mock('@capacitor/filesystem', () => {
  mocks.pluginFactoryRuns += 1;
  return {
    Directory: { Cache: 'CACHE' },
    Filesystem: { writeFile: mocks.writeFile, deleteFile: mocks.deleteFile, readdir: mocks.readdir },
  };
});
vi.mock('@capacitor/share', () => {
  mocks.pluginFactoryRuns += 1;
  return { Share: { share: mocks.share } };
});

import { EXPORT_CLEANUP_GRACE_MS, saveAndShare, sweepStaleExportFiles } from './exportFile';

const files = (...names: string[]) => ({ files: names.map((name) => ({ name, type: 'file', size: 1, mtime: 0, uri: name })) });

beforeEach(() => {
  mocks.native = true;
  mocks.pluginFactoryRuns = 0;
  for (const fn of [mocks.writeFile, mocks.deleteFile, mocks.readdir, mocks.share]) fn.mockReset();
  mocks.deleteFile.mockResolvedValue(undefined);
});

describe('sweepStaleExportFiles', () => {
  it('deletes only export files that match the naming pattern and leaves other cache files alone', async () => {
    mocks.readdir.mockResolvedValue(files(
      'project-money-account-2025-01-02.json',
      'project-money-expenses-2025-01-02.csv',
      'project-money-account-2025-01-02.csv',
      'project-money-expenses-2025-01-02.json',
      'project-money-budget-2025-01-02.csv',
      'project-money-account-2025-01-02.txt',
      'project-money-account-2025-01-02.json.bak',
      'my-project-money-account-2025-01-02.json',
      'image_cache.png',
      'other.json',
    ));

    await sweepStaleExportFiles();

    expect(mocks.readdir).toHaveBeenCalledWith({ path: '', directory: 'CACHE' });
    const deleted = mocks.deleteFile.mock.calls.map(([arg]) => arg.path).sort();
    expect(deleted).toEqual([
      'project-money-account-2025-01-02.csv',
      'project-money-account-2025-01-02.json',
      'project-money-expenses-2025-01-02.csv',
      'project-money-expenses-2025-01-02.json',
    ]);
    for (const [arg] of mocks.deleteFile.mock.calls) expect(arg.directory).toBe('CACHE');
  });

  it('deletes nothing when the cache holds no export files', async () => {
    mocks.readdir.mockResolvedValue(files('a.png', 'b.txt'));
    await sweepStaleExportFiles();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('does not throw when listing the cache directory rejects', async () => {
    mocks.readdir.mockRejectedValue(new Error('Directory does not exist'));
    await expect(sweepStaleExportFiles()).resolves.toBeUndefined();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('does not throw and still tries every match when one deletion rejects', async () => {
    mocks.readdir.mockResolvedValue(files('project-money-account-1.json', 'project-money-expenses-1.csv'));
    mocks.deleteFile.mockRejectedValueOnce(new Error('File does not exist'));
    await expect(sweepStaleExportFiles()).resolves.toBeUndefined();
    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
  });
});

describe('saveAndShare on the web', () => {
  let click: Mock<(anchor: { href: string; download: string }) => void>;
  let createObjectURL: Mock<(blob: Blob) => string>;
  let revokeObjectURL: Mock<(url: string) => void>;

  beforeEach(() => {
    mocks.native = false;
    click = vi.fn<(anchor: { href: string; download: string }) => void>();
    createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mock-url');
    revokeObjectURL = vi.fn<(url: string) => void>();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      click({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('downloads through an anchor and never imports the Filesystem or Share plugins', async () => {
    vi.resetModules();
    mocks.pluginFactoryRuns = 0;
    const { saveAndShare: freshSaveAndShare } = await import('./exportFile');
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });

    const result = await freshSaveAndShare(blob, 'project-money-expenses-2025-01-02.csv');

    expect(result).toEqual({ outcome: 'downloaded' });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledWith({ href: 'blob:mock-url', download: 'project-money-expenses-2025-01-02.csv' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(mocks.pluginFactoryRuns).toBe(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});

describe('saveAndShare when writing fails', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('returns failed, does not share, and schedules no cleanup', async () => {
    mocks.writeFile.mockRejectedValue(new Error('No space left on device'));

    const result = await saveAndShare(new Blob(['data']), 'project-money-account-2025-01-02.json');

    expect(result).toEqual({ outcome: 'failed' });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(EXPORT_CLEANUP_GRACE_MS * 2);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('reports shared for a successful share and deletes the file only after the grace period', async () => {
    mocks.writeFile.mockResolvedValue({ uri: 'file:///cache/project-money-account-2025-01-02.json' });
    mocks.share.mockResolvedValue({});

    const result = await saveAndShare(new Blob(['data']), 'project-money-account-2025-01-02.json');

    expect(result).toEqual({ outcome: 'shared' });
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ url: 'file:///cache/project-money-account-2025-01-02.json' }));
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EXPORT_CLEANUP_GRACE_MS);
    expect(mocks.deleteFile).toHaveBeenCalledWith({ path: 'project-money-account-2025-01-02.json', directory: 'CACHE' });
  });
});
