# AgentPipe Domain Glossary

Zero-dependency local proxy bridging OpenAI-compatible coding agents to web chatbots via Human-in-the-Loop SSE.

## Language

**Intercepted Request**:
An incoming HTTP chat completion request from an Agent Client held in suspension until a human operator resolves, cancels, or aborts it via the dashboard.
_Avoid_: Pending request, raw socket, paused call, completion job

**Agent Client**:
An external AI development tool or IDE extension (such as Cline, Roo Code, Continue, or Aider) that consumes the standard OpenAI chat completion API.
_Avoid_: Caller, LLM, bot, consumer

**Dashboard Client**:
A web browser instance connected to AgentPipe's internal Server-Sent Events stream to inspect, resolve, or cancel Intercepted Requests.
_Avoid_: Web client, frontend, viewer, subscriber

**Request Store**:
The in-memory registry managing the lifecycle, state transitions, and safe resolution of Intercepted Requests.
_Avoid_: Cache, pending list, socket pool, memory map

**SSE Dispatcher**:
The subsystem responsible for streaming OpenAI-compatible events to Agent Clients and real-time state change events to Dashboard Clients.
_Avoid_: Event emitter, socket writer, streamer

**Instant Dispatch**:
The immediate transmission of the operator-approved response to the waiting Agent Client in a compliant SSE chunk without artificial token pacing.
_Avoid_: Stream simulation, typing pacing, token throttle

**Indefinite Hold**:
The design guarantee that an Intercepted Request remains active in the Request Store without an arbitrary timeout, awaiting operator action or client abort.
_Avoid_: Socket timeout, lease, keepalive expiration

**Server Factory**:
A modular function that wires the router, store, and controllers to return an unlistened HTTP server instance without execution side-effects.
_Avoid_: Server singleton, global listener, self-starting module
