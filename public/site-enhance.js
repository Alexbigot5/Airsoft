/**
 * Injected into the bundled marketing page by the Worker, alongside site-hook.js
 * (see src/index.ts). Adds the things the generated bundle does not have:
 *
 *   - a live Google Maps embed where the Contact page has a placeholder slot
 *   - an Instagram button and a directions link on the Contact page
 *   - the liability waiver call-to-action on the Games page
 *   - a working navigation menu on phones
 *
 * Three properties of the host page shape all of this.
 *
 * First, the loader replaces the whole document (`documentElement.replaceWith`)
 * once the bundle unpacks, so nothing this script puts in the DOM at load time
 * survives. Second, the page is a React app that re-renders on every navigation,
 * so anything added to a container it owns can be dropped again. Both are
 * answered the same way: every addition below is idempotent, and a
 * MutationObserver on `document` -- the one node that is never replaced --
 * reapplies them.
 *
 * Third, and least obvious: the bundle's runtime builds its React tree by
 * reading `<x-dc>`'s innerHTML, and whether that happens before or after this
 * script first runs is a race. If it happens after, our elements are swept into
 * that template and every one React renders is a *clone* -- so a listener bound
 * to the node we created belongs to a node that is no longer on the page. That
 * is why nothing here binds listeners to elements. Every interaction is
 * delegated from `document`, which survives cloning, re-rendering and the
 * document swap alike; it is the same trick site-hook.js uses on the bundle's
 * own buttons.
 */
