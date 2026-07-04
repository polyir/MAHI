// Per-file content direction: separate from the global UI language direction
// in ide/i18n.ts (isRTL()/dir()), which only reflects the interface language,
// not the direction a given file's own text should render in.

const RTL_RANGE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_RANGE = /[A-Za-z]/;

/// Scan a sample of the content and guess its direction by counting RTL vs
/// LTR letters. Falls back to "ltr" when there's not enough signal.
export function detectDirection(sample: string): "rtl" | "ltr" {
  const slice = sample.slice(0, 2000);
  let rtl = 0;
  let ltr = 0;
  for (const ch of slice) {
    if (RTL_RANGE.test(ch)) rtl++;
    else if (LTR_RANGE.test(ch)) ltr++;
    if (rtl + ltr >= 500) break;
  }
  const total = rtl + ltr;
  if (total === 0) return "ltr";
  return rtl / total > 0.3 ? "rtl" : "ltr";
}

const OVERRIDE_KEY_PREFIX = "mahi_dir_override_";

export function getDirOverride(path: string): "rtl" | "ltr" | null {
  const v = localStorage.getItem(OVERRIDE_KEY_PREFIX + path);
  return v === "rtl" || v === "ltr" ? v : null;
}

export function setDirOverride(path: string, dir: "rtl" | "ltr" | null): void {
  const key = OVERRIDE_KEY_PREFIX + path;
  if (dir) localStorage.setItem(key, dir);
  else localStorage.removeItem(key);
}

export function resolveDirection(path: string, content: string): "rtl" | "ltr" {
  return getDirOverride(path) ?? detectDirection(content);
}
