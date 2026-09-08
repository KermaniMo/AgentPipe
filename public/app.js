// State
let pendingRequests = [];
let selectedRequestId = null;
let toastTimer = null;

// System Prompt Constant for New Web Chat
const SYSTEM_PROMPT = `You are acting strictly as the autonomous backend LLM engine for an AI coding agent.
I will forward environment context, user instructions, file states, and tool execution outputs to you step-by-step.

Your responsibility is to drive the task forward by selecting and executing the next appropriate action.

### STRICT OPERATING RULES:
1. NO conversational filler, greetings, or acknowledgments (never say "Sure", "Let me check", or "Here is the tool").
2. When an action/tool is needed, output ONLY a valid JSON object specifying the tool call:
   {
     "name": "<tool_name>",
     "arguments": { ... }
   }
3. Always use the exact tool names and argument schemas provided in the prompt context.
4. Avoid markdown code block wrappers (like \`\`\`json ... \`\`\`) whenever possible; output raw JSON.
5. When the entire task is finished, or when answering a purely informational question with no tool required, reply in clean, direct plain text (NO JSON).

Acknowledge your role by replying with exactly one word: "READY".`;

const BASE_URL = 'http://localhost:4747/v1';

// DOM Elements
const pendingList = document.getElementById('pending-list');
const emptyState = document.getElementById('empty-state');
const pendingCount = document.getElementById('pending-count');
const serverStatus = document.getElementById('server-status');
const pulseIndicator = document.getElementById('pulse-indicator');
const selectedReqDisplay = document.getElementById('selected-req-display');
const selectedReqMeta = document.getElementById('selected-req-meta');
const cancelActiveBtn = document.getElementById('cancel-active-btn');
const responseInput = document.getElementById('response-input');
const sendBtn = document.getElementById('send-btn');
const dispatchStatus = document.getElementById('dispatch-status');
const refreshBtn = document.getElementById('refresh-btn');
const validationBadge = document.getElementById('validation-badge');
const validationText = document.getElementById('validation-text');

// Quick Connection Bar Controls
const copyBaseUrlBtn = document.getElementById('copy-base-url-btn');
const baseUrlBadge = document.getElementById('base-url-badge');
const copySystemPromptBtn = document.getElementById('copy-system-prompt-btn');

// Prompt Formatter Controls
const btnCopyCompact = document.getElementById('btn-copy-compact');
const btnCopyFull = document.getElementById('btn-copy-full');
const promptModeHint = document.getElementById('prompt-mode-hint');

// Chips
const chipSampleTool = document.getElementById('chip-sample-tool');
const chipSampleText = document.getElementById('chip-sample-text');
const chipClear = document.getElementById('chip-clear');

/**
 * Toast feedback
 */
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--accent-rose)' : 'var(--accent-emerald)';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

/**
 * Status message in dispatch footer
 */
function setStatus(message, type = '') {
  dispatchStatus.className = `status-msg ${type}`;
  dispatchStatus.textContent = message;
}

/**
 * Intelligent JSON & Markdown Extraction and Normalization
 * Handles:
 * - Stripping conversational wrapper text
 * - Removing markdown code block wrappers (```json, ```xml, etc.)
 * - Removing <thought>...</thought> and <think>...</think> blocks
 * - Extracting outermost valid JSON object/array
 * - Normalizing shorthand tool calls to standard OpenAI tool_calls schema
 * - Validating broken/malformed JSON attempts
 */
