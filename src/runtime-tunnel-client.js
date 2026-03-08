/**
 * Runtime Tunnel Client — consumer side for the web editor container
 *
 * Connects to the relay's tunnel room as a "consumer". When the Electron
 * desktop app is online (the "provider"), this client routes MRP traffic
 * through the tunnel instead of to local runtimes.
 *
 * Provides:
 *   - isAvailable()         — is the Electron provider connected?
 *   - startRuntime(config)  — ask Electron to start runtimes for a document
 *   - getSharedSyncInfo(config) — ask Electron for local sync port/doc info
 *   - httpProxy(port, req, res)    — tunnel HTTP request to Electron
 *   - wsProxy(port, path, clientWs) — tunnel WebSocket to Electron
 *   - isTunnelPort(port)    — is this port served by the tunnel?
 */

import { WebSocket } from 'ws';

let _nextId = 1;
function nextId() { return `tc-${_nextId++}`; }

export class RuntimeTunnelClient {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl - WebSocket URL (e.g. 'ws://localhost:3006')
   * @param {string} opts.userId - User UUID
   */
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.userId = opts.userId;
    this.ws = null;
    this._destroyed = false;
    this._reconnectTimer = null;
    this._providerAvailable = false;
    this._provider = null;
    this._activeMachineId = null;
    this._machines = [];

    /** Ports that belong to the Electron's runtimes (route through tunnel) */
    this._tunnelPorts = new Set();

    /** Pending response handlers: id → { resolve, reject, onChunk, ... } */
    this._pending = new Map();

    /** Active WS sessions: id → { clientWs } */
    this._wsSessions = new Map();

