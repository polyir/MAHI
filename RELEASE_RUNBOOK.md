# MAHI release runbook

Step-by-step procedure for building, installing, committing, and publishing
MAHI. Written so any model or agent working on this repo can follow it
correctly on the first try — every step here exists because skipping it
broke a real release earlier in this project's history. Don't shortcut
steps marked ⚠️ even if the build "looks fine" without them.

Current state (version, what's committed, what's published) lives in
[`RELEASE_PROGRESS.md`](./RELEASE_PROGRESS.md) — read it before you start,
update it when you finish.

## macOS distribution identity (required)

Public builds must use `npm run tauri:build:distribution`. It refuses ad-hoc
signing and signs the final patched app with one stable identity before it
creates the ZIP and updater tarball. Developer ID builds are also notarized
and stapled automatically.

Set `MAHI_CODESIGN_IDENTITY` when more than one identity exists, plus either
`MAHI_NOTARY_PROFILE` or the Apple credentials accepted by
`notarize-macos.sh`. Set `MAHI_UPDATER_PRIVATE_KEY_PATH` for updater signing.
Until Developer ID is available, `npm run tauri:signing:create-local` creates
the temporary `MAHI Local Distribution` identity. Back up both files under
`~/Library/Application Support/MAHI/Signing` and never regenerate them: every
public update must use that same private key. Self-signed builds cannot be
notarized and show macOS's unidentified-developer warning on first install,
but their stable certificate-root requirement preserves TCC permissions after
the user's one-time migration grant.

Never publish a build whose signature reports `Signature=adhoc`; TCC
permissions do not survive those updates.

## 0. Before touching anything: review the diff

⚠️ **Never build from a dirty working tree without reading the diff first**,
especially if changes came from another model/tool or you don't remember
making them yourself. This project is regularly edited by more than one AI
model in the same working tree. Things found this way in the past:

- A large, never-wired-in parallel implementation of a feature that had
  been sitting uncommitted for an entire session before anyone reviewed it.
- Leftover debug scaffolding: a `console.warn` logging every streamed
  chunk forever, and a mechanism that dumped conversation content to an
  unmanaged log file on every API error.

Run `git status --short` and `git diff <file>` for everything listed, for
every file, even ones you don't expect to be part of "your" change. If
something looks like debug instrumentation, an unrelated feature, or you
can't explain why it's there, **surface it to the user before building** —
don't silently ship it and don't silently delete it either.

## 1. Decide the version bump

1. Check the **Working tree** version in `RELEASE_PROGRESS.md` — that's
   the version you're bumping *from*, not whatever `tauri.conf.json`
   happens to say if it's ambiguous (it should match, but progress notes
   are the tie-breaker).
2. Apply the semver-ish policy from the top of `VERSION_LOG.md`:
   - **Patch** (x.y.Z): fixes, small additive features, no config-shape
     change.
   - **Minor** (x.Y.0): larger new features, or anything that changes
     stored config shape (session/settings fields) in a way old data
     needs a migration path through.
   - **Major** (X.0.0): breaking changes to the user's data/workflow only.
3. Never ask the user what the next version number should be — this is
   decided from the rules above, not by request.

## 2. Bump the version in ALL FOUR places

