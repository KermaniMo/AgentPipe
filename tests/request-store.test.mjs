import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import defaultStore, {
  RequestStore,
  store as singletonStore,
  addRequest,
  getRequest,
  removeRequest,
  getAllPending
} from '../src/store.js';
import { InterceptedRequest, REQUEST_STATUS } from '../src/models/intercepted-request.js';

describe('RequestStore Domain Entity', () => {
  let store;

  beforeEach(() => {
    store = new RequestStore();
  });

  test('extends EventEmitter and can be instantiated independently', () => {
    assert.ok(store instanceof EventEmitter, 'store should be an EventEmitter');
    assert.ok(singletonStore instanceof RequestStore, 'default singleton should be RequestStore');
    assert.ok(defaultStore instanceof RequestStore, 'default export should be RequestStore');
    assert.strictEqual(singletonStore, defaultStore, 'default and singleton named export should match');
  });

  test('addRequest(request): adds InterceptedRequest instance and emits request:added', () => {
    const events = [];
    store.on('request:added', (req) => {
      events.push(req);
    });

    const intercepted = new InterceptedRequest({
      id: 'req_test_1',
      messages: [{ role: 'user', content: 'test prompt' }],
      tools: [{ type: 'function' }]
    });

    const returned = store.addRequest(intercepted);

    assert.strictEqual(returned, intercepted, 'addRequest should return the request instance');
    assert.strictEqual(events.length, 1, 'request:added should be emitted exactly once');
    assert.strictEqual(events[0], intercepted, 'emitted request should match added instance');
    assert.strictEqual(store.getRequest('req_test_1'), intercepted, 'getRequest should retrieve request by id');
  });

  test('addRequest supports positional arguments for backward compatibility', () => {
    const events = [];
    store.on('request:added', (req) => {
      events.push(req);
    });

    const mockReq = new EventEmitter();
    const mockRes = { writeHead: () => {}, write: () => {}, end: () => {} };
    const messages = [{ role: 'user', content: 'hello from agent' }];
    const tools = [{ name: 'read_file' }];

    const returned = store.addRequest('req_positional_1', mockReq, mockRes, messages, tools);

    assert.ok(returned instanceof InterceptedRequest, 'should construct an InterceptedRequest');
    assert.strictEqual(returned.id, 'req_positional_1');
    assert.strictEqual(returned.req, mockReq);
    assert.strictEqual(returned.res, mockRes);
    assert.deepStrictEqual(returned.messages, messages);
    assert.deepStrictEqual(returned.tools, tools);
    assert.strictEqual(returned.status, REQUEST_STATUS.PENDING);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0], returned);
    assert.strictEqual(store.getRequest('req_positional_1'), returned);
  });

  test('addRequest supports plain options object', () => {
    const returned = store.addRequest({
      id: 'req_options_1',
      messages: [{ role: 'user', content: 'options call' }]
    });

    assert.ok(returned instanceof InterceptedRequest);
    assert.strictEqual(returned.id, 'req_options_1');
    assert.deepStrictEqual(returned.messages, [{ role: 'user', content: 'options call' }]);
    assert.strictEqual(store.getRequest('req_options_1'), returned);
  });

  test('removeRequest(id): deletes request and returns boolean', () => {
    const req = new InterceptedRequest({ id: 'req_to_remove' });
    store.addRequest(req);

    assert.strictEqual(store.removeRequest('req_to_remove'), true);
    assert.strictEqual(store.getRequest('req_to_remove'), undefined);
    assert.strictEqual(store.removeRequest('req_to_remove'), false, 'subsequent delete returns false');
    assert.strictEqual(store.removeRequest('non_existent'), false);
  });

  test('removeRequest(id): cleans up listeners so removed requests do not trigger store events', () => {
    const events = [];
    store.on('request:resolved', (e) => events.push(e));

    const req = new InterceptedRequest({
      id: 'req_detached',
      res: { writeHead: () => {}, write: () => {}, end: () => {} }
    });

    store.addRequest(req);
    store.removeRequest('req_detached');

    // Resolving after removal from store
    req.resolve('delayed response');

    assert.strictEqual(events.length, 0, 'no store events should fire for removed requests');
  });

  test('subscribes to lifecycle events and emits request:resolved on store', () => {
    const events = [];
    store.on('request:resolved', (req, data) => {
      events.push({ req, data });
    });

    const mockRes = {
      headersSent: false,
      writeHead: () => {},
      write: () => {},
      end: () => {}
    };

    const req = new InterceptedRequest({ id: 'req_resolve_flow', res: mockRes });
    store.addRequest(req);

    req.resolve('Operator approved text');

    assert.strictEqual(events.length, 1, 'request:resolved should fire once');
    assert.strictEqual(events[0].req.id, 'req_resolve_flow');
    assert.strictEqual(events[0].req.status, REQUEST_STATUS.RESOLVED);
    assert.strictEqual(events[0].req.payload, 'Operator approved text');
  });

  test('subscribes to lifecycle events and emits request:canceled on store', () => {
    const events = [];
    store.on('request:canceled', (req, data) => {
      events.push({ req, data });
    });

    const mockRes = {
      headersSent: false,
      writeHead: () => {},
      write: () => {},
      end: () => {}
    };

    const req = new InterceptedRequest({ id: 'req_cancel_flow', res: mockRes });
    store.addRequest(req);

    req.cancel('Operator declined prompt');

    assert.strictEqual(events.length, 1, 'request:canceled should fire once');
    assert.strictEqual(events[0].req.id, 'req_cancel_flow');
    assert.strictEqual(events[0].req.status, REQUEST_STATUS.CANCELED);
    assert.strictEqual(events[0].req.reason, 'Operator declined prompt');
  });

  test('subscribes to lifecycle events and emits request:aborted when client disconnects', () => {
    const events = [];
    store.on('request:aborted', (req, data) => {
      events.push({ req, data });
    });

    const mockReq = new EventEmitter();
    const req = new InterceptedRequest({ id: 'req_abort_flow', req: mockReq });
    store.addRequest(req);

    // Simulate Agent Client disconnect
    mockReq.emit('close');

    assert.strictEqual(events.length, 1, 'request:aborted should fire once');
    assert.strictEqual(events[0].req.id, 'req_abort_flow');
    assert.strictEqual(events[0].req.status, REQUEST_STATUS.ABORTED);
  });

  test('getAllPending(): returns array of sanitized representations (toJSON) and filters non-pending', () => {
    const mockRes = {
      headersSent: false,
      writeHead: () => {},
      write: () => {},
      end: () => {}
    };

    const req1 = new InterceptedRequest({
      id: 'req_pending_1',
      messages: [{ role: 'user', content: 'first prompt' }],
      tools: [{ name: 'tool_1' }],
      createdAt: 1000
    });
    const req2 = new InterceptedRequest({
      id: 'req_resolved_2',
      res: mockRes,
      messages: [{ role: 'user', content: 'second prompt' }],
      createdAt: 2000
    });
    const req3 = new InterceptedRequest({
      id: 'req_pending_3',
      messages: [{ role: 'user', content: 'third prompt' }],
      createdAt: 3000
    });

    store.addRequest(req1);
    store.addRequest(req2);
    store.addRequest(req3);

    // Resolve req2
    req2.resolve('finished');

    const pending = store.getAllPending();

    assert.strictEqual(pending.length, 2, 'only pending requests should be returned');
    assert.deepStrictEqual(pending[0], {
      id: 'req_pending_1',
      messages: [{ role: 'user', content: 'first prompt' }],
      tools: [{ name: 'tool_1' }],
      createdAt: 1000,
      status: REQUEST_STATUS.PENDING
    });
    assert.deepStrictEqual(pending[1], {
      id: 'req_pending_3',
      messages: [{ role: 'user', content: 'third prompt' }],
      tools: [],
      createdAt: 3000,
      status: REQUEST_STATUS.PENDING
    });

    // Verify sanitization: no internal socket handles leaked
    for (const item of pending) {
      assert.strictEqual(item.req, undefined);
      assert.strictEqual(item.res, undefined);
      assert.strictEqual(item.socket, undefined);
    }
  });

  test('maintains backward compatibility with module-level singleton functions', () => {
    const id = `req_compat_${Date.now()}`;
    const initialCount = getAllPending().length;

    addRequest(id, null, null, [{ role: 'user', content: 'singleton test' }], []);

    const pending = getAllPending();
    assert.strictEqual(pending.length, initialCount + 1);

    const retrieved = getRequest(id);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.id, id);

    const removed = removeRequest(id);
    assert.strictEqual(removed, true);
    assert.strictEqual(getAllPending().length, initialCount);
  });
});