    /** Map cloud project root -> local project root (from runtime responses) */
    this._cloudToLocalRoots = new Map();
  }

  start() {
    this._connect();
  }

  _connect() {
    if (this._destroyed) return;

    const url = `${this.relayUrl}/tunnel/${encodeURIComponent(this.userId)}?role=consumer`;
    try {
      this.ws = new WebSocket(url, {
        headers: { 'X-User-Id': this.userId },
      });
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[tunnel-client] Connected to relay as consumer');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        this._handleMessage(msg);
      } catch (err) {
        console.error('[tunnel-client] Bad message:', err.message);
      }
    });

    this.ws.on('close', () => {
      this._providerAvailable = false;
      this._provider = null;
      this._activeMachineId = null;
      this._machines = [];
      this._tunnelPorts.clear();
      this._cloudToLocalRoots.clear();
      // Reject all pending requests
      for (const [id, handler] of this._pending) {
        handler.reject?.(new Error('Tunnel disconnected'));
      }
      this._pending.clear();
      // Close all WS sessions
      for (const [id, session] of this._wsSessions) {
        try { session.clientWs?.close(); } catch { /* ignore */ }
      }
      this._wsSessions.clear();
      if (!this._destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', () => { /* handled by close */ });
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, 5000);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  _handleMessage(msg) {
    switch (msg.t) {
      case 'provider-status':
        this._providerAvailable = msg.available;
        this._provider = msg.provider || this._provider;
        this._activeMachineId = msg.activeMachineId || null;
        this._machines = msg.machines || [];
        console.log(`[tunnel-client] Provider ${msg.available ? 'available' : 'unavailable'} (active: ${this._activeMachineId || 'none'}, machines: ${this._machines.length})`);
        break;

      case 'provider-gone':
        this._providerAvailable = false;
        this._provider = null;
        this._activeMachineId = null;
        this._machines = [];
        this._tunnelPorts.clear();
        console.log('[tunnel-client] All providers disconnected');
        break;

      case 'provider-info':
        this._providerAvailable = true;
        this._provider = {
          ...(this._provider || {}),
          machineId: msg.machineId || this._provider?.machineId || null,
          machineName: msg.machineName || this._provider?.machineName || null,
          hostname: msg.hostname || this._provider?.hostname || null,
          capabilities: msg.capabilities || this._provider?.capabilities || [],
        };
        console.log('[tunnel-client] Provider info:', this._provider);
        break;

      case 'runtimes-list':
        this._handleRuntimesList(msg);
        break;

      case 'runtime-started':
        this._handleRuntimeStarted(msg);
        break;

      case 'shared-sync-info':
        this._resolvePending(msg.id, msg.sync);
        break;

      case 'runtime-update':
        this._handleRuntimeUpdate(msg);
        break;

      case 'runtime-update-error':
        this._handleRuntimeUpdateError(msg);
        break;

      case 'runtime-stopped':
        this._resolvePending(msg.id, { success: msg.success });
        break;

      case 'runtime-error':
        this._resolvePending(msg.id, null, msg.error);
        break;

      case 'http-res':
        this._handleHttpRes(msg);
        break;

      case 'http-chunk':
        this._handleHttpChunk(msg);
        break;

      case 'http-end':
        this._handleHttpEnd(msg);
        break;

      case 'http-error':
        this._resolvePending(msg.id, null, msg.error);
        break;

      case 'ws-opened':
        this._handleWsOpened(msg);
        break;

      case 'ws-msg':
        this._handleWsMsg(msg);
        break;

      case 'ws-close':
        this._handleWsSessionClose(msg);
        break;

      case 'ws-error':
        this._handleWsError(msg);
        break;

      case 'voice-result':
        this._resolvePending(msg.id, msg.result, msg.error);
        break;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Is the Electron provider connected? */
  isAvailable() {
    return this._providerAvailable && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Is this port a tunneled Electron port? */
  isTunnelPort(port) {
    return this._tunnelPorts.has(Number(port));
  }

  /** Current active provider metadata (machine info), if connected */
  getProvider() {
    return this._providerAvailable ? (this._provider || null) : null;
  }

  /** Get all connected machines from the tunnel. */
  getMachines() {
    return {
      activeMachineId: this._activeMachineId,
      machines: this._machines,
    };
  }

  /**
   * Transcribe audio via the Electron provider's local Parakeet.
   * Audio is sent as base64 through the tunnel.
   *
   * @param {object} opts
   * @param {string} opts.audioBase64 - Base64 encoded audio
   * @param {string} opts.mimeType - Audio MIME type
   * @param {string} opts.url - Parakeet WebSocket URL (on provider's LAN)
   * @returns {Promise<{text: string, segments: Array, duration: number}>}
   */
  async voiceTranscribe({ audioBase64, mimeType, url }) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Voice transcription timeout (tunnel)'));
      }, 120000); // 2min timeout for large audio

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({ t: 'voice-transcribe', id, audioBase64, mimeType, url });
    });
  }

  /**
   * Ask the Electron to list its runtimes.
   */
  async listRuntimes(language) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Runtime list timeout'));
      }, 10000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({ t: 'list-runtimes', id, language });
    });
  }

  /**
   * Ask the Electron to stop a runtime.
   */
  async stopRuntime(name) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Runtime stop timeout'));
      }, 10000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({ t: 'stop-runtime', id, name });
    });
  }

  /**
   * Ask the Electron to restart a runtime.
   */
  async restartRuntime(name) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Runtime restart timeout'));
      }, 30000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          // restart returns a single runtime info map {lang: info}
          // just return the first one
          const keys = Object.keys(result || {});
          resolve(keys.length > 0 ? result[keys[0]] : null);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({ t: 'restart-runtime', id, name });
    });
  }

  /**
   * Ask the Electron to start/find runtimes for a document.
   * Returns the same format as RuntimeService.getForDocument().
   */
  async startRuntime(config) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Runtime start timeout'));
      }, 30000);

      this._pending.set(id, {
        requestContext: {
          projectRoot: config.projectRoot || null,
          documentPath: config.documentPath || null,
        },
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({
        t: 'start-runtime',
        id,
        name: config.name || null,
        language: config.language || null,
        cwd: config.cwd || null,
        venv: config.venv || null,
        documentPath: config.documentPath || null,
        projectRoot: config.projectRoot || null,
        sharedProject: config.sharedProject || null,
        sharedDocPath: config.sharedDocPath || null,
        projectConfig: config.projectConfig || null,
        frontmatter: config.frontmatter || null,
      });
    });
  }

  async getSharedSyncInfo(config) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');

    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Shared sync info timeout'));
      }, 15000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          reject(typeof err === 'string' ? new Error(err) : err);
        },
      });

      this._send({
        t: 'shared-sync-info',
        id,
        project: config.sharedProject || null,
        docPath: config.sharedDocPath || null,
      });
    });
  }

  /**
   * Tunnel an HTTP request to the Electron's local runtime.
   * Streams the response back to the Express `res` object.
   *
   * @param {number} port - Electron-side runtime port
   * @param {import('express').Request} req - Incoming request
   * @param {import('express').Response} res - Outgoing response
   */
  async httpProxy(port, req, res) {
    if (!this.isAvailable()) {
      res.status(502).json({ error: 'Tunnel provider not available' });
      return;
    }

    const id = nextId();
    const targetPath = req.url; // includes query string

    // Forward relevant headers
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase().startsWith('x-') ||
          key.toLowerCase() === 'content-type' ||
          key.toLowerCase() === 'accept') {
        headers[key] = value;
      }
    }

    // Read body for non-GET requests
    let body = undefined;
    if (!['GET', 'HEAD'].includes(req.method)) {
      body = JSON.stringify(req.body);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        if (!res.headersSent) {
          res.status(504).json({ error: 'Tunnel request timeout' });
        }
        resolve();
      }, 60000);

      this._pending.set(id, {
        // Called when we get http-res (headers)
        onHeaders: (status, resHeaders) => {
          res.status(status);
          for (const [k, v] of Object.entries(resHeaders || {})) {
            if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k.toLowerCase())) {
              res.setHeader(k, v);
            }
          }
        },
        // Called for each body chunk
        onChunk: (data) => {
          const buf = Buffer.from(data, 'base64');
          res.write(buf);
        },
        // Called when response is complete
        resolve: () => {
          clearTimeout(timeout);
          this._pending.delete(id);
          res.end();
          resolve();
        },
        // Called on error
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(id);
          if (!res.headersSent) {
            res.status(502).json({ error: typeof err === 'string' ? err : err?.message || 'Tunnel error' });
          } else {
            res.end();
          }
          resolve();
        },
      });

      this._send({ t: 'http-req', id, port, method: req.method, path: targetPath, headers, body });
    });
  }

  /**
   * Tunnel a WebSocket connection to the Electron's local runtime.
   *
   * @param {number} port - Electron-side runtime port
   * @param {string} path - Path after the port (e.g. 'pty?cols=80&rows=24')
   * @param {WebSocket} clientWs - The browser-side WebSocket
   */
  wsProxy(port, path, clientWs) {
    if (!this.isAvailable()) {
      clientWs.close(1013, 'Tunnel provider not available');
      return;
    }

    const id = nextId();
    this._wsSessions.set(id, { clientWs });

    // Forward client messages to tunnel.
    // IMPORTANT: In Node.js ws, `data` is always a Buffer regardless of
    // frame type. Only `isBinary` correctly distinguishes text vs binary
    // frames. Using Buffer.isBuffer() would incorrectly treat ALL messages
    // as binary, breaking text-based protocols (PTY sends/expects text).
    clientWs.on('message', (data, isBinary) => {
      if (isBinary) {
        this._send({ t: 'ws-msg', id, data: Buffer.from(data).toString('base64'), bin: true });
      } else {
        this._send({ t: 'ws-msg', id, data: data.toString(), bin: false });
      }
    });

    clientWs.on('close', () => {
      this._send({ t: 'ws-close', id });
      this._wsSessions.delete(id);
    });

    clientWs.on('error', () => {
      this._send({ t: 'ws-close', id });
      this._wsSessions.delete(id);
    });

    // Ask the provider to open a WS to the local runtime
    const rewrittenPath = this._rewriteWsPath(path);
    if (rewrittenPath !== path) {
      console.log(`[tunnel-client] Rewrote WS path for tunnel: ${path} -> ${rewrittenPath}`);
    }
    this._send({ t: 'ws-open', id, port, path: rewrittenPath });
  }

  // ── Message handlers ──────────────────────────────────────────────────

  _handleRuntimesList(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;

    // Register all returned ports as tunnel ports
    const runtimes = msg.runtimes || [];
    for (const info of runtimes) {
      if (info?.port) {
        this._tunnelPorts.add(info.port);
      }
    }

    handler.resolve(runtimes);
  }

  _handleRuntimeStarted(msg) {
    const runtimes = msg.runtimes || {};
    this._registerRuntimePorts(runtimes);

    const handler = this._pending.get(msg.id);
    if (!handler) return;

    // Learn cloud->local path mapping from this runtime response.
    // Example: cloud /home/ubuntu/tidyjs  -> local /home/maxime/Projects/tidyjs
    const cloudRoot = handler.requestContext?.projectRoot || null;
    this._learnCloudToLocalRoot(cloudRoot, runtimes);

    handler.resolve(runtimes);
  }

  _handleRuntimeUpdate(msg) {
    const runtimes = msg.runtimes || {};
    this._registerRuntimePorts(runtimes);

    // Background updates (e.g. delayed Julia startup) may arrive after the
    // original RPC request has already resolved.
    const pending = this._pending.get(msg.requestId);
    const cloudRoot = pending?.requestContext?.projectRoot || msg.projectRoot || null;
    this._learnCloudToLocalRoot(cloudRoot, runtimes);

    if (!pending) {
      console.log(`[tunnel-client] Runtime update received (${msg.language || 'unknown'})`);
    }
  }

  _handleRuntimeUpdateError(msg) {
    // Background startup errors are informational unless the original request
    // is still pending.
    const pending = this._pending.get(msg.requestId);
    if (pending) {
      pending.reject?.(msg.error || `Runtime update failed (${msg.language || 'unknown'})`);
      return;
    }
    console.warn(`[tunnel-client] Runtime update error (${msg.language || 'unknown'}): ${msg.error || 'unknown error'}`);
  }

  _registerRuntimePorts(runtimes) {
    for (const info of Object.values(runtimes || {})) {
      if (info?.port) {
        this._tunnelPorts.add(info.port);
      }
    }
  }

  _learnCloudToLocalRoot(cloudRoot, runtimes) {
    if (!cloudRoot) return;
    for (const info of Object.values(runtimes || {})) {
      if (info?.cwd && typeof info.cwd === 'string' && info.cwd !== cloudRoot) {
        this._cloudToLocalRoots.set(cloudRoot, info.cwd);
        break;
      }
    }
  }

  _handleHttpRes(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    handler.onHeaders?.(msg.status, msg.headers);
  }

  _handleHttpChunk(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    handler.onChunk?.(msg.data);
  }

  _handleHttpEnd(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    handler.resolve?.();
  }

  _handleWsOpened(msg) {
    // WS session established on the provider side — nothing to do,
    // messages will start flowing
  }

  _handleWsMsg(msg) {
    const session = this._wsSessions.get(msg.id);
    if (!session?.clientWs || session.clientWs.readyState !== 1) return;

    try {
      if (msg.bin) {
        session.clientWs.send(Buffer.from(msg.data, 'base64'));
      } else {
        session.clientWs.send(msg.data);
      }
    } catch { /* ignore */ }
  }

  _handleWsSessionClose(msg) {
    const session = this._wsSessions.get(msg.id);
    if (!session) return;
    try { session.clientWs?.close(msg.code || 1000, msg.reason || ''); } catch { /* ignore */ }
    this._wsSessions.delete(msg.id);
  }

  _handleWsError(msg) {
    const session = this._wsSessions.get(msg.id);
    if (session) {
      try { session.clientWs?.close(1011, msg.error || 'Tunnel error'); } catch { /* ignore */ }
      this._wsSessions.delete(msg.id);
    }
    // Also check pending (for runtime-start errors etc.)
    this._resolvePending(msg.id, null, msg.error);
  }

  _resolvePending(id, result, error) {
    const handler = this._pending.get(id);
    if (!handler) return;
    if (error) {
      handler.reject?.(error);
    } else {
      handler.resolve?.(result);
    }
  }

  _rewriteWsPath(path) {
    // PTY sessions carry cwd/file_path/session_id in query params.
    // Browser-side paths are cloud paths (/home/ubuntu/...), but provider
    // runs on desktop local paths (/home/maxime/Projects/...). Rewrite them.
    if (!path || !path.startsWith('api/pty')) return path;

    const [pathname, query = ''] = String(path).split('?', 2);
    const params = new URLSearchParams(query);

    const rewriteParam = (key) => {
      const val = params.get(key);
      if (!val) return;
      const rewritten = this._rewriteCloudPathToLocal(val);
      if (rewritten !== val) params.set(key, rewritten);
    };

    rewriteParam('cwd');
    rewriteParam('file_path');

    // session_id often embeds the file path; rewrite in-place if needed
    const sessionId = params.get('session_id');
    if (sessionId) {
      const rewrittenSessionId = this._rewriteCloudPathToLocal(sessionId);
      if (rewrittenSessionId !== sessionId) {
        params.set('session_id', rewrittenSessionId);
      }
    }

    const newQuery = params.toString();
    return newQuery ? `${pathname}?${newQuery}` : pathname;
  }

  _rewriteCloudPathToLocal(value) {
    if (!value || typeof value !== 'string') return value;
    for (const [cloudRoot, localRoot] of this._cloudToLocalRoots.entries()) {
      if (value === cloudRoot) return localRoot;
      if (value.startsWith(cloudRoot + '/')) {
        return localRoot + value.slice(cloudRoot.length);
      }
      // Also handle embedded paths (e.g. session_id prefixes)
      if (value.includes(cloudRoot + '/')) {
        return value.split(cloudRoot).join(localRoot);
      }
    }
    return value;
  }

  stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    console.log('[tunnel-client] Stopped');
  }
}

export default RuntimeTunnelClient;
