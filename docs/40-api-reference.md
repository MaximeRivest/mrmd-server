# MRMD Server API Reference (Canonical summary)

For user-facing examples see `../README.md`.
This file is implementation-oriented and grouped by route module.

## Authentication

`/api/*` requires token unless server started with `--no-auth`.

Accepted token locations:
- query: `?token=...`
- header: `Authorization: Bearer ...`
- header: `X-Token: ...`

## Public endpoints

- `GET /health`
- `GET /auth/validate`
- `GET /http-shim.js`
- `GET /api/project-file?path=...`

## Project routes (`src/api/project.js`)

- `GET /api/project?path=...`
- `GET /api/project/nav?root=...`
- `POST /api/project`
- `POST /api/project/invalidate`
- `POST /api/project/watch`
- `POST /api/project/unwatch`
- `GET /api/project/sync`
- `POST /api/project/sync/acquire`
- `POST /api/project/sync/release`

## Session and runtime routes

### Python session (`src/api/session.js`)
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session/:name`
- `POST /api/session/:name/restart`
- `POST /api/session/for-document`
- `POST /api/session/attach`

### Runtime (`src/api/runtime.js`)
- `GET /api/runtime`
- `DELETE /api/runtime/:id`
- `POST /api/runtime/:id/attach`
- `POST /api/runtime/start-python`
- `POST /api/runtime/update-port` (cloud hot-reload)

### Language session routes
- Bash: `/api/bash*`
- R: `/api/r*`
- Julia: `/api/julia*`
- PTY: `/api/pty*`

## File and asset routes

- file routes: `/api/file*` (scan/create/move/reorder/delete/read/write/preview/info)
- asset routes: `/api/asset*`
- notebook routes: `/api/notebook*`
- settings routes: `/api/settings*`
- system routes: `/api/system*`

## WebSocket routes

- `/events` — event bus stream
- `/sync/:port/:path` — WS proxy to sync/pty/local ws services

## HTTP proxy route

- `/proxy/:port/*` — HTTP proxy to runtime/local services
  - forwards `X-*` headers (including API-key headers)

## Source of truth

- `src/server.js`
- `src/api/*.js`
- `src/websocket.js`
- `static/http-shim.js`
