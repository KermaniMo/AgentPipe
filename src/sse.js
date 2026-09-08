/**
 * Server-Sent Events (SSE) response generator for OpenAI-compatible streaming
 */

export function sendSSEResponse(res, rawPayload) {
  if (!res || res.writableEnded) {
    return;
  }

  // Set SSE response headers
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
  }

  let parsed = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      // Pure text string
      parsed = rawPayload;
    }
  }

  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let chunk;

  // Check if it contains tool_calls
  let toolCalls = null;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.tool_calls)) {
      toolCalls = parsed.tool_calls;
    } else if (parsed.tool_calls) {
      toolCalls = [parsed.tool_calls];
    } else if (parsed.message?.tool_calls) {
      toolCalls = Array.isArray(parsed.message.tool_calls)
        ? parsed.message.tool_calls
        : [parsed.message.tool_calls];
    } else if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].function || parsed[0].type === 'function' || parsed[0].name)) {
      toolCalls = parsed;
    } else if (parsed.function || (parsed.name && parsed.arguments !== undefined)) {
      toolCalls = [parsed];
    }
  }

  if (toolCalls && toolCalls.length > 0) {
    const formattedToolCalls = toolCalls.map((tc, idx) => {
      const callId = tc.id || `call_${Date.now()}_${idx}`;
      const funcName = tc.function?.name || tc.name || 'custom_tool';
      const funcArgs = typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {});

      return {
        index: tc.index ?? idx,
        id: callId,
        type: 'function',
        function: {
          name: funcName,
          arguments: funcArgs
        }
      };
    });

    chunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model: 'agent-relay',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: formattedToolCalls
          },
          finish_reason: 'tool_calls'
        }
      ]
    };
  } else {
    // Pure text or a message with content
    let content = '';
    if (typeof parsed === 'string') {
      content = parsed;
    } else if (parsed && typeof parsed === 'object') {
      content = parsed.content ?? parsed.message?.content ?? JSON.stringify(parsed);
    }

    chunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model: 'agent-relay',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: String(content)
          },
          finish_reason: 'stop'
        }
      ]
    };
  }

  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

export default {
  sendSSEResponse
};
