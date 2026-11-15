import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { InterceptedRequest, REQUEST_STATUS } from '../src/models/intercepted-request.js';
import { InterceptedRequest as IndexInterceptedRequest, REQUEST_STATUS as IndexRequestStatus } from '../src/models/index.js';

test('InterceptedRequest: models index re-exports InterceptedRequest and REQUEST_STATUS', () => {
  assert.strictEqual(IndexInterceptedRequest, InterceptedRequest);
  assert.strictEqual(IndexRequestStatus, REQUEST_STATUS);
});

test('InterceptedRequest: initializes with status PENDING and given metadata', () => {
  const reqMock = {};
  const resMock = {};
  const messages = [{ role: 'user', content: 'Hello' }];
  const tools = [{ type: 'function', function: { name: 'test_tool' } }];

  const req = new InterceptedRequest({
    id: 'req_123',
    req: reqMock,
    res: resMock,
    messages,
    tools,
    createdAt: 1000
  });

  assert.strictEqual(req.id, 'req_123');
  assert.strictEqual(req.status, REQUEST_STATUS.PENDING);
  assert.strictEqual(req.status, 'PENDING');
  assert.deepStrictEqual(req.messages, messages);
  assert.deepStrictEqual(req.tools, tools);
  assert.strictEqual(req.createdAt, 1000);
});

test('InterceptedRequest: toJSON() serializes metadata without socket references', () => {
  const reqMock = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  const resMock = { socket: {}, write: () => {}, end: () => {} };
  const messages = [{ role: 'user', content: 'test message' }];
  const tools = [{ name: 'dummy_tool' }];

  const req = new InterceptedRequest({
    id: 'req_456',
    req: reqMock,
    res: resMock,
    messages,
    tools,
    createdAt: 2000
  });

  const serialized = req.toJSON();
  assert.deepStrictEqual(serialized, {
    id: 'req_456',
    messages: [{ role: 'user', content: 'test message' }],
    tools: [{ name: 'dummy_tool' }],
    createdAt: 2000,
    status: 'PENDING'
  });

  // Verify JSON.stringify uses toJSON and does not include req or res
  const jsonString = JSON.stringify(req);
  const parsed = JSON.parse(jsonString);
  assert.deepStrictEqual(parsed, serialized);
  assert.strictEqual(parsed.req, undefined);
  assert.strictEqual(parsed.res, undefined);
  assert.strictEqual(parsed.socket, undefined);
});

test('InterceptedRequest: resolve() transitions PENDING -> RESOLVING -> RESOLVED and writes SSE payload', () => {
  const writtenChunks = [];
  let ended = false;
  let headersSent = false;
  let responseHeaders = {};

  const resMock = {
    get headersSent() {
      return headersSent;
    },
    writeHead(statusCode, headers) {
      headersSent = true;
      responseHeaders = headers;
    },
    write(chunk) {
      writtenChunks.push(chunk);
    },
    end() {
      ended = true;
    }
  };

  const req = new InterceptedRequest({
    id: 'req_res_1',
    res: resMock
  });

  const stateTransitions = [];
  req.on('stateChange', ({ status, previousStatus }) => {
    stateTransitions.push({ status, previousStatus });
  });

  const payload = 'Hello from human operator';
  req.resolve(payload);

  assert.strictEqual(req.status, REQUEST_STATUS.RESOLVED);
  assert.deepStrictEqual(stateTransitions, [
    { status: REQUEST_STATUS.RESOLVING, previousStatus: REQUEST_STATUS.PENDING },
    { status: REQUEST_STATUS.RESOLVED, previousStatus: REQUEST_STATUS.RESOLVING }
  ]);
  assert.strictEqual(ended, true);
  assert.strictEqual(writtenChunks.length, 2);
  assert.ok(writtenChunks[0].includes('Hello from human operator'));
  assert.strictEqual(writtenChunks[1], 'data: [DONE]\n\n');
});

