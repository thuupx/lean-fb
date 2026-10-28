/*
 * LeanFB response pruning (MAIN world).
 *
 * Runs at document_start, before any Facebook script, so the XHR/fetch hooks
 * are in place when Relay issues its first GraphQL call.
 *
 * Facebook ships sponsored stories inside the same GraphQL payload as organic
 * ones, so the request cannot be blocked at the network layer. Instead we drop
 * the sponsored nodes from the JSON before React ever sees them. The ad is
 * never rendered and its creative is never downloaded, which is the single
 * biggest saving this extension makes.
 *
 * The hook is guarded by a substring check, so responses without ad markers
 * are never parsed or copied.
 */
(() => {
  'use strict';

  // The stable marker. Facebook rotates the *field name* that holds it
  // (`sponsored_data`, `th_dat_spo`, ...), but the `__typename` value has stayed
  // constant and only appears when an ad is present: 1 of 13 GraphQL responses
  // in a captured HAR, 0 of 12 in a session without ads.
  const AD_TYPENAME = 'SponsoredData';

  // Substrings that justify a parse. Kept narrow on purpose: a marker that also
  // appears on organic payloads would make every feed response pay the cost.
  const MARKERS = [
    'SponsoredData',
    'MarketplaceFeedAdStory',
    'SEARCH_ADS',
    'VideoHomeFeedUnitSectionComponent',
  ];

  const state = {
    enabled: true,
    maxBytes: 4 * 1024 * 1024,
    hits: 0,
    // Instrumentation: tells "no ad was served" apart from "the hook never ran".
    seen: 0,
    marked: 0,
    parseFailures: 0,
    rewrote: 0,
  };

  function isGraphql(url) {
    if (typeof url !== 'string') return false;
    return url.includes('/graphql');
  }

  function looksInteresting(text) {
    for (let i = 0; i < MARKERS.length; i++) {
      if (text.includes(MARKERS[i])) return true;
    }
    return false;
  }

  /** Does this value contain a sponsored node anywhere inside it? */
  function containsAd(value, depth) {
    if (!value || typeof value !== 'object' || depth > 10) return false;
    if (value.__typename === AD_TYPENAME) return true;
    if (value.role === 'SEARCH_ADS') return true;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (containsAd(value[i], depth + 1)) return true;
      }
      return false;
    }
    for (const key in value) {
      if (containsAd(value[key], depth + 1)) return true;
    }
    return false;
  }

  function report(count) {
    state.hits += count;
    try {
      window.postMessage({ __leanfb: 'hits', count }, window.location.origin);
    } catch {
      /* postMessage is best effort */
    }
  }

  /** First `edges` array found in the object, in document order. */
  function findEdges(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      for (const key in node) {
        const value = node[key];
        if (key === 'edges' && Array.isArray(value)) return value;
        stack.push(value);
      }
    }
    return null;
  }

  /**
   * Facebook serves the feed as newline-delimited JSON (Relay incremental
   * delivery) with a `text/html` content type, so parsing the body as one JSON
   * document always fails. Each line is parsed on its own.
   *
   * Line 0 carries the initial `...news_feed.edges` array. Every later line is a
   * patch: `{ label, path: [..., 'edges', i], data: <edge> }`. Removing an ad
   * from either place shifts the indices, so later patches are renumbered to
   * keep the array contiguous.
   */
  function pruneText(text) {
    state.seen++;
    if (!looksInteresting(text)) return null;
    state.marked++;

    const rawLines = text.split('\n');
    const lines = [];
    for (const raw of rawLines) {
      if (!raw.trim()) {
        lines.push(null);
        continue;
      }
      try {
        lines.push(JSON.parse(raw));
      } catch {
        // Not JSONL after all; leave the body alone rather than risk a rewrite.
        state.parseFailures++;
        return null;
      }
    }

    let removed = 0;

    const initial = lines[0];
    const edges = initial && typeof initial === 'object' ? findEdges(initial) : null;
    const removedInitial = new Set();
    if (edges) {
      for (let i = edges.length - 1; i >= 0; i--) {
        if (containsAd(edges[i], 0)) {
          removedInitial.add(i);
          edges.splice(i, 1);
          removed++;
        }
      }
    }

    const removedPatches = new Set();
    const shiftFor = (index) => {
      let shift = 0;
      for (const i of removedInitial) if (i < index) shift++;
      for (const i of removedPatches) if (i < index) shift++;
      return shift;
    };

    for (let n = 1; n < lines.length; n++) {
      const patch = lines[n];
      if (!patch || typeof patch !== 'object') continue;
      const path = patch.path;
      const isEdgePatch = Array.isArray(path) && path.length >= 2 && path[path.length - 2] === 'edges';
      const index = isEdgePatch ? path[path.length - 1] : null;

      if (isEdgePatch && containsAd(patch.data, 0)) {
        removedPatches.add(index);
        lines[n] = null;
        removed++;
        continue;
      }
      if (isEdgePatch && typeof index === 'number') {
        patch.path[path.length - 1] = index - shiftFor(index);
      }
    }

    if (!removed) return null;
    state.rewrote++;

    const out = [];
    for (const line of lines) {
      if (line === null) continue;
      out.push(JSON.stringify(line));
    }
    report(removed);
    return out.join('\n');
  }

  /** Prune a response the page already parsed (responseType === 'json'). */
  function pruneObject(root) {
    let removed = 0;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          if (containsAd(node[i], 0)) {
            node.splice(i, 1);
            removed++;
          } else {
            stack.push(node[i]);
          }
        }
      } else {
        for (const key in node) stack.push(node[key]);
      }
    }
    if (removed) report(removed);
    return removed;
  }

  // ---------------------------------------------------------------- XHR

  const proto = XMLHttpRequest.prototype;
  const rawOpen = proto.open;
  const rawText = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const rawResponse = Object.getOwnPropertyDescriptor(proto, 'response');

  // Exposed for __leanfbDiagnose; a patch that silently fails to install is the
  // difference between working and not working at all.
  const patches = { open: false, responseText: false, response: false, instanceChecked: false, instance: false, fetch: false };
  window.__leanfbPatches = patches;

  /**
   * Facebook restores the native `responseText` getter shortly after
   * document_start, so a prototype-level patch does not survive. Defining the
   * accessor on the request instance at readyState 4 is not reverted and still
   * happens before the page's `onload` handler reads the body.
   */
  function installInstancePrune(xhr) {
    patches.instanceChecked = true;
    try {
      const type = xhr.responseType;
      if (type === '' || type === 'text') {
        const native = rawText.get.call(xhr);
        if (typeof native !== 'string' || native.length > state.maxBytes) return;
        const out = pruneText(native);
        if (out == null) return;
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get() {
            return out;
          },
        });
        patches.instance = true;
      } else if (type === 'json') {
        if (xhr.__lfJsonDone) return;
        xhr.__lfJsonDone = true;
        const value = rawResponse.get.call(xhr);
        if (!value || typeof value !== 'object') return;
        const removed = pruneObject(value);
        if (!removed) return;
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get() {
            return value;
          },
        });
        patches.instance = true;
      }
    } catch {
      /* leave the request untouched */
    }
  }

  function onReadyStateChange() {
    if (this.readyState !== 4) return;
    if (!state.enabled) return;
    installInstancePrune(this);
  }

  proto.open = function open(method, url) {
    this.__lfUrl = typeof url === 'string' ? url : String(url);
    // Registered inside open(), so it runs before any handler the page assigns
    // afterwards.
    if (isGraphql(this.__lfUrl)) {
      this.addEventListener('readystatechange', onReadyStateChange);
    }
    return rawOpen.apply(this, arguments);
  };
  patches.open = true;

  if (rawText && rawText.get) {
    Object.defineProperty(proto, 'responseText', {
      configurable: true,
      enumerable: rawText.enumerable,
      get() {
        const value = rawText.get.call(this);
        if (!state.enabled || typeof value !== 'string') return value;
        if (!isGraphql(this.__lfUrl) || value.length > state.maxBytes) return value;

        const cache = this.__lfCache;
        if (cache && cache.raw === value) return cache.out;

        const out = pruneText(value);
        this.__lfCache = { raw: value, out: out == null ? value : out };
        return this.__lfCache.out;
      },
    });
    patches.responseText = true;
  }

  if (rawResponse && rawResponse.get) {
    Object.defineProperty(proto, 'response', {
      configurable: true,
      enumerable: rawResponse.enumerable,
      get() {
        const value = rawResponse.get.call(this);
        if (!state.enabled || this.responseType !== 'json') return value;
        if (!value || typeof value !== 'object') return value;
        if (!isGraphql(this.__lfUrl)) return value;
        if (this.__lfJsonDone) return value;

        this.__lfJsonDone = true;
        try {
          const removed = pruneObject(value);
          if (removed) report(removed);
        } catch {
          /* leave the payload untouched */
        }
        return value;
      },
    });
    patches.response = true;
  }

  // -------------------------------------------------------------- fetch

  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function fetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const pending = rawFetch.apply(this, arguments);

      if (!state.enabled || !isGraphql(url)) return pending;

      return pending.then(async (response) => {
        try {
          // Facebook serves GraphQL as text/html even though the body is JSONL.
          const declared = Number(response.headers.get('content-length') || 0);
          if (declared > state.maxBytes) return response;

          const text = await response.clone().text();
          if (text.length > state.maxBytes || !looksInteresting(text)) return response;

          const out = pruneText(text);
          if (out == null) return response;

          const headers = new Headers(response.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          return new Response(out, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch {
          return response;
        }
      });
    };
    patches.fetch = true;
  }

  // ------------------------------------------------------------- config

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__leanfb !== 'config') return;
    if (typeof data.prune === 'boolean') state.enabled = data.prune;
    if (typeof data.maxBytes === 'number' && data.maxBytes > 0) state.maxBytes = data.maxBytes;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__leanfb !== 'ping') return;
    window.postMessage({ __leanfb: 'pong', hits: state.hits, enabled: state.enabled }, window.location.origin);
  });

  // --------------------------------------------------------- diagnostics

  /**
   * Run `__leanfbDiagnose()` in the page console when an ad survives.
   * Returns structure only: tag names, ARIA roles and labels, never post text.
   */
  window.__leanfbDiagnose = function diagnose() {
    const LABELS = new Set(['Ad', 'Sponsored', 'Paid', 'Anzeige', 'Được tài trợ']);
    const AD_DOT = /(?:Ad|Paid)\s*[·•∙‧]/;

    const describe = (node) => {
      const parts = [node.tagName];
      const role = node.getAttribute('role');
      const posinset = node.getAttribute('aria-posinset');
      const label = node.getAttribute('aria-label');
      if (role) parts.push('[role=' + role + ']');
      if (posinset) parts.push('[posinset=' + posinset + ']');
      if (label) parts.push('[aria-label=' + label.slice(0, 40) + ']');
      if (node.hasAttribute('attributionsrc')) parts.push('[attributionsrc]');
      return parts.join('');
    };

    const cardFor = (heading) => {
      let node = heading.parentElement;
      while (node && node !== document.body) {
        if (node.getBoundingClientRect().height > 100) return node;
        node = node.parentElement;
      }
      return null;
    };

    const cards = new Set();
    for (const heading of document.querySelectorAll('h4')) {
      const card = cardFor(heading);
      if (card) cards.add(card);
    }

    const adCards = [];
    for (const card of cards) {
      const head = (card.textContent || '').slice(0, 200);
      const isAd = AD_DOT.test(head) || [...LABELS].some((w) => head.includes(w)) ||
        Boolean(card.querySelector('a[href*="ads/about"]')) ||
        Boolean(card.querySelector('[attributionsrc]'));
      if (isAd) adCards.push({ h: Math.round(card.getBoundingClientRect().height), head: head.slice(0, 60) });
    }

    const labels = [];
    for (const element of document.querySelectorAll('a,span,div')) {
      const text = (element.textContent || '').trim();
      if (!LABELS.has(text)) continue;
      if (element.children.length > 2) continue;

      const chain = [];
      let node = element;
      for (let i = 0; i < 7 && node; i++) {
        chain.push(describe(node));
        node = node.parentElement;
      }
      labels.push({ text, chain });
      if (labels.length >= 5) break;
    }

    const result = {
      url: location.pathname,
      patches: window.__leanfbPatches || null,
      prunedHits: state.hits,
      pruneStats: {
        responses: state.seen,
        withMarker: state.marked,
        parseFailures: state.parseFailures,
        rewritten: state.rewrote,
      },
      legacyUnits: document.querySelectorAll('div[aria-posinset]').length,
      headings: document.querySelectorAll('h4').length,
      cards: cards.size,
      adCards,
      labels,
    };
    console.log('[LeanFB] diagnose', JSON.stringify(result, null, 2));
    return result;
  };
})();
