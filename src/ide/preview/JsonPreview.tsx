import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function valueClass(v: Json): string {
  if (v === null) return "json-null";
  switch (typeof v) {
    case "string":
      return "json-string";
    case "number":
      return "json-number";
    case "boolean":
      return "json-bool";
    default:
      return "";
  }
}

function renderPrimitive(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

function JsonNode({
  value,
  label,
  path,
  expanded,
  toggle,
}: {
  value: Json;
  label: string | null;
  path: string;
  expanded: Set<string>;
  toggle: (path: string) => void;
}) {
  const isContainer = value !== null && typeof value === "object";
  if (!isContainer) {
    return (
      <div className="json-row" style={{ paddingInlineStart: 16 }}>
        {label !== null && <span className="json-key">{label}: </span>}
        <span className={valueClass(value)}>{renderPrimitive(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const open = expanded.has(path);
  const bracket = isArray ? ["[", "]"] : ["{", "}"];

  return (
    <div>
      <div className="json-row json-toggle" onClick={() => toggle(path)} style={{ paddingInlineStart: 4 }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label !== null && <span className="json-key">{label}: </span>}
        <span className="json-bracket">
          {bracket[0]}
          {!open && `${entries.length} ${isArray ? "items" : "keys"}${bracket[1]}`}
        </span>
      </div>
      {open && (
        <div style={{ paddingInlineStart: 16 }}>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              value={v}
              label={isArray ? null : k}
              path={`${path}.${k}`}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
          <div className="json-row json-bracket" style={{ opacity: 0.6 }}>
            {bracket[1]}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JsonPreview({
  content,
  onParseError,
}: {
  content: string;
  onParseError: () => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(content) as Json };
    } catch {
      return { ok: false as const, value: null };
    }
  }, [content]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["$"]));
  function toggle(path: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  useEffect(() => {
    if (!parsed.ok) onParseError();
  }, [parsed.ok]);

  if (!parsed.ok) {
    return null;
  }

  return (
    <div dir="ltr" className="json-preview" style={{ padding: "10px 14px", overflow: "auto", height: "100%", fontSize: 12.5 }}>
      <JsonNode value={parsed.value} label={null} path="$" expanded={expanded} toggle={toggle} />
    </div>
  );
}
