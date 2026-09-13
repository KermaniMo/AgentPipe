const get = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

// DOM Elements
export const pendingList = get('pending-list');
export const emptyState = get('empty-state');
export const pendingCount = get('pending-count');
export const serverStatus = get('server-status');
export const pulseIndicator = get('pulse-indicator');
export const selectedReqDisplay = get('selected-req-display');
export const selectedReqMeta = get('selected-req-meta');
export const cancelActiveBtn = get('cancel-active-btn');
export const responseInput = get('response-input');
export const sendBtn = get('send-btn');
export const dispatchStatus = get('dispatch-status');
export const refreshBtn = get('refresh-btn');
export const validationBadge = get('validation-badge');
export const validationText = get('validation-text');

// Quick Connection Bar Controls
export const copyBaseUrlBtn = get('copy-base-url-btn');
export const baseUrlBadge = get('base-url-badge');
export const copySystemPromptBtn = get('copy-system-prompt-btn');

// Prompt Formatter Controls
export const btnCopyCompact = get('btn-copy-compact');
export const btnCopyFull = get('btn-copy-full');
export const promptModeHint = get('prompt-mode-hint');

// Chips
export const chipSampleTool = get('chip-sample-tool');
export const chipSampleText = get('chip-sample-text');
export const chipClear = get('chip-clear');

let toastTimer = null;

export function showToast(message, isError = false) {
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

export function setStatus(message, type = '') {
  dispatchStatus.className = `status-msg ${type}`;
  dispatchStatus.textContent = message;
}

export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
