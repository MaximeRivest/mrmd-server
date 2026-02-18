/**
 * Relay Bridge — bidirectional sync between local mrmd-sync and the cloud relay
 *
 * Runs inside the editor container. For each document, creates a DocBridge
 * that forwards Yjs WebSocket messages between the local mrmd-sync server
 * and the cloud relay. This keeps:
 *   - Local filesystem in sync with relay (via local mrmd-sync's file writer)
 *   - Relay in sync with local edits (via bridge forwarding)
 *   - Other devices (Electron, phone) see changes in real-time
 *
 * Uses X-User-Id header for auth (trusted internal network, host networking).
 *
 * Usage:
 *   import { RelayBridge } from './relay-bridge.js';
 *   const bridge = new RelayBridge({
 *     relayWsUrl: 'ws://localhost:3006',
 *     userId: '31bdffb9-...',
 *   });
 *   bridge.bridgeProject(localSyncPort, projectDir, projectName, docNames);
 *   bridge.stopAll();
 */

import { WebSocket } from 'ws';

function encodePathSegments(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

/**
 * Bridges a single document between local mrmd-sync and cloud relay.
 * Just forwards raw WS messages — no Yjs dependency needed.
 */
class DocBridge {
  constructor(opts) {
    this.localUrl = opts.localUrl;
    this.remoteUrl = opts.remoteUrl;
    this.remoteHeaders = opts.remoteHeaders || {};
    this.docName = opts.docName;

    this.localWs = null;
    this.remoteWs = null;
    this._destroyed = false;
    this._reconnectLocal = null;
    this._reconnectRemote = null;
    this._localReady = false;
    this._remoteReady = false;
    this._lastError = null;
    this._startedAt = Date.now();
    // Buffer messages when the other side isn't ready yet.
    // Critical: without this, sync step 1/2 messages are dropped during
    // the race between local and remote WS connections opening, causing
    // the Yjs sync to never complete for many documents.
    this._localBuffer = [];   // messages from remote waiting for local
    this._remoteBuffer = [];  // messages from local waiting for remote
  }

  start() {
    this._connectLocal();
    this._connectRemote();
  }

  _connectLocal() {
    if (this._destroyed) return;
    try {
      this.localWs = new WebSocket(this.localUrl);
    } catch {
      this._scheduleReconnect('local');
      return;
    }

    this.localWs.binaryType = 'arraybuffer';

    this.localWs.on('open', () => {
      this._localReady = true;
      // Flush buffered messages from remote that arrived before local was ready
      for (const msg of this._localBuffer) {
        try { this.localWs.send(msg.data, { binary: msg.isBinary }); } catch { /* ignore */ }
      }
      this._localBuffer = [];
    });

    this.localWs.on('message', (data, isBinary) => {
      if (this._remoteReady && this.remoteWs?.readyState === WebSocket.OPEN) {
        try { this.remoteWs.send(data, { binary: isBinary }); } catch { /* ignore */ }
      } else {
        this._remoteBuffer.push({ data, isBinary });
      }
    });

    this.localWs.on('close', () => {
      this._localReady = false;
      this._localBuffer = [];
      if (!this._destroyed) this._scheduleReconnect('local');
    });

    this.localWs.on('error', (err) => {
      this._lastError = `local:${err?.code || err?.message || 'error'}`;
    });
  }

  _connectRemote() {
    if (this._destroyed) return;
    try {
      this.remoteWs = new WebSocket(this.remoteUrl, { headers: this.remoteHeaders });
    } catch {
      this._scheduleReconnect('remote');
      return;
    }

    this.remoteWs.binaryType = 'arraybuffer';

    this.remoteWs.on('open', () => {
      this._remoteReady = true;
      // Flush buffered messages from local that arrived before remote was ready
      for (const msg of this._remoteBuffer) {
        try { this.remoteWs.send(msg.data, { binary: msg.isBinary }); } catch { /* ignore */ }
      }
      this._remoteBuffer = [];
    });

    this.remoteWs.on('message', (data, isBinary) => {
      if (this._localReady && this.localWs?.readyState === WebSocket.OPEN) {
        try { this.localWs.send(data, { binary: isBinary }); } catch { /* ignore */ }
      } else {
        this._localBuffer.push({ data, isBinary });
      }
    });

    this.remoteWs.on('close', () => {
      this._remoteReady = false;
      this._remoteBuffer = [];
      if (!this._destroyed) this._scheduleReconnect('remote');
    });

    this.remoteWs.on('error', (err) => {
      this._lastError = `remote:${err?.code || err?.message || 'error'}`;
    });
  }

  _scheduleReconnect(which) {
    if (this._destroyed) return;
    const key = which === 'local' ? '_reconnectLocal' : '_reconnectRemote';
    if (this[key]) return;
    this[key] = setTimeout(() => {
      this[key] = null;
      if (which === 'local') this._connectLocal();
      else this._connectRemote();
    }, 3000);
  }

  getStatus() {
    return {
      docName: this.docName,
      localReady: this._localReady,
      remoteReady: this._remoteReady,
      connected: this._localReady && this._remoteReady,
      lastError: this._lastError,
    };
  }

  async stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectLocal);
    clearTimeout(this._reconnectRemote);
    try { this.localWs?.close(); } catch { /* ignore */ }
    try { this.remoteWs?.close(); } catch { /* ignore */ }
  }
}

