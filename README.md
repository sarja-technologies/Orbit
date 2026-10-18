# Orbit by AgentDock

Orbit is a local-first Electron workspace for projects, conversations, runs, and artifacts.

## Antigravity runtime

Orbit's primary Antigravity integration is derived from AgentDock Pro's proven Antigravity runtime integration. Electron main launches the installed `agy` CLI with its structured `stream-json` transport; Antigravity owns its existing signed-in account and session state.

Normal Orbit use requires no Python runtime, `google-antigravity` package, Gemini API key, Google API key, Vertex credentials, service account, copied OAuth token, or hardcoded credential.

Orbit discovers `agy` from `PATH` (including the standard `~/.local/bin/agy` location on Unix). `ORBIT_AGY_PATH` can override discovery with an absolute executable path for managed installations. Install and sign in to Antigravity using its official tooling before starting Orbit.

Each Orbit conversation persists the native Antigravity conversation ID returned by `stream-json`. Later turns resume that actual provider conversation with `--conversation`; Orbit does not reconstruct context by concatenating transcripts. One child process is used per run, and cancellation terminates only that process.

A conversation can also be switched into interactive mode, which keeps a persistent, live `agy` session open so it can surface and answer native questions and permission prompts, and attach images natively via clipboard paste. See `docs/antigravity-transports.md` for the full design and what has actually been live-verified.

## Development

Use Node.js 22 (see `.nvmrc`); Electron 33 supplies the desktop runtime.

```bash
npm ci
npm run dev
```

`npm install` runs `scripts/ensureNodePtyPermissions.mjs`, which restores the
executable bit on `node-pty`'s `spawn-helper`. The published node-pty tarball
records it as mode `0644`, and without the fix every PTY spawn on macOS fails
with `posix_spawnp failed` — i.e. interactive mode never starts. Installing
with `--ignore-scripts` skips it (and node-pty's own install too); run
`npm run postinstall` afterwards if you do. See
`docs/antigravity-transports.md`.

For isolated development data:

```bash
ORBIT_USER_DATA_DIR=/tmp/orbit-dev npm run dev
```

## Verification

```bash
npm run typecheck
npm run test
npm run build
npm run verify
```

`npm run test:agy` runs additional tests against the real, installed, signed-in `agy` CLI (both structured and interactive PTY transports) — opt-in via `ORBIT_REAL_AGY=1`, skipped otherwise.

The retired Python SDK worker has been removed. Orbit has one production Antigravity backend: the native `agy` transport.

### Continuous integration

`.github/workflows/ci.yml` runs `npm ci` and `npm run verify` on Ubuntu,
macOS, and Windows for every PR into `main` and every push to `main`.
The checks are `Verify (ubuntu-latest)`, `Verify (macos-latest)`, and
`Verify (windows-latest)`. npm caching stores downloads, not `node_modules`;
each OS runs the repository-owned postinstall repair from a clean install.

All platforms run typecheck, deterministic main/renderer/shared/script tests,
and the main/preload/renderer builds. The three real Unix PTY signal tests
are Unix-only because Windows has different process termination semantics.
Unix helper permission tests use real chmod on Unix and modeled mode bits on
Windows; installed-package checks use the actual host filesystem. Structured
stream fixtures run through Node on every OS, preserving real child-process
pipes and cancellation without relying on Unix shebang execution. Fixtures
wait for process exit before removing workspaces (required by Windows locks).
Mocked provider tests isolate executable discovery and temporary workspaces,
so the deterministic suite needs no installed AGY even on a developer machine.

Live AGY tests are deliberately excluded (`ORBIT_REAL_AGY=0`): they need a
signed-in account, network access, and model availability. Green CI does not
certify live AGY, desktop UI, or Windows PTY/clipboard behavior.

## Licence

Orbit's own source code and documentation are dedicated to the public domain under
[CC0 1.0 Universal](LICENSE) (SPDX: `CC0-1.0`). Before this change the repository carried no licence file.

CC0 covers only material the project's authors own. It does **not** apply to:

- **Provider logos** in `src/renderer/assets/providers/` (Anthropic, Google Gemini, OpenAI). These are the
  providers' own marks, used for identification; they remain the property and trademarks of their owners
  (see `src/renderer/assets/providers/SOURCES.md`).
- **`ReferenceImagesForAGY.zip`**, a set of screenshots of third-party software (Antigravity) kept as
  design reference. It has not been cleared for redistribution and is excluded from the CC0 dedication.
- **npm dependencies**, which keep their own licences and notices.
