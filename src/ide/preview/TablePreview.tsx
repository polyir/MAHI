const MAX_ROWS = 2000;

/// Minimal RFC4180-ish parser: handles quoted fields, embedded delimiters/
/// newlines inside quotes, and "" as an escaped quote. Dependency-free by
/// design (no papaparse) to match the project's low-dependency style.
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export default function TablePreview({ content, delimiter }: { content: string; delimiter: "," | "\t" }) {
  const rows = parseDelimited(content, delimiter);
  if (rows.length === 0) {
    return <div style={{ padding: 14, fontSize: 12.5, opacity: 0.6 }}>empty</div>;
  }
  const [header, ...body] = rows;
  const shown = body.slice(0, MAX_ROWS);
  const truncated = body.length - shown.length;

  return (
    <div dir="ltr" className="table-preview" style={{ overflow: "auto", height: "100%" }}>
      <table>
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>
              {header.map((_, ci) => (
                <td key={ci}>{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated > 0 && (
        <div style={{ padding: 8, fontSize: 11.5, opacity: 0.6 }}>{truncated} more rows truncated</div>
      )}
    </div>
  );
}
