import type { Project } from "./projects";
import { t, dir as uiDir, useLang } from "./i18n";
import { useModalOpen } from "./modalTracker";

// Settings for the ONE project currently open in ChatPanel — deliberately
// separate from ProvidersModal (which is global, one config for the whole
// app). Scoped to a single project rather than listing every project, so
// more per-project settings can be added later without this menu turning
// into a second project switcher.
export default function ProjectSettingsModal({
  project,
  onSave,
  onClose,
}: {
  project: Project;
  onSave: (p: Project) => void;
  onClose: () => void;
}) {
  useLang();
  useModalOpen(true);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" dir={uiDir()} style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t("projectSettingsTitle")}</h3>
        <div style={{ fontSize: 12.5, marginBottom: 4, fontWeight: 600 }}>{project.name}</div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 14 }} dir="ltr">
          {project.directory || "—"}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={!!project.allowModelRouting}
            onChange={(e) => onSave({ ...project, allowModelRouting: e.target.checked })}
          />
          {t("allowModelRoutingLabel")}
        </label>

        <label style={{ fontSize: 12.5, display: "block", marginBottom: 16 }}>
          {t("projectInstructionsLabel")}
          <textarea
            value={project.instructions ?? ""}
            onChange={(e) => onSave({ ...project, instructions: e.target.value })}
            rows={6}
            style={{ width: "100%", marginTop: 6, fontFamily: "inherit", fontSize: 12.5 }}
          />
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{t("projectInstructionsHelp")}</div>
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
