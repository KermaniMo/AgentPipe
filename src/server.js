import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import store from './store.js';
import { sendSSEResponse } from './sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = 4747;

// Connected SSE dashboard clients
const dashboardClients = new Set();

/**
 * Broadcast updated pending requests list to all connected dashboard SSE clients
 */
function broadcastPending() {
  const data = JSON.stringify(store.getAllPending());
  const message = `data: ${data}\n\n`;

  for (const clientRes of dashboardClients) {
    try {
      if (!clientRes.writableEnded) {
        clientRes.write(message);
      } else {
        dashboardClients.delete(clientRes);
      }
    } catch (err) {
      console.error('[AgentPipe] Error broadcasting to client:', err);
      dashboardClients.delete(clientRes);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // 10MB safety limit
      if (body.length > 1e7) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Enable CORS for external tools, extensions, and the web dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // Serve dashboard index.html
    if (req.method === 'GET' && pathname === '/') {
      const filePath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('500 Internal Server Error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      });
      return;
    }

    // Serve dashboard app.js
    if (req.method === 'GET' && pathname === '/app.js') {
      const filePath = path.join(PUBLIC_DIR, 'app.js');
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('500 Internal Server Error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(content);
      });
      return;
    }

    // Serve dashboard style.css
    if (req.method === 'GET' && pathname === '/style.css') {
      const filePath = path.join(PUBLIC_DIR, 'style.css');
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('500 Internal Server Error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(content);
      });
      return;
    }

    // Real-time Server-Sent Events stream for dashboard
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      dashboardClients.add(res);
      console.log(`[AgentPipe] Dashboard SSE client connected. Total clients: ${dashboardClients.size}`);

      req.on('close', () => {
        dashboardClients.delete(res);
        console.log(`[AgentPipe] Dashboard SSE client disconnected. Total clients: ${dashboardClients.size}`);
      });

      // Immediately send current pending list on connection
      res.write(`data: ${JSON.stringify(store.getAllPending())}\n\n`);
      return;
    }

    // OpenAI-compatible models endpoint
    if (req.method === 'GET' && pathname === '/v1/models') {
      const modelsResponse = {
        object: 'list',
        data: [
          {
            id: 'agent-pipe',
            object: 'model',
            created: 123456789,
            owned_by: 'custom'
          }
        ]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modelsResponse));
      return;
    }

    // Intercept LLM chat completions and hold connection
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      let data;
      try {
        data = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        return;
      }

      const id = `req_${Date.now()}`;
      store.addRequest(id, req, res, data.messages || [], data.tools || []);

      console.log(`[AgentPipe] Intercepted chat completion request: ${id}`);

      // Broadcast update to all connected dashboard SSE clients
      broadcastPending();

      // Handle client disconnect or abort
      req.on('close', () => {
        if (!res.writableEnded) {
          console.log(`[AgentPipe] Client disconnected/aborted request: ${id}`);
          store.removeRequest(id);
          broadcastPending();
        }
      });

      // CRITICAL: Do NOT call res.end() or send headers! Leave the connection hanging.
      return;
    }

    // Get all pending requests for dashboard (fallback / API access)
    if (req.method === 'GET' && pathname === '/api/pending') {
      const pending = store.getAllPending();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pending));
      return;
    }

    // Resolve an intercepted request with user dashboard payload
    if (req.method === 'POST' && pathname === '/api/resolve') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        return;
      }

      const { id, payload } = body;
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: id' }));
        return;
      }

      const storedReq = store.getRequest(id);
      if (!storedReq) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request not found or already resolved' }));
        return;
      }

      // Send SSE response back to the client waiting on POST /v1/chat/completions
      sendSSEResponse(storedReq.res, payload);
      store.removeRequest(id);

      console.log(`[AgentPipe] Successfully resolved request: ${id}`);

      // Broadcast updated pending list to all connected dashboard clients
      broadcastPending();

      // Respond to dashboard API caller
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Cancel/abort an intercepted request
    if (req.method === 'POST' && pathname === '/api/cancel') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        return;
      }

      const { id } = body;
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: id' }));
        return;
      }

      const storedReq = store.getRequest(id);
      if (!storedReq) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request not found or already resolved' }));
        return;
      }

      if (!storedReq.res.headersSent) {
        storedReq.res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
      }

      // Send a graceful termination SSE chunk to Cline so it stops cleanly without throwing a network error
      const cancelChunk = {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'agent-pipe',
        choices: [{
          index: 0,
          delta: { content: '\n[Task canceled by user via dashboard]' },
          finish_reason: 'stop'
        }]
      };

      storedReq.res.write('data: ' + JSON.stringify(cancelChunk) + '\n\n');
      storedReq.res.write('data: [DONE]\n\n');
      storedReq.res.end();

      store.removeRequest(id);
      console.log(`[AgentPipe] Successfully canceled request: ${id}`);

      broadcastPending();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Request canceled' }));
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '404 Not Found' }));
  } catch (err) {
    console.error('[AgentPipe] Unhandled server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`AgentPipe server listening on http://localhost:${PORT}`);
});
