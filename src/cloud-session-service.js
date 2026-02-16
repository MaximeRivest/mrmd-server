/**
 * CloudSessionService — hybrid runtime manager for cloud mode
 *
 * Python:       Routes to a pre-existing runtime container (RUNTIME_PORT)
 * Bash/R/Julia/PTY: Spawns local child processes via RuntimeService
 *
 * Used when mrmd-server runs inside an editor container (CLOUD_MODE=1).
 * The Python runtime container is started by the orchestrator/compute-manager.
 */

import { RuntimeService } from './services.js';

/** Languages handled by the external runtime container */
const CLOUD_LANGUAGES = new Set(['python', 'py', 'python3']);

class CloudSessionService {
  constructor(runtimePort, runtimeHost) {
    this.runtimePort = runtimePort;
    this.runtimeHost = runtimeHost || '127.0.0.1';
    this.homeDir = process.env.CLOUD_HOME || process.env.HOME || '/home/ubuntu';
    this.pythonSessions = new Map();
    this.defaultRuntime = null;

    // Local RuntimeService for bash, R, Julia, PTY
    this.localService = new RuntimeService();
  }

  /**
   * Is this language handled by the cloud runtime container?
   */
  _isCloudLanguage(language) {
    return CLOUD_LANGUAGES.has((language || '').toLowerCase());
  }

  /**
   * List all sessions (cloud Python + local runtimes).
   */
  list(language) {
    const cloud = Array.from(this.pythonSessions.values());
    const local = this.localService.list(language);

    if (language) {
      if (this._isCloudLanguage(language)) return cloud;
      return local;
    }
    return [...cloud, ...local];
  }

  /**
   * Start a session.
   * Python → register cloud runtime.  Others → delegate to local RuntimeService.
   */
  async start(config) {
    const language = config.language || 'python';

    if (!this._isCloudLanguage(language)) {
      return this.localService.start(config);
    }

    // Cloud Python: register pre-existing runtime container
    const name = config.name || 'default';
    const port = this.runtimePort;

    // Verify runtime is reachable
    try {
      const res = await fetch(`http://${this.runtimeHost}:${port}/mrp/v1/capabilities`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
    } catch (err) {
      throw new Error(`Runtime container not reachable on port ${port}: ${err.message}`);
    }

    const info = {
      name,
      language: 'python',
      port,
      url: `http://${this.runtimeHost}:${port}/mrp/v1`,
      pid: null,
      venv: null,
      cwd: config.cwd || this.homeDir,
      startedAt: new Date().toISOString(),
      alive: true,
      cloud: true,
    };

    this.pythonSessions.set(name, info);
    if (!this.defaultRuntime) this.defaultRuntime = name;

    return info;
  }

  /**
   * Stop a session.
   */
  async stop(sessionName) {
    if (this.pythonSessions.has(sessionName)) {
      this.pythonSessions.delete(sessionName);
      return true;
    }
    return this.localService.stop(sessionName);
  }

  /**
   * Restart a session.
   */
  async restart(sessionName) {
    if (this.pythonSessions.has(sessionName)) {
      const session = this.pythonSessions.get(sessionName);
      const config = { name: sessionName, language: 'python', cwd: session?.cwd };
      this.pythonSessions.delete(sessionName);
      return this.start(config);
    }
    return this.localService.restart(sessionName);
  }

  /**
   * Attach to an existing session.
   */
  attach(sessionName) {
    const cloudSession = this.pythonSessions.get(sessionName);
    if (cloudSession) return cloudSession;
    return this.localService.attach(sessionName);
  }

  /**
   * Get or create ALL runtimes needed for a document.
   * Python → cloud container.  Bash/R/Julia/PTY → local RuntimeService.
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    const results = {};

    // Python: cloud runtime
    const projectName = projectRoot ? projectRoot.split('/').pop() : 'default';
    const pythonName = `${projectName}:python:default`;

    const existingPython = this.pythonSessions.get(pythonName);
    if (existingPython?.alive) {
      results.python = { ...existingPython, autoStart: true, available: true };
    } else {
      try {
        const info = await this.start({ name: pythonName, language: 'python', cwd: projectRoot || this.homeDir });
        results.python = {
          ...info,
          autoStart: true,
          available: true,
        };
      } catch (err) {
        results.python = {
          name: pythonName,
          language: 'python',
          port: null,
          alive: false,
          autoStart: true,
          available: false,
          error: err.message,
        };
      }
    }

    // Other languages: delegate to local RuntimeService
    const localResults = await this.localService.getForDocument(
      documentPath, projectConfig, frontmatter, projectRoot,
    );

    // Merge: local results for non-Python, cloud result for Python
    for (const [lang, info] of Object.entries(localResults)) {
      if (lang !== 'python') {
        results[lang] = info;
      }
    }

    return results;
  }

  /**
   * Get or create a runtime for a specific language.
   */
  async getForDocumentLanguage(language, documentPath, projectConfig, frontmatter, projectRoot) {
    if (this._isCloudLanguage(language)) {
      const projectName = projectRoot ? projectRoot.split('/').pop() : 'default';
      const name = `${projectName}:python:default`;

      const existing = this.pythonSessions.get(name);
      if (existing?.alive) {
        return { ...existing, autoStart: true, available: true };
      }

      try {
        const info = await this.start({ name, language: 'python', cwd: projectRoot || this.homeDir });
        return { ...info, autoStart: true, available: true };
      } catch (err) {
        return {
          name,
          language: 'python',
          port: null,
          alive: false,
          autoStart: true,
          available: false,
          error: err.message,
        };
      }
    }

    // Non-Python: delegate to local RuntimeService
    return this.localService.getForDocumentLanguage(
      language, documentPath, projectConfig, frontmatter, projectRoot,
    );
  }

  /**
   * Check if a language is available.
   */
  isAvailable(language) {
    if (this._isCloudLanguage(language)) return { available: true };
    return this.localService.isAvailable(language);
  }

  /**
   * List ALL supported languages (cloud + local).
   */
  supportedLanguages() {
    return ['python', ...this.localService.supportedLanguages().filter(l => l !== 'python')];
  }

  /**
   * Update the cloud runtime port/host (called after CRIU migration).
   */
  updateRuntimePort(newPort, newHost) {
    const oldPort = this.runtimePort;
    const oldHost = this.runtimeHost;
    this.runtimePort = newPort;
    if (newHost) this.runtimeHost = newHost;
    for (const [, session] of this.pythonSessions) {
      session.port = newPort;
      session.url = `http://${this.runtimeHost}:${newPort}/mrp/v1`;
    }
    console.log(`[cloud-session] Runtime updated: ${oldHost}:${oldPort} → ${this.runtimeHost}:${newPort}`);
    return { oldPort, newPort, oldHost, newHost: this.runtimeHost, sessionsUpdated: this.pythonSessions.size };
  }

  /**
   * Shutdown all sessions.
   */
  shutdown() {
    this.pythonSessions.clear();
    if (typeof this.localService.shutdown === 'function') {
      this.localService.shutdown();
    }
  }
}

export default CloudSessionService;
