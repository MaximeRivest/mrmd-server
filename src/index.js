/**
 * mrmd-server - HTTP server for mrmd
 *
 * Provides the same API as Electron's main process, but over HTTP.
 * This allows running mrmd in any browser, accessing from anywhere.
 */

export { createServer, startServer } from './server.js';
export { EventBus } from './events.js';
