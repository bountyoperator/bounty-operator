// Page bootstrap. Loaded as a blocking classic script in <head> (the CSP
// forbids inline script), so [data-js] is on <html> before the first paint.
//
// The site has one look, the black page, so there is no theme to choose and
// nothing is stored. A choice kept by an earlier version of the site
// (localStorage "bo-theme") is removed here.
//
// It wires the two behaviours the shared components promise on every page, so
// static pages need no script of their own:
//   [data-copy]          copies the code block it sits in
//   [data-close-dialog]  closes the dialog it sits in
(function () {
  'use strict';

  var COPIED_MS = 2000;
  var root = document.documentElement;
  // Scripts run on this page. CSS reads [data-js] to lay out, from the first
  // paint, what a script will arrange later (the /mcp client tabs), so the page
  // does not jump when that script runs.
  root.setAttribute('data-js', '');

  try {
    window.localStorage.removeItem('bo-theme');
  } catch (error) {
    // Storage can be blocked. There is nothing to remove then.
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

    var copyButton = target.closest('[data-copy]');
    if (copyButton) copyCode(copyButton);

    var closeButton = target.closest('[data-close-dialog]');
    var dialog = closeButton && closeButton.closest('dialog');
    if (dialog) dialog.close();
  }

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

  document.addEventListener('DOMContentLoaded', revealCurrentNavLink);
})();