A missed spot here means the app reports a different version than what's
actually installed, which breaks the whole point of versioning (verifying
an update took effect). Update every one of these — a simple find won't
catch `Cargo.lock` since it also lists the version of every dependency,
only the `vibe-coder` package entry near `name = "vibe-coder"` matters:

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/Cargo.lock` → the `version` line directly under
  `name = "vibe-coder"` (search for that exact string first, don't
  sed-replace every version string in the file)

## 3. Type-check

```
npx tsc --noEmit -p .
```

Must be clean before building. Don't build past a type error hoping it's
harmless.

## 4. Build

```
npx tauri build
```

⚠️ **This bundles the DMG and the updater `.tar.gz` from the UNPATCHED
`.app`** — `fix-native-libs.sh` (next step) hasn't run yet at this point.
Both artifacts from this step are wrong and get regenerated in step 6+.
This is the single most-repeated mistake in this project's history —
don't skip re-patching just because `tauri build` "finished successfully."

If build fails on `TAURI_SIGNING_PRIVATE_KEY`/"public key found but no
private key" — that's expected and harmless when you're only building for
local install, not publishing. It only matters for step 8 (publish).

## 5. Patch native libs

```
bash src-tauri/scripts/fix-native-libs.sh
```

No arguments needed (defaults to the `release` profile). This copies
`libonnxruntime`/`libsherpa-onnx-c-api` into the bundle and rewrites
`@rpath` references to `@executable_path`, then re-signs with the configured
identity (ad-hoc is allowed only for local builds). Without
this, the installed app crashes immediately on launch with "Library not
loaded: @rpath/libonnxruntime... no LC_RPATH's found." This must run
**every single build**, no exceptions — Tauri's bundler has no way to know
about this project's native dependencies.

## 6. Install locally

```
osascript -e 'quit app "MAHI"' 2>/dev/null; sleep 1
rm -rf /Applications/MAHI.app
cp -R src-tauri/target/release/bundle/macos/MAHI.app /Applications/MAHI.app
```

Quit first — a running instance can otherwise relaunch itself during the
copy (observed behavior, mimics a WebKit cache bug).

## 7. Verify before calling it done

```
otool -L /Applications/MAHI.app/Contents/MacOS/vibe-coder | grep -i onnx
# both lines must read @executable_path/..., never @rpath/...
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/MAHI.app/Contents/Info.plist
# must match the version you just bumped to
open /Applications/MAHI.app
sleep 3
pgrep -fl "MAHI.app/Contents/MacOS/vibe-coder"
# must show a running process — if empty, it crashed on launch
```

If any of these fail, don't report success — go back and find out why.

## 8. Publish to the update server (only if explicitly asked)

Don't do this just because you built and installed — this project's
pattern is: build+install happens on almost every request, but committing
and publishing only happens when the user explicitly says so (e.g. "کامیت
و آپلود کن" / "commit and push"). See `PROJECT_CREDENTIALS.md` (local-only,
never committed) for the actual server host/credentials/paths — this file
intentionally does not repeat them.

1. Re-tar the **patched** `.app` (the one from step 5, not step 4's):
   ```
   COPYFILE_DISABLE=1 tar czf MAHI-<version>.app.tar.gz -C src-tauri/target/release/bundle/macos MAHI.app
   ```
   ⚠️ `COPYFILE_DISABLE=1` is required — without it, macOS `tar` emits
   AppleDouble `._MAHI.app` sidecar entries that break Tauri's updater
   unpacking with "failed to unpack `._MAHI.app`."
2. Sign it: `npx tauri signer sign -k src-tauri/mahi-updater.key <tarball>`
   (no password on that key).
3. Write `latest.json` with the new version, notes, `pub_date`, the
   signature from step 2, and a URL using the **version-unique filename**
   from step 1.
   ⚠️ **Never reuse a tarball filename across releases** — the CDN in
   front of `cnatorabi.com` caches by URL, so a reused name can keep
   serving an old, possibly-crashing cached copy forever even after you
   upload a new file to the same name.
4. Upload both the tarball and `latest.json` to the server path in
   `PROJECT_CREDENTIALS.md`.
5. Delete the **previous** version's tarball from the server (user's
   explicit preference: only the current release's artifact is kept).
6. Verify live, don't just assume:
   ```
   curl -sI https://cnatorabi.com/mahi-updates/latest.json
   # must echo back Cache-Control: no-cache, no-store, must-revalidate
   curl -s https://cnatorabi.com/mahi-updates/latest.json
   # must show the new version and the new tarball URL
   ```
   ⚠️ `latest.json` can be served stale from a different CDN edge/PoP than
   whatever your own curl happens to hit — the `.htaccess` in
   `mahi-updates/` sets no-cache headers for exactly this reason; confirm
   the response actually has them, don't assume the CDN honors it.

## 9. Commit (only if explicitly asked)

Stage the relevant files, write a commit message describing what shipped
and why (not just "bump version"). Follow the repo's existing commit
message style (`git log` for examples). Never use `--no-verify` or amend
an already-pushed commit.

## 10. Update the two tracking files

- **`RELEASE_PROGRESS.md`**: update the working-tree version, whether it's
  built/installed, whether it's committed (and to what commit hash), and
  the "currently live on the update server" section if you published.
- **`VERSION_LOG.md`** (local-only, gitignored): add an entry — what
  shipped, why the bump level was chosen, and anything not yet confirmed
  working (e.g. "not yet live-tested by the user").
