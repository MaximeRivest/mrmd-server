/**
 * System API routes
 *
 * Mirrors various electronAPI system functions
 */

import { Router } from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { ensureAiServer, getAiServer, restartAiServer } from '../ai-service.js';

const MAX_RECENT_FILES = 50;
const MAX_RECENT_VENVS = 20;

function toIsoOrNull(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeRecentEntry(entry, {
  timeField,
  fallbackTimeFields = [],
  defaultTime = new Date().toISOString(),
} = {}) {
  if (!entry) return null;

  let pathValue = null;
  let countValue = 1;
  let timeValue = null;

  if (typeof entry === 'string') {
    pathValue = entry;
  } else if (typeof entry === 'object') {
    if (typeof entry.path === 'string') {
      pathValue = entry.path;
    }

    const rawCount = Number(entry.count ?? entry.frequency ?? entry.opens ?? 1);
    if (Number.isFinite(rawCount) && rawCount > 0) {
      countValue = rawCount;
    }

    const candidates = [entry[timeField], ...fallbackTimeFields.map(k => entry[k])];
    for (const candidate of candidates) {
      const normalized = toIsoOrNull(candidate);
      if (normalized) {
        timeValue = normalized;
        break;
      }
    }
  }

  if (!pathValue) return null;

  return {
    path: pathValue,
    [timeField]: timeValue || defaultTime,
    count: countValue,
  };
}

function sortRecentEntries(entries, timeField) {
  entries.sort((a, b) => {
    const aTime = Date.parse(a?.[timeField] || 0) || 0;
    const bTime = Date.parse(b?.[timeField] || 0) || 0;
    if (aTime !== bTime) return bTime - aTime;

    const aCount = Number(a?.count || 0);
    const bCount = Number(b?.count || 0);
    if (aCount !== bCount) return bCount - aCount;

    return String(a?.path || '').localeCompare(String(b?.path || ''));
  });
  return entries;
}

function normalizeRecentList(list, {
  timeField,
  fallbackTimeFields = [],
  limit,
} = {}) {
  const nowMs = Date.now();
  const byPath = new Map();

  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const syntheticTime = new Date(nowMs - i).toISOString();
      const normalized = normalizeRecentEntry(raw, {
        timeField,
        fallbackTimeFields,
        defaultTime: syntheticTime,
      });
      if (!normalized) continue;

      const existing = byPath.get(normalized.path);
      if (!existing) {
        byPath.set(normalized.path, normalized);
      } else {
        const existingTime = Date.parse(existing[timeField] || 0) || 0;
        const nextTime = Date.parse(normalized[timeField] || 0) || 0;
        byPath.set(normalized.path, {
          path: normalized.path,
          [timeField]: nextTime >= existingTime ? normalized[timeField] : existing[timeField],
          count: Math.max(Number(existing.count || 1), Number(normalized.count || 1)),
        });
      }
    }
  }

  const rows = sortRecentEntries(Array.from(byPath.values()), timeField);
  return rows.slice(0, limit);
}

function mergeRecentEntries(existingList, incomingList, {
  timeField,
  fallbackTimeFields = [],
  limit,
  incrementCount = false,
} = {}) {
  const merged = new Map();

  for (const row of normalizeRecentList(existingList, { timeField, fallbackTimeFields, limit: Number.MAX_SAFE_INTEGER })) {
    merged.set(row.path, row);
  }

  const nowIso = new Date().toISOString();
  const incoming = Array.isArray(incomingList) ? incomingList : [];
  for (const raw of incoming) {
    const normalized = normalizeRecentEntry(raw, {
      timeField,
      fallbackTimeFields,
      defaultTime: nowIso,
    });
    if (!normalized) continue;

    const previous = merged.get(normalized.path);
    if (!previous) {
      merged.set(normalized.path, normalized);
      continue;
    }

    const incomingCount = Number(normalized.count || 1);
    const previousCount = Number(previous.count || 1);

    merged.set(normalized.path, {
      path: normalized.path,
      [timeField]: normalized[timeField] || previous[timeField] || nowIso,
      count: incrementCount
        ? Math.max(1, previousCount + Math.max(1, incomingCount))
        : Math.max(previousCount, incomingCount),
    });
  }

  const rows = sortRecentEntries(Array.from(merged.values()), timeField);
  return rows.slice(0, limit);
}

