/**
 * CloudSessionService — drop-in replacement for SessionService
 *
 * Instead of spawning mrmd-python as a child process, this connects
 * to a pre-existing runtime container's MRP endpoint. Used when
 * mrmd-server runs inside an editor container (CLOUD_MODE=1).
 *
 * The runtime container is started by the orchestrator/compute-manager
 * and its port is passed via RUNTIME_PORT env var.
 */

class CloudSessionService {
  constructor(runtimePort, runtimeHost) {
    this.runtimePort = runtimePort;
    this.runtimeHost = runtimeHost || '127.0.0.1';
    this.sessions = new Map();
    this.defaultSession = null;
  }

  /**
   * List all sessions.
   * In cloud mode there's typically one session per runtime container.
   */
  list() {
    return Array.from(this.sessions.values());
  }

  /**
   * Start a session — in cloud mode, just registers the pre-existing runtime.
   */
  async start(config) {
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
      port,
      pid: null,
      venv: null,
      cwd: config.cwd || '/home/user',
      startedAt: new Date().toISOString(),
      alive: true,
      cloud: true,
    };

    this.sessions.set(name, info);
    if (!this.defaultSession) this.defaultSession = name;

    return info;
  }

  /**
   * Stop a session — in cloud mode, we don't kill the runtime container
   * (that's the orchestrator's job). Just deregister locally.
   */
  async stop(sessionName) {
    this.sessions.delete(sessionName);
    return true;
  }

  /**
   * Restart — re-verify the runtime is alive.
   */
  async restart(sessionName) {
    const session = this.sessions.get(sessionName);
    const config = session ? { name: sessionName, cwd: session.cwd } : { name: sessionName };
    this.sessions.delete(sessionName);
    return this.start(config);
  }

  /**
   * Attach to a session.
   */
  attach(sessionName) {
    const session = this.sessions.get(sessionName);
    return session || null;
  }

  /**
   * Get or create session for a document.
   * In cloud mode, always returns the runtime container's port.
   * Auto-starts (registers) the session if needed.
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    // Derive a session name from the project
    const projectName = projectRoot ? projectRoot.split('/').pop() : 'default';
    const name = `${projectName}:default`;

    const existing = this.sessions.get(name);
    if (existing?.alive) {
      return existing;
    }

    // Auto-register the runtime container as a session
    try {
      const info = await this.start({ name, cwd: projectRoot || '/home/user' });
      return {
        name,
        port: info.port,
        alive: true,
        autoStart: true,
        venv: null,
        cwd: info.cwd,
        pid: null,
        startedAt: info.startedAt,
      };
    } catch (err) {
      return {
        name,
        port: null,
        alive: false,
        autoStart: true,
        venv: null,
        cwd: projectRoot || '/home/user',
        pid: null,
        error: err.message,
      };
    }
  }

  /**
   * Update the runtime port and/or host (called by orchestrator after CRIU migration).
   * Updates all existing sessions to point to the new location.
   */
  updateRuntimePort(newPort, newHost) {
    const oldPort = this.runtimePort;
    const oldHost = this.runtimeHost;
    this.runtimePort = newPort;
    if (newHost) this.runtimeHost = newHost;
    for (const [name, session] of this.sessions) {
      session.port = newPort;
    }
    console.log(`[cloud-session] Runtime updated: ${oldHost}:${oldPort} → ${this.runtimeHost}:${newPort}`);
    return { oldPort, newPort, oldHost, newHost: this.runtimeHost, sessionsUpdated: this.sessions.size };
  }

  /**
   * Shutdown — no-op in cloud mode.
   */
  shutdown() {
    this.sessions.clear();
  }
}

export default CloudSessionService;
