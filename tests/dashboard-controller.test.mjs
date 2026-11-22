import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRouter } from '../src/router.js';
import { RequestStore } from '../src/store.js';
import { InterceptedRequest, REQUEST_STATUS } from '../src/models/intercepted-request.js';
import {
  createDashboardController,
  registerDashboardRoutes
} from '../src/controllers/dashboard.controller.js';

describe('Dashboard Controller: SSE Hub and Resolution Controller', () => {
  let server;
  let baseUrl;
  let router;
  let store;
  let controller;

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

      if (body !== null && body !== undefined) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          req.write(body);
        } else {
          req.write(JSON.stringify(body));
        }
      }
      req.end();
    });
  }

  function connectSSE(path = '/api/events') {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream'
        }
      });

      const events = [];
      let buffer = '';
      const listeners = [];

      req.on('response', res => {
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop();
          for (const part of parts) {
            if (part.startsWith('data: ')) {
              const dataStr = part.replace(/^data:\s*/, '').trim();
              events.push(dataStr);
              for (const listener of [...listeners]) {
                listener(dataStr);
              }
            }
          }
        });

        resolve({
          req,
          res,
          statusCode: res.statusCode,
          headers: res.headers,
          events,
          waitForEvent(predicate = () => true, timeout = 2000) {
            return new Promise((resEv, rejEv) => {
              for (const ev of events) {
                if (predicate(ev)) {
                  return resEv(ev);
                }
              }
              const timer = setTimeout(() => {
                rejEv(new Error(`waitForEvent timed out after ${timeout}ms`));
              }, timeout);
              const listener = (ev) => {
                if (predicate(ev)) {
                  clearTimeout(timer);
                  const idx = listeners.indexOf(listener);
                  if (idx !== -1) listeners.splice(idx, 1);
                  resEv(ev);
                }
              };
              listeners.push(listener);
            });
          },
          close() {
            req.destroy();
          }
        });
      });

      req.on('error', err => {
        if (err.code !== 'ECONNRESET' && err.message !== 'socket hang up') {
          reject(err);
        }
      });

      req.end();
    });
  }

  before(async () => {
    store = new RequestStore();
    router = createRouter();
    controller = createDashboardController(store);
    controller.registerRoutes(router);

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
    if (controller && typeof controller.close === 'function') {
      controller.close();
    }
    if (store) {
      store.clear();
    }
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(resolve));
    }
  });

  beforeEach(() => {
    store.clear();
  });

  test('GET /api/events establishes SSE connection, adds to subscriber pool, sends current pending list, and cleans up on disconnect', async () => {
    // Add one request first
    store.addRequest(new InterceptedRequest({
      id: 'req_initial_1',
      messages: [{ role: 'user', content: 'Initial message' }]
    }));

    const client = await connectSSE('/api/events');

    assert.strictEqual(client.statusCode, 200);
    assert.strictEqual(client.headers['content-type'], 'text/event-stream');
    assert.strictEqual(client.headers['cache-control'], 'no-cache');
    assert.strictEqual(client.headers['connection'], 'keep-alive');
    assert.strictEqual(client.headers['access-control-allow-origin'], '*');

    // Verify initial event received
    const initialRaw = await client.waitForEvent(data => data.includes('req_initial_1'));
    const initialList = JSON.parse(initialRaw);
    assert.strictEqual(Array.isArray(initialList), true);
    assert.strictEqual(initialList.length, 1);
    assert.strictEqual(initialList[0].id, 'req_initial_1');

    // Verify subscriber pool count
    assert.strictEqual(controller.subscriberCount, 1);

    // Disconnect client
    client.close();

    // Allow disconnect event to propagate
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(controller.subscriberCount, 0);
  });

  test('Store lifecycle events automatically broadcast updated pending list to all connected SSE clients', async () => {
    const client1 = await connectSSE('/api/events');
    const client2 = await connectSSE('/api/events');

    assert.strictEqual(controller.subscriberCount, 2);

    // Initial event for both should be empty []
    const init1 = await client1.waitForEvent();
    const init2 = await client2.waitForEvent();
    assert.deepStrictEqual(JSON.parse(init1), []);
    assert.deepStrictEqual(JSON.parse(init2), []);

    // 1. Test request:added broadcast
    const mockAgentReq = new EventEmitter();
    const mockAgentRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() {},
      write() {},
      end() { this.writableEnded = true; }
    };

    const addedPromise1 = client1.waitForEvent(data => data.includes('req_add_test'));
    const addedPromise2 = client2.waitForEvent(data => data.includes('req_add_test'));

    const intercepted = new InterceptedRequest({
      id: 'req_add_test',
      req: mockAgentReq,
      res: mockAgentRes,
      messages: [{ role: 'user', content: 'Broadcast test' }]
    });
    store.addRequest(intercepted);

    const [addEv1, addEv2] = await Promise.all([addedPromise1, addedPromise2]);
    const addList1 = JSON.parse(addEv1);
    const addList2 = JSON.parse(addEv2);
    assert.strictEqual(addList1.length, 1);
    assert.strictEqual(addList1[0].id, 'req_add_test');
    assert.deepStrictEqual(addList1, addList2);

    // 2. Test request:resolved broadcast
    const resolvedPromise1 = client1.waitForEvent(data => data === '[]');
    const resolvedPromise2 = client2.waitForEvent(data => data === '[]');

    intercepted.resolve({ content: 'Operator completed' });

    const [resEv1, resEv2] = await Promise.all([resolvedPromise1, resolvedPromise2]);
    assert.deepStrictEqual(JSON.parse(resEv1), []);
    assert.deepStrictEqual(JSON.parse(resEv2), []);

    // 3. Test request:canceled broadcast
    const addedCancelPromise = client1.waitForEvent(data => data.includes('req_cancel_test'));
    const interceptedForCancel = new InterceptedRequest({
      id: 'req_cancel_test',
      res: {
        headersSent: false,
        writableEnded: false,
        writeHead() {},
        write() {},
        end() { this.writableEnded = true; }
      }
    });
    store.addRequest(interceptedForCancel);
    await addedCancelPromise;

    const cancelBroadcastPromise = client1.waitForEvent(data => data === '[]');
    interceptedForCancel.cancel('Operator cancel');
    const cancelEv = await cancelBroadcastPromise;
    assert.deepStrictEqual(JSON.parse(cancelEv), []);

    // 4. Test request:aborted broadcast
    const addedAbortPromise = client1.waitForEvent(data => data.includes('req_abort_test'));
    const mockAbortReq = new EventEmitter();
    const interceptedForAbort = new InterceptedRequest({
      id: 'req_abort_test',
      req: mockAbortReq
    });
    store.addRequest(interceptedForAbort);
    await addedAbortPromise;

    const abortBroadcastPromise = client1.waitForEvent(data => data === '[]');
    mockAbortReq.emit('close');
    const abortEv = await abortBroadcastPromise;
    assert.deepStrictEqual(JSON.parse(abortEv), []);

    client1.close();
    client2.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(controller.subscriberCount, 0);
  });

  test('GET /api/pending returns current array of pending requests with sanitized representation', async () => {
    // Empty pending list
    const resEmpty = await makeRequest('/api/pending');
    assert.strictEqual(resEmpty.statusCode, 200);
    assert.strictEqual(resEmpty.headers['content-type'], 'application/json');
    assert.deepStrictEqual(resEmpty.json(), []);

    // Add pending requests
    const sampleReq = new InterceptedRequest({
      id: 'req_pending_test',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ name: 'get_weather' }],
      createdAt: 123456789
    });
    store.addRequest(sampleReq);

    const resWithItems = await makeRequest('/api/pending');
    assert.strictEqual(resWithItems.statusCode, 200);
    const list = resWithItems.json();
    assert.strictEqual(Array.isArray(list), true);
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0], {
      id: 'req_pending_test',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ name: 'get_weather' }],
      createdAt: 123456789,
      status: REQUEST_STATUS.PENDING
    });
    assert.strictEqual(list[0].req, undefined, 'no socket references should be leaked');
    assert.strictEqual(list[0].res, undefined, 'no socket references should be leaked');
  });

  test('POST /api/resolve resolves InterceptedRequest, transmits Instant Dispatch SSE chunks, and returns success', async () => {
    let writtenHeaders = null;
    let writtenStatus = null;
    const writtenChunks = [];
    let ended = false;

    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers) {
        writtenStatus = status;
        writtenHeaders = headers;
        this.headersSent = true;
      },
      write(chunk) {
        writtenChunks.push(chunk);
      },
      end() {
        ended = true;
        this.writableEnded = true;
      }
    };

    const intercepted = new InterceptedRequest({
      id: 'req_resolve_target',
      res: mockRes,
      messages: [{ role: 'user', content: 'Solve this' }]
    });
    store.addRequest(intercepted);

    const res = await makeRequest(
      '/api/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      {
        id: 'req_resolve_target',
        payload: { content: 'Operator resolution result' }
      }
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/json');
    assert.deepStrictEqual(res.json(), { success: true });

    // Intercepted request must transition to RESOLVED
    assert.strictEqual(intercepted.status, REQUEST_STATUS.RESOLVED);

    // Agent client response must receive Instant Dispatch SSE chunk followed by [DONE]
    assert.strictEqual(writtenStatus, 200);
    assert.strictEqual(writtenHeaders['Content-Type'], 'text/event-stream');
    assert.strictEqual(ended, true);

    const agentStreamText = writtenChunks.join('');
    assert.ok(agentStreamText.includes('data: {'), 'should contain SSE data chunk');
    assert.ok(agentStreamText.includes('chat.completion.chunk'), 'chunk should be chat.completion.chunk');
    assert.ok(agentStreamText.includes('Operator resolution result'), 'chunk should contain resolution content');
    assert.ok(agentStreamText.includes('data: [DONE]\n\n'), 'should end with [DONE]');

    // Request is no longer pending in store
    assert.strictEqual(store.getAllPending().length, 0);
  });

  test('POST /api/resolve supports tool calls payload and transmits tool_calls SSE chunk', async () => {
    const writtenChunks = [];
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(chunk) { writtenChunks.push(chunk); },
      end() { this.writableEnded = true; }
    };

    const intercepted = new InterceptedRequest({
      id: 'req_resolve_tools',
      res: mockRes
    });
    store.addRequest(intercepted);

    const res = await makeRequest(
      '/api/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      {
        id: 'req_resolve_tools',
        payload: {
          tool_calls: [
            {
              function: {
                name: 'fetch_docs',
                arguments: '{"topic":"sse"}'
              }
            }
          ]
        }
      }
    );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { success: true });

    const agentStreamText = writtenChunks.join('');
    assert.ok(agentStreamText.includes('tool_calls'), 'should contain tool_calls');
    assert.ok(agentStreamText.includes('fetch_docs'), 'should contain function name');
    assert.ok(agentStreamText.includes('data: [DONE]\n\n'), 'should end with [DONE]');
  });

  test('POST /api/cancel cancels InterceptedRequest, transmits graceful stop SSE chunk, and returns success', async () => {
    let writtenStatus = null;
    let writtenHeaders = null;
    const writtenChunks = [];
    let ended = false;

    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers) {
        writtenStatus = status;
        writtenHeaders = headers;
        this.headersSent = true;
      },
      write(chunk) {
        writtenChunks.push(chunk);
      },
      end() {
        ended = true;
        this.writableEnded = true;
      }
    };

    const intercepted = new InterceptedRequest({
      id: 'req_cancel_target',
      res: mockRes
    });
    store.addRequest(intercepted);

    const res = await makeRequest(
      '/api/cancel',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      {
        id: 'req_cancel_target',
        reason: 'Stop this immediately'
      }
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/json');
    assert.deepStrictEqual(res.json(), { success: true, message: 'Request canceled' });

    // Request transitions to CANCELED
    assert.strictEqual(intercepted.status, REQUEST_STATUS.CANCELED);

    // Agent receives graceful cancellation SSE chunk
    assert.strictEqual(writtenStatus, 200);
    assert.strictEqual(writtenHeaders['Content-Type'], 'text/event-stream');
    assert.strictEqual(ended, true);

    const streamText = writtenChunks.join('');
    assert.ok(streamText.includes('chat.completion.chunk'));
    assert.ok(streamText.includes('Stop this immediately'));
    assert.ok(streamText.includes('finish_reason":"stop"'));
    assert.ok(streamText.includes('data: [DONE]\n\n'));

    // Request is no longer pending in store
    assert.strictEqual(store.getAllPending().length, 0);
  });

  test('POST /api/cancel with omitted reason uses default cancellation message', async () => {
    const writtenChunks = [];
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(chunk) { writtenChunks.push(chunk); },
      end() { this.writableEnded = true; }
    };

    const intercepted = new InterceptedRequest({
      id: 'req_cancel_default_reason',
      res: mockRes
    });
    store.addRequest(intercepted);

    const res = await makeRequest(
      '/api/cancel',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      {
        id: 'req_cancel_default_reason'
      }
    );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { success: true, message: 'Request canceled' });

    const streamText = writtenChunks.join('');
    assert.ok(streamText.includes('[Task canceled by user via dashboard]'));
  });

  test('POST /api/resolve validation and error handling', async () => {
    // 1. Missing ID returns 400
    const resNoId = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { payload: 'test' }
    );
    assert.strictEqual(resNoId.statusCode, 400);
    assert.ok(resNoId.json().error.includes('id'));

    // 2. Malformed JSON returns 400
    const resMalformed = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      '{ "id": "req_1", malformed... '
    );
    assert.strictEqual(resMalformed.statusCode, 400);
    assert.ok(resMalformed.json().error);

    // 3. Non-existent ID returns 404
    const resNotFound = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'non_existent_req', payload: 'test' }
    );
    assert.strictEqual(resNotFound.statusCode, 404);
    assert.ok(resNotFound.json().error.includes('Request not found or already resolved'));

    // 4. Already resolved request returns 404
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() {},
      write() {},
      end() { this.writableEnded = true; }
    };
    const intercepted = new InterceptedRequest({ id: 'req_double_resolve', res: mockRes });
    store.addRequest(intercepted);

    // First resolve succeeds
    const firstRes = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'req_double_resolve', payload: 'first' }
    );
    assert.strictEqual(firstRes.statusCode, 200);

    // Second resolve returns 404
    const secondRes = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'req_double_resolve', payload: 'second' }
    );
    assert.strictEqual(secondRes.statusCode, 404);
  });

  test('POST /api/cancel validation and error handling', async () => {
    // 1. Missing ID returns 400
    const resNoId = await makeRequest(
      '/api/cancel',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { reason: 'stop' }
    );
    assert.strictEqual(resNoId.statusCode, 400);
    assert.ok(resNoId.json().error.includes('id'));

    // 2. Malformed JSON returns 400
    const resMalformed = await makeRequest(
      '/api/cancel',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      'not a json string'
    );
    assert.strictEqual(resMalformed.statusCode, 400);

    // 3. Non-existent ID returns 404
    const resNotFound = await makeRequest(
      '/api/cancel',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'non_existent_req' }
    );
    assert.strictEqual(resNotFound.statusCode, 404);

    // 4. Cancel on already canceled request returns 404
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() {},
      write() {},
      end() { this.writableEnded = true; }
    };
    const intercepted = new InterceptedRequest({ id: 'req_double_cancel', res: mockRes });
    store.addRequest(intercepted);

    const firstCancel = await makeRequest(
      '/api/cancel',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'req_double_cancel' }
    );
    assert.strictEqual(firstCancel.statusCode, 200);

    const secondCancel = await makeRequest(
      '/api/cancel',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'req_double_cancel' }
    );
    assert.strictEqual(secondCancel.statusCode, 404);

    // 5. Resolve on canceled request returns 404
    const resolveAfterCancel = await makeRequest(
      '/api/resolve',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { id: 'req_double_cancel', payload: 'try resolve' }
    );
    assert.strictEqual(resolveAfterCancel.statusCode, 404);
  });

  test('registerDashboardRoutes helper registers all 4 endpoints on Router', async () => {
    const localStore = new RequestStore();
    const testRouter = createRouter();
    const returnedRouter = registerDashboardRoutes(testRouter, localStore);

    assert.strictEqual(returnedRouter, testRouter);
  });

  test('createDashboardController exposes expected methods and default delegates', () => {
    const localStore = new RequestStore();
    const ctrl = createDashboardController(localStore);

    assert.strictEqual(typeof ctrl.handleEvents, 'function');
    assert.strictEqual(typeof ctrl.handlePending, 'function');
    assert.strictEqual(typeof ctrl.handleResolve, 'function');
    assert.strictEqual(typeof ctrl.handleCancel, 'function');
    assert.strictEqual(typeof ctrl.broadcastPending, 'function');
    assert.strictEqual(typeof ctrl.registerRoutes, 'function');
    assert.strictEqual(typeof ctrl.close, 'function');
    assert.strictEqual(ctrl.subscriberPool instanceof Set, true);
    assert.strictEqual(ctrl.subscriberCount, 0);

    ctrl.close();
  });
});