function sanitizeResponseInput(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      mode: 'text',
      payload: ''
    };
  }

  // 1. Strip reasoning blocks (<think>...</think> and <thought>...</thought>)
  let cleaned = rawText
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thought[\s\S]*?<\/thought>/gi, '')
    .trim();

  // 2. Extract markdown code blocks if present
  let codeBlockContent = null;
  const codeBlockMatch = cleaned.match(/```(?:json|javascript|js|xml)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    codeBlockContent = codeBlockMatch[1].trim();
  }

  // Helper to find balanced JSON object {...} or array [...]
  function findBalancedJson(str) {
    let startIndex = -1;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '{' || str[i] === '[') {
        startIndex = i;
        break;
      }
    }
    if (startIndex === -1) return null;

    const opener = str[startIndex];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < str.length; i++) {
      const c = str[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (c === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === opener || c === '{' || c === '[') {
          depth++;
        } else if (c === closer || c === '}' || c === ']') {
          depth--;
          if (depth === 0) {
            return str.substring(startIndex, i + 1);
          }
        }
      }
    }
    return null; // Unbalanced
  }

  // Determine candidate JSON string
  let candidateJson = null;
  if (codeBlockContent) {
    candidateJson = findBalancedJson(codeBlockContent) || codeBlockContent;
  } else {
    candidateJson = findBalancedJson(cleaned);
  }

  // Try parsing JSON
  let parsedJson = null;
  if (candidateJson) {
    try {
      parsedJson = JSON.parse(candidateJson);
    } catch (e) {
      // Parse error on candidate
    }
  }

  // Detect whether the input strongly appears to be intended as JSON
  const looksLikeJson =
    codeBlockMatch !== null ||
    cleaned.startsWith('{') ||
    cleaned.startsWith('[') ||
    cleaned.includes('```json') ||
    (cleaned.includes('{') && (cleaned.includes('"name"') || cleaned.includes('"arguments"') || cleaned.includes('"tool_calls"') || cleaned.includes('"function"')));

  if (!parsedJson && looksLikeJson) {
    let errMsg = 'Syntax error in JSON';
    if (candidateJson) {
      try {
        JSON.parse(candidateJson);
      } catch (err) {
        errMsg = err.message;
      }
    } else {
      errMsg = 'Unclosed brackets or braces';
    }

    return {
      mode: 'malformed',
      error: errMsg,
      payload: cleaned
    };
  }

  // If valid JSON was detected and parsed
  if (parsedJson && typeof parsedJson === 'object') {
    let toolCalls = [];

    // Format A: Standard tool_calls object
    if (Array.isArray(parsedJson.tool_calls) && parsedJson.tool_calls.length > 0) {
      toolCalls = parsedJson.tool_calls;
    } else if (parsedJson.tool_calls && typeof parsedJson.tool_calls === 'object') {
      toolCalls = [parsedJson.tool_calls];
    } else if (parsedJson.name && (parsedJson.arguments !== undefined || parsedJson.parameters !== undefined)) {
      // Format B: Shorthand { name: '...', arguments: {...} }
      toolCalls = [parsedJson];
    } else if (parsedJson.function && parsedJson.function.name) {
      // Format C: { function: { name: '...', arguments: {...} } }
      toolCalls = [parsedJson];
    } else if (Array.isArray(parsedJson) && parsedJson.length > 0 && (parsedJson[0].name || parsedJson[0].function)) {
      // Format D: Array of tool calls
      toolCalls = parsedJson;
    }

    if (toolCalls.length > 0) {
      // Normalize into standard OpenAI tool_calls structure
      const timestamp = Date.now();
      const normalizedToolCalls = toolCalls.map((tc, idx) => {
        const id = tc.id || `call_${timestamp}_${idx}`;
        const name = tc.function?.name || tc.name || 'custom_tool';
        const rawArgs = tc.function?.arguments !== undefined
          ? tc.function.arguments
          : (tc.arguments !== undefined ? tc.arguments : (tc.parameters !== undefined ? tc.parameters : {}));
        const argumentsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);

        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: argumentsStr
          }
        };
      });

      const normalizedPayload = {
        tool_calls: normalizedToolCalls
      };

      const toolNames = normalizedToolCalls.map(tc => tc.function.name).join(', ');

      return {
        mode: 'tool',
        toolName: toolNames,
        payload: JSON.stringify(normalizedPayload, null, 2)
      };
    }
  }

  // Plain natural text mode
  let textPayload = cleaned;
  if (textPayload.startsWith('```') && textPayload.endsWith('```')) {
    textPayload = textPayload.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  return {
    mode: 'text',
    payload: textPayload
  };
}

/**
 * Live validation badge updater
 */
function updateValidationIndicator() {
  if (!validationBadge || !validationText) return;

  const rawText = responseInput.value.trim();
  if (!rawText) {
    validationBadge.className = 'validation-badge text-mode';
    validationText.textContent = 'Text Response Mode';
    return;
  }

  const analysis = sanitizeResponseInput(rawText);

  if (analysis.mode === 'tool') {
    validationBadge.className = 'validation-badge tool-mode';
    validationText.textContent = `Detected Tool: ${analysis.toolName}`;
  } else if (analysis.mode === 'malformed') {
    validationBadge.className = 'validation-badge malformed-mode';
    const shortErr = analysis.error && analysis.error.length > 35
      ? analysis.error.slice(0, 32) + '...'
      : (analysis.error || 'Syntax Error');
    validationText.textContent = `Malformed JSON: ${shortErr}`;
  } else {
    validationBadge.className = 'validation-badge text-mode';
    validationText.textContent = 'Text Response Mode';
  }
}

