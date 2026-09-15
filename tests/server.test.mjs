import { test, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { server, PORT } from '../src/server.js';
import store from '../src/store.js';

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${PORT}${path}`,
      { method, headers },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

after(() => {
  server.close();
});

test('CORS: Universal headers applied to GET request', async () => {
  const res = await makeRequest('GET', '/v1/models');
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
  assert.strictEqual(res.headers['access-control-allow-headers'], '*');
});

test('OPTIONS: Immediate HTTP 204 No Content for preflight', async () => {
  const res = await makeRequest('OPTIONS', '/v1/chat/completions');
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
  assert.strictEqual(res.headers['access-control-allow-headers'], '*');
  assert.strictEqual(res.body, '');
});

test('Path Normalization: GET /v1/models returns dummy model JSON', async () => {
  const res = await makeRequest('GET', '/v1/models');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'application/json');
  const json = JSON.parse(res.body);
  assert.deepStrictEqual(json, {
    object: 'list',
    data: [{ id: 'agent-relay', object: 'model' }]
  });
});

test('Path Normalization: GET /models returns dummy model JSON', async () => {
  const res = await makeRequest('GET', '/models');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'application/json');
  const json = JSON.parse(res.body);
  assert.deepStrictEqual(json, {
    object: 'list',
    data: [{ id: 'agent-relay', object: 'model' }]
  });
});

test('Path Normalization: handles trailing slashes and query strings', async () => {
  const resSlash = await makeRequest('GET', '/models/');
  assert.strictEqual(resSlash.statusCode, 200);
  const jsonSlash = JSON.parse(resSlash.body);
  assert.strictEqual(jsonSlash.data[0].id, 'agent-relay');

  const resV1Slash = await makeRequest('GET', '/v1/models/');
  assert.strictEqual(resV1Slash.statusCode, 200);

  const resQuery = await makeRequest('GET', '/models?agent=roo-code');
  assert.strictEqual(resQuery.statusCode, 200);
  const jsonQuery = JSON.parse(resQuery.body);
  assert.strictEqual(jsonQuery.data[0].id, 'agent-relay');
});

test('Chat Completions: Intercepts POST on /chat/completions and stores request', async () => {
  const initialPendingCount = store.getAllPending().length;

  const req = http.request(
    `http://127.0.0.1:${PORT}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }
  );

  req.on('error', () => {});
  req.write(JSON.stringify({ messages: [{ role: 'user', content: 'Test prompt' }] }));
  req.end();

  // Wait briefly for server to process and store request
  await new Promise(r => setTimeout(r, 50));

  const pending = store.getAllPending();
  assert.strictEqual(pending.length, initialPendingCount + 1);
  const intercepted = pending[pending.length - 1];

  // Resolve via /api/resolve
  await makeRequest('POST', '/api/resolve', {
    id: intercepted.id,
    payload: { content: 'Resolved response' }
  }, { 'Content-Type': 'application/json' });
});

test('Guaranteed Catch-All: Returns HTTP 404 for unhandled routes immediately', async () => {
  const resUnknownGet = await makeRequest('GET', '/unknown/route');
  assert.strictEqual(resUnknownGet.statusCode, 404);

  const resUnknownPost = await makeRequest('POST', '/v1/unknown', { hello: 'world' }, { 'Content-Type': 'application/json' });
  assert.strictEqual(resUnknownPost.statusCode, 404);
  const json = JSON.parse(resUnknownPost.body);
  assert.deepStrictEqual(json, { error: '404 Not Found' });
});
