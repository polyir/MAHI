import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { loader } from "@monaco-editor/react";

// Serve Monaco's language workers from the app bundle (via Vite's ?worker
// imports) instead of a CDN, so the editor works fully offline inside Tauri.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

export const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  dockerfile: "dockerfile",
};

export function langForPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}
