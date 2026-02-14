# MRMD Server Deployment

## Quick start

```bash
mrmd-server --port 8080 /path/to/notebooks
```

Default bind host is `0.0.0.0` unless overridden.

## CLI options

- `-p, --port <port>`
- `-h, --host <host>`
- `-t, --token <token>`
- `--no-auth` (local/dev only)
- `[project-dir]`

## Production recommendations

1. Put behind HTTPS reverse proxy (nginx/caddy)
2. Keep token auth enabled
3. Ensure websocket upgrades are forwarded
4. Preserve full path/query forwarding

### Reverse-proxy must support

- `/events` websocket upgrades
- `/sync/*` websocket upgrades
- `/api/*` HTTP API
- `/proxy/*` HTTP proxy endpoints
- query-token propagation (`?token=...`) if used in URLs

## Cloud mode contract

Environment variables used by platform/orchestrators:

- `CLOUD_MODE=1`
- `RUNTIME_PORT=<int>`
- `RUNTIME_HOST=<host>` (optional, defaults `127.0.0.1`)
- `BASE_PATH=/u/<userId>/` (optional path prefix mounting)

When cloud mode is active, Python sessions map to pre-existing runtime endpoints rather than spawning local runtimes.

## Security baseline

- never expose `--no-auth` publicly
- treat token as password
- run behind TLS in all non-local environments
- rotate token if link/token leaks
