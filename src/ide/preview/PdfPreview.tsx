import { convertFileSrc } from "@tauri-apps/api/core";
import { absolutePath } from "../fileKind";

export default function PdfPreview({ workspace, path }: { workspace: string; path: string }) {
  const src = convertFileSrc(absolutePath(workspace, path));
  // WKWebView (and Chromium) render PDFs natively via <embed>; no extra
  // library needed. Streamed via asset:// so large PDFs aren't read into
  // JS as base64.
  return <embed key={src} src={src} type="application/pdf" style={{ width: "100%", height: "100%", border: "none" }} />;
}
