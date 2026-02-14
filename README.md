# MRMD Server

**Run MRMD in any browser.** Access your markdown notebooks from anywhere — your phone, tablet, or any machine with a browser.

[![npm version](https://img.shields.io/npm/v/mrmd-server)](https://www.npmjs.com/package/mrmd-server)  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Server / VPS / Cloud                │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                    mrmd-server                       │   │
│   │  • Full MRMD UI served over HTTP                    │   │
│   │  • Code execution (Python, JS, Bash, R, Julia)      │   │
│   │  • Real-time collaboration via WebSocket            │   │
│   │  • Token-based authentication                       │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          │
                          │  https://your-server.com?token=xxx
                          │
              ┌───────────┴───────────┬─────────────────┐
              │                       │                 │
          ┌───▼───┐              ┌────▼────┐       ┌────▼────┐
          │Laptop │              │  Phone  │       │ Collab  │
          └───────┘              └─────────┘       └─────────┘
```

---

## Documentation

- Start here: [docs/README.md](./docs/README.md)
- Quick explain: [docs/00-quick-explain.md](./docs/00-quick-explain.md)
- Architecture: [docs/10-architecture-overview.md](./docs/10-architecture-overview.md)
- Deployment: [docs/20-deployment.md](./docs/20-deployment.md)

## What is MRMD Server?

MRMD Server is the headless/server version of [MRMD Electron](https://github.com/MaximeRivest/mrmd-electron). It provides the same markdown notebook experience without requiring a desktop app — just start the server and open it in any browser.

**Use cases:**
- Run notebooks on a remote GPU server, access from your laptop
- Host shared notebooks for a team
- Access your notebooks from your phone or tablet
- Deploy on a cloud VM for always-on compute

---

## Features

### Same UI as Desktop
The exact same editor, code execution, and collaboration features as MRMD Electron.

### Access from Anywhere
Open your notebooks in any browser — phone, tablet, another computer.

### Real-Time Collaboration
Share the URL with teammates. Changes sync instantly via Yjs CRDT.

### Token Authentication
Secure access with auto-generated or custom tokens. Share links safely.

### Portable Compute
Start the server wherever your data lives. GPU machine? Local workstation? Cloud VM? Just run `mrmd-server`.

---

## Installation

### npm (recommended)

```bash
npm install -g mrmd-server
```

### npx (no install)

```bash
npx mrmd-server ./my-notebooks
```

### Requirements

- **Node.js 18+**
- **Python 3.11+** with [uv](https://github.com/astral-sh/uv) (for Python execution)

---

## Quick Start

```bash
# Start server in your project directory
mrmd-server ./my-notebooks

# Output:
#   mrmd-server
#   ──────────────────────────────────────────────────────
#   Server:     http://0.0.0.0:8080
#   Project:    /home/you/my-notebooks
#   Token:      abc123xyz...
#
#   Access URL:
#   http://localhost:8080?token=abc123xyz...
```

Open the Access URL in your browser. That's it.

---

## Usage

### Command Line Options

```bash
mrmd-server [options] [project-dir]

Options:
  -p, --port <port>     HTTP port (default: 8080)
  -h, --host <host>     Bind address (default: 0.0.0.0)
  -t, --token <token>   Auth token (auto-generated if not provided)
  --no-auth             Disable authentication (local dev only!)
  --help                Show help
```

### Examples

```bash
# Start in current directory
mrmd-server

# Start in specific directory
mrmd-server ./my-project

# Custom port
mrmd-server -p 3000 ./my-project

# With specific token (for automation)
mrmd-server -t my-secret-token ./my-project

# No auth (local development only!)
mrmd-server --no-auth
```

---

## Remote Access Setup

### 1. Start the server on your remote machine

```bash
ssh your-server
cd /path/to/notebooks
mrmd-server -p 8080
```

### 2. Set up HTTPS with nginx (recommended)

```nginx
server {
    listen 443 ssl;
    server_name notebooks.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 3. Access from anywhere

```
https://notebooks.example.com?token=YOUR_TOKEN
```

---

## Sharing & Collaboration

Share the URL (including the token) with collaborators:

```
https://your-server.com?token=abc123xyz
```

Everyone with the URL gets:
- Real-time collaborative editing
- Code execution on your server
- Full MRMD features

---

## Architecture

MRMD Server mirrors the Electron app's IPC interface as an HTTP API:

| Electron (IPC) | MRMD Server (HTTP) |
|----------------|-------------------|
| `electronAPI.project.get(path)` | `GET /api/project?path=...` |
| `electronAPI.file.write(path, content)` | `POST /api/file/write` |
| `electronAPI.session.forDocument(path)` | `POST /api/session/for-document` |
| `ipcRenderer.on('project:changed', cb)` | WebSocket `/events` |

The browser loads an HTTP shim that creates `window.electronAPI` making HTTP calls instead of IPC. The UI code works unchanged.

```
┌─────────────────────────────────────────────────────────────┐
│                      mrmd-server                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Express     │  │ mrmd-sync   │  │ mrmd-       │         │
│  │ HTTP API    │  │ (Yjs)       │  │ python/bash │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
         │                  │                  │
    HTTP/REST          WebSocket           Execution
```

---

## API Reference

### Authentication

All `/api/*` endpoints require authentication. Provide token via:
- Query parameter: `?token=xxx`
- Header: `Authorization: Bearer xxx`
- Header: `X-Token: xxx`

### Core Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (no auth) |
| `GET /auth/validate?token=xxx` | Validate token (no auth) |
| `GET /api/project?path=...` | Get project info |
| `GET /api/file/read?path=...` | Read file |
| `POST /api/file/write` | Write file |
| `POST /api/session/for-document` | Get/create session for document |
| `GET /api/runtime` | List active runtimes |
| `DELETE /api/runtime/:id` | Kill a runtime |

### WebSocket Events

Connect to `/events?token=xxx` for real-time updates:

```javascript
const ws = new WebSocket('wss://server.com/events?token=xxx');
ws.onmessage = (e) => {
  const { event, data } = JSON.parse(e.data);
  // Events: 'project:changed', 'venv-found', 'sync-server-died', etc.
};
```

---

## Runtime Resolution

MRMD Server supports **R, Julia, and Ruby** runtimes (in addition to Python and Bash which use `uv`). Each native runtime is resolved through a 4-level priority chain:

| Priority | Source | How to configure | Use case |
|----------|--------|-----------------|----------|
| 1 | **Remote URL** | `MRMD_R_URL=http://host:port` | Runtime runs on another machine (cloud/feuille.dev) |
| 2 | **Explicit directory** | `MRMD_R_DIR=/path/to/mrmd-r` | Point to a local checkout |
| 3 | **Sibling monorepo** | (automatic) | Development mode in mrmd-packages/ |
| 4 | **Vendor bundle** | (automatic) | Shipped with mrmd-server for npx users |

### Environment Variables

Replace `R` with the language: `R`, `JULIA`, or `RUBY`.

| Variable | Description |
|----------|-------------|
| `MRMD_R_URL` | URL of a running mrmd-r server. No local process is spawned. |
| `MRMD_R_DIR` | Path to the mrmd-r package directory (must contain `DESCRIPTION`). |
| `MRMD_JULIA_URL` | URL of a running mrmd-julia server. |
| `MRMD_JULIA_DIR` | Path to the mrmd-julia package directory (must contain `Project.toml`). |
| `MRMD_RUBY_URL` | URL of a running mrmd-ruby server. |
| `MRMD_RUBY_DIR` | Path to the mrmd-ruby package directory (must contain `Gemfile`). |

### Remote Runtimes (Cloud Mode)

When a `MRMD_{LANG}_URL` is set, the server does **not** spawn a local process. Instead it registers a virtual session pointing to the remote URL. This is how [feuille.dev](https://feuille.dev) runs runtimes on separate containers:

```bash
# Runtime container runs mrmd-r on port 9001
MRMD_R_URL=http://10.0.0.5:9001 mrmd-server ./notebooks
```

### Local / npx Users

When installed via `npx mrmd-server`, the bundled `vendor/mrmd-r/` is used automatically — no extra setup needed (as long as R is installed on the system).

### Adding a New Language Runtime

1. Add an entry to `LANGUAGES` in `src/runtime-resolver.js`
2. Bundle the runtime in `vendor/mrmd-{lang}/`
3. Create an enhanced session service class in `src/enhanced-session-services.js`

---

## Security

1. **Always use HTTPS** in production — use nginx, caddy, or a cloud load balancer
2. **Keep tokens secret** — treat them like passwords
3. **Never use `--no-auth` on public networks**
4. **Rotate tokens** if you suspect they're compromised

---

## Limitations

Some desktop features don't work in browser mode:

| Feature | Browser Behavior |
|---------|------------------|
| "Show in Finder" | Returns path (can't open native file browser) |
| Native window controls | Standard browser chrome |
| Offline mode | Requires server connection |

---

## Development

```bash
# Clone the monorepo
git clone https://github.com/MaximeRivest/mrmd-packages.git
cd mrmd-packages/mrmd-server

# Install dependencies
npm install

# Run in dev mode
npm run dev
```

---

## Related Projects

| Project | Description |
|---------|-------------|
| [MRMD Electron](https://github.com/MaximeRivest/mrmd-electron) | Desktop app (macOS, Windows, Linux) |
| [mrmd-python](https://github.com/MaximeRivest/mrmd-python) | Python execution runtime |
| [mrmd-editor](https://github.com/MaximeRivest/mrmd-editor) | CodeMirror-based editor component |
| [mrmd-sync](https://github.com/MaximeRivest/mrmd-sync) | Yjs collaboration server |

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <b>MRMD Server</b> — Your notebooks, anywhere.
</p>
