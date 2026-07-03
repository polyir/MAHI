import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Msg } from "../agent";
import ToolCallView from "./ToolCallView";
import { t } from "../ide/i18n";

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
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

export default function Message({ msg, workspace }: { msg: Msg; workspace: string }) {
  if (msg.role === "tool") {
    return <ToolCallView msg={msg} workspace={workspace} />;
  }

  if (msg.role === "user") {
    return (
      <div className="msg msg-user" dir="auto">
        {msg.content.split("\n\n[Attached file:")[0]}
        {msg.content.includes("[Attached file:") && (
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>{t("withAttachment")}</div>
        )}
      </div>
    );
  }

  // assistant
  if (!msg.content && msg.tool_calls?.length) return null; // tool-only step; cards follow

  return (
    <div className="msg msg-assistant" dir="auto">
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
          }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
