/**
 * PTY Session API routes (for ```term blocks)
 *
 * Mirrors electronAPI.pty.* using PtySessionService from mrmd-electron
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
 * Create PTY routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createPtyRoutes(ctx) {
  const router = Router();
  const { ptySessionService } = ctx;

  /**
   * GET /api/pty
   * List all running PTY sessions
   * Mirrors: electronAPI.pty.list()
   */
  router.get('/', async (req, res) => {
    try {
      const list = ptySessionService.list();
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

      if (!config?.name) {
        return res.status(400).json({ error: 'config.name required' });
      }

      const result = await ptySessionService.start(config);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        venv: result.venv,
        pid: result.pid,
        wsUrl: `ws://localhost:${result.port}`,
        alive: result.alive,
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
      await ptySessionService.stop(name);
      res.json({ success: true });
    } catch (err) {
      console.error('[pty:stop]', err);
      res.json({ success: true, message: err.message });
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
      const result = await ptySessionService.restart(name);

      res.json({
        name: result.name,
        port: result.port,
        cwd: result.cwd,
        venv: result.venv,
        pid: result.pid,
        wsUrl: `ws://localhost:${result.port}`,
        alive: result.alive,
      });
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

      const result = await ptySessionService.getForDocument(
        documentPath,
        projectConfig,
        frontmatter,
        projectRoot
      );

      // Add wsUrl if we have a port
      if (result?.port) {
        result.wsUrl = `ws://localhost:${result.port}`;
      }

      res.json(result);
    } catch (err) {
      console.error('[pty:forDocument]', err);
      res.json(null);
    }
  });

  return router;
}
