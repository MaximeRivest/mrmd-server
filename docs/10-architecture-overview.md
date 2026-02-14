# MRMD Server Architecture Overview

`mrmd-server` is the HTTP/browser adaptation of MRMD Electron behavior.

## Core files

- CLI: `bin/cli.js`
- Server core: `src/server.js`
- Browser bridge shim: `static/http-shim.js`
- Electron service bridge: `src/services.js`
- Dynamic sync lifecycle: `src/sync-manager.js`
- Cloud runtime adapter: `src/cloud-session-service.js`

## Design principle: mirror Electron API, not rewrite UI

The browser UI still expects `window.electronAPI`.
`mrmd-server` injects `http-shim.js`, which converts those calls into HTTP/WebSocket requests.

This preserves behavior and enables code reuse.

## Reused service layer

`src/services.js` re-exports pure Node services from `mrmd-electron/src/services/*`.
That gives parity for project/session/file/asset/settings behavior between desktop and server.

## HTTP/WS surface

- `/api/*` — API routes mirroring Electron capabilities
- `/events` — event websocket
- `/sync/:port/:path` — websocket proxy to local sync/runtime ws targets
- `/proxy/:port/*` — HTTP proxy to localhost/runtime targets
- `/api/project-file` — serves project assets/files in browser mode

## Dynamic project/sync behavior

Project detection is per-document (not fixed to one static project only).
`sync-manager` starts/reuses sync servers by project path hash and reference counting.

## Cloud mode

When `CLOUD_MODE=1`:
- Python session handling uses `CloudSessionService`
- runtime endpoint is externalized via `RUNTIME_PORT` (+ optional `RUNTIME_HOST`)
- runtime location can be hot-swapped via `/api/runtime/update-port`
- `BASE_PATH` enables path-prefix deployments like `/u/<userId>/`

## Browser transport interception

`http-shim.js` intercepts:
- `new WebSocket("ws://127.0.0.1:...")` -> `/sync/...`
- `fetch("http://127.0.0.1:...")` -> `/proxy/...`

This is the key mechanism that allows remote browsers to use services originally designed for localhost access patterns.
