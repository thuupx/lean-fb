# Architecture

LeanFB is a Manifest V3 extension that removes advertising, tracking and low-value
content from Facebook while keeping the page cheap to run. This document explains how it
is built and why each decision was made.

The design follows one rule: **do the cheapest thing that works, and fail in the
direction that is least harmful to the page.**

---

## 1. Constraints the platform imposes

MV3 removed blocking `webRequest` for regular extensions. The only request-level
blocking mechanism is `declarativeNetRequest` (DNR): rules are declared up front and the
browser evaluates them natively. An extension never sees the request.

DNR has one hard limit that shapes everything here: **it cannot read or rewrite response
bodies.** It can block, allow, redirect and modify headers, nothing else.

Measured limits (Chrome 151):

| Limit | Value |
| --- | --- |
| `MAX_NUMBER_OF_DYNAMIC_RULES` | 30,000 (safe rules) |
| `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` | 5,000 |
| `MAX_NUMBER_OF_SESSION_RULES` | 5,000 |
| `MAX_NUMBER_OF_REGEX_RULES` | 1,000 |
| `GUARANTEED_MINIMUM_STATIC_RULES` | 30,000 |
| `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` | 50 |

These are far above what a Facebook-only extension needs. LeanFB ships 11 rules.

---

## 2. The four layers

```
┌─ rules/*.json ────────────── DNR static rulesets
│                               block ad hosts, telemetry, trackers
│                               zero JS, evaluated in C++
│
├─ cosmetic.css ────────────── native CSS, gated by html.lf-* classes
│                               disabled features are never evaluated
│
├─ prune.js (MAIN world) ───── patches XHR/fetch at document_start
│                               removes sponsored nodes before React sees them
│
└─ boot.js (ISOLATED) ──────── class toggles, structural filtering,
                                autoplay control, stats, rail card
```

Each layer exists because the one above it cannot do the job:

- DNR cannot touch bodies, so payload pruning needs a page-context hook.
- The hook only sees network traffic, so anything rendered from the document itself
  needs DOM work.
- DOM work in the page world would be fragile and expensive, so it lives in the
  isolated world where `chrome.*` is available.

---

## 3. Network layer

### 3.1 Rulesets

Three static rulesets, one per feature, toggled at runtime with
`updateEnabledRulesets()`:

| Ruleset | Default | Contents |
| --- | --- | --- |
| `ads` | on | ad-serving hosts, Audience Network, ad redirectors |
| `telemetry` | on | batch logging and pixel endpoints |
| `thirdparty` | off | third-party ad and analytics domains |

Every rule is scoped with `initiatorDomains: ["facebook.com"]` and excludes the business
surfaces (`adsmanager`, `business`, `developers`) so the extension stays Facebook-only
and never breaks Ads Manager.

Blocking rules do not need host permissions - the `declarativeNetRequest` permission
grants implicit block/allow access. That is why the manifest asks for `facebook.com`
only.

### 3.2 Payload pruning

The feed is served as **newline-delimited JSON** (Relay incremental delivery) with a
`text/html` content type. It is not one JSON document, so `JSON.parse` on the whole body
always fails.

Shape:

```
line 0      {"data":{"viewer":{"news_feed":{"edges":[...]}}},"extensions":{...}}
lines 1..n  {"label":"...","path":["viewer","news_feed","edges",N],"data":<edge>}
```

Pruning therefore works per line:

1. Parse each line; if any line is not valid JSON, abandon the rewrite entirely.
2. Drop members of the initial `edges` array whose subtree contains a sponsored node.
3. Drop patch lines whose `data` carries one.
4. **Renumber** the remaining `path: [..., "edges", i]` patches, because removing an
   edge shifts the array.

The marker is `__typename === "SponsoredData"`. The *field name* that holds it rotates
between sessions, so keying on a name is unreliable. A cheap substring guard means only
responses that could contain an ad are parsed at all.

Two platform details make a naive implementation silently useless:

- **Facebook restores the native `responseText` getter** shortly after
  `document_start`. A prototype-level patch reports success and never runs. The working
  approach is an accessor defined on the request instance at `readyState === 4`,
  registered inside `open()` so it runs before any handler the page assigns.
- **The feed uses XHR, not `fetch`.** A fetch-only hook sees nothing.

`window.__leanfbPatches` reports which hooks actually installed, and
`__leanfbDiagnose().pruneStats` separates "no ad was served" from "the hook never ran":

| Counter | Meaning |
| --- | --- |
| `responses` | GraphQL responses inspected |
| `withMarker` | of those, how many contained an ad marker |
| `parseFailures` | marker present, body not parseable |
| `rewritten` | bodies actually rewritten |

### 3.3 What this layer cannot do

On some accounts the first feed paint - ads included - is server-rendered into inline
`<script type="application/json">` blocks and consumed by the Relay bootloader. No
request carries that payload; it is part of the document. Blocking it would mean
blocking the page.

Rewriting those blocks before the bootloader reads them is theoretically possible and
deliberately not implemented. The payload is the whole bootstrap (route config, current
user, feature flags, prefetched queries), a mistake leaves the feed blank with no
fallback, and the failure is far worse than the one it prevents. The DOM layer covers
these ads instead.

A `JSON.parse` hook was evaluated for this path and rejected: the only matches in the
bootloader were a feature-flag *name* containing the marker substring, so the hook fired
hundreds of times over multi-hundred-KB objects and pruned nothing.

---

## 4. Cosmetic layer

All hiding rules live in one stylesheet. Every rule is prefixed with a class on `<html>`
(`html.lf-sponsored`, `html.lf-stories`, ...), so turning a feature off removes the class
and the selector is never evaluated. No dynamic injection, no flash of unstyled ads.

