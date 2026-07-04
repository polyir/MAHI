import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export default function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const match = /language-(\w+)/.exec(className || "");
  const code = String(children).replace(/\n$/, "");
  if (!match) {
    return <code className="inline-code">{code}</code>;
  }
  return (
    <div dir="ltr">
      <SyntaxHighlighter
        language={match[1]}
        style={oneDark}
        customStyle={{ margin: "6px 0", borderRadius: 8, fontSize: 12.5 }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
