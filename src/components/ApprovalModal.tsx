import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DiffView from "./DiffView";
import { t, dir as uiDir, useLang } from "../ide/i18n";
import { useModalOpen } from "../ide/modalTracker";

export type PendingApproval = {
  toolName: string;
  args: any;
  workspace: string;
  resolve: (approved: boolean) => void;
};

export default function ApprovalModal({
  pending,
  onDecide,
}: {
  pending: PendingApproval;
  onDecide: (approved: boolean) => void;
}) {
  useLang();
  useModalOpen(true);
  const [oldContent, setOldContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (pending.toolName === "write_file") {
      invoke<string>("read_file", { workspace: pending.workspace, path: pending.args.path })
        .then((c) => !cancelled && setOldContent(c))
        .catch(() => !cancelled && setOldContent(""));
    }
    return () => {
      cancelled = true;
    };
  }, [pending]);

  return (
    <div className="modal-overlay">
      <div className="modal" dir={uiDir()} style={{ width: 560, maxHeight: "80vh", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0 }}>
          {pending.toolName === "run_command"
            ? t("approvalShell")
            : pending.toolName === "delete_file"
            ? t("approvalDelete")
            : pending.toolName === "move_file"
            ? t("approvalMove")
            : ["generate_image", "generate_audio", "generate_video", "speak_text"].includes(pending.toolName)
            ? t("approvalGenerate")
            : ["browser_navigate", "browser_close"].includes(pending.toolName)
            ? t("approvalBrowser")
            : pending.toolName === "call_model"
            ? t("approvalCallModel")
            : t("approvalEdit")}
        </h3>

        {pending.toolName === "run_command" && (
          <pre
            dir="ltr"
            style={{
              background: "var(--bg-0)",
              padding: 10,
              borderRadius: 8,
              fontSize: 13,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {pending.args.cmd}
          </pre>
        )}

        {(pending.toolName === "delete_file" || pending.toolName === "move_file") && (
          <pre dir="ltr" style={{ background: "var(--bg-0)", padding: 10, borderRadius: 8, fontSize: 13 }}>
            {pending.toolName === "delete_file"
              ? `delete: ${pending.args.path}`
              : `move: ${pending.args.from} → ${pending.args.to}`}
          </pre>
        )}

        {pending.toolName === "edit_file" && (
          <>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 4 }}>{pending.args.path}</div>
            <DiffView before={pending.args.old_string ?? ""} after={pending.args.new_string ?? ""} />
          </>
        )}

        {["generate_image", "generate_audio", "generate_video", "speak_text"].includes(pending.toolName) && (
          <pre dir="ltr" style={{ background: "var(--bg-0)", padding: 10, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
            "{pending.args.prompt ?? pending.args.text}" → {pending.args.path}
          </pre>
        )}

        {pending.toolName === "browser_navigate" && (
          <pre dir="ltr" style={{ background: "var(--bg-0)", padding: 10, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
            {pending.args.tab_id ? `tab ${pending.args.tab_id}` : "active tab"} → {pending.args.url}
          </pre>
        )}
        {pending.toolName === "browser_close" && (
          <pre dir="ltr" style={{ background: "var(--bg-0)", padding: 10, borderRadius: 8, fontSize: 13 }}>
            close: {pending.args.tab_id ? `tab ${pending.args.tab_id}` : "active tab"}
          </pre>
        )}

        {pending.toolName === "call_model" && (
          <pre dir="ltr" style={{ background: "var(--bg-0)", padding: 10, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
            {pending.args.provider_id}/{pending.args.model}:{"\n"}"{pending.args.prompt}"
          </pre>
        )}

        {pending.toolName === "write_file" && (
          <>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 4 }}>{pending.args.path}</div>
            {oldContent === null ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>{t("loadingCurrent")}</div>
            ) : (
              <DiffView before={oldContent} after={pending.args.content ?? ""} />
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={() => onDecide(false)}>{t("reject")}</button>
          <button className="primary" onClick={() => onDecide(true)}>
            {t("approve")}
          </button>
        </div>
      </div>
    </div>
  );
}
