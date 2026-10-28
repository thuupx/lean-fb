/**
 * Shared settings schema. Loaded both by the service worker (as a module)
 * and by content scripts (as a classic script) so the defaults live in one place.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    ads: {
      sponsored: true,
      pruneGraphql: true,
      rightRail: true,
      marketplace: true,
    },
    clutter: {
      stories: true,
      reels: false,
      watch: false,
      pymk: true,
      suggested: true,
      groupSuggestions: true,
      leftRail: false,
    },
    net: {
      adEndpoints: true,
      telemetry: true,
      thirdParty: false,
    },
    perf: {
      pauseAutoplay: true,
      reduceAnimations: false,
    },
    ui: {
      railCard: true,
      debugLog: false,
    },
    filters: {
      keywords: [],
    },
    allowlist: [],
  };

  /** Settings path -> CSS class applied on <html>. */
  const CLASS_MAP = {
    'ads.sponsored': 'lf-sponsored',
    'ads.rightRail': 'lf-rightrail',
    'ads.marketplace': 'lf-marketplace',
    'clutter.stories': 'lf-stories',
    'clutter.reels': 'lf-reels',
    'clutter.watch': 'lf-watch',
    'clutter.pymk': 'lf-pymk',
    'clutter.suggested': 'lf-suggested',
    'clutter.leftRail': 'lf-leftrail',
    'perf.reduceAnimations': 'lf-anim',
  };

  /** Settings path -> declarativeNetRequest static ruleset id. */
  const RULESET_MAP = {
    'net.adEndpoints': 'ads',
    'net.telemetry': 'telemetry',
    'net.thirdParty': 'thirdparty',
  };

  /**
   * One-click setups. Only the feature groups are preset; allowlist, keywords
   * and interface choices are left alone.
   */
  const PRESETS = {
    light: {
      ads: { sponsored: true, pruneGraphql: true, rightRail: true, marketplace: false },
      clutter: {
        stories: false,
        reels: false,
        watch: false,
        pymk: false,
        suggested: false,
        groupSuggestions: false,
        leftRail: false,
      },
      net: { adEndpoints: true, telemetry: false, thirdParty: false },
      perf: { pauseAutoplay: false, reduceAnimations: false },
    },
    balanced: {
      ads: { sponsored: true, pruneGraphql: true, rightRail: true, marketplace: true },
      clutter: {
        stories: true,
        reels: false,
        watch: false,
        pymk: true,
        suggested: true,
        groupSuggestions: true,
        leftRail: false,
      },
      net: { adEndpoints: true, telemetry: true, thirdParty: false },
      perf: { pauseAutoplay: true, reduceAnimations: false },
    },
    aggressive: {
      ads: { sponsored: true, pruneGraphql: true, rightRail: true, marketplace: true },
      clutter: {
        stories: true,
        reels: true,
        watch: true,
        pymk: true,
        suggested: true,
        groupSuggestions: true,
        leftRail: true,
      },
      net: { adEndpoints: true, telemetry: true, thirdParty: true },
      perf: { pauseAutoplay: true, reduceAnimations: true },
    },
  };

  function applyPreset(settings, name) {
    const preset = PRESETS[name];
    if (!preset) return settings;
    for (const group of Object.keys(preset)) {
      Object.assign(settings[group], preset[group]);
    }
    return settings;
  }

  /** Name of the preset this settings object currently matches, or null. */
  function matchPreset(settings) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      let same = true;
      for (const group of Object.keys(preset)) {
        for (const key of Object.keys(preset[group])) {
          if (settings[group][key] !== preset[group][key]) {
            same = false;
            break;
          }
        }
        if (!same) break;
      }
      if (same) return name;
    }
    return null;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function get(obj, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }

  function set(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((acc, key) => {
      if (typeof acc[key] !== 'object' || acc[key] === null) acc[key] = {};
      return acc[key];
    }, obj);
    target[last] = value;
  }

  /** Merge stored settings over defaults, dropping unknown keys. */
  function normalize(stored) {
    const out = clone(DEFAULTS);
    if (!stored || typeof stored !== 'object') return out;
    (function merge(dst, src) {
      for (const key of Object.keys(dst)) {
        if (!(key in src)) continue;
        const dv = dst[key];
        const sv = src[key];
        if (Array.isArray(dv)) {
          if (Array.isArray(sv)) dst[key] = sv.filter((v) => typeof v === 'string');
        } else if (dv && typeof dv === 'object') {
          if (sv && typeof sv === 'object' && !Array.isArray(sv)) merge(dv, sv);
        } else if (typeof sv === typeof dv) {
          dst[key] = sv;
        }
      }
    })(out, stored);
    return out;
  }

  function classList(settings) {
    const classes = [];
    for (const [path, className] of Object.entries(CLASS_MAP)) {
      if (get(settings, path)) classes.push(className);
    }
    return classes;
  }

  function enabledRulesets(settings) {
    const ids = [];
    for (const [path, rulesetId] of Object.entries(RULESET_MAP)) {
      if (get(settings, path)) ids.push(rulesetId);
    }
    return ids;
  }

  function isAllowlisted(settings, hostname) {
    if (!settings || !Array.isArray(settings.allowlist)) return false;
    const host = String(hostname || '').toLowerCase();
    return settings.allowlist.some((entry) => {
      const domain = String(entry).toLowerCase().replace(/^\./, '');
      return host === domain || host.endsWith('.' + domain);
    });
  }

  root.LeanFBSettings = {
    DEFAULTS,
    PRESETS,
    CLASS_MAP,
    RULESET_MAP,
    normalize,
    applyPreset,
    matchPreset,
    classList,
    enabledRulesets,
    isAllowlisted,
    get,
    set,
    clone,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
