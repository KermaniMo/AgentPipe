import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createAgentPipeServer } from '../src/server.js';
import { RequestStore } from '../src/store.js';

/**
 * Helper to execute standard HTTP requests against the test server instance.
 */
function makeRequest(baseUrl, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
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
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // non-JSON response
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
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

/**
 * Helper to initiate a chat completion request, returning handle for indefinite hold inspection
 * and a promise resolving once the SSE response stream completes.
 */
function openChatCompletion(baseUrl, path, body = {}) {
  const url = new URL(path, baseUrl);
  const payload = JSON.stringify(body);
  let req;
  const chunks = [];
  let headers = null;
  let statusCode = null;

  const responsePromise = new Promise((resolve, reject) => {
    req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        statusCode = res.statusCode;
        headers = res.headers;
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode,
            headers,
            body: rawText,
            getParsedChunks() {
              const lines = rawText.split('\n\n').map((l) => l.trim()).filter(Boolean);
              return lines.map((line) => {
                if (line === 'data: [DONE]') return { done: true };
                if (line.startsWith('data: ')) {
                  try {
                    return JSON.parse(line.slice(6));
                  } catch {
                    return line.slice(6);
                  }
                }
                return line;
              });
            }
          });
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  return {
    req,
    responsePromise,
    getStatusCode: () => statusCode,
    getHeaders: () => headers
  };
}

describe('Integration Test Suite (Single Highest Seam: createAgentPipeServer)', () => {
  let app;
  let baseUrl;
  let store;

  before(async () => {
    store = new RequestStore();
    app = createAgentPipeServer({ store });
    await new Promise((resolve) => {
      app.listen(0, '127.0.0.1', resolve);
    });
    const port = app.address().port;
    assert.ok(port > 0, 'Server must bind to an ephemeral port > 0');
    assert.notStrictEqual(port, 4747, 'Ephemeral port must be assigned by OS, not default 4747');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (app && app.listening) {
      await new Promise((resolve) => {
        app.close(resolve);
      });
    }
  });

  describe('CORS Headers & OPTIONS Preflight across Endpoints', () => {
    test('Universal CORS headers applied to GET requests', async () => {
      const res = await makeRequest(baseUrl, 'GET', '/v1/models');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    test('Universal CORS headers applied to GET /api/pending', async () => {
      const res = await makeRequest(baseUrl, 'GET', '/api/pending');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
    });

    test('Universal CORS headers applied to error/404 responses', async () => {
      const res = await makeRequest(baseUrl, 'GET', '/unknown/route');
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    const preflightEndpoints = [
      '/v1/chat/completions',
      '/chat/completions',
      '/v1/models',
      '/models',
      '/api/events',
      '/api/pending',
      '/api/resolve',
      '/api/cancel'
    ];

    for (const endpoint of preflightEndpoints) {
      test(`OPTIONS ${endpoint} returns HTTP 204 No Content with CORS headers and empty body`, async () => {
        const res = await makeRequest(baseUrl, 'OPTIONS', endpoint);
        assert.strictEqual(res.statusCode, 204, `Preflight for ${endpoint} should be 204`);
        assert.strictEqual(res.headers['access-control-allow-origin'], '*');
        assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
        assert.strictEqual(res.headers['access-control-allow-headers'], '*');
        assert.strictEqual(res.body, '');
      });
    }
  });

  describe('Model Discovery (GET /v1/models & GET /models)', () => {
    test('GET /v1/models returns OpenAI model list JSON', async () => {
      const res = await makeRequest(baseUrl, 'GET', '/v1/models');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.deepStrictEqual(res.json, {
        object: 'list',
        data: [{ id: 'agent-relay', object: 'model' }]
      });
    });

    test('GET /models alias returns OpenAI model list JSON', async () => {
      const res = await makeRequest(baseUrl, 'GET', '/models');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.deepStrictEqual(res.json, {
        object: 'list',
        data: [{ id: 'agent-relay', object: 'model' }]
      });
    });

    test('Path Normalization: handles trailing slashes and query strings', async () => {
      const resSlash = await makeRequest(baseUrl, 'GET', '/models/');
      assert.strictEqual(resSlash.statusCode, 200);
      assert.strictEqual(resSlash.json.data[0].id, 'agent-relay');

      const resV1Slash = await makeRequest(baseUrl, 'GET', '/v1/models/');
      assert.strictEqual(resV1Slash.statusCode, 200);
      assert.strictEqual(resV1Slash.json.data[0].id, 'agent-relay');

      const resQuery = await makeRequest(baseUrl, 'GET', '/models?agent=cline&version=2');
      assert.strictEqual(resQuery.statusCode, 200);
      assert.strictEqual(resQuery.json.data[0].id, 'agent-relay');
    });
  });

  describe('Chat Completion Interception and Indefinite Holding', () => {
    test('POST /v1/chat/completions intercepts request and holds connection open indefinitely', async () => {
      const initialCount = store.getAllPending().length;

      const chat = openChatCompletion(baseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'What is the speed of light?' }],
        model: 'agent-relay'
      });

      // Indefinite hold verification: wait 100ms and verify no response headers sent yet
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(chat.getStatusCode(), null, 'Headers must not be sent while held in suspension');

      const pending = store.getAllPending();
      assert.strictEqual(pending.length, initialCount + 1);
      const intercepted = pending[pending.length - 1];
      assert.strictEqual(intercepted.status, 'PENDING');
      assert.deepStrictEqual(intercepted.messages, [{ role: 'user', content: 'What is the speed of light?' }]);

      // Clean up by resolving
      await makeRequest(baseUrl, 'POST', '/api/resolve', {
        id: intercepted.id,
        payload: { content: '299,792,458 m/s' }
      });
      await chat.responsePromise;
    });

    test('POST /chat/completions alias intercepts and holds connection', async () => {
      const initialCount = store.getAllPending().length;

      const chat = openChatCompletion(baseUrl, '/chat/completions', {
        messages: [{ role: 'user', content: 'Alias test prompt' }]
      });

      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(chat.getStatusCode(), null, 'Headers must not be sent during hold');

      const pending = store.getAllPending();
      assert.strictEqual(pending.length, initialCount + 1);
      const intercepted = pending[pending.length - 1];

      // Clean up by resolving
      await makeRequest(baseUrl, 'POST', '/api/resolve', {
        id: intercepted.id,
        payload: { content: 'Alias response' }
      });
      await chat.responsePromise;
    });
  });

  describe('Request Resolution via POST /api/resolve', () => {
    test('Resolves text response and transmits OpenAI SSE chunk structure', async () => {
      const promptContent = 'Explain quantum computing in one sentence.';
      const resolvedAnswer = 'Quantum computing leverages superposition and entanglement to solve specific problems exponentially faster.';

      const chat = openChatCompletion(baseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: promptContent }]
      });

      // Wait for server to store request
      await new Promise((r) => setTimeout(r, 50));
      const pending = store.getAllPending();
      const intercepted = pending.find((p) => p.messages[0]?.content === promptContent);
      assert.ok(intercepted, 'Intercepted request must exist in pending store');

      // Resolve via dashboard API
      const resolveRes = await makeRequest(baseUrl, 'POST', '/api/resolve', {
        id: intercepted.id,
        payload: { content: resolvedAnswer }
      });
      assert.strictEqual(resolveRes.statusCode, 200);
      assert.deepStrictEqual(resolveRes.json, { success: true });

      // Verify Agent Client SSE response
      const clientResult = await chat.responsePromise;
      assert.strictEqual(clientResult.statusCode, 200);
      assert.strictEqual(clientResult.headers['content-type'], 'text/event-stream');

      const chunks = clientResult.getParsedChunks();
      assert.strictEqual(chunks.length, 2, 'Should receive 1 completion chunk followed by [DONE]');

      // Inspect OpenAI chat.completion.chunk
      const completionChunk = chunks[0];
      assert.strictEqual(completionChunk.object, 'chat.completion.chunk');
      assert.strictEqual(typeof completionChunk.id, 'string');
      assert.ok(completionChunk.id.startsWith('chatcmpl-'));
      assert.strictEqual(completionChunk.model, 'agent-pipe');
      assert.strictEqual(typeof completionChunk.created, 'number');
      assert.strictEqual(completionChunk.choices.length, 1);
      assert.strictEqual(completionChunk.choices[0].index, 0);
      assert.strictEqual(completionChunk.choices[0].finish_reason, 'stop');
      assert.strictEqual(completionChunk.choices[0].delta.role, 'assistant');
      assert.strictEqual(completionChunk.choices[0].delta.content, resolvedAnswer);

      // Inspect [DONE] terminator
      assert.strictEqual(chunks[1].done, true);

      // Verify removed from pending store
      assert.strictEqual(store.getRequest(intercepted.id), undefined);
    });

    test('Resolves tool calls response and transmits tool_calls SSE chunk', async () => {
      const chat = openChatCompletion(baseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Run command ls' }]
      });

      await new Promise((r) => setTimeout(r, 50));
      const pending = store.getAllPending();
      const intercepted = pending.find((p) => p.messages[0]?.content === 'Run command ls');
      assert.ok(intercepted);

      // Resolve with tool_calls
      const resolveRes = await makeRequest(baseUrl, 'POST', '/api/resolve', {
        id: intercepted.id,
        payload: {
          tool_calls: [
            {
              id: 'call_test_123',
              function: {
                name: 'execute_command',
                arguments: JSON.stringify({ command: 'ls -la' })
              }
            }
          ]
        }
      });
      assert.strictEqual(resolveRes.statusCode, 200);

      const clientResult = await chat.responsePromise;
      const chunks = clientResult.getParsedChunks();
      assert.strictEqual(chunks.length, 2);

      const toolChunk = chunks[0];
      assert.strictEqual(toolChunk.object, 'chat.completion.chunk');
      assert.strictEqual(toolChunk.choices[0].finish_reason, 'tool_calls');
      assert.strictEqual(toolChunk.choices[0].delta.role, 'assistant');
      assert.strictEqual(toolChunk.choices[0].delta.tool_calls.length, 1);
      assert.strictEqual(toolChunk.choices[0].delta.tool_calls[0].id, 'call_test_123');
      assert.strictEqual(toolChunk.choices[0].delta.tool_calls[0].function.name, 'execute_command');
      assert.strictEqual(toolChunk.choices[0].delta.tool_calls[0].function.arguments, '{"command":"ls -la"}');

      assert.strictEqual(chunks[1].done, true);
    });
  });

  describe('Request Cancellation via POST /api/cancel', () => {
    test('Cancels request with default reason and transmits graceful termination chunk', async () => {
      const chat = openChatCompletion(baseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Task that will be canceled' }]
      });

      await new Promise((r) => setTimeout(r, 50));
      const pending = store.getAllPending();
      const intercepted = pending.find((p) => p.messages[0]?.content === 'Task that will be canceled');
      assert.ok(intercepted);

      // Cancel via dashboard API without explicit reason
      const cancelRes = await makeRequest(baseUrl, 'POST', '/api/cancel', {
        id: intercepted.id
      });
      assert.strictEqual(cancelRes.statusCode, 200);
      assert.deepStrictEqual(cancelRes.json, { success: true, message: 'Request canceled' });

      // Verify Agent Client receives graceful cancellation SSE chunk
      const clientResult = await chat.responsePromise;
      assert.strictEqual(clientResult.statusCode, 200);
      assert.strictEqual(clientResult.headers['content-type'], 'text/event-stream');

      const chunks = clientResult.getParsedChunks();
      assert.strictEqual(chunks.length, 2);

      const cancelChunk = chunks[0];
      assert.strictEqual(cancelChunk.object, 'chat.completion.chunk');
      assert.strictEqual(cancelChunk.choices[0].finish_reason, 'stop');
      assert.strictEqual(cancelChunk.choices[0].delta.content, '\n[Task canceled by user via dashboard]');

      assert.strictEqual(chunks[1].done, true);
      assert.strictEqual(store.getRequest(intercepted.id), undefined);
    });

    test('Cancels request with custom operator reason', async () => {
      const customReason = 'Operator stopped this task because instructions were ambiguous.';
      const chat = openChatCompletion(baseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Ambiguous prompt' }]
      });

      await new Promise((r) => setTimeout(r, 50));
      const pending = store.getAllPending();
      const intercepted = pending.find((p) => p.messages[0]?.content === 'Ambiguous prompt');
      assert.ok(intercepted);

      const cancelRes = await makeRequest(baseUrl, 'POST', '/api/cancel', {
        id: intercepted.id,
        reason: customReason
      });
      assert.strictEqual(cancelRes.statusCode, 200);

      const clientResult = await chat.responsePromise;
      const chunks = clientResult.getParsedChunks();
      assert.strictEqual(chunks[0].choices[0].delta.content, customReason);
      assert.strictEqual(chunks[1].done, true);
    });
  });

  describe('Socket Draining on Test Teardown via closeAllConnections()', () => {
    test('Server closes cleanly and drains open sockets without hangs', async () => {
      const isolatedStore = new RequestStore();
      const isolatedServer = createAgentPipeServer({ store: isolatedStore });

      await new Promise((resolve) => isolatedServer.listen(0, '127.0.0.1', resolve));
      const isolatedPort = isolatedServer.address().port;
      const isolatedBaseUrl = `http://127.0.0.1:${isolatedPort}`;

      // 1. Open an indefinite chat completion request
      const chat = openChatCompletion(isolatedBaseUrl, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Connection to drain' }]
      });

      // 2. Open an SSE event subscriber
      const sseReq = http.request(new URL('/api/events', isolatedBaseUrl));
      sseReq.on('error', () => {});
      sseReq.end();

      // Wait for registration
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(isolatedStore.getAllPending().length, 1);

      // Sockets will encounter disconnect when server destroys/closes connections
      chat.req.on('error', () => {});
      chat.responsePromise.catch(() => {});

      // 3. Close the server (which internally triggers closeAllConnections())
      await new Promise((resolve) => isolatedServer.close(resolve));

      assert.strictEqual(isolatedServer.listening, false);
      assert.strictEqual(isolatedServer.address(), null);
    });
  });

  describe('Guaranteed Catch-All 404 Route', () => {
    test('Returns HTTP 404 JSON for unhandled routes immediately', async () => {
      const resUnknownGet = await makeRequest(baseUrl, 'GET', '/non/existent/path');
      assert.strictEqual(resUnknownGet.statusCode, 404);
      assert.deepStrictEqual(resUnknownGet.json, { error: '404 Not Found' });

      const resUnknownPost = await makeRequest(
        baseUrl,
        'POST',
        '/v1/unknown',
        { hello: 'world' }
      );
      assert.strictEqual(resUnknownPost.statusCode, 404);
      assert.deepStrictEqual(resUnknownPost.json, { error: '404 Not Found' });
    });
  });
});
