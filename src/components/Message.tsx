import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Msg } from "../agent";
import ToolCallView from "./ToolCallView";
import CodeBlock from "./CodeBlock";
import { t } from "../ide/i18n";

export default function Message({
  msg,
  workspace,
  getScreenshot,
}: {
  msg: Msg;
  workspace: string;
  getScreenshot?: (toolCallId?: string) => string | undefined;
}) {
  if (msg.role === "tool") {
    return <ToolCallView msg={msg} workspace={workspace} screenshot={getScreenshot?.(msg.tool_call_id)} />;
  }

  if (msg.role === "user") {
    return (
      <div className="msg msg-user" dir="auto">
        {msg.images && msg.images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {msg.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt="pasted"
                style={{ maxWidth: 160, maxHeight: 160, borderRadius: 8, display: "block" }}
              />
            ))}
          </div>
        )}
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
