import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribeAnyModalOpen } from "./modalTracker";

// Generous fixed safety margin, taller than the address bar itself: Tauri's
// child-webview positioning has a real, historical quirk (documented in the
// original pre-iframe implementation) where a wide webview's rendered
// content can bleed a bit past its assigned top edge, upward into whatever
// sits directly above it. Reporting the container's rect with the top
// pushed down by this much (and the height shrunk by the same amount, so
// the bottom edge stays anchored — no gap introduced there) gives that
// bleed somewhere harmless to land instead of over the address bar. This
// is a margin, not a coordinate-space conversion — no window/title-bar
// size math needed.
const TOP_SAFETY_MARGIN = 40;

export type BrowserTab = { id: string; url: string; title: string };

// Hosts one native child webview (a real OS-level surface, not a DOM
// element) — restored from the pre-iframe implementation (see git history:
// deleted at bee5a4f, "Switch embedded browser to iframe... fixes it
// rendering above modals"). Native child webviews always paint above the
// window's own DOM content regardless of CSS z-index, which is exactly
// what caused that bug — this version fixes it properly instead of
// avoiding the whole approach: it's shown only while both this tab is
// active AND no modal is currently open anywhere in the app (see
// modalTracker.ts), so it never has a chance to cover one.
//
// All open browser tabs stay mounted for their whole lifetime — only the
// visible one's webview is shown (via show/hide, not create/destroy) so
// switching tabs preserves each one's session/history.
//
// No toolbar lives inside this component — the address bar and tab strip
// are rendered by EditorArea above this component's own container, since
// Tauri's child-webview positioning has historically been able to extend a
// wide webview slightly past its intended top edge, covering whatever sits
// directly above it.
export default function BrowserTabView({ tab, isActive }: { tab: BrowserTab; isActive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const modalOpenRef = useRef(false);
  const lastUrlRef = useRef(tab.url);

  function shouldShow() {
    return isActive && !modalOpenRef.current;
  }

  function reportRect() {
    if (!shouldShow()) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Confirmed empirically (Retina/dpr=2): browser.rs's add_child/
    // set_position/set_size take physical pixels, not logical — passing
    // raw logical values (rect.*) rendered the webview at roughly half its
    // intended size. Converting with devicePixelRatio here is the fix.
    const dpr = window.devicePixelRatio || 1;
    const x = rect.x * dpr;
    const y = (rect.y + TOP_SAFETY_MARGIN) * dpr;
    const width = rect.width * dpr;
    const height = Math.max(0, rect.height - TOP_SAFETY_MARGIN) * dpr;
    if (!openedRef.current) {
      openedRef.current = true;
      invoke("browser_open", { tabId: tab.id, url: tab.url, x, y, width, height }).catch(() => {
        // The webview never actually got created (or was torn down before
        // this resolved, e.g. StrictMode's dev-only synthetic
        // mount/unmount/remount — see the close-effect below) — un-flip the
        // flag so the next reportRect() retries browser_open instead of
        // reposition-ing a webview that was never really there.
        openedRef.current = false;
      });
    } else {
      invoke("browser_reposition", { tabId: tab.id, x, y, width, height }).catch(() => {
        openedRef.current = false;
      });
    }
  }

  function applyVisibility() {
    if (shouldShow()) {
      reportRect();
    } else if (openedRef.current) {
      invoke("browser_hide", { tabId: tab.id }).catch(() => {});
    }
  }

  // Toggle the native webview's visibility to match whether this tab is the
  // one currently on screen.
  useEffect(() => {
    applyVisibility();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Unlike an iframe's `src`, a native webview doesn't re-navigate just
  // because a prop changed — the address bar (EditorArea's goAddress) and
  // the agent's browser_navigate tool both only update `tab.url` in React
  // state (see App.tsx's navigateBrowserTab/agentBrowserNavigate), so this
  // is what actually turns that state change into a real navigation.
  useEffect(() => {
    if (openedRef.current && tab.url !== lastUrlRef.current) {
      invoke("browser_navigate", { tabId: tab.id, url: tab.url }).catch(() => {});
    }
    lastUrlRef.current = tab.url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.url]);

  // Any modal opening anywhere in the app hides this tab's webview (a
  // native child webview always paints above regular DOM content, so this
  // is the only way to keep it from covering a modal); it reappears the
  // moment the last open modal closes.
  useEffect(() => {
    return subscribeAnyModalOpen((open) => {
      modalOpenRef.current = open;
      applyVisibility();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // (component unmounts because it was removed from the tabs array) — but
  // also fires once synthetically on every mount under React StrictMode
  // (dev-only mount/cleanup/re-mount to surface effect bugs). Without
  // resetting openedRef here, that synthetic cleanup destroys the real
  // webview while the ref still claims it's open, so every reportRect()
  // afterwards calls browser_reposition on a webview that no longer exists
  // (fails with "browser not open") instead of ever calling browser_open
  // again — the tab silently never renders anything, forever.
  useEffect(() => {
    return () => {
      openedRef.current = false;
      invoke("browser_close", { tabId: tab.id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ display: isActive ? "block" : "none", height: "100%" }} />;
}
