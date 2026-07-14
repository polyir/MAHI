import { invoke } from "@tauri-apps/api/core";

export type WindowVisionCapabilities = {
  supported: boolean;
  permissionGranted: boolean;
  pickerSupported: boolean;
};

export type WindowVisionWindow = {
  windowId: number;
  title: string;
  bundleId: string;
  applicationName: string;
  processId: number;
  displayId?: number;
  role: "main" | "dialog" | "panel" | "unknown";
  isOnScreen: boolean;
  isActive: boolean;
  frame: { x: number; y: number; width: number; height: number };
};

export type WindowVisionSession = {
  status: string;
  sessionId: string;
  revision: number;
  changed: boolean;
  changeScore: number;
  width: number;
  height: number;
  lastFrameAt: string;
  imagePath: string;
  error?: string;
  metadata: {
    mode?: string;
    bundleId?: string;
    bundleIds?: string[];
    windowId?: number;
    windowIds?: number[];
    title?: string;
    role?: string;
    displayId?: number;
  };
};

export const STUDIO_WINDOW_BUNDLES: Record<string, string> = {
  "studio-premiere": "com.adobe.PremierePro",
  "studio-photoshop": "com.adobe.Photoshop",
  "studio-afterfx": "com.adobe.AfterEffects.application",
  "studio-obs": "com.obsproject.obs-studio",
};

export async function windowVisionCapabilities(): Promise<WindowVisionCapabilities> {
  return invoke("window_vision_capabilities");
}

export async function requestWindowVisionPermission(): Promise<{ granted: boolean }> {
  return invoke("window_vision_request_permission");
}

export async function allowedWindowVisionApps(): Promise<string[]> {
  const result = await invoke<{ bundleIds: string[] }>("window_vision_allowed_apps");
  return result.bundleIds;
}

export async function presentWindowVisionPicker(captureMode: "window" | "display" = "window"): Promise<{ status: string; sessionId: string; error?: string }> {
  return invoke("window_vision_present_picker", { captureMode });
}

export async function pollWindowVisionPicker(sessionId: string): Promise<any> {
  return invoke("window_vision_picker_result", { sessionId });
}

export async function waitForWindowVisionPicker(
  sessionId: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<any> {
  const started = Date.now();
  while (!signal?.aborted && Date.now() - started < timeoutMs) {
    const result = await pollWindowVisionPicker(sessionId);
    if (!["pending", "starting"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (signal?.aborted) throw new DOMException("Picker wait cancelled", "AbortError");
  throw new Error("Window picker timed out");
}

export async function removeAllowedWindowVisionApp(bundleId: string): Promise<void> {
  await invoke("window_vision_remove_allowed_app", { bundleId });
}

export async function listAllowedWindows(): Promise<WindowVisionWindow[]> {
  const result = await invoke<{ windows: WindowVisionWindow[] }>("window_vision_list_allowed_windows");
  return result.windows;
}

export async function listWindowVisionSessions(): Promise<WindowVisionSession[]> {
  const result = await invoke<{ sessions: WindowVisionSession[] }>("window_vision_sessions");
  return result.sessions;
}

export async function observeApplication(args: {
  sessionId: string;
  bundleId: string;
  windowId?: number;
  titleContains?: string;
  role?: string;
  includeCursor?: boolean;
  fps?: number;
  threshold?: number;
}): Promise<WindowVisionSession | any> {
  return invoke("window_vision_observe_app", args);
}

export async function observeWindowGroup(args: {
  sessionId: string;
  displayId: number;
  windowIds: number[];
  includeCursor?: boolean;
  fps?: number;
  threshold?: number;
}): Promise<WindowVisionSession | any> {
  return invoke("window_vision_start_group", args);
}

export async function captureObservedWindow(sessionId: string, sinceRevision = 0): Promise<WindowVisionSession> {
  return invoke("window_vision_capture", { sessionId, sinceRevision });
}

export async function waitForObservedWindowChange(
  sessionId: string,
  afterRevision: number,
  timeoutMs = 3000,
): Promise<WindowVisionSession> {
  return invoke("window_vision_wait_for_change", { sessionId, afterRevision, timeoutMs });
}

export async function stopWindowObservation(sessionId: string): Promise<any> {
  return invoke("window_vision_stop", { sessionId });
}

export async function stopAllWindowObservations(): Promise<any> {
  return invoke("window_vision_stop_all");
}

export async function detectWindowDialogs(bundleId: string, knownWindowIds: number[]): Promise<WindowVisionWindow[]> {
  const result = await invoke<{ windows: WindowVisionWindow[] }>("window_vision_detect_dialogs", {
    bundleId,
    knownWindowIds,
  });
  return result.windows;
}

export async function prepareStudioVerification(bundleId: string): Promise<WindowVisionSession | null> {
  try {
    const result = await invoke<WindowVisionSession | any>("window_vision_auto_prepare", { bundleId });
    if (result.status !== "active" && result.status !== "stale") return null;
    const baseline = await captureObservedWindow(result.sessionId, 0);
    return baseline.revision > 0 && baseline.imagePath ? baseline : null;
  } catch {
    return null;
  }
}

export async function finishStudioVerification(
  baseline: WindowVisionSession | null,
  timeoutMs = 3000,
): Promise<WindowVisionSession | null> {
  if (!baseline?.sessionId) return null;
  try {
    return await waitForObservedWindowChange(baseline.sessionId, baseline.revision ?? 0, timeoutMs);
  } catch {
    return null;
  }
}

export async function watchForNewDialogSessions(
  bundleId: string,
  initialWindowIds: number[],
  signal: AbortSignal,
): Promise<WindowVisionSession[]> {
  const known = new Set(initialWindowIds);
  const sessions: WindowVisionSession[] = [];
  while (!signal.aborted) {
    try {
      const dialogs = await detectWindowDialogs(bundleId, [...known]);
      for (const dialog of dialogs) {
        known.add(dialog.windowId);
        const session = await observeApplication({
          sessionId: `dialog_${dialog.windowId}_${Date.now()}`,
          bundleId,
          windowId: dialog.windowId,
          role: dialog.role,
          fps: 2,
        });
        if (session.status === "active" || session.status === "stale") sessions.push(session);
      }
    } catch {
      // A transient registry refresh failure must not fail the underlying MCP action.
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return sessions;
}
