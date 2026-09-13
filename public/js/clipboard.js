import { showToast, btnCopyCompact, btnCopyFull } from './dom.js';
import { formatCompactPrompt, formatFullPrompt } from './formatters.js';
import { state } from './ui.js';

let lastAutoCopiedRequestId = null;

export function resetAutoCopyState() {
  lastAutoCopiedRequestId = null;
}

/**
 * Copy text to clipboard with optional custom toast message
 */
export async function copyToClipboard(text, btnElement, toastMsg = 'Copied to clipboard!') {
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
 * Automatically format and copy prompt when tab gains focus with a pending request
 * - Uses Compact Mode by default
 * - Automatically uses Full Mode if it's the first turn in the session (messages.length <= 2)
 */
export async function handleAutoCopyOnFocus() {
  const { restoreTitle } = await import('./audio.js');
  restoreTitle();

  if (state.pendingRequests.length === 0) return;

  const targetReq = state.pendingRequests.find(r => r.id === state.selectedRequestId) || state.pendingRequests[0];
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
