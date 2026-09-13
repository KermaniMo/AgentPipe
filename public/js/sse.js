import { serverStatus, pulseIndicator } from './dom.js';
import { renderPendingList, state } from './ui.js';
import { playNotificationChime, setNewRequestTitle } from './audio.js';
import { handleAutoCopyOnFocus } from './clipboard.js';

export function initSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    console.log('[AgentPipe] SSE connection established');
    if (state.pendingRequests.length === 0) {
      serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
      pulseIndicator.className = 'pulse-dot idle';
    } else {
      serverStatus.textContent = `AgentPipe Dashboard - ${state.pendingRequests.length} Active Request${state.pendingRequests.length > 1 ? 's' : ''}`;
      pulseIndicator.className = 'pulse-dot';
    }
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const newRequests = Array.isArray(data) ? data : [];

      // Check if new requests arrived
      const previousIds = new Set(state.pendingRequests.map(r => r.id));
      const hasNewArrivals = newRequests.some(r => !previousIds.has(r.id));

      state.pendingRequests = newRequests;
      renderPendingList();

      if (hasNewArrivals && state.pendingRequests.length > 0) {
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
}
