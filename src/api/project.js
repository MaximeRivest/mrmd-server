/**
 * Project API routes
 *
 * Mirrors electronAPI.project.* using ProjectService from mrmd-electron
 * and dynamic sync server management.
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { watch } from 'chokidar';
import { Project } from 'mrmd-project';

const DOC_EXTENSIONS = ['.md', '.qmd'];

function isDocFile(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return DOC_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function stripDocExtension(fileName) {
  if (!fileName) return '';
  const lower = fileName.toLowerCase();
  for (const ext of DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return fileName.slice(0, -ext.length);
  }
  return fileName;
}

/**
 * Detect project from a file path
 * Returns { root, config } or null if not in a project
 */
function detectProject(filePath) {
  // Use mrmd-project's findRoot to locate project root
  const root = Project.findRoot(filePath, (dir) => existsSync(path.join(dir, 'mrmd.md')));

  if (!root) return null;

  // Read and parse mrmd.md config
  try {
    const mrmdPath = path.join(root, 'mrmd.md');
    const content = readFileSync(mrmdPath, 'utf8');
    const config = Project.parseConfig(content);
    return { root, config };
  } catch (e) {
    // mrmd.md exists but couldn't be read/parsed
    return { root, config: {} };
  }
}

/**
 * Create project routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createProjectRoutes(ctx) {
  const router = Router();
  const { projectService, acquireSyncServer, releaseSyncServer, getSyncServer, listSyncServers } = ctx;

  /**
   * GET /api/project?path=...
   * Get project info for a file path
   * Mirrors: electronAPI.project.get(filePath)
   *
   * Enhanced: Now uses mrmd-project for detection and starts sync server dynamically
   */
  router.get('/', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      // Detect project from file path
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.projectDir || process.cwd(), filePath);
      const detected = detectProject(resolvedPath);

      if (detected) {
        // Get or start sync server for this project
        let syncInfo = null;
        try {
          syncInfo = await acquireSyncServer(detected.root);
        } catch (e) {
          console.warn('[project] Could not start sync server:', e.message);
        }

        // Build nav tree
        const navTree = await buildNavTree(detected.root);

        res.json({
          root: detected.root,
          config: detected.config,
          navTree,
          files: flattenNavTree(navTree, detected.root),
          currentFile: resolvedPath,
          syncPort: syncInfo?.port || null,
        });
      } else {
        // No project detected, use fallback
        const projectInfo = await getProjectInfo(filePath, ctx.projectDir || process.cwd());
        res.json(projectInfo);
      }
    } catch (err) {
      console.error('[project:get]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/project/sync
   * List all active sync servers
   */
  router.get('/sync', async (req, res) => {
    try {
      const servers = listSyncServers();
      res.json(servers);
    } catch (err) {
      console.error('[project:sync]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project/sync/acquire
   * Acquire sync server for a project directory
   */
  router.post('/sync/acquire', async (req, res) => {
    try {
      const { projectDir } = req.body;
      if (!projectDir) {
        return res.status(400).json({ error: 'projectDir required' });
      }
      const server = await acquireSyncServer(projectDir);
      res.json({ port: server.port, dir: server.dir, refCount: server.refCount });
    } catch (err) {
      console.error('[project:sync/acquire]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project/sync/release
   * Release sync server for a project directory
   */
  router.post('/sync/release', async (req, res) => {
    try {
      const { projectDir } = req.body;
      if (!projectDir) {
        return res.status(400).json({ error: 'projectDir required' });
      }
      releaseSyncServer(projectDir);
      res.json({ success: true });
    } catch (err) {
      console.error('[project:sync/release]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project
   * Create a new mrmd project
   * Mirrors: electronAPI.project.create(targetPath)
   *
   * Uses ProjectService.createProject() which:
   * 1. Creates scaffold files (mrmd.md, index files)
   * 2. Creates venv
   * 3. Installs mrmd-python
   */
  router.post('/', async (req, res) => {
    try {
      const { targetPath } = req.body;
      if (!targetPath) {
        return res.status(400).json({ error: 'targetPath required' });
      }

      const resolvedPath = path.resolve(ctx.projectDir, targetPath);

      // Use ProjectService to create full project (same as Electron)
      const projectInfo = await projectService.createProject(resolvedPath);
      res.json(projectInfo);
    } catch (err) {
      console.error('[project:create]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/project/nav?root=...
   * Get navigation tree for a project
   * Mirrors: electronAPI.project.nav(projectRoot)
   */
  router.get('/nav', async (req, res) => {
    try {
      const projectRoot = req.query.root || ctx.projectDir;
      const navTree = await buildNavTree(projectRoot);
      res.json(navTree);
    } catch (err) {
      console.error('[project:nav]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project/invalidate
   * Invalidate cached project info
   * Mirrors: electronAPI.project.invalidate(projectRoot)
   */
  router.post('/invalidate', async (req, res) => {
    try {
      const { projectRoot } = req.body;
      // In this implementation we don't cache, so this is a no-op
      // but we emit an event so the UI can refresh
      ctx.eventBus.projectChanged(projectRoot || ctx.projectDir);
      res.json({ success: true });
    } catch (err) {
      console.error('[project:invalidate]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project/watch
   * Watch project for file changes
   * Mirrors: electronAPI.project.watch(projectRoot)
   */
  router.post('/watch', async (req, res) => {
    try {
      const { projectRoot } = req.body;
      const watchPath = projectRoot || ctx.projectDir;

      // Close existing watcher if any
      if (ctx.watchers.has(watchPath)) {
        await ctx.watchers.get(watchPath).close();
      }

      // Create new watcher
      const watcher = watch(watchPath, {
        ignored: /(^|[\/\\])\.|node_modules|\.git|__pycache__|\.mrmd-sync/,
        persistent: true,
        ignoreInitial: true,
      });

      watcher.on('all', (event, filePath) => {
        if (isDocFile(filePath)) {
          ctx.eventBus.projectChanged(watchPath);
        }
      });

      ctx.watchers.set(watchPath, watcher);
      res.json({ success: true, watching: watchPath });
    } catch (err) {
      console.error('[project:watch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project/unwatch
   * Stop watching project
   * Mirrors: electronAPI.project.unwatch()
   */
  router.post('/unwatch', async (req, res) => {
    try {
      // Close all watchers
      for (const [watchPath, watcher] of ctx.watchers) {
        await watcher.close();
        ctx.watchers.delete(watchPath);
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[project:unwatch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Get project info for a file path
 */
async function getProjectInfo(filePath, defaultRoot) {
  const resolvedPath = path.resolve(defaultRoot, filePath);

  // Find project root by walking up to find mrmd.md
  let projectRoot = path.dirname(resolvedPath);
  let mrmdConfig = null;

  for (let i = 0; i < 10; i++) {
    const mrmdPath = path.join(projectRoot, 'mrmd.md');
    try {
      const content = await fs.readFile(mrmdPath, 'utf-8');
      mrmdConfig = parseMrmdConfig(content);
      break;
    } catch {
      const parent = path.dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }
  }

  // If no mrmd.md found, use the provided directory
  if (!mrmdConfig) {
    projectRoot = defaultRoot;
    mrmdConfig = { venv: '.venv' };
  }

  // Build nav tree
  const navTree = await buildNavTree(projectRoot);

  // Collect all files from nav tree (flattened)
  const files = flattenNavTree(navTree, projectRoot);

  return {
    root: projectRoot,
    config: mrmdConfig,
    navTree,
    files,
    currentFile: resolvedPath,
  };
}

/**
 * Flatten nav tree to list of file paths
 */
function flattenNavTree(nodes, projectRoot) {
  const files = [];
  for (const node of nodes) {
    if (!node.isFolder) {
      files.push(path.join(projectRoot, node.path));
    } else if (node.children) {
      files.push(...flattenNavTree(node.children, projectRoot));
    }
  }
  return files;
}

/**
 * Parse mrmd.md config (from yaml config code blocks)
 */
function parseMrmdConfig(content) {
  const config = { venv: '.venv' };

  // Find all ```yaml config blocks and merge them
  const configBlockRegex = /```yaml\s+config\n([\s\S]*?)```/g;
  let match;

  while ((match = configBlockRegex.exec(content)) !== null) {
    const yaml = match[1];

    // Parse name
    const nameMatch = yaml.match(/^name:\s*["']?([^"'\n]+)["']?/m);
    if (nameMatch) {
      config.name = nameMatch[1].trim();
    }

    // Parse venv (direct or under session.python)
    const venvMatch = yaml.match(/^\s*venv:\s*["']?([^"'\n]+)["']?/m);
    if (venvMatch) {
      config.venv = venvMatch[1].trim();
    }

    // Parse session config
    const sessionMatch = yaml.match(/^session:\n([\s\S]*?)(?=^[^\s]|\Z)/m);
    if (sessionMatch) {
      config.session = {};
      const sessionYaml = sessionMatch[1];

      // Parse python session
      const pythonMatch = sessionYaml.match(/^\s+python:\n([\s\S]*?)(?=^\s+\w+:|\Z)/m);
      if (pythonMatch) {
        config.session.python = {};
        const pyYaml = pythonMatch[1];
        const pyVenv = pyYaml.match(/venv:\s*["']?([^"'\n]+)["']?/);
        if (pyVenv) config.session.python.venv = pyVenv[1].trim();
        const pyCwd = pyYaml.match(/cwd:\s*["']?([^"'\n]+)["']?/);
        if (pyCwd) config.session.python.cwd = pyCwd[1].trim();
        const pyName = pyYaml.match(/name:\s*["']?([^"'\n]+)["']?/);
        if (pyName) config.session.python.name = pyName[1].trim();
        const pyAutoStart = pyYaml.match(/auto_start:\s*(true|false)/);
        if (pyAutoStart) config.session.python.auto_start = pyAutoStart[1] === 'true';
      }
    }
  }

  // Also check YAML frontmatter for backwards compatibility
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const yaml = fmMatch[1];
    const venvMatch = yaml.match(/venv:\s*(.+)/);
    if (venvMatch && !config.venv) {
      config.venv = venvMatch[1].trim();
    }
  }

  return config;
}

/**
 * Build navigation tree for a project
 */
async function buildNavTree(projectRoot, relativePath = '') {
  const fullPath = path.join(projectRoot, relativePath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const nodes = [];

  // Sort entries: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    // Handle FSML ordering (numeric prefixes)
    const aNum = parseInt(a.name.match(/^(\d+)/)?.[1] || '999');
    const bNum = parseInt(b.name.match(/^(\d+)/)?.[1] || '999');
    if (aNum !== bNum) return aNum - bNum;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    // Skip hidden files and special directories
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name === '__pycache__') continue;
    if (entry.name === '_assets') continue;

    const entryRelPath = path.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildNavTree(projectRoot, entryRelPath);
      // Only include directories that have markdown-like doc files (directly or nested)
      if (children.length > 0 || await hasIndexFile(path.join(projectRoot, entryRelPath))) {
        nodes.push({
          isFolder: true,
          title: cleanName(entry.name),
          path: entryRelPath,
          children,
        });
      }
    } else if (isDocFile(entry.name) && entry.name !== 'mrmd.md') {
      nodes.push({
        isFolder: false,
        title: cleanName(stripDocExtension(entry.name)),
        path: entryRelPath,
      });
    }
  }

  return nodes;
}

/**
 * Check if directory has an index file
 */
async function hasIndexFile(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.some(e => isDocFile(e));
  } catch {
    return false;
  }
}

/**
 * Clean FSML numeric prefix from name
 */
function cleanName(name) {
  return name.replace(/^\d+[-_.\s]*/, '');
}
