/**
 * Unified Runtime API routes
 *
 * Single set of endpoints for ALL language runtimes.
 * Replaces: bash.js, julia.js, r.js, pty.js + old runtime.js
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Resolve project root from a file path without requiring mrmd.md.
 */
function findGitRoot(startDir) {
  let current = path.resolve(startDir || '/');
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function hasDocsInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && /\.(md|qmd)$/i.test(entry.name));
  } catch {
    return false;
  }
}

function resolveProjectRoot(filePath, fallbackRoot = null) {
  const abs = path.resolve(String(filePath || fallbackRoot || process.cwd()));
  let startDir = abs;
  try {
    const stat = fs.statSync(abs);
    if (stat.isFile()) startDir = path.dirname(abs);
  } catch {
    if (path.extname(abs)) startDir = path.dirname(abs);
  }

  const gitRoot = findGitRoot(startDir);
  if (gitRoot) return gitRoot;

  const homeDir = path.resolve(process.env.HOME || '/');
  let current = startDir;
  let candidate = startDir;
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current || parent === '/' || parent === homeDir) break;
    if (hasDocsInDir(parent)) {
      candidate = parent;
      current = parent;
      continue;
    }
    break;
  }

  return candidate;
}

/**
 * Create unified runtime routes.
 * @param {Object} ctx — server context with runtimeService
 */
export function createRuntimeRoutes(ctx) {
  const router = Router();
  const { runtimeService, runtimePreferencesService } = ctx;

  function normalizeRuntimeLanguage(language) {
    const l = String(language || '').toLowerCase();
    if (l === 'py' || l === 'python3') return 'python';
    if (l === 'sh' || l === 'shell' || l === 'zsh') return 'bash';
    if (l === 'rlang') return 'r';
    if (l === 'jl') return 'julia';
    if (l === 'term' || l === 'terminal') return 'pty';
    return l;
  }

  async function ensureEffectiveRuntime(documentPath, language, options = {}) {
    const normalized = normalizeRuntimeLanguage(language);
    const supported = new Set(runtimeService.supportedLanguages());
    if (!supported.has(normalized)) {
      return {
        language: normalized,
        alive: false,
        available: false,
        error: `Unsupported runtime language: ${language}`,
      };
    }

    const resolvedProjectRoot = resolveProjectRoot(documentPath, options.projectRoot || ctx.projectDir || process.cwd());

    let effective = null;
    let startConfig = null;
    if (runtimePreferencesService?.getEffectiveForDocument) {
      effective = await runtimePreferencesService.getEffectiveForDocument({
        documentPath,
        language: normalized,
        projectRoot: resolvedProjectRoot,
        deviceKind: options.deviceKind || 'desktop',
      });
      startConfig = runtimePreferencesService.toRuntimeStartConfig(effective);
    } else {
      const projectName = path.basename(resolvedProjectRoot) || 'project';
      startConfig = {
        name: `rt:notebook:${projectName}:${normalized}`,
        language: normalized,
        cwd: resolvedProjectRoot,
      };
      if (normalized === 'python') {
        startConfig.venv = path.join(resolvedProjectRoot, '.venv');
      }
    }

    // If tunnel provider is available, prefer it so execution runs on user's machine.
    if (ctx.tunnelClient?.isAvailable()) {
      try {
        const tunnelResult = await ctx.tunnelClient.startRuntime({
          language: normalized,
          documentPath,
          projectRoot: resolvedProjectRoot,
        });
        const langResult = tunnelResult?.[normalized];
        if (langResult) {
          return {
            ...langResult,
            id: langResult.name,
            alive: !!langResult.alive,
            available: true,
            effective,
          };
        }
      } catch (err) {
        console.warn(`[runtime:ensure:${normalized}] Tunnel failed, falling back to local:`, err.message);
      }
    }

    try {
      const runtime = await runtimeService.start(startConfig);
      return {
        ...runtime,
        id: runtime.name,
        alive: true,
        available: true,
        autoStart: true,
        effective,
      };
    } catch (e) {
      return {
        ...startConfig,
        id: startConfig.name,
        alive: false,
        available: true,
        autoStart: true,
        error: e.message,
        effective,
      };
    }
  }

  /**
   * GET /api/runtime
   * List all running runtimes, optionally filtered by language.
   * Query: ?language=python
   */
  router.get('/', async (req, res) => {
    try {
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const tunnelRuntimes = await ctx.tunnelClient.listRuntimes(req.query.language);
          console.log('[runtime:list] Using tunnel — listing Electron runtimes');
          return res.json(tunnelRuntimes);
        } catch (err) {
          console.warn('[runtime:list] Tunnel list failed, falling back to local:', err.message);
        }
      }
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
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const tunnelResult = await ctx.tunnelClient.startRuntime(config);
          console.log(`[runtime:start] Using tunnel — starting Electron runtime "${config.name}"`);
          return res.json(tunnelResult?.[config.language] || tunnelResult);
        } catch (err) {
          console.warn(`[runtime:start] Tunnel start failed for "${config.name}", falling back:`, err.message);
        }
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
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const result = await ctx.tunnelClient.stopRuntime(req.params.name);
          console.log(`[runtime:stop] Using tunnel — stopping Electron runtime "${req.params.name}"`);
          return res.json(result);
        } catch (err) {
          console.warn(`[runtime:stop] Tunnel stop failed for "${req.params.name}", falling back:`, err.message);
        }
      }
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
      if (ctx.tunnelClient?.isAvailable()) {
        try {
          const result = await ctx.tunnelClient.restartRuntime(req.params.name);
          console.log(`[runtime:restart] Using tunnel — restarting Electron runtime "${req.params.name}"`);
          return res.json(result);
        } catch (err) {
          console.warn(`[runtime:restart] Tunnel restart failed for "${req.params.name}", falling back:`, err.message);
        }
      }
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
   * Body: { documentPath, projectRoot?, deviceKind? }
   */
  router.post('/for-document', async (req, res) => {
    try {
      const { documentPath, projectRoot, deviceKind } = req.body;
      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      const out = {};
      const languages = runtimeService.supportedLanguages();
      for (const language of languages) {
        out[language] = await ensureEffectiveRuntime(documentPath, language, {
          projectRoot,
          deviceKind,
        });
      }

      res.json(out);
    } catch (err) {
      console.error('[runtime:forDocument]', err);
      res.json(null);
    }
  });

  /**
   * POST /api/runtime/for-document/:language
   * Get or create a runtime for a specific language.
   * Body: { documentPath, projectRoot?, deviceKind? }
   */
  router.post('/for-document/:language', async (req, res) => {
    try {
      const { documentPath, projectRoot, deviceKind } = req.body;
      const { language } = req.params;

      if (!documentPath) {
        return res.status(400).json({ error: 'documentPath required' });
      }

      const result = await ensureEffectiveRuntime(documentPath, language, {
        projectRoot,
        deviceKind,
      });
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
