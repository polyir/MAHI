import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "../../components/CodeBlock";

export default function MarkdownPreview({ content, dir }: { content: string; dir: "rtl" | "ltr" }) {
  return (
    <div dir={dir} className="markdown-body" style={{ padding: "12px 18px", overflow: "auto", height: "100%" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
