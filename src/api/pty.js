/**
 * PTY Session API routes (for ```term blocks)
 *
 * Mirrors electronAPI.pty.*
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import net from 'net';

// Session registry: sessionName -> { port, process, cwd, venv, wsUrl }
const sessions = new Map();

/**
 * Create PTY routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createPtyRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/pty
   * List all running PTY sessions
   * Mirrors: electronAPI.pty.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = [];
      for (const [name, session] of sessions) {
        list.push({
          name,
          port: session.port,
          cwd: session.cwd,
          venv: session.venv,
          wsUrl: session.wsUrl,
          running: session.process && !session.process.killed,
        });
      }
      res.json(list);
    } catch (err) {
      console.error('[pty:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/pty
   * Start a new PTY session (mrmd-pty server)
   * Mirrors: electronAPI.pty.start(config)
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;
      const { name, cwd, venv } = config || {};

      if (!name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      // Check if session already exists
      if (sessions.has(name)) {
        const existing = sessions.get(name);
        if (existing.process && !existing.process.killed) {
          return res.json({
            name,
            port: existing.port,
            cwd: existing.cwd,
            venv: existing.venv,
            wsUrl: existing.wsUrl,
            reused: true,
            alive: true,
          });
        }
      }

      // Find free port
      const port = await findFreePort(7001, 7100);
      const workDir = cwd ? path.resolve(ctx.projectDir, cwd) : ctx.projectDir;

      // Find mrmd-pty package
      const mrmdPtyPaths = [
        path.join(ctx.projectDir, '../mrmd-pty'),
        path.join(process.cwd(), '../mrmd-pty'),
        path.join(process.cwd(), 'mrmd-pty'),
        path.join(__dirname, '../../../mrmd-pty'),
      ];

      let mrmdPtyPath = null;
      for (const p of mrmdPtyPaths) {
        try {
          await fs.access(path.join(p, 'package.json'));
          mrmdPtyPath = p;
          break;
        } catch {}
      }

      let proc;
      const env = { ...process.env };

      // If venv specified, activate it
      if (venv) {
        const venvPath = path.resolve(ctx.projectDir, venv);
        env.VIRTUAL_ENV = venvPath;
        env.PATH = `${path.join(venvPath, 'bin')}:${env.PATH}`;
      }

      if (mrmdPtyPath) {
        // Run mrmd-pty server
        proc = spawn('node', [
          path.join(mrmdPtyPath, 'src', 'server.js'),
          '--port', port.toString(),
          '--cwd', workDir,
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } else {
        // Fallback: Try to use npx
        proc = spawn('npx', [
          'mrmd-pty',
          '--port', port.toString(),
          '--cwd', workDir,
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      }

      // Wait for server to start
      try {
        await waitForPort(port, 10000);
      } catch (err) {
        proc.kill();
        return res.status(500).json({ error: `PTY server failed to start: ${err.message}` });
      }

      const wsUrl = `ws://localhost:${port}`;

      sessions.set(name, {
        port,
        process: proc,
        cwd: workDir,
        venv,
        wsUrl,
      });

      proc.on('exit', (code) => {
        console.log(`[pty] ${name} exited with code ${code}`);
        sessions.delete(name);
      });

      res.json({
        name,
        port,
        cwd: workDir,
        venv,
        wsUrl,
        alive: true,
      });
    } catch (err) {
      console.error('[pty:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/pty/:name
   * Stop a PTY session
   * Mirrors: electronAPI.pty.stop(sessionName)
   */
  router.delete('/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const session = sessions.get(name);

      if (!session) {
        return res.json({ success: true, message: 'Session not found' });
      }

      if (session.process && !session.process.killed) {
        session.process.kill();
      }

      sessions.delete(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[pty:stop]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/pty/:name/restart
   * Restart a PTY session
   * Mirrors: electronAPI.pty.restart(sessionName)
   */
  router.post('/:name/restart', async (req, res) => {
    try {
      const { name } = req.params;
      const session = sessions.get(name);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { cwd, venv } = session;

      // Kill existing
      if (session.process && !session.process.killed) {
        session.process.kill();
      }

      sessions.delete(name);

      // Create new session
      req.body.config = { name, cwd, venv };
      // Redirect to POST /
      return res.redirect(307, '/api/pty');
    } catch (err) {
      console.error('[pty:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/pty/for-document
   * Get or create PTY session for a document
   * Returns session info including wsUrl for WebSocket connection
   * Mirrors: electronAPI.pty.forDocument(documentPath)
   */
  router.post('/for-document', async (req, res) => {
    try {
      const { documentPath } = req.body;
      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      const docName = `pty-${path.basename(documentPath, '.md')}`;

      // Check if session exists
      if (sessions.has(docName)) {
        const session = sessions.get(docName);
        const alive = session.process && !session.process.killed;
        return res.json({
          name: docName,
          port: session.port,
          cwd: session.cwd,
          venv: session.venv,
          wsUrl: session.wsUrl,
          alive,
        });
      }

      // Try to read venv from document frontmatter
      const fullPath = path.resolve(ctx.projectDir, documentPath);
      let venv = null;

      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const match = content.match(/^---\n[\s\S]*?venv:\s*(.+?)[\n\r]/m);
        if (match) {
          venv = match[1].trim();
        }
      } catch {}

      // Create session
      const port = await findFreePort(7001, 7100);
      const workDir = path.dirname(fullPath);
      const env = { ...process.env };

      if (venv) {
        const venvPath = path.resolve(ctx.projectDir, venv);
        env.VIRTUAL_ENV = venvPath;
        env.PATH = `${path.join(venvPath, 'bin')}:${env.PATH}`;
      }

      // Try to start mrmd-pty
      const mrmdPtyPaths = [
        path.join(ctx.projectDir, '../mrmd-pty'),
        path.join(process.cwd(), '../mrmd-pty'),
      ];

      let mrmdPtyPath = null;
      for (const p of mrmdPtyPaths) {
        try {
          await fs.access(path.join(p, 'package.json'));
          mrmdPtyPath = p;
          break;
        } catch {}
      }

      let proc;
      if (mrmdPtyPath) {
        proc = spawn('node', [
          path.join(mrmdPtyPath, 'src', 'server.js'),
          '--port', port.toString(),
          '--cwd', workDir,
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } else {
        // mrmd-pty not found, return null
        return res.json(null);
      }

      try {
        await waitForPort(port, 10000);
      } catch (err) {
        proc.kill();
        return res.json(null);
      }

      const wsUrl = `ws://localhost:${port}`;

      sessions.set(docName, {
        port,
        process: proc,
        cwd: workDir,
        venv,
        wsUrl,
      });

      proc.on('exit', () => {
        sessions.delete(docName);
      });

      res.json({
        name: docName,
        port,
        cwd: workDir,
        venv,
        wsUrl,
        alive: true,
      });
    } catch (err) {
      console.error('[pty:forDocument]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Find a free port in range
 */
async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

/**
 * Check if port is free
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Wait for port to be open
 */
function waitForPort(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 200);
        }
      });
    }

    check();
  });
}