/**
 * Extract latest user message (role === 'user')
 */
function getLatestUserMessage(messages = []) {
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
function getMessageContent(msg) {
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
function getToolOutput(msg) {
  return getMessageContent(msg);
}

const JSON_INSTRUCTION = 'Respond strictly with an OpenAI-compatible JSON tool call object (e.g. {"name": "...", "arguments": {...}}) or plain text.';

/**
 * Format prompt in Compact Mode (Default for Auto-Copy & Quick Copy):
 * - Extract only the last message from the messages array (messages[messages.length - 1]).
 * - If it's a tool output (role: "tool"): format cleanly as:
 *   Tool execution output for [tool_call_id]:
 *   ---
 *   [content]
 *   ---
 *   Based on this output, proceed with the next step. Respond strictly with an OpenAI-compatible JSON tool call object (e.g. {"name": "...", "arguments": {...}}) or plain text.
 * - If it's a regular user message: format just that message with the JSON instruction.
 */
function formatCompactPrompt(req) {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  if (messages.length === 0) {
    return JSON_INSTRUCTION;
  }

  const lastMsg = messages[messages.length - 1];
  const content = getMessageContent(lastMsg).trim();

  if (lastMsg && lastMsg.role === 'tool') {
    const toolId = lastMsg.tool_call_id ? ` for ${lastMsg.tool_call_id}` : '';
    return `Tool execution output${toolId}:
---
${content}
---
Based on this output, proceed with the next step. ${JSON_INSTRUCTION}`;
  }

  // Regular user message (or other role)
  return `${content}

---
${JSON_INSTRUCTION}`;
}

/**
 * Format prompt in Full Mode:
 * Copies the full message history and available tools (for the very first turn of a task or starting a fresh web chat).
 */
function formatFullPrompt(req) {
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

  return formatted.trim();
}

/**
 * Universal formatter supporting 'compact' or 'full' modes
 */
function formatForWebChat(req, mode = 'compact') {
  return mode === 'full' ? formatFullPrompt(req) : formatCompactPrompt(req);
}

/**
 * Copy text to clipboard with optional custom toast message
 */
async function copyToClipboard(text, btnElement, toastMsg = 'Copied to clipboard!') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    if (btnElement) {
      const originalHtml = btnElement.innerHTML;
      btnElement.innerHTML = `✓ Copied!`;
      setTimeout(() => {
        btnElement.innerHTML = originalHtml;
      }, 1800);
    }

    showToast(toastMsg);
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Failed to copy to clipboard', true);
  }
}

/**
 * Update selection state UI
 */
function updateSelectionUI() {
  const req = pendingRequests.find(r => r.id === selectedRequestId);
  if (selectedRequestId && req) {
    selectedReqDisplay.textContent = selectedRequestId;
    const msgCount = (req.messages || []).length;
    const toolCount = (req.tools || []).length;
    selectedReqMeta.textContent = `${msgCount} msgs • ${toolCount} tools`;
    sendBtn.disabled = false;
    if (cancelActiveBtn) cancelActiveBtn.disabled = false;

    if (btnCopyCompact) btnCopyCompact.disabled = false;
    if (btnCopyFull) btnCopyFull.disabled = false;

    if (promptModeHint) {
      if (msgCount <= 2) {
        promptModeHint.textContent = 'First turn: Full Context recommended';
        promptModeHint.className = 'prompt-mode-hint first-turn';
      } else {
        promptModeHint.textContent = 'Compact mode active';
        promptModeHint.className = 'prompt-mode-hint';
      }
    }
  } else {
    selectedReqDisplay.textContent = 'None selected';
    selectedReqMeta.textContent = '';
    sendBtn.disabled = true;
    if (cancelActiveBtn) cancelActiveBtn.disabled = true;

    if (btnCopyCompact) btnCopyCompact.disabled = true;
    if (btnCopyFull) btnCopyFull.disabled = true;

    if (promptModeHint) {
      promptModeHint.textContent = 'No request selected';
      promptModeHint.className = 'prompt-mode-hint';
    }
  }

  // Update card highlights
  const cards = pendingList.querySelectorAll('.request-card');
  cards.forEach(card => {
    if (card.dataset.id === selectedRequestId) {
      card.classList.add('selected');
      const selectBtn = card.querySelector('.btn-select');
      if (selectBtn) selectBtn.textContent = 'Selected';
    } else {
      card.classList.remove('selected');
      const selectBtn = card.querySelector('.btn-select');
      if (selectBtn) selectBtn.textContent = 'Select';
    }
  });
}

