/**
 * Session API routes
 *
 * Mirrors electronAPI.session.*
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import net from 'net';

// Session registry: sessionName -> { port, process, venv, cwd }
const sessions = new Map();

/**
 * Create session routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createSessionRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/session
   * List all running sessions
   * Mirrors: electronAPI.session.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = [];
      for (const [name, session] of sessions) {
        list.push({
          name,
          port: session.port,
          venv: session.venv,
          cwd: session.cwd,
          running: session.process && !session.process.killed,
        });
      }
      res.json(list);
    } catch (err) {
      console.error('[session:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/session
   * Start a new session
   * Mirrors: electronAPI.session.start(config)
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;
      const { name, venv, cwd } = config || {};

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
            venv: existing.venv,
            cwd: existing.cwd,
            reused: true,
          });
        }
      }

      // Find free port
      const port = await findFreePort(8001, 8100);

      // Determine Python path
      let pythonPath = 'python3';
      let resolvedVenv = null;

      if (venv) {
        resolvedVenv = path.resolve(ctx.projectDir, venv);
        const venvPython = path.join(resolvedVenv, 'bin', 'python');
        try {
          await fs.access(venvPython);
          pythonPath = venvPython;
        } catch {
          console.warn(`[session] Venv python not found: ${venvPython}`);
        }
      }

      // Start mrmd-python
      const workDir = cwd ? path.resolve(ctx.projectDir, cwd) : ctx.projectDir;

      // Try to find mrmd-python package
      const mrmdPythonPaths = [
        path.join(ctx.projectDir, '../mrmd-python'),
        path.join(process.cwd(), '../mrmd-python'),
        path.join(process.cwd(), 'mrmd-python'),
      ];

      let mrmdPythonPath = null;
      for (const p of mrmdPythonPaths) {
        try {
          await fs.access(path.join(p, 'src', 'mrmd_python'));
          mrmdPythonPath = p;
          break;
        } catch {}
      }

      let proc;
      if (mrmdPythonPath) {
        // Run with uv
        proc = spawn('uv', [
          'run', '--project', mrmdPythonPath,
          'python', '-m', 'mrmd_python.cli',
          '--port', port.toString(),
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONPATH: path.join(mrmdPythonPath, 'src') },
        });
      } else {
        // Fallback: assume mrmd-python is installed
        proc = spawn(pythonPath, [
          '-m', 'mrmd_python.cli',
          '--port', port.toString(),
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      // Wait for server to start
      await waitForPort(port, 15000);

      sessions.set(name, {
        port,
        process: proc,
        venv: resolvedVenv,
        cwd: workDir,
      });

      proc.on('exit', (code) => {
        console.log(`[session] ${name} exited with code ${code}`);
        sessions.delete(name);
      });

      res.json({
        name,
        port,
        venv: resolvedVenv,
        cwd: workDir,
        url: `http://localhost:${port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[session:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/session/:name
   * Stop a session
   * Mirrors: electronAPI.session.stop(sessionName)
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
      console.error('[session:stop]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/session/:name/restart
   * Restart a session
   * Mirrors: electronAPI.session.restart(sessionName)
   */
  router.post('/:name/restart', async (req, res) => {
    try {
      const { name } = req.params;
      const session = sessions.get(name);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Kill existing
      if (session.process && !session.process.killed) {
        session.process.kill();
      }

      // Re-create with same config
      req.body.config = { name, venv: session.venv, cwd: session.cwd };
      sessions.delete(name);

      // Forward to start handler
      // (In a real implementation, extract the logic to a shared function)
      return router.handle(req, res, () => {});
    } catch (err) {
      console.error('[session:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/session/for-document
   * Get or create session for a document
   * Mirrors: electronAPI.session.forDocument(documentPath)
   */
  router.post('/for-document', async (req, res) => {
    try {
      const { documentPath } = req.body;
      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      // Use document name as session name
      const docName = path.basename(documentPath, '.md');

      // Check if session exists
      if (sessions.has(docName)) {
        const session = sessions.get(docName);
        return res.json({
          name: docName,
          port: session.port,
          venv: session.venv,
          cwd: session.cwd,
          url: `http://localhost:${session.port}/mrp/v1`,
        });
      }

      // Try to read venv from document frontmatter or project config
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
      req.body.config = {
        name: docName,
        venv,
        cwd: path.dirname(fullPath),
      };

      // Re-use the POST / handler logic
      // (simplified - in production extract to shared function)
      const { config } = req.body;
      const port = await findFreePort(8001, 8100);
      const workDir = config.cwd || ctx.projectDir;

      // Start with default Python for now
      const proc = spawn('uv', [
        'run', 'python', '-m', 'mrmd_python.cli',
        '--port', port.toString(),
      ], {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      await waitForPort(port, 15000);

      sessions.set(docName, {
        port,
        process: proc,
        venv,
        cwd: workDir,
      });

      res.json({
        name: docName,
        port,
        venv,
        cwd: workDir,
        url: `http://localhost:${port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[session:forDocument]', err);
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
