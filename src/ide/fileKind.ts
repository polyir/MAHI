// Extension-to-category map for the preview panel, mirroring the
// EXT_LANG/langForPath pattern in monacoSetup.ts but for "how should this
// file be previewed" rather than "which Monaco language mode applies".
export type FileKind = "text" | "markdown" | "json" | "csv" | "tsv" | "image" | "audio" | "video" | "pdf";

export const EXT_KIND: Record<string, FileKind> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  csv: "csv",
  tsv: "tsv",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  aac: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  // .avi/.mkv are deliberately excluded: WebKit's <video> element has no
  // built-in demuxer for those containers, so even a correctly-read file
  // would show a blank/broken player — a real browser limitation, not a
  // read/transport bug.
  pdf: "pdf",
};

export function kindForPath(path: string): FileKind {
  const name = path.split("/").pop() ?? "";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "text";
}

export function isBinaryKind(kind: FileKind): boolean {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "pdf";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  pdf: "application/pdf",
};

export function mimeForPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/// Absolute on-disk path for a workspace-relative file, as needed by
/// Tauri's convertFileSrc (asset:// protocol).
export function absolutePath(workspace: string, relPath: string): string {
  return `${workspace.replace(/\/+$/, "")}/${relPath}`;
}
