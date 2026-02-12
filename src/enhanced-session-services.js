/**
 * Enhanced Session Services — wraps mrmd-electron's session services
 * to support vendor-bundled and remote runtimes.
 *
 * The mrmd-electron services only look for sibling monorepo paths.
 * This module patches their start() methods to also check:
 *   1. Remote URL (MRMD_{LANG}_URL) — no spawning, just return URL
 *   2. Explicit dir (MRMD_{LANG}_DIR)
 *   3. Vendor bundle (mrmd-server/vendor/mrmd-{lang})
 *
 * Works for R, Julia, Ruby, and any future native runtimes.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import { resolveRuntime, LANGUAGES } from './runtime-resolver.js';

// Import the upstream services
import {
  RSessionService as UpstreamRSessionService,
  JuliaSessionService as UpstreamJuliaSessionService,
} from './services.js';

// Import utils from mrmd-electron for port finding etc.
import { findFreePort, waitForPort } from 'mrmd-electron/src/utils/index.js';
import { killProcessTree, isProcessAlive } from 'mrmd-electron/src/utils/platform.js';
import { SESSIONS_DIR } from 'mrmd-electron/src/config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Generic: patch any session service's start() to use runtime-resolver
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a patched start() that:
 *   - For 'remote' mode: registers a virtual session pointing to the remote URL
 *   - For 'local' mode: spawns the CLI script from the resolved directory
 *   - Falls through to upstream start() if resolver returns null (sibling found)
 *
 * @param {string} lang          — language key ("r", "julia", "ruby")
 * @param {object} service       — session service instance
 * @param {Function} upstreamStart — original start() method
 * @param {object} spawnOpts     — { makeArgs, makeEnv, interpreterPath? }
 */
function patchStart(lang, service, upstreamStart, spawnOpts) {
  return async function patchedStart(config) {
    // Check if already running (reuse upstream logic)
    if (service.sessions.has(config.name)) {
      const existing = service.sessions.get(config.name);
      if (existing?.alive) {
        if (existing.pid === null || isProcessAlive(existing.pid)) {
          return existing;
        }
        service.sessions.delete(config.name);
        service.removeRegistry(config.name);
      }
    }

    // Resolve the runtime
    const resolved = resolveRuntime(lang);

    if (!resolved) {
      // Let upstream try (it will fail with its own error if sibling not found)
      return upstreamStart.call(service, config);
    }

    if (resolved.mode === 'remote') {
      // ── Remote mode: no spawning ──────────────────────────────────────
      // Parse port from URL
      const url = new URL(resolved.url);
      const port = parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);

      const info = {
        name: config.name,
        language: lang,
        pid: null,           // no local process
        port,
        host: url.hostname,
        cwd: config.cwd,
        startedAt: new Date().toISOString(),
        alive: true,
        remote: true,
        url: resolved.url,
      };

      service.sessions.set(config.name, info);
      service.saveRegistry(info);

      console.log(`[${lang}-session] Using remote runtime at ${resolved.url}`);
      return info;
    }

    // ── Local mode: spawn from resolved directory ───────────────────────
    const { packageDir, cliScript } = resolved;

    if (!fs.existsSync(cliScript)) {
      throw new Error(`CLI script not found: ${cliScript}`);
    }

    const port = await findFreePort();
    console.log(`[${lang}-session] Starting "${config.name}" on port ${port} with cwd ${config.cwd}...`);
    console.log(`[${lang}-session] Using package: ${packageDir}`);

    const args = spawnOpts.makeArgs(cliScript, port, config, packageDir);
    const env = spawnOpts.makeEnv ? spawnOpts.makeEnv(packageDir) : { ...process.env };
    const interpreter = spawnOpts.interpreterPath?.(service) || args.shift();

    const proc = spawn(interpreter, args, {
      cwd: packageDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env,
    });

    proc.stdout.on('data', (d) => console.log(`[${lang}-session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[${lang}-session:${config.name}]`, d.toString().trim()));

    // Julia needs more time to start (JIT compilation)
    const portTimeout = lang === 'julia' ? 60000 : 10000;
    await waitForPort(port, { timeout: portTimeout });

    const info = {
      name: config.name,
      language: lang,
      pid: proc.pid,
      port,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    service.sessions.set(config.name, info);
    service.processes.set(config.name, proc);
    service.saveRegistry(info);

    proc.on('exit', (code, signal) => {
      console.log(`[${lang}-session:${config.name}] Exited (code=${code}, signal=${signal})`);
      const session = service.sessions.get(config.name);
      if (session) session.alive = false;
      service.sessions.delete(config.name);
      service.processes.delete(config.name);
      service.removeRegistry(config.name);
    });

    return info;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// R Session Service
// ═══════════════════════════════════════════════════════════════════════════

export class RSessionService extends UpstreamRSessionService {
  constructor() {
    super();

    // If upstream couldn't find the package dir, try our resolver
    if (!this.packageDir) {
      const resolved = resolveRuntime('r');
      if (resolved?.mode === 'local') {
        this.packageDir = resolved.packageDir;
        console.log(`[r-session] Patched packageDir from runtime-resolver: ${this.packageDir}`);
      } else if (resolved?.mode === 'remote') {
        // For remote mode, set a sentinel so availability checks pass
        this.packageDir = '__remote__';
        this._remoteUrl = resolved.url;
        console.log(`[r-session] Using remote R runtime: ${resolved.url}`);
      }
    }

    // Patch start() with our resolver
    const upstreamStart = UpstreamRSessionService.prototype.start;

    this.start = patchStart('r', this, upstreamStart, {
      interpreterPath: (svc) => svc.rscriptPath,
      makeArgs: (cliScript, port, config) => [
        cliScript,
        '--port', port.toString(),
        '--cwd', config.cwd,
      ],
      makeEnv: () => ({
        ...process.env,
        R_LIBS_USER: process.env.R_LIBS_USER || '',
      }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Julia Session Service
// ═══════════════════════════════════════════════════════════════════════════

export class JuliaSessionService extends UpstreamJuliaSessionService {
  constructor() {
    super();

    // If upstream couldn't find the package dir, try our resolver
    if (!this.packageDir) {
      const resolved = resolveRuntime('julia');
      if (resolved?.mode === 'local') {
        this.packageDir = resolved.packageDir;
        console.log(`[julia-session] Patched packageDir from runtime-resolver: ${this.packageDir}`);
      } else if (resolved?.mode === 'remote') {
        this.packageDir = '__remote__';
        this._remoteUrl = resolved.url;
        console.log(`[julia-session] Using remote Julia runtime: ${resolved.url}`);
      }
    }

    const upstreamStart = UpstreamJuliaSessionService.prototype.start;

    this.start = patchStart('julia', this, upstreamStart, {
      interpreterPath: (svc) => svc.juliaPath,
      makeArgs: (cliScript, port, config, packageDir) => [
        '--project=' + packageDir,
        cliScript,
        '--port', port.toString(),
        '--cwd', config.cwd,
      ],
      makeEnv: (packageDir) => ({
        ...process.env,
        JULIA_PROJECT: packageDir,
      }),
    });
  }
}

// Future: export class RubySessionService extends UpstreamRubySessionService { ... }
