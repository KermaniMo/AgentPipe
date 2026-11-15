import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createRouter } from '../src/router.js';
import { RequestStore } from '../src/store.js';
import {
  registerAgentRoutes,
  createAgentController,
  createChatCompletionsHandler,
  handleModels
} from '../src/controllers/agent.controller.js';

describe('Agent Controller: Model Discovery and Chat Interception Flow', () => {
  let server;
  let baseUrl;
  let router;
  let store;

  function makeRequest(path, options = {}, body = null) {
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
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyStr,
            json: () => {
              try {
                return JSON.parse(bodyStr);
              } catch {
                return null;
              }
            }
          });
        });
      });

      req.on('error', reject);

      if (body) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          req.write(body);
        } else {
          req.write(JSON.stringify(body));
        }
      }
      req.end();
    });
  }

  before(async () => {
    store = new RequestStore();
    router = createRouter();
    registerAgentRoutes(router, store);

    server = http.createServer((req, res) => router.handle(req, res));

    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    store.clear();
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('GET /v1/models and GET /models return valid OpenAI model list', async () => {
    for (const path of ['/v1/models', '/models']) {
      const res = await makeRequest(path);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');

      const data = res.json();
      assert.ok(data, 'response should be valid JSON');
      assert.strictEqual(data.object, 'list');
      assert.ok(Array.isArray(data.data), 'data should be an array');
      assert.strictEqual(data.data.length, 1);
      assert.strictEqual(data.data[0].id, 'agent-relay');
      assert.strictEqual(data.data[0].object, 'model');
    }
  });

  test('POST /v1/chat/completions and POST /chat/completions intercept chat completions, extract messages & tools, create InterceptedRequest, and register in RequestStore', async () => {
    for (const endpoint of ['/v1/chat/completions', '/chat/completions']) {
      const sampleMessages = [
        { role: 'system', content: 'You are a helpful coding assistant.' },
        { role: 'user', content: 'Refactor this module' }
      ];
      const sampleTools = [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file'
          }
        }
      ];

      const addedPromise = new Promise(resolve => {
        store.once('request:added', resolve);
      });

      // Send the request without waiting for it to finish because connection is held open
      const url = new URL(endpoint, baseUrl);
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      req.on('error', () => {}); // Ignore expected client abort/hangup on teardown

      req.write(JSON.stringify({
        model: 'gpt-4',
        messages: sampleMessages,
        tools: sampleTools
      }));
      req.end();

      const interceptedReq = await addedPromise;

      assert.ok(interceptedReq, 'InterceptedRequest should be emitted and registered');
      assert.ok(interceptedReq.id.startsWith('req_'), 'id should start with req_');
      assert.strictEqual(interceptedReq.status, 'PENDING');
      assert.deepStrictEqual(interceptedReq.messages, sampleMessages);
      assert.deepStrictEqual(interceptedReq.tools, sampleTools);
      assert.strictEqual(store.getRequest(interceptedReq.id), interceptedReq);

      // Clean up client request
      req.destroy();
    }
  });

  test('Connection is held open indefinitely without sending headers or calling res.end()', async () => {
    let responseReceived = false;
    let headersReceived = false;

    const addedPromise = new Promise(resolve => {
      store.once('request:added', resolve);
    });

    const url = new URL('/v1/chat/completions', baseUrl);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    req.on('error', () => {});
    req.on('response', () => {
      headersReceived = true;
    });

    req.write(JSON.stringify({
      messages: [{ role: 'user', content: 'Hold this indefinitely' }]
    }));
    req.end();

    const interceptedReq = await addedPromise;

    // Verify immediately
    assert.strictEqual(interceptedReq.res.headersSent, false, 'headers should not be sent immediately');
    assert.strictEqual(interceptedReq.res.writableEnded, false, 'writableEnded should be false');
    assert.strictEqual(interceptedReq.status, 'PENDING');

    // Wait 150ms to verify it is held open over time and no response headers are sent
    await new Promise(resolve => setTimeout(resolve, 150));

    assert.strictEqual(headersReceived, false, 'client should not have received any response headers');
    assert.strictEqual(interceptedReq.res.headersSent, false, 'headers should still not be sent after delay');
    assert.strictEqual(interceptedReq.res.writableEnded, false, 'writableEnded should still be false after delay');
    assert.strictEqual(interceptedReq.status, 'PENDING', 'status should remain PENDING');
    assert.strictEqual(store.getRequest(interceptedReq.id), interceptedReq, 'request should remain in store');

    req.destroy();
  });

  test('Client disconnect transitions request to ABORTED and cleans up', async () => {
    const addedPromise = new Promise(resolve => {
      store.once('request:added', resolve);
    });

    const url = new URL('/v1/chat/completions', baseUrl);
    const clientReq = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    clientReq.on('error', () => {});

    clientReq.write(JSON.stringify({
      messages: [{ role: 'user', content: 'Client will disconnect soon' }]
    }));
    clientReq.end();

    const interceptedReq = await addedPromise;
    assert.strictEqual(interceptedReq.status, 'PENDING');

    const abortedPromise = new Promise(resolve => {
      const listener = (req, data) => {
        if (req.id === interceptedReq.id) {
          store.removeListener('request:aborted', listener);
          resolve({ req, data });
        }
      };
      store.on('request:aborted', listener);
    });

    // Simulate Agent Client aborting the connection
    clientReq.destroy();

    const abortedEvent = await abortedPromise;
    assert.ok(abortedEvent, 'store should emit request:aborted event for this request');
    assert.strictEqual(abortedEvent.req.id, interceptedReq.id);
    assert.strictEqual(interceptedReq.status, 'ABORTED');

    // Verify cleaned up: not present in getAllPending()
    const pendingList = store.getAllPending();
    const isStillPending = pendingList.some(r => r.id === interceptedReq.id);
    assert.strictEqual(isStillPending, false, 'aborted request must not appear in getAllPending()');
  });

  test('Client disconnect via req.emit(\'close\') transitions request to ABORTED and cleans up', async () => {
    const addedPromise = new Promise(resolve => {
      store.once('request:added', resolve);
    });

    const url = new URL('/v1/chat/completions', baseUrl);
    const clientReq = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    clientReq.on('error', () => {});

    clientReq.write(JSON.stringify({
      messages: [{ role: 'user', content: 'req.emit close test' }]
    }));
    clientReq.end();

    const interceptedReq = await addedPromise;
    assert.strictEqual(interceptedReq.status, 'PENDING');

    const abortedPromise = new Promise(resolve => {
      const listener = (req, data) => {
        if (req.id === interceptedReq.id) {
          store.removeListener('request:aborted', listener);
          resolve({ req, data });
        }
      };
      store.on('request:aborted', listener);
    });

    // Explicit req.emit('close')
    interceptedReq.req.emit('close');

    const abortedEvent = await abortedPromise;
    assert.strictEqual(abortedEvent.req.id, interceptedReq.id);
    assert.strictEqual(interceptedReq.status, 'ABORTED');

    clientReq.destroy();
  });

  test('Handles malformed JSON body appropriately with HTTP 400', async () => {
    const initialPendingCount = store.getAllPending().length;

    for (const endpoint of ['/v1/chat/completions', '/chat/completions']) {
      const res = await makeRequest(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        '{ "messages": [ { invalid json ... '
      );

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');

      const data = res.json();
      assert.ok(data, 'response should be JSON');
      assert.ok(data.error, 'response should include error message');
      assert.ok(data.error.includes('Invalid JSON') || data.error.includes('JSON'), 'error message should describe JSON issue');
    }

    // Ensure store was not modified
    assert.strictEqual(store.getAllPending().length, initialPendingCount, 'no requests should be added to store');
  });

  test('createAgentController exposes controller interface and handlers', async () => {
    const localStore = new RequestStore();
    const controller = createAgentController(localStore);

    assert.strictEqual(typeof controller.handleModels, 'function');
    assert.strictEqual(typeof controller.handleChatCompletions, 'function');
    assert.strictEqual(typeof controller.registerRoutes, 'function');

    const testRouter = createRouter();
    const returnedRouter = controller.registerRoutes(testRouter);
    assert.strictEqual(returnedRouter, testRouter);
  });

  test('Standalone handleChatCompletions rejects non-object or malformed body with HTTP 400', async () => {
    const localStore = new RequestStore();
    const handler = createChatCompletionsHandler(localStore);

    let writtenStatus = null;
    let writtenHeaders = null;
    let writtenData = '';

    const mockRes = {
      headersSent: false,
      writeHead(status, headers) {
        writtenStatus = status;
        writtenHeaders = headers;
      },
      end(data) {
        writtenData = data;
      }
    };

    // Body is a primitive string instead of an object
    const mockReq = {
      body: 'not-an-object'
    };

    await handler(mockReq, mockRes);

    assert.strictEqual(writtenStatus, 400);
    assert.strictEqual(writtenHeaders['Content-Type'], 'application/json');
    const json = JSON.parse(writtenData);
    assert.ok(json.error.includes('Expected an object'));
    assert.strictEqual(localStore.size, 0);
  });
});
