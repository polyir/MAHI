// Local tracking of Sakana's usage windows (5-hour rolling + weekly).
//
// Honesty model:
// - Token counts are REAL: every API response reports exact usage and we log
//   it here. But they only cover requests made through MAHI, and the provider
//   weights input/output/cached/orchestration differently — so percentages
//   derived from them are estimates.
// - Reset times are near-real: 429 errors carry the exact reset timestamp
//   (we snap to it), the 5h window is otherwise inferred from the first
//   request after an idle gap, and the weekly window follows a fixed
//   schedule (observed: Monday 03:00 local).
// - Percentages appear only after a ONE-TIME calibration where the user
//   copies the current % from console.sakana.ai/billing. No recurring
//   recalibration: capacity per plan is stable.

const EVENTS_KEY = "mahi_usage_events"; // [{t:number, tok:number}]
const RESET_5H_KEY = "mahi_reset_5h_exact"; // ISO string from a 429
const CAP_5H_KEY = "mahi_capacity_5h"; // tokens (from calibration)
const CAP_WEEK_KEY = "mahi_capacity_week";

const FIVE_H = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

type UsageEvent = { t: number; tok: number };

function loadEvents(): UsageEvent[] {
  try {
    return JSON.parse(localStorage.getItem(EVENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function recordUsage(totalTokens: number) {
  if (!totalTokens) return;
  const now = Date.now();
  const events = loadEvents().filter((e) => now - e.t < WEEK + FIVE_H);
  events.push({ t: now, tok: totalTokens });
  localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
}

/// Called when a 429 reveals the exact reset moment of a window.
export function reportRateLimitReset(resetAt: Date) {
  const delta = resetAt.getTime() - Date.now();
  if (delta > 0 && delta <= FIVE_H + 10 * 60 * 1000) {
    // belongs to the 5-hour window
    localStorage.setItem(RESET_5H_KEY, resetAt.toISOString());
  }
}

export function setCalibration(window: "5h" | "week", usedTokens: number, pct: number) {
  if (pct <= 0 || pct > 100) return;
  const capacity = Math.round(usedTokens / (pct / 100));
  localStorage.setItem(window === "5h" ? CAP_5H_KEY : CAP_WEEK_KEY, String(capacity));
}

/// Most recent Monday 03:00 local time (observed weekly reset schedule).
function lastWeeklyAnchor(now: Date): Date {
  const d = new Date(now);
  d.setHours(3, 0, 0, 0);
  // getDay(): Monday = 1
  let back = (d.getDay() + 6) % 7; // days since Monday
  if (d.getTime() > now.getTime()) back = back === 0 ? 6 : back; // anchor in future → step back
  d.setDate(d.getDate() - back);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

export type WindowStat = {
  usedTokens: number;
  resetAt: Date | null;
  pct: number | null; // null until calibrated
  exact: boolean; // reset time came from a 429 (true) or inference (false)
};

export function getWindows(now = new Date()): { fiveHour: WindowStat; weekly: WindowStat } {
  const events = loadEvents();
  const nowMs = now.getTime();

  // --- 5-hour rolling window: starts at the first request made while no
  // window was active; each event beyond start+5h opens a new window.
  let windowStart: number | null = null;
  for (const e of events) {
    if (windowStart === null || e.t >= windowStart + FIVE_H) windowStart = e.t;
  }
  let fiveUsed = 0;
  let fiveReset: Date | null = null;
  let exact = false;
  if (windowStart !== null && nowMs < windowStart + FIVE_H) {
    fiveUsed = events.filter((e) => e.t >= windowStart!).reduce((s, e) => s + e.tok, 0);
    fiveReset = new Date(windowStart + FIVE_H);
    const stored = localStorage.getItem(RESET_5H_KEY);
    if (stored) {
      const t = Date.parse(stored);
      if (!Number.isNaN(t) && t > nowMs && t < windowStart + FIVE_H + 30 * 60 * 1000) {
        fiveReset = new Date(t);
        exact = true;
      }
    }
  }
  const cap5 = Number(localStorage.getItem(CAP_5H_KEY)) || 0;

  // --- weekly window: fixed schedule.
  const anchor = lastWeeklyAnchor(now);
  const weekUsed = events.filter((e) => e.t >= anchor.getTime()).reduce((s, e) => s + e.tok, 0);
  const weekReset = new Date(anchor.getTime() + WEEK);
  const capW = Number(localStorage.getItem(CAP_WEEK_KEY)) || 0;

  return {
    fiveHour: {
      usedTokens: fiveUsed,
      resetAt: fiveReset,
      pct: cap5 > 0 ? Math.min(100, Math.round((fiveUsed / cap5) * 100)) : null,
      exact,
    },
    weekly: {
      usedTokens: weekUsed,
      resetAt: weekReset,
      pct: capW > 0 ? Math.min(100, Math.round((weekUsed / capW) * 100)) : null,
      exact: false,
    },
  };
}

export function formatCountdown(resetAt: Date | null, now = new Date()): string {
  if (!resetAt) return "—";
  let s = Math.max(0, Math.floor((resetAt.getTime() - now.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
}