test('InterceptedRequest: double-resolve guard throws error and prevents second resolution', () => {
  let writeCallCount = 0;
  const resMock = {
    headersSent: false,
    writeHead: () => {},
    write: () => { writeCallCount++; },
    end: () => {}
  };

  const req = new InterceptedRequest({ id: 'req_guard_1', res: resMock });

  req.resolve('First response');
  assert.strictEqual(req.status, REQUEST_STATUS.RESOLVED);
  const initialWrites = writeCallCount;

  assert.throws(
    () => req.resolve('Second response'),
    /Cannot resolve request: current status is RESOLVED/
  );
  assert.strictEqual(writeCallCount, initialWrites);
});

test('InterceptedRequest: cancel() transitions PENDING -> CANCELED and transmits graceful termination chunk', () => {
  const writtenChunks = [];
  let ended = false;
  let headersSent = false;
  let responseHeaders = {};

  const resMock = {
    get headersSent() {
      return headersSent;
    },
    writeHead(statusCode, headers) {
      headersSent = true;
      responseHeaders = headers;
    },
    write(chunk) {
      writtenChunks.push(chunk);
    },
    end() {
      ended = true;
    }
  };

  const req = new InterceptedRequest({ id: 'req_cancel_1', res: resMock });

  const stateTransitions = [];
  req.on('stateChange', ({ status, previousStatus }) => {
    stateTransitions.push({ status, previousStatus });
  });

  req.cancel();

  assert.strictEqual(req.status, REQUEST_STATUS.CANCELED);
  assert.deepStrictEqual(stateTransitions, [
    { status: REQUEST_STATUS.CANCELED, previousStatus: REQUEST_STATUS.PENDING }
  ]);
  assert.strictEqual(ended, true);
  assert.strictEqual(headersSent, true);
  assert.strictEqual(responseHeaders['Content-Type'], 'text/event-stream');
  assert.strictEqual(writtenChunks.length, 2);

  const chunkJson = JSON.parse(writtenChunks[0].replace(/^data: /, '').trim());
  assert.strictEqual(chunkJson.object, 'chat.completion.chunk');
  assert.strictEqual(chunkJson.choices[0].delta.content, '\n[Task canceled by user via dashboard]');
  assert.strictEqual(chunkJson.choices[0].finish_reason, 'stop');
  assert.strictEqual(writtenChunks[1], 'data: [DONE]\n\n');
});

test('InterceptedRequest: cannot cancel or resolve request that is not PENDING', () => {
  const createResMock = () => ({
    headersSent: false,
    writeHead: () => {},
    write: () => {},
    end: () => {}
  });

  // Cannot cancel already canceled
  const req1 = new InterceptedRequest({ id: 'req_guard_cancel', res: createResMock() });
  req1.cancel();
  assert.strictEqual(req1.status, REQUEST_STATUS.CANCELED);
  assert.throws(
    () => req1.cancel(),
    /Cannot cancel request: current status is CANCELED/
  );

  // Cannot resolve already canceled
  assert.throws(
    () => req1.resolve('should fail'),
    /Cannot resolve request: current status is CANCELED/
  );

  // Cannot cancel already resolved
  const req2 = new InterceptedRequest({ id: 'req_guard_resolve', res: createResMock() });
  req2.resolve('all good');
  assert.strictEqual(req2.status, REQUEST_STATUS.RESOLVED);
  assert.throws(
    () => req2.cancel(),
    /Cannot cancel request: current status is RESOLVED/
  );
});

test('InterceptedRequest: abort() transitions PENDING -> ABORTED without throwing errors', () => {
  const req = new InterceptedRequest({ id: 'req_abort_1' });

  const stateTransitions = [];
  req.on('stateChange', ({ status, previousStatus }) => {
    stateTransitions.push({ status, previousStatus });
  });

  // Calling abort transitions to ABORTED
  assert.doesNotThrow(() => req.abort());
  assert.strictEqual(req.status, REQUEST_STATUS.ABORTED);
  assert.deepStrictEqual(stateTransitions, [
    { status: REQUEST_STATUS.ABORTED, previousStatus: REQUEST_STATUS.PENDING }
  ]);

  // Calling abort again when already ABORTED does not throw
  assert.doesNotThrow(() => req.abort());
  assert.strictEqual(req.status, REQUEST_STATUS.ABORTED);

  // Calling abort on already RESOLVED does not throw and does not change state
  const reqResolved = new InterceptedRequest({ id: 'req_abort_res' });
  reqResolved.resolve('done');
  assert.doesNotThrow(() => reqResolved.abort());
  assert.strictEqual(reqResolved.status, REQUEST_STATUS.RESOLVED);

  // Cannot resolve or cancel an ABORTED request
  assert.throws(
    () => req.resolve('fail'),
    /Cannot resolve request: current status is ABORTED/
  );
  assert.throws(
    () => req.cancel(),
    /Cannot cancel request: current status is ABORTED/
  );
});

