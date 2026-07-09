import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { absolutePath } from "../fileKind";
import { t } from "../i18n";

// Streamed via the asset:// protocol (convertFileSrc) rather than read into
// JS as base64 — large audio/video files would otherwise have to round-trip
// the whole file through the IPC channel as one giant string.
export default function MediaPreview({
  workspace,
  path,
  kind,
  cacheBust,
}: {
  workspace: string;
  path: string;
  kind: "audio" | "video";
  cacheBust?: number;
}) {
  const [error, setError] = useState(false);
  const base = convertFileSrc(absolutePath(workspace, path));
  const src = cacheBust ? `${base}?v=${cacheBust}` : base;

  if (error) {
    return <div style={{ padding: 14, fontSize: 12.5, opacity: 0.6 }}>{t("openError")}</div>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 20 }}>
      {kind === "audio" ? (
        <audio key={src} controls src={src} onError={() => setError(true)} style={{ width: "100%", maxWidth: 480 }} />
      ) : (
        <video
          key={src}
          controls
          src={src}
          onError={() => setError(true)}
          style={{ maxWidth: "100%", maxHeight: "100%" }}
        />
      )}
    </div>
  );
}
