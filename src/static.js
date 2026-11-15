import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Default public assets directory pointing to the repository's public/ folder.
 */
export const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/**
 * Standard MIME type mappings for web assets.
 */
export const MIME_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

/**
 * Resolves the Content-Type header from a file extension.
 *
 * @param {string} filePath
 * @returns {string} MIME type or 'application/octet-stream'
 */
export function getMimeType(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return 'application/octet-stream';
  }
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Safely resolves a requested URL path against the public root directory.
 * Protects against relative traversal sequences (e.g. ../, ..%2f, %2e%2e/, ..\\),
 * null byte injections, and directory escapes.
 *
 * @param {string} publicDir Base directory for static files
 * @param {string} requestUrl The incoming request URL or pathname
 * @returns {string|null} Resolved absolute file path or null if invalid / traversal attempted
 */
export function resolveSafePath(publicDir, requestUrl) {
  if (!requestUrl || typeof requestUrl !== 'string') {
    return null;
  }

  // Parse path, stripping query string and hash fragments
  let rawPathname;
  try {
    const parsed = new URL(requestUrl, 'http://localhost');
    rawPathname = parsed.pathname;
  } catch {
    rawPathname = requestUrl.split('?')[0].split('#')[0];
  }

  // Reject null byte injection immediately
  if (rawPathname.includes('\0') || rawPathname.includes('%00')) {
    return null;
  }

  // Decode URI components safely, including checking for double-encoding
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPathname);
    if (decodedPath.includes('%')) {
      try {
        decodedPath = decodeURIComponent(decodedPath);
      } catch {
        // Fall back to once-decoded path if second decode fails
      }
    }
  } catch {
    return null;
  }

  if (decodedPath.includes('\0')) {
    return null;
  }

  // Normalize path separators to POSIX for consistent segment analysis
  const posixPath = decodedPath.replace(/\\/g, '/');

  // Strict segment validation: reject any segment attempting traversal
  const segments = posixPath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('..')) {
      return null;
    }
  }

  // Root path resolution: '/' or empty resolves to index.html
  let relativeFilePath = posixPath;
  if (relativeFilePath === '/' || relativeFilePath === '') {
    relativeFilePath = 'index.html';
  } else if (relativeFilePath.endsWith('/')) {
    relativeFilePath = path.posix.join(relativeFilePath, 'index.html');
  }

  // Strip leading slashes for path.resolve
  const sanitizedRelative = path.normalize(relativeFilePath).replace(/^(\/|\\)+/, '');

  // Containment verification against public directory
  const resolvedRoot = path.resolve(publicDir);
  let candidatePath = path.resolve(resolvedRoot, sanitizedRelative);

  const relative = path.relative(resolvedRoot, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  // Handle directory requests where trailing slash was normalized:
  // if candidate path is a directory, resolve path.join(candidatePath, 'index.html')
  try {
    const stats = fs.statSync(candidatePath);
    if (stats.isDirectory()) {
      const indexCandidate = path.join(candidatePath, 'index.html');
      const indexRelative = path.relative(resolvedRoot, indexCandidate);
      if (!indexRelative.startsWith('..') && !path.isAbsolute(indexRelative)) {
        return indexCandidate;
      }
    }
  } catch {
    // candidatePath does not exist; return candidatePath so stat/ENOENT can handle it later
  }

  return candidatePath;
}

/**
 * Writes a standard 404 Not Found response.
 *
 * @param {import('node:http').ServerResponse} res
 */
function sendNotFound(res) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '404 Not Found' }));
}

/**
 * Serves a static file from the public directory via readable streams.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ publicDir?: string }} [options]
 * @returns {Promise<boolean>} Resolves to true if served, false otherwise
 */
export async function serveStatic(req, res, options = {}) {
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const method = (req.method || 'GET').toUpperCase();

  // Only GET and HEAD methods are supported for static asset serving
  if (method !== 'GET' && method !== 'HEAD') {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }
    return false;
  }

  const urlPath = req.pathname || req.url || '/';
  const filePath = resolveSafePath(publicDir, urlPath);

  // If path traversal was attempted or path could not be resolved safely, return 404
  if (!filePath) {
    sendNotFound(res);
    return false;
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    // File not found (ENOENT) or inaccessible
    sendNotFound(res);
    return false;
  }

  // Handle directory requests where trailing slash was normalized: if candidate path is a directory, resolve path.join(candidatePath, 'index.html')
  if (stats.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      sendNotFound(res);
      return false;
    }
  }

  // Must be a regular file
  if (!stats.isFile()) {
    sendNotFound(res);
    return false;
  }

  const contentType = getMimeType(filePath);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': stats.size,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  // If HEAD request, write headers and end response without body
  if (method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  return new Promise((resolve) => {
    res.writeHead(200, headers);

    const stream = fs.createReadStream(filePath);

    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else {
        res.destroy();
      }
      resolve(false);
    });

    // Guard against client socket abort while streaming
    res.on('close', () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
      resolve(true);
    });

    res.on('finish', () => {
      resolve(true);
    });

    stream.pipe(res);
  });
}

/**
 * Creates a static asset handler middleware configured with options.
 *
 * @param {{ publicDir?: string }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 */
export function createStaticHandler(options = {}) {
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  return function staticHandler(req, res) {
    return serveStatic(req, res, { ...options, publicDir });
  };
}

export const staticHandler = createStaticHandler;

export default serveStatic;
