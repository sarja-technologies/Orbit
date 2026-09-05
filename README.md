# Orbit by AgentDock

Orbit is a local-first Electron workspace for projects, conversations, runs, and artifacts.

## Antigravity runtime

Orbit's primary Antigravity integration is derived from AgentDock Pro's proven Antigravity runtime integration. Electron main launches the installed `agy` CLI with its structured `stream-json` transport; Antigravity owns its existing signed-in account and session state.

Normal Orbit use requires no Python runtime, `google-antigravity` package, Gemini API key, Google API key, Vertex credentials, service account, copied OAuth token, or hardcoded credential.

Orbit discovers `agy` from `PATH` (including the standard `~/.local/bin/agy` location on Unix). `ORBIT_AGY_PATH` can override discovery with an absolute executable path for managed installations. Install and sign in to Antigravity using its official tooling before starting Orbit.

Each Orbit conversation persists the native Antigravity conversation ID returned by `stream-json`. Later turns resume that actual provider conversation with `--conversation`; Orbit does not reconstruct context by concatenating transcripts. One child process is used per run, and cancellation terminates only that process.

A conversation can also be switched into interactive mode, which keeps a persistent, live `agy` session open so it can surface and answer native questions and permission prompts, and attach images natively via clipboard paste. See `docs/antigravity-transports.md` for the full design and what has actually been live-verified.

## Development

```bash
npm install
npm run dev
```

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