/**
 * Render list of pending requests
 */
function renderPendingList() {
  pendingCount.textContent = pendingRequests.length;

  if (pendingRequests.length === 0) {
    pendingList.innerHTML = '';
    pendingList.appendChild(emptyState);
    emptyState.style.display = 'flex';

    serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
    pulseIndicator.className = 'pulse-dot idle';

    selectedRequestId = null;
    updateSelectionUI();
    return;
  }

  emptyState.style.display = 'none';
  serverStatus.textContent = `AgentPipe Dashboard - ${pendingRequests.length} Active Request${pendingRequests.length > 1 ? 's' : ''}`;
  pulseIndicator.className = 'pulse-dot';

  // If currently selected request is no longer present, select the first available
  if (!selectedRequestId || !pendingRequests.some(r => r.id === selectedRequestId)) {
    selectedRequestId = pendingRequests[0].id;
  }

  pendingList.innerHTML = '';

  pendingRequests.forEach(req => {
    const card = document.createElement('div');
    card.className = `request-card ${req.id === selectedRequestId ? 'selected' : ''}`;
    card.dataset.id = req.id;

    const messages = Array.isArray(req.messages) ? req.messages : [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isToolResult = lastMsg && lastMsg.role === 'tool';
    const latestUserMsg = getLatestUserMessage(messages);

    const fullJson = JSON.stringify({ messages: req.messages, tools: req.tools }, null, 2);

    const timeAgo = req.createdAt ? Math.max(0, Math.floor((Date.now() - req.createdAt) / 1000)) : 0;
    const timeDisplay = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;

    // 1. User Message HTML (if any user message exists)
    let userMsgHtml = '';
    if (latestUserMsg) {
      userMsgHtml = `
        <div class="user-msg-container">
          <div class="user-msg-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            Latest User Message
          </div>
          <div class="user-msg-content">${escapeHtml(latestUserMsg)}</div>
        </div>
      `;
    }

    // 2. Dedicated Terminal / Tool Output Box (if last message has role === 'tool')
    let toolOutputHtml = '';
    if (isToolResult) {
      const toolText = getToolOutput(lastMsg);
      toolOutputHtml = `
        <div class="terminal-output-container">
          <div class="terminal-header">
            <div class="terminal-header-left">
              <div class="terminal-dots">
                <span class="terminal-dot red"></span>
                <span class="terminal-dot yellow"></span>
                <span class="terminal-dot green"></span>
              </div>
              <div class="terminal-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5"></polyline>
                  <line x1="12" y1="19" x2="20" y2="19"></line>
                </svg>
                Terminal / Tool Output:
              </div>
            </div>
            ${lastMsg.tool_call_id ? `<span class="tool-id-tag">${escapeHtml(lastMsg.tool_call_id)}</span>` : ''}
          </div>
          <div class="terminal-body">
            <div class="terminal-prompt-line">
              <span>$ [execution result]</span>
            </div>
            <div class="terminal-content">${escapeHtml(toolText)}</div>
          </div>
        </div>
      `;
    }

    // Fallback if neither user message nor tool output exists
    if (!userMsgHtml && !toolOutputHtml) {
      userMsgHtml = `
        <div class="user-msg-container">
          <div class="user-msg-label">Message</div>
          <div class="user-msg-content">(No user or tool message found)</div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-top">
        <span class="req-id-badge">${req.id}</span>
        <span class="req-time">${timeDisplay}</span>
      </div>

      ${userMsgHtml}
      ${toolOutputHtml}

      <details>
        <summary>View Messages & Tools JSON (${messages.length} msgs, ${(req.tools || []).length} tools)</summary>
        <pre class="json-preview"><code>${escapeHtml(fullJson)}</code></pre>
      </details>

      <div class="card-actions">
        <div class="card-copy-group">
          <button class="btn btn-secondary btn-compact-card copy-compact-btn" title="Copy last message/tool output (Compact Mode)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy (Compact)
          </button>
          <button class="btn btn-secondary copy-full-btn" title="Copy full context and tools (Full Mode)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            Full
          </button>
        </div>
        <div class="card-btn-group">
          <button class="btn btn-cancel cancel-req-btn" title="Cancel this request">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Cancel
          </button>
          <button class="btn btn-select">${req.id === selectedRequestId ? 'Selected' : 'Select'}</button>
        </div>
      </div>
    `;

    // Click anywhere on card (except buttons & details) to select
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('details')) return;
      selectedRequestId = req.id;
      updateSelectionUI();
    });

    const selectBtn = card.querySelector('.btn-select');
    selectBtn.addEventListener('click', () => {
      selectedRequestId = req.id;
      updateSelectionUI();
    });

    const cancelBtn = card.querySelector('.cancel-req-btn');
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelRequest(req.id);
    });

    const copyCompactBtn = card.querySelector('.copy-compact-btn');
    copyCompactBtn.addEventListener('click', () => {
      const formattedText = formatCompactPrompt(req);
      copyToClipboard(formattedText, copyCompactBtn, 'Copied Last Message (Compact Mode)!');
    });

    const copyFullBtn = card.querySelector('.copy-full-btn');
    copyFullBtn.addEventListener('click', () => {
      const formattedText = formatFullPrompt(req);
      copyToClipboard(formattedText, copyFullBtn, 'Copied Full Context!');
    });

    pendingList.appendChild(card);
  });

  updateSelectionUI();
}