function normalizeRecentPayload(payload) {
  return {
    files: normalizeRecentList(payload?.files, {
      timeField: 'opened',
      fallbackTimeFields: ['used'],
      limit: MAX_RECENT_FILES,
    }),
    venvs: normalizeRecentList(payload?.venvs, {
      timeField: 'used',
      fallbackTimeFields: ['opened'],
      limit: MAX_RECENT_VENVS,
    }),
  };
}

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
   * GET /api/system/info
   * Get system and app info including uv status
   * Mirrors: electronAPI.system.info()
   */
  router.get('/info', async (req, res) => {
    try {
      // Check uv availability
      let uvInfo = { installed: false };
      try {
        const uvVersion = execSync('uv --version', { encoding: 'utf-8' }).trim();
        const uvPath = execSync('which uv', { encoding: 'utf-8' }).trim();
        uvInfo = {
          installed: true,
          version: uvVersion.replace('uv ', ''),
          path: uvPath,
        };
      } catch {}

      // Get Node.js version
      const nodeVersion = process.version;

      res.json({
        appVersion: '0.1.0',
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion,
        pythonDeps: ['ipython', 'starlette', 'uvicorn', 'sse-starlette'],
        uv: uvInfo,
        serverMode: true, // Indicates this is running in server mode, not Electron
      });
    } catch (err) {
      console.error('[system:info]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/system/ensure-uv
   * Ensure uv is installed (auto-install if missing)
   * Mirrors: electronAPI.system.ensureUv()
   */
  router.post('/ensure-uv', async (req, res) => {
    try {
      // Check if uv is already installed
      try {
        const uvVersion = execSync('uv --version', { encoding: 'utf-8' }).trim();
        const uvPath = execSync('which uv', { encoding: 'utf-8' }).trim();
        return res.json({
          success: true,
          path: uvPath,
          version: uvVersion.replace('uv ', ''),
          alreadyInstalled: true,
        });
      } catch {}

      // Try to install uv using the official installer
      const installScript = 'curl -LsSf https://astral.sh/uv/install.sh | sh';

      const proc = spawn('sh', ['-c', installScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      await new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with code ${code}: ${stderr}`));
        });
      });

      // Verify installation
      const uvPath = path.join(os.homedir(), '.local', 'bin', 'uv');
      if (existsSync(uvPath)) {
        try {
          const uvVersion = execSync(`${uvPath} --version`, { encoding: 'utf-8' }).trim();
          return res.json({
            success: true,
            path: uvPath,
            version: uvVersion.replace('uv ', ''),
          });
        } catch {}
      }

      res.json({
        success: false,
        error: 'Installation completed but uv not found',
      });
    } catch (err) {
      console.error('[system:ensureUv]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/system/recent
   * Get recent files and venvs
   * Mirrors: electronAPI.getRecent()
   */
  router.get('/recent', async (req, res) => {
    try {
      const configDir = path.join(os.homedir(), '.config', 'mrmd');
      const recentPath = path.join(configDir, 'recent.json');

      try {
        const content = await fs.readFile(recentPath, 'utf-8');
        const parsed = JSON.parse(content);
        res.json(normalizeRecentPayload(parsed));
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
      const {
        files,
        venvs,
        file,
        venv,
      } = req.body || {};

      const configDir = path.join(os.homedir(), '.config', 'mrmd');
      await fs.mkdir(configDir, { recursive: true });

      const recentPath = path.join(configDir, 'recent.json');

      let existing = { files: [], venvs: [] };
      try {
        const content = await fs.readFile(recentPath, 'utf-8');
        existing = normalizeRecentPayload(JSON.parse(content));
      } catch {}

      if (Array.isArray(files)) {
        existing.files = mergeRecentEntries(existing.files, files, {
          timeField: 'opened',
          fallbackTimeFields: ['used'],
          limit: MAX_RECENT_FILES,
          incrementCount: false,
        });
      }

      if (file) {
        existing.files = mergeRecentEntries(existing.files, [file], {
          timeField: 'opened',
          fallbackTimeFields: ['used'],
          limit: MAX_RECENT_FILES,
          incrementCount: true,
        });
      }

      if (Array.isArray(venvs)) {
        existing.venvs = mergeRecentEntries(existing.venvs, venvs, {
          timeField: 'used',
          fallbackTimeFields: ['opened'],
          limit: MAX_RECENT_VENVS,
          incrementCount: false,
        });
      }

      if (venv) {
        existing.venvs = mergeRecentEntries(existing.venvs, [venv], {
          timeField: 'used',
          fallbackTimeFields: ['opened'],
          limit: MAX_RECENT_VENVS,
          incrementCount: true,
        });
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
   * Get AI server info - ensures AI server is running
   * Mirrors: electronAPI.getAi()
   */
  router.get('/ai', async (req, res) => {
    try {
      // Ensure AI server is running (starts it if not)
      const result = await ensureAiServer();
      res.json(result);
    } catch (err) {
      console.error('[system:ai]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/system/ai/status
   * Get AI server status without starting it
   */
  router.get('/ai/status', (req, res) => {
    res.json(getAiServer());
  });

  /**
   * POST /api/system/ai/restart
   * Restart AI server with new API keys
   * Call this after changing API keys in settings
   */
  router.post('/ai/restart', async (req, res) => {
    try {
      const { apiKeys } = req.body;
      console.log('[system:ai:restart] Restarting AI server with new API keys');
      const result = await restartAiServer(apiKeys);
      res.json(result);
    } catch (err) {
      console.error('[system:ai:restart]', err);
      res.status(500).json({ success: false, error: err.message });
    }
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
   * POST /api/system/create-venv
   * Create a new Python virtual environment
   * Mirrors: electronAPI.createVenv(venvPath)
   */
  router.post('/create-venv', async (req, res) => {
    try {
      const { venvPath } = req.body;
      if (!venvPath) {
        return res.status(400).json({ error: 'venvPath required' });
      }

      const resolvedPath = path.resolve(venvPath);

      // Check if venv already exists
      if (existsSync(path.join(resolvedPath, 'bin', 'activate'))) {
        return res.json({
          success: true,
          path: resolvedPath,
          message: 'Virtual environment already exists',
        });
      }

      // Create parent directory if needed
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Try uv first (faster)
      let uvPath = null;
      try {
        uvPath = execSync('which uv', { encoding: 'utf-8' }).trim();
      } catch {
        // Check common locations
        const uvLocations = [
          path.join(os.homedir(), '.local', 'bin', 'uv'),
          '/usr/local/bin/uv',
          '/usr/bin/uv',
        ];
        for (const loc of uvLocations) {
          if (existsSync(loc)) {
            uvPath = loc;
            break;
          }
        }
      }

      if (uvPath) {
        // Use uv to create venv
        const proc = spawn(uvPath, ['venv', resolvedPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data; });

        await new Promise((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`uv venv failed: ${stderr}`));
          });
          proc.on('error', reject);
        });
      } else {
        // Fallback to python3 -m venv
        const proc = spawn('python3', ['-m', 'venv', resolvedPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data; });

        await new Promise((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`python3 -m venv failed (code ${code}): ${stderr}`));
          });
          proc.on('error', reject);
        });
      }

      // Verify creation
      if (existsSync(path.join(resolvedPath, 'bin', 'activate'))) {
        res.json({
          success: true,
          path: resolvedPath,
          method: uvPath ? 'uv' : 'python3',
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Virtual environment creation completed but activation script not found',
        });
      }
    } catch (err) {
      console.error('[system:create-venv]', err);
      res.status(500).json({ success: false, error: err.message });
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
