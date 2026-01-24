/**
 * http-shim.js - Drop-in replacement for Electron's electronAPI
 *
 * This shim allows the Electron UI (index.html) to work in a browser
 * by replacing IPC calls with HTTP/WebSocket calls to mrmd-server.
 *
 * Usage:
 *   <script src="/http-shim.js"></script>
 *   <!-- Now window.electronAPI is available -->
 */

(function() {
  'use strict';

  // Get configuration from URL or defaults
  const params = new URLSearchParams(window.location.search);
  const TOKEN = params.get('token') || '';
  const BASE_URL = window.MRMD_SERVER_URL || window.location.origin;

  // ==========================================================================
  // HTTP Client
  // ==========================================================================

  async function apiCall(method, path, body = null) {
    const url = new URL(path, BASE_URL);
    if (TOKEN) {
      url.searchParams.set('token', TOKEN);
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body !== null) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  const GET = (path) => apiCall('GET', path);
  const POST = (path, body) => apiCall('POST', path, body);
  const DELETE = (path) => apiCall('DELETE', path);

  // ==========================================================================
  // WebSocket for Events
  // ==========================================================================

  const eventHandlers = {
    'files-update': [],
    'venv-found': [],
    'venv-scan-done': [],
    'project:changed': [],
    'sync-server-died': [],
  };

  let ws = null;
  let wsReconnectTimer = null;

  function connectWebSocket() {
    const wsUrl = new URL('/events', BASE_URL);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (TOKEN) {
      wsUrl.searchParams.set('token', TOKEN);
    }

    ws = new WebSocket(wsUrl.toString());

    ws.onopen = () => {
      console.log('[http-shim] WebSocket connected');
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onmessage = (e) => {
      try {
        const { event, data } = JSON.parse(e.data);
        const handlers = eventHandlers[event];
        if (handlers) {
          handlers.forEach(cb => {
            try {
              cb(data);
            } catch (err) {
              console.error('[http-shim] Event handler error:', err);
            }
          });
        }
      } catch (err) {
        console.error('[http-shim] WebSocket message error:', err);
      }
    };

    ws.onclose = () => {
      console.log('[http-shim] WebSocket disconnected, reconnecting in 2s...');
      wsReconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (err) => {
      console.error('[http-shim] WebSocket error:', err);
    };
  }

  // Connect WebSocket on load
  connectWebSocket();

  // ==========================================================================
  // electronAPI Shim
  // ==========================================================================

  window.electronAPI = {
    // ========================================================================
    // System
    // ========================================================================

    getHomeDir: () => GET('/api/system/home').then(r => r.homeDir),

    getRecent: () => GET('/api/system/recent'),

    getAi: () => GET('/api/system/ai'),

    // ========================================================================
    // Shell (stubs for browser)
    // ========================================================================

    shell: {
      showItemInFolder: async (fullPath) => {
        console.log('[http-shim] showItemInFolder not available in browser:', fullPath);
        // Could show a toast with the path
        return { success: false, path: fullPath };
      },

      openExternal: async (url) => {
        window.open(url, '_blank');
        return { success: true };
      },

      openPath: async (fullPath) => {
        console.log('[http-shim] openPath not available in browser:', fullPath);
        return { success: false, path: fullPath };
      },
    },

    // ========================================================================
    // File scanning
    // ========================================================================

    scanFiles: (searchDir) => GET(`/api/file/scan?root=${encodeURIComponent(searchDir || '')}`),

    onFilesUpdate: (callback) => {
      eventHandlers['files-update'].push(callback);
    },

    // ========================================================================
    // Venv discovery
    // ========================================================================

    discoverVenvs: (projectDir) => POST('/api/system/discover-venvs', { projectDir }),

    onVenvFound: (callback) => {
      eventHandlers['venv-found'].push(callback);
    },

    onVenvScanDone: (callback) => {
      eventHandlers['venv-scan-done'].push(callback);
    },

    // ========================================================================
    // File info
    // ========================================================================

    readPreview: (filePath, lines) =>
      GET(`/api/file/preview?path=${encodeURIComponent(filePath)}&lines=${lines || 40}`)
        .then(r => r.content),

    getFileInfo: (filePath) =>
      GET(`/api/file/info?path=${encodeURIComponent(filePath)}`),

    // ========================================================================
    // Python management
    // ========================================================================

    installMrmdPython: (venvPath) =>
      POST('/api/system/install-mrmd-python', { venvPath }),

    startPython: (venvPath, forceNew = false) =>
      POST('/api/runtime/start-python', { venvPath, forceNew }),

    // ========================================================================
    // Runtime management
    // ========================================================================

    listRuntimes: () => GET('/api/runtime'),

    killRuntime: (runtimeId) => DELETE(`/api/runtime/${encodeURIComponent(runtimeId)}`),

    attachRuntime: (runtimeId) => POST(`/api/runtime/${encodeURIComponent(runtimeId)}/attach`, {}),

    // ========================================================================
    // Open file (legacy)
    // ========================================================================

    openFile: async (filePath) => {
      // This was used to open a file and get session info
      // We'll get project info and session info separately
      const project = await window.electronAPI.project.get(filePath);
      const session = await window.electronAPI.session.forDocument(filePath);
      return { project, session };
    },

    // ========================================================================
    // PROJECT SERVICE
    // ========================================================================

    project: {
      get: (filePath) =>
        GET(`/api/project?path=${encodeURIComponent(filePath)}`),

      create: (targetPath) =>
        POST('/api/project', { targetPath }),

      nav: (projectRoot) =>
        GET(`/api/project/nav?root=${encodeURIComponent(projectRoot)}`),

      invalidate: (projectRoot) =>
        POST('/api/project/invalidate', { projectRoot }),

      watch: (projectRoot) =>
        POST('/api/project/watch', { projectRoot }),

      unwatch: () =>
        POST('/api/project/unwatch', {}),

      onChanged: (callback) => {
        // Remove existing handlers to prevent duplicates (matches Electron behavior)
        eventHandlers['project:changed'] = [callback];
      },
    },

    // ========================================================================
    // SESSION SERVICE
    // ========================================================================

    session: {
      list: () => GET('/api/session'),

      start: (config) => POST('/api/session', { config }),

      stop: (sessionName) => DELETE(`/api/session/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/session/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: (documentPath) => POST('/api/session/for-document', { documentPath }),
    },

    // ========================================================================
    // BASH SESSION SERVICE
    // ========================================================================

    bash: {
      list: () => GET('/api/bash'),

      start: (config) => POST('/api/bash', { config }),

      stop: (sessionName) => DELETE(`/api/bash/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/bash/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: (documentPath) => POST('/api/bash/for-document', { documentPath }),
    },

    // ========================================================================
    // FILE SERVICE
    // ========================================================================

    file: {
      scan: (root, options = {}) => {
        const params = new URLSearchParams();
        if (root) params.set('root', root);
        if (options.extensions) params.set('extensions', options.extensions.join(','));
        if (options.maxDepth) params.set('maxDepth', options.maxDepth);
        if (options.includeHidden) params.set('includeHidden', 'true');
        return GET(`/api/file/scan?${params.toString()}`);
      },

      create: (filePath, content = '') =>
        POST('/api/file/create', { filePath, content }),

      createInProject: (projectRoot, relativePath, content = '') =>
        POST('/api/file/create-in-project', { projectRoot, relativePath, content }),

      move: (projectRoot, fromPath, toPath) =>
        POST('/api/file/move', { projectRoot, fromPath, toPath }),

      reorder: (projectRoot, sourcePath, targetPath, position) =>
        POST('/api/file/reorder', { projectRoot, sourcePath, targetPath, position }),

      delete: (filePath) =>
        DELETE(`/api/file?path=${encodeURIComponent(filePath)}`),

      read: (filePath) =>
        GET(`/api/file/read?path=${encodeURIComponent(filePath)}`),

      write: (filePath, content) =>
        POST('/api/file/write', { filePath, content }),
    },

    // ========================================================================
    // ASSET SERVICE
    // ========================================================================

    asset: {
      list: (projectRoot) =>
        GET(`/api/asset?projectRoot=${encodeURIComponent(projectRoot || '')}`),

      save: async (projectRoot, file, filename) => {
        // Convert Uint8Array to base64 for JSON transport
        const base64 = btoa(String.fromCharCode.apply(null, file));
        return POST('/api/asset/save', {
          projectRoot,
          file: base64,
          filename,
        });
      },

      relativePath: (assetPath, documentPath) =>
        GET(`/api/asset/relative-path?assetPath=${encodeURIComponent(assetPath)}&documentPath=${encodeURIComponent(documentPath)}`)
          .then(r => r.relativePath),

      orphans: (projectRoot) =>
        GET(`/api/asset/orphans?projectRoot=${encodeURIComponent(projectRoot || '')}`),

      delete: (projectRoot, assetPath) =>
        DELETE(`/api/asset?projectRoot=${encodeURIComponent(projectRoot || '')}&assetPath=${encodeURIComponent(assetPath)}`),
    },

    // ========================================================================
    // DATA LOSS PREVENTION
    // ========================================================================

    onSyncServerDied: (callback) => {
      // Remove existing handlers to prevent duplicates
      eventHandlers['sync-server-died'] = [callback];
    },
  };

  // ==========================================================================
  // Expose utilities
  // ==========================================================================

  window.MRMD_HTTP_SHIM = {
    BASE_URL,
    TOKEN,
    reconnectWebSocket: connectWebSocket,
    getWebSocketState: () => ws ? ws.readyState : -1,
  };

  console.log('[http-shim] electronAPI shim loaded', { BASE_URL, hasToken: !!TOKEN });

})();
