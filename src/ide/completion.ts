import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import doneSound from "../assets/fish-done.m4a";

let audio: HTMLAudioElement | null = null;
let permissionChecked = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return true;
  let granted = await isPermissionGranted();
  if (!granted) {
    const res = await requestPermission();
    granted = res === "granted";
  }
  permissionChecked = true;
  return granted;
}

/// Plays the completion chime and fires a native macOS notification. Call
/// this once a turn finishes, whether it ended in success, an error, or a
/// dropped connection — but not on a manual user-initiated Stop, since the
/// user is already watching in that case.
export async function notifyTaskDone(title: string, body: string) {
  try {
    if (!audio) audio = new Audio(doneSound);
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // autoplay can be blocked before the user has interacted with the
    // window at all; nothing useful to do beyond skipping the sound
  }

  try {
    const granted = await ensurePermission();
    if (granted) sendNotification({ title, body });
  } catch {
    // notification plugin unavailable — sound-only fallback is fine
  }
}
