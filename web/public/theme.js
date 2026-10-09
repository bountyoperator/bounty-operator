// Page bootstrap. Loaded as a blocking classic script in <head> (the CSP
// forbids inline script), so [data-js] and [data-motion] are on <html> before
// the first paint.
//
// The site has one look, the black page, so there is no theme to choose. A
// choice kept by an earlier version of the site (localStorage "bo-theme") is
// removed here.
//
// Motion. Every animation on the site runs only while <html> carries
// data-motion="on" (the rules are keyed on it in the stylesheets). It is on
// unless the visitor's system asks for less motion, and the visitor's own
// choice wins over the system: any [data-motion-toggle] button pauses or plays
// it. A choice that differs from the system is kept in localStorage
// "bo-motion" as "on" or "off"; choosing what the system already asks for
// removes the key. Other code listens for "motionchange" on document.
//
// It also wires the two behaviours the shared components promise on every
// page, so static pages need no script of their own:
//   [data-copy]          copies the code block it sits in
//   [data-close-dialog]  closes the dialog it sits in
(function () {
  'use strict';

  var COPIED_MS = 2000;
  var MOTION_KEY = 'bo-motion';
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

  var lessMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function storedMotion() {
    try {
      var value = window.localStorage.getItem(MOTION_KEY);
      return value === 'on' || value === 'off' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function systemMotion() {
    return lessMotion.matches ? 'off' : 'on';
  }

  function currentMotion() {
    return storedMotion() || systemMotion();
  }

  function syncMotionToggles(state) {
    var toggles = document.querySelectorAll('[data-motion-toggle]');
    for (var index = 0; index < toggles.length; index += 1) {
      var label = toggles[index].querySelector('[data-motion-label]') || toggles[index];
      label.textContent = state === 'on' ? 'Pause motion' : 'Play motion';
      toggles[index].hidden = false;
    }
  }

  function applyMotion() {
    var state = currentMotion();
    var changed = root.getAttribute('data-motion') !== state;
    root.setAttribute('data-motion', state);
    syncMotionToggles(state);
    if (changed) document.dispatchEvent(new CustomEvent('motionchange', { detail: { motion: state } }));
  }

  function toggleMotion() {
    var next = currentMotion() === 'on' ? 'off' : 'on';
    try {
      // Choosing what the system already asks for goes back to following it.
      if (next === systemMotion()) window.localStorage.removeItem(MOTION_KEY);
      else window.localStorage.setItem(MOTION_KEY, next);
    } catch (error) {
      // Storage can be blocked. The choice then lasts for this page only.
      root.setAttribute('data-motion', next);
      syncMotionToggles(next);
      document.dispatchEvent(new CustomEvent('motionchange', { detail: { motion: next } }));
      return;
    }
    applyMotion();
  }

  // Before the first paint: the attribute the stylesheets key every animation on.
  root.setAttribute('data-motion', currentMotion());

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

    if (target.closest('[data-motion-toggle]')) toggleMotion();

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

  // The motion button is parsed after this script runs, so label it once the DOM is ready.
  document.addEventListener('DOMContentLoaded', function () {
    syncMotionToggles(currentMotion());
    revealCurrentNavLink();
  });

  // Follow a system change while the visitor has made no choice of their own.
  lessMotion.addEventListener('change', applyMotion);

  // Keep other open tabs in step.
  window.addEventListener('storage', function (event) {
    if (event.key === MOTION_KEY) applyMotion();
  });
})();
