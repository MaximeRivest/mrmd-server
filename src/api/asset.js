/**
 * Asset API routes
 *
 * Mirrors electronAPI.asset.* using AssetService from mrmd-electron
 */

import { Router } from 'express';
import path from 'path';
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
  const { assetService } = ctx;

  /**
   * GET /api/asset?projectRoot=...
   * List all assets in a project
   * Mirrors: electronAPI.asset.list(projectRoot)
   */
  router.get('/', async (req, res) => {
    try {
      const projectRoot = req.query.projectRoot || ctx.projectDir;
      const assets = await assetService.list(projectRoot);
      res.json(assets);
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

      // AssetService.save expects a file-like object
      const result = await assetService.save(projectRoot, fileBuffer, filename);
      res.json(result);
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
      const orphans = await assetService.findOrphans(projectRoot);
      res.json(orphans);
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

      await assetService.delete(projectRoot, assetPath);
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
