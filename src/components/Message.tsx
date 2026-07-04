import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Msg } from "../agent";
import ToolCallView from "./ToolCallView";
import CodeBlock from "./CodeBlock";
import { t } from "../ide/i18n";

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