Feed units use `height: 0; overflow: hidden` rather than `display: none`. Facebook
virtualises the list; collapsing the box keeps its scroll anchors intact and avoids
re-render churn.

---

## 5. Feed structure

The feed has no stable ARIA hooks. Measured on a live feed:

| Query | Count |
| --- | --- |
| `div[aria-posinset]` | 0 |
| `div[role="feed"]` | 0 |
| `div[role="article"]` | comments and message rows, not posts |

A post is a plain `div` with only hashed atomic classes. The one stable anchor is the
**`h4` author heading**; the card is the first ancestor taller than ~100 px. Results are
cached per heading because `getBoundingClientRect` forces layout.

`div[aria-posinset]` is kept as a fallback for surfaces that still use it, never as the
primary selector.

---

## 6. Ad detection

Facebook labels ads several ways and localises all of them, so detection is layered:

**Structural (language independent)**

- `a[href*="ads/about"]` - the "why am I seeing this" link
- `a[attributionsrc]` - Privacy Sandbox attribution, only on ad links
- `a[href*="#?dhd"]` - the tracking fragment on the ad label anchor
- an anchor whose text is only U+2060 - the icon-only label

**Text (fallback)**

- `/Ad|Paid\s*[·•∙‧]/` and a list of localised "Sponsored" words

The separator dot is required for `Ad`/`Paid` because the bare word collides with page
names. On some ads the word itself is CSS-generated and never appears in `textContent`,
which is why the structural signals carry most of the weight.

Units are re-checked when their own subtree mutates (capped at three checks) and when
they scroll into view, because Facebook can attach the label after the unit is inserted.

---

## 7. Suggestion units

"People You May Know", "Suggested for you" and group suggestions are localised, so they
are matched structurally:

1. A real post - organic or sponsored - always has an `h4`. Suggestion units do not.
2. Units without an `h4` are then classified by link target: `/groups/` means group
   suggestions, a bare profile path means people suggestions, anything else is generic.

Counting `/groups/` links alone would be wrong: an organic group post carries several of
them.

The failure mode is deliberately safe. If Facebook stops emitting `h4`, these filters
stop hiding suggestions rather than start hiding posts.

---

## 8. Right rail

Facebook reserves the ad slot with a class-level `min-height` on both the section and
the rail, and the rail clips with `overflow: hidden`. Hiding the ad card alone leaves a
tall empty column and the "Sponsored" heading behind.

The extension collapses the ad section, then sizes the rail to the replacement card's
measured height. Collapsing the rail to zero instead clips the card, because its height
is driven only by that `min-height`.

The replacement card is built from `<div>` only: Facebook's rail CSS sets
`display: none` on bare `<span>` elements in that position, and `color: inherit` picks
up a dark colour even in dark mode. Facebook's theme is a user setting independent of
the OS, so `prefers-color-scheme` cannot be used either; body background luminance is
the reliable signal.

Everything is sized in `em` and `%` so it follows the rail on any screen.

---

## 9. Counting

Three things inflate a naive counter:

1. **Ads and suggestions share a hide path.** Counting both as "ads blocked" reports
   ads that never existed. Hides are counted per reason: `ad`, `suggestion`, `keyword`.
2. **Pruned ads never reach the DOM.** A DOM query always reads zero once the network
   layer works, so the pruned count has to be added in.
3. **The feed is virtualised.** Scrolling away and back re-creates the same post as a
   new element, which would count the same ad twice.

Deduplication uses a text signature. `textContent` starts with the SVG `<title>` of
every icon in the card, so the first characters are identical for every post - the
prefix has to be stripped before slicing, or every unit collapses into one key.

---

## 10. Lifecycle

Reloading or updating the extension invalidates the running content script's `chrome.*`
APIs. Every later call throws `Extension context invalidated`, which surfaces as an
error on every scan.

`boot.js` keeps an `alive` flag, routes all messaging through one guarded `sendMessage`,
and tears down observers and timers in `shutdown()`. A rejected send is only fatal when
the message says the context was invalidated; a missing receiver is normal.

---

## 11. Custom filter

Three forms, auto-detected per line, matched against the post's rendered text **and its
link URLs**:

| Line | Handling |
| --- | --- |
| `crypto` | plain text, case-insensitive |
| `https://shop.example.com/*` | glob, `*` becomes "anything" |
| `/regex/flags` | JavaScript regex, `i` added when absent |

Matching includes the card's `href`s because people filter by domain, and a URL is an
attribute rather than visible text. `innerText` is used instead of `textContent` so the
SVG title noise does not pollute matches, and it is only computed when filters exist
because it forces layout.

Invalid patterns are dropped at runtime and flagged in the popup. Patterns are capped at
300 characters: JavaScript regex has no timeout, so a backtracking pattern can freeze
the tab. The cap is a mitigation, not a guarantee.

---

## 12. Presets and settings

Three presets - Light, Balanced, Aggressive - set only the feature groups, leaving the
allowlist, custom filter and interface choices untouched. The active preset is derived
by comparison, so hand-tweaking a toggle simply unhighlights it.

Settings live in `storage.local` and are normalised against defaults on read, which is
also the migration path: a missing key falls back rather than breaking.

---

## 13. Known limits

- Cosmetic selectors depend on Facebook's markup and need maintenance. The "Hide an ad"
  picker exists for exactly that reason: it turns a missed ad into a custom filter.
- The canvas-rendered "Sponsored" label is not detected. It requires measuring the
  rendered word width, which is expensive and account-dependent.
- Payload pruning only fires when a response carries the marker; ads delivered in the
  document itself are handled by the DOM layer instead.
- Telemetry endpoints can be renamed at any time.
