/**
 * Express server that mirrors Electron's electronAPI
 *
 * Uses services from mrmd-electron for full feature parity.
 */

import express from 'express';
import cors from 'cors';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

import { createAuthMiddleware, generateToken } from './auth.js';
import { EventBus } from './events.js';
import { createProjectRoutes } from './api/project.js';
import { createSessionRoutes } from './api/session.js';
import { createBashRoutes } from './api/bash.js';
import { createFileRoutes } from './api/file.js';
import { createAssetRoutes } from './api/asset.js';
import { createSystemRoutes } from './api/system.js';
import { createRuntimeRoutes } from './api/runtime.js';
import { createJuliaRoutes } from './api/julia.js';
import { createPtyRoutes } from './api/pty.js';
import { createNotebookRoutes } from './api/notebook.js';
import { createSettingsRoutes } from './api/settings.js';
import { createRRoutes } from './api/r.js';
import { setupWebSocket } from './websocket.js';

// Cloud mode: use CloudSessionService that connects to a pre-existing runtime container
import CloudSessionService from './cloud-session-service.js';

// Import services from mrmd-electron (pure Node.js, no Electron deps)
import {
  ProjectService,
  SessionService,
  BashSessionService,
  PtySessionService,
  FileService,
  AssetService,
  SettingsService,
} from './services.js';

// Enhanced session services: support vendor-bundled, env-override, and remote runtimes
import {
  RSessionService,
  JuliaSessionService,
} from './enhanced-session-services.js';

// Import sync manager for dynamic project handling
import {
  acquireSyncServer,
  releaseSyncServer,
  getSyncServer,
  listSyncServers,
  stopAllSyncServers,
  onSyncDeath,
} from './sync-manager.js';

// Import AI service for mrmd-ai server management
import { stopAiServer } from './ai-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} ServerConfig
 * @property {number} port - HTTP port (default: 8080)
 * @property {string} host - Bind host (default: '0.0.0.0')
 * @property {string} projectDir - Root project directory
 * @property {string} [token] - Auth token (generated if not provided)
 * @property {boolean} [noAuth] - Disable auth (for local dev only!)
 * @property {string} [staticDir] - Custom static files directory
 * @property {string} [electronDir] - Path to mrmd-electron for index.html
 * @property {number} [syncPort] - mrmd-sync port (default: 4444)
 * @property {number} [pythonPort] - mrmd-python port (default: 8000)
 * @property {number} [aiPort] - mrmd-ai port (default: 51790)
 */

/**
 * Create the mrmd server (async)
 * @param {ServerConfig} config
 */
