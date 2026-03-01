/**
 * Project API routes
 *
 * Mirrors electronAPI.project.* using ProjectService from mrmd-electron
 * and dynamic sync server management.
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { watch } from 'chokidar';

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
 * Resolve project root from a file path without requiring mrmd.md.
 */
function findGitRoot(startDir) {
  let current = path.resolve(startDir || '/');
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

async function hasDocsInDir(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && isDocFile(entry.name));
  } catch {
    return false;
  }
}

async function detectProject(filePath) {
  const abs = path.resolve(filePath);
  let startDir = abs;
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile()) startDir = path.dirname(abs);
  } catch {
    if (path.extname(abs)) startDir = path.dirname(abs);
  }

  const gitRoot = findGitRoot(startDir);
  if (gitRoot) {
    return { root: gitRoot, config: { name: path.basename(gitRoot) || 'Project' } };
  }

  let candidate = startDir;
  let current = startDir;
  const homeDir = path.resolve(process.env.HOME || '/');
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current || parent === '/' || parent === homeDir) break;
    if (await hasDocsInDir(parent)) {
      candidate = parent;
      current = parent;
      continue;
    }
    break;
  }

  return {
    root: candidate,
    config: { name: path.basename(candidate) || 'Project' },
  };
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
      const detected = await detectProject(resolvedPath);

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
   * 1. Creates scaffold files (index + assets)
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
   * GET /api/project/raw-tree?root=...&showSystem=true&maxDepth=...
   * Get raw file tree (all files, actual filenames) for file browser view.
   * Mirrors: electronAPI.project.rawTree(root, showSystem, maxDepth)
   */
  router.get('/raw-tree', async (req, res) => {
    try {
      const root = req.query.root || ctx.projectDir;
      const showSystem = req.query.showSystem === 'true';
      const maxDepth = Number.isFinite(Number(req.query.maxDepth)) ? Number(req.query.maxDepth) : undefined;

      if (!root) {
        return res.status(400).json({ error: 'root query parameter required' });
      }

      // Use shared ProjectService implementation so Electron + server stay aligned.
      const tree = await projectService.getRawTree(root, {
        showSystem,
        ...(Number.isInteger(maxDepth) && maxDepth >= 0 ? { maxDepth } : {}),
      });

      res.json(tree);
    } catch (err) {
      console.error('[project:raw-tree]', err);
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
      const root = projectRoot || ctx.projectDir;
      if (root) {
        projectService.invalidate(root);
      }
      ctx.eventBus.projectChanged(root);
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
        const isDirectoryEvent = !path.extname(filePath || '');
        if (isDocFile(filePath) || isDirectoryEvent) {
          projectService.invalidate(watchPath);
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
  const detected = await detectProject(resolvedPath);
  const projectRoot = detected?.root || path.dirname(resolvedPath);
  const config = detected?.config || { name: path.basename(projectRoot) || 'Project' };

  // Build nav tree
  const navTree = await buildNavTree(projectRoot);

  // Collect all files from nav tree (flattened)
  const files = flattenNavTree(navTree, projectRoot);

  return {
    root: projectRoot,
    config,
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
    } else if (isDocFile(entry.name)) {
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

