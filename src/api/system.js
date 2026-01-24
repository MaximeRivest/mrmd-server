/**
 * System API routes
 *
 * Mirrors various electronAPI system functions
 */

import { Router } from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';

/**
 * Create system routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createSystemRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/system/home
   * Get home directory
   * Mirrors: electronAPI.getHomeDir()
   */
  router.get('/home', (req, res) => {
    res.json({ homeDir: os.homedir() });
  });

  /**
   * GET /api/system/recent
   * Get recent files and venvs
   * Mirrors: electronAPI.getRecent()
   */
  router.get('/recent', async (req, res) => {
    try {
      // Try to read from config file
      const configDir = path.join(os.homedir(), '.config', 'mrmd');
      const recentPath = path.join(configDir, 'recent.json');

      try {
        const content = await fs.readFile(recentPath, 'utf-8');
        res.json(JSON.parse(content));
      } catch {
        res.json({ files: [], venvs: [] });
      }
    } catch (err) {
      console.error('[system:recent]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/system/recent
   * Update recent files/venvs
   */
  router.post('/recent', async (req, res) => {
    try {
      const { files, venvs } = req.body;

      const configDir = path.join(os.homedir(), '.config', 'mrmd');
      await fs.mkdir(configDir, { recursive: true });

      const recentPath = path.join(configDir, 'recent.json');

      // Read existing
      let existing = { files: [], venvs: [] };
      try {
        const content = await fs.readFile(recentPath, 'utf-8');
        existing = JSON.parse(content);
      } catch {}

      // Merge
      if (files) {
        existing.files = [...new Set([...files, ...existing.files])].slice(0, 50);
      }
      if (venvs) {
        existing.venvs = [...new Set([...venvs, ...existing.venvs])].slice(0, 20);
      }

      await fs.writeFile(recentPath, JSON.stringify(existing, null, 2));
      res.json(existing);
    } catch (err) {
      console.error('[system:recent:update]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/system/ai
   * Get AI server info
   * Mirrors: electronAPI.getAi()
   */
  router.get('/ai', (req, res) => {
    res.json({
      port: ctx.aiPort,
      url: `http://localhost:${ctx.aiPort}`,
    });
  });

  /**
   * POST /api/system/discover-venvs
   * Discover virtual environments
   * Mirrors: electronAPI.discoverVenvs(projectDir)
   */
  router.post('/discover-venvs', async (req, res) => {
    try {
      const { projectDir } = req.body;
      const searchDir = projectDir || ctx.projectDir;

      // Start async discovery
      discoverVenvs(searchDir, ctx.eventBus);

      res.json({ started: true, searchDir });
    } catch (err) {
      console.error('[system:discover-venvs]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/system/install-mrmd-python
   * Install mrmd-python in a venv
   * Mirrors: electronAPI.installMrmdPython(venvPath)
   */
  router.post('/install-mrmd-python', async (req, res) => {
    try {
      const { venvPath } = req.body;
      if (!venvPath) {
        return res.status(400).json({ error: 'venvPath required' });
      }

      const resolvedPath = path.resolve(ctx.projectDir, venvPath);
      const pipPath = path.join(resolvedPath, 'bin', 'pip');

      // Install dependencies
      const deps = ['ipython', 'starlette', 'uvicorn', 'sse-starlette'];

      const proc = spawn('uv', ['pip', 'install', '--python', path.join(resolvedPath, 'bin', 'python'), ...deps], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      await new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed: ${stderr}`));
        });
      });

      res.json({ success: true, output: stdout });
    } catch (err) {
      console.error('[system:install-mrmd-python]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shell operations (stubs for browser)
   */
  router.post('/shell/show-in-folder', (req, res) => {
    // Can't do this in browser - return the path so UI can display it
    res.json({
      success: false,
      message: 'Not available in browser mode',
      path: req.body.path,
    });
  });

  router.post('/shell/open-external', (req, res) => {
    // Return URL so browser can window.open() it
    res.json({
      success: true,
      url: req.body.url,
      action: 'window.open',
    });
  });

  router.post('/shell/open-path', (req, res) => {
    // Can't open local files from browser
    res.json({
      success: false,
      message: 'Not available in browser mode',
      path: req.body.path,
    });
  });

  return router;
}

/**
 * Async venv discovery
 */
async function discoverVenvs(searchDir, eventBus, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth) return;

  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.venv') continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name === '__pycache__') continue;

      const fullPath = path.join(searchDir, entry.name);

      // Check if this is a venv
      const activatePath = path.join(fullPath, 'bin', 'activate');
      try {
        await fs.access(activatePath);

        // Found a venv!
        const pythonPath = path.join(fullPath, 'bin', 'python');
        let version = 'unknown';

        try {
          const proc = spawn(pythonPath, ['--version'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let output = '';
          proc.stdout.on('data', (data) => { output += data; });
          proc.stderr.on('data', (data) => { output += data; });

          await new Promise((resolve) => proc.on('close', resolve));
          version = output.trim().replace('Python ', '');
        } catch {}

        eventBus.venvFound({
          path: fullPath,
          name: entry.name,
          python: pythonPath,
          version,
        });

        // Don't recurse into venvs
        continue;
      } catch {}

      // Recurse into directory
      await discoverVenvs(fullPath, eventBus, maxDepth, currentDepth + 1);
    }
  } catch (err) {
    console.error('[discover-venvs]', err.message);
  }

  // If this is the root call, emit done
  if (currentDepth === 0) {
    eventBus.venvScanDone();
  }
}
