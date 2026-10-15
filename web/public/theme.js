// Page bootstrap. Loaded as a blocking classic script in <head> (the CSP
// forbids inline script), so [data-js] and [data-motion] are on <html> before
// the first paint.
//
// The site has one look, the charcoal page, so there is no theme to choose. A
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
// Account label. A browser that has signed in here before (localStorage
// "bo:known", written by app/account.mjs) gets [data-known] on <html>, and the
// header's account control reads Sign in instead of Sign up from the first paint.
//
// It also wires the behaviours the shared components promise on every page, so
// static pages need no script of their own:
//   [data-copy]          copies the code block it sits in
//   [data-close-dialog]  closes the dialog it sits in
//   [data-menu-toggle]   the phone header's Menu button: opens and closes the
//                        navigation its aria-controls names. The stylesheet folds
//                        that navigation away only under [data-js], so without
//                        this script every link stays on screen.
(function () {
  'use strict';

  var COPIED_MS = 2000;
  var MOTION_KEY = 'bo-motion';
  var KNOWN_KEY = 'bo:known';
  var MENU_OPEN = 'data-menu-open';
  var root = document.documentElement;
  // Scripts run on this page. CSS reads [data-js] to lay out, from the first
  // paint, what a script will arrange later (the /mcp client tabs, the phone
  // header's menu), so the page does not jump when that script runs.
  root.setAttribute('data-js', '');

  try {
    window.localStorage.removeItem('bo-theme');
  } catch (error) {
    // Storage can be blocked. There is nothing to remove then.
  }

  try {
    if (window.localStorage.getItem(KNOWN_KEY) === '1') root.setAttribute('data-known', '');
  } catch (error) {
    // Storage can be blocked. The control then reads Sign up, and the dialog still offers Sign in.
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

  // The menu a Menu button controls, or null.
  function menuOf(toggle) {
    var id = toggle.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  }

  function setMenu(toggle, open) {
    var menu = menuOf(toggle);
    if (!menu) return null;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menu.setAttribute(MENU_OPEN, '');
    else menu.removeAttribute(MENU_OPEN);
    return menu;
  }

  // The Menu button whose open menu holds the node, or which is the node.
  function openMenuToggle(node) {
    var toggles = document.querySelectorAll('[data-menu-toggle][aria-expanded="true"]');
    for (var index = 0; index < toggles.length; index += 1) {
      var menu = menuOf(toggles[index]);
      if (toggles[index].contains(node) || (menu && menu.contains(node))) return toggles[index];
    }
    return null;
  }

  // The links come before the button in the page, so opening moves focus to
  // the first one; Tab then runs through the links and on to the account control.
  function toggleMenu(toggle) {
    var opening = toggle.getAttribute('aria-expanded') !== 'true';
    var menu = setMenu(toggle, opening);
    var first = opening && menu && menu.querySelector('a[href]');
    if (first) first.focus();
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

    var menuToggle = target.closest('[data-menu-toggle]');
    if (menuToggle) {
      toggleMenu(menuToggle);
    } else if (target.closest('a[href]')) {
      // A link in the menu was chosen: on this page (a #section) the menu has done its job.
      var owner = openMenuToggle(target);
      if (owner) setMenu(owner, false);
    }
  }

  // Escape inside an open menu, or on its button, closes it and puts focus back on the button.
  function onKeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !event.target) return;
    var owner = openMenuToggle(event.target);
    if (!owner) return;
    setMenu(owner, false);
    owner.focus();
  }

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);

  // The motion button is parsed after this script runs, so label it once the DOM is ready.
  document.addEventListener('DOMContentLoaded', function () {
    syncMotionToggles(currentMotion());
  });

  // Follow a system change while the visitor has made no choice of their own.
  lessMotion.addEventListener('change', applyMotion);

  // Keep other open tabs in step.
  window.addEventListener('storage', function (event) {
    if (event.key === MOTION_KEY) applyMotion();
  });
})();
