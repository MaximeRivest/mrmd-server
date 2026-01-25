/**
 * Express server that mirrors Electron's electronAPI
 */

import express from 'express';
import cors from 'cors';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

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
import { setupWebSocket } from './websocket.js';

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
    token = generateToken(),
    noAuth = false,
    staticDir,
    electronDir,
    syncPort = 4444,
    pythonPort = 8000,
    aiPort = 51790,
  } = config;

  if (!projectDir) {
    throw new Error('projectDir is required');
  }

  const app = express();
  const server = createHttpServer(app);
  const eventBus = new EventBus();

  // Service context passed to all route handlers
  const context = {
    projectDir: path.resolve(projectDir),
    syncPort,
    pythonPort,
    aiPort,
    eventBus,
    // These will be populated by services
    syncProcess: null,
    pythonProcess: null,
    monitorProcesses: new Map(),
    watchers: new Map(),
  };

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

  // Serve http-shim.js
  app.get('/http-shim.js', (req, res) => {
    res.sendFile(path.join(__dirname, '../static/http-shim.js'));
  });

  // Find mrmd-electron directory for UI assets
  const electronPath = electronDir || findElectronDir(__dirname);

  if (electronPath) {
    // Serve mrmd-electron assets (fonts, icons)
    app.use('/assets', express.static(path.join(electronPath, 'assets')));

    // Serve mrmd-editor dist
    const editorDistPath = path.join(electronPath, '../mrmd-editor/dist');
    app.use('/dist', express.static(editorDistPath));

    // Serve transformed index.html at root
    app.get('/', async (req, res) => {
      try {
        const indexPath = path.join(electronPath, 'index.html');
        let html = await fs.readFile(indexPath, 'utf-8');

        // Transform for browser mode:
        // 1. Inject http-shim.js as first script in head
        // 2. Update CSP to allow HTTP connections to this server
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

  // WebSocket for push events
  const wss = new WebSocketServer({ server, path: '/events' });
  setupWebSocket(wss, eventBus, token, noAuth);

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

      // Kill child processes
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
    path.join(fromDir, '../../mrmd-electron'),
    path.join(fromDir, '../../../mrmd-electron'),
    path.join(process.cwd(), '../mrmd-electron'),
    path.join(process.cwd(), 'mrmd-electron'),
    // In npx/installed context, it might be in node_modules
    path.join(fromDir, '../../node_modules/mrmd-electron'),
    path.join(process.cwd(), 'node_modules/mrmd-electron'),
  ];

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
 */
function transformIndexHtml(html, host, port) {
  // 1. Inject http-shim.js right after <head>
  const shimScript = `
  <!-- HTTP shim for browser mode (injected by mrmd-server) -->
  <script src="/http-shim.js"></script>
`;
  html = html.replace('<head>', '<head>' + shimScript);

  // 2. Update CSP to allow connections to this server and any host
  // Replace the strict CSP with a more permissive one for HTTP mode
  const browserCSP = `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:; connect-src 'self' ws: wss: http: https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com blob: http:; font-src 'self' https://fonts.gstatic.com https://www.openresponses.org data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https:; img-src 'self' data: blob: https: http:; frame-src 'self' blob: data:`;

  html = html.replace(
    /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
    `<meta http-equiv="Content-Security-Policy" content="${browserCSP}">`
  );

  // 3. Remove Electron-specific CSS (window drag regions)
  html = html.replace(/-webkit-app-region:\s*drag;/g, '/* -webkit-app-region: drag; */');
  html = html.replace(/-webkit-app-region:\s*no-drag;/g, '/* -webkit-app-region: no-drag; */');

  return html;
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
