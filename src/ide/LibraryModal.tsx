import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Download, FolderOpen, FolderPlus, GitPullRequest, RefreshCw, Save, Trash2, X } from "lucide-react";
import { enabledLibraryIds, LibraryItem, libraryDisplayName, listLibrary, saveProjectSkillMap, setLibraryDisplayName } from "./library";
import { dir as uiDir, t, useLang } from "./i18n";
import { useModalOpen } from "./modalTracker";

type SkillProgress = { operationId: string; phase: string; percent: number | null; message: string };
type GitLfsStatus = { installed: boolean; version: string; managed: boolean };

export default function LibraryModal({ projectId, workspace, onClose, onChanged }: {
  projectId: string; workspace: string; onClose: () => void; onChanged: (items: LibraryItem[]) => void;
}) {
  useLang(); useModalOpen(true);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState<Set<string>>(() => enabledLibraryIds(projectId));
  const [removed, setRemoved] = useState<LibraryItem[]>([]);
  const [, setNameRevision] = useState(0);
  const [progress, setProgress] = useState<SkillProgress | null>(null);
  const [lfsStatus, setLfsStatus] = useState<GitLfsStatus | null>(null);
  const activeOperationId = useRef("");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SkillProgress>("skill://progress", (event) => {
      if (event.payload.operationId === activeOperationId.current) setProgress(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  async function refresh() {
    const next = await listLibrary();
    setItems(next); onChanged(next);
  }
  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    invoke<GitLfsStatus>("git_lfs_status").then(setLfsStatus).catch(() => setLfsStatus({ installed: false, version: "", managed: false }));
  }, []);

  async function run(action: (operationId: string) => Promise<unknown>, showProgress = false) {
    setBusy(true); setError("");
    const operationId = crypto.randomUUID();
    activeOperationId.current = operationId;
    if (showProgress) setProgress({ operationId, phase: "starting", percent: 0, message: "Starting…" });
    try { await action(operationId); await refresh(); }
    catch (e) { setError(String(e)); }
    finally {
      setBusy(false);
      if (showProgress) window.setTimeout(() => {
        if (activeOperationId.current === operationId) setProgress(null);
      }, 1200);
    }
  }

  async function importDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await run((operationId) => invoke("library_import_directory", { kind: "skills", source: selected, operationId }), true);
  }

  async function installGitLfs() {
    await run(async (operationId) => {
      const status = await invoke<GitLfsStatus>("git_lfs_install", { operationId });
      setLfsStatus(status);
    }, true);
  }

  async function updateSkill(item: LibraryItem, chooseSource = false) {
    let sourceOverride: string | null = null;
    if (chooseSource) {
      const selected = await open({ directory: true, multiple: false, defaultPath: item.sourceDirectory || undefined });
      if (typeof selected !== "string") return;
      sourceOverride = selected;
    }
    await run((operationId) => invoke("library_update", {
      kind: "skills", sourceRoot: item.sourceRoot, sourceOverride, operationId,
    }), true);
  }

  async function save() {
    setBusy(true); setError("");
    try {
      for (const item of removed) await invoke("library_remove", { kind: "skills", sourceRoot: item.sourceRoot });
      await saveProjectSkillMap(workspace, projectId, [...items, ...removed], enabled);
      onChanged([...items]); onClose();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal library-modal" dir={uiDir()} onClick={(e) => e.stopPropagation()}>
      <div className="library-title">
        <div><h3>{t("skillsLibrary")}</h3><small>{t("libraryProjectScope")}</small></div>
        <button className="ghost" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="library-import">
        <input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repository.git" />
        <button disabled={busy || !url.trim()} onClick={() => run(async (operationId) => { await invoke("library_clone", { kind: "skills", url: url.trim(), operationId }); setUrl(""); }, true)}><GitPullRequest size={14} />{t("cloneRepo")}</button>
        <button disabled={busy} onClick={importDirectory}><FolderPlus size={14} />{t("addDirectory")}</button>
      </div>
      <div className={`git-lfs-status${lfsStatus?.installed ? " installed" : ""}`}>
        <span>
          {lfsStatus?.installed ? <CheckCircle2 size={14} /> : <GitPullRequest size={14} />}
          {lfsStatus?.installed ? `${t("gitLfsInstalled")} · ${lfsStatus.version}` : t("gitLfsRequired")}
        </span>
        {lfsStatus && !lfsStatus.installed && (
          <button disabled={busy} onClick={installGitLfs}><Download size={13} />{t("installGitLfs")}</button>
        )}
      </div>
      {progress && (
        <div className="library-progress">
          <div><span>{progress.phase}</span><span>{progress.percent == null ? "…" : `${progress.percent}%`}</span></div>
          <div className={`library-progress-track${progress.percent == null ? " indeterminate" : ""}`}>
            <span style={progress.percent == null ? undefined : { width: `${progress.percent}%` }} />
          </div>
          <small dir="auto">{progress.message}</small>
        </div>
      )}
      {error && <div className="library-error" dir="ltr">{error}</div>}
      <div className="library-list">
        {!items.length && !busy && <div className="service-page-empty">{t("libraryEmpty")}</div>}
        {items.map((item) => <div className={`library-item${enabled.has(item.id) ? " enabled" : ""}`} key={item.id} title={item.bundleRoot}>
          <div className="library-item-main">
            <input type="checkbox" checked={enabled.has(item.id)} onChange={(e) => setEnabled((current) => { const next = new Set(current); e.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} />
            <div className="library-item-copy">
              <input className="library-name-input" value={libraryDisplayName(item)} onChange={(e) => { setLibraryDisplayName(item, e.target.value); setNameRevision((v) => v + 1); onChanged([...items]); }} aria-label={t("name")} />
              <span className="library-source" dir="ltr" title={item.sourceUrl || item.sourceDirectory || item.bundleRoot}>
                {item.sourceKind === "git" ? item.sourceUrl : item.sourceDirectory || "Local source must be selected again"}
              </span>
            </div>
            {item.updateAvailable && <span className="library-update-dot" title="Local source has changed" />}
          </div>
          <div className="library-item-actions">
            <button className="ghost" title={t("openLibraryFile")} onClick={() => openPath(item.bundleRoot)}><FolderOpen size={13} /></button>
            <button className="ghost" title={item.sourceKind === "git" ? t("updateFromGit") : "Update from original folder"} disabled={busy} onClick={() => updateSkill(item)}><RefreshCw size={13} /></button>
            {item.sourceKind === "local" && <button className="ghost" title="Choose source folder and update" disabled={busy} onClick={() => updateSkill(item, true)}><FolderPlus size={13} /></button>}
            <button className="ghost danger" title={t("del")} disabled={busy} onClick={() => { setRemoved((cur) => [...cur, item]); setItems((cur) => cur.filter((entry) => entry.id !== item.id)); setEnabled((cur) => { const next = new Set(cur); next.delete(item.id); return next; }); }}><Trash2 size={13} /></button>
          </div>
        </div>)}
      </div>
      <div className="library-location" dir="ltr">~/Documents/MAHI Skills</div>
      <div className="library-footer"><span>{items.filter((item) => enabled.has(item.id)).length} {t("enabledCount")}</span><button className="primary" disabled={busy} onClick={save}><Save size={13} />{t("save")}</button></div>
    </div>
  </div>;
}
