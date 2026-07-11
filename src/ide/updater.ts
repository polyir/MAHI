// Self-update: checks a static JSON manifest (hosted on our own server —
// see tauri.conf.json's plugins.updater.endpoints) for a newer signed
// release. Download and install are deliberately two separate steps (not
// Tauri's combined downloadAndInstall()): the download happens silently in
// the background as soon as a release is found, but the actual install —
// closing the app, swapping it in, reopening — only ever happens when the
// user explicitly clicks the "install" button. This is both the UX the user
// asked for (never surprise-close their work) and, as a side effect, gives
// each step its own success/failure signal instead of one opaque combined
// call — useful given install failures on macOS have been hard to diagnose
// blind (see VERSION_LOG.md's 1.0.6–1.0.9 entries).
import { check, Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateInfo = { version: string; notes?: string; update: Update };

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return { version: update.version, notes: update.body, update };
  } catch (e) {
    console.warn("update check failed:", e);
    return null;
  }
}

export async function downloadUpdate(
  update: Update,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      total = event.data.contentLength;
      onProgress?.(0, total);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, total);
    }
  });
}

// Only ever called from an explicit user click (see App.tsx's install
// button) — never automatically. Installs the already-downloaded update in
// place, then quits and reopens the app onto the new version.
export async function installDownloadedUpdate(update: Update): Promise<void> {
  await update.install();
  await relaunch();
}
