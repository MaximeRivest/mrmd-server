# MRMD Server — Quick Explain

`mrmd-server` runs the MRMD experience in any browser.

- It serves the same UI used by Electron
- It injects `http-shim.js` so browser code can call `window.electronAPI`
- It mirrors IPC behavior as HTTP endpoints and WebSocket events
- It reuses `mrmd-electron` services (`src/services.js`)

## Key modes

- Standard mode: local runtime/services on same host
- Cloud mode: `CLOUD_MODE=1`, runtime accessed via `RUNTIME_PORT`/`RUNTIME_HOST`, optional `BASE_PATH`

## Why this matters

This is the canonical home for browser/server architecture and deployment behavior.