test('InterceptedRequest: client disconnect (req close event) transitions PENDING to ABORTED', () => {
  const reqEmitter = new EventEmitter();

  const interceptedReq = new InterceptedRequest({
    id: 'req_client_disconnect',
    req: reqEmitter
  });

  assert.strictEqual(interceptedReq.status, REQUEST_STATUS.PENDING);

  // Agent client disconnects (socket closes)
  reqEmitter.emit('close');

  assert.strictEqual(interceptedReq.status, REQUEST_STATUS.ABORTED);

  // Emitting close again or after resolution must not throw or alter state
  assert.doesNotThrow(() => reqEmitter.emit('close'));
  assert.strictEqual(interceptedReq.status, REQUEST_STATUS.ABORTED);
});

test('InterceptedRequest: supports positional constructor parameters and default values', () => {
  const reqDefault = new InterceptedRequest();
  assert.ok(reqDefault.id.startsWith('req_'));
  assert.strictEqual(reqDefault.status, REQUEST_STATUS.PENDING);
  assert.deepStrictEqual(reqDefault.messages, []);
  assert.deepStrictEqual(reqDefault.tools, []);
  assert.ok(typeof reqDefault.createdAt === 'number');

  const reqPositional = new InterceptedRequest('custom_id', null, null, [{ role: 'system' }], [{ name: 't1' }], 5555);
  assert.strictEqual(reqPositional.id, 'custom_id');
  assert.strictEqual(reqPositional.status, REQUEST_STATUS.PENDING);
  assert.deepStrictEqual(reqPositional.messages, [{ role: 'system' }]);
  assert.deepStrictEqual(reqPositional.tools, [{ name: 't1' }]);
  assert.strictEqual(reqPositional.createdAt, 5555);
});

test('InterceptedRequest: guards against writes after close when res.writableEnded is true', () => {
  let writeCalled = false;
  const resClosed = {
    writableEnded: true,
    headersSent: true,
    write: () => { writeCalled = true; },
    end: () => {}
  };

  const req = new InterceptedRequest({ id: 'req_closed_res', res: resClosed });
  assert.doesNotThrow(() => req.resolve('test payload'));
  assert.strictEqual(req.status, REQUEST_STATUS.RESOLVED);
  assert.strictEqual(writeCalled, false);
});

test('InterceptedRequest: resolve() with tool calls dispatches tool_calls SSE chunk', () => {
  const writtenChunks = [];
  const resMock = {
    headersSent: false,
    writeHead: () => {},
    write: (chunk) => writtenChunks.push(chunk),
    end: () => {}
  };

  const req = new InterceptedRequest({ id: 'req_tool_call', res: resMock });
  const toolPayload = {
    tool_calls: [
      {
        id: 'call_1',
        function: { name: 'get_weather', arguments: '{"city":"Berlin"}' }
      }
    ]
  };

  req.resolve(toolPayload);

  assert.strictEqual(req.status, REQUEST_STATUS.RESOLVED);
  assert.strictEqual(writtenChunks.length, 2);
  const chunkJson = JSON.parse(writtenChunks[0].replace(/^data: /, '').trim());
  assert.strictEqual(chunkJson.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(chunkJson.choices[0].delta.tool_calls[0].function.name, 'get_weather');
  assert.strictEqual(writtenChunks[1], 'data: [DONE]\n\n');
});