/**
 * Simple HTML escape
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const ORIGINAL_TITLE = 'AgentPipe - Human-in-the-Loop LLM Proxy';
let lastAutoCopiedRequestId = null;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Unlock audio context on first user gesture
function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}
window.addEventListener('click', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });
window.addEventListener('touchstart', unlockAudio, { once: true });

/**
 * Play a short, subtle, pleasant chime using Web Audio API oscillator
 */
function playNotificationChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Primary tone (E5 -> A5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    osc1.frequency.exponentialRampToValueAtTime(880.0, now + 0.12);

    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.35);

    // Harmonic overtone (E6)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1318.5, now + 0.08);
    gain2.gain.setValueAtTime(0.05, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.0005, now + 0.4);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    osc2.start(now + 0.08);
    osc2.stop(now + 0.4);
  } catch (err) {
    console.debug('[AgentPipe] Audio chime blocked or unavailable:', err);
  }
}

function setNewRequestTitle() {
  document.title = '(🔴 New Request) AgentPipe';
}

function restoreTitle() {
  document.title = ORIGINAL_TITLE;
}

/**
 * Automatically format and copy prompt when tab gains focus with a pending request
 * - Uses Compact Mode by default
 * - Automatically uses Full Mode if it's the first turn in the session (messages.length <= 2)
 */
async function handleAutoCopyOnFocus() {
  restoreTitle();

  if (pendingRequests.length === 0) return;

  const targetReq = pendingRequests.find(r => r.id === selectedRequestId) || pendingRequests[0];
  if (!targetReq) return;

  // Avoid duplicate auto-copying for the same request
  if (lastAutoCopiedRequestId === targetReq.id) return;

  try {
    const messages = Array.isArray(targetReq.messages) ? targetReq.messages : [];
    const isFirstTurn = messages.length <= 2;
    const mode = isFirstTurn ? 'full' : 'compact';
    const formatted = mode === 'full' ? formatFullPrompt(targetReq) : formatCompactPrompt(targetReq);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(formatted);
      lastAutoCopiedRequestId = targetReq.id;

      // Update active state on segmented buttons
      if (btnCopyCompact && btnCopyFull) {
        if (mode === 'full') {
          btnCopyFull.classList.add('active');
          btnCopyCompact.classList.remove('active');
        } else {
          btnCopyCompact.classList.add('active');
          btnCopyFull.classList.remove('active');
        }
      }

      showToast(`⚡ Prompt Auto-copied (${isFirstTurn ? 'Full Context' : 'Compact Mode'})!`);
    }
  } catch (err) {
    console.debug('[AgentPipe] Auto-copy on focus blocked or failed:', err);
  }
}

