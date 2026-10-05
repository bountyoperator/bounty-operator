// Theme bootstrap. Loaded as a blocking classic script in <head> so the stored
// choice is applied before first paint (the CSP forbids inline script).
//
// The choice lives in localStorage under "bo-theme" as "light" or "dark".
// No stored value means "follow the system". The header toggle is any element
// with [data-theme-toggle]; other code can listen for "themechange" on document.
//
// It also wires the two behaviours the shared components promise on every
// page, so static pages need no script of their own:
//   [data-copy]          copies the code block it sits in
//   [data-close-dialog]  closes the dialog it sits in
(function () {
  'use strict';

  var STORAGE_KEY = 'bo-theme';
  var COPIED_MS = 2000;
  // Keep in step with --bg in /css/base.css.
  var PAGE_COLOR = { light: '#f5f7fb', dark: '#0a1220' };
  var root = document.documentElement;
  // Scripts run on this page. CSS reads [data-js] to lay out, from the first
  // paint, what a script will arrange later (the /mcp client tabs), so the page
  // does not jump when that script runs.
  root.setAttribute('data-js', '');
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function readStored() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function writeStored(theme) {
    try {
      if (theme) window.localStorage.setItem(STORAGE_KEY, theme);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Storage can be blocked. The choice then lasts for this page only.
    }
  }

  function systemTheme() {
    return systemDark.matches ? 'dark' : 'light';
  }

  function currentTheme() {
    return root.getAttribute('data-theme') || systemTheme();
  }

  // The browser chrome follows the page: point both theme-color metas at the forced colour.
  function syncThemeColor(forced) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var index = 0; index < metas.length; index += 1) {
      var meta = metas[index];
      if (!meta.hasAttribute('data-default')) meta.setAttribute('data-default', meta.content);
      meta.content = forced ? PAGE_COLOR[forced] : meta.getAttribute('data-default');
    }
  }

  function syncToggles() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    var toggles = document.querySelectorAll('[data-theme-toggle]');
    for (var index = 0; index < toggles.length; index += 1) {
      toggles[index].setAttribute('aria-label', 'Switch to ' + next + ' theme');
    }
  }

  function apply(forced) {
    if (forced) root.setAttribute('data-theme', forced);
    else root.removeAttribute('data-theme');
    syncThemeColor(forced);
    syncToggles();
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    // Choosing what the system already prefers clears the override, so the
    // page goes back to following the system.
    var forced = next === systemTheme() ? null : next;
    writeStored(forced);
    apply(forced);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  }

  // Each code line ends with a line feed; the last one is not part of the source.
  function sourceText(block) {
    var text = block.textContent;
    return text.charAt(text.length - 1) === '\n' ? text.slice(0, -1) : text;
  }

  function copyCode(button) {
    var figure = button.closest('.code');
    var block = figure && figure.querySelector('pre');
    if (!block || !navigator.clipboard) return;

    navigator.clipboard.writeText(sourceText(block)).then(function () {
      var label = button.querySelector('[data-copy-label]');
      var original = label ? label.textContent : '';
      button.setAttribute('data-copied', '');
      if (label) label.textContent = 'Copied';
      window.setTimeout(function () {
        button.removeAttribute('data-copied');
        if (label) label.textContent = original;
      }, COPIED_MS);
    });
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest('[data-theme-toggle]')) toggleTheme();

    var copyButton = target.closest('[data-copy]');
    if (copyButton) copyCode(copyButton);

    var closeButton = target.closest('[data-close-dialog]');
    var dialog = closeButton && closeButton.closest('dialog');
    if (dialog) dialog.close();
  }

  apply(readStored());

  document.addEventListener('click', onClick);

  // On narrow screens the nav row scrolls sideways; bring the current page's link
  // into view when it would start under the faded right edge.
  function revealCurrentNavLink() {
    var current = document.querySelector('.site-nav a[aria-current="page"]');
    var nav = current && current.closest('.site-nav');
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    var overflow = current.getBoundingClientRect().right - (nav.getBoundingClientRect().right - 48);
    if (overflow > 0) nav.scrollLeft += overflow;
  }

  // The toggle is parsed after this script runs, so label it once the DOM is ready.
  document.addEventListener('DOMContentLoaded', function () {
    syncToggles();
    revealCurrentNavLink();
  });

  // Follow a system change while no override is stored.
  systemDark.addEventListener('change', function () {
    if (!readStored()) apply(null);
  });

  // Keep other open tabs in step.
  window.addEventListener('storage', function (event) {
    if (event.key === STORAGE_KEY) apply(readStored());
  });
})();
