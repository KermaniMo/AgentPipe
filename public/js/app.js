import { SYSTEM_PROMPT, BASE_URL } from './constants.js';
import {
  responseInput,
  sendBtn,
  refreshBtn,
  chipSampleTool,
  chipSampleText,
  chipClear,
  btnCopyCompact,
  btnCopyFull,
  cancelActiveBtn,
  copyBaseUrlBtn,
  baseUrlBadge,
  copySystemPromptBtn,
  showToast,
  setStatus
} from './dom.js';
import { sanitizeResponseInput, updateValidationIndicator } from './sanitizer.js';
import { state, renderPendingList, updateSelectionUI } from './ui.js';
import { initSSE } from './sse.js';
import { restoreTitle, unlockAudio } from './audio.js';
import { copyToClipboard, handleAutoCopyOnFocus, resetAutoCopyState } from './clipboard.js';
import { formatCompactPrompt, formatFullPrompt } from './formatters.js';
import { settings, initSettingsUI } from './settings.js';

// Setup audio unlock on gesture
window.addEventListener('click', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });
window.addEventListener('touchstart', unlockAudio, { once: true });

// Auto-copy on focus
window.addEventListener('focus', handleAutoCopyOnFocus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    handleAutoCopyOnFocus();
  }
});

// Init SSE connection
initSSE();

/**
 * Cancel / Abort a request
 */
export async function cancelRequest(id) {
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
    state.pendingRequests = state.pendingRequests.filter(r => r.id !== id);

    if (state.selectedRequestId === id) {
      state.selectedRequestId = state.pendingRequests.length > 0 ? state.pendingRequests[0].id : null;
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

/**
 * Dispatch response to the LLM agent
 */
async function handleSend() {
  if (!state.selectedRequestId) {
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

  const modeLabel = sanitized.mode === 'tool'
    ? (sanitized.repaired ? `auto-repaired tool (${sanitized.toolName})` : `tool (${sanitized.toolName})`)
    : 'text response';

  setStatus(`Dispatching ${modeLabel} to ${state.selectedRequestId}...`, 'sending');
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: state.selectedRequestId,
        payload: payloadToSend
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to resolve request');
    }

    const resolvedId = state.selectedRequestId;
    setStatus(`✓ Successfully resolved ${resolvedId}!`, 'success');
    showToast(sanitized.repaired
      ? `Auto-repaired response dispatched to agent (${resolvedId})`
      : `Response dispatched to agent (${resolvedId})`);

    restoreTitle();
    resetAutoCopyState();

    responseInput.value = '';
    state.selectedRequestId = null;
    updateSelectionUI();
    updateValidationIndicator();
  } catch (err) {
    console.error('Send error:', err);
    setStatus(`Dispatch failed: ${err.message}`, 'error');
    showToast(`Failed: ${err.message}`, true);
  } finally {
    sendBtn.disabled = !state.selectedRequestId;
  }
}

// Global UI Event Listeners
sendBtn.addEventListener('click', handleSend);

responseInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!sendBtn.disabled) {
      handleSend();
    } else if (!state.selectedRequestId) {
      showToast('Select an incoming request first', true);
    } else if (!responseInput.value.trim()) {
      showToast('Response input cannot be empty', true);
    }
  }
});

responseInput.addEventListener('input', updateValidationIndicator);

responseInput.addEventListener('focus', async () => {
  if (settings && !settings.autoPaste) return;
  if (responseInput.value.trim().length > 0) return;

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const clipText = await navigator.clipboard.readText();
      if (clipText && clipText.trim()) {
        const trimmed = clipText.trim();
        if (
          trimmed.startsWith('INSTRUCTION:') ||
          trimmed.startsWith('Tool execution output') ||
          trimmed.includes('Respond strictly with an OpenAI-compatible') ||
          trimmed.includes('CRITICAL SYSTEM DIRECTIVE') ||
          trimmed.includes('[CRITICAL SYSTEM DIRECTIVE:')
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
    console.debug('[AgentPipe] Auto-paste readText not permitted:', err);
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/pending');
    if (res.ok) {
      const data = await res.json();
      state.pendingRequests = Array.isArray(data) ? data : [];
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

if (btnCopyCompact) {
  btnCopyCompact.addEventListener('click', () => {
    if (!state.selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = state.pendingRequests.find(r => r.id === state.selectedRequestId);
    if (!req) return;

    btnCopyCompact.classList.add('active');
    btnCopyFull?.classList.remove('active');

    const formatted = formatCompactPrompt(req);
    copyToClipboard(formatted, btnCopyCompact, 'Copied Last Message (Compact Mode)!');
  });
}

if (btnCopyFull) {
  btnCopyFull.addEventListener('click', () => {
    if (!state.selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = state.pendingRequests.find(r => r.id === state.selectedRequestId);
    if (!req) return;

    btnCopyFull.classList.add('active');
    btnCopyCompact?.classList.remove('active');

    const formatted = formatFullPrompt(req);
    copyToClipboard(formatted, btnCopyFull, 'Copied Full Context!');
  });
}

if (cancelActiveBtn) {
  cancelActiveBtn.addEventListener('click', () => {
    if (state.selectedRequestId) {
      cancelRequest(state.selectedRequestId);
    } else {
      showToast('No request selected to cancel', true);
    }
  });
}

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
    const promptToCopy = (settings && settings.systemPrompt) || SYSTEM_PROMPT;
    copyToClipboard(promptToCopy, copySystemPromptBtn, 'Copied System Prompt to clipboard!');
  });
}

// Initialize settings modal and configuration
initSettingsUI();

// Initial state
updateValidationIndicator();
