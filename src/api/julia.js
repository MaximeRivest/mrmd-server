/**
 * Julia Session API routes
 *
 * Mirrors electronAPI.julia.* using JuliaSessionService from mrmd-electron
 */

import { Router } from 'express';
import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Detect project from a file path
 */
function detectProject(filePath) {
  const root = Project.findRoot(filePath, (dir) => fs.existsSync(path.join(dir, 'mrmd.md')));
  if (!root) return null;

  try {
    const mrmdPath = path.join(root, 'mrmd.md');
    const content = fs.readFileSync(mrmdPath, 'utf8');
    const config = Project.parseConfig(content);
    return { root, config };
  } catch (e) {
    return { root, config: {} };
  }
}

/**
 * Check if Julia is available on the system
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
 * Create Julia routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createJuliaRoutes(ctx) {
  const router = Router();
  const { juliaSessionService } = ctx;

  /**
   * GET /api/julia
   * List all running Julia sessions
   * Mirrors: electronAPI.julia.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = juliaSessionService.list();
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

      if (!config?.name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      // Check if Julia is available
      if (!await isJuliaAvailable()) {
        return res.status(503).json({ error: 'Julia is not available on this system' });
      }

      const result = await juliaSessionService.start(config);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
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
      await juliaSessionService.stop(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[julia:stop]', err);
      res.json({ success: true, message: err.message });
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
      const result = await juliaSessionService.restart(name);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[julia:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/julia/for-document
   * Get or create Julia session for a document
   * Mirrors: electronAPI.julia.forDocument(documentPath)
   *
   * Automatically detects project if projectConfig/projectRoot not provided
   */
  router.post('/for-document', async (req, res) => {
    try {
      let { documentPath, projectConfig, frontmatter, projectRoot } = req.body;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      // Check if Julia is available
      if (!await isJuliaAvailable()) {
        return res.json(null);
      }

      // Auto-detect project if not provided
      if (!projectConfig || !projectRoot) {
        const detected = detectProject(documentPath);
        if (detected) {
          projectRoot = projectRoot || detected.root;
          projectConfig = projectConfig || detected.config;
        } else {
          projectRoot = projectRoot || (ctx.projectDir || process.cwd());
          projectConfig = projectConfig || {};
        }
      }

      // Auto-parse frontmatter if not provided
      if (!frontmatter) {
        try {
          const content = fs.readFileSync(documentPath, 'utf8');
          frontmatter = Project.parseFrontmatter(content);
        } catch (e) {
          frontmatter = null;
        }
      }

      const result = await juliaSessionService.getForDocument(
        documentPath,
        projectConfig,
        frontmatter,
        projectRoot
      );

      // Add url if we have a port
      if (result?.port) {
        result.url = `http://localhost:${result.port}/mrp/v1`;
      }

      res.json(result);
    } catch (err) {
      console.error('[julia:forDocument]', err);
      res.json(null);
    }
  });

  return router;
}
