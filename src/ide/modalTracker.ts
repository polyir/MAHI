// Lets BrowserTabView.tsx know whether ANY modal is currently open anywhere
// in the app, without prop-drilling through App.tsx/ChatPanel.tsx/EditorArea
// (modals live in several different branches of the component tree). A
// native child webview always paints above regular DOM content regardless
// of CSS z-index — the only way to keep it from covering a modal is to
// explicitly hide it while one is open. Each modal component calls
// useModalOpen(true) unconditionally at its own top level; since every
// modal is only ever rendered while open (the `{show && <Modal />}`
// pattern used throughout this app), mount/unmount alone is enough to
// track this correctly with no other wiring.
import { useEffect } from "react";

let openCount = 0;
const listeners = new Set<(open: boolean) => void>();

export function useModalOpen(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    openCount++;
    if (openCount === 1) listeners.forEach((l) => l(true));
    return () => {
      openCount--;
      if (openCount === 0) listeners.forEach((l) => l(false));
    };
  }, [open]);
}

export function subscribeAnyModalOpen(cb: (open: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
