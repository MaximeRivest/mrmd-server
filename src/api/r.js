/**
 * R Session API routes
 *
 * Mirrors electronAPI.r.* using RSessionService from mrmd-electron
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
 * Check if R is available on the system
 */
async function isRAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('R', ['--version'], {
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
 * Create R routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createRRoutes(ctx) {
  const router = Router();
  const { rSessionService } = ctx;

  /**
   * GET /api/r
   * List all running R sessions
   * Mirrors: electronAPI.r.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = rSessionService.list();
      res.json(list);
    } catch (err) {
      console.error('[r:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/r/available
   * Check if R is available on the system
   */
  router.get('/available', async (req, res) => {
    try {
      const available = await isRAvailable();
      res.json({ available });
    } catch (err) {
      console.error('[r:available]', err);
      res.json({ available: false });
    }
  });

  /**
   * POST /api/r
   * Start a new R session
   * Mirrors: electronAPI.r.start(config)
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;

      if (!config?.name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      // Check if R is available
      if (!await isRAvailable()) {
        return res.status(503).json({ error: 'R is not available on this system' });
      }

      const result = await rSessionService.start(config);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[r:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/r/:name
   * Stop an R session
   * Mirrors: electronAPI.r.stop(sessionName)
   */
  router.delete('/:name', async (req, res) => {
    try {
      const { name } = req.params;
      await rSessionService.stop(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[r:stop]', err);
      res.json({ success: true, message: err.message });
    }
  });

  /**
   * POST /api/r/:name/restart
   * Restart an R session
   * Mirrors: electronAPI.r.restart(sessionName)
   */
  router.post('/:name/restart', async (req, res) => {
    try {
      const { name } = req.params;
      const result = await rSessionService.restart(name);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[r:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/r/for-document
   * Get or create R session for a document
   * Mirrors: electronAPI.r.forDocument(documentPath)
   *
   * Automatically detects project if projectConfig/projectRoot not provided
   */
  router.post('/for-document', async (req, res) => {
    try {
      let { documentPath, projectConfig, frontmatter, projectRoot } = req.body;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      // Check if R is available
      if (!await isRAvailable()) {
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

      const result = await rSessionService.getForDocument(
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
      console.error('[r:forDocument]', err);
      res.json(null);
    }
  });

  return router;
}
