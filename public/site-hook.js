/**
 * Injected into the bundled marketing page by the Worker (see src/index.ts).
 *
 * That page ships its own mock booking flow -- the confirmation code it shows
 * is Math.random() and nothing is stored -- reached from generic "Book" and
 * "Reserve" buttons scattered across the site. Rather than edit a 3 MB
 * generated bundle, this hook intercepts those in the capture phase.
 *
 * They now land on the Games page, because sign-up is per event: each game day
 * has its own registration form, so a button that does not name a game day has
 * nothing to send anyone to except the list of them. site-enhance.js renders
 * that list, and its per-event buttons are real external links, which the
 * external-href guard below deliberately leaves alone.
 */
(function () {
  'use strict';

  // Labels taken from the bundle. "View schedule" / "Full schedule" are
  // navigation within the marketing page and are deliberately left alone.
  var BOOKING_LABELS = [
    'book',
    'book now',
    'book another',
    'reserve',
    'reserve now',
    'reserve a spot',
    'confirm reservation',
  ];

  function normalise(text) {
    return (text || '')
      .replace(/[→➔➤>]/g, ' ') // trailing arrows
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** A link that leaves this origin is a real destination, not a mock button. */
  function isExternalLink(el) {
    return (
      (el.tagName || '').toLowerCase() === 'a' &&
      !!el.getAttribute('href') &&
      !!el.origin &&
      el.origin !== window.location.origin
    );
  }

  function bookingTarget(node) {
    for (var el = node; el && el !== document.body; el = el.parentElement) {
      var tag = (el.tagName || '').toLowerCase();
      if (tag !== 'button' && tag !== 'a') continue;
      if (isExternalLink(el)) return null;
      if (BOOKING_LABELS.indexOf(normalise(el.textContent)) !== -1) return el;
    }
    return null;
  }

  /** The bundle's nav is state-driven, so "go to Games" means click its button. */
  function showGames() {
    var links = document.querySelectorAll('.navlinks .nav-link');
    for (var i = 0; i < links.length; i++) {
      if (normalise(links[i].textContent) === 'games') {
        links[i].click();
        window.scrollTo(0, 0);
        return true;
      }
    }
    return false;
  }

  document.addEventListener(
    'click',
    function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (!bookingTarget(event.target)) return;

      // Stop the bundle's own handler from running its fake flow.
      event.preventDefault();
      event.stopPropagation();

      // Falls back to the registration flow if the nav is not on the page --
      // better than a click that does nothing at all.
      if (!showGames()) window.location.href = '/register';
    },
    true, // capture: the bundle binds its handlers on the elements themselves
  );
})();
