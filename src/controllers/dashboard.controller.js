import { REQUEST_STATUS } from '../models/intercepted-request.js';
import { parseJsonBody } from '../router.js';
import { sendSSEResponse } from '../sse.js';
import defaultStore from '../store.js';

const STORE_LIFECYCLE_EVENTS = [
  'request:added',
  'request:resolved',
  'request:canceled',
  'request:aborted'
];

/**
 * Creates a Dashboard Controller instance managing real-time SSE subscriptions
 * and operator actions (resolve and cancel).
 *
 * @param {import('../store.js').RequestStore} [store]
 * @returns {object} Dashboard controller instance
 */
export function createDashboardController(store = defaultStore) {
  const subscriberPool = new Set();

  /**
   * Broadcasts the current pending requests list to all connected dashboard SSE clients.
   */
  function broadcastPending() {
    const data = JSON.stringify(store.getAllPending());
    const message = `data: ${data}\n\n`;

    for (const clientRes of subscriberPool) {
      try {
        if (!clientRes.writableEnded) {
          clientRes.write(message);
        } else {
          subscriberPool.delete(clientRes);
        }
      } catch {
        subscriberPool.delete(clientRes);
      }
    }
  }

  // Subscribe to domain lifecycle events on the RequestStore
  const onStoreEvent = () => {
    broadcastPending();
  };

  if (store && typeof store.on === 'function') {
    for (const eventName of STORE_LIFECYCLE_EVENTS) {
      store.on(eventName, onStoreEvent);
    }
  }

  /**
   * Handles GET /api/events.
   * Establishes real-time SSE stream, registers subscriber, sends initial state,
   * and cleans up on client disconnect.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handleEvents(req, res) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
    }

    subscriberPool.add(res);

    const onClientClose = () => {
      subscriberPool.delete(res);
      if (req && typeof req.removeListener === 'function') {
        req.removeListener('close', onClientClose);
      }
      if (res && typeof res.removeListener === 'function') {
        res.removeListener('close', onClientClose);
      }
    };

    if (req && typeof req.once === 'function') {
      req.once('close', onClientClose);
    }
    if (res && typeof res.once === 'function') {
      res.once('close', onClientClose);
    }

    // Immediately send current pending requests list on connection
    const initialData = JSON.stringify(store.getAllPending());
    res.write(`data: ${initialData}\n\n`);
  }

  /**
   * Handles GET /api/pending.
   * Returns current pending requests array as JSON.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handlePending(req, res) {
    const pending = store.getAllPending();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pending));
  }

  /**
   * Handles POST /api/resolve.
   * Resolves target InterceptedRequest and transmits Instant Dispatch SSE chunks to agent client.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleResolve(req, res) {
    let body = req.body;
    if (body === undefined) {
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        }
        return;
      }
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body: Expected an object' }));
      }
      return;
    }

    const { id, payload } = body;
    if (!id || typeof id !== 'string') {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: id' }));
      }
      return;
    }

    const storedReq = store.getRequest(id);
    if (!storedReq || storedReq.status !== REQUEST_STATUS.PENDING) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request not found or already resolved' }));
      }
      return;
    }

    try {
      if (typeof storedReq.resolve === 'function') {
        storedReq.resolve(payload);
      } else if (storedReq.res && !storedReq.res.writableEnded) {
        sendSSEResponse(storedReq.res, payload);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Request not found or already resolved' }));
      }
      return;
    }

    store.removeRequest(id);

    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
  }

  /**
   * Handles POST /api/cancel.
   * Cancels target InterceptedRequest and transmits graceful termination SSE chunk to agent client.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleCancel(req, res) {
    let body = req.body;
    if (body === undefined) {
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        }
        return;
      }
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body: Expected an object' }));
      }
      return;
    }

    const { id, reason } = body;
    if (!id || typeof id !== 'string') {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: id' }));
      }
      return;
    }

    const storedReq = store.getRequest(id);
    if (!storedReq || storedReq.status !== REQUEST_STATUS.PENDING) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request not found or already resolved' }));
      }
      return;
    }

    try {
      if (typeof storedReq.cancel === 'function') {
        storedReq.cancel(reason);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Request not found or already resolved' }));
      }
      return;
    }

    store.removeRequest(id);

    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Request canceled' }));
    }
  }

  /**
   * Registers all dashboard routes on the provided router instance.
   *
   * @param {import('../router.js').Router|Function} router
   * @returns {import('../router.js').Router|Function}
   */
  function registerRoutes(router) {
    router.get('/api/events', handleEvents);
    router.get('/api/pending', handlePending);
    router.post('/api/resolve', handleResolve);
    router.post('/api/cancel', handleCancel);
    return router;
  }

  /**
   * Closes all subscriber connections and detaches store lifecycle listeners.
   */
  function close() {
    if (store && typeof store.removeListener === 'function') {
      for (const eventName of STORE_LIFECYCLE_EVENTS) {
        store.removeListener(eventName, onStoreEvent);
      }
    }

    for (const clientRes of subscriberPool) {
      try {
        if (!clientRes.writableEnded) {
          clientRes.end();
        }
      } catch {
        // Safe close
      }
    }
    subscriberPool.clear();
  }

  return {
    handleEvents,
    handlePending,
    handleResolve,
    handleCancel,
    broadcastPending,
    registerRoutes,
    close,
    subscriberPool,
    get subscriberCount() {
      return subscriberPool.size;
    }
  };
}

/**
 * Convenience helper to register dashboard routes on a router instance.
 *
 * @param {import('../router.js').Router|Function} router
 * @param {import('../store.js').RequestStore} [store]
 * @returns {import('../router.js').Router|Function}
 */
export function registerDashboardRoutes(router, store = defaultStore) {
  const controller = createDashboardController(store);
  return controller.registerRoutes(router);
}

export const STORE_EVENTS = STORE_LIFECYCLE_EVENTS;

// Default singleton controller instance for application-wide backward compatibility
export const defaultDashboardController = createDashboardController(defaultStore);
export const handleEvents = defaultDashboardController.handleEvents;
export const handlePending = defaultDashboardController.handlePending;
export const handleResolve = defaultDashboardController.handleResolve;
export const handleCancel = defaultDashboardController.handleCancel;
export const broadcastPending = defaultDashboardController.broadcastPending;

export default {
  createDashboardController,
  registerDashboardRoutes,
  defaultDashboardController,
  handleEvents,
  handlePending,
  handleResolve,
  handleCancel,
  broadcastPending,
  STORE_EVENTS
};
