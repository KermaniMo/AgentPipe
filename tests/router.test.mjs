import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Readable } from 'node:stream';
import { Router, createRouter, parseJsonBody, normalizePath } from '../src/router.js';

describe('Router & Safe Body Parser', () => {
  let server;
  let baseUrl;
  let router;

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

      if (options.chunkedBytes && body) {
        // Send body sliced into specific byte chunk sizes to stress-test multi-byte buffering
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const chunkSize = options.chunkedBytes;
        for (let i = 0; i < buf.length; i += chunkSize) {
          req.write(buf.subarray(i, i + chunkSize));
        }
        req.end();
      } else if (body) {
        if (Buffer.isBuffer(body)) {
          req.write(body);
        } else if (typeof body === 'string') {
          req.write(body);
        } else {
          req.write(JSON.stringify(body));
        }
        req.end();
      } else {
        req.end();
      }
    });
  }

  before(async () => {
    router = createRouter();

    // Register test routes
    router.get('/v1/models', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'agent-relay', object: 'model' }] }));
    });

    router.get('/models', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'agent-relay', object: 'model' }] }));
    });

    router.get('/query-test', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: req.query, pathname: req.pathname }));
    });

    router.post('/v1/chat/completions', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: req.body }));
    });

    router.post('/echo-unicode', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt: req.body.prompt }));
    });

    router.put('/update-resource', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updated: true, body: req.body }));
    });

    server = http.createServer((req, res) => router.handle(req, res));

    await new Promise((resolve) => {
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
  });

  describe('Universal CORS Headers', () => {
    test('applies universal CORS headers to GET requests', async () => {
      const res = await makeRequest('/v1/models');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    test('applies universal CORS headers to POST requests', async () => {
      const res = await makeRequest('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { messages: [] });
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    test('applies universal CORS headers to 404 responses', async () => {
      const res = await makeRequest('/unhandled-route');
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    test('applies universal CORS headers to 400 bad request responses', async () => {
      const res = await makeRequest('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '{ invalid json');
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });
  });

  describe('OPTIONS Preflight Handling', () => {
    test('handles OPTIONS preflight immediately with HTTP 204 No Content', async () => {
      const res = await makeRequest('/v1/chat/completions', { method: 'OPTIONS' });
      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, '');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS, PUT, DELETE');
      assert.strictEqual(res.headers['access-control-allow-headers'], '*');
    });

    test('handles OPTIONS preflight even on unhandled routes with HTTP 204', async () => {
      const res = await makeRequest('/any/nonexistent/path', { method: 'OPTIONS' });
      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, '');
    });
  });

  describe('Path Normalization and Route Matching', () => {
    test('matches route with exact path', async () => {
      const res = await makeRequest('/v1/models');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.object, 'list');
    });

    test('normalizes trailing slashes (e.g., /v1/models/ -> /v1/models)', async () => {
      const resSingleSlash = await makeRequest('/v1/models/');
      assert.strictEqual(resSingleSlash.statusCode, 200);

      const resMultipleSlashes = await makeRequest('/v1/models///');
      assert.strictEqual(resMultipleSlashes.statusCode, 200);
    });

    test('normalizes query strings and passes query parameters to req.query', async () => {
      const res = await makeRequest('/query-test?agent=cline&debug=true&num=42');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.pathname, '/query-test');
      assert.deepStrictEqual(data.query, {
        agent: 'cline',
        debug: 'true',
        num: '42'
      });
    });

    test('supports registering multiple paths for a single handler', async () => {
      const customRouter = createRouter();
      let hitCount = 0;
      customRouter.get(['/route-a', '/route-b'], (req, res) => {
        hitCount++;
        res.writeHead(200);
        res.end('ok');
      });

      const s = http.createServer((req, res) => customRouter.handle(req, res));
      await new Promise(r => s.listen(0, '127.0.0.1', r));
      const port = s.address().port;

      const resA = await fetch(`http://127.0.0.1:${port}/route-a`);
      assert.strictEqual(resA.status, 200);

      const resB = await fetch(`http://127.0.0.1:${port}/route-b`);
      assert.strictEqual(resB.status, 200);

      assert.strictEqual(hitCount, 2);
      s.closeAllConnections?.();
      s.close();
    });

    test('normalizePath utility helper strips trailing slashes and handles roots', () => {
      assert.strictEqual(normalizePath('/'), '/');
      assert.strictEqual(normalizePath('///'), '/');
      assert.strictEqual(normalizePath('/v1/models/'), '/v1/models');
      assert.strictEqual(normalizePath('/v1/models///'), '/v1/models');
      assert.strictEqual(normalizePath('v1/models'), '/v1/models');
      assert.strictEqual(normalizePath(''), '/');
    });
  });

  describe('Safe Binary Buffer Body Parsing & Unicode Integrity', () => {
    test('parses multi-byte Persian Unicode prompt without corruption', async () => {
      const persianPrompt = 'سلام دنیا! من یک درخواست به زبان فارسی با ساختار چندبایتی هستم: گچپژ';
      const payload = { prompt: persianPrompt };

      const res = await makeRequest('/echo-unicode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload);

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.prompt, persianPrompt);
      assert.strictEqual(data.prompt.includes('\uFFFD'), false);
    });

    test('parses multi-byte Unicode text split across 1-byte chunk boundaries without corruption', async () => {
      // 4-byte emojis and 2-byte Persian chars
      const complexText = 'پروژه AgentPipe 🚀🔥🤖 - تست چندبایتی: گ، چ، پ، ژ - 🌟💡🎉';
      const payload = JSON.stringify({ prompt: complexText });

      // Send payload chunked into 1-byte slices over HTTP socket
      const res = await makeRequest('/echo-unicode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        chunkedBytes: 1
      }, payload);

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.prompt, complexText);
      // Ensure zero replacement characters (corruption)
      assert.strictEqual(data.prompt.includes('\uFFFD'), false);
    });

    test('handles empty body gracefully by providing empty object', async () => {
      const res = await makeRequest('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '');

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.deepStrictEqual(data.received, {});
    });

    test('handles PUT request body parsing', async () => {
      const res = await makeRequest('/update-resource', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      }, { status: 'active' });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.updated, true);
      assert.deepStrictEqual(data.body, { status: 'active' });
    });

    test('enforces body limit on parseJsonBody directly and rejects if payload exceeds limit', async () => {
      const tinyStream = new Readable({
        read() {
          this.push(Buffer.from('{"data":"'));
          this.push(Buffer.from('x'.repeat(100)));
          this.push(Buffer.from('"}'));
          this.push(null);
        }
      });

      // Set safety limit to 50 bytes
      await assert.rejects(
        async () => {
          await parseJsonBody(tinyStream, { limit: 50 });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 413);
          assert.match(err.message, /too large/i);
          return true;
        }
      );
    });

    test('router returns 413 when request body exceeds configured bodyLimit', async () => {
      const limitedRouter = createRouter({ bodyLimit: 50 });
      limitedRouter.post('/upload', (req, res) => {
        res.writeHead(200);
        res.end('ok');
      });

      const s = http.createServer((req, res) => limitedRouter.handle(req, res));
      await new Promise(r => s.listen(0, '127.0.0.1', r));
      const port = s.address().port;

      const largePayload = JSON.stringify({ text: 'A'.repeat(200) });
      const res = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largePayload
      });

      assert.strictEqual(res.status, 413);
      const body = await res.json();
      assert.match(body.error, /too large/i);

      s.closeAllConnections?.();
      s.close();
    });
  });

  describe('Error Handling: 400 Malformed JSON & 404 Unhandled Routes', () => {
    test('returns standard HTTP 400 error payload when request JSON is malformed', async () => {
      const res = await makeRequest('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '{ "messages": [ broken json');

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.ok(data.error);
      assert.match(data.error, /Invalid JSON body/i);
    });

    test('returns standard 404 for unhandled route paths', async () => {
      const res = await makeRequest('/unhandled/random/endpoint');
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.deepStrictEqual(data, { error: '404 Not Found' });
    });

    test('returns standard 404 when HTTP method is not registered for path', async () => {
      // /v1/models is only registered as GET
      const res = await makeRequest('/v1/models', { method: 'POST' }, { foo: 'bar' });
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.deepStrictEqual(data, { error: '404 Not Found' });
    });

    test('allows setting custom notFoundHandler', async () => {
      const customRouter = createRouter();
      customRouter.setNotFoundHandler((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ custom: 'not_found', path: req.pathname }));
      });

      const s = http.createServer((req, res) => customRouter.handle(req, res));
      await new Promise(r => s.listen(0, '127.0.0.1', r));
      const port = s.address().port;

      const res = await fetch(`http://127.0.0.1:${port}/custom-miss`);
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.deepStrictEqual(data, { custom: 'not_found', path: '/custom-miss' });

      s.closeAllConnections?.();
      s.close();
    });
  });
});
