/**
 * Project API routes
 *
 * Mirrors electronAPI.project.*
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { watch } from 'chokidar';

/**
 * Create project routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createProjectRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/project?path=...
   * Get project info for a file path
   * Mirrors: electronAPI.project.get(filePath)
   */
  router.get('/', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const projectInfo = await getProjectInfo(filePath, ctx.projectDir);
      res.json(projectInfo);
    } catch (err) {
      console.error('[project:get]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/project
   * Create a new mrmd project
   * Mirrors: electronAPI.project.create(targetPath)
   */
  router.post('/', async (req, res) => {
    try {
      const { targetPath } = req.body;
      if (!targetPath) {
        return res.status(400).json({ error: 'targetPath required' });
      }

      const resolvedPath = path.resolve(ctx.projectDir, targetPath);

      // Create directory if it doesn't exist
      await fs.mkdir(resolvedPath, { recursive: true });

      // Create mrmd.md config file
      const mrmdPath = path.join(resolvedPath, 'mrmd.md');
      const mrmdContent = `# ${path.basename(resolvedPath)}

A new mrmd project.

---
venv: .venv
---
`;
      await fs.writeFile(mrmdPath, mrmdContent);

      // Get and return project info
      const projectInfo = await getProjectInfo(mrmdPath, ctx.projectDir);
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
        if (filePath.endsWith('.md')) {
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

  return {
    root: projectRoot,
    config: mrmdConfig,
    navTree,
    currentFile: resolvedPath,
  };
}

/**
 * Parse mrmd.md config (frontmatter)
 */
function parseMrmdConfig(content) {
  const config = { venv: '.venv' };

  // Simple YAML frontmatter parsing
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    const yaml = match[1];
    const venvMatch = yaml.match(/venv:\s*(.+)/);
    if (venvMatch) {
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
      // Only include directories that have .md files (directly or nested)
      if (children.length > 0 || await hasIndexFile(path.join(projectRoot, entryRelPath))) {
        nodes.push({
          type: 'folder',
          name: cleanName(entry.name),
          path: entryRelPath,
          children,
        });
      }
    } else if (entry.name.endsWith('.md') && entry.name !== 'mrmd.md') {
      nodes.push({
        type: 'file',
        name: cleanName(entry.name.replace(/\.md$/, '')),
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
    return entries.some(e => e.endsWith('.md'));
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
