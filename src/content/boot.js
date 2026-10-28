/*
 * LeanFB page controller (ISOLATED world).
 *
 * Cheap by design:
 *  - CSS does the heavy lifting; this file only flips classes on <html>.
 *  - The DOM observer is only attached when a text filter is actually active.
 *  - Scans are debounced and each feed unit is visited once.
 */
(() => {
  'use strict';

  const S = globalThis.LeanFBSettings;
  if (!S) return;

  const HIDE_CLASS = 'lf-hidden';
  // Older surfaces still expose aria-posinset. The current feed does not: a post
  // is a plain div whose only stable anchor is the h4 author heading, so units
  // are resolved from headings (see collectUnits).
  const LEGACY_UNIT_SELECTOR = 'div[aria-posinset]';

  const SPONSORED_SELECTOR = [
    'div[aria-posinset]:has(a[href*="ads/about"])',
    'div[aria-posinset]:has(a[aria-label="Sponsored"])',
  ].join(',');

  // Facebook labels ads in several ways. "Ad" and "Paid" always carry a
  // separator dot ("Ad · 🌐"). No leading word boundary is required because the
  // page name and the label are separate elements and their textContent can run
  // together ("Page nameAd · ...").
  const AD_LABEL_DOT_RE = /(?:Ad|Paid|Anzeige)\s*[·•∙‧]/;
  const AD_LABEL_WORDS = [
    'Sponsored',
    'Gesponsert',
    'Sponsorisé',
    'Patrocinado',
    'Publicidad',
    'Sponsorizzato',
    'Sponsrad',
    'Được tài trợ',
    '広告',
    '广告',
    '스폰서',
  ];

  // Feed column bounds, used to tell feed units apart from page chrome.
  const FEED_MIN_WIDTH = 400;
  const FEED_MAX_WIDTH = 900;

  let settings = S.normalize(null);
  let allowlisted = false;
  // Hidden units are counted per reason: the badge must not report suggestion
  // cards as blocked ads.
  let adsHidden = 0;
  let suggestionsHidden = 0;
  let keywordHidden = 0;

  /**
   * Facebook virtualises the feed: scrolling away and back re-creates the same
   * unit as a new element. Without this, one ad would be counted again every
   * time it is re-rendered.
   */
  const seenUnitKeys = new Set();

  // Ring buffer for the popup's activity log. Only fills when the user turns
  // recording on, so it costs nothing by default.
  const LOG_LIMIT = 200;
  let logEntries = [];

  function recordLog(entry) {
    if (!settings.ui.debugLog) return;
    logEntries.push(entry);
    if (logEntries.length > LOG_LIMIT) logEntries.shift();
  }
  let prunedCount = 0;
  let scanTimer = null;
  let statsTimer = null;
  let lastStatsAt = 0;
  let observer = null;
  let lastGesture = 0;

  let checkedUnits = new WeakSet();
  const observedUnits = new WeakSet();
  const checkCounts = new WeakMap();
  const knownCards = new WeakSet();
  const cardByHeading = new WeakMap();
  let unitObserver = null;
  let alive = true;

  // ----------------------------------------------------------- lifecycle

  /**
   * Reloading or updating the extension invalidates the running content
   * script's `chrome.*` APIs. Any later call throws "Extension context
   * invalidated", so stop everything instead of logging errors on every scan.
   */
  function shutdown() {
    if (!alive) return;
    alive = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (unitObserver) {
      unitObserver.disconnect();
      unitObserver = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }
    // Visible to the page so a stale content script can be diagnosed from the
    // console (and asserted in tests).
    try {
      window.postMessage({ __leanfb: 'shutdown' }, window.location.origin);
    } catch {
      /* nothing left to report to */
    }
  }

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function sendMessage(message) {
    if (!alive || !extensionAlive()) {
      shutdown();
      return;
    }
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending && typeof pending.catch === 'function') {
        // A missing receiver is normal (no one answers lf-stats); only a dead
        // extension context means this script is finished.
        pending.catch((error) => {
          if (String((error && error.message) || error).includes('Extension context invalidated')) {
            shutdown();
          }
        });
      }
    } catch (error) {
      shutdown();
    }
  }

  // ---------------------------------------------------------------- units

  /**
   * Resolve the post card for an author heading. A post header is ~48px and the
   * card is a few hundred, so the first ancestor taller than 100px is the card.
   * The result is cached per heading because getBoundingClientRect forces layout.
   */
  function postCardFor(heading) {
    const cached = cardByHeading.get(heading);
    if (cached && cached.isConnected) return cached;

    let node = heading.parentElement;
    while (node && node !== document.body) {
      if (node.getBoundingClientRect().height > 100) {
        cardByHeading.set(heading, node);
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function collectUnits() {
    const units = new Set();

    for (const element of document.querySelectorAll(LEGACY_UNIT_SELECTOR)) {
      units.add(element);
    }
    for (const heading of document.querySelectorAll('h4')) {
      const card = postCardFor(heading);
      if (card) units.add(card);
    }

    for (const unit of units) knownCards.add(unit);
    return units;
  }

  // ------------------------------------------------------------- classes

  /** Undo runtime hides so a settings change takes effect without a reload. */
  function resetRuntimeHides() {
    for (const element of document.querySelectorAll('.' + HIDE_CLASS)) {
      element.classList.remove(HIDE_CLASS);
    }
    checkedUnits = new WeakSet();
    adsHidden = 0;
    suggestionsHidden = 0;
    keywordHidden = 0;
    seenUnitKeys.clear();
  }

  function applyClasses() {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener('DOMContentLoaded', applyClasses, { once: true });
      return;
    }

    const active = settings.enabled && !allowlisted;
    const wanted = new Set(active ? S.classList(settings) : []);
    for (const className of Object.values(S.CLASS_MAP)) {
      root.classList.toggle(className, wanted.has(className));
    }
    root.classList.toggle('lf-off', !active);
    if (!active) resetRuntimeHides();
  }

  function postConfig() {
    const prune = settings.enabled && !allowlisted && settings.ads.pruneGraphql;
    window.postMessage({ __leanfb: 'config', prune }, window.location.origin);
  }

  // -------------------------------------------------------- text filter

  /**
   * Only user-supplied keywords live here. The built-in clutter filters are
   * structural, because Facebook localises every label and string matching
   * would only work for the languages we happen to list.
   */
  /**
   * Custom filter lines, matched against the post text *and* its link URLs:
   *
   *   crypto                    plain text, case-insensitive
   *   /giveaway|free\s+iphone/i JavaScript regex
   *   https://shop.example.com/*     glob, `*` becomes "anything"
   *
   * Invalid or oversized patterns are dropped rather than allowed to break the
   * scan.
   */
  function compileFilter(line) {
    const regexForm = line.match(/^\/(.+)\/([a-z]*)$/);
    if (regexForm) {
      if (regexForm[1].length > 300) return null;
      try {
        const flags = regexForm[2].includes('i') ? regexForm[2] : regexForm[2] + 'i';
        return { re: new RegExp(regexForm[1], flags) };
      } catch {
        return null;
      }
    }

    if (line.includes('*')) {
      if (line.length > 300) return null;
      const escaped = line.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return { re: new RegExp(escaped, 'i') };
    }

    return { text: line.toLowerCase() };
  }

  function activeFilters() {
    if (!settings.enabled || allowlisted) return [];
    const out = [];
    for (const raw of settings.filters.keywords) {
      const line = String(raw).trim();
      if (!line) continue;
      const compiled = compileFilter(line);
      if (compiled) out.push(compiled);
    }
    return out;
  }

  /**
   * Identity of a unit for deduplication. `textContent` starts with the SVG
   * <title> of every icon in the card, so the first 120 characters are the same
   * "FacebookFacebook..." string for every post - using it as a key collapsed
   * all hides into one. Strip that prefix before slicing.
   */
  function unitSignature(unit) {
    const text = (unit.textContent || '').replace(/\s+/g, ' ').trim();
    return text.replace(/^(?:Facebook\s*)+/i, '').slice(0, 160);
  }

  function hideUnit(unit, reason) {
    // Read the identity before collapsing the element.
    const key = unitSignature(unit);
    unit.classList.add(HIDE_CLASS);

    if (settings.ui.debugLog) {
      recordLog({ at: Date.now(), reason, source: 'dom', label: key.slice(0, 80) });
    }

    if (key) {
      if (seenUnitKeys.has(key)) return;
      if (seenUnitKeys.size > 500) seenUnitKeys.clear();
      seenUnitKeys.add(key);
    }

    if (reason === 'ad') adsHidden++;
    else if (reason === 'suggestion') suggestionsHidden++;
    else keywordHidden++;
  }

  // ------------------------------------------------------------ rail card

  /**
   * Facebook reserves the ad slot with an inline min-height on the right-rail
   * section, so hiding the ad card alone leaves a tall empty hole and the
   * "Sponsored" heading behind. Collapse the whole section instead.
   */
  function collapseRailAds() {
    const rail = document.querySelector('div[role="complementary"]');
    if (!rail) return;

    for (const section of rail.children) {
      if (section.hasAttribute('data-leanfb')) continue;
      const isAdSection = section.querySelector(
        '[attributionsrc], a[href*="ads/about"], a[href^="https://l.facebook.com"][target="_blank"]',
      );
      if (isAdSection) section.classList.add(HIDE_CLASS);
    }
  }

  /**
   * Facebook lets the user pick a theme independently of the OS, so
   * `prefers-color-scheme` is unreliable here. The body background is the
   * authoritative signal.
   */
  function pageIsDark() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const parts = bg.match(/\d+(\.\d+)?/g);
      if (!parts || parts.length < 3) return true;
      const [r, g, b] = parts.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    } catch {
      return true;
    }
  }

  function cardPalette(dark) {
    return dark
      ? {
          background: 'rgba(255,255,255,0.07)',
          border: '1px solid rgba(255,255,255,0.10)',
          text: '#e4e6eb',
          muted: 'rgba(228,230,235,0.62)',
          track: 'rgba(255,255,255,0.22)',
        }
      : {
          background: 'rgba(0,0,0,0.035)',
          border: '1px solid rgba(0,0,0,0.07)',
          text: '#050505',
          muted: 'rgba(5,5,5,0.58)',
          track: 'rgba(0,0,0,0.22)',
        };
  }

  function applyCardTheme(card) {
    const p = cardPalette(pageIsDark());
    card.style.background = p.background;
    card.style.border = p.border;
    card.style.color = p.text;

    for (const el of card.querySelectorAll('[data-leanfb="muted"]')) el.style.color = p.muted;

    const toggle = card.querySelector('[data-leanfb="toggle"]');
    const knob = card.querySelector('[data-leanfb="knob"]');
    if (toggle && knob) {
      const on = Boolean(settings.enabled) && !allowlisted;
      toggle.style.background = on ? '#2563eb' : p.track;
      knob.style.left = on ? '1.15em' : '0.15em';
    }
  }

  function toggleEnabled(event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      chrome.storage.local.get('settings').then((stored) => {
        const next = S.normalize(stored.settings);
        next.enabled = !next.enabled;
        return chrome.storage.local.set({ settings: next });
      }).catch(() => {});
    } catch {
      /* extension context gone */
    }
  }

  /**
   * Small status card for the space the ad slot used to occupy. Sized in em and
   * percentages so it follows the rail width on any screen.
   */
  function renderRailCard() {
    if (!settings.ui.railCard) return;

    const rail = document.querySelector('div[role="complementary"]');
    if (!rail) return;

    let card = rail.querySelector('[data-leanfb="rail-card"]');
    if (!card) {
      card = document.createElement('div');
      card.setAttribute('data-leanfb', 'rail-card');
      card.style.cssText = [
        'box-sizing:border-box',
        'width:100%',
        'padding:0.9em 1em',
        'margin:0',
        'border-radius:0.75em',
        'font-family:inherit',
        'font-size:0.8125rem',
        'line-height:1.35',
      ].join(';');

      // Divs, not spans: Facebook's rail CSS sets `display: none` on spans in
      // this position, which silently swallows the title row.
      card.innerHTML = [
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75em">',
        '<div style="font-weight:650;letter-spacing:-0.01em">LeanFB</div>',
        '<div data-leanfb="toggle" role="switch" tabindex="0" style="position:relative;width:2.2em;height:1.2em;border-radius:1em;cursor:pointer;flex:none">',
        '<div data-leanfb="knob" style="position:absolute;top:0.15em;left:1.15em;width:0.9em;height:0.9em;border-radius:50%;background:#fff;transition:left 120ms ease;box-shadow:0 1px 2px rgba(0,0,0,0.3)"></div>',
        '</div>',
        '</div>',
        '<div style="display:flex;gap:1.5em;margin-top:0.55em">',
        '<div><div data-leanfb="ads" style="font-size:1.6em;font-weight:650;line-height:1.1">0</div>',
        '<div data-leanfb="muted" style="font-size:0.85em">ads blocked</div></div>',
        '<div><div data-leanfb="suggestions" style="font-size:1.6em;font-weight:650;line-height:1.1">0</div>',
        '<div data-leanfb="muted" style="font-size:0.85em">suggestions</div></div>',
        '</div>',
      ].join('');

      const toggle = card.querySelector('[data-leanfb="toggle"]');
      toggle.addEventListener('click', toggleEnabled);
      toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') toggleEnabled(event);
      });

      rail.prepend(card);
    }

    const ads = card.querySelector('[data-leanfb="ads"]');
    const suggestions = card.querySelector('[data-leanfb="suggestions"]');
    if (ads) ads.textContent = String(adsBlocked());
    if (suggestions) suggestions.textContent = String(suggestionsHidden);

    const off = !settings.enabled || allowlisted;
    card.style.opacity = off ? '0.65' : '1';
    applyCardTheme(card);
  }

  function updateRail() {
    if (!settings.ui.railCard) {
      const card = document.querySelector('[data-leanfb="rail-card"]');
      if (card) card.remove();
      return;
    }

    // The card stays visible while the extension is off: it carries the switch
    // that turns it back on.
    if (settings.enabled && !allowlisted) collapseRailAds();
    renderRailCard();

    // The rail reserves the ad slot with a class-level min-height and clips its
    // overflow, so leaving it alone shows a tall empty column and collapsing it
    // to zero clips our card. Size it to the card instead.
    const rail = document.querySelector('div[role="complementary"]');
    if (!rail) return;
    const card = rail.querySelector('[data-leanfb="rail-card"]');
    const visible = [...rail.children].filter((child) => !child.classList.contains(HIDE_CLASS));
    const onlyCard = Boolean(card) && visible.length > 0 && visible.every((child) => child.hasAttribute('data-leanfb'));

    if (onlyCard) {
      const height = Math.ceil(card.getBoundingClientRect().height);
      if (height > 0) rail.style.setProperty('min-height', height + 'px', 'important');
    } else {
      rail.style.removeProperty('min-height');
    }
  }

  // --------------------------------------------------- suggested units

  /**
   * A real post always carries an h4 author heading; suggestion and netego
   * units in the feed do not. That distinction is language independent, unlike
   * matching "Suggested for you" / "Your group suggestions" strings.
   */
  function feedContainer() {
    const headings = [...document.querySelectorAll('h4')].filter(
      (heading) => heading.getBoundingClientRect().height > 0,
    );
    if (headings.length < 2) return null;

    let common = headings[0];
    for (const heading of headings) {
      while (common && !common.contains(heading)) common = common.parentElement;
      if (!common) return null;
    }
    return common;
  }

  function hideSuggestedUnits() {
    if (!settings.enabled || allowlisted) return;
    const wantGroups = settings.clutter.groupSuggestions;
    const wantPymk = settings.clutter.pymk;
    const wantSuggested = settings.clutter.suggested;
    if (!wantGroups && !wantPymk && !wantSuggested) return;

    const feed = feedContainer();
    if (!feed) return;

    for (const unit of feed.children) {
      if (unit.classList.contains(HIDE_CLASS)) continue;
      if (unit.querySelector('h4')) continue;

      const rect = unit.getBoundingClientRect();
      if (rect.height < 100) continue;
      if (rect.width < FEED_MIN_WIDTH || rect.width > FEED_MAX_WIDTH) continue;

      const hrefs = [...unit.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
      if (!hrefs.length) continue;

      // Classify the unit, then apply only its own toggle.
      if (hrefs.some((href) => href.startsWith('/groups/'))) {
        if (wantGroups) hideUnit(unit, 'suggestion');
      } else if (hrefs.some((href) => /^\/[^/?#]+\/?$/.test(href))) {
        if (wantPymk) hideUnit(unit, 'suggestion');
      } else if (wantSuggested) {
        hideUnit(unit, 'suggestion');
      }
    }
  }

  /** Ad label check over the header region only, to avoid body-text matches. */
  function looksLikeAdUnit(unit, head) {
    if (unit.querySelector('a[href*="ads/about"]')) return true;
    if (unit.querySelector('[attributionsrc]')) return true;

    // The current "Ad" label is icon-only: the text is CSS-generated, so it
    // never appears in textContent. Its anchor is a word-joiner-only link that
    // carries an ad tracking fragment. Organic posts have neither.
    if (unit.querySelector('a[href*="#?dhd"]')) return true;
    for (const anchor of unit.querySelectorAll('a')) {
      if ((anchor.textContent || '').trim() === '\u2060') return true;
    }

    const header = head.length > 160 ? head.slice(0, 160) : head;
    if (AD_LABEL_DOT_RE.test(header)) return true;
    for (const word of AD_LABEL_WORDS) {
      if (header.includes(word)) return true;
    }
    return false;
  }

  function scan() {
    if (!alive) return;
    const filters = activeFilters();
    const checkAds = settings.enabled && !allowlisted && settings.ads.sponsored;
    if (!filters.length && !checkAds) {
      hideSuggestedUnits();
      updateRail();
      return;
    }

    ensureUnitObserver();
    const units = collectUnits();
    let budget = 40;

    for (const unit of units) {
      if (!observedUnits.has(unit) && unitObserver) {
        observedUnits.add(unit);
        unitObserver.observe(unit);
      }
      if (checkedUnits.has(unit)) continue;
      if (budget-- <= 0) break;
      checkedUnits.add(unit);
      checkCounts.set(unit, (checkCounts.get(unit) || 0) + 1);

      // innerText is the rendered text: it leaves out the SVG <title> noise that
      // pollutes textContent ("FacebookFacebook..."), which matters when the
      // user is matching their own words. Only pay for it when filters exist.
      const text = filters.length ? unit.innerText || unit.textContent : unit.textContent;
      if (!text) continue;
      const textHead = text.length > 800 ? text.slice(0, 800) : text;

      // Filters also see the post's links, so a rule like `shop.example.com` or
      // `https://shop.example.com/*` can hide posts that point at a domain.
      let haystack = textHead;
      if (filters.length) {
        const hrefs = [...unit.querySelectorAll('a[href]')]
          .slice(0, 20)
          .map((a) => (a.getAttribute('href') || '').slice(0, 200));
        if (hrefs.length) haystack = (textHead + '\n' + hrefs.join('\n')).slice(0, 1400);
      }
      const lower = filters.some((filter) => filter.text) ? haystack.toLowerCase() : haystack;

      let reason = null;
      for (const filter of filters) {
        const hit = filter.re ? filter.re.test(haystack) : lower.includes(filter.text);
        if (hit) {
          reason = 'keyword';
          break;
        }
      }
      if (!reason && checkAds && looksLikeAdUnit(unit, textHead)) reason = 'ad';
      if (reason) hideUnit(unit, reason);
    }

    hideSuggestedUnits();
    updateRail();
  }

  /**
   * Facebook can attach the ad label after the unit is inserted. One shared
   * observer re-queues a unit when it scrolls into view, so a late label is
   * still caught without scanning the whole feed repeatedly.
   */
  function ensureUnitObserver() {
    if (unitObserver || typeof IntersectionObserver === 'undefined') return;
    unitObserver = new IntersectionObserver((entries) => {
      if (!needsScan()) return;
      let dirty = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target.classList.contains(HIDE_CLASS)) continue;
        if (checkedUnits.delete(entry.target)) dirty = true;
      }
      if (dirty) scheduleScan();
    }, { rootMargin: '200px' });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
      scheduleStats();
    }, 400);
  }

  function needsScan() {
    if (!settings.enabled || allowlisted) return false;
    return (
      settings.ads.sponsored ||
      settings.clutter.suggested ||
      settings.clutter.pymk ||
      settings.clutter.groupSuggestions ||
      settings.ui.railCard ||
      activeFilters().length > 0
    );
  }

  function syncObserver() {
    const needed = needsScan();
    const root = document.documentElement;
    if (needed && !observer && root) {
      observer = new MutationObserver((records) => {
        // A unit whose own subtree changed may have just received its ad label,
        // so let it be inspected again. Capped per unit to bound the work.
        for (const record of records) {
          if (record.type !== 'childList') continue;
          let node = record.target;
          if (!(node instanceof Element)) continue;
          while (node && node !== document.body) {
            if (knownCards.has(node)) {
              if ((checkCounts.get(node) || 0) < 3) checkedUnits.delete(node);
              break;
            }
            node = node.parentElement;
          }
        }
        scheduleScan();
      });
      observer.observe(root, { childList: true, subtree: true });
    } else if (!needed && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // -------------------------------------------------------------- stats

  function countSponsored() {
    try {
      return document.querySelectorAll(SPONSORED_SELECTOR).length;
    } catch {
      return 0;
    }
  }

  /**
   * Total ads prevented from appearing. Ads removed from the GraphQL payload
   * never become DOM nodes, so the DOM query alone would always read zero once
   * the network layer is working.
   */
  /**
   * Ads actually blocked: pruned from the payload, hidden by ad markers, or
   * caught by the legacy selector. Suggestion units are counted separately so
   * the number never overstates ad blocking.
   */
  function adsBlocked() {
    return countSponsored() + adsHidden + prunedCount;
  }

  function totalHidden() {
    return adsBlocked() + suggestionsHidden + keywordHidden;
  }

  function scheduleStats() {
    if (!alive) return;
    if (statsTimer) return;
    if (!settings.enabled || allowlisted) return;
    // Counting runs a :has() query over the feed, so keep it to one pass per
    // few seconds instead of following every scroll event.
    if (Date.now() - lastStatsAt < 4000) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      lastStatsAt = Date.now();
      if (!alive || document.visibilityState === 'hidden') return;
      sendMessage({ type: 'lf-stats', hidden: totalHidden() });
    }, 1500);
  }

  // ----------------------------------------------------------- autoplay

  function markGesture() {
    lastGesture = Date.now();
  }

  function onPlay(event) {
    if (!alive) return;
    if (!settings.perf.pauseAutoplay || allowlisted || !settings.enabled) return;
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    // Only muted media is treated as autoplay; unmuted playback is deliberate.
    if (!media.muted) return;
    if (Date.now() - lastGesture < 1200) return;
    try {
      media.pause();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------- init

  async function load() {
    try {
      const stored = await chrome.storage.local.get('settings');
      settings = S.normalize(stored.settings);
      allowlisted = S.isAllowlisted(settings, location.hostname);
      applyClasses();
      postConfig();
      syncObserver();
      scheduleScan();
      scheduleStats();
    } catch {
      // The extension was reloaded or removed before this script finished.
      shutdown();
    }
  }

  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
    window.addEventListener(type, markGesture, { capture: true, passive: true });
  }
  document.addEventListener('play', onPlay, true);
  window.addEventListener('scroll', scheduleStats, { passive: true });

  window.addEventListener('message', (event) => {
    if (!alive || event.source !== window) return;
    const data = event.data;
    if (!data || data.__leanfb !== 'hits') return;
    const count = Number(data.count) || 0;
    prunedCount += count;
    recordLog({ at: Date.now(), reason: 'ad', source: 'api', label: count + ' from payload' });
    scheduleStats();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!alive || area !== 'local' || !changes.settings) return;
      settings = S.normalize(changes.settings.newValue);
      allowlisted = S.isAllowlisted(settings, location.hostname);
      if (!settings.ui.debugLog) logEntries = [];
      resetRuntimeHides();
      applyClasses();
      postConfig();
      syncObserver();
      scheduleScan();
      scheduleStats();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!alive || !message) return;

      if (message.type === 'lf-get-log') {
        sendResponse({ entries: logEntries.slice(-60), recording: Boolean(settings.ui.debugLog) });
        return true;
      }
      if (message.type === 'lf-clear-log') {
        logEntries = [];
        sendResponse({ ok: true });
        return true;
      }
      if (message.type !== 'lf-get-stats') return;
      sendResponse({
        hidden: totalHidden(),
        ads: adsBlocked(),
        suggestions: suggestionsHidden,
        pruned: prunedCount,
        allowlisted,
      });
      return true;
    });
  } catch {
    shutdown();
  }

  load();
})();
