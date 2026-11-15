import { EventEmitter } from 'node:events';
import { InterceptedRequest, REQUEST_STATUS } from './models/intercepted-request.js';

/**
 * RequestStore is an in-memory registry for Intercepted Requests that extends
 * Node's native EventEmitter. It manages the collection of active requests and
 * emits domain events when requests are added or change lifecycle states.
 */
export class RequestStore extends EventEmitter {
  constructor() {
    super();
    this._requests = new Map();
    this._cleanups = new Map();
  }

  /**
   * Register a new Intercepted Request. Accepts either an existing
   * InterceptedRequest instance, an options object, or positional arguments.
   * Emits 'request:added'.
   *
   * @param {InterceptedRequest|string|object} requestOrId
   * @param {import('node:http').IncomingMessage} [req]
   * @param {import('node:http').ServerResponse} [res]
   * @param {Array} [messages]
   * @param {Array} [tools]
   * @param {number} [createdAt]
   * @returns {InterceptedRequest}
   */
  addRequest(requestOrId, req, res, messages = [], tools = [], createdAt) {
    let request;

    if (requestOrId instanceof InterceptedRequest) {
      request = requestOrId;
    } else if (requestOrId && typeof requestOrId === 'object' && typeof requestOrId.on === 'function' && requestOrId.id) {
      request = requestOrId;
    } else if (typeof requestOrId === 'object' && requestOrId !== null && !(requestOrId instanceof EventEmitter) && !req && !res) {
      request = new InterceptedRequest(requestOrId);
    } else {
      request = new InterceptedRequest(requestOrId, req, res, messages, tools, createdAt);
    }

    if (this._requests.has(request.id)) {
      this.removeRequest(request.id);
    }

    this._requests.set(request.id, request);

    if (typeof request.on === 'function') {
      const onResolved = (data) => {
        if (data && typeof data === 'object') {
          request.payload = data.payload;
        }
        request.request = request;
        this.emit('request:resolved', request, data);
      };

      const onCanceled = (data) => {
        if (data && typeof data === 'object') {
          request.reason = data.reason;
        }
        request.request = request;
        this.emit('request:canceled', request, data);
      };

      const onAborted = (data) => {
        request.request = request;
        this.emit('request:aborted', request, data);
      };

      if (typeof request.once === 'function') {
        request.once('resolved', onResolved);
        request.once('canceled', onCanceled);
        request.once('aborted', onAborted);
      } else {
        request.on('resolved', onResolved);
        request.on('canceled', onCanceled);
        request.on('aborted', onAborted);
      }

      this._cleanups.set(request.id, () => {
        if (typeof request.removeListener === 'function') {
          request.removeListener('resolved', onResolved);
          request.removeListener('canceled', onCanceled);
          request.removeListener('aborted', onAborted);
        }
      });
    }

    request.request = request;
    this.emit('request:added', request);
    return request;
  }

  /**
   * Retrieve an active Intercepted Request by its ID.
   *
   * @param {string} id
   * @returns {InterceptedRequest|undefined}
   */
  getRequest(id) {
    return this._requests.get(id);
  }

  /**
   * Remove an Intercepted Request from the registry. Detaches any attached
   * lifecycle listeners and deletes it from storage.
   *
   * @param {string} id
   * @returns {boolean} True if the request was present and deleted, false otherwise.
   */
  removeRequest(id) {
    if (!this._requests.has(id)) {
      return false;
    }

    const cleanup = this._cleanups.get(id);
    if (cleanup) {
      cleanup();
      this._cleanups.delete(id);
    }

    return this._requests.delete(id);
  }

  /**
   * Returns an array of sanitized JSON representations (using req.toJSON())
   * of all currently pending requests.
   *
   * @returns {Array<object>}
   */
  getAllPending() {
    const pending = [];
    for (const req of this._requests.values()) {
      if (!req.status || req.status === REQUEST_STATUS.PENDING) {
        if (typeof req.toJSON === 'function') {
          pending.push(req.toJSON());
        } else {
          pending.push({
            id: req.id,
            messages: req.messages || [],
            tools: req.tools || [],
            createdAt: req.createdAt || Date.now(),
            status: req.status || REQUEST_STATUS.PENDING
          });
        }
      }
    }
    return pending;
  }

  /**
   * Clear all stored requests and detach listeners.
   */
  clear() {
    for (const cleanup of this._cleanups.values()) {
      cleanup();
    }
    this._cleanups.clear();
    this._requests.clear();
  }

  /**
   * Total count of requests in store.
   */
  get size() {
    return this._requests.size;
  }
}

/**
 * Singleton RequestStore instance for application-wide backward compatibility.
 */
export const store = new RequestStore();

// Named delegates maintaining 100% backward compatibility with module-level consumers
export function addRequest(...args) {
  return store.addRequest(...args);
}

export function getRequest(id) {
  return store.getRequest(id);
}

export function removeRequest(id) {
  return store.removeRequest(id);
}

export function getAllPending() {
  return store.getAllPending();
}

export default store;
