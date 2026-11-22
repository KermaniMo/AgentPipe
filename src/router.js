/**
 * Native Zero-Dependency Router and Safe Body Parser for AgentPipe.
 * Normalizes request paths, enforces universal CORS headers, handles preflight OPTIONS,
 * and parses JSON request bodies using binary buffer concatenation to preserve multi-byte UTF-8 Unicode text.
 */

const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024; // 10MB safety limit

/**
 * Normalizes a URL path by ensuring a leading slash, removing redundant
 * or trailing slashes (except for root "/"), and trimming whitespace.
 *
 * @param {string} pathStr
 * @returns {string} Normalized path string
 */
export function normalizePath(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') {
    return '/';
  }
  let trimmed = pathStr.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  if (!trimmed.startsWith('/')) {
    trimmed = '/' + trimmed;
  }
  // Strip trailing slashes
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    trimmed = trimmed.replace(/\/+$/, '');
  }
  return trimmed || '/';
}

/**
 * Safely parses an incoming request's JSON body using binary buffer concatenation.
 * Prevents Unicode replacement character corruption by assembling all chunks in memory
 * as raw Buffers before decoding UTF-8.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<any>} Parsed JSON payload or empty object
 */
export function parseJsonBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  if (req.body !== undefined) {
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let limitExceeded = false;

    function onData(chunk) {
      if (limitExceeded) return;
      receivedBytes += chunk.length;
      if (receivedBytes > limit) {
        limitExceeded = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        // Resume in discarding mode so socket drains cleanly without blocking response
        req.on('data', () => {});
        req.resume();
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (limitExceeded) return;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const buffer = Buffer.concat(chunks);
      const str = buffer.toString('utf8');
      if (!str.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(str);
        resolve(parsed);
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    }

    function onError(err) {
      reject(err);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Backward compatibility alias for parseJsonBody.
 */
export const readJsonBody = parseJsonBody;

/**
 * Lightweight native HTTP router.
 */
export class Router {
  constructor({ bodyLimit = DEFAULT_BODY_LIMIT } = {}) {
    this._routes = [];
    this._bodyLimit = bodyLimit;
    this._notFoundHandler = null;
    this.handle = this.handle.bind(this);
  }

  /**
   * Registers a route for a specific method and path (or array of paths).
   *
   * @param {string} method HTTP method in uppercase
   * @param {string|string[]} path Path or list of paths
   * @param {Function} handler Request handler function (req, res)
   */
  add(method, path, handler) {
    const paths = Array.isArray(path) ? path : [path];
    const upperMethod = method.toUpperCase();
    for (const p of paths) {
      this._routes.push({
        method: upperMethod,
        path: normalizePath(p),
        handler
      });
    }
  }

  get(path, handler) {
    this.add('GET', path, handler);
  }

  post(path, handler) {
    this.add('POST', path, handler);
  }

  put(path, handler) {
    this.add('PUT', path, handler);
  }

  /**
   * Sets a custom 404 handler.
   *
   * @param {Function} handler Request handler function (req, res)
   */
  setNotFoundHandler(handler) {
    this._notFoundHandler = handler;
  }

  /**
   * Dispatches incoming requests. Sets universal CORS headers, handles preflight
   * OPTIONS immediately with 204 No Content, normalizes request paths, parses JSON
   * bodies on mutating requests, and routes to handlers or standard 404.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handle(req, res) {
    // Universal CORS headers applied to all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // Immediate 204 No Content preflight handling
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = normalizePath(parsedUrl.pathname);
    req.pathname = pathname;
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());

    const method = (req.method || 'GET').toUpperCase();

    // Match route by method and normalized path
    const matched = this._routes.find(route => route.method === method && route.path === pathname);

    if (!matched) {
      if (this._notFoundHandler) {
        return await this._notFoundHandler(req, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '404 Not Found' }));
      return;
    }

    // Auto-parse JSON body for mutating methods
    if (method === 'POST' || method === 'PUT') {
      try {
        req.body = await parseJsonBody(req, { limit: this._bodyLimit });
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, {
            'Content-Type': 'application/json',
            'Connection': 'close'
          });
          res.end(JSON.stringify({ error: err.message || 'Payload too large' }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        return;
      }
    }

    try {
      await matched.handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }
}

/**
 * Creates and returns a lightweight Router instance.
 *
 * @param {{ bodyLimit?: number }} [options]
 * @returns {Router}
 */
export function createRouter(options) {
  return new Router(options);
}

export default createRouter;
