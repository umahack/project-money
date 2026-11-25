import { isNativePlatform } from '../platform';

/**
 * Export_Share_Wrapper. On the web it keeps the existing blob + <a download>
 * behaviour. On the native platform it writes the file to the app cache
 * directory and opens the system share sheet. No storage permission is needed:
 * the cache directory is app-private and shared through the FileProvider.
 */
export interface ExportResult {
  outcome: 'downloaded' | 'shared' | 'cancelled' | 'failed';
}

/** Time the share target has to read the cached file before it is deleted. */
export const EXPORT_CLEANUP_GRACE_MS = 60_000;

/** Names of files this module writes to the cache directory. */
export const EXPORT_FILE_PATTERN = /^project-money-(account|expenses)-.*\.(json|csv)$/;

function downloadViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read export data'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

/** @capacitor/share (Android) rejects with "Share canceled" when the sheet is dismissed. */
function isShareCancellation(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '');
  return /cancel/i.test(message);
}

function scheduleCleanup(filename: string): void {
  setTimeout(() => {
    void (async () => {
      try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.deleteFile({ path: filename, directory: Directory.Cache });
      } catch {
        // Already gone or not deletable; the startup sweep retries on next launch.
      }
    })();
  }, EXPORT_CLEANUP_GRACE_MS);
}

export async function saveAndShare(blob: Blob, filename: string): Promise<ExportResult> {
  if (!isNativePlatform()) {
    downloadViaAnchor(blob, filename);
    return { outcome: 'downloaded' };
  }

  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    try {
      await Share.share({ url: uri, title: filename });
      scheduleCleanup(filename);
      return { outcome: 'shared' };
    } catch (shareError) {
      scheduleCleanup(filename);
      // A rejection that is not a dismissal still means the file was offered, so no false error toast.
      return isShareCancellation(shareError) ? { outcome: 'cancelled' } : { outcome: 'shared' };
    }
  } catch {
    return { outcome: 'failed' };
  }
}

/** Deletes export files left in the cache directory by an earlier run. Never throws. */
export async function sweepStaleExportFiles(): Promise<void> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { files } = await Filesystem.readdir({ path: '', directory: Directory.Cache });
    await Promise.all(
      files
        .filter((file) => EXPORT_FILE_PATTERN.test(file.name))
        .map((file) =>
          Filesystem.deleteFile({ path: file.name, directory: Directory.Cache }).catch(() => undefined),
        ),
    );
  } catch {
    // Listing the cache directory failed; nothing to sweep.
  }
}
