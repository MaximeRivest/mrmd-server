/**
 * Sync Server Manager for mrmd-server
 *
 * Ported from mrmd-electron/main.js to provide dynamic per-project sync servers.
 * Allows mrmd-server to handle files from any project, not just a fixed projectDir.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

// Import utilities from mrmd-electron
import { findFreePort, waitForPort, isProcessAlive } from 'mrmd-electron/src/utils/index.js';
import { SYNC_SERVER_MEMORY_MB, DIR_HASH_LENGTH } from 'mrmd-electron/src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track active sync servers by directory hash
const syncServers = new Map();

// Event listeners for sync death notifications
const syncDeathListeners = new Set();

/**
 * Hash a directory path to a short, filesystem-safe string
 */
function computeDirHash(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, DIR_HASH_LENGTH);
}

/**
 * Resolve the path to an mrmd package's CLI script
 * In dev mode: Returns path to source CLI in sibling directory
 */
function resolvePackageBin(packageName, binPath) {
  // Try sibling directory (for monorepo development)
  const siblingPath = path.join(path.dirname(path.dirname(__dirname)), packageName, binPath);
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }

  // Try node_modules
  try {
    const packageJson = path.dirname(require.resolve(`${packageName}/package.json`));
    return path.join(packageJson, binPath);
  } catch (e) {
    // Fallback for ESM - look relative to mrmd-server
    const nmPath = path.join(__dirname, '..', 'node_modules', packageName, binPath);
    if (fs.existsSync(nmPath)) {
      return nmPath;
    }
    throw new Error(`Cannot resolve ${packageName}: ${e.message}`);
  }
}

/**
 * Notify all registered listeners that a sync server died
 */
function notifySyncDied(projectDir, exitCode, signal) {
  const message = {
    projectDir,
    exitCode,
    signal,
    timestamp: new Date().toISOString(),
    reason: exitCode === null ? 'crashed (likely OOM)' : `exited with code ${exitCode}`,
  };

  console.error(`[sync] CRITICAL: Sync server died for ${projectDir}:`, message.reason);

  for (const listener of syncDeathListeners) {
    try {
      listener(message);
    } catch (e) {
      console.error('[sync] Error in death listener:', e);
    }
  }
}

/**
 * Register a listener to be notified when any sync server dies
 * @param {Function} listener - Called with {projectDir, exitCode, signal, timestamp, reason}
 * @returns {Function} Unsubscribe function
 */
export function onSyncDeath(listener) {
  syncDeathListeners.add(listener);
  return () => syncDeathListeners.delete(listener);
}

/**
 * Get or start a sync server for a project directory
 * Uses reference counting so multiple documents can share a sync server
 *
 * @param {string} projectDir - The project directory to sync
 * @returns {Promise<{port: number, dir: string, refCount: number}>}
 */
export async function acquireSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);

  // Reuse existing server if available
  if (syncServers.has(dirHash)) {
    const server = syncServers.get(dirHash);
    server.refCount++;
    console.log(`[sync] Reusing server for ${projectDir} on port ${server.port} (refCount: ${server.refCount})`);
    return server;
  }

  // Check for existing server from a PID file (in case of restart)
  const syncStatePath = path.join(os.tmpdir(), `mrmd-sync-${dirHash}`, 'server.pid');
  try {
    if (fs.existsSync(syncStatePath)) {
      const pidData = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
      if (isProcessAlive(pidData.pid)) {
        console.log(`[sync] Found existing server on port ${pidData.port}`);
        const server = { proc: null, port: pidData.port, dir: projectDir, refCount: 1, owned: false };
        syncServers.set(dirHash, server);
        return server;
      } else {
        fs.unlinkSync(syncStatePath);
      }
    }
  } catch (e) {
    // Ignore errors reading PID file
  }

  // Start a new sync server
  const port = await findFreePort();
  console.log(`[sync] Starting server for ${projectDir} on port ${port}...`);

  const syncCliPath = resolvePackageBin('mrmd-sync', 'bin/cli.js');
  const nodeArgs = [
    `--max-old-space-size=${SYNC_SERVER_MEMORY_MB}`,
    syncCliPath,
    '--port', port.toString(),
    '--i-know-what-i-am-doing',
    projectDir,
  ];

  const proc = spawn('node', nodeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.expectedExit = false;

  proc.stdout.on('data', (d) => console.log(`[sync:${port}]`, d.toString().trim()));
  proc.stderr.on('data', (d) => console.error(`[sync:${port}]`, d.toString().trim()));

  // Handle unexpected exits (data loss prevention)
  proc.on('exit', (code, signal) => {
    console.log(`[sync:${port}] Exited with code ${code}, signal ${signal}`);
    syncServers.delete(dirHash);

    if (!proc.expectedExit) {
      notifySyncDied(projectDir, code, signal);
    }
  });

  await waitForPort(port);

  const server = { proc, port, dir: projectDir, refCount: 1, owned: true };
  syncServers.set(dirHash, server);
  return server;
}

/**
 * Release a sync server reference
 * If refCount reaches 0, the server is stopped
 *
 * @param {string} projectDir - The project directory
 */
export function releaseSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);
  const server = syncServers.get(dirHash);
  if (!server) return;

  server.refCount--;
  console.log(`[sync] Released server for ${projectDir} (refCount: ${server.refCount})`);

  if (server.refCount <= 0 && server.owned && server.proc) {
    console.log(`[sync] Stopping server for ${projectDir}`);
    server.proc.expectedExit = true;
    server.proc.kill('SIGTERM');
    syncServers.delete(dirHash);
  }
}

/**
 * Get the sync server for a project if one is running
 *
 * @param {string} projectDir - The project directory
 * @returns {Object|null} The server info or null
 */
export function getSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);
  return syncServers.get(dirHash) || null;
}

/**
 * List all active sync servers
 * @returns {Array<{dir: string, port: number, refCount: number, owned: boolean}>}
 */
export function listSyncServers() {
  return Array.from(syncServers.values()).map(s => ({
    dir: s.dir,
    port: s.port,
    refCount: s.refCount,
    owned: s.owned,
  }));
}

/**
 * Stop all sync servers (for shutdown)
 */
export function stopAllSyncServers() {
  for (const [hash, server] of syncServers) {
    if (server.owned && server.proc) {
      console.log(`[sync] Stopping server for ${server.dir}`);
      server.proc.expectedExit = true;
      server.proc.kill('SIGTERM');
    }
  }
  syncServers.clear();
}
