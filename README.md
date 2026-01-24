# mrmd-server

Run mrmd in any browser. Access your notebooks from anywhere.

```
┌─────────────────────────────────────────────────────────────┐
│                    Your VPS / Cloud Server                   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                    mrmd-server                       │   │
│   │  • HTTP API (full electronAPI equivalent)           │   │
│   │  • Static file serving                              │   │
│   │  • WebSocket for real-time events                   │   │
│   │  • Token authentication                             │   │
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

## Features

- **Same UI as Electron** - Uses the exact same index.html from mrmd-electron
- **Access from anywhere** - Phone, tablet, any browser
- **Real-time collaboration** - Yjs sync works over WebSocket
- **Token authentication** - Secure access with shareable links
- **Portable compute** - Move your disk to a GPU server when needed

## Quick Start

```bash
# Install
cd mrmd-packages/mrmd-server
npm install

# Start server in your project directory
npx mrmd-server ./my-notebooks

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

## Usage

### Basic Usage

```bash
# Start in current directory
mrmd-server

# Start in specific directory
mrmd-server ./my-project

# Custom port
mrmd-server -p 3000 ./my-project

# With specific token
mrmd-server -t my-secret-token ./my-project

# No auth (local development only!)
mrmd-server --no-auth ./my-project
```

### Remote Access

1. Start mrmd-server on your VPS:
   ```bash
   mrmd-server -p 8080 /home/you/notebooks
   ```

2. Set up HTTPS (recommended) with nginx or caddy:
   ```nginx
   server {
       listen 443 ssl;
       server_name notebooks.example.com;

       location / {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```

3. Access from anywhere:
   ```
   https://notebooks.example.com?token=YOUR_TOKEN
   ```

### Share with Collaborators

Just share the URL with the token:
```
https://your-server.com?token=abc123xyz
```

Collaborators get:
- Real-time collaborative editing (Yjs)
- Code execution (via the server)
- Same UI as local Electron app

## Architecture

mrmd-server provides an HTTP API that mirrors Electron's IPC interface:

| Electron (IPC) | mrmd-server (HTTP) |
|----------------|-------------------|
| `electronAPI.project.get(path)` | `GET /api/project?path=...` |
| `electronAPI.file.write(path, content)` | `POST /api/file/write` |
| `electronAPI.session.forDocument(path)` | `POST /api/session/for-document` |
| `ipcRenderer.on('project:changed', cb)` | WebSocket `/events` |

The browser loads `http-shim.js` which creates a `window.electronAPI` object that makes HTTP calls instead of IPC calls. The existing UI code works unchanged.

## API Reference

### Authentication

All API endpoints (except `/health` and `/auth/validate`) require authentication.

Provide token via:
- Query parameter: `?token=xxx`
- Header: `Authorization: Bearer xxx`
- Header: `X-Token: xxx`

### Endpoints

#### System
- `GET /api/system/home` - Get home directory
- `GET /api/system/recent` - Get recent files/venvs
- `GET /api/system/ai` - Get AI server info
- `POST /api/system/discover-venvs` - Start venv discovery

#### Project
- `GET /api/project?path=...` - Get project info
- `POST /api/project` - Create project
- `GET /api/project/nav?root=...` - Get navigation tree
- `POST /api/project/watch` - Watch for changes
- `POST /api/project/unwatch` - Stop watching

#### Session
- `GET /api/session` - List sessions
- `POST /api/session` - Start session
- `DELETE /api/session/:name` - Stop session
- `POST /api/session/for-document` - Get/create session for document

#### Bash
- Same as Session, at `/api/bash/*`

#### File
- `GET /api/file/scan` - Scan for files
- `POST /api/file/create` - Create file
- `POST /api/file/create-in-project` - Create with FSML ordering
- `POST /api/file/move` - Move/rename
- `POST /api/file/reorder` - Drag-drop reorder
- `DELETE /api/file?path=...` - Delete file
- `GET /api/file/read?path=...` - Read file
- `POST /api/file/write` - Write file

#### Asset
- `GET /api/asset` - List assets
- `POST /api/asset/save` - Upload asset
- `GET /api/asset/relative-path` - Calculate relative path
- `GET /api/asset/orphans` - Find orphaned assets
- `DELETE /api/asset` - Delete asset

#### Runtime
- `GET /api/runtime` - List runtimes
- `DELETE /api/runtime/:id` - Kill runtime
- `POST /api/runtime/:id/attach` - Attach to runtime

### WebSocket Events

Connect to `/events?token=xxx` to receive push events:

```javascript
const ws = new WebSocket('wss://server.com/events?token=xxx');
ws.onmessage = (e) => {
  const { event, data } = JSON.parse(e.data);
  // event: 'project:changed', 'venv-found', 'sync-server-died', etc.
};
```

## Security Considerations

1. **Always use HTTPS** in production (use nginx/caddy as reverse proxy)
2. **Keep tokens secret** - treat them like passwords
3. **Use `--no-auth` only for local development**
4. **Rotate tokens** if compromised

## Limitations

Some Electron features can't work in browser:

| Feature | Browser Behavior |
|---------|------------------|
| `shell.showItemInFolder` | Returns path (can't open Finder) |
| `shell.openPath` | Returns path (can't open local apps) |
| Native titlebar | Standard browser chrome |
| Offline | Requires server connection |

## Development

```bash
# Run in dev mode
npm run dev

# The server will:
# - Watch for file changes
# - Auto-restart on changes
```

## License

MIT
