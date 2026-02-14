# MRMD Server Runbook

## 1) Health checks

- `GET /health`
- `GET /auth/validate?token=<token>`

If `health` is up but editor behavior fails, continue with subsystem checks.

## 2) Subsystem checks

### A) Project and sync

- `GET /api/project?path=<file>`
- `GET /api/project/sync`

Check that:
- project root resolves as expected
- sync server is allocated and has a port

### B) Session/runtime

- `POST /api/session/for-document`
- `GET /api/runtime`

If execution fails, verify runtime endpoint and reachability through `/proxy/:port/...`.

### C) WebSockets

Verify successful upgrade/connect for:
- `/events`
- `/sync/:port/:doc`

Frequent reconnects usually indicate reverse-proxy WS config issues.

## 3) Cloud mode troubleshooting

If mounted under `/u/<userId>/` style paths:
- verify `BASE_PATH` is set correctly
- verify injected `window.MRMD_SERVER_URL` uses the prefixed path
- verify shim-generated URLs are relative/path-safe

If runtime migrates hosts/ports:
- call `POST /api/runtime/update-port`
- verify subsequent Python calls route to updated host/port

## 4) Useful files

- `src/server.js`
- `static/http-shim.js`
- `src/cloud-session-service.js`
- `src/sync-manager.js`
- `src/api/*.js`
