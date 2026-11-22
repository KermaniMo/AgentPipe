import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Subject under test
import { createAgentPipeServer, server as exportedServer, getServer, PORT as EXPORTED_PORT } from '../src/server.js';
import { RequestStore } from '../src/store.js';
import { resolvePort, start as cliStart, DEFAULT_PORT } from '../src/cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Helper to make HTTP requests against a test server base URL.
 */
function request(baseUrl, { method = 'GET', path: reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;

    if (body !== null && body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const rawBody = rawBuffer.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(rawBody);
        } catch {
          // not JSON
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawBody,
          json,
          buffer: rawBuffer
        });
      });
    });

    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

describe('Server Factory Assembly and CLI Lifecycle', () => {

  describe('Zero Side Effects on Import', () => {
    test('Importing src/server.js does not bind port or call listen', async () => {
      // The exportedServer must not be actively listening upon import
      assert.strictEqual(exportedServer.listening, false, 'Server should not be listening on module import');
      assert.strictEqual(exportedServer.address(), null, 'Server address should be null when not listening');
    });

    test('getServer returns lazily instantiated server instance without side effects', () => {
      const serverInstance = getServer();
      assert.ok(serverInstance instanceof http.Server);
      assert.strictEqual(serverInstance.listening, false);
      assert.strictEqual(serverInstance.address(), null);
    });

    test('Default port is not bound by importing server.js', async () => {
      // Attempt to connect to port 4747; it should fail or not be bound by this module
      await new Promise((resolve) => {
        const socket = net.createConnection({ port: EXPORTED_PORT, host: '127.0.0.1' });
        socket.on('connect', () => {
          socket.destroy();
          // If something is listening on 4747, verify it's not exportedServer
          assert.strictEqual(exportedServer.listening, false);
          resolve();
        });
        socket.on('error', (err) => {
          assert.strictEqual(err.code, 'ECONNREFUSED');
          resolve();
        });
      });
    });
  });

  describe('createAgentPipeServer Factory', () => {
    test('returns an unlistened http.Server instance', () => {
      const customStore = new RequestStore();
      const testServer = createAgentPipeServer({ store: customStore });

      assert.ok(testServer instanceof http.Server, 'Should return an instance of http.Server');
      assert.strictEqual(testServer.listening, false, 'Factory server must not be listening upon creation');
      assert.strictEqual(testServer.address(), null, 'Server address must be null before listen()');

      // Teardown
      testServer.close();
    });

    test('binds cleanly to ephemeral port 0 and serves requests', async () => {
      const customStore = new RequestStore();
      const testServer = createAgentPipeServer({ store: customStore });

      await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
      const port = testServer.address().port;
      assert.ok(port > 0, 'Should have bound to a valid ephemeral port');

      const res = await request(`http://127.0.0.1:${port}`, { path: '/v1/models' });
      assert.strictEqual(res.statusCode, 200);

      await new Promise((resolve) => testServer.close(resolve));
    });
  });

  describe('Route Wiring through Server Seam', () => {
    let testServer;
    let customStore;
    let baseUrl;
    let tempDir;

    before(async () => {
      // Create temporary public directory for static asset tests
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpipe-server-test-'));
      fs.writeFileSync(path.join(tempDir, 'index.html'), '<!DOCTYPE html><html><body>AgentPipe Dashboard</body></html>', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'app.js'), 'console.log("agentpipe");', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'style.css'), 'body { background: #000; }', 'utf8');

      customStore = new RequestStore();
      testServer = createAgentPipeServer({
        store: customStore,
        publicDir: tempDir
      });

      await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
      if (testServer && testServer.listening) {
        await new Promise((resolve) => testServer.close(resolve));
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // cleanup
      }
    });

    test('GET /v1/models and GET /models return OpenAI model list with CORS headers', async () => {
      for (const route of ['/v1/models', '/models']) {
        const res = await request(baseUrl, { path: route });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['access-control-allow-origin'], '*');
        assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
        assert.strictEqual(res.headers['content-type'], 'application/json');
        assert.deepStrictEqual(res.json, {
          object: 'list',
          data: [{ id: 'agent-relay', object: 'model' }]
        });
      }
    });

    test('OPTIONS /v1/chat/completions returns 204 No Content with CORS headers', async () => {
      const res = await request(baseUrl, { method: 'OPTIONS', path: '/v1/chat/completions' });
      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
    });

    test('POST /v1/chat/completions intercepts request, holds open, and wires to store', async () => {
      const initialCount = customStore.getAllPending().length;

      // Start agent request without waiting for end (Indefinite Hold)
      const url = new URL('/v1/chat/completions', baseUrl);
      const agentReq = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      agentReq.write(JSON.stringify({
        messages: [{ role: 'user', content: 'Create a fibonacci function' }],
        tools: [{ type: 'function', function: { name: 'test' } }]
      }));
      agentReq.end();

      // Wait briefly for server to intercept and store
      await new Promise((r) => setTimeout(r, 60));

      const pending = customStore.getAllPending();
      assert.strictEqual(pending.length, initialCount + 1);
      const intercepted = pending[pending.length - 1];
      assert.ok(intercepted.id.startsWith('req_'));
      assert.strictEqual(intercepted.messages[0].content, 'Create a fibonacci function');

      // Resolve the held request via POST /api/resolve
      const resolveRes = await request(baseUrl, {
        method: 'POST',
        path: '/api/resolve',
        body: {
          id: intercepted.id,
          payload: { content: 'function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }' }
        }
      });
      assert.strictEqual(resolveRes.statusCode, 200);
      assert.strictEqual(resolveRes.json.success, true);
    });

    test('GET /api/pending returns array of pending requests', async () => {
      const res = await request(baseUrl, { path: '/api/pending' });
      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.json));
    });

    test('GET /api/events establishes SSE stream with current pending list', async () => {
      const url = new URL('/api/events', baseUrl);

      const sseData = await new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'GET' }, (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.headers['content-type'], 'text/event-stream');
          assert.strictEqual(res.headers['cache-control'], 'no-cache');

          res.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            if (text.startsWith('data: ')) {
              req.destroy();
              resolve(text);
            }
          });
        });
        req.on('error', (err) => {
          // If destroyed manually, ignore ECONNRESET
          if (err.code !== 'ECONNRESET') reject(err);
        });
        req.end();
      });

      assert.ok(sseData.startsWith('data: ['));
    });

    test('POST /api/cancel cancels intercepted request and emits stop chunk', async () => {
      // Create pending request
      const url = new URL('/chat/completions', baseUrl);
      let agentResponseData = '';

      const agentReceived = new Promise((resolve) => {
        const agentReq = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          res.on('data', (chunk) => {
            agentResponseData += chunk.toString('utf8');
          });
          res.on('end', () => resolve(agentResponseData));
        });

        agentReq.write(JSON.stringify({
          messages: [{ role: 'user', content: 'Task to cancel' }]
        }));
        agentReq.end();
      });

      await new Promise((r) => setTimeout(r, 60));
      const pending = customStore.getAllPending();
      const target = pending.find((p) => p.messages?.[0]?.content === 'Task to cancel');
      assert.ok(target, 'Request should be in pending store');

      // Cancel via POST /api/cancel
      const cancelRes = await request(baseUrl, {
        method: 'POST',
        path: '/api/cancel',
        body: { id: target.id, reason: 'Operator aborted task' }
      });
      assert.strictEqual(cancelRes.statusCode, 200);
      assert.strictEqual(cancelRes.json.success, true);

      // Verify agent received cancellation chunk
      const agentOutput = await agentReceived;
      assert.ok(agentOutput.includes('chat.completion.chunk'));
      assert.ok(agentOutput.includes('Operator aborted task'));
      assert.ok(agentOutput.includes('data: [DONE]'));
    });

    test('Static file serving: GET / and /index.html serve HTML', async () => {
      const resRoot = await request(baseUrl, { path: '/' });
      assert.strictEqual(resRoot.statusCode, 200);
      assert.strictEqual(resRoot.headers['content-type'], 'text/html');
      assert.ok(resRoot.body.includes('AgentPipe Dashboard'));

      const resIndex = await request(baseUrl, { path: '/index.html' });
      assert.strictEqual(resIndex.statusCode, 200);
      assert.strictEqual(resIndex.headers['content-type'], 'text/html');
    });

    test('Static file serving: GET /app.js and /style.css serve correct MIME types', async () => {
      const resJs = await request(baseUrl, { path: '/app.js' });
      assert.strictEqual(resJs.statusCode, 200);
      assert.strictEqual(resJs.headers['content-type'], 'application/javascript');
      assert.ok(resJs.body.includes('agentpipe'));

      const resCss = await request(baseUrl, { path: '/style.css' });
      assert.strictEqual(resCss.statusCode, 200);
      assert.strictEqual(resCss.headers['content-type'], 'text/css');
    });

    test('Static file serving: HEAD /index.html returns 200 with headers but empty body', async () => {
      const res = await request(baseUrl, { method: 'HEAD', path: '/index.html' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html');
      assert.strictEqual(res.body, '');
    });

    test('Path Traversal Guard: returns 404 for traversal attempts', async () => {
      const res1 = await request(baseUrl, { path: '/../../package.json' });
      assert.strictEqual(res1.statusCode, 404);

      const res2 = await request(baseUrl, { path: '/..%2fpackage.json' });
      assert.strictEqual(res2.statusCode, 404);
    });

    test('Catch-All 404: Unhandled routes return standard 404 JSON', async () => {
      const resApi = await request(baseUrl, { path: '/api/unknown-endpoint' });
      assert.strictEqual(resApi.statusCode, 404);
      assert.deepStrictEqual(resApi.json, { error: '404 Not Found' });

      const resPost = await request(baseUrl, {
        method: 'POST',
        path: '/v1/unknown',
        body: { test: true }
      });
      assert.strictEqual(resPost.statusCode, 404);
      assert.deepStrictEqual(resPost.json, { error: '404 Not Found' });

      const resStatic404 = await request(baseUrl, { path: '/missing-file.html' });
      assert.strictEqual(resStatic404.statusCode, 404);
      assert.deepStrictEqual(resStatic404.json, { error: '404 Not Found' });
    });
  });

  describe('Clean Teardown and Resource Draining', () => {
    test('Server teardown drains and closes controllers and listeners cleanly', async () => {
      const isolatedStore = new RequestStore();
      const serverInstance = createAgentPipeServer({ store: isolatedStore });

      // Before listening, dashboardController is registered to store events
      assert.ok(isolatedStore.listenerCount('request:added') > 0, 'Store should have attached listeners');

      await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
      const port = serverInstance.address().port;
      const url = `http://127.0.0.1:${port}`;

      // Connect an SSE client
      const sseClientReq = http.request(`${url}/api/events`, (res) => {
        res.on('data', () => {});
      });
      sseClientReq.end();

      // Wait for SSE subscriber to be registered
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(serverInstance.dashboardController.subscriberCount, 1);

      // Close server and verify teardown
      await new Promise((resolve) => serverInstance.close(resolve));

      // After teardown, store listeners must be detached
      assert.strictEqual(isolatedStore.listenerCount('request:added'), 0, 'Store listeners must be cleanly detached');
      assert.strictEqual(isolatedStore.listenerCount('request:resolved'), 0);
      assert.strictEqual(isolatedStore.listenerCount('request:canceled'), 0);
      assert.strictEqual(isolatedStore.listenerCount('request:aborted'), 0);

      // SSE subscribers must be drained
      assert.strictEqual(serverInstance.dashboardController.subscriberCount, 0, 'Subscribers must be cleared');
    });
  });

  describe('Port Resolution Logic in CLI', () => {
    test('resolves port from --port CLI flag', () => {
      assert.strictEqual(resolvePort(['start', '--port', '8080']), 8080);
      assert.strictEqual(resolvePort(['--port', '9090', 'start']), 9090);
      assert.strictEqual(resolvePort(['start', '--port=3000']), 3000);
    });

    test('resolves port from -p CLI flag', () => {
      assert.strictEqual(resolvePort(['start', '-p', '8081']), 8081);
      assert.strictEqual(resolvePort(['-p=3001', 'start']), 3001);
    });

    test('resolves port from PORT environment variable when CLI flag is absent', () => {
      assert.strictEqual(resolvePort(['start'], { PORT: '5000' }), 5000);
      assert.strictEqual(resolvePort([], { PORT: '6000' }), 6000);
    });

    test('CLI flag takes precedence over PORT environment variable', () => {
      assert.strictEqual(resolvePort(['start', '--port', '8080'], { PORT: '5000' }), 8080);
      assert.strictEqual(resolvePort(['-p=3000'], { PORT: '5000' }), 3000);
    });

    test('falls back to DEFAULT_PORT (4747) when no flag or env var is provided', () => {
      assert.strictEqual(DEFAULT_PORT, 4747);
      assert.strictEqual(resolvePort([]), 4747);
      assert.strictEqual(resolvePort(['start']), 4747);
      assert.strictEqual(resolvePort(['start'], {}), 4747);
    });

    test('falls back to default 4747 when port value is invalid or out of range', () => {
      assert.strictEqual(resolvePort(['--port', 'invalid']), 4747);
      assert.strictEqual(resolvePort(['--port', '-1']), 4747);
      assert.strictEqual(resolvePort(['--port', '999999']), 4747);
      assert.strictEqual(resolvePort([], { PORT: 'not-a-number' }), 4747);
    });
  });

  describe('CLI Lifecycle', () => {
    test('cliStart starts server on resolved port and returns listening server', async () => {
      const testStore = new RequestStore();
      const server = await cliStart({
        port: 0, // ephemeral port for test
        host: '127.0.0.1',
        open: false,
        store: testStore
      });

      assert.ok(server.listening, 'Server should be listening after cliStart');
      const port = server.address().port;
      assert.ok(port > 0);

      // Verify health/discovery through the server
      const res = await request(`http://127.0.0.1:${port}`, { path: '/v1/models' });
      assert.strictEqual(res.statusCode, 200);

      await new Promise((resolve) => server.close(resolve));
    });
  });

});
