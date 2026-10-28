/*
 * "Hide an ad" picker. Injected on demand from the popup, so a failure here
 * can never affect normal browsing.
 *
 * Facebook changes its ad markup often; when a sponsored post slips past the
 * built-in selectors the user can point at it and turn its header text into a
 * custom filter. That filter is visible and editable in the popup.
 */
(() => {
  'use strict';

  if (window.__leanfbPicker) return;
  window.__leanfbPicker = true;

  const UNIT_SELECTOR = 'div[aria-posinset]';
  const previousCursor = document.documentElement.style.cursor;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-leanfb-picker', 'overlay');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'pointer-events:none', 'background:rgba(37,99,235,0.06)',
  ].join(';');

  const label = document.createElement('div');
  label.setAttribute('data-leanfb-picker', 'label');
  label.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
    'z-index:2147483647', 'padding:10px 14px', 'border-radius:10px',
    'background:#111827', 'color:#f9fafb', 'font:13px/1.4 -apple-system,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,0.35)', 'max-width:min(520px,90vw)',
    'text-align:center', 'pointer-events:none',
  ].join(';');
  label.textContent = 'Click a sponsored post to filter it. Esc to cancel.';

  let highlighted = null;

  function clearHighlight() {
    if (!highlighted) return;
    highlighted.style.removeProperty('outline');
    highlighted.style.removeProperty('outline-offset');
    highlighted = null;
  }

  function teardown() {
    clearHighlight();
    overlay.remove();
    label.remove();
    document.documentElement.style.cursor = previousCursor;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey, true);
    window.__leanfbPicker = false;
  }

  function unitAt(target) {
    return target instanceof Element ? target.closest(UNIT_SELECTOR) : null;
  }

  function onMove(event) {
    const unit = unitAt(event.target);
    if (unit === highlighted) return;
    clearHighlight();
    if (!unit) return;
    highlighted = unit;
    unit.style.setProperty('outline', '2px solid #2563eb', 'important');
    unit.style.setProperty('outline-offset', '-2px', 'important');
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    teardown();
  }

  function onPick(event) {
    event.preventDefault();
    event.stopPropagation();

    const unit = unitAt(event.target);
    if (!unit) {
      label.textContent = 'That is not a post. Try clicking the sponsored card itself.';
      return;
    }

    const text = (unit.textContent || '').replace(/\s+/g, ' ').trim();
    const keyword = text.slice(0, 50).trim();

    if (keyword.length < 4) {
      label.textContent = 'Could not read that post. Try another one.';
      return;
    }

    unit.style.setProperty('height', '0', 'important');
    unit.style.setProperty('overflow', 'hidden', 'important');
    unit.classList.add('lf-hidden');

    try {
      chrome.runtime.sendMessage({ type: 'lf-add-keyword', keyword }).catch(() => {});
    } catch {
      // Extension reloaded while the picker was open.
    }
    teardown();
  }

  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onPick, true);
  document.addEventListener('keydown', onKey, true);
  document.documentElement.append(overlay, label);
})();
