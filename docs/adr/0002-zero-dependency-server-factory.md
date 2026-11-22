# Zero-Dependency Server Factory and Modular Layering

We isolate AgentPipe's HTTP server lifecycle into a side-effect-free factory (`createAgentPipeServer`) and split monolithic routing into native zero-dependency modules (`router`, `static`, `controllers`, and `models`).

## Context
The previous `server.js` was a monolithic script that called `server.listen(PORT)` at the top level upon module import. This introduced severe testing friction (port collisions, unclosed sockets, inability to test in parallel) and coupled HTTP routing, static file streaming, agent interception, and dashboard SSE management in a single 325-line file. Furthermore, the repository enforces a strict zero-dependency policy (no Express, Fastify, or external npm packages).

## Decision
1. **Server Factory**: `server.js` exports `createAgentPipeServer({ store, port, host })` which wires handlers and returns an unlistened `http.Server` instance. Only CLI entrypoints (`src/cli.js`) invoke `.listen()`.
2. **Native Lightweight Router**: A ~40-line zero-dependency router (`src/router.js`) handles route registration (`GET`, `POST`, `OPTIONS`), CORS, and path normalization without external frameworks.
3. **Domain & Controller Separation**: Domain entity `InterceptedRequest` lives in `src/models/`, protocol logic lives in `src/controllers/agent.controller.js` and `src/controllers/dashboard.controller.js`, and file streaming lives in `src/static.js`.
