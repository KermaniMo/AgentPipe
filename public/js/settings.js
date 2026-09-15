import { SYSTEM_PROMPT_DEFAULT } from './constants.js';
import {
  openSettingsBtn,
  settingsModal,
  closeSettingsBtn,
  btnCancelSettings,
  btnSaveSettings,
  settingAutoCopy,
  settingAutoPaste,
  settingSoundAlerts,
  btnTestChime,
  settingDefaultCopyMode,
  settingSystemPrompt,
  btnResetSystemPrompt,
  btnCopyCompact,
  btnCopyFull,
  promptModeHint,
  showToast
} from './dom.js';
import { playNotificationChime } from './audio.js';

export const SETTINGS_STORAGE_KEY = 'agentpipe_settings';

export const defaultSettings = {
  autoCopy: true,
  autoPaste: true,
  soundAlerts: true,
  defaultCopyMode: 'compact',
  systemPrompt: SYSTEM_PROMPT_DEFAULT
};

/**
 * Load settings from localStorage merged with defaultSettings
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw);
    return {
      autoCopy: typeof parsed.autoCopy === 'boolean' ? parsed.autoCopy : defaultSettings.autoCopy,
      autoPaste: typeof parsed.autoPaste === 'boolean' ? parsed.autoPaste : defaultSettings.autoPaste,
      soundAlerts: typeof parsed.soundAlerts === 'boolean' ? parsed.soundAlerts : defaultSettings.soundAlerts,
      defaultCopyMode: parsed.defaultCopyMode === 'full' ? 'full' : 'compact',
      systemPrompt: typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim().length > 0
        ? parsed.systemPrompt
        : defaultSettings.systemPrompt
    };
  } catch (err) {
    console.warn('[AgentPipe] Failed to read settings from localStorage, using defaults:', err);
    return { ...defaultSettings };
  }
}

// Active singleton settings object
export let settings = loadSettings();

/**
 * Persist current settings to localStorage
 */
export function saveSettings(newValues = {}) {
  try {
    Object.assign(settings, newValues);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    applySettingsToUI();
  } catch (err) {
    console.error('[AgentPipe] Failed to persist settings to localStorage:', err);
    showToast('Failed to save settings to storage', true);
  }
}

/**
 * Update UI elements that depend on current settings (e.g. copy mode indicators)
 */
export function applySettingsToUI() {
  if (btnCopyCompact && btnCopyFull) {
    const isFull = settings.defaultCopyMode === 'full';
    const compactPill = btnCopyCompact.querySelector('.default-pill');
    const fullPill = btnCopyFull.querySelector('.default-pill');

    if (isFull) {
      if (!fullPill) {
        const pill = document.createElement('span');
        pill.className = 'default-pill';
        pill.textContent = 'Default';
        btnCopyFull.appendChild(pill);
      }
      if (compactPill) compactPill.remove();
      btnCopyFull.classList.add('active');
      btnCopyCompact.classList.remove('active');
    } else {
      if (!compactPill) {
        const pill = document.createElement('span');
        pill.className = 'default-pill';
        pill.textContent = 'Default';
        btnCopyCompact.appendChild(pill);
      }
      if (fullPill) fullPill.remove();
      btnCopyCompact.classList.add('active');
      btnCopyFull.classList.remove('active');
    }
  }

  if (promptModeHint && promptModeHint.textContent && promptModeHint.textContent !== 'No request selected') {
    if (settings.defaultCopyMode === 'full') {
      promptModeHint.textContent = 'Full Context mode active';
      promptModeHint.className = 'prompt-mode-hint';
    } else {
      promptModeHint.textContent = 'Compact mode active';
      promptModeHint.className = 'prompt-mode-hint';
    }
  }
}

/**
 * Open Settings Modal
 */
export function openSettingsModal() {
  if (!settingsModal) return;

  // Sync inputs with current settings
  if (settingAutoCopy) settingAutoCopy.checked = !!settings.autoCopy;
  if (settingAutoPaste) settingAutoPaste.checked = !!settings.autoPaste;
  if (settingSoundAlerts) settingSoundAlerts.checked = !!settings.soundAlerts;
  if (settingDefaultCopyMode) settingDefaultCopyMode.value = settings.defaultCopyMode || 'compact';
  if (settingSystemPrompt) settingSystemPrompt.value = settings.systemPrompt || SYSTEM_PROMPT_DEFAULT;

  settingsModal.classList.add('open');
  settingsModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

/**
 * Close Settings Modal
 */
export function closeSettingsModal() {
  if (!settingsModal) return;
  settingsModal.classList.remove('open');
  settingsModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

/**
 * Initialize settings UI events
 */
export function initSettingsUI() {
  applySettingsToUI();

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', openSettingsModal);
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', closeSettingsModal);
  }

  if (btnCancelSettings) {
    btnCancelSettings.addEventListener('click', closeSettingsModal);
  }

  // Click outside modal card to close
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        closeSettingsModal();
      }
    });
  }

  // Escape key to close
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal && settingsModal.classList.contains('open')) {
      closeSettingsModal();
    }
  });

  // Test Chime button
  if (btnTestChime) {
    btnTestChime.addEventListener('click', () => {
      playNotificationChime(true);
      showToast('🔔 Chime test sound played!');
    });
  }

  // Reset System Prompt to Default button
  if (btnResetSystemPrompt && settingSystemPrompt) {
    btnResetSystemPrompt.addEventListener('click', () => {
      settingSystemPrompt.value = SYSTEM_PROMPT_DEFAULT;
      showToast('Restored default system prompt');
      settingSystemPrompt.focus();
    });
  }

  // Save Settings button
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      const updated = {
        autoCopy: settingAutoCopy ? settingAutoCopy.checked : settings.autoCopy,
        autoPaste: settingAutoPaste ? settingAutoPaste.checked : settings.autoPaste,
        soundAlerts: settingSoundAlerts ? settingSoundAlerts.checked : settings.soundAlerts,
        defaultCopyMode: settingDefaultCopyMode ? settingDefaultCopyMode.value : settings.defaultCopyMode,
        systemPrompt: settingSystemPrompt && settingSystemPrompt.value.trim().length > 0
          ? settingSystemPrompt.value.trim()
          : SYSTEM_PROMPT_DEFAULT
      };

      saveSettings(updated);
      closeSettingsModal();
      showToast('Settings saved successfully!');
    });
  }
}
