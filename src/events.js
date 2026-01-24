/**
 * Event bus for server-side events that need to be pushed to clients
 *
 * Events:
 * - files-update: File list changed
 * - venv-found: Venv discovered during scan
 * - venv-scan-done: Venv scan complete
 * - project:changed: Project files changed
 * - sync-server-died: Sync server crashed
 */

import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Allow many WebSocket connections
  }

  /**
   * Emit an event to all connected clients
   * @param {string} event - Event name
   * @param {any} data - Event data
   */
  broadcast(event, data) {
    this.emit('broadcast', { event, data });
  }

  // Convenience methods for specific events

  filesUpdated(files) {
    this.broadcast('files-update', { files });
  }

  venvFound(venv) {
    this.broadcast('venv-found', venv);
  }

  venvScanDone() {
    this.broadcast('venv-scan-done', {});
  }

  projectChanged(projectRoot) {
    this.broadcast('project:changed', { projectRoot });
  }

  syncServerDied(data) {
    this.broadcast('sync-server-died', data);
  }
}