export async function createServer(config) {
  const {
    port = 8080,
    host = '0.0.0.0',
    projectDir,
    token: configuredToken,
    noAuth = false,
    staticDir,
    electronDir,
    syncPort = 4444,
    pythonPort = 8000,
    aiPort = 51790,
  } = config;
  const token = (
    typeof configuredToken === 'string' &&
    configuredToken.trim() !== '' &&
    configuredToken !== 'null' &&
    configuredToken !== 'undefined'
  ) ? configuredToken : generateToken();

  // projectDir is optional now - dynamic project detection is supported
  if (!projectDir) {
    console.log('[server] No projectDir specified - dynamic project detection enabled');
  }

  const app = express();
  const server = createHttpServer(app);
  const eventBus = new EventBus();

  // Cloud mode: connect to pre-existing runtime container instead of spawning locally
  const cloudMode = process.env.CLOUD_MODE === '1';
  const runtimePort = parseInt(process.env.RUNTIME_PORT || '0', 10);

  // Instantiate services from mrmd-electron
  const projectService = new ProjectService();
  const runtimeHost = process.env.RUNTIME_HOST || '127.0.0.1';
  const sessionService = cloudMode && runtimePort
    ? new CloudSessionService(runtimePort, runtimeHost)
    : new SessionService();
  const bashSessionService = new BashSessionService();
  const rSessionService = new RSessionService();
  const juliaSessionService = new JuliaSessionService();
  const ptySessionService = new PtySessionService();
  const fileService = new FileService();
  const assetService = new AssetService();
  const settingsService = new SettingsService();

  // Import API keys from environment variables into settings
  // This lets users run: ANTHROPIC_API_KEY=sk-ant-... mrmd-server
  importApiKeysFromEnv(settingsService);

  // Service context passed to all route handlers
  const context = {
    // Legacy: fixed project dir (for backwards compat, may be null)
    projectDir: projectDir ? path.resolve(projectDir) : null,
    syncPort,
    pythonPort,
    aiPort,
    eventBus,

    // Services from mrmd-electron
    projectService,
    sessionService,
    bashSessionService,
    rSessionService,
    juliaSessionService,
    ptySessionService,
    fileService,
    assetService,
    settingsService,

    // Sync server management (dynamic per-project)
    acquireSyncServer,
    releaseSyncServer,
    getSyncServer,
    listSyncServers,

    // Legacy: process tracking (kept for backwards compat)
    syncProcess: null,
    pythonProcess: null,
    monitorProcesses: new Map(),
    watchers: new Map(),
    pythonReady: false,
  };

  // Register for sync death notifications and broadcast via WebSocket
  onSyncDeath((message) => {
    eventBus.emit('sync-server-died', message);
  });

  // Middleware
  app.use(cors({
    origin: true,
    credentials: true,
  }));
  app.use(express.json({ limit: '50mb' }));

  // Auth middleware (skip for static files and health check)
  const authMiddleware = createAuthMiddleware(token, noAuth);
  app.use('/api', authMiddleware);

  // Health check (no auth)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Token info endpoint (no auth - used to validate tokens)
  app.get('/auth/validate', (req, res) => {
    const providedToken = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    if (noAuth || providedToken === token) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false });
    }
  });

  // API routes - mirror electronAPI structure
  app.use('/api/project', createProjectRoutes(context));
  app.use('/api/session', createSessionRoutes(context));
  app.use('/api/bash', createBashRoutes(context));
  app.use('/api/file', createFileRoutes(context));
  app.use('/api/asset', createAssetRoutes(context));
  app.use('/api/system', createSystemRoutes(context));
  app.use('/api/runtime', createRuntimeRoutes(context));
  app.use('/api/julia', createJuliaRoutes(context));
  app.use('/api/pty', createPtyRoutes(context));
  app.use('/api/notebook', createNotebookRoutes(context));
  app.use('/api/settings', createSettingsRoutes(context));
  app.use('/api/r', createRRoutes(context));

  // Proxy for localhost services (bash, pty, ai, etc.)
  // Routes /proxy/:port/* to the correct host
  // Runtime port routes to runtimeHost (may be remote after CRIU migration)
  // All other ports route to 127.0.0.1 (local services like bash, pty, ai)
  // IMPORTANT: Forwards X-Api-Key-* headers for AI providers
  app.use('/proxy/:port', async (req, res) => {
    const { port } = req.params;
    const targetPath = req.url; // Includes query string
    // Route runtime traffic to the (possibly remote) runtime host
    const host = (sessionService.runtimeHost && parseInt(port) === sessionService.runtimePort)
      ? sessionService.runtimeHost : '127.0.0.1';
    const targetUrl = `http://${host}:${port}${targetPath}`;

    // Build headers - forward all relevant headers including API keys
    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept': req.headers['accept'] || '*/*',
    };

    // Forward X-* headers (API keys, juice level, model override, etc.)
    // Note: Express lowercases header names, but HTTP headers are case-insensitive
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase().startsWith('x-')) {
        forwardHeaders[key] = value;
      }
    }

    // Debug: log API key headers being forwarded
    const apiKeyHeaders = Object.keys(forwardHeaders).filter(k => k.toLowerCase().includes('api-key'));
    if (apiKeyHeaders.length > 0) {
      console.log(`[proxy] Forwarding ${apiKeyHeaders.length} API key headers:`, apiKeyHeaders.map(k => `${k}=***${forwardHeaders[k]?.slice(-4)}`));
    } else if (targetPath.includes('Predict')) {
      console.log(`[proxy] WARNING: No API key headers found for AI request. Incoming headers:`, Object.keys(req.headers).filter(k => k.startsWith('x-')));
    }

    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      // Forward response headers
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      // Forward response body as raw bytes (important for binary assets like PNGs)
      const data = Buffer.from(await response.arrayBuffer());
      res.send(data);
    } catch (err) {
      console.error(`[proxy] Failed to proxy to ${targetUrl}:`, err.message);
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
  });

  // Serve http-shim.js
  app.get('/http-shim.js', (req, res) => {
    res.sendFile(path.join(__dirname, '../static/http-shim.js'));
  });

  // Find mrmd-electron directory for UI assets
  const electronPath = electronDir || findElectronDir(__dirname);

  if (electronPath) {
    // Serve mrmd-electron assets (fonts, icons)
    app.use('/assets', express.static(path.join(electronPath, 'assets')));

    // Serve mrmd-editor dist - check multiple locations
    const editorDistCandidates = [
      path.join(electronPath, 'editor'),  // Bundled in mrmd-electron (npm)
      path.join(electronPath, '../mrmd-editor/dist'),  // Sibling (dev mode)
    ];
    for (const distPath of editorDistCandidates) {
      if (existsSync(path.join(distPath, 'mrmd.iife.js'))) {
        app.use('/mrmd-editor/dist', express.static(distPath));
        app.use('/dist', express.static(distPath));
        break;
      }
    }

    // Serve node_modules for xterm, etc. - check multiple locations (npm hoisting)
    const nodeModulesCandidates = [
      path.join(electronPath, 'node_modules'),  // Direct dependency
      path.join(electronPath, '..'),  // Hoisted to parent (npm installed)
      path.join(__dirname, '../node_modules'),  // mrmd-server's node_modules
      path.join(__dirname, '../../node_modules'),  // Hoisted further up
    ];
    for (const nmPath of nodeModulesCandidates) {
      if (existsSync(path.join(nmPath, 'xterm'))) {
        app.use('/node_modules', express.static(nmPath));
        break;
      }
    }

    // Serve transformed index.html at root
    app.get('/', async (req, res) => {
      try {
        const indexPath = path.join(electronPath, 'index.html');
        let html = await fs.readFile(indexPath, 'utf-8');

        // Transform for browser mode:
        // 1. Inject http-shim.js as first script in head
        // 2. Update CSP to allow HTTP connections to this server
        // 3. Fix relative paths for HTTP serving
        html = transformIndexHtml(html, host, port);

        res.type('html').send(html);
      } catch (err) {
        console.error('[index.html]', err);
        res.sendFile(path.join(__dirname, '../static/index.html'));
      }
    });
  } else {
    // Fallback: serve placeholder
    console.warn('[server] mrmd-electron not found, serving placeholder UI');
    app.use(express.static(path.join(__dirname, '../static')));
  }

  // Serve custom static files if provided
  if (staticDir) {
    app.use(express.static(staticDir));
  }

  // ── Raw project file serving ──────────────────────────────────────────
  // Serves project files (images, assets, generated plots) over HTTP.
  // Used by the asset resolver in browser mode instead of file:// URLs.
  // GET /api/project-file?path=relative/path/to/file.png
  app.get('/api/project-file', (req, res) => {
    try {
      const relPath = req.query.path;
      if (!relPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      // Resolve from project directory, prevent path traversal
      const resolved = path.resolve(projectDir, relPath);
      if (!resolved.startsWith(path.resolve(projectDir))) {
        return res.status(403).json({ error: 'Path traversal not allowed' });
      }

      if (!existsSync(resolved)) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.sendFile(resolved);
    } catch (err) {
      console.error('[project-file]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // WebSocket for push events (noServer to avoid duplicate upgrade handlers)
  const wss = new WebSocketServer({ noServer: true });
  setupWebSocket(wss, eventBus, token, noAuth);

  // WebSocket proxy for sync connections (remote browsers can't reach localhost)
  const syncWss = new WebSocketServer({ noServer: true });

  // Single upgrade handler for all WebSocket connections
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');

    // Handle /events normally
    if (url.pathname === '/events') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }

    // Handle /sync/:port/:path - proxy to local server (sync, pty, etc.)
    const syncMatch = url.pathname.match(/^\/sync\/(\d+)\/(.+)$/);
    if (syncMatch) {
      const [, syncPort, pathPart] = syncMatch;
      // Preserve query string for PTY sessions
      const targetUrl = `ws://127.0.0.1:${syncPort}/${pathPart}${url.search}`;

      // Create connection to local sync server
      const upstream = new WsClient(targetUrl);

      upstream.on('open', () => {
        syncWss.handleUpgrade(request, socket, head, (clientWs) => {
          // Bidirectional proxy - preserve message type (binary/text)
          clientWs.on('message', (data, isBinary) => {
            upstream.send(data, { binary: isBinary });
          });
          upstream.on('message', (data, isBinary) => {
            clientWs.send(data, { binary: isBinary });
          });
          clientWs.on('close', () => upstream.close());
          upstream.on('close', () => clientWs.close());
          clientWs.on('error', () => upstream.close());
          upstream.on('error', () => clientWs.close());
        });
      });

      upstream.on('error', (err) => {
        console.error(`[sync-proxy] Failed to connect to ${targetUrl}:`, err.message);
        socket.destroy();
      });
      return;
    }

    // Unknown upgrade request
    socket.destroy();
  });

  return {
    app,
    server,
    context,
    eventBus,
    token,
    electronPath,

    /**
     * Start the server
     */
    async start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
          console.log('');
          console.log('\x1b[36m  mrmd-server\x1b[0m');
          console.log('  ' + '─'.repeat(50));
          console.log(`  Server:     ${url}`);
          console.log(`  Project:    ${context.projectDir}`);
          if (electronPath) {
            console.log(`  UI:         ${electronPath}`);
          }
          if (!noAuth) {
            console.log(`  Token:      ${token}`);
            console.log('');
            console.log(`  \x1b[33mAccess URL:\x1b[0m`);
            console.log(`  ${url}?token=${token}`);
          }
          console.log('');
          resolve({ url, token });
        });
      });
    },

    /**
     * Stop the server
     */
    async stop() {
      // Clean up watchers
      for (const watcher of context.watchers.values()) {
        await watcher.close();
      }

      // Stop all sync servers
      stopAllSyncServers();

      // Stop AI server
      stopAiServer();

      // Stop all sessions via services (if they have shutdown methods)
      try {
        if (typeof sessionService.shutdown === 'function') {
          await sessionService.shutdown();
        }
      } catch (e) {
        console.warn('[server] Error stopping sessions:', e.message);
      }
      try {
        if (typeof bashSessionService.shutdown === 'function') {
          await bashSessionService.shutdown();
        }
      } catch (e) {
        console.warn('[server] Error stopping bash sessions:', e.message);
      }
      try {
        if (typeof ptySessionService.shutdown === 'function') {
          await ptySessionService.shutdown();
        }
      } catch (e) {
        console.warn('[server] Error stopping pty sessions:', e.message);
      }

      // Legacy: kill child processes
      if (context.syncProcess) {
        context.syncProcess.kill();
      }
      if (context.pythonProcess) {
        context.pythonProcess.kill();
      }
      for (const proc of context.monitorProcesses.values()) {
        proc.kill();
      }

      // Close WebSocket connections
      wss.clients.forEach(client => client.close());

      // Close server
      return new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

/**
 * Find mrmd-electron directory
 */
function findElectronDir(fromDir) {
  const candidates = [
    // Development: sibling directories
    path.join(fromDir, '../../mrmd-electron'),
    path.join(fromDir, '../../../mrmd-electron'),
    path.join(process.cwd(), '../mrmd-electron'),
    path.join(process.cwd(), 'mrmd-electron'),
    // npm/npx: node_modules relative to mrmd-server package
    path.join(fromDir, '../node_modules/mrmd-electron'),
    path.join(fromDir, '../../node_modules/mrmd-electron'),
    // npm/npx: node_modules in cwd
    path.join(process.cwd(), 'node_modules/mrmd-electron'),
  ];

  // Also try require.resolve to find the package
  try {
    const electronPkg = path.dirname(require.resolve('mrmd-electron/package.json'));
    candidates.unshift(electronPkg);
  } catch (e) {
    // mrmd-electron not found via require, continue with path search
  }

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, 'index.html');
    if (existsSync(indexPath)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

/**
 * Transform index.html for browser mode
 * - Inject http-shim.js as first script
 * - Update CSP to allow HTTP connections
 * - Fix relative paths for HTTP serving
 */
function transformIndexHtml(html, host, port) {
  // 0. If BASE_PATH is set (cloud mode behind reverse proxy), inject <base> tag
  //    and use relative paths (no leading /) so <base> resolves them correctly
  const basePath = process.env.BASE_PATH || '';
  const baseTag = basePath ? `<base href="${basePath}">` : '';
  const pathPrefix = basePath ? '' : '/'; // relative in cloud, absolute otherwise

  // 1. Inject base tag + server URL config + http-shim.js right after <head>
  const serverUrl = basePath
    ? `${baseTag}\n  <script>window.MRMD_SERVER_URL = window.location.origin + "${basePath}";</script>`
    : '';
  const shimScript = `
  ${serverUrl}
  <!-- HTTP shim for browser mode (injected by mrmd-server) -->
  <script src="${pathPrefix}http-shim.js"></script>
`;
  html = html.replace('<head>', '<head>' + shimScript);

  // 2. Update CSP to allow connections to this server and any host
  const browserCSP = `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:; connect-src 'self' ws: wss: http: https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com blob: http:; font-src 'self' https://fonts.gstatic.com https://www.openresponses.org data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https:; img-src 'self' data: blob: https: http:; frame-src 'self' blob: data:`;

  html = html.replace(
    /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
    `<meta http-equiv="Content-Security-Policy" content="${browserCSP}">`
  );

  // 3. Remove Electron-specific CSS (window drag regions)
  html = html.replace(/-webkit-app-region:\s*drag;/g, '/* -webkit-app-region: drag; */');
  html = html.replace(/-webkit-app-region:\s*no-drag;/g, '/* -webkit-app-region: no-drag; */');

  // 4. Fix relative paths for HTTP serving
  // Use pathPrefix: "/" for direct access, "" for behind-proxy (relative + <base>)
  html = html.replace(/src=["']\.\.\/mrmd-editor\//g, `src="${pathPrefix}mrmd-editor/`);
  html = html.replace(/href=["']\.\.\/mrmd-editor\//g, `href="${pathPrefix}mrmd-editor/`);

  html = html.replace(/src=["']\.\/node_modules\//g, `src="${pathPrefix}node_modules/`);
  html = html.replace(/href=["']\.\/node_modules\//g, `href="${pathPrefix}node_modules/`);

  html = html.replace(/src=["']\.\/assets\//g, `src="${pathPrefix}assets/`);
  html = html.replace(/href=["']\.\/assets\//g, `href="${pathPrefix}assets/`);

  // 5. Patch asset resolver: replace file:// URLs with HTTP URLs
  //    In Electron, assets resolve to file:// which works.
  //    In browser mode, we serve them via /api/project-file?path=...
  html = html.replace(
    /const fileUrl = 'file:\/\/' \+ resolvedPath;/g,
    `// [mrmd-server] Patched: serve via HTTP instead of file://
        const projectRoot = state.project?.root || '';
        const relativePath = resolvedPath.startsWith(projectRoot)
          ? resolvedPath.slice(projectRoot.length).replace(/^\\//, '')
          : resolvedPath;
        const fileUrl = (window.MRMD_SERVER_URL || window.location.origin)
          + '/api/project-file?path=' + encodeURIComponent(relativePath)
          + (window.MRMD_TOKEN ? '&token=' + window.MRMD_TOKEN : '');`
  );

  return html;
}

/**
 * Import API keys from environment variables into settings.
 * Only imports if the env var is set and the settings key is empty.
 * This allows: ANTHROPIC_API_KEY=sk-ant-... mrmd-server
 */
function importApiKeysFromEnv(settingsService) {
  const envMapping = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };

  settingsService.load();
  let imported = 0;

  for (const [provider, envVar] of Object.entries(envMapping)) {
    const envValue = process.env[envVar];
    if (envValue) {
      const existing = settingsService.getApiKey(provider);
      if (!existing) {
        settingsService.setApiKey(provider, envValue);
        console.log(`[server] Imported ${envVar} from environment into settings`);
        imported++;
      }
    }
  }

  if (imported > 0) {
    console.log(`[server] Imported ${imported} API key(s) from environment`);
  }
}

/**
 * Convenience function to create and start server
 * @param {ServerConfig} config
 */
export async function startServer(config) {
  const server = await createServer(config);
  await server.start();
  return server;
}
