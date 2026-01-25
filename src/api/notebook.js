/**
 * Notebook (Jupyter) API routes
 *
 * Mirrors electronAPI.notebook.*
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

// Active sync processes: ipynbPath -> { process, shadowPath, syncPort }
const syncProcesses = new Map();

/**
 * Create notebook routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createNotebookRoutes(ctx) {
  const router = Router();

  /**
   * POST /api/notebook/convert
   * Convert a Jupyter notebook to markdown (deletes the .ipynb file)
   * Mirrors: electronAPI.notebook.convert(ipynbPath)
   */
  router.post('/convert', async (req, res) => {
    try {
      const { ipynbPath } = req.body;
      if (!ipynbPath) {
        return res.status(400).json({ error: 'ipynbPath required' });
      }

      const fullPath = path.resolve(ctx.projectDir, ipynbPath);

      // Verify file exists and is .ipynb
      try {
        await fs.access(fullPath);
      } catch {
        return res.status(404).json({ success: false, error: 'File not found' });
      }

      if (!fullPath.endsWith('.ipynb')) {
        return res.status(400).json({ success: false, error: 'File must be a .ipynb file' });
      }

      // Read notebook
      const content = await fs.readFile(fullPath, 'utf-8');
      const notebook = JSON.parse(content);

      // Convert to markdown
      const markdown = convertNotebookToMarkdown(notebook);

      // Write markdown file
      const mdPath = fullPath.replace(/\.ipynb$/, '.md');
      await fs.writeFile(mdPath, markdown, 'utf-8');

      // Delete original .ipynb
      await fs.unlink(fullPath);

      res.json({
        success: true,
        mdPath: path.relative(ctx.projectDir, mdPath),
      });
    } catch (err) {
      console.error('[notebook:convert]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/notebook/start-sync
   * Start syncing a notebook (creates shadow .md in .mrmd folder)
   * Mirrors: electronAPI.notebook.startSync(ipynbPath)
   */
  router.post('/start-sync', async (req, res) => {
    try {
      const { ipynbPath } = req.body;
      if (!ipynbPath) {
        return res.status(400).json({ error: 'ipynbPath required' });
      }

      const fullPath = path.resolve(ctx.projectDir, ipynbPath);

      // Check if already syncing
      if (syncProcesses.has(fullPath)) {
        const existing = syncProcesses.get(fullPath);
        return res.json({
          success: true,
          shadowPath: existing.shadowPath,
          syncPort: existing.syncPort,
          reused: true,
        });
      }

      // Verify file exists
      try {
        await fs.access(fullPath);
      } catch {
        return res.status(404).json({ success: false, error: 'File not found' });
      }

      // Create .mrmd directory if needed
      const mrmdDir = path.join(path.dirname(fullPath), '.mrmd');
      await fs.mkdir(mrmdDir, { recursive: true });

      // Create shadow markdown file
      const baseName = path.basename(fullPath, '.ipynb');
      const shadowPath = path.join(mrmdDir, `${baseName}.shadow.md`);

      // Read and convert notebook
      const content = await fs.readFile(fullPath, 'utf-8');
      const notebook = JSON.parse(content);
      const markdown = convertNotebookToMarkdown(notebook);
      await fs.writeFile(shadowPath, markdown, 'utf-8');

      // Find mrmd-jupyter-bridge
      const bridgePaths = [
        path.join(ctx.projectDir, '../mrmd-jupyter-bridge'),
        path.join(process.cwd(), '../mrmd-jupyter-bridge'),
        path.join(process.cwd(), 'mrmd-jupyter-bridge'),
      ];

      let bridgePath = null;
      for (const p of bridgePaths) {
        try {
          await fs.access(path.join(p, 'package.json'));
          bridgePath = p;
          break;
        } catch {}
      }

      let syncPort = null;
      let proc = null;

      if (bridgePath) {
        // Start sync process
        syncPort = 4450 + syncProcesses.size;

        proc = spawn('node', [
          path.join(bridgePath, 'src', 'sync.js'),
          '--notebook', fullPath,
          '--shadow', shadowPath,
          '--port', syncPort.toString(),
        ], {
          cwd: path.dirname(fullPath),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.on('exit', () => {
          syncProcesses.delete(fullPath);
        });
      }

      syncProcesses.set(fullPath, {
        process: proc,
        shadowPath: path.relative(ctx.projectDir, shadowPath),
        syncPort,
      });

      res.json({
        success: true,
        shadowPath: path.relative(ctx.projectDir, shadowPath),
        syncPort,
      });
    } catch (err) {
      console.error('[notebook:startSync]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/notebook/stop-sync
   * Stop syncing a notebook
   * Mirrors: electronAPI.notebook.stopSync(ipynbPath)
   */
  router.post('/stop-sync', async (req, res) => {
    try {
      const { ipynbPath } = req.body;
      if (!ipynbPath) {
        return res.status(400).json({ error: 'ipynbPath required' });
      }

      const fullPath = path.resolve(ctx.projectDir, ipynbPath);
      const sync = syncProcesses.get(fullPath);

      if (sync) {
        if (sync.process && !sync.process.killed) {
          sync.process.kill();
        }
        syncProcesses.delete(fullPath);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[notebook:stopSync]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

/**
 * Convert Jupyter notebook to markdown
 */
function convertNotebookToMarkdown(notebook) {
  const cells = notebook.cells || [];
  const lines = [];

  // Add frontmatter if notebook has metadata
  if (notebook.metadata?.kernelspec?.language) {
    lines.push('---');
    lines.push(`language: ${notebook.metadata.kernelspec.language}`);
    if (notebook.metadata.kernelspec.display_name) {
      lines.push(`kernel: ${notebook.metadata.kernelspec.display_name}`);
    }
    lines.push('---');
    lines.push('');
  }

  for (const cell of cells) {
    const source = Array.isArray(cell.source)
      ? cell.source.join('')
      : cell.source || '';

    if (cell.cell_type === 'markdown') {
      lines.push(source.trim());
      lines.push('');
    } else if (cell.cell_type === 'code') {
      // Determine language
      const lang = notebook.metadata?.kernelspec?.language || 'python';

      lines.push('```' + lang);
      lines.push(source.trim());
      lines.push('```');
      lines.push('');

      // Add outputs if present
      if (cell.outputs && cell.outputs.length > 0) {
        for (const output of cell.outputs) {
          if (output.output_type === 'stream') {
            const text = Array.isArray(output.text)
              ? output.text.join('')
              : output.text || '';
            if (text.trim()) {
              lines.push('```output');
              lines.push(text.trim());
              lines.push('```');
              lines.push('');
            }
          } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
            const data = output.data || {};
            if (data['text/plain']) {
              const text = Array.isArray(data['text/plain'])
                ? data['text/plain'].join('')
                : data['text/plain'];
              lines.push('```output');
              lines.push(text.trim());
              lines.push('```');
              lines.push('');
            }
            // Handle images
            if (data['image/png']) {
              lines.push(`![output](data:image/png;base64,${data['image/png']})`);
              lines.push('');
            }
          } else if (output.output_type === 'error') {
            const traceback = output.traceback || [];
            // Strip ANSI codes
            const cleanTraceback = traceback
              .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
              .join('\n');
            lines.push('```error');
            lines.push(cleanTraceback.trim());
            lines.push('```');
            lines.push('');
          }
        }
      }
    } else if (cell.cell_type === 'raw') {
      lines.push('```');
      lines.push(source.trim());
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}