window.addEventListener('focus', handleAutoCopyOnFocus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    handleAutoCopyOnFocus();
  }
});

/**
 * Native Server-Sent Events (SSE) Connection for Real-Time Updates
 */
const eventSource = new EventSource('/api/events');

eventSource.onopen = () => {
  console.log('[AgentPipe] SSE connection established');
  if (pendingRequests.length === 0) {
    serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
    pulseIndicator.className = 'pulse-dot idle';
  } else {
    serverStatus.textContent = `AgentPipe Dashboard - ${pendingRequests.length} Active Request${pendingRequests.length > 1 ? 's' : ''}`;
    pulseIndicator.className = 'pulse-dot';
  }
};

eventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    const newRequests = Array.isArray(data) ? data : [];

    // Check if new requests arrived
    const previousIds = new Set(pendingRequests.map(r => r.id));
    const hasNewArrivals = newRequests.some(r => !previousIds.has(r.id));

    pendingRequests = newRequests;
    renderPendingList();

    if (hasNewArrivals && pendingRequests.length > 0) {
      playNotificationChime();
      setNewRequestTitle();

      // If document is already focused and visible, auto-copy immediately
      if (document.hasFocus() && !document.hidden) {
        handleAutoCopyOnFocus();
      }
    }
  } catch (err) {
    console.error('[AgentPipe] Error parsing SSE event data:', err);
  }
};

eventSource.onerror = (err) => {
  console.warn('[AgentPipe] SSE connection error / reconnecting...', err);
  serverStatus.textContent = 'AgentPipe Server Disconnected - Reconnecting...';
  pulseIndicator.className = 'pulse-dot idle';
};

/**
 * Dispatch response to Cline
 */
async function handleSend() {
  if (!selectedRequestId) {
    setStatus('Please select an incoming request first.', 'error');
    showToast('No request selected', true);
    return;
  }

  const raw = responseInput.value.trim();
  if (!raw) {
    setStatus('Response body is empty. Please enter or paste output.', 'error');
    showToast('Response cannot be empty', true);
    responseInput.focus();
    return;
  }

  const sanitized = sanitizeResponseInput(raw);

  if (sanitized.mode === 'malformed') {
    setStatus(`Cannot send: Malformed JSON (${sanitized.error}). Fix syntax or remove JSON brackets.`, 'error');
    showToast(`Malformed JSON: ${sanitized.error}`, true);
    responseInput.focus();
    return;
  }

  const payloadToSend = sanitized.payload;

  setStatus(`Dispatching ${sanitized.mode === 'tool' ? `tool (${sanitized.toolName})` : 'text response'} to ${selectedRequestId}...`, 'sending');
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: selectedRequestId,
        payload: payloadToSend
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to resolve request');
    }

    const resolvedId = selectedRequestId;
    setStatus(`✓ Successfully resolved ${resolvedId}!`, 'success');
    showToast(`Response dispatched to agent (${resolvedId})`);

    restoreTitle();
    lastAutoCopiedRequestId = null;

    responseInput.value = '';
    selectedRequestId = null;
    updateSelectionUI();
    updateValidationIndicator();
  } catch (err) {
    console.error('Send error:', err);
    setStatus(`Dispatch failed: ${err.message}`, 'error');
    showToast(`Failed: ${err.message}`, true);
  } finally {
    sendBtn.disabled = !selectedRequestId;
  }
}

// Event Listeners
sendBtn.addEventListener('click', handleSend);

// Keyboard shortcut: Ctrl + Enter / Cmd + Enter
responseInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!sendBtn.disabled) {
      handleSend();
    } else if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
    } else if (!responseInput.value.trim()) {
      showToast('Response input cannot be empty', true);
    }
  }
});

// Live validation on typing / pasting
responseInput.addEventListener('input', updateValidationIndicator);

