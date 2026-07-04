import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { absolutePath } from "../fileKind";
import { t } from "../i18n";

export default function ImagePreview({ workspace, path }: { workspace: string; path: string }) {
  const [error, setError] = useState(false);
  const src = convertFileSrc(absolutePath(workspace, path));

  if (error) {
    return <div style={{ padding: 14, fontSize: 12.5, opacity: 0.6 }}>{t("openError")}</div>;
  }
  return (
    <div className="image-preview">
      <img
        key={src}
        src={src}
        alt={path}
        onError={() => setError(true)}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
