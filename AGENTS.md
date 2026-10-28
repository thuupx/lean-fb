# Project notes for agents

LeanFB is a plain MV3 extension. There is no build step, no bundler and no runtime
dependencies. Editing a file is enough; reload the extension in `chrome://extensions`
to pick it up.

## Layout

- `manifest.json` - MV3 manifest. `world: "MAIN"` requires Chrome 111+.
- `rules/*.json` - declarativeNetRequest static rulesets, one per network feature.
- `src/lib/settings.js` - single source of truth for defaults, CSS class mapping and
  ruleset mapping. Loaded as a classic script by content scripts and as a module
  side-effect import by the service worker. Keep it dependency free.
- `src/background.js` - service worker. Syncs rulesets and allowlist rules to
  `storage.local`, sets the badge.
- `src/content/cosmetic.css` - every cosmetic rule is gated by `html.lf-*`. Add new
  features as a new class plus an entry in `CLASS_MAP`.
- `src/content/boot.js` - ISOLATED world controller.
  - Built-in clutter filters must be **structural**, never text based: Facebook
    localises every label. A real post (organic or sponsored) always has an `h4`
    author heading; suggestion units do not, and are then classified by link target
    (`/groups/`, profile URLs). Do not add label strings for these features.
  - `filters.keywords` is the only text matching left, and it is user-supplied.
  - The right rail reserves its ad slot with a class-level `min-height` and clips with
    `overflow: hidden`. Hiding the ad section is not enough; the rail is sized to the
    replacement card's measured height. Facebook's rail CSS also sets
    `display: none` on bare `<span>` elements there, so the card uses `<div>` only.
- `src/content/prune.js` - MAIN world XHR/fetch hook. Must stay before page scripts.
  Facts that shape it, all measured on real captures:
  - The feed body is **newline-delimited JSON** (12 lines), not one JSON document, and
    is served as `text/html`. Parse per line; never `JSON.parse` the whole body.
  - The field holding the ad marker rotates per session (`th_dat_spo`,
    `sponsored_data`, ...). Key on `__typename === "SponsoredData"`, which appeared in
    1 of 13 ad-session responses and 0 of 12 clean ones.
  - Removing an edge from the initial `edges` array or dropping a patch line shifts the
    indices, so later `path: [..., 'edges', i]` patches must be renumbered.
  - The feed uses XHR, not fetch.
  - Facebook restores the native `responseText` getter after `document_start`. The
    working hook is the per-instance accessor installed at `readyState === 4`; do not
    rely on the prototype getter. `window.__leanfbPatches` reports which hooks
    installed.
- `src/content/picker.js` - injected on demand only.
- `src/ui/` - popup.

## Conventions

- Content scripts are classic scripts (no `import`). Share code through
  `globalThis.LeanFBSettings` only.
- Never call a `chrome.*` API in a content script without a guard. Reloading or
  updating the extension invalidates the running script's context and every later call
  throws `Extension context invalidated`. `boot.js` keeps an `alive` flag, routes all
  messaging through `sendMessage()`, and tears down observers and timers in
  `shutdown()`. A rejected send is only fatal when the message says the context was
  invalidated; a missing receiver is normal.
- Never add a permission that is not strictly needed. Network blocking works without
  host permissions because `declarativeNetRequest` grants implicit block/allow access.
- Scope DNR rules with `initiatorDomains: ["facebook.com"]` so the extension stays
  Facebook-only.
- Prefer `height: 0; overflow: hidden` over `display: none` for feed units, to keep
  Facebook's virtualised list stable.

## Verifying

Syntax and JSON:

```bash
node --check src/content/boot.js
node --check src/content/prune.js
node --check src/content/picker.js
node --check src/ui/popup.js
node --check src/lib/settings.js
cp src/background.js /tmp/bg.mjs && node --check /tmp/bg.mjs
node -e "JSON.parse(require('fs').readFileSync('manifest.json'))"
```

Manual load (Chrome for Testing, because branded Chrome 137+ ignores
`--load-extension`):

```bash
"/path/to/chrome-for-testing" \
  --load-extension="$PWD" \
  --user-data-dir=/tmp/leanfb-profile \
  --remote-debugging-port=9222
```

To exercise the content scripts against a local fixture, copy the extension to a temp
directory and add `http://localhost/*` to `content_scripts[].matches` and
`host_permissions` in the copy. Never add localhost to the shipped manifest.

Useful checks from the service worker target over CDP:

- `chrome.declarativeNetRequest.getEnabledRulesets()`
- `chrome.declarativeNetRequest.getDisabledRuleIds({rulesetId: 'ads'})` - empty means
  every rule parsed
- `chrome.declarativeNetRequest.testMatchOutcome({url, initiator, type, method})` -
  needs `declarativeNetRequestFeedback`, so add it only in the test copy

## Diagnosing a missed ad

`src/content/prune.js` defines `window.__leanfbDiagnose()` in the page's MAIN world.
Run it in the DevTools console on the ad page; it prints unit counts, ad-card matches
and the ancestor chain (tag, role, `aria-posinset`, `aria-label`, `attributionsrc`) of
every ad label it can find. It never reads post text.

Important: the current Facebook feed has **no** `aria-posinset` and no
`role="article"` on posts. A post is a plain `div` whose only stable anchor is the `h4`
author heading; the card is the first ancestor taller than ~100 px. Do not reintroduce
`div[aria-posinset]` as the primary unit selector.

Use the output to add either a structural check in `looksLikeAdUnit()` or a label word
in `AD_LABEL_WORDS` / `AD_LABEL_DOT_RE` in `boot.js`.