(function () {
  'use strict';

  var INSTAGRAM_URL = 'https://www.instagram.com/coyote__ridge/';
  var INSTAGRAM_HANDLE = '@coyote__ridge';
  var FIELD_ADDRESS = '84562 Territorial Hwy, Eugene, OR';
  var WAIVER_URL = '/waiver';

  var mapsQuery = encodeURIComponent('Coyote Ridge Airsoft, ' + FIELD_ADDRESS);
  // Keyless embed. The official Maps Embed API needs a billing-enabled key;
  // this form needs nothing, which is what makes it deployable as it stands.
  var MAP_EMBED_URL = 'https://www.google.com/maps?q=' + mapsQuery + '&output=embed';
  var MAP_LINK_URL = 'https://www.google.com/maps/search/?api=1&query=' + mapsQuery;

  var INSTAGRAM_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="2" width="20" height="20" rx="5"></rect>' +
    '<circle cx="12" cy="12" r="4"></circle>' +
    '<circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function externalLink(href, className) {
    var a = el('a', className);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function normalise(text) {
    return (text || '').replace(/[→➔➤>]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Stylesheet
  // -------------------------------------------------------------------------

  function ensureStyles() {
    if (!document.head || document.getElementById('cr-enhance-css')) return;
    var link = el('link');
    link.id = 'cr-enhance-css';
    link.rel = 'stylesheet';
    link.href = '/site-enhance.css';
    document.head.appendChild(link);
  }

  // -------------------------------------------------------------------------
  // Contact page: map, directions, Instagram
  // -------------------------------------------------------------------------

  function enhanceContact() {
    var holder = document.querySelector('.mapph');
    if (!holder) return; // not the Contact page

    if (!holder.querySelector('.cr-map')) {
      var slot = holder.querySelector('image-slot');
      if (slot) slot.style.display = 'none';

      var frame = el('iframe', 'cr-map');
      frame.src = MAP_EMBED_URL;
      frame.title = 'Map of Coyote Ridge Airsoft, ' + FIELD_ADDRESS;
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer-when-downgrade';
      frame.setAttribute('allowfullscreen', '');
      holder.appendChild(frame);

      var tap = externalLink(MAP_LINK_URL, 'cr-map-tap');
      tap.setAttribute('aria-label', 'Open ' + FIELD_ADDRESS + ' in Google Maps');
      tap.appendChild(el('span', null, 'Open in Maps'));
      holder.appendChild(tap);
    }

    // The panel of phone / email / game-day cells directly under the map.
    var info = holder.nextElementSibling;
    if (!info || info.querySelector('.cr-social')) return;

    var cell = el('div', 'cr-contact-cell');
    cell.setAttribute('style', 'background:var(--panel);padding:22px;grid-column:1/-1');
    cell.appendChild(el('div', 'label', 'Follow us'));

    var row = el('div', 'cr-social');

    var ig = externalLink(INSTAGRAM_URL, 'btn cr-ig');
    ig.innerHTML = INSTAGRAM_SVG;
    ig.appendChild(document.createTextNode('Instagram ' + INSTAGRAM_HANDLE));
    row.appendChild(ig);

    var directions = externalLink(MAP_LINK_URL, 'btn btn-ghost');
    directions.textContent = 'Get directions →';
    row.appendChild(directions);

    cell.appendChild(row);
    info.appendChild(cell);
  }

  // -------------------------------------------------------------------------
  // Games page: the waiver every player has to sign
  // -------------------------------------------------------------------------

  function gamesHeading() {
    var headings = document.querySelectorAll('h1.display');
    for (var i = 0; i < headings.length; i++) {
      if (normalise(headings[i].textContent) === 'upcoming games') return headings[i];
    }
    return null;
  }

  function enhanceGames() {
    var heading = gamesHeading();
    if (!heading) return; // not the Games page

    var wrap = heading.closest ? heading.closest('.wrap') : heading.parentElement;
    if (!wrap || wrap.querySelector('.cr-waiver-cta')) return;

    var band = el('div', 'cr-waiver-cta corner');

    var copy = el('div');
    copy.appendChild(el('div', 'tag tag-o', '// Required before you play'));
    copy.appendChild(el('h3', 'cond', 'Every player signs the liability waiver'));
    copy.appendChild(
      el(
        'p',
        null,
        'Sign it here before you arrive — it takes two minutes and covers you for a ' +
          'year of game days. Players under 18 need a parent or legal guardian to sign. ' +
          'No signed waiver, no check-in.',
      ),
    );
    band.appendChild(copy);

    var button = el('a', 'btn', 'Sign the liability waiver →');
    button.href = WAIVER_URL;
    band.appendChild(button);

    wrap.appendChild(band);
  }

  // -------------------------------------------------------------------------
  // Mobile navigation
  // -------------------------------------------------------------------------

  /* The bundle's nav buttons drive React state rather than URLs, so a menu item
     cannot be a link -- it finds the real button by its label and clicks it.
     Looked up at click time because a re-render may have replaced the node the
     menu was built from. */
  function activateNav(label) {
    var links = document.querySelectorAll('.navlinks .nav-link');
    for (var i = 0; i < links.length; i++) {
      if (normalise(links[i].textContent) === normalise(label)) {
        links[i].click();
        window.scrollTo(0, 0);
        return;
      }
    }
  }

  function menuIsOpen() {
    return document.querySelector('.cr-menu') !== null;
  }

  function closeMenu() {
    var open = document.querySelectorAll('.cr-menu, .cr-menu-backdrop');
    for (var i = 0; i < open.length; i++) open[i].remove();
    document.documentElement.style.removeProperty('overflow');

    var button = document.querySelector('.cr-menu-btn');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function menuItem(label, isCurrent) {
    var item = el('button', 'cr-menu-item' + (isCurrent ? ' on' : ''), label);
    item.type = 'button';
    item.setAttribute('data-cr-nav', label);
    return item;
  }

  function menuLink(label, href, className) {
    var item = el('a', 'cr-menu-item ' + (className || ''), label);
    item.href = href;
    return item;
  }

  function openMenu() {
    closeMenu();

    var panel = el('nav', 'cr-menu');
    panel.setAttribute('aria-label', 'Site');

    var head = el('div', 'cr-menu-head');
    head.appendChild(el('div', 'tag tag-o', 'Menu'));
    var close = el('button', 'cr-menu-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close menu');
    head.appendChild(close);
    panel.appendChild(head);

    // Mirrors whatever the bundle currently has in its (hidden) nav bar.
    var links = document.querySelectorAll('.navlinks .nav-link');
    for (var i = 0; i < links.length; i++) {
      panel.appendChild(
        menuItem(links[i].textContent, links[i].className.indexOf('on') !== -1),
      );
    }

    // No "Reserve" item: the Book entry above is one of the labels site-hook.js
    // intercepts, so it already lands on the real /register flow.
    panel.appendChild(menuLink('Sign liability waiver', WAIVER_URL, 'cr-menu-cta'));
    panel.appendChild(menuLink('Instagram ' + INSTAGRAM_HANDLE, INSTAGRAM_URL));

    document.body.appendChild(el('div', 'cr-menu-backdrop'));
    document.body.appendChild(panel);
    document.documentElement.style.overflow = 'hidden';

    var button = document.querySelector('.cr-menu-btn');
    if (button) button.setAttribute('aria-expanded', 'true');
    close.focus();
  }

  function enhanceNav() {
    var row = document.querySelector('.navrow');
    if (!row || row.querySelector('.cr-menu-btn')) return;

    var button = el('button', 'cr-menu-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Open menu');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span></span><span></span><span></span>';
    row.appendChild(button);
  }

  // Delegated, for the reason given at the top of the file: the elements these
  // act on may be clones the bundle rendered, not the ones created above.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest('.cr-menu-btn')) {
      event.preventDefault();
      if (menuIsOpen()) closeMenu();
      else openMenu();
      return;
    }

    if (target.closest('.cr-menu-close') || target.closest('.cr-menu-backdrop')) {
      event.preventDefault();
      closeMenu();
      return;
    }

    var item = target.closest('.cr-menu-item');
    if (!item) return;

    // Plain links close the menu and are then left to navigate on their own.
    var label = item.getAttribute('data-cr-nav');
    closeMenu();
    if (label) {
      event.preventDefault();
      activateNav(label);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeMenu();
  });

  // A menu left open while the viewport grows past the breakpoint would hide the
  // page behind a backdrop with no visible way to close it.
  window.addEventListener('resize', function () {
    if (window.innerWidth > 900) closeMenu();
  });

  // -------------------------------------------------------------------------
  // Apply, and keep applying
  // -------------------------------------------------------------------------

  var queued = false;

  function apply() {
    queued = false;
    try {
      ensureStyles();
      enhanceNav();
      enhanceContact();
      enhanceGames();
    } catch (err) {
      // A broken enhancement must not take the page down with it.
      console.warn('[site-enhance]', err);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    // Coalesce a render's worth of mutations -- including the ones apply() makes
    // itself, which would otherwise feed straight back into the observer. A
    // timer rather than requestAnimationFrame: rAF is paused in a backgrounded
    // tab, which would leave `queued` stuck true and stop reapplying for good.
    setTimeout(apply, 16);
  }

  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  apply();
})();
