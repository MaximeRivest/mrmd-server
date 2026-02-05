/**
 * Bash Session API routes
 *
 * Mirrors electronAPI.bash.* using BashSessionService from mrmd-electron
 */

import { Router } from 'express';
import { Project } from 'mrmd-project';
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
 * Create bash routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createBashRoutes(ctx) {
  const router = Router();
  const { bashSessionService } = ctx;

  /**
   * GET /api/bash
   * List all running bash sessions
   * Mirrors: electronAPI.bash.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = bashSessionService.list();
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

      if (!config?.name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      const result = await bashSessionService.start(config);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
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
      await bashSessionService.stop(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[bash:stop]', err);
      res.json({ success: true, message: err.message });
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
      const result = await bashSessionService.restart(name);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        pid: result.pid,
        url: `http://localhost:${result.port}/mrp/v1`,
      });
    } catch (err) {
      console.error('[bash:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/bash/for-document
   * Get or create bash session for a document
   * Mirrors: electronAPI.bash.forDocument(documentPath)
   *
   * Automatically detects project if projectConfig/projectRoot not provided
   */
  router.post('/for-document', async (req, res) => {
    try {
      let { documentPath, projectConfig, frontmatter, projectRoot } = req.body;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
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

      const result = await bashSessionService.getForDocument(
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
      console.error('[bash:forDocument]', err);
      res.json(null);
    }
  });

  return router;
}
