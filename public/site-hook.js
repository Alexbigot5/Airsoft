/**
 * Injected into the bundled marketing page by the Worker (see src/index.ts).
 *
 * That page ships its own mock booking flow -- the confirmation code it shows
 * is Math.random() and nothing is stored. Rather than edit a 3 MB generated
 * bundle, this hook intercepts the booking call-to-action in the capture phase
 * and sends people to the real /register flow instead.
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

  function bookingTarget(node) {
    for (var el = node; el && el !== document.body; el = el.parentElement) {
      var tag = (el.tagName || '').toLowerCase();
      if (tag !== 'button' && tag !== 'a') continue;
      if (BOOKING_LABELS.indexOf(normalise(el.textContent)) !== -1) return el;
    }
    return null;
  }

  document.addEventListener(
    'click',
    function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (!bookingTarget(event.target)) return;

      // Stop the bundle's own handler from running its fake flow.
      event.preventDefault();
      event.stopPropagation();
      window.location.href = '/register';
    },
    true, // capture: the bundle binds its handlers on the elements themselves
  );
})();
