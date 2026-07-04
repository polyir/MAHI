import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FilePen,
  FilePlus,
  FileX,
  FolderTree,
  Search,
  TerminalSquare,
  MoveRight,
  Image,
  Music,
  Video,
} from "lucide-react";
import { Msg } from "../agent";
import DiffView from "./DiffView";
import ImagePreview from "../ide/preview/ImagePreview";
import MediaPreview from "../ide/preview/MediaPreview";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  read_file: <FileText size={13} />,
  write_file: <FilePlus size={13} />,
  edit_file: <FilePen size={13} />,
  delete_file: <FileX size={13} />,
  move_file: <MoveRight size={13} />,
  list_dir: <FolderTree size={13} />,
  glob_files: <Search size={13} />,
  search_files: <Search size={13} />,
  run_command: <TerminalSquare size={13} />,
  generate_image: <Image size={13} />,
  generate_audio: <Music size={13} />,
  generate_video: <Video size={13} />,
};

function summarize(name: string, args: any): string {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file":
      return `${name} ${args?.path ?? ""}`;
    case "move_file":
      return `move ${args?.from ?? ""} → ${args?.to ?? ""}`;
    case "list_dir":
      return `list_dir ${args?.path || "."}`;
    case "glob_files":
      return `glob ${args?.pattern ?? ""}`;
    case "search_files":
      return `search "${args?.query ?? ""}"`;
    case "run_command":
      return `$ ${args?.cmd ?? ""}`;
    case "generate_image":
    case "generate_audio":
    case "generate_video":
      return `${name} ${args?.path ?? ""}`;
    default:
      return name;
  }
}

export default function ToolCallView({ msg, workspace }: { msg: Msg; workspace: string }) {
  const [open, setOpen] = useState(false);
  const name = msg.toolName ?? "tool";
  const args = msg.toolArgs ?? {};
  const isError = msg.content.startsWith("error:") || msg.content.startsWith("Rejected by user");

  let parsedRunResult: { stdout: string; stderr: string; code: number } | null = null;
  if (name === "run_command") {
    try {
      parsedRunResult = JSON.parse(msg.content);
    } catch {
      // non-JSON result (e.g. rejection message)
    }
  }
  const runFailed = parsedRunResult !== null && parsedRunResult.code !== 0;

  return (
    <div className="tool-card msg">
      <div className="tool-card-head" onClick={() => setOpen(!open)} dir="ltr">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {TOOL_ICONS[name] ?? <TerminalSquare size={13} />}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {summarize(name, args)}
        </span>
        <span className={`status-dot ${isError || runFailed ? "status-err" : "status-ok"}`} />
      </div>

      {open && (
        <div className="tool-card-body" dir="ltr">
          {name === "edit_file" && <DiffView before={args.old_string ?? ""} after={args.new_string ?? ""} />}
          {name === "write_file" && <DiffView before={args.__oldContent ?? ""} after={args.content ?? ""} />}
          {name === "read_file" && (
            <pre style={{ fontSize: 11.5, margin: 0, maxHeight: 240, overflow: "auto" }}>{msg.content}</pre>
          )}
          {name === "run_command" && parsedRunResult && (
            <pre
              style={{
                fontSize: 11.5,
                margin: 0,
                maxHeight: 240,
                overflow: "auto",
                color: runFailed ? "var(--red)" : undefined,
              }}
            >
              exit: {parsedRunResult.code}
              {"\n"}
              {parsedRunResult.stdout}
              {parsedRunResult.stderr}
            </pre>
          )}
          {name === "generate_image" && !isError && <ImagePreview workspace={workspace} path={args.path} />}
          {name === "generate_audio" && !isError && (
            <MediaPreview workspace={workspace} path={args.path} kind="audio" />
          )}
          {(["list_dir", "glob_files", "search_files", "delete_file", "move_file"].includes(name) ||
            (name === "run_command" && !parsedRunResult) ||
            name === "generate_video" ||
            isError) && (
            <pre style={{ fontSize: 11.5, margin: 0, maxHeight: 240, overflow: "auto" }}>{msg.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
