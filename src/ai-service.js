/**
 * AI Service - manages the mrmd-ai server
 *
 * The AI server is shared across all sessions (stateless).
 * It's started once on first request and kept running.
 *
 * API keys are passed as environment variables to the AI server process
 * because dspy/litellm reads them from env vars.
 */

import { spawn, execSync } from 'child_process';
import net from 'net';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import os from 'os';

// AI server singleton
let aiServer = null;
let startPromise = null;

/**
 * Find a free port
 */
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Wait for a port to be available (server started)
 */
async function waitForPort(port, { timeout = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

/**
 * Find uv executable
 */
function findUv() {
  try {
    return execSync('which uv', { encoding: 'utf-8' }).trim();
  } catch {
    // Check common locations
    const locations = [
      path.join(os.homedir(), '.local', 'bin', 'uv'),
      '/usr/local/bin/uv',
      '/usr/bin/uv',
      path.join(os.homedir(), '.cargo', 'bin', 'uv'),
    ];
    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }
  }
  return null;
}

/**
 * Load API keys from settings file
 * Settings are stored in ~/.config/mrmd/settings.json (same as mrmd-electron)
 */
function loadApiKeysFromSettings() {
  const settingsPath = path.join(os.homedir(), '.config', 'mrmd', 'settings.json');
  console.log(`[ai] Loading API keys from ${settingsPath}`);
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const apiKeys = settings.apiKeys || {};
      console.log(`[ai] Found API keys for: ${Object.keys(apiKeys).filter(k => apiKeys[k]).join(', ') || 'none'}`);
      return apiKeys;
    } else {
      console.log(`[ai] Settings file not found at ${settingsPath}`);
    }
  } catch (e) {
    console.warn('[ai] Failed to load API keys from settings:', e.message);
  }
  return {};
}

/**
 * Build environment variables for AI server from API keys
 */
function buildEnvFromApiKeys(apiKeys) {
  const env = { ...process.env };

  // Map settings keys to litellm environment variable names
  const envMapping = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };

  for (const [provider, envVar] of Object.entries(envMapping)) {
    if (apiKeys[provider]) {
      env[envVar] = apiKeys[provider];
      console.log(`[ai] Setting ${envVar} from settings`);
    }
  }

  return env;
}

/**
 * Ensure AI server is running
 * @param {Object} options
 * @param {Object} [options.apiKeys] - API keys to pass as env vars (optional, will load from settings if not provided)
 * Returns { port, url, success } or { error, success: false }
 */
export async function ensureAiServer(options = {}) {
  // Already running
  if (aiServer) {
    return {
      success: true,
      port: aiServer.port,
      url: `http://localhost:${aiServer.port}`,
    };
  }

  // Already starting (avoid race condition)
  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    const uvPath = findUv();
    if (!uvPath) {
      return {
        success: false,
        error: "'uv' is not installed. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh",
      };
    }

    // Load API keys - from options or settings file
    const apiKeys = options.apiKeys || loadApiKeysFromSettings();
    const env = buildEnvFromApiKeys(apiKeys);

    const port = await findFreePort();
    console.log(`[ai] Starting mrmd-ai on port ${port}...`);

    const proc = spawn(uvPath, [
      'tool', 'run',
      '--from', 'mrmd-ai>=0.1.0,<0.2',
      'mrmd-ai-server',
      '--port', port.toString(),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env, // Pass API keys as environment variables
    });

    proc.stdout.on('data', (d) => console.log('[ai]', d.toString().trim()));
    proc.stderr.on('data', (d) => console.error('[ai]', d.toString().trim()));
    proc.on('exit', (code) => {
      console.log(`[ai] AI server exited with code ${code}`);
      aiServer = null;
      startPromise = null;
    });

    try {
      // AI server imports heavy libs (dspy, litellm) - needs 30s timeout
      await waitForPort(port, { timeout: 30000 });

      aiServer = { proc, port };
      console.log(`[ai] AI server ready on port ${port}`);

      return {
        success: true,
        port,
        url: `http://localhost:${port}`,
      };
    } catch (e) {
      proc.kill('SIGTERM');
      startPromise = null;
      return {
        success: false,
        error: `AI server failed to start: ${e.message}`,
      };
    }
  })();

  const result = await startPromise;
  if (!result.success) {
    startPromise = null;
  }
  return result;
}

/**
 * Get current AI server status
 */
export function getAiServer() {
  if (aiServer) {
    return {
      success: true,
      port: aiServer.port,
      url: `http://localhost:${aiServer.port}`,
      running: true,
    };
  }
  return {
    success: false,
    running: false,
    error: 'AI server not started',
  };
}

/**
 * Stop AI server
 */
export function stopAiServer() {
  if (aiServer?.proc) {
    console.log('[ai] Stopping AI server...');
    aiServer.proc.kill('SIGTERM');
    aiServer = null;
    startPromise = null;
  }
}

/**
 * Restart AI server with new API keys
 * Call this when API keys change in settings
 */
export async function restartAiServer(apiKeys) {
  stopAiServer();
  return ensureAiServer({ apiKeys });
}
