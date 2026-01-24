/**
 * Bash Session API routes
 *
 * Mirrors electronAPI.bash.*
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import net from 'net';

// Bash session registry
const bashSessions = new Map();

/**
 * Create bash routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createBashRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/bash
   * List all running bash sessions
   * Mirrors: electronAPI.bash.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = [];
      for (const [name, session] of bashSessions) {
        list.push({
          name,
          port: session.port,
          cwd: session.cwd,
          running: session.process && !session.process.killed,
        });
      }
      res.json(list);
    } catch (err) {
      console.error('[bash:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/bash
   * Start a new bash session
   * Mirrors: electronAPI.bash.start(config)
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;
      const { name, cwd } = config || {};

      if (!name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      // Check if session already exists
      if (bashSessions.has(name)) {
        const existing = bashSessions.get(name);
        if (existing.process && !existing.process.killed) {
          return res.json({
            name,
            port: existing.port,
            cwd: existing.cwd,
            reused: true,
          });
        }
      }

      // Find free port
      const port = await findFreePort(8101, 8200);

      const workDir = cwd ? path.resolve(ctx.projectDir, cwd) : ctx.projectDir;

      // Try to find mrmd-bash package
      const mrmdBashPaths = [
        path.join(ctx.projectDir, '../mrmd-bash'),
        path.join(process.cwd(), '../mrmd-bash'),
        path.join(process.cwd(), 'mrmd-bash'),
      ];

      let mrmdBashPath = null;
      for (const p of mrmdBashPaths) {
        try {
          const fs = await import('fs/promises');
          await fs.access(path.join(p, 'pyproject.toml'));
          mrmdBashPath = p;
          break;
        } catch {}
      }

      let proc;
      if (mrmdBashPath) {
        proc = spawn('uv', [
          'run', '--project', mrmdBashPath,
          'mrmd-bash',
          '--port', port.toString(),
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        // Fallback: assume mrmd-bash is installed
        proc = spawn('mrmd-bash', [
          '--port', port.toString(),
        ], {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      // Wait for server to start
      await waitForPort(port, 15000);

      bashSessions.set(name, {
        port,
        process: proc,
        cwd: workDir,
      });

      proc.on('exit', (code) => {
        console.log(`[bash] ${name} exited with code ${code}`);
        bashSessions.delete(name);
      });

      res.json({
        name,
        port,
        cwd: workDir,
        url: `http://localhost:${port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[bash:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/bash/:name
   * Stop a bash session
   * Mirrors: electronAPI.bash.stop(sessionName)
   */
  router.delete('/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const session = bashSessions.get(name);

      if (!session) {
        return res.json({ success: true, message: 'Session not found' });
      }

      if (session.process && !session.process.killed) {
        session.process.kill();
      }

      bashSessions.delete(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[bash:stop]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/bash/:name/restart
   * Restart a bash session
   * Mirrors: electronAPI.bash.restart(sessionName)
   */
  router.post('/:name/restart', async (req, res) => {
    try {
      const { name } = req.params;
      const session = bashSessions.get(name);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Kill existing
      if (session.process && !session.process.killed) {
        session.process.kill();
      }

      bashSessions.delete(name);

      // Re-create
      req.body.config = { name, cwd: session.cwd };

      // Use the POST handler
      const handler = router.stack.find(r => r.route?.path === '/' && r.route.methods.post);
      if (handler) {
        return handler.route.stack[0].handle(req, res);
      }

      res.status(500).json({ error: 'Could not restart' });
    } catch (err) {
      console.error('[bash:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/bash/for-document
   * Get or create bash session for a document
   * Mirrors: electronAPI.bash.forDocument(documentPath)
   */
  router.post('/for-document', async (req, res) => {
    try {
      const { documentPath } = req.body;
      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      const docName = `bash-${path.basename(documentPath, '.md')}`;

      // Check if session exists
      if (bashSessions.has(docName)) {
        const session = bashSessions.get(docName);
        return res.json({
          name: docName,
          port: session.port,
          cwd: session.cwd,
          url: `http://localhost:${session.port}/mrp/v1`,
        });
      }

      // Create session in document's directory
      const fullPath = path.resolve(ctx.projectDir, documentPath);
      req.body.config = {
        name: docName,
        cwd: path.dirname(fullPath),
      };

      // Use the POST handler
      const handler = router.stack.find(r => r.route?.path === '/' && r.route.methods.post);
      if (handler) {
        return handler.route.stack[0].handle(req, res);
      }

      res.status(500).json({ error: 'Could not create session' });
    } catch (err) {
      console.error('[bash:forDocument]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

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
