import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export default function TerminalPanel({ workspace }: { workspace: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: { background: "#141414", foreground: "#e0e0e0" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    let ptyId: string | null = null;
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;

    (async () => {
      const id = await invoke<string>("pty_spawn", {
        workspace,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) {
        invoke("pty_kill", { id }).catch(() => {});
        return;
      }
      ptyId = id;

      unlistenData = await listen<string>(`pty://data/${id}`, (e) => {
        term.write(e.payload);
      });
      unlistenExit = await listen(`pty://exit/${id}`, () => {
        term.write("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
      });

      term.onData((data) => {
        invoke("pty_write", { id, data }).catch(() => {});
      });
    })();

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ptyId) invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {
        // ignore fit errors during teardown
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      term.dispose();
    };
  }, [workspace]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%", background: "#141414", padding: 4 }} />;
}
