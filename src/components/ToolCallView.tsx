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
  Globe,
  Camera,
  Captions,
  Volume2,
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
  copy_library_asset: <FilePlus size={13} />,
  list_dir: <FolderTree size={13} />,
  glob_files: <Search size={13} />,
  search_files: <Search size={13} />,
  run_command: <TerminalSquare size={13} />,
  generate_image: <Image size={13} />,
  generate_audio: <Music size={13} />,
  generate_music: <Music size={13} />,
  generate_sound_effect: <Volume2 size={13} />,
  generate_video: <Video size={13} />,
  browser_open: <Globe size={13} />,
  browser_navigate: <Globe size={13} />,
  browser_close: <Globe size={13} />,
  browser_screenshot: <Camera size={13} />,
  browser_dom: <Globe size={13} />,
  browser_click: <Globe size={13} />,
  browser_type: <Globe size={13} />,
  browser_submit: <Globe size={13} />,
  browser_scroll: <Globe size={13} />,
  browser_key: <Globe size={13} />,
  open_file_in_editor: <FileText size={13} />,
  view_screen: <Camera size={13} />,
  transcribe_media: <Captions size={13} />,
  speak_text: <Volume2 size={13} />,
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
    case "copy_library_asset":
      return `library asset → ${args?.path ?? ""}`;
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
    case "generate_music":
    case "generate_sound_effect":
    case "generate_video":
      return `${name} ${args?.path ?? ""}`;
    case "browser_open":
      return `browser_open ${args?.url ?? ""}`;
    case "browser_navigate":
      return `browser_navigate ${args?.tab_id ? `[${args.tab_id}] ` : ""}${args?.url ?? ""}`;
    case "browser_close":
      return `browser_close ${args?.tab_id ?? "(active tab)"}`;
    case "browser_screenshot":
      return "browser_screenshot";
    case "browser_dom":
      return `browser_dom ${args?.tab_id ?? "(active tab)"}`;
    case "browser_click":
    case "browser_submit":
      return `${name} ${args?.selector ?? ""}`;
    case "browser_type":
      return `browser_type ${args?.selector ?? ""}`;
    case "browser_scroll":
      return `browser_scroll ${args?.y ?? 0}px`;
    case "browser_key":
      return `browser_key ${args?.key ?? ""}`;
    case "open_file_in_editor":
      return `open_file_in_editor ${args?.path ?? ""}`;
    case "view_screen":
      return "view_screen";
    case "transcribe_media":
      return `transcribe_media ${args?.path ?? ""}`;
    case "speak_text":
      return `speak_text → ${args?.path ?? ""}`;
    default:
      return name;
  }
}

export default function ToolCallView({
  msg,
  workspace,
  screenshot,
}: {
  msg: Msg;
  workspace: string;
  screenshot?: string;
}) {
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
          {(["generate_audio", "generate_music", "generate_sound_effect", "speak_text"].includes(name)) && !isError && (
            <MediaPreview workspace={workspace} path={args.path} kind="audio" />
          )}
          {name === "transcribe_media" && !isError && (
            <pre style={{ fontSize: 11.5, margin: 0, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {(() => {
                try {
                  return JSON.parse(msg.content).text;
                } catch {
                  return msg.content;
                }
              })()}
            </pre>
          )}
          {(name === "browser_screenshot" || name === "view_screen") && !isError && screenshot && (
            <img
              src={`data:image/png;base64,${screenshot}`}
              alt="screenshot"
              style={{ maxWidth: "100%", borderRadius: 6, display: "block" }}
            />
          )}
          {(name === "browser_screenshot" || name === "view_screen") && !isError && !screenshot && (
            <div style={{ fontSize: 11.5, opacity: 0.6 }}>{msg.content}</div>
          )}
          {([
            "list_dir",
            "glob_files",
            "search_files",
            "delete_file",
            "move_file",
            "browser_open",
            "browser_navigate",
            "browser_close",
            "browser_dom",
            "browser_click",
            "browser_type",
            "browser_submit",
            "browser_scroll",
            "browser_key",
            "open_file_in_editor",
          ].includes(name) ||
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
