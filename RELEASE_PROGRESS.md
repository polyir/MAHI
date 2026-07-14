# MAHI release progress

Single source of truth for "what version are we on" and "what's actually
live where." Committed to git (unlike `VERSION_LOG.md`, which is local-only)
specifically so any model or agent working on this repo — not just the one
that did the last release — can read real current state here instead of
guessing or asking the user. See `RELEASE_RUNBOOK.md` for the actual
step-by-step procedure that keeps this file in sync.

**Read this FIRST before bumping a version number. Never guess the next
version — bump from the "Working tree" line below, following
`VERSION_LOG.md`'s semver policy.**

## Working tree (source of truth for the next bump)

- **Version:** 2.7.0
- **tsc:** clean
- Built and installed to `/Applications/MAHI.app`: yes (2026-07-14)
- Committed to git: **no** — HEAD is still `ea55c85` (1.3.6). Everything
  from 1.3.7 through 2.7.0 is uncommitted working-tree state.

## Last git commit

- `ea55c85` — "Fix Gemini null-content requirements and stagger-animation
  delay overflow" — 2026-07-11 23:05 +0300 — shipped as 1.3.6.

## Currently live on the update server

(what `https://cnatorabi.com/mahi-updates/latest.json` actually serves —
verified by curling it directly, not assumed)

- **Version:** 2.7.0
- **Published:** 2026-07-14T16:50:38Z
- Artifact: `https://cnatorabi.com/mahi-updates/MAHI-2.7.0.app.tar.gz`
- Previous artifact (`MAHI-1.3.6.app.tar.gz`) deleted from the server per
  policy (only current release's artifact is kept).

So: installed locally is 2.7.0 and that's now also what's published to the
update server. Git HEAD is still `ea55c85` (1.3.6) — commit was not part of
this request and was not done (this project's pattern: build+install,
commit, and publish-to-server are three separate asks).

## Open items / things not to forget

- 2.7.0 fixes Studio MCP discovery and visibility. Existing installs are
  migrated once without overwriting enabled flags or environment secrets;
  installing/updating the managed bundle now persists its four presets
  immediately. The chat MCP popover is scrollable and checks each enabled
  server live, showing connection state and tool count. OBS now has a clear
  dedicated WebSocket-password field. Photoshop and After Effects passed
  read-only live calls; Premiere and OBS were closed during the final test.

- 2.6.0 added self-service download/install for the studio MCP servers: a
  "Download & install studio servers" button in Manage Providers → MCP now
  fetches them from `https://cnatorabi.com/mahi-updates/mahi-mcp-servers.json`
  (a small manifest pointing at a versioned tarball) into the hidden
  `~/Documents/MAHI/.mcp-servers` folder and runs `npm ci` automatically —
  see `src-tauri/src/mcp_servers.rs` and `src/ide/studioMcp.ts`. Publishing
  a future update to that bundle is documented in `mcp-servers/README.md`
  ("Publishing an update") — bump the version number in the tarball
  filename, never reuse one (CDN caches by URL).
  **Not click-verified in the live UI**: this machine's computer-use
  screen automation is broken at the OS level (Screen Recording/Accessibility
  TCC permissions, not fixable by any tool — see memory), and the Vite
  dev-preview browser tab can't call real Tauri `invoke()`. The underlying
  pipeline (download, SHA-256 check, tar extract, npm ci, version marker)
  was instead verified by replicating it by hand directly into the real
  target folder, and it worked — but the actual button click through the
  real app has not yet been observed. Worth a quick manual click-through
  the next time the user is actually looking at the app.

- 2.5.0 added four local "studio" MCP servers (Photoshop, After Effects,
  Premiere Pro, OBS) living in `mcp-servers/` at the repo root — that folder
  is **deliberately gitignored** (its own `.gitignore` contains `*`) and must
  never be committed. Setup/docs: `mcp-servers/README.md`. MAHI-side UI:
  "Studio servers" preset block in Manage Providers → MCP (the folder path is
  typed once and remembered in localStorage — never hardcode it in source).
  The Premiere bridge is a CEP extension symlinked into
  `~/Library/Application Support/Adobe/CEP/extensions/com.mahi.bridge`;
  PlayerDebugMode is enabled for CSXS 11/12. All four servers were
  live-tested against the real apps on 2026-07-14. The user still needs to
  paste the OBS WebSocket password into the OBS server's env in MAHI's MCP
  settings before OBS tools work from chat.

- Models now receive dedicated `generate_music` and `generate_sound_effect`
  tools whenever an ElevenLabs key is stored in MAHI. They use the managed key
  directly, require approval before paid generation, and never require a shell
  environment variable. No paid live generation was invoked automatically.

- The chat composer now has a per-project Skill persistence switch. Off keeps
  the one-message behavior; on retains the current Skill selection after send.

- Skills now live in `~/Documents/MAHI Skills`. Git and local sources retain
  update metadata; project-enabled skills enter model context only when picked
  for the current message. The Skill Library now shows Git LFS status and can
  install a checksum-verified, MAHI-managed official binary after an explicit
  button click. Git LFS remains uninstalled on this Mac because the button was
  intentionally not clicked during verification. The final 2.3.1 `.app`
  compiled, was native-lib patched, installed, and launched.

- Gemini's second-call failure was addressed in 1.6.0 by preserving its
  `thought_signature`; parallel tool calls no longer collapse when their
  compatibility-stream index is null. A direct two-step live API test passed.
- Reasoning-effort options are provider/model-specific and must be
  confirmed against real provider docs before adding a new preset to
  `BUILTIN_MODEL_REASONING` in `src/ide/providers.ts` — never guess a value
  that could 400 (see `RELEASE_RUNBOOK.md`'s review-before-building step).
- Media generation now uses the data-driven registry in
  `src/ide/mediaAdapters.ts`. Built-in adapters should be updated only from
  official provider documentation; paid live generation was not invoked by
  the 2.2.0 automated verification.
