/**
 * Julia Session API routes
 *
 * Mirrors electronAPI.julia.*
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import net from 'net';

// Session registry: sessionName -> { port, process, cwd }
const sessions = new Map();

/**
 * Create Julia routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createJuliaRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/julia
   * List all running Julia sessions
   * Mirrors: electronAPI.julia.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = [];
      for (const [name, session] of sessions) {
        list.push({
          name,
          port: session.port,
          cwd: session.cwd,
          running: session.process && !session.process.killed,
        });
      }
      res.json(list);
    } catch (err) {
      console.error('[julia:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/julia/available
   * Check if Julia is available on the system
   * Mirrors: electronAPI.julia.isAvailable()
   */
  router.get('/available', async (req, res) => {
    try {
      const available = await isJuliaAvailable();
      res.json({ available });
    } catch (err) {
      console.error('[julia:available]', err);
      res.json({ available: false });
    }
  });

  /**
   * POST /api/julia
   * Start a new Julia session
   * Mirrors: electronAPI.julia.start(config)
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;
      const { name, cwd } = config || {};

      if (!name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      // Check if Julia is available
      if (!await isJuliaAvailable()) {
        return res.status(503).json({ error: 'Julia is not available on this system' });
      }

      // Check if session already exists
      if (sessions.has(name)) {
        const existing = sessions.get(name);
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
      const port = await findFreePort(9001, 9100);
      const workDir = cwd ? path.resolve(ctx.projectDir, cwd) : ctx.projectDir;

      // Start Julia MRP server
      // Note: This assumes mrmd-julia is installed and provides an MRP-compatible server
      const proc = spawn('julia', [
        '-e',
        `using MrmdJulia; MrmdJulia.serve(${port})`,
      ], {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Wait for server to start (with timeout)
      try {
        await waitForPort(port, 15000);
      } catch (err) {
        proc.kill();
        return res.status(500).json({ error: `Julia server failed to start: ${err.message}` });
      }

      sessions.set(name, {
        port,
        process: proc,
        cwd: workDir,
      });

      proc.on('exit', (code) => {
        console.log(`[julia] ${name} exited with code ${code}`);
        sessions.delete(name);
      });

      res.json({
        name,
        port,
        cwd: workDir,
        url: `http://localhost:${port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[julia:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/julia/:name
   * Stop a Julia session
   * Mirrors: electronAPI.julia.stop(sessionName)
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
      console.error('[julia:stop]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/julia/:name/restart
   * Restart a Julia session
   * Mirrors: electronAPI.julia.restart(sessionName)
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

      // Re-create
      const cwd = session.cwd;
      sessions.delete(name);

      // Forward to start handler
      req.body.config = { name, cwd };
      // Recursively call POST /
      // In production, extract logic to shared function
      return res.redirect(307, '/api/julia');
    } catch (err) {
      console.error('[julia:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/julia/for-document
   * Get or create Julia session for a document
   * Mirrors: electronAPI.julia.forDocument(documentPath)
   */
  router.post('/for-document', async (req, res) => {
    try {
      const { documentPath } = req.body;
      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      // Check if Julia is available
      if (!await isJuliaAvailable()) {
        return res.json(null);
      }

      const docName = `julia-${path.basename(documentPath, '.md')}`;

      // Check if session exists
      if (sessions.has(docName)) {
        const session = sessions.get(docName);
        return res.json({
          name: docName,
          port: session.port,
          cwd: session.cwd,
          url: `http://localhost:${session.port}/mrp/v1`,
        });
      }

      // Create session
      const fullPath = path.resolve(ctx.projectDir, documentPath);
      const port = await findFreePort(9001, 9100);
      const workDir = path.dirname(fullPath);

      const proc = spawn('julia', [
        '-e',
        `using MrmdJulia; MrmdJulia.serve(${port})`,
      ], {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        await waitForPort(port, 15000);
      } catch (err) {
        proc.kill();
        return res.json(null);
      }

      sessions.set(docName, {
        port,
        process: proc,
        cwd: workDir,
      });

      res.json({
        name: docName,
        port,
        cwd: workDir,
        url: `http://localhost:${port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[julia:forDocument]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Check if Julia is available
 */
async function isJuliaAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('julia', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
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
