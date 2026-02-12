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

  // Expose token globally for asset resolver patching
  window.MRMD_TOKEN = TOKEN;

  // ==========================================================================
  // WebSocket Proxy Interceptor
  // ==========================================================================
  // Intercept WebSocket connections to localhost sync servers and route through proxy
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let targetUrl = url;

    // Check if this is a sync connection to localhost
    const match = url.match(/^wss?:\/\/127\.0\.0\.1:(\d+)\/(.+)$/);
    if (match) {
      const [, port, docPath] = match;
      // Route through server proxy
      const proxyUrl = new URL(`sync/${port}/${docPath}`, BASE_URL);
      proxyUrl.protocol = proxyUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      targetUrl = proxyUrl.toString();
      console.log(`[http-shim] Proxying sync WebSocket: ${url} -> ${targetUrl}`);
    }

    return new OriginalWebSocket(targetUrl, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // ==========================================================================
  // Fetch Proxy Interceptor
  // ==========================================================================
  // Intercept fetch requests to localhost services (bash, pty) and route through proxy
  const OriginalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = typeof input === 'string' ? input : input.url;

    // Check if this is a request to localhost service
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/(.*)$/);
    if (match) {
      const [, port, path] = match;
      // Route through server proxy
      const proxyUrl = new URL(`proxy/${port}/${path}`, BASE_URL);
      console.log(`[http-shim] Proxying fetch: ${url} -> ${proxyUrl.toString()}`);

      if (typeof input === 'string') {
        input = proxyUrl.toString();
      } else {
        input = new Request(proxyUrl.toString(), input);
      }
    }

    return OriginalFetch.call(window, input, init);
  };

  // ==========================================================================
  // HTTP Client
  // ==========================================================================

  async function apiCall(method, path, body = null) {
    // Strip leading slash so URL resolves relative to BASE_URL path (not origin root)
    const relativePath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(relativePath, BASE_URL);
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
    const wsUrl = new URL('events', BASE_URL);
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

    // System info and uv management
    system: {
      info: () => GET('/api/system/info'),
      ensureUv: () => POST('/api/system/ensure-uv', {}),
    },

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

    scanFiles: (searchDir) => {
      // Trigger scan and emit results via onFilesUpdate (matches electron behavior)
      GET(`/api/file/scan?root=${encodeURIComponent(searchDir || '')}`)
        .then(files => {
          // Emit files-update event with the results
          const handlers = eventHandlers['files-update'];
          if (handlers) {
            handlers.forEach(cb => {
              try {
                cb({ files });
              } catch (err) {
                console.error('[http-shim] files-update handler error:', err);
              }
            });
          }
        })
        .catch(err => {
          console.error('[http-shim] scanFiles error:', err);
        });
    },

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

    createVenv: (venvPath) =>
      POST('/api/system/create-venv', { venvPath }),

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
      // Get project info and session info
      const project = await window.electronAPI.project.get(filePath);
      const session = await window.electronAPI.session.forDocument(filePath);

      // Extract filename without extension for docName
      const fileName = filePath.split('/').pop();
      const lower = fileName.toLowerCase();
      const docName = lower.endsWith('.md') ? fileName.replace(/\.md$/i, '') : fileName;

      // Use syncPort from project response (dynamically assigned per-project)
      const syncPort = project?.syncPort || 4444;

      return {
        success: true,
        syncPort,
        docName,
        projectDir: project?.root || filePath.split('/').slice(0, -1).join('/'),
        pythonPort: session?.pythonPort || null,
      };
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
    // JULIA SESSION SERVICE
    // ========================================================================

    julia: {
      list: () => GET('/api/julia'),

      start: (config) => POST('/api/julia', { config }),

      stop: (sessionName) => DELETE(`/api/julia/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/julia/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: (documentPath) => POST('/api/julia/for-document', { documentPath }),

      isAvailable: () => GET('/api/julia/available').then(r => r.available),
    },

    // ========================================================================
    // PTY SESSION SERVICE (for ```term blocks)
    // ========================================================================

    pty: {
      list: () => GET('/api/pty'),

      start: (config) => POST('/api/pty', { config }),

      stop: (sessionName) => DELETE(`/api/pty/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/pty/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: (documentPath) => POST('/api/pty/for-document', { documentPath }),
    },

    // ========================================================================
    // NOTEBOOK (JUPYTER) SERVICE
    // ========================================================================

    notebook: {
      convert: (ipynbPath) => POST('/api/notebook/convert', { ipynbPath }),

      startSync: (ipynbPath) => POST('/api/notebook/start-sync', { ipynbPath }),

      stopSync: (ipynbPath) => POST('/api/notebook/stop-sync', { ipynbPath }),
    },

    // ========================================================================
    // R SESSION SERVICE
    // ========================================================================

    r: {
      list: () => GET('/api/r'),

      start: (config) => POST('/api/r', { config }),

      stop: (sessionName) => DELETE(`/api/r/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/r/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: (documentPath) => POST('/api/r/for-document', { documentPath }),

      isAvailable: () => GET('/api/r/available').then(r => r.available),
    },

    // ========================================================================
    // SETTINGS SERVICE
    // ========================================================================

    settings: {
      getAll: () => GET('/api/settings'),

      get: (key, defaultValue) =>
        GET(`/api/settings/key?path=${encodeURIComponent(key)}${defaultValue !== undefined ? `&default=${encodeURIComponent(defaultValue)}` : ''}`).then(r => r.value),

      set: (key, value) =>
        POST('/api/settings/key', { key, value }).then(r => r.success),

      update: (updates) =>
        POST('/api/settings/update', { updates }).then(r => r.success),

      reset: () =>
        POST('/api/settings/reset', {}).then(r => r.success),

      getApiKeys: (masked = true) =>
        GET(`/api/settings/api-keys?masked=${masked}`),

      setApiKey: (provider, key) =>
        POST('/api/settings/api-key', { provider, key }).then(r => r.success),

      getApiKey: (provider) =>
        GET(`/api/settings/api-key/${encodeURIComponent(provider)}`).then(r => r.key),

      hasApiKey: (provider) =>
        GET(`/api/settings/api-key/${encodeURIComponent(provider)}/exists`).then(r => r.hasKey),

      getApiProviders: () =>
        GET('/api/settings/api-providers'),

      getQualityLevels: () =>
        GET('/api/settings/quality-levels'),

      setQualityLevelModel: (level, model) =>
        POST(`/api/settings/quality-level/${level}/model`, { model }).then(r => r.success),

      getCustomSections: () =>
        GET('/api/settings/custom-sections'),

      addCustomSection: (name) =>
        POST('/api/settings/custom-section', { name }),

      removeCustomSection: (sectionId) =>
        DELETE(`/api/settings/custom-section/${encodeURIComponent(sectionId)}`).then(r => r.success),

      addCustomCommand: (sectionId, command) =>
        POST('/api/settings/custom-command', { sectionId, command }),

      updateCustomCommand: (sectionId, commandId, updates) =>
        apiCall('PUT', '/api/settings/custom-command', { sectionId, commandId, updates }).then(r => r.success),

      removeCustomCommand: (sectionId, commandId) =>
        apiCall('DELETE', '/api/settings/custom-command', { sectionId, commandId }).then(r => r.success),

      getAllCustomCommands: () =>
        GET('/api/settings/custom-commands'),

      getDefaults: () =>
        GET('/api/settings/defaults'),

      setDefaults: (defaults) =>
        POST('/api/settings/defaults', defaults).then(r => r.success),

      export: (includeKeys = false) =>
        GET(`/api/settings/export?includeKeys=${includeKeys}`).then(r => r.json),

      import: (json, mergeKeys = false) =>
        POST('/api/settings/import', { json, mergeKeys }).then(r => r.success),
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

    /**
     * Register callback for OS "open with" events.
     * In browser mode, this will never be called (no OS integration).
     */
    onOpenWithFile: (callback) => {
      // No-op in browser mode - OS file associations don't exist
      // Could potentially be triggered via URL parameters in the future
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
