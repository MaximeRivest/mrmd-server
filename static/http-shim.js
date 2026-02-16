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

  const DOC_EXTENSIONS = ['.md', '.qmd'];

  function basenameFromPath(filePath = '') {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/\/+/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function dirnameFromPath(filePath = '') {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/\/+/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return normalized.startsWith('/') ? '/' : '.';
    return normalized.slice(0, lastSlash) || '/';
  }

  function stripDocExtension(fileName = '') {
    const lower = fileName.toLowerCase();
    for (const ext of DOC_EXTENSIONS) {
      if (lower.endsWith(ext)) {
        return fileName.slice(0, -ext.length);
      }
    }
    return fileName;
  }

  function makeRuntimeIdFromVenv(venvPath = '', forceNew = false) {
    const venvName = basenameFromPath(venvPath).replace(/^\.+/, '') || 'venv';
    const projectName = basenameFromPath(dirnameFromPath(venvPath)).replace(/^\.+/, '') || 'project';
    let name = `${projectName}:${venvName}`.replace(/[^a-zA-Z0-9-:]/g, '-');
    if (forceNew) name += '-' + Date.now().toString(36).slice(-4);
    return name;
  }

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
  let fileScanToken = 0;

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

    updateRecent: (payload) => POST('/api/system/recent', payload || {}),

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
      // Match Electron's streaming contract closely:
      // - emit reset with scanToken
      // - ignore stale responses from older scans
      // - emit done=true so UI doesn't stay stuck on "Indexing..."
      const scanToken = ++fileScanToken;
      const handlers = eventHandlers['files-update'];

      const emitFilesUpdate = (payload) => {
        if (!handlers) return;
        handlers.forEach(cb => {
          try {
            cb(payload);
          } catch (err) {
            console.error('[http-shim] files-update handler error:', err);
          }
        });
      };

      emitFilesUpdate({
        scanToken,
        reset: true,
        done: false,
        totalFiles: 0,
        totalDirs: 0,
      });

      GET(`/api/file/scan?root=${encodeURIComponent(searchDir || '')}`)
        .then((result) => {
          if (scanToken !== fileScanToken) return; // stale response

          const files = Array.isArray(result)
            ? result
            : Array.isArray(result?.files)
              ? result.files
              : [];

          const explicitDirs = Array.isArray(result?.dirs) ? result.dirs : null;

          // Derive directory list from file paths for folder navigation
          // (fallback when API only returns files)
          const derivedDirs = new Set();
          for (const filePath of files) {
            if (typeof filePath !== 'string') continue;
            const parts = filePath.split('/').filter(Boolean);
            const isAbsolute = filePath.startsWith('/');
            let current = isAbsolute ? '/' : '';
            for (let i = 0; i < parts.length - 1; i++) {
              const part = parts[i];
              if (current === '/') current = '/' + part;
              else current = current ? current + '/' + part : part;
              derivedDirs.add(current);
            }
          }

          const dirs = explicitDirs || Array.from(derivedDirs);

          emitFilesUpdate({
            scanToken,
            filesChunk: files,
            dirsChunk: dirs,
            totalFiles: files.length,
            totalDirs: dirs.length,
            done: true,
          });
        })
        .catch(err => {
          if (scanToken !== fileScanToken) return;
          console.error('[http-shim] scanFiles error:', err);
          emitFilesUpdate({ scanToken, error: err.message || String(err), done: true });
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

    getFileInfo: async (filePath) => {
      try {
        const info = await GET(`/api/file/info?path=${encodeURIComponent(filePath)}`);
        return {
          success: true,
          ...info,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    },

    // ========================================================================
    // Venv creation (still useful for setup flows)
    // ========================================================================

    createVenv: (venvPath) =>
      POST('/api/system/create-venv', { venvPath }),

    installMrmdPython: (venvPath) =>
      POST('/api/system/install-mrmd-python', { venvPath }),

    startPython: async (venvPath, forceNew = false) => {
      try {
        const runtimeId = makeRuntimeIdFromVenv(venvPath, forceNew);
        const cwd = dirnameFromPath(venvPath);
        const result = await POST('/api/runtime', {
          config: {
            name: runtimeId,
            language: 'python',
            cwd,
            venv: venvPath,
          },
        });

        return {
          success: true,
          port: result.port,
          runtimeId,
          venv: result.venv || venvPath,
          url: result.url,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    },

    attachRuntime: async (runtimeId) => {
      try {
        const result = await POST(`/api/runtime/${encodeURIComponent(runtimeId)}/attach`, {});
        return {
          success: true,
          port: result.port,
          url: result.url,
          venv: result.venv,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    },

    openFile: async (filePath) => {
      try {
        // Ensure project is detected and sync server is available.
        const project = await GET(`/api/project?path=${encodeURIComponent(filePath)}`);
        const projectDir = project?.root || dirnameFromPath(filePath);

        let syncPort = project?.syncPort;
        if (!syncPort) {
          const sync = await POST('/api/project/sync/acquire', { projectDir });
          syncPort = sync.port;
        }

        // Mirror Electron behavior: track recent file usage.
        try {
          await POST('/api/system/recent', { file: filePath });
        } catch (err) {
          console.warn('[http-shim] Failed to update recent file:', err.message);
        }

        const fileName = basenameFromPath(filePath);
        const docName = stripDocExtension(fileName);

        return {
          success: true,
          syncPort,
          docName,
          pythonPort: null,
          projectDir,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    },

    listRuntimes: async () => {
      try {
        const runtimes = await GET('/api/runtime');
        return { runtimes };
      } catch (err) {
        return { runtimes: [], error: err.message };
      }
    },

    killRuntime: async (runtimeId) => {
      try {
        await DELETE(`/api/runtime/${encodeURIComponent(runtimeId)}`);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
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
    // UNIFIED RUNTIME SERVICE
    // ========================================================================

    runtime: {
      list: (language) => GET(`/api/runtime${language ? `?language=${encodeURIComponent(language)}` : ''}`),

      start: (config) => POST('/api/runtime', { config }),

      stop: (sessionName) => DELETE(`/api/runtime/${encodeURIComponent(sessionName)}`),

      restart: (sessionName) => POST(`/api/runtime/${encodeURIComponent(sessionName)}/restart`, {}),

      forDocument: async (documentPath) => {
        const result = await POST('/api/runtime/for-document', { documentPath });

        // Backwards compatibility: legacy renderer expects a single Python session object.
        // Unified runtime API returns { python, bash, r, julia, pty }.
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          if (result.python && typeof result.python === 'object') {
            return result.python;
          }
        }

        return result;
      },

      forDocumentLanguage: (documentPath, language) =>
        POST(`/api/runtime/for-document/${encodeURIComponent(language)}`, { documentPath }),

      isAvailable: (language) => GET(`/api/runtime/available/${encodeURIComponent(language)}`),

      languages: () => GET('/api/runtime/languages'),
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
        // Use chunked approach to avoid call stack size limits on large files
        let binary = '';
        const bytes = new Uint8Array(file);
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
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
