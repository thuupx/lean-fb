'use strict';

const S = globalThis.LeanFBSettings;
const SETTINGS_KEY = 'settings';

let settings = S.normalize(null);
let activeTab = null;

function inputFor(path) {
  return document.querySelector(`input[data-path="${path}"]`);
}

function renderPresets() {
  const active = S.matchPreset(settings);
  for (const button of document.querySelectorAll('.presets button')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === active));
  }
}

function render() {
  for (const input of document.querySelectorAll('input[data-path]')) {
    input.checked = Boolean(S.get(settings, input.dataset.path));
  }
  document.getElementById('keywords').value = (settings.filters.keywords || []).join('\n');
  document.body.classList.toggle('is-off', !settings.enabled);
  renderPresets();
}

async function save() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function loadStats() {
  if (!activeTab || !activeTab.url || !activeTab.url.includes('facebook.com')) {
    document.getElementById('status').textContent = 'Open facebook.com to use LeanFB';
    return;
  }

  try {
    const stats = await chrome.tabs.sendMessage(activeTab.id, { type: 'lf-get-stats' });
    document.getElementById('ads-count').textContent = stats?.ads ?? 0;
    document.getElementById('suggestions-count').textContent = stats?.suggestions ?? 0;
    setAllowlistButton(Boolean(stats?.allowlisted));
  } catch {
    // No content script yet (page loaded before install, or a non-feed page).
    document.getElementById('ads-count').textContent = '0';
    document.getElementById('suggestions-count').textContent = '0';
  }
}

function setAllowlistButton(allowlisted) {
  const button = document.getElementById('allowlist');
  button.textContent = allowlisted ? 'Allowlisted' : 'Allowlist site';
  button.setAttribute('aria-pressed', String(allowlisted));
}

function invalidPatterns(lines) {
  const bad = [];
  for (const line of lines) {
    const match = line.match(/^\/(.+)\/([a-z]*)$/);
    if (!match) continue;
    try {
      new RegExp(match[1], match[2]);
    } catch {
      bad.push(line);
    }
  }
  return bad;
}

function showFilterErrors() {
  const field = document.getElementById('filter-error');
  if (!field) return;
  const lines = document.getElementById('keywords').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = invalidPatterns(lines);
  field.textContent = bad.length ? 'Invalid regex (ignored): ' + bad.join(', ') : '';
}

function formatTime(ms) {
  try {
    return new Date(ms).toTimeString().slice(0, 8);
  } catch {
    return '--:--:--';
  }
}

function renderLog(entries) {
  const list = document.getElementById('log-list');
  if (!list) return;

  if (!entries.length) {
    list.innerHTML = '<div class="log-empty">Nothing recorded yet. Scroll the feed.</div>';
    return;
  }

  list.innerHTML = '';
  for (const entry of entries.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'log-row';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.at);

    const source = document.createElement('span');
    source.className = 'log-src';
    source.dataset.src = entry.source;
    source.textContent = entry.source === 'api' ? 'API' : 'DOM';

    const label = document.createElement('span');
    label.className = 'log-label';
    label.textContent = entry.label || entry.reason;
    label.title = label.textContent;

    row.append(time, source, label);
    list.append(row);
  }
}

async function loadLog() {
  const wrap = document.getElementById('log-wrap');
  if (!wrap) return;

  wrap.hidden = !settings.ui.debugLog;
  if (!settings.ui.debugLog || !activeTab?.id) return;

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'lf-get-log' });
    renderLog(response?.entries || []);
  } catch {
    renderLog([]);
  }
}

function bindPresets() {
  for (const button of document.querySelectorAll('.presets button')) {
    button.addEventListener('click', async () => {
      S.applyPreset(settings, button.dataset.preset);
      await save();
      render();
    });
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function bindToggles() {
  for (const input of document.querySelectorAll('input[data-path]')) {
    input.addEventListener('change', () => {
      S.set(settings, input.dataset.path, input.checked);
      document.body.classList.toggle('is-off', !settings.enabled);
      renderPresets();
      save();
      if (input.dataset.path === 'ui.debugLog') loadLog();
    });
  }

  const keywords = document.getElementById('keywords');
  keywords.addEventListener('change', () => {
    settings.filters.keywords = keywords.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    showFilterErrors();
    save();
  });

  document.getElementById('allowlist').addEventListener('click', async () => {
    const host = hostOf(activeTab?.url || '');
    if (!host) return;
    const response = await chrome.runtime.sendMessage({ type: 'lf-allowlist-toggle', host });
    setAllowlistButton(Boolean(response?.allowlisted));
    if (activeTab?.id != null) chrome.tabs.reload(activeTab.id);
  });

  document.getElementById('reload').addEventListener('click', () => {
    if (activeTab?.id != null) chrome.tabs.reload(activeTab.id);
  });

  document.getElementById('pick').addEventListener('click', async () => {
    if (activeTab?.id == null) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['src/content/picker.js'],
      });
      window.close();
    } catch {
      document.getElementById('status').textContent = 'Open a facebook.com page first';
    }
  });
}

async function init() {
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = S.normalize(stored[SETTINGS_KEY]);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  const host = hostOf(activeTab?.url || '');
  document.getElementById('site-host').textContent = host || 'facebook.com';
  if (host) setAllowlistButton(S.isAllowlisted(settings, host));

  render();
  bindToggles();
  bindPresets();
  showFilterErrors();
  loadStats();
  loadLog();

  const clear = document.getElementById('log-clear');
  if (clear) {
    clear.addEventListener('click', async () => {
      if (activeTab?.id == null) return;
      try {
        await chrome.tabs.sendMessage(activeTab.id, { type: 'lf-clear-log' });
      } catch {
        /* no content script */
      }
      loadLog();
    });
  }

  setInterval(loadLog, 2000);
}

init().catch((error) => console.error('[LeanFB] popup failed', error));
