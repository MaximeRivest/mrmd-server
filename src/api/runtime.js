/**
 * Unified Runtime API routes
 *
 * Single set of endpoints for ALL language runtimes.
 * Replaces: bash.js, julia.js, r.js, pty.js + old runtime.js
 */

import { Router } from 'express';
import { Project } from 'mrmd-project';
import fs from 'fs';
import path from 'path';

/**
 * Detect project from a file path.
 */
function detectProject(filePath) {
  const root = Project.findRoot(filePath, (dir) => fs.existsSync(path.join(dir, 'mrmd.md')));
  if (!root) return null;

  try {
    const mrmdPath = path.join(root, 'mrmd.md');
    const content = fs.readFileSync(mrmdPath, 'utf8');
    const config = Project.parseConfig(content);
    return { root, config };
  } catch {
    return { root, config: {} };
  }
}

/**
 * Create unified runtime routes.
 * @param {Object} ctx — server context with runtimeService
 */
export function createRuntimeRoutes(ctx) {
  const router = Router();
  const { runtimeService } = ctx;

  /**
   * GET /api/runtime
   * List all running runtimes, optionally filtered by language.
   * Query: ?language=python
   */
  router.get('/', async (req, res) => {
    try {
      res.json(runtimeService.list(req.query.language));
    } catch (err) {
      console.error('[runtime:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/runtime
   * Start a runtime.
   * Body: { config: { name, language, cwd, venv? } }
   */
  router.post('/', async (req, res) => {
    try {
      const { config } = req.body;
      if (!config?.name || !config?.language) {
        return res.status(400).json({ error: 'config.name and config.language required' });
      }
      const result = await runtimeService.start(config);
      res.json(result);
    } catch (err) {
      console.error('[runtime:start]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/runtime/:name
   * Stop a runtime.
   */
  router.delete('/:name', async (req, res) => {
    try {
      await runtimeService.stop(req.params.name);
      res.json({ success: true });
    } catch (err) {
      console.error('[runtime:stop]', err);
      res.json({ success: true, message: err.message });
    }
  });

  /**
   * POST /api/runtime/:name/restart
   * Restart a runtime.
   */
  router.post('/:name/restart', async (req, res) => {
    try {
      const result = await runtimeService.restart(req.params.name);
      res.json(result);
    } catch (err) {
      console.error('[runtime:restart]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/runtime/:name/attach
   * Attach to an existing runtime.
   */
  router.post('/:name/attach', async (req, res) => {
    try {
      const result = runtimeService.attach(req.params.name);
      if (!result) {
        return res.status(404).json({ success: false, error: 'Runtime not found' });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[runtime:attach]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/runtime/for-document
   * Get or create ALL runtimes needed for a document.
   * Body: { documentPath, projectConfig?, frontmatter?, projectRoot? }
   * Returns: { python: {...}, bash: {...}, r: {...}, julia: {...}, pty: {...} }
   */
  router.post('/for-document', async (req, res) => {
    try {
      let { documentPath, projectConfig, frontmatter, projectRoot } = req.body;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      // Auto-detect project
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

      // Auto-parse frontmatter
      if (!frontmatter) {
        try {
          const content = fs.readFileSync(documentPath, 'utf8');
          frontmatter = Project.parseFrontmatter(content);
        } catch {
          frontmatter = null;
        }
      }

      // If the Electron desktop runtime tunnel is available, route to it
      // so code runs on the user's laptop instead of the server.
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const tunnelResult = await ctx.tunnelClient.startRuntime({
            documentPath,
            projectRoot,
            projectConfig,
            frontmatter,
          });
          console.log('[runtime:forDocument] Using tunnel — runtimes from Electron');
          return res.json(tunnelResult);
        } catch (err) {
          console.warn('[runtime:forDocument] Tunnel failed, falling back to local:', err.message);
          // Fall through to local runtimes
        }
      }

      const result = await runtimeService.getForDocument(
        documentPath, projectConfig, frontmatter, projectRoot
      );
      res.json(result);
    } catch (err) {
      console.error('[runtime:forDocument]', err);
      res.json(null);
    }
  });

  /**
   * POST /api/runtime/for-document/:language
   * Get or create a runtime for a specific language.
   * Body: { documentPath, projectConfig?, frontmatter?, projectRoot? }
   */
  router.post('/for-document/:language', async (req, res) => {
    try {
      let { documentPath, projectConfig, frontmatter, projectRoot } = req.body;
      const { language } = req.params;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

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

      if (!frontmatter) {
        try {
          const content = fs.readFileSync(documentPath, 'utf8');
          frontmatter = Project.parseFrontmatter(content);
        } catch {
          frontmatter = null;
        }
      }

      // Try tunnel first
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const tunnelResult = await ctx.tunnelClient.startRuntime({
            language,
            documentPath,
            projectRoot,
            projectConfig,
            frontmatter,
          });
          const langResult = tunnelResult?.[language];
          if (langResult) {
            console.log(`[runtime:forDocument:${language}] Using tunnel — runtime from Electron`);
            return res.json(langResult);
          }
        } catch (err) {
          console.warn(`[runtime:forDocument:${language}] Tunnel failed, falling back:`, err.message);
        }
      }

      const result = await runtimeService.getForDocumentLanguage(
        language, documentPath, projectConfig, frontmatter, projectRoot
      );
      res.json(result);
    } catch (err) {
      console.error('[runtime:forDocumentLanguage]', err);
      res.json(null);
    }
  });

  /**
   * GET /api/runtime/available/:language
   * Check if a language runtime is available.
   */
  router.get('/available/:language', (req, res) => {
    res.json(runtimeService.isAvailable(req.params.language));
  });

  /**
   * GET /api/runtime/provider
   * Return connected machine-provider info for tunnel mode.
   */
  router.get('/provider', (req, res) => {
    const provider = ctx.tunnelClient?.getProvider?.() || null;
    const machineInfo = ctx.tunnelClient?.getMachines?.() || { activeMachineId: null, machines: [] };
    res.json({
      available: !!provider,
      provider,
      ...machineInfo,
    });
  });

  /**
   * GET /api/runtime/languages
   * List all supported languages.
   */
  router.get('/languages', (req, res) => {
    res.json(runtimeService.supportedLanguages());
  });

  /**
   * POST /api/runtime/update-port
   * Hot-reload runtime port/host after CRIU migration (cloud mode).
   * Body: { port, host? }
   */
  router.post('/update-port', async (req, res) => {
    try {
      const { port, host } = req.body;
      if (!port || typeof port !== 'number') {
        return res.status(400).json({ error: 'port (number) required' });
      }
      if (typeof runtimeService.updateRuntimePort !== 'function') {
        return res.status(400).json({ error: 'Not in cloud mode' });
      }
      const result = runtimeService.updateRuntimePort(port, host || null);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[runtime:update-port]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
