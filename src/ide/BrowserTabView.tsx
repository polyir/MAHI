import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export type BrowserTab = { id: string; url: string; title: string };

// Hosts one native child webview (a real OS-level surface, not a DOM
// element). All open browser tabs stay mounted for their whole lifetime —
// only the active one's webview is shown (via show/hide, not
// create/destroy) so switching tabs preserves each one's session/history.
// No toolbar lives inside this component — the address bar and tab strip
// are rendered by EditorArea below the content area, since Tauri's
// experimental multiwebview positioning can extend a wide child webview
// upward past its intended top edge, covering whatever sits above it.
export default function BrowserTabView({ tab, isActive }: { tab: BrowserTab; isActive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);

  function reportRect() {
    if (!isActive) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { x, y, width, height } = rect;
    if (!openedRef.current) {
      openedRef.current = true;
      invoke("browser_open", { tabId: tab.id, url: tab.url, x, y, width, height }).catch(() => {});
    } else {
      invoke("browser_reposition", { tabId: tab.id, x, y, width, height }).catch(() => {});
    }
  }

  // Toggle the native webview's visibility to match whether this tab is the
  // one currently on screen.
  useEffect(() => {
    if (isActive) {
      reportRect();
    } else if (openedRef.current) {
      invoke("browser_hide", { tabId: tab.id }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // react-resizable-panels can settle into its final pixel size a beat
    // after the first paint; re-check a few times shortly after becoming
    // active to catch that late settling, on top of resize-driven reports.
    const timeouts = [50, 150, 400, 800].map((ms) => setTimeout(reportRect, ms));
    const observer = new ResizeObserver(() => reportRect());
    observer.observe(el);
    window.addEventListener("resize", reportRect);
    return () => {
      timeouts.forEach(clearTimeout);
      observer.disconnect();
      window.removeEventListener("resize", reportRect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only tears down the native webview when this tab is actually closed
  // (component unmounts because it was removed from the tabs array).
  useEffect(() => {
    return () => {
      invoke("browser_close", { tabId: tab.id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ display: isActive ? "block" : "none", height: "100%" }} />;
}
