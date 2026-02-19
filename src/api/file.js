/**
 * File API routes
 *
 * Mirrors electronAPI.file.* using FileService from mrmd-electron
 */

import { Router } from 'express';
import path from 'path';
import fsPromises from 'fs/promises';

/**
 * Scan directories for picker navigation (includes empty folders).
 * Returns absolute paths.
 */
async function scanDirectories(root, { maxDepth = 10, includeHidden = false } = {}) {
  const dirs = [];

  const walk = async (dir, depth) => {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip system files (.)
      if (entry.name.startsWith('.')) continue;

      // Skip hidden files (_) unless requested
      if (!includeHidden && entry.name.startsWith('_')) continue;

      // Skip node_modules
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      dirs.push(fullPath);
      await walk(fullPath, depth + 1);
    }
  };

  await walk(root, 0);
  return dirs;
}

/**
 * Create file routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createFileRoutes(ctx) {
  const router = Router();
  const { fileService } = ctx;

  /**
   * GET /api/file/scan?root=...&extensions=...&maxDepth=...
   * Scan files in a directory
   * Mirrors: electronAPI.file.scan(root, options)
   */
  router.get('/scan', async (req, res) => {
    try {
      // Default to project dir, then cwd, then home
      // On servers like RunPod, cwd (/workspace) is more useful than home (/root)
      const os = await import('os');
      const root = req.query.root || ctx.projectDir || process.cwd() || os.default.homedir();
      const options = {
        // Default to markdown-like docs and .ipynb (like Electron)
        extensions: req.query.extensions?.split(',') || ['.md', '.qmd', '.ipynb'],
        maxDepth: parseInt(req.query.maxDepth) || 10,
        includeHidden: req.query.includeHidden === 'true',
      };

      console.log(`[file:scan] Scanning ${root} with options:`, options);
      const relativeFiles = await fileService.scan(root, options);
      // Convert relative paths to absolute (file picker expects absolute paths)
      const files = relativeFiles.map(f => path.join(root, f));
      const dirs = await scanDirectories(root, options);
      console.log(`[file:scan] Found ${files.length} files, ${dirs.length} dirs`);

      // Return object for modern clients, still easy to consume by legacy ones.
      res.json({ files, dirs });
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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      await fileService.createFile(fullPath, content);

      ctx.eventBus.projectChanged(ctx.projectDir);
      res.json({ success: true, path: fullPath });
    } catch (err) {
      if (err.message?.includes('already exists')) {
        return res.status(409).json({ error: 'File already exists' });
      }
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
      const result = await fileService.createInProject(root, relativePath, content);

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        path: result,
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
      const result = await fileService.move(root, fromPath, toPath);

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        movedFile: result.movedFile,
        updatedFiles: result.updatedFiles || [],
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
      const result = await fileService.reorder(root, sourcePath, targetPath, position);

      ctx.eventBus.projectChanged(root);
      res.json({
        success: true,
        movedFile: result.movedFile,
        updatedFiles: result.updatedFiles || [],
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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      await fileService.delete(fullPath);

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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      const content = await fileService.read(fullPath);

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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      await fileService.write(fullPath, content ?? '');

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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      const content = await fileService.read(fullPath);
      const previewLines = content.split('\n').slice(0, lines).join('\n');

      res.json({ success: true, content: previewLines, preview: previewLines });
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

      const fullPath = resolvePath(ctx.projectDir, filePath);
      // FileService doesn't have getInfo, use fs directly for this simple operation
      const fs = await import('fs/promises');
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

  /**
   * GET /api/browse?path=...&type=all|dir|file&show_hidden=true
   * Browse the filesystem for the file picker.
   * Returns { path, parent, entries: [{name, path, type, size?, modified?}] }
   */
  router.get('/browse', async (req, res) => {
    try {
      const os = await import('os');
      const fs = await import('fs/promises');

      let browsePath = req.query.path || '~';
      if (browsePath === '~') {
        browsePath = ctx.projectDir || os.default.homedir();
      }

      const resolvedPath = path.resolve(browsePath);
      const typeFilter = req.query.type || 'all'; // 'all', 'dir', 'file'
      const showHidden = req.query.show_hidden === 'true';

      let dirEntries;
      try {
        dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') {
          return res.status(404).json({ error: 'Directory not found', path: resolvedPath });
        }
        if (err.code === 'EACCES') {
          return res.status(403).json({ error: 'Permission denied', path: resolvedPath });
        }
        throw err;
      }

      const entries = [];
      for (const entry of dirEntries) {
        // Skip hidden files unless requested
        if (!showHidden && entry.name.startsWith('.')) continue;
        // Skip common uninteresting directories
        if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') continue;

        const isDir = entry.isDirectory();
        const isFile = entry.isFile();
        if (!isDir && !isFile) continue;
        if (typeFilter === 'dir' && !isDir) continue;
        if (typeFilter === 'file' && !isFile) continue;

        const entryPath = path.join(resolvedPath, entry.name);
        const item = {
          name: entry.name,
          path: entryPath,
          type: isDir ? 'directory' : 'file',
        };

        // Add file metadata (best-effort, don't fail if stat errors)
        if (isFile) {
          try {
            const stat = await fs.stat(entryPath);
            item.size = stat.size;
            item.modified = stat.mtime.toISOString();
          } catch { /* ignore stat errors */ }
        }

        entries.push(item);
      }

      // Sort: directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      const parent = path.dirname(resolvedPath);
      res.json({
        path: resolvedPath,
        parent: parent !== resolvedPath ? parent : null,
        entries,
      });
    } catch (err) {
      console.error('[file:browse]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Resolve path - allows full filesystem access
 *
 * @param {string} basePath - Base path for relative paths (ignored for absolute)
 * @param {string} inputPath - Path to resolve (absolute or relative)
 * @returns {string} Resolved absolute path
 */
function resolvePath(basePath, inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(basePath, inputPath);
}
