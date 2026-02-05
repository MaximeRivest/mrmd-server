/**
 * Runtime API routes
 *
 * Mirrors electronAPI runtime management functions
 */

import { Router } from 'express';
import path from 'path';

// Global runtime registry (shared with session.js in a real impl)
const runtimes = new Map();

/**
 * Create runtime routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createRuntimeRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/runtime
   * List all runtimes
   * Mirrors: electronAPI.listRuntimes()
   */
  router.get('/', async (req, res) => {
    try {
      const list = [];
      for (const [id, runtime] of runtimes) {
        list.push({
          id,
          type: runtime.type,
          port: runtime.port,
          venv: runtime.venv,
          cwd: runtime.cwd,
          running: runtime.process && !runtime.process.killed,
        });
      }
      res.json(list);
    } catch (err) {
      console.error('[runtime:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/runtime/:id
   * Kill a runtime
   * Mirrors: electronAPI.killRuntime(runtimeId)
   */
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const runtime = runtimes.get(id);

      if (!runtime) {
        return res.json({ success: true, message: 'Runtime not found' });
      }

      if (runtime.process && !runtime.process.killed) {
        runtime.process.kill();
      }

      runtimes.delete(id);
      res.json({ success: true });
    } catch (err) {
      console.error('[runtime:kill]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/runtime/:id/attach
   * Attach to an existing runtime
   * Mirrors: electronAPI.attachRuntime(runtimeId)
   */
  router.post('/:id/attach', async (req, res) => {
    try {
      const { id } = req.params;
      const runtime = runtimes.get(id);

      if (!runtime) {
        return res.status(404).json({ error: 'Runtime not found' });
      }

      res.json({
        id,
        port: runtime.port,
        url: `http://localhost:${runtime.port}/mrp/v1`,
        attached: true,
      });
    } catch (err) {
      console.error('[runtime:attach]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/runtime/start-python
   * Start a Python runtime
   * Mirrors: electronAPI.startPython(venvPath, forceNew)
   */
  router.post('/start-python', async (req, res) => {
    try {
      const { venvPath, forceNew = false, cwd } = req.body;
      const { sessionService } = ctx;

      if (!venvPath) {
        return res.status(400).json({ error: 'venvPath required' });
      }

      // Check if we can reuse an existing session
      if (!forceNew) {
        const existing = sessionService.list().find(s =>
          s.language === 'python' && s.venv === venvPath && s.alive
        );
        if (existing) {
          return res.json({
            id: existing.name,
            port: existing.port,
            url: `http://localhost:${existing.port}/mrp/v1`,
            reused: true,
          });
        }
      }

      // Start a new Python session
      const sessionName = `runtime-${Date.now()}`;
      const result = await sessionService.start({
        name: sessionName,
        language: 'python',
        venv: venvPath,
        cwd: cwd || path.dirname(venvPath),
      });

      res.json({
        id: result.name,
        port: result.port,
        url: `http://localhost:${result.port}/mrp/v1`,
        pid: result.pid,
      });
    } catch (err) {
      console.error('[runtime:start-python]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Export for use by session.js
export { runtimes };
