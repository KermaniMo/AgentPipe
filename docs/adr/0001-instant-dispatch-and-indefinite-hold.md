# Instant Dispatch and Indefinite Hold

In AgentPipe's Human-in-the-Loop workflow, intercepted requests are held open indefinitely by default without arbitrary timeouts, and operator responses are dispatched immediately in standard SSE chunk format without artificial streaming delays.

## Context
AgentPipe bridges IDE coding agents with free/subscription web chatbots. Unlike automated proxy chains, human operators require arbitrary time to read prompts, query web chats, and review tool outputs before responding. When the operator triggers a dispatch, any artificial delay or token-by-token pacing introduces unwanted latency into the developer's feedback loop.

## Decision
1. **Instant Dispatch**: We format and transmit the full completion response immediately inside a compliant OpenAI SSE chunk (`chat.completion.chunk`) followed by `[DONE]`. We reject simulated typing or token pacing.
2. **Indefinite Hold**: The `RequestStore` will not auto-expire or abort connections based on hardcoded TTLs. Intercepted Requests remain active until explicitly resolved or canceled by the operator, or aborted by the client socket disconnect. An optional configurable timeout may be provided as an opt-in user setting.
