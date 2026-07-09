# Claude Code Changelog

Date: 2026-07-06

## Summary

Fixed the bug audit findings around workspace path escaping, unsafe revert behavior, local LLM process cleanup, ASR temp-file races, prompt-improvement model selection, dependency audit warnings, and the Rust clippy failure.

## Changes

- Hardened `resolve()` in `src-tauri/src/lib.rs`:
  - Rejects absolute paths and `..` escapes before joining with the workspace.
  - Canonicalizes existing paths.
  - For new files, canonicalizes the nearest existing ancestor so symlinked parents cannot escape the workspace.
  - Rejects mutations that target the workspace root itself.

- Made checkpoints binary- and directory-safe in `src-tauri/src/checkpoint.rs`:
  - Snapshots files as bytes instead of UTF-8 strings.
  - Snapshots directory trees.
  - Restores by replacing the current target with the snapshotted state.
  - Removes targets that did not exist at checkpoint time.

- Extended agent revert coverage in `src/agent.ts` and `src/ide/ChatPanel.tsx`:
  - Media outputs from `generate_image`, `generate_audio`, and `speak_text` are now checkpointed before overwrite/create.
  - Revert buttons now appear for those tool-created files.
  - Generated media refreshes the IDE file tree/tabs when the chat project is the open workspace.

- Fixed ASR temp-file collision in `src-tauri/src/asr.rs`:
  - Temp wav names now include a per-process atomic counter.
  - Temp files are cleaned up on ffmpeg and WAV-read errors.

- Fixed local LLM process cleanup hazards in `src-tauri/src/llm.rs`:
  - `kill_pid(0)` is now a no-op.
  - PID `0` is treated as not alive.
  - `/slots` busy detection now parses JSON instead of searching for an exact string.

- Fixed prompt-improvement model selection:
  - `improvePrompt()` now accepts the configured model id.
  - Local prompt improvement uses `loadImproveModel()` instead of always using Qwen3 4B.

- Fixed dependency audit:
  - Added an npm override for `dompurify@3.4.11`.
  - Updated `package-lock.json`.

- Fixed clippy:
  - Removed the needless borrow in `open_console_window()`.

## Verification

- `npm run build`
- `cargo check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test`
- `npm audit --omit=dev`
- `npm ls dompurify monaco-editor`

All passed. `cargo test` still reports 0 tests.
