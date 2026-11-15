import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serveStatic, createStaticHandler, getMimeType, MIME_TYPES } from '../src/static.js';
import { createRouter } from '../src/router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.resolve(REPO_ROOT, 'public');

describe('Streaming Static Asset Handler with Traversal Guard', () => {
  let server;
  let baseUrl;
  let tempDir;

  function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqOptions = {
        method: options.method || 'GET',
        headers: options.headers || {}
      };

      const req = http.request(url, reqOptions, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const bodyStr = rawBuffer.toString('utf8');
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyStr,
            buffer: rawBuffer
          });
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    // Create temporary directory with fixture files for all required MIME types
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpipe-static-test-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<!DOCTYPE html><html><body>AgentPipe Dashboard</body></html>', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'app.js'), 'console.log("agentpipe");', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'style.css'), 'body { background: #000; }', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'data.json'), '{"status":"ok"}', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(tempDir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(path.join(tempDir, 'photo.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(path.join(tempDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    // Create a subfolder to test nested directory traversal attempts
    const subDir = path.join(tempDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'nested.js'), 'export const nested = true;', 'utf8');

    // Create a subfolder with index.html to test directory index resolution when trailing slash is normalized
    const nestedDir = path.join(tempDir, 'nested-dir');
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, 'index.html'), '<!DOCTYPE html><html><body>Nested Directory Index</body></html>', 'utf8');

    // Start HTTP test server serving from tempDir
    const staticMiddleware = createStaticHandler({ publicDir: tempDir });
    server = http.createServer((req, res) => {
      staticMiddleware(req, res);
    });

    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(() => {
    if (server) {
      server.closeAllConnections?.();
      server.close();
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Default and Root URL Resolution', () => {
    test('GET / resolves to index.html with HTTP 200 and text/html', async () => {
      const res = await makeRequest('/');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.ok(res.body.includes('AgentPipe Dashboard'));
    });

    test('GET /index.html resolves to index.html with HTTP 200 and text/html', async () => {
      const res = await makeRequest('/index.html');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.ok(res.body.includes('AgentPipe Dashboard'));
    });

    test('GET /?tab=pending preserves query strings and resolves to index.html', async () => {
      const res = await makeRequest('/?tab=pending');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.ok(res.body.includes('AgentPipe Dashboard'));
    });

    test('resolves directory request to index.html when trailing slash is normalized (GET /nested-dir)', async () => {
      const res = await makeRequest('/nested-dir');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.ok(res.body.includes('Nested Directory Index'));
    });

    test('resolves directory request to index.html with trailing slash (GET /nested-dir/)', async () => {
      const res = await makeRequest('/nested-dir/');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.ok(res.body.includes('Nested Directory Index'));
    });
  });

  describe('MIME Type Resolution and Streaming', () => {
    test('serves JavaScript (.js) with application/javascript', async () => {
      const res = await makeRequest('/app.js');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript');
      assert.strictEqual(res.body, 'console.log("agentpipe");');
    });

    test('serves CSS (.css) with text/css', async () => {
      const res = await makeRequest('/style.css');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/css');
      assert.strictEqual(res.body, 'body { background: #000; }');
    });

    test('serves JSON (.json) with application/json', async () => {
      const res = await makeRequest('/data.json');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
    });

    test('serves PNG (.png) with image/png and binary stream fidelity', async () => {
      const res = await makeRequest('/image.png');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'image/png');
      const expectedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.deepStrictEqual(res.buffer, expectedBytes);
    });

    test('serves JPEG (.jpg and .jpeg) with image/jpeg', async () => {
      const resJpg = await makeRequest('/photo.jpg');
      assert.strictEqual(resJpg.statusCode, 200);
      assert.strictEqual(resJpg.headers['content-type'], 'image/jpeg');

      const resJpeg = await makeRequest('/photo.jpeg');
      assert.strictEqual(resJpeg.statusCode, 200);
      assert.strictEqual(resJpeg.headers['content-type'], 'image/jpeg');
    });

    test('serves SVG (.svg) with image/svg+xml', async () => {
      const res = await makeRequest('/logo.svg');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'image/svg+xml');
      assert.ok(res.body.includes('<svg'));
    });

    test('handles HEAD requests with 200 and headers but empty body', async () => {
      const res = await makeRequest('/style.css', { method: 'HEAD' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/css');
      assert.strictEqual(res.body, '');
    });

    test('streams actual project public/ assets byte-for-byte using default directory', async () => {
      // Create separate server using default public directory
      const defaultStaticHandler = createStaticHandler();
      const defaultServer = http.createServer((req, res) => defaultStaticHandler(req, res));
      await new Promise(resolve => defaultServer.listen(0, '127.0.0.1', resolve));
      const defaultPort = defaultServer.address().port;

      try {
        const actualIndex = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        const res = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${defaultPort}/index.html`, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            }));
            res.on('error', reject);
          });
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-type'], 'text/html');
        assert.strictEqual(res.body, actualIndex);
      } finally {
        defaultServer.closeAllConnections?.();
        defaultServer.close();
      }
    });

    test('exposes getMimeType helper and MIME_TYPES registry', () => {
      assert.strictEqual(getMimeType('index.html'), 'text/html');
      assert.strictEqual(getMimeType('/foo/bar.js'), 'application/javascript');
      assert.strictEqual(getMimeType('styles.css'), 'text/css');
      assert.strictEqual(getMimeType('data.json'), 'application/json');
      assert.strictEqual(getMimeType('pic.png'), 'image/png');
      assert.strictEqual(getMimeType('pic.jpg'), 'image/jpeg');
      assert.strictEqual(getMimeType('pic.jpeg'), 'image/jpeg');
      assert.strictEqual(getMimeType('icon.svg'), 'image/svg+xml');
      assert.strictEqual(getMimeType('unknown.custom'), 'application/octet-stream');
      assert.ok(MIME_TYPES['.html']);
    });
  });

  describe('Path Traversal Security Guards', () => {
    test('rejects relative path traversal with ../ returning HTTP 404', async () => {
      const res = await makeRequest('/../package.json');
      assert.ok([403, 404].includes(res.statusCode));
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects URL-encoded traversal ..%2f returning HTTP 404', async () => {
      const res = await makeRequest('/..%2fpackage.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects URL-encoded traversal %2e%2e/ returning HTTP 404', async () => {
      const res = await makeRequest('/%2e%2e/package.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects double URL-encoded traversal %252e%252e%252f returning HTTP 404', async () => {
      const res = await makeRequest('/%252e%252e%252fpackage.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects nested directory traversal /sub/../../package.json returning HTTP 404', async () => {
      const res = await makeRequest('/sub/../../package.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects backslash directory traversal ..\\ returning HTTP 404', async () => {
      const res = await makeRequest('/..\\package.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects encoded backslash traversal ..%5c returning HTTP 404', async () => {
      const res = await makeRequest('/..%5cpackage.json');
      assert.strictEqual(res.statusCode, 404);
      assert.ok(!res.body.includes('name'));
    });

    test('rejects null byte injection returning HTTP 404', async () => {
      const res = await makeRequest('/index.html%00.txt');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe('Non-Existent Files Handling', () => {
    test('returns standard HTTP 404 for missing static files', async () => {
      const res = await makeRequest('/non-existent-file-404.html');
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, '404 Not Found');
    });

    test('returns HTTP 404 for missing nested files', async () => {
      const res = await makeRequest('/sub/missing.js');
      assert.strictEqual(res.statusCode, 404);
    });

    test('returns HTTP 404 when requested path is a directory without index.html', async () => {
      const res = await makeRequest('/sub/');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe('Router Integration', () => {
    test('integrates with Router as a wildcard handler or custom 404 handler', async () => {
      const router = createRouter();
      const staticHandler = createStaticHandler({ publicDir: tempDir });

      router.get('/api/health', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });

      router.setNotFoundHandler((req, res) => {
        return staticHandler(req, res);
      });

      const integrationServer = http.createServer((req, res) => router.handle(req, res));
      await new Promise(resolve => integrationServer.listen(0, '127.0.0.1', resolve));
      const port = integrationServer.address().port;
      const testUrl = `http://127.0.0.1:${port}`;

      try {
        // API route handled by router
        const apiRes = await new Promise(resolve => {
          http.get(`${testUrl}/api/health`, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8')
            }));
          });
        });
        assert.strictEqual(apiRes.statusCode, 200);
        assert.deepStrictEqual(JSON.parse(apiRes.body), { ok: true });

        // Static file handled via notFoundHandler fallback
        const staticRes = await new Promise(resolve => {
          http.get(`${testUrl}/app.js`, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8')
            }));
          });
        });
        assert.strictEqual(staticRes.statusCode, 200);
        assert.strictEqual(staticRes.body, 'console.log("agentpipe");');

        // Missing file handled cleanly
        const missingRes = await new Promise(resolve => {
          http.get(`${testUrl}/not-found.xyz`, res => {
            resolve({ statusCode: res.statusCode });
          });
        });
        assert.strictEqual(missingRes.statusCode, 404);
      } finally {
        integrationServer.closeAllConnections?.();
        integrationServer.close();
      }
    });
  });
});
