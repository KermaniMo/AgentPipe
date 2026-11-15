import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRouter } from './router.js';
import { serveStatic, DEFAULT_PUBLIC_DIR } from './static.js';
import { createAgentController } from './controllers/agent.controller.js';
import { createDashboardController } from './controllers/dashboard.controller.js';
import defaultStore from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = 4747;

/**
 * Creates and returns an unlistened AgentPipe HTTP server instance.
 * Wires the router, agent interception controller, dashboard controller,
 * static asset streaming with traversal guards, and universal CORS.
 *
 * @param {object} [options]
 * @param {import('./store.js').RequestStore} [options.store] Store for intercepted requests
 * @param {string} [options.publicDir] Directory containing static dashboard assets
 * @param {number} [options.port] Default port (default 4747)
 * @param {string} [options.host] Default host (default 'localhost')
 * @param {number} [options.bodyLimit] JSON body parsing limit in bytes
 * @returns {import('node:http').Server} Unlistened HTTP server instance
 */
export function createAgentPipeServer(options = {}) {
  const store = options.store || defaultStore;
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const port = options.port || PORT;
  const host = options.host || 'localhost';
  const bodyLimit = options.bodyLimit;

  const router = createRouter({ bodyLimit });

  // 1. Wire Agent Controller routes (/v1/models, /models, /v1/chat/completions, /chat/completions)
  const agentController = createAgentController(store);
  agentController.registerRoutes(router);

  // 2. Wire Dashboard Controller routes (/api/events, /api/pending, /api/resolve, /api/cancel)
  const dashboardController = createDashboardController(store);
  dashboardController.registerRoutes(router);

  // 3. Wire Static Assets with Path Traversal Guards and 404 Fallback
  router.setNotFoundHandler(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      if (!req.pathname.startsWith('/api/') && !req.pathname.startsWith('/v1/')) {
        return serveStatic(req, res, { publicDir });
      }
    }
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '404 Not Found' }));
    }
  });

  // 4. Create HTTP Server instance
  const server = http.createServer((req, res) => router.handle(req, res));

  // Attach components to server for inspection/customization
  server.store = store;
  server.router = router;
  server.agentController = agentController;
  server.dashboardController = dashboardController;
  server.port = port;
  server.host = host;

  // 5. Clean Teardown hook
  let isClosed = false;
  const teardown = () => {
    if (isClosed) return;
    isClosed = true;
    dashboardController.close();
  };

  server.on('close', teardown);

  const originalClose = server.close.bind(server);
  server.close = function close(callback) {
    teardown();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    return originalClose(callback);
  };

  return server;
}

let _defaultServerInstance = null;

/**
 * Returns a lazily instantiated unlistened server instance for backward compatibility.
 * Zero side effects on module import.
 *
 * @returns {import('node:http').Server}
 */
export function getServer() {
  if (!_defaultServerInstance) {
    _defaultServerInstance = createAgentPipeServer();
  }
  return _defaultServerInstance;
}

/**
 * Lazy proxy to unlistened server instance for backward compatibility.
 * Ensures zero side-effects on module import (deferred instantiation on demand).
 */
export const server = new Proxy({}, {
  get(target, prop, receiver) {
    const instance = getServer();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
  set(target, prop, value, receiver) {
    const instance = getServer();
    return Reflect.set(instance, prop, value, receiver);
  },
  has(target, prop) {
    const instance = getServer();
    return Reflect.has(instance, prop);
  },
  getPrototypeOf() {
    const instance = getServer();
    return Reflect.getPrototypeOf(instance);
  }
});

export default createAgentPipeServer;
