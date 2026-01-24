/**
 * mrmd-server v2 - Uses shared handlers from mrmd-electron
 *
 * This version imports the handler definitions from mrmd-electron,
 * so any new handlers added there automatically work here.
 */

import express from 'express';
import cors from 'cors';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAuthMiddleware, generateToken } from './auth.js';
import { EventBus } from './events.js';
import { setupWebSocket } from './websocket.js';

// Import shared handlers from mrmd-electron
import {
  handlers,
  registerHttpHandlers,
  generateHttpShim,
} from '../../mrmd-electron/src/handlers/index.js';

// Import services (these could also be shared)
import { ProjectService } from '../../mrmd-electron/src/services/project-service.js';
import { FileService } from '../../mrmd-electron/src/services/file-service.js';
// ... other services

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create the mrmd server using shared handlers
 */
export function createServerV2(config) {
  const {
    port = 8080,
    host = '0.0.0.0',
    projectDir,
    token = generateToken(),
    noAuth = false,
  } = config;

  if (!projectDir) {
    throw new Error('projectDir is required');
  }

  const app = express();
  const server = createHttpServer(app);
  const eventBus = new EventBus();

  // Initialize services (same as Electron would)
  const projectService = new ProjectService(projectDir);
  const fileService = new FileService(projectDir);
  // ... initialize other services

  // Create context (same shape as Electron's context)
  const context = {
    projectDir: path.resolve(projectDir),
    projectService,
    fileService,
    // sessionService,
    // bashService,
    // assetService,
    // venvService,
    // pythonService,
    // runtimeService,
    eventBus,
    // shell: null, // No shell in server mode
  };

  // Middleware
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '50mb' }));

  // Auth
  const authMiddleware = createAuthMiddleware(token, noAuth);
  app.use('/api', authMiddleware);

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Register ALL handlers from mrmd-electron automatically!
  registerHttpHandlers(app, context);

  // Serve auto-generated http-shim.js
  app.get('/http-shim.js', (req, res) => {
    res.type('application/javascript');
    res.send(generateHttpShim());
  });

  // WebSocket for events
  const wss = new WebSocketServer({ server, path: '/events' });
  setupWebSocket(wss, eventBus, token, noAuth);

  return {
    app,
    server,
    context,
    token,

    async start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          console.log(`mrmd-server running at http://${host}:${port}`);
          console.log(`Token: ${token}`);
          resolve({ url: `http://${host}:${port}`, token });
        });
      });
    },

    async stop() {
      wss.clients.forEach(client => client.close());
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
