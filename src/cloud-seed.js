/**
 * Cloud Seeding — materialize relay documents to the local filesystem
 *
 * When the editor container starts in cloud mode, this module fetches
 * all the user's documents from the sync relay and writes them as .md
 * files so they appear in the nav tree. It also writes Yjs binary
 * snapshots so that local mrmd-sync loads the relay's exact Yjs state
 * (avoiding Yjs content duplication when the bridge connects).
 *
 * Usage:
 *   import { seedFromRelay } from './cloud-seed.js';
 *   await seedFromRelay({
 *     relayUrl: 'http://localhost:3006',
 *     userId: '31bdffb9-...',
 *     homeDir: '/home/ubuntu',
 *   });
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';

/**
 * Seed the local filesystem with documents from the sync relay.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl - HTTP URL of the sync relay (e.g. 'http://localhost:3006')
 * @param {string} opts.userId - User UUID
 * @param {string} opts.homeDir - User's home directory (where projects are created)
 * @returns {Promise<{seededProjects: string[], seededDocs: number, errors: string[]}>}
 */
export async function seedFromRelay(opts) {
  const { relayUrl, userId, homeDir } = opts;
  const errors = [];
  const seededProjects = [];
  let seededDocs = 0;

  console.log(`[cloud-seed] Seeding from relay ${relayUrl} for user ${userId}`);

  // 1. Fetch all projects and their documents from the relay
  let projectData;
  try {
    const listUrl = `${relayUrl}/api/documents/${encodeURIComponent(userId)}`;
    const res = await fetch(listUrl, {
      headers: { 'X-User-Id': userId },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const msg = `Failed to list documents: HTTP ${res.status}`;
      console.error(`[cloud-seed] ${msg}`);
      return { seededProjects: [], seededDocs: 0, errors: [msg] };
    }

    projectData = await res.json();
  } catch (err) {
    const msg = `Failed to fetch document list: ${err.message}`;
    console.error(`[cloud-seed] ${msg}`);
    return { seededProjects: [], seededDocs: 0, errors: [msg] };
  }

  if (!projectData?.projects) {
    console.log('[cloud-seed] No projects found in relay');
    return { seededProjects: [], seededDocs: 0, errors: [] };
  }

  // 2. For each project, fetch documents with content + Yjs state
  for (const [projectName, projectInfo] of Object.entries(projectData.projects)) {
    // Skip empty projects
    if (!projectInfo.docCount || projectInfo.docCount === 0) continue;

    // Skip 'desktop-e2e' test projects
    if (projectName === 'desktop-e2e') continue;

    console.log(`[cloud-seed] Seeding project "${projectName}" (${projectInfo.docCount} docs)`);

    // Determine project directory
    const projectDir = join(homeDir, projectName);

    try {
      // Fetch documents with content and Yjs state for this project
      const docsUrl = `${relayUrl}/api/documents/${encodeURIComponent(userId)}/${encodeURIComponent(projectName)}?content=1&yjs=1`;
      const docsRes = await fetch(docsUrl, {
        headers: { 'X-User-Id': userId },
        signal: AbortSignal.timeout(30000),
      });

      if (!docsRes.ok) {
        errors.push(`Failed to fetch docs for ${projectName}: HTTP ${docsRes.status}`);
        continue;
      }

      const docsData = await docsRes.json();
      if (!docsData?.documents?.length) continue;

      // Ensure project directory exists
      mkdirSync(projectDir, { recursive: true });

      // Create mrmd.md config if it doesn't exist
      const mrmdPath = join(projectDir, 'mrmd.md');
      if (!existsSync(mrmdPath)) {
        const mrmdContent = `# ${projectName}\n\n\`\`\`yaml config\nname: "${projectName}"\nsession:\n  python:\n    venv: ".venv"\n\`\`\`\n`;
        writeFileSync(mrmdPath, mrmdContent, 'utf8');
        console.log(`[cloud-seed]   Created ${mrmdPath}`);
      }

      // Compute dirHash for Yjs snapshot directory
      const dirHash = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
      const snapshotDir = join(tmpdir(), `mrmd-sync-${dirHash}`);
      mkdirSync(snapshotDir, { recursive: true });

      // Write each document
      for (const doc of docsData.documents) {
        try {
          const filePath = join(projectDir, `${doc.docPath}.md`);
          const fileDir = dirname(filePath);
          mkdirSync(fileDir, { recursive: true });

          // Write .md file (only if content changed or file doesn't exist)
          const existingContent = existsSync(filePath)
            ? readFileSync(filePath, 'utf8')
            : null;

          if (existingContent !== doc.content) {
            writeFileSync(filePath, doc.content || '', 'utf8');
          }

          // Write Yjs snapshot (critical: prevents content duplication)
          if (doc.yjsState) {
            const safeSnapshotName = doc.docPath.replace(/\//g, '__').replace(/^_+/, '');
            const snapshotPath = join(snapshotDir, `${safeSnapshotName}.yjs`);
            writeFileSync(snapshotPath, doc.yjsState, 'utf8'); // Already base64
          }

          seededDocs++;
        } catch (err) {
          errors.push(`Failed to write ${doc.docPath}: ${err.message}`);
        }
      }

      seededProjects.push(projectName);
      console.log(`[cloud-seed]   Seeded ${docsData.documents.length} docs to ${projectDir}`);
    } catch (err) {
      errors.push(`Failed to seed project ${projectName}: ${err.message}`);
    }
  }

  console.log(`[cloud-seed] Done: ${seededProjects.length} projects, ${seededDocs} docs, ${errors.length} errors`);
  if (errors.length > 0) {
    console.warn('[cloud-seed] Errors:', errors);
  }

  return { seededProjects, seededDocs, errors };
}

/**
 * Periodically poll the relay for new projects/documents and seed them.
 * Returns a stop function to cancel the watcher.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl - HTTP URL of the sync relay
 * @param {string} opts.userId - User UUID
 * @param {string} opts.homeDir - User's home directory
 * @param {number} [opts.intervalMs=30000] - Poll interval
 * @param {function} [opts.onNewDocs] - Callback({project, docs[]}) when new docs are seeded
 * @returns {{ stop: () => void }}
 */
export function startProjectWatcher(opts) {
  const { relayUrl, userId, homeDir, intervalMs = 30000, onNewDocs } = opts;

  /** Set of "project/docPath" strings we've already seeded */
  const seededSet = new Set();

  // Pre-populate with what's already on disk
  _scanExistingDocs(homeDir, seededSet);

  let timer = null;
  let running = false;

  async function poll() {
    if (running) return;
    running = true;
    try {
      const listUrl = `${relayUrl}/api/documents/${encodeURIComponent(userId)}`;
      const res = await fetch(listUrl, {
        headers: { 'X-User-Id': userId },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const projectData = await res.json();
      if (!projectData?.projects) return;

      for (const [projectName, projectInfo] of Object.entries(projectData.projects)) {
        if (!projectInfo.docCount || projectName === 'desktop-e2e') continue;

        // Check if any docs in this project are new
        const knownCount = _countProjectDocs(projectName, seededSet);
        if (knownCount >= projectInfo.docCount) continue;

        // Fetch and seed new docs
        console.log(`[cloud-seed:watcher] New docs detected in "${projectName}" (known: ${knownCount}, relay: ${projectInfo.docCount})`);
        const docsUrl = `${relayUrl}/api/documents/${encodeURIComponent(userId)}/${encodeURIComponent(projectName)}?content=1&yjs=1`;
        const docsRes = await fetch(docsUrl, {
          headers: { 'X-User-Id': userId },
          signal: AbortSignal.timeout(30000),
        });
        if (!docsRes.ok) continue;
        const docsData = await docsRes.json();
        if (!docsData?.documents?.length) continue;

        const projectDir = join(homeDir, projectName);
        mkdirSync(projectDir, { recursive: true });

        // Create mrmd.md config if missing
        const mrmdPath = join(projectDir, 'mrmd.md');
        if (!existsSync(mrmdPath)) {
          const mrmdContent = `# ${projectName}\n\n\`\`\`yaml config\nname: "${projectName}"\nsession:\n  python:\n    venv: ".venv"\n\`\`\`\n`;
          writeFileSync(mrmdPath, mrmdContent, 'utf8');
        }

        const dirHash = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
        const snapshotDir = join(tmpdir(), `mrmd-sync-${dirHash}`);
        mkdirSync(snapshotDir, { recursive: true });

        const newDocs = [];
        for (const doc of docsData.documents) {
          const key = `${projectName}/${doc.docPath}`;
          if (seededSet.has(key)) continue;

          try {
            const filePath = join(projectDir, `${doc.docPath}.md`);
            mkdirSync(dirname(filePath), { recursive: true });

            const existingContent = existsSync(filePath)
              ? readFileSync(filePath, 'utf8')
              : null;
            if (existingContent !== doc.content) {
              writeFileSync(filePath, doc.content || '', 'utf8');
            }

            if (doc.yjsState) {
              const safeSnapshotName = doc.docPath.replace(/\//g, '__').replace(/^_+/, '');
              const snapshotPath = join(snapshotDir, `${safeSnapshotName}.yjs`);
              writeFileSync(snapshotPath, doc.yjsState, 'utf8');
            }

            seededSet.add(key);
            newDocs.push(doc.docPath);
          } catch { /* ignore individual doc errors */ }
        }

        if (newDocs.length > 0) {
          console.log(`[cloud-seed:watcher] Seeded ${newDocs.length} new docs for "${projectName}"`);
          if (onNewDocs) {
            try { onNewDocs({ project: projectName, projectDir, docs: newDocs }); } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      // Silent — don't spam logs on transient relay issues
    } finally {
      running = false;
    }
  }

  timer = setInterval(poll, intervalMs);
  // Run first poll after a short delay (let initial seed + bridges settle)
  setTimeout(poll, 5000);

  return {
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

/** Scan existing .md files on disk and populate the seeded set */
function _scanExistingDocs(homeDir, seededSet) {
  try {
    const entries = readdirSync(homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const projectName = entry.name;
      const projectDir = join(homeDir, projectName);
      _walkMd(projectDir, projectDir, projectName, seededSet);
    }
  } catch { /* ignore */ }
}

function _walkMd(dir, projectDir, projectName, seededSet) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
          entry.name === '.venv' || entry.name === '__pycache__' ||
          entry.name === '_assets') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        _walkMd(full, projectDir, projectName, seededSet);
      } else if (entry.name.endsWith('.md') && entry.name !== 'mrmd.md') {
        const rel = full.slice(projectDir.length + 1).replace(/\.md$/, '');
        seededSet.add(`${projectName}/${rel}`);
      }
    }
  } catch { /* ignore */ }
}

function _countProjectDocs(projectName, seededSet) {
  let count = 0;
  for (const key of seededSet) {
    if (key.startsWith(projectName + '/')) count++;
  }
  return count;
}

export default { seedFromRelay, startProjectWatcher };
