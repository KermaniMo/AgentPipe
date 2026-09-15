import { test } from 'node:test';
import assert from 'node:assert';
import { SYSTEM_PROMPT_DEFAULT } from '../public/js/constants.js';

// Mock localStorage and document/window for testing settings module in Node
const storageMap = new Map();
global.localStorage = {
  getItem: (key) => storageMap.has(key) ? storageMap.get(key) : null,
  setItem: (key, val) => storageMap.set(key, String(val)),
  removeItem: (key) => storageMap.delete(key),
  clear: () => storageMap.clear()
};

global.document = {
  getElementById: () => null,
  body: { style: {} }
};
global.window = {
  addEventListener: () => {}
};

test('Settings: Default settings match schema', async () => {
  const { defaultSettings, SETTINGS_STORAGE_KEY } = await import('../public/js/settings.js');
  assert.strictEqual(SETTINGS_STORAGE_KEY, 'agentpipe_settings');
  assert.strictEqual(defaultSettings.autoCopy, true);
  assert.strictEqual(defaultSettings.autoPaste, true);
  assert.strictEqual(defaultSettings.soundAlerts, true);
  assert.strictEqual(defaultSettings.defaultCopyMode, 'compact');
  assert.strictEqual(defaultSettings.systemPrompt, SYSTEM_PROMPT_DEFAULT);
});

test('Settings: loadSettings returns defaults when storage is empty', async () => {
  storageMap.clear();
  const { loadSettings } = await import('../public/js/settings.js');
  const loaded = loadSettings();
  assert.deepStrictEqual(loaded.autoCopy, true);
  assert.deepStrictEqual(loaded.autoPaste, true);
  assert.deepStrictEqual(loaded.soundAlerts, true);
  assert.deepStrictEqual(loaded.defaultCopyMode, 'compact');
  assert.deepStrictEqual(loaded.systemPrompt, SYSTEM_PROMPT_DEFAULT);
});

test('Settings: loadSettings gracefully handles malformed JSON in localStorage', async () => {
  storageMap.set('agentpipe_settings', '{{broken json');
  const { loadSettings } = await import('../public/js/settings.js');
  const loaded = loadSettings();
  assert.strictEqual(loaded.autoCopy, true);
  assert.strictEqual(loaded.autoPaste, true);
  assert.strictEqual(loaded.soundAlerts, true);
  assert.strictEqual(loaded.defaultCopyMode, 'compact');
  assert.strictEqual(loaded.systemPrompt, SYSTEM_PROMPT_DEFAULT);
});

test('Settings: loadSettings merges partial settings with defaults', async () => {
  storageMap.set('agentpipe_settings', JSON.stringify({
    soundAlerts: false,
    defaultCopyMode: 'full'
  }));
  const { loadSettings } = await import('../public/js/settings.js');
  const loaded = loadSettings();
  assert.strictEqual(loaded.autoCopy, true); // default preserved
  assert.strictEqual(loaded.autoPaste, true); // default preserved
  assert.strictEqual(loaded.soundAlerts, false); // customized
  assert.strictEqual(loaded.defaultCopyMode, 'full'); // customized
  assert.strictEqual(loaded.systemPrompt, SYSTEM_PROMPT_DEFAULT); // default preserved
});

test('Settings: saveSettings persists modified values to localStorage', async () => {
  storageMap.clear();
  const { saveSettings, loadSettings } = await import('../public/js/settings.js');

  saveSettings({
    autoCopy: false,
    autoPaste: false,
    soundAlerts: false,
    defaultCopyMode: 'full',
    systemPrompt: 'Custom test system prompt'
  });

  const stored = JSON.parse(storageMap.get('agentpipe_settings'));
  assert.strictEqual(stored.autoCopy, false);
  assert.strictEqual(stored.autoPaste, false);
  assert.strictEqual(stored.soundAlerts, false);
  assert.strictEqual(stored.defaultCopyMode, 'full');
  assert.strictEqual(stored.systemPrompt, 'Custom test system prompt');

  const reloaded = loadSettings();
  assert.strictEqual(reloaded.autoCopy, false);
  assert.strictEqual(reloaded.autoPaste, false);
  assert.strictEqual(reloaded.soundAlerts, false);
  assert.strictEqual(reloaded.defaultCopyMode, 'full');
  assert.strictEqual(reloaded.systemPrompt, 'Custom test system prompt');
});
