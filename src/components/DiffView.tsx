import { diffLines } from "diff";

export default function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre
      style={{
        fontSize: 12,
        background: "#1a1a1a",
        borderRadius: 6,
        padding: 8,
        overflowX: "auto",
        margin: "6px 0",
        maxHeight: 300,
      }}
    >
      {parts.map((part, i) => (
        <div
          key={i}
          style={{
            background: part.added ? "#123d1a" : part.removed ? "#3d1414" : "transparent",
            color: part.added ? "#8fdb8f" : part.removed ? "#db8f8f" : "#bbb",
          }}
        >
          {part.value
            .replace(/\n$/, "")
            .split("\n")
            .map((line, j) => (
              <div key={j}>
                {part.added ? "+ " : part.removed ? "- " : "  "}
                {line}
              </div>
            ))}
        </div>
      ))}
    </pre>
  );
}
