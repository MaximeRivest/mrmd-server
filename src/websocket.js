/**
 * WebSocket handler for push events
 *
 * Clients connect to /events?token=xxx and receive JSON messages:
 * { "event": "project:changed", "data": { ... } }
 */

import { validateWsToken } from './auth.js';

/**
 * Setup WebSocket server
 * @param {import('ws').WebSocketServer} wss
 * @param {import('./events.js').EventBus} eventBus
 * @param {string} validToken
 * @param {boolean} noAuth
 */
export function setupWebSocket(wss, eventBus, validToken, noAuth) {
  // Track connected clients
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    // Validate token from query string
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!validateWsToken(token, validToken, noAuth)) {
      ws.close(4001, 'Invalid token');
      return;
    }

    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    // Send welcome message
    ws.send(JSON.stringify({
      event: 'connected',
      data: { message: 'Connected to mrmd-server events' },
    }));

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
      clients.delete(ws);
    });

    // Handle ping/pong for connection health
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  // Broadcast events to all connected clients
  eventBus.on('broadcast', ({ event, data }) => {
    const message = JSON.stringify({ event, data });
    for (const client of clients) {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    }
  });

  // Ping clients periodically to detect dead connections
  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  return { clients };
}
