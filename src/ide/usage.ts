// Parses real rate-limit / usage information out of the HTTP response headers
// returned by the Sakana API. We do NOT invent any numbers: if the API doesn't
// send a header, we don't show a value.

export type UsageWindow = {
  label: string;
  limit?: number;
  remaining?: number;
  used?: number;
  usedPct?: number;
  reset?: string; // human-readable
};

export type ParsedUsage = {
  windows: UsageWindow[];
  raw: Record<string, string>; // every rate-limit-ish header, verbatim
};

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// Reset values come in different shapes across providers: unix seconds/ms,
// an ISO date, or a duration like "3600s" / "2h30m". Normalize to a readable
// absolute time when possible.
function humanizeReset(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();

  // ISO date
  const iso = Date.parse(trimmed);
  if (!Number.isNaN(iso) && /[-:T]/.test(trimmed)) {
    return new Date(iso).toLocaleString();
  }

  // pure number => epoch seconds or ms
  if (/^\d+$/.test(trimmed)) {
    let n = Number(trimmed);
    if (n > 1e12) n = n; // ms
    else if (n > 1e9) n = n * 1000; // epoch seconds
    else {
      // small number => seconds-from-now duration
      const d = new Date(Date.now() + Number(trimmed) * 1000);
      return d.toLocaleString();
    }
    return new Date(n).toLocaleString();
  }

  // duration like 2h30m15s or 3600s
  const m = trimmed.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/);
  if (m && (m[1] || m[2] || m[3])) {
    const secs = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
    return new Date(Date.now() + secs * 1000).toLocaleString();
  }

  return trimmed;
}

const RATE_RE = /rate.?limit|ratelimit|reset|remaining|(^|[-_])limit|usage|quota/i;

export function parseUsage(headers: Record<string, string>): ParsedUsage {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(lower)) {
    if (RATE_RE.test(k)) raw[k] = v;
  }

  // Group headers by their window suffix so "5h"/"weekly"/"tokens"/"requests"
  // each become one window row. We look at the token after the last dash.
  const groups = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(raw)) {
    const parts = k.split(/[-_]/);
    const suffix = parts[parts.length - 1];
    const kind = parts.find((p) => /limit|remaining|reset|used|usage/.test(p)) ?? "value";
    const key = suffix === kind ? "general" : suffix;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)![kind] = v;
  }

  const windows: UsageWindow[] = [];
  for (const [key, g] of groups) {
    const limit = num(g["limit"]);
    const remaining = num(g["remaining"]);
    let used = num(g["used"]) ?? num(g["usage"]);
    if (used === undefined && limit !== undefined && remaining !== undefined) {
      used = limit - remaining;
    }
    const usedPct =
      limit && used !== undefined ? Math.round((used / limit) * 100) : undefined;
    windows.push({
      label: key,
      limit,
      remaining,
      used,
      usedPct,
      reset: humanizeReset(g["reset"]),
    });
  }

  return { windows: windows.filter((w) => w.limit || w.remaining || w.reset), raw };
}
