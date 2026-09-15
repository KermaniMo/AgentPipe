import {
  pendingList,
  emptyState,
  pendingCount,
  serverStatus,
  pulseIndicator,
  selectedReqDisplay,
  selectedReqMeta,
  sendBtn,
  cancelActiveBtn,
  btnCopyCompact,
  btnCopyFull,
  promptModeHint,
  escapeHtml
} from './dom.js';
import { getLatestUserMessage, getToolOutput, formatCompactPrompt, formatFullPrompt } from './formatters.js';
import { copyToClipboard } from './clipboard.js';
import { cancelRequest } from './app.js';
import { settings } from './settings.js';

export const state = {
  pendingRequests: [],
  selectedRequestId: null
};

/**
 * Update selection state UI
 */
export function updateSelectionUI() {
  const req = state.pendingRequests.find(r => r.id === state.selectedRequestId);
  if (state.selectedRequestId && req) {
    selectedReqDisplay.textContent = state.selectedRequestId;
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
      } else if (settings && settings.defaultCopyMode === 'full') {
        promptModeHint.textContent = 'Full Context mode active';
        promptModeHint.className = 'prompt-mode-hint';
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
    if (card.dataset.id === state.selectedRequestId) {
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
 * Create a single request card element
 */
function createCard(req) {
  const card = document.createElement('div');
  card.className = `request-card ${req.id === state.selectedRequestId ? 'selected' : ''}`;
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
        <button class="btn btn-select">${req.id === state.selectedRequestId ? 'Selected' : 'Select'}</button>
      </div>
    </div>
  `;

  // Click anywhere on card (except buttons & details) to select
  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('details')) return;
    state.selectedRequestId = req.id;
    updateSelectionUI();
  });

  const selectBtn = card.querySelector('.btn-select');
  selectBtn.addEventListener('click', () => {
    state.selectedRequestId = req.id;
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

  return card;
}

/**
 * Render list of pending requests
 */
export function renderPendingList() {
  const scrollY = typeof window !== 'undefined' ? window.scrollY : 0;
  const isAtBottom = typeof window !== 'undefined' ? 
    (Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 10) : false;
  const listScroll = pendingList ? pendingList.scrollTop : 0;

  pendingCount.textContent = state.pendingRequests.length;

  if (state.pendingRequests.length === 0) {
    pendingList.innerHTML = '';
    pendingList.appendChild(emptyState);
    emptyState.style.display = 'flex';

    serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
    pulseIndicator.className = 'pulse-dot idle';

    state.selectedRequestId = null;
    updateSelectionUI();

    if (pendingList) pendingList.scrollTop = listScroll;
    if (typeof window !== 'undefined') {
      if (isAtBottom) window.scrollTo(0, document.documentElement.scrollHeight);
      else if (scrollY > 0) window.scrollTo(0, scrollY);
    }
    return;
  }

  emptyState.style.display = 'none';
  if (emptyState.parentNode === pendingList) {
    pendingList.removeChild(emptyState);
  }

  serverStatus.textContent = `AgentPipe Dashboard - ${state.pendingRequests.length} Active Request${state.pendingRequests.length > 1 ? 's' : ''}`;
  pulseIndicator.className = 'pulse-dot';

  // If currently selected request is no longer present, select the first available
  if (!state.selectedRequestId || !state.pendingRequests.some(r => r.id === state.selectedRequestId)) {
    state.selectedRequestId = state.pendingRequests[0].id;
  }

  // Preserve existing cards in-place to prevent DOM destruction and height collapse
  const existingCards = new Map();
  pendingList.querySelectorAll('.request-card').forEach(card => {
    existingCards.set(card.dataset.id, card);
  });

  const activeIds = new Set(state.pendingRequests.map(r => r.id));

  // Remove cards that are no longer active
  existingCards.forEach((card, id) => {
    if (!activeIds.has(id)) {
      card.remove();
    }
  });

  // Append new cards or update timestamps on existing ones
  state.pendingRequests.forEach(req => {
    let card = existingCards.get(req.id);
    if (!card) {
      card = createCard(req);
      pendingList.appendChild(card);
    } else {
      const timeEl = card.querySelector('.req-time');
      if (timeEl && req.createdAt) {
        const timeAgo = Math.max(0, Math.floor((Date.now() - req.createdAt) / 1000));
        timeEl.textContent = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;
      }
    }
  });

  updateSelectionUI();

  // Restore scroll positions so the view remains completely steady
  // If the user was scrolled all the way to the bottom, force the page to stick to the bottom.
  if (pendingList) pendingList.scrollTop = listScroll;
  
  if (typeof window !== 'undefined') {
    // Wait a brief moment for the DOM height to recalculate, then adjust
    requestAnimationFrame(() => {
      if (isAtBottom) {
        window.scrollTo(0, document.documentElement.scrollHeight);
      } else if (scrollY > 0) {
        window.scrollTo(0, scrollY);
      }
    });
  }
}
