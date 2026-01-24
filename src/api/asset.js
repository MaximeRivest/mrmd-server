/**
 * Asset API routes
 *
 * Mirrors electronAPI.asset.*
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import multer from 'multer';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

/**
 * Create asset routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createAssetRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/asset?projectRoot=...
   * List all assets in a project
   * Mirrors: electronAPI.asset.list(projectRoot)
   */
  router.get('/', async (req, res) => {
    try {
      const projectRoot = req.query.projectRoot || ctx.projectDir;
      const assetsDir = path.join(projectRoot, '_assets');

      try {
        const files = await fs.readdir(assetsDir);
        const assets = [];

        for (const file of files) {
          if (file.startsWith('.')) continue;

          const filePath = path.join(assetsDir, file);
          const stat = await fs.stat(filePath);

          assets.push({
            name: file,
            path: `_assets/${file}`,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }

        res.json(assets);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return res.json([]);
        }
        throw err;
      }
    } catch (err) {
      console.error('[asset:list]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/asset/save
   * Save an asset (handles deduplication)
   * Mirrors: electronAPI.asset.save(projectRoot, file, filename)
   *
   * Accepts multipart form data with 'file' field
   * or JSON with 'file' as base64 or array of bytes
   */
  router.post('/save', upload.single('file'), async (req, res) => {
    try {
      const projectRoot = req.body.projectRoot || ctx.projectDir;
      let filename = req.body.filename || req.file?.originalname || 'untitled';
      let fileBuffer;

      if (req.file) {
        // Multipart upload
        fileBuffer = req.file.buffer;
      } else if (req.body.file) {
        // JSON with base64 or array
        if (typeof req.body.file === 'string') {
          fileBuffer = Buffer.from(req.body.file, 'base64');
        } else if (Array.isArray(req.body.file)) {
          fileBuffer = Buffer.from(req.body.file);
        } else {
          return res.status(400).json({ error: 'Invalid file format' });
        }
      } else {
        return res.status(400).json({ error: 'No file provided' });
      }

      const assetsDir = path.join(projectRoot, '_assets');
      await fs.mkdir(assetsDir, { recursive: true });

      // Compute hash for deduplication
      const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex').slice(0, 8);
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);

      // Check if identical file already exists
      const existingFiles = await fs.readdir(assetsDir).catch(() => []);
      for (const existing of existingFiles) {
        if (existing.startsWith(hash + '-')) {
          // Found duplicate
          return res.json({
            path: `_assets/${existing}`,
            deduplicated: true,
          });
        }
      }

      // Save with hash prefix
      const finalName = `${hash}-${base}${ext}`;
      const finalPath = path.join(assetsDir, finalName);

      await fs.writeFile(finalPath, fileBuffer);

      res.json({
        path: `_assets/${finalName}`,
        deduplicated: false,
      });
    } catch (err) {
      console.error('[asset:save]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/asset/relative-path?assetPath=...&documentPath=...
   * Get relative path from document to asset
   * Mirrors: electronAPI.asset.relativePath(assetPath, documentPath)
   */
  router.get('/relative-path', async (req, res) => {
    try {
      const { assetPath, documentPath } = req.query;

      if (!assetPath || !documentPath) {
        return res.status(400).json({ error: 'assetPath and documentPath required' });
      }

      // Calculate relative path from document to asset
      const docDir = path.dirname(documentPath);
      const relativePath = path.relative(docDir, assetPath);

      res.json({ relativePath });
    } catch (err) {
      console.error('[asset:relativePath]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/asset/orphans?projectRoot=...
   * Find orphaned assets
   * Mirrors: electronAPI.asset.orphans(projectRoot)
   */
  router.get('/orphans', async (req, res) => {
    try {
      const projectRoot = req.query.projectRoot || ctx.projectDir;
      const assetsDir = path.join(projectRoot, '_assets');

      // Get all assets
      let assetFiles;
      try {
        assetFiles = await fs.readdir(assetsDir);
      } catch {
        return res.json([]);
      }

      // Get all markdown files
      const mdFiles = await scanMarkdownFiles(projectRoot);

      // Read all markdown content and find referenced assets
      const referencedAssets = new Set();
      for (const mdFile of mdFiles) {
        try {
          const content = await fs.readFile(mdFile, 'utf-8');
          // Find asset references (images, links)
          const matches = content.matchAll(/!\[.*?\]\(([^)]+)\)|href="([^"]+)"/g);
          for (const match of matches) {
            const ref = match[1] || match[2];
            if (ref && ref.includes('_assets/')) {
              const assetName = path.basename(ref);
              referencedAssets.add(assetName);
            }
          }
        } catch {}
      }

      // Find orphans
      const orphans = assetFiles.filter(f => !f.startsWith('.') && !referencedAssets.has(f));

      res.json(orphans.map(f => `_assets/${f}`));
    } catch (err) {
      console.error('[asset:orphans]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/asset?projectRoot=...&assetPath=...
   * Delete an asset
   * Mirrors: electronAPI.asset.delete(projectRoot, assetPath)
   */
  router.delete('/', async (req, res) => {
    try {
      const projectRoot = req.query.projectRoot || ctx.projectDir;
      const assetPath = req.query.assetPath;

      if (!assetPath) {
        return res.status(400).json({ error: 'assetPath required' });
      }

      const fullPath = path.join(projectRoot, assetPath);

      // Security check
      if (!fullPath.startsWith(path.resolve(projectRoot))) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      await fs.unlink(fullPath);
      res.json({ success: true });
    } catch (err) {
      console.error('[asset:delete]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/asset/file/*
   * Serve asset files (for image preview in browser)
   */
  router.get('/file/*', async (req, res) => {
    try {
      const assetPath = req.params[0];
      const fullPath = path.join(ctx.projectDir, '_assets', assetPath);

      // Security check
      if (!fullPath.startsWith(path.resolve(ctx.projectDir))) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      res.sendFile(fullPath);
    } catch (err) {
      console.error('[asset:file]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Recursively scan for markdown files
 */
async function scanMarkdownFiles(dir, maxDepth = 6, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];

  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name === '_assets') continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await scanMarkdownFiles(fullPath, maxDepth, currentDepth + 1);
      files.push(...subFiles);
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}
