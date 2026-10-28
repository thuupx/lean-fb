# LeanFB

A Manifest V3 Chrome extension that strips ads, tracking beacons and clutter from
Facebook, with an emphasis on making the page cheap to run.

LeanFB is not a general ad blocker. It is a Facebook-only, CSS-first filter with a
declarative network layer and one small page-context hook. FBPurity was used as the
feature reference; the implementation deliberately avoids its most expensive
techniques.

## Why it is light

| Layer | Cost | What it does |
| --- | --- | --- |
| `rules/*.json` (DNR) | Zero JS. Chrome evaluates rules in C++ before the request leaves the browser. | Blocks ad hosts and telemetry endpoints. |
| `src/content/cosmetic.css` | Native CSS matching. Disabled features are not evaluated at all because every rule is gated by a class on `<html>`. | Hides sponsored posts, rails, Stories, Reels. |
| `src/content/prune.js` | One substring check per GraphQL response, per-line parse only when an ad marker is present. | Removes sponsored nodes before React renders them. |
| `src/content/boot.js` | Debounced, one-pass scanning. The DOM observer is only attached when a text filter is active. | Class toggles, text filter, autoplay pause, badge stats. |

The important difference from FBPurity: LeanFB never runs `IntersectionObserver`
plus `canvas.getImageData` on every feed unit, and it does not re-scan the whole
DOM on every mutation.

## Features

**Ads**
- Hide sponsored feed posts. Facebook labels ads several ways ("Sponsored", "Ad ·",
  "Paid ·"), so detection runs at two levels: structural markers
  (`a[href*="ads/about"]`, `a[attributionsrc]`, `aria-label="Ad"`) plus a header-text
  check for the label variants CSS cannot express.
- Post units are resolved from the `h4` author heading, because the current feed has no
  `aria-posinset` or `role="article"` to key on (see `docs/ARCHITECTURE.md` §5).
- Prune sponsored nodes from GraphQL payloads before they render
- Remove right-column ad boxes
- Hide promoted Marketplace listings

**Clutter**
- Stories tray
- Reels and Watch entry points
- People You May Know, Suggested posts and Your group suggestions, matched
  **structurally**: a real post always has an `h4` author heading, suggestion units do
  not, and units are then classified by link target (`/groups/`, profile URLs). No
  label text is matched, so this works in every UI language.
- Left rail extras

**Network** (declarative rulesets, individually toggleable)
- Ad endpoints (`ads.facebook.com`, `an.facebook.com`, Audience Network, `adn.fbcdn.net`)
- Telemetry (`/ajax/bz`, `/ajax/bnzai`, `/tr/`, logging endpoints)
- Third-party trackers (opt-in, experimental)

**Performance**
- Pause muted autoplay videos
- Reduce animations and transitions

**Presets**
Three one-click setups at the top of the popup: **Light** (ads only), **Balanced**
(default), **Aggressive** (everything, including third-party trackers and motion
reduction). The active preset is highlighted; hand-tweaking a toggle simply unhighlights
it.

**Right rail**
- The sponsored section is removed together with the ad slot's reserved height, so no
  empty column is left behind and the "Sponsored" heading goes with it.
- A compact status card fills the slot: ads blocked on this page, suggestion units
  hidden, and an on/off switch for the whole extension. Sized in `em` and `%` so it
  follows the rail on any screen, and coloured from the page background so it stays
  readable in both Facebook themes.
  Toggle: **Interface → Status card**.

**Counting**
- Ads and suggestions are counted separately. "Ads blocked" is pruned payloads plus
  units hidden by ad markers; suggestion units never inflate that number.
- A unit is counted once. Facebook virtualises the feed, so scrolling away and back
  re-creates the same post as a new element; a text signature deduplicates it.

**Activity log**
Optional, off by default. When on, the popup lists the last 60 blocked items with the
time, the source (`API` = removed from a payload, `DOM` = hidden in the page) and a short
label. Recording stops and the buffer is dropped as soon as the toggle is turned off.

**Custom filter**
One rule per line, matched against the post's rendered text **and its link URLs**:

| Line | Meaning |
| --- | --- |
| `crypto` | plain text, case-insensitive, matches anywhere |
| `shop.example.com` | same, and it matches the domain inside a link |
| `https://shop.example.com/*` | glob, `*` means "anything" |
| `/giveaway\|free\s+iphone/i` | JavaScript regex, flags optional (`i` is added if absent) |

Invalid patterns are ignored at runtime and flagged in the popup instead of silently
doing nothing. Patterns longer than 300 characters are dropped.

**Recovery**
- "Hide an ad…" picker in the popup: click a sponsored post that slipped through and
  its header text becomes a custom filter.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select this folder

Chrome 111 or newer is required (`world: "MAIN"` content scripts).

## Using it

Click the toolbar icon for the panel. The master switch disables everything on the
current page immediately; network rulesets apply on the next page load.

**Allowlist site** adds an `allowAllRequests` dynamic rule for the current host and
turns off cosmetic filtering there.

**Hide an ad…** injects a one-off picker. Click a post that should have been hidden;
LeanFB stores its header text in the custom filter and collapses the post. Edit or
remove those entries under **Activity log**
Optional, off by default. When on, the popup lists the last 60 blocked items with the
time, the source (`API` = removed from a payload, `DOM` = hidden in the page) and a short
label. Recording stops and the buffer is dropped as soon as the toggle is turned off.

**Custom filter** in the popup.

## Project layout

```
manifest.json
rules/
  ads.json            ad hosts and ad endpoints
  telemetry.json      logging and pixel beacons
  thirdparty.json     third-party trackers (off by default)
src/
  background.js       service worker: settings, ruleset sync, allowlist, badge
  lib/settings.js     schema, defaults, class and ruleset mappings
  content/
    cosmetic.css      all cosmetic rules, gated by html classes
    prune.js          MAIN world GraphQL pruning
    boot.js           ISOLATED world controller
    picker.js         on-demand "hide an ad" picker
  ui/                 popup
icons/
docs/
  ARCHITECTURE.md     how it is built and why
```

## Testing

The extension has no build step. To test it programmatically, load it into Chrome for
Testing (branded Chrome 137+ ignores `--load-extension`; use `chrome://extensions`
for manual installs):

```bash
"/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  --load-extension="$PWD" \
  --user-data-dir=/tmp/leanfb-profile \
  --remote-debugging-port=9222
```

## Known limitations

- Cosmetic selectors depend on Facebook's markup and will need maintenance. The
  picker exists for exactly that reason.
- Suggestion-unit detection relies on the `h4` author heading being present on every
  real post. If Facebook drops it, those filters stop matching rather than hiding
  organic posts - the failure mode is deliberately the safe one.
- If an ad still gets through, run `__leanfbDiagnose()` in the page console. It prints
  feed-unit counts and the ancestor chain of every ad label it can see, which is
  usually enough to write the missing selector.
- Response pruning cannot catch ads delivered through endpoints whose shape differs
  from the markers in `src/content/prune.js`.
- Facebook renders the "Sponsored" label to a `<canvas>` for some accounts. FBPurity
  detects that by measuring the rendered word width; LeanFB does not implement this
  yet (see `docs/ARCHITECTURE.md` §13).
- Blocking telemetry can be reverted by Facebook at any time by renaming endpoints.

## License

MIT
