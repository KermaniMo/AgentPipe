import { JSON_INSTRUCTION, CRITICAL_SYSTEM_DIRECTIVE } from './constants.js';

/**
 * Extract latest user message (role === 'user')
 */
export function getLatestUserMessage(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || JSON.stringify(c)).join('\n');
      }
      return JSON.stringify(msg.content, null, 2);
    }
  }

  return null;
}

/**
 * Helper to safely extract content from a message (string, array of parts, or object)
 */
export function getMessageContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c && typeof c.text === 'string') return c.text;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (typeof msg.content === 'object' && msg.content !== null) {
    return JSON.stringify(msg.content, null, 2);
  }
  return String(msg.content ?? '');
}

/**
 * Format tool output content safely
 */
export function getToolOutput(msg) {
  return getMessageContent(msg);
}

/**
 * Format prompt in Compact Mode (Default for Auto-Copy & Quick Copy):
 * - Extract only the last message from the messages array (messages[messages.length - 1]).
 * - If it's a tool output (role: "tool"): format cleanly with tool output block.
 * - If it's a regular user message: format just that message.
 * - Appends the unambiguous CRITICAL SYSTEM DIRECTIVE as the absolute last line.
 */
export function formatCompactPrompt(req) {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  if (messages.length === 0) {
    return `${JSON_INSTRUCTION}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
  }

  const lastMsg = messages[messages.length - 1];
  const content = getMessageContent(lastMsg).trim();

  let formatted = '';
  if (lastMsg && lastMsg.role === 'tool') {
    const toolId = lastMsg.tool_call_id ? ` for ${lastMsg.tool_call_id}` : '';
    formatted = `Tool execution output${toolId}:
---
${content}
---
Based on this output, proceed with the next step. ${JSON_INSTRUCTION}`;
  } else {
    // Regular user message (or other role)
    formatted = `${content}

---
${JSON_INSTRUCTION}`;
  }

  return `${formatted}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
}

/**
 * Format prompt in Full Mode:
 * Copies the full message history and available tools (for the very first turn of a task or starting a fresh web chat).
 */
export function formatFullPrompt(req) {
  let formatted = `INSTRUCTION:\n${JSON_INSTRUCTION} Do not add markdown backticks.\n\n`;

  const messages = Array.isArray(req.messages) ? req.messages : [];
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

  // If the last message is a tool output, prominently highlight it at the top
  if (lastMsg && lastMsg.role === 'tool') {
    const toolOutput = getMessageContent(lastMsg);
    formatted += `==================================================\n`;
    formatted += `LATEST TERMINAL / TOOL OUTPUT:\n`;
    if (lastMsg.tool_call_id) {
      formatted += `Tool Call ID: ${lastMsg.tool_call_id}\n`;
    }
    formatted += `Result / Output:\n${toolOutput}\n`;
    formatted += `==================================================\n`;
    formatted += `NOTE FOR LLM: The command or tool above has finished execution in the environment. Analyze its output and provide the next tool call or final response.\n\n`;
  }

  if (req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    formatted += `AVAILABLE TOOLS:\n${JSON.stringify(req.tools, null, 2)}\n\n`;
  }

  formatted += `CONVERSATION HISTORY:\n`;
  if (messages.length > 0) {
    messages.forEach(m => {
      const role = (m.role || 'user').toUpperCase();
      let content = m.content;
      if (typeof content !== 'string') {
        content = JSON.stringify(content, null, 2);
      }

      if (m.role === 'tool') {
        formatted += `--- [TERMINAL / TOOL OUTPUT${m.tool_call_id ? ` (${m.tool_call_id})` : ''}] ---\n${content}\n\n`;
      } else if (m.role === 'assistant' && m.tool_calls) {
        formatted += `--- [ASSISTANT (REQUESTED TOOL CALLS)] ---\n${JSON.stringify(m.tool_calls, null, 2)}\n`;
        if (content) formatted += `Commentary: ${content}\n`;
        formatted += `\n`;
      } else {
        formatted += `--- [${role}] ---\n${content}\n\n`;
      }
    });
  }

  return `${formatted.trim()}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
}

/**
 * Universal formatter supporting 'compact' or 'full' modes
 */
export function formatForWebChat(req, mode = 'compact') {
  return mode === 'full' ? formatFullPrompt(req) : formatCompactPrompt(req);
}
