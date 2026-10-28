import './lib/settings.js';

const { DEFAULTS, normalize, enabledRulesets, isAllowlisted } = globalThis.LeanFBSettings;

const SETTINGS_KEY = 'settings';
const ALLOWLIST_RULE_ID_BASE = 1000;

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalize(stored[SETTINGS_KEY]);
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Turn the declarative rulesets on or off to match the current settings. */
async function applyRulesets(settings) {
  const desired = new Set(enabledRulesets(settings));
  const manifest = chrome.runtime.getManifest();
  const declared = (manifest.declarative_net_request?.rule_resources || []).map((r) => r.id);
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());

  const enableRulesetIds = declared.filter((id) => desired.has(id) && !current.has(id));
  const disableRulesetIds = declared.filter((id) => !desired.has(id) && current.has(id));

  if (!enableRulesetIds.length && !disableRulesetIds.length) return;
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
}

/** Allowlisted hosts get a higher priority allowAllRequests rule. */
async function applyAllowlist(settings) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const wanted = settings.allowlist
    .map((domain) => String(domain).toLowerCase().trim())
    .filter(Boolean);

  const rules = wanted.map((domain, index) => ({
    id: ALLOWLIST_RULE_ID_BASE + index,
    priority: 100,
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }));

  const removeRuleIds = existing.map((rule) => rule.id);
  if (!removeRuleIds.length && !rules.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
}

async function syncAll(settings) {
  await Promise.all([applyRulesets(settings), applyAllowlist(settings)]);
}

async function init() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  let settings = stored[SETTINGS_KEY];
  if (!settings) {
    settings = normalize(DEFAULTS);
    await saveSettings(settings);
  } else {
    settings = normalize(settings);
  }
  await syncAll(settings);
}

chrome.runtime.onInstalled.addListener(() => {
  init().catch((error) => console.error('[LeanFB] init failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  init().catch((error) => console.error('[LeanFB] startup sync failed', error));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const settings = normalize(changes[SETTINGS_KEY].newValue);
  syncAll(settings).catch((error) => console.error('[LeanFB] settings sync failed', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'lf-stats' && sender.tab?.id != null) {
    const count = Number(message.hidden) || 0;
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 999)) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    return;
  }

  if (message.type === 'lf-get-state') {
    (async () => {
      const settings = await loadSettings();
      const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
      sendResponse({ settings, enabledRulesets: enabled });
    })();
    return true;
  }

  if (message.type === 'lf-allowlist-toggle') {
    (async () => {
      const settings = await loadSettings();
      const host = String(message.host || '').toLowerCase();
      if (!host) return sendResponse({ ok: false });
      const index = settings.allowlist.indexOf(host);
      if (index >= 0) settings.allowlist.splice(index, 1);
      else settings.allowlist.push(host);
      await saveSettings(settings);
      sendResponse({ ok: true, allowlisted: index < 0 });
    })();
    return true;
  }

  if (message.type === 'lf-add-keyword') {
    (async () => {
      const settings = await loadSettings();
      const keyword = String(message.keyword || '').trim();
      if (!keyword) return sendResponse({ ok: false });
      if (!settings.filters.keywords.includes(keyword)) {
        settings.filters.keywords.push(keyword);
        await saveSettings(settings);
      }
      sendResponse({ ok: true, keywords: settings.filters.keywords });
    })();
    return true;
  }

  if (message.type === 'lf-is-allowlisted') {
    (async () => {
      const settings = await loadSettings();
      sendResponse({ allowlisted: isAllowlisted(settings, message.host) });
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