/**
 * Manages document bridges between local mrmd-sync and the cloud relay.
 */
export class RelayBridge {
  /**
   * @param {object} opts
   * @param {string} opts.relayWsUrl - WebSocket URL of relay (e.g. 'ws://localhost:3006')
   * @param {string} opts.userId - User UUID for auth + doc routing
   */
  constructor(opts) {
    this.relayWsUrl = opts.relayWsUrl;
    this.userId = opts.userId;

    /** @type {Map<string, { bridges: Map<string, DocBridge>, port: number, projectName: string }>} */
    this._projects = new Map();
  }

  /**
   * Bridge a local project's sync server to the cloud relay.
   *
   * @param {number} localSyncPort - Local mrmd-sync port
   * @param {string} projectDir - Local project directory
   * @param {string} projectName - Project name/slug
   * @param {string[]} docNames - Document names to bridge
   */
  bridgeProject(localSyncPort, projectDir, projectName, docNames = []) {
    if (this._projects.has(projectDir)) {
      // Already bridged — add any new docs
      const existing = this._projects.get(projectDir);
      for (const docName of docNames) {
        if (!existing.bridges.has(docName)) {
          this._bridgeDoc(projectDir, localSyncPort, projectName, docName);
        }
      }
      return;
    }

    console.log(`[relay-bridge] Bridging "${projectName}" (port ${localSyncPort}, ${docNames.length} docs)`);

    const bridges = new Map();
    this._projects.set(projectDir, { bridges, port: localSyncPort, projectName });

    for (const docName of docNames) {
      this._bridgeDoc(projectDir, localSyncPort, projectName, docName);
    }
  }

  /**
   * Add a single document to an existing project bridge.
   */
  bridgeDoc(projectDir, docName) {
    const project = this._projects.get(projectDir);
    if (!project || project.bridges.has(docName)) return;
    this._bridgeDoc(projectDir, project.port, project.projectName, docName);
  }

  _bridgeDoc(projectDir, localSyncPort, projectName, docName) {
    const project = this._projects.get(projectDir);
    if (!project) return;

    const encodedDoc = encodePathSegments(docName);
    const encodedProject = encodePathSegments(projectName);
    const encodedUserId = encodeURIComponent(this.userId);

    const localUrl = `ws://127.0.0.1:${localSyncPort}/${encodedDoc}`;
    const remoteUrl = `${this.relayWsUrl}/sync/${encodedUserId}/${encodedProject}/${encodedDoc}`;

    const bridge = new DocBridge({
      localUrl,
      remoteUrl,
      remoteHeaders: { 'X-User-Id': this.userId },
      docName,
    });

    bridge.start();
    project.bridges.set(docName, bridge);
  }

  /**
   * Stop syncing a specific project.
   */
  async stopProject(projectDir) {
    const project = this._projects.get(projectDir);
    if (!project) return;

    for (const bridge of project.bridges.values()) {
      await bridge.stop();
    }
    project.bridges.clear();
    this._projects.delete(projectDir);
    console.log(`[relay-bridge] Stopped project: ${projectDir}`);
  }

  /**
   * Stop all project bridges.
   */
  async stopAll() {
    for (const projectDir of [...this._projects.keys()]) {
      await this.stopProject(projectDir);
    }
    console.log('[relay-bridge] All bridges stopped');
  }

  /**
   * Get sync status.
   */
  getStatus() {
    const projects = [];
    let connectedDocs = 0;
    let totalDocs = 0;

    for (const [dir, info] of this._projects) {
      const docs = [];
      for (const [name, bridge] of info.bridges) {
        const status = bridge.getStatus();
        docs.push(status);
        totalDocs++;
        if (status.connected) connectedDocs++;
      }
      projects.push({
        dir,
        projectName: info.projectName,
        port: info.port,
        documents: docs,
      });
    }

    return { projects, connectedDocs, totalDocs };
  }
}

export default RelayBridge;
