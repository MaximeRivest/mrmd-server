/**
 * File API routes
 *
 * Mirrors electronAPI.file.*
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';

/**
 * Create file routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createFileRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/file/scan?root=...&extensions=...&maxDepth=...
   * Scan files in a directory
   * Mirrors: electronAPI.file.scan(root, options)
   */
  router.get('/scan', async (req, res) => {
    try {
      const root = req.query.root || ctx.projectDir;
      const extensions = req.query.extensions?.split(',') || ['.md'];
      const maxDepth = parseInt(req.query.maxDepth) || 6;
      const includeHidden = req.query.includeHidden === 'true';

      const files = await scanDirectory(root, extensions, maxDepth, includeHidden);
      res.json(files);
    } catch (err) {
      console.error('[file:scan]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/file/create
   * Create a file
   * Mirrors: electronAPI.file.create(filePath, content)
   */
  router.post('/create', async (req, res) => {
    try {
      const { filePath, content = '' } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: 'filePath required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);

      // Create directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Check if file exists
      try {
        await fs.access(fullPath, fsConstants.F_OK);
        return res.status(409).json({ error: 'File already exists' });
      } catch {
        // File doesn't exist, good to create
      }

      await fs.writeFile(fullPath, content, 'utf-8');

      ctx.eventBus.projectChanged(ctx.projectDir);
      res.json({ success: true, path: fullPath });
    } catch (err) {
      console.error('[file:create]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/file/create-in-project
   * Create a file within a project (handles FSML ordering)
   * Mirrors: electronAPI.file.createInProject(projectRoot, relativePath, content)
   */
  router.post('/create-in-project', async (req, res) => {
    try {
      const { projectRoot, relativePath, content = '' } = req.body;
      if (!relativePath) {
        return res.status(400).json({ error: 'relativePath required' });
      }

      const root = projectRoot || ctx.projectDir;
      const fullPath = resolveSafePath(root, relativePath);

      // Create directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // If file exists, find next available FSML name
      let finalPath = fullPath;
      try {
        await fs.access(fullPath, fsConstants.F_OK);
        // File exists, generate unique name
        const dir = path.dirname(fullPath);
        const ext = path.extname(fullPath);
        const base = path.basename(fullPath, ext);

        let counter = 1;
        while (true) {
          finalPath = path.join(dir, `${base}-${counter}${ext}`);
          try {
            await fs.access(finalPath, fsConstants.F_OK);
            counter++;
          } catch {
            break;
          }
        }
      } catch {
        // File doesn't exist, use original path
      }

      await fs.writeFile(finalPath, content, 'utf-8');

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        path: path.relative(root, finalPath),
      });
    } catch (err) {
      console.error('[file:createInProject]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/file/move
   * Move/rename a file (with automatic refactoring)
   * Mirrors: electronAPI.file.move(projectRoot, fromPath, toPath)
   */
  router.post('/move', async (req, res) => {
    try {
      const { projectRoot, fromPath, toPath } = req.body;
      if (!fromPath || !toPath) {
        return res.status(400).json({ error: 'fromPath and toPath required' });
      }

      const root = projectRoot || ctx.projectDir;
      const fullFromPath = resolveSafePath(root, fromPath);
      const fullToPath = resolveSafePath(root, toPath);

      // Create destination directory if needed
      await fs.mkdir(path.dirname(fullToPath), { recursive: true });

      // Move the file
      await fs.rename(fullFromPath, fullToPath);

      // TODO: Update internal links in other files (refactoring)
      // This would require parsing all .md files and updating links
      // For now, just return the moved file

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        movedFile: {
          from: fromPath,
          to: toPath,
        },
        updatedFiles: [], // TODO: implement link refactoring
      });
    } catch (err) {
      console.error('[file:move]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/file/reorder
   * Reorder a file/folder (drag-drop with FSML ordering)
   * Mirrors: electronAPI.file.reorder(projectRoot, sourcePath, targetPath, position)
   */
  router.post('/reorder', async (req, res) => {
    try {
      const { projectRoot, sourcePath, targetPath, position } = req.body;
      if (!sourcePath || !targetPath || !position) {
        return res.status(400).json({ error: 'sourcePath, targetPath, and position required' });
      }

      const root = projectRoot || ctx.projectDir;

      // TODO: Implement FSML reordering
      // This involves:
      // 1. Reading the source and target directories
      // 2. Calculating new FSML prefixes
      // 3. Renaming files with new prefixes

      // For now, just do a simple move
      const fullSourcePath = resolveSafePath(root, sourcePath);
      let fullTargetPath;

      if (position === 'inside') {
        // Move into target directory
        fullTargetPath = resolveSafePath(root, path.join(targetPath, path.basename(sourcePath)));
      } else {
        // Move to same directory as target
        fullTargetPath = resolveSafePath(root, path.join(path.dirname(targetPath), path.basename(sourcePath)));
      }

      await fs.mkdir(path.dirname(fullTargetPath), { recursive: true });
      await fs.rename(fullSourcePath, fullTargetPath);

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        movedFile: {
          from: sourcePath,
          to: path.relative(root, fullTargetPath),
        },
        updatedFiles: [],
      });
    } catch (err) {
      console.error('[file:reorder]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/file?path=...
   * Delete a file
   * Mirrors: electronAPI.file.delete(filePath)
   */
  router.delete('/', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await fs.rm(fullPath, { recursive: true });
      } else {
        await fs.unlink(fullPath);
      }

      ctx.eventBus.projectChanged(ctx.projectDir);
      res.json({ success: true });
    } catch (err) {
      console.error('[file:delete]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/file/read?path=...
   * Read a file
   * Mirrors: electronAPI.file.read(filePath)
   */
  router.get('/read', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');

      res.json({ success: true, content });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ success: false, error: 'File not found' });
      }
      console.error('[file:read]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/file/write
   * Write a file
   * Mirrors: electronAPI.file.write(filePath, content)
   */
  router.post('/write', async (req, res) => {
    try {
      const { filePath, content } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: 'filePath required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);

      // Create directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      await fs.writeFile(fullPath, content ?? '', 'utf-8');

      res.json({ success: true });
    } catch (err) {
      console.error('[file:write]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/file/preview?path=...&lines=...
   * Read file preview
   * Mirrors: electronAPI.readPreview(filePath, lines)
   */
  router.get('/preview', async (req, res) => {
    try {
      const filePath = req.query.path;
      const lines = parseInt(req.query.lines) || 40;

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const previewLines = content.split('\n').slice(0, lines).join('\n');

      res.json({ success: true, content: previewLines });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ success: false, error: 'File not found' });
      }
      console.error('[file:preview]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/file/info?path=...
   * Get file info
   * Mirrors: electronAPI.getFileInfo(filePath)
   */
  router.get('/info', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const fullPath = resolveSafePath(ctx.projectDir, filePath);
      const stat = await fs.stat(fullPath);

      res.json({
        path: fullPath,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        isDirectory: stat.isDirectory(),
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      console.error('[file:info]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Resolve path safely within project directory
 */
function resolveSafePath(projectDir, relativePath) {
  const resolved = path.resolve(projectDir, relativePath);

  // Security: ensure resolved path is within project directory
  if (!resolved.startsWith(path.resolve(projectDir))) {
    throw new Error('Path traversal not allowed');
  }

  return resolved;
}

/**
 * Scan directory for files
 */
async function scanDirectory(root, extensions, maxDepth, includeHidden, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];

  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files unless requested
    if (!includeHidden && entry.name.startsWith('.')) continue;

    // Skip common non-content directories
    if (entry.name === 'node_modules') continue;
    if (entry.name === '__pycache__') continue;
    if (entry.name === '.git') continue;

    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await scanDirectory(fullPath, extensions, maxDepth, includeHidden, currentDepth + 1);
      files.push(...subFiles);
    } else {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}