// Smart Auto-Paste on textarea focus
responseInput.addEventListener('focus', async () => {
  // Only trigger if textarea is currently empty
  if (responseInput.value.trim().length > 0) return;

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const clipText = await navigator.clipboard.readText();
      if (clipText && clipText.trim()) {
        const trimmed = clipText.trim();

        // Guard: Do not paste outgoing prompt if clipboard hasn't changed
        if (
          trimmed.startsWith('INSTRUCTION:') ||
          trimmed.startsWith('Tool execution output') ||
          trimmed.includes('Respond strictly with an OpenAI-compatible')
        ) {
          return;
        }

        if (responseInput.value.trim().length === 0) {
          responseInput.value = trimmed;
          updateValidationIndicator();
          showToast('📋 Auto-pasted response from clipboard!');
        }
      }
    }
  } catch (err) {
    // Graceful catch for permission rejections or non-gesture focus
    console.debug('[AgentPipe] Auto-paste readText not permitted:', err);
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/pending');
    if (res.ok) {
      const data = await res.json();
      pendingRequests = Array.isArray(data) ? data : [];
      renderPendingList();
    }
    showToast('Refreshed requests list');
  } catch (err) {
    console.error('Manual refresh failed:', err);
    showToast('Failed to refresh', true);
  }
});

chipSampleTool.addEventListener('click', () => {
  responseInput.value = JSON.stringify({
    name: 'execute_command',
    arguments: {
      command: 'echo "Hello from AgentPipe"'
    }
  }, null, 2);
  updateValidationIndicator();
  responseInput.focus();
});

chipSampleText.addEventListener('click', () => {
  responseInput.value = 'I have analyzed the project structure and everything is set up correctly. Ready for the next instruction!';
  updateValidationIndicator();
  responseInput.focus();
});

chipClear.addEventListener('click', () => {
  responseInput.value = '';
  setStatus('');
  updateValidationIndicator();
  responseInput.focus();
});

// Smart Prompt Formatter Segmented Button Click Handlers
if (btnCopyCompact) {
  btnCopyCompact.addEventListener('click', () => {
    if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = pendingRequests.find(r => r.id === selectedRequestId);
    if (!req) return;

    btnCopyCompact.classList.add('active');
    btnCopyFull?.classList.remove('active');

    const formatted = formatCompactPrompt(req);
    copyToClipboard(formatted, btnCopyCompact, 'Copied Last Message (Compact Mode)!');
  });
}

if (btnCopyFull) {
  btnCopyFull.addEventListener('click', () => {
    if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = pendingRequests.find(r => r.id === selectedRequestId);
    if (!req) return;

    btnCopyFull.classList.add('active');
    btnCopyCompact?.classList.remove('active');

    const formatted = formatFullPrompt(req);
    copyToClipboard(formatted, btnCopyFull, 'Copied Full Context!');
  });
}

/**
 * Cancel / Abort a request
 */
async function cancelRequest(id) {
  if (!id) return;

  try {
    const res = await fetch('/api/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to cancel request');
    }

    // Clear response textarea and update UI immediately
    responseInput.value = '';
    updateValidationIndicator();

    // Optimistically remove request from local state
    pendingRequests = pendingRequests.filter(r => r.id !== id);

    if (selectedRequestId === id) {
      selectedRequestId = pendingRequests.length > 0 ? pendingRequests[0].id : null;
    }

    renderPendingList();
    setStatus(`Request ${id} canceled`, '');
    showToast('Request canceled');
  } catch (err) {
    console.error('Cancel error:', err);
    setStatus(`Failed to cancel: ${err.message}`, 'error');
    showToast(`Failed to cancel: ${err.message}`, true);
  }
}

// Active Request Cancel Button Listener
if (cancelActiveBtn) {
  cancelActiveBtn.addEventListener('click', () => {
    if (selectedRequestId) {
      cancelRequest(selectedRequestId);
    } else {
      showToast('No request selected to cancel', true);
    }
  });
}

// Quick Connection Bar Listeners
if (copyBaseUrlBtn) {
  copyBaseUrlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(BASE_URL, copyBaseUrlBtn, 'Copied Base URL (http://localhost:4747/v1)!');
  });
}

if (baseUrlBadge) {
  baseUrlBadge.addEventListener('click', (e) => {
    if (e.target.closest('#copy-base-url-btn')) return;
    copyToClipboard(BASE_URL, copyBaseUrlBtn, 'Copied Base URL (http://localhost:4747/v1)!');
  });
}

if (copySystemPromptBtn) {
  copySystemPromptBtn.addEventListener('click', () => {
    copyToClipboard(SYSTEM_PROMPT, copySystemPromptBtn, 'Copied System Prompt to clipboard!');
  });
}

// Initialize live validation state
updateValidationIndicator();

