/**
 * Injected into the bundled marketing page by the Worker, alongside site-hook.js
 * (see src/index.ts). Adds the things the generated bundle does not have:
 *
 *   - a live Google Maps embed where the Contact page has a placeholder slot
 *   - Instagram, Discord and directions buttons on the Contact page
 *   - the liability waiver call-to-action on the Games page
 *   - the real game-day schedule, replacing the export's sample games
 *   - a photo gallery on the home page, in place of the invented game modes
 *   - a working navigation menu on phones
 *
 * It also corrects what the export made up: the field's phone number, address
 * and email, its "open Sat + Sun" status, and the footer's stand-in operator
 * name. Anything the export invented and this file does not replace is a bug.
 *
 * It also takes two things away: the Book page, whose booking form was a mock,
 * and the per-game player counts, which were sample numbers with nothing behind
 * them. Sign-up is per event, through the registration form linked from each
 * game day in EVENTS below.
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
  var DISCORD_URL = 'https://discord.com/invite/k8CXcKvjGg';
  var FIELD_ADDRESS = '84562 Territorial Hwy, Eugene, OR';
  var FIELD_PHONE = '541-799-6823';
  var FIELD_PHONE_HREF = 'tel:+15417996823';
  var FIELD_EMAIL = 'games@coyoteridge.gg';
  var FOOTER_LEGAL = '© 2026 Coyote Ridge Airsoft';

  /**
   * The waiver every player signs. This used to be `/waiver`, the in-house page
   * backed by `POST /api/waiver/sign`; the field collects signatures on a Google
   * Form instead, so every waiver link on the marketing page points there.
   *
   * It is off-origin, which matters twice below: the links that use it are built
   * with externalLink() so they open in a new tab rather than dropping visitors
   * out of the site, and site-hook.js leaves off-origin anchors alone, so none of
   * them can be mistaken for one of the bundle's mock booking buttons.
   *
   * `/waiver`, `/register` and the API behind them are untouched and still live
   * at their URLs — this changes where the marketing page points, nothing else.
   */
  var WAIVER_URL =
    'https://docs.google.com/forms/d/e/1FAIpQLScF4dQoVeV7ocSxWfxiJy2iJOk4NLe63kIB5EHBkLw38KxDcA/viewform?usp=header';

  /**
   * The hero's two status chips. The export shipped "OPEN SAT + SUN" beside a
   * "NEXT GAME: SAT 08:30" that was pinned to its sample schedule; the field
   * opens for the scheduled events in EVENTS and nothing else, so the first is
   * rewritten and the second — which would need updating after every game day to
   * stay true — goes.
   */
  var FIELD_STATUS = '● FIELD STATUS: OPEN FOR SCHEDULED EVENTS ONLY';

  /** Sat + Sun opening hours the field does not keep. */
  var CONTACT_GAME_DAYS = 'Scheduled events only · 9:00 AM – 4:00 PM';

  /** The export's hero coordinates are in Minnesota. These are not coordinates. */
  var HERO_EYEBROW = 'Eugene, Oregon · Outdoor woodland field';

  /**
   * The game days, and the only place to edit them. Each `url` is that day's
   * registration form; a game day without one would have no way to sign up, so
   * every entry needs it.
   *
   * No spots or capacity here on purpose. The export showed "6 / 40 spots left"
   * from sample data with nothing behind it, which reads as live availability
   * and is worse than showing nothing.
   */
  var EVENTS = [
    {
      mon: 'AUG',
      dd: '15',
      day: 'SAT',
      title: 'Open Play',
      time: '9:00 AM – 4:00 PM',
      note: 'Objective-based games run by marshals all day. Chrono and med on site.',
      url: 'https://form.jotform.com/261820920022041',
    },
    {
      mon: 'AUG',
      dd: '29',
      day: 'SAT',
      title: 'Open Play',
      time: '9:00 AM – 4:00 PM',
      note: 'Objective-based games run by marshals all day. Chrono and med on site.',
      url: 'https://form.jotform.com/261835114941153',
    },
  ];

  var PRICING = [
    { label: 'Early bird', value: '$30' },
    { label: 'Registration', value: '$35' },
  ];

  var FEATURES = [
    'Anyone welcome',
    'Safe & fair gameplay',
    'Objective based games',
    'Chrono & med on site',
    'Bring your own gear',
  ];

  /**
   * The home page gallery, and the only place to edit it. Files live in
   * `public/img/` and are served straight from Workers Assets.
   *
   * It replaces the export's "Five ways to run the field" — five invented game
   * modes with invented player counts, in the same register as the sample
   * schedule and the mock booking form. Photographs of the actual field say more
   * about a game day than a made-up mode list, and cannot go stale.
   *
   * `wide` spans two columns. Exactly one entry carries it, which is what makes
   * the seven photos fill the four-column grid to the edge — two full rows, no
   * ragged tail. Adding or removing a photo means re-checking that arithmetic.
   */
  var GALLERY = [
    {
      src: '/img/staging-area.jpg',
      alt: 'Two players in helmets and plate carriers at the staging area before a game',
      wide: true,
    },
    {
      src: '/img/wooded-hillside.jpg',
      alt: 'A player moving up the steep, fern-covered hillside through the trees',
    },
    {
      src: '/img/wooden-barricade.jpg',
      alt: 'A player firing over a wooden barricade into the treeline',
    },
    {
      src: '/img/tarp-barricade.jpg',
      alt: 'A player pushing past a tarp barricade with a scoped rifle up',
    },
    {
      src: '/img/tire-stack.jpg',
      alt: 'A player holding an angle between a tree and a stack of tires',
    },
    {
      src: '/img/squad-treeline.jpg',
      alt: 'A squad regrouping in the trees between objectives',
    },
    {
      src: '/img/structure-overwatch.jpg',
      alt: "A player on overwatch beside one of the field's wooden structures",
    },
  ];

  var GALLERY_EYEBROW = '01 / Field gallery';
  var GALLERY_HEADING = 'Shots from game day';
  var GALLERY_INTRO =
    'Every photo here is from a Coyote Ridge game day — the terrain, the ' +
    'structures and the players who show up for them.';

  var SCHEDULE_INTRO =
    'Two open play events, and everyone is welcome. Games run rain or shine — gates ' +
    'open 60 minutes before first call for chrono and the safety brief.';

  var SCHEDULE_DISCLAIMER = 'Dates subject to change due to weather or field conditions.';

  /** Removed from the site: its booking form was a mock. */
  var HIDDEN_NAV_LABELS = ['book'];

  /**
   * FAQ entries taken off the About page, matched on the question as the export
   * wrote it. Normalised the same way as everything else here, so case and
   * spacing do not matter -- but the wording does: change the question in the
   * bundle and the entry comes back.
   */
  var HIDDEN_FAQ_QUESTIONS = ['how old do i have to be?', 'can i book for a group or party?'];

  /**
   * The footer's "Play" column. Its three entries were never links -- plain
   * spans naming services the field does not sell separately -- so the column
   * goes whole rather than leaving a heading over an empty space. Matching any
   * one of the three finds it, so re-wording a single entry does not bring the
   * column back.
   */
  var HIDDEN_FOOTER_LINKS = ['open play', 'private events', 'beginner sessions'];

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

  // A chat mark rather than the Discord wordmark glyph: it sits beside the
  // Instagram icon above, and the two only read as a pair drawn in the same
  // single-weight stroke. The link text is what names the destination.
  var DISCORD_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 ' +
    '8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5h.5a8.5 8.5 0 0 1 8 8v.5z"></path>' +
    '<circle cx="9.5" cy="11.5" r="1.1" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="14.5" cy="11.5" r="1.1" fill="currentColor" stroke="none"></circle></svg>';

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

  /**
   * Writes text and attributes onto the bundle's own nodes only when the value
   * would actually change, for the same reason setClass() below is conditional:
   * these live inside the tree the MutationObserver watches, and an
   * unconditional write on every pass would wake the observer, which would
   * schedule another pass, forever.
   */
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setAttr(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  /** The first element under `root` whose text matches, ignoring case and arrows. */
  function findByText(root, selector, text) {
    var nodes = (root || document).querySelectorAll(selector);
    var wanted = normalise(text);
    for (var i = 0; i < nodes.length; i++) {
      if (normalise(nodes[i].textContent) === wanted) return nodes[i];
    }
    return null;
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
  // Home page: the hero's status chips, and the gallery
  // -------------------------------------------------------------------------

  /** The hero exists on the home page and nowhere else. */
  function heroSection() {
    return document.querySelector('.hero');
  }

  function enhanceHero() {
    var hero = heroSection();
    if (!hero) return;

    var eyebrow = hero.querySelector('.eyebrow .tag');
    if (eyebrow) setText(eyebrow, HERO_EYEBROW);

    var status = hero.querySelector('.chip-live');
    if (!status) return;
    setText(status, FIELD_STATUS);

    // Everything else in that row is the "NEXT GAME" chip. Hidden rather than
    // removed, like the sample game rows: React owns it and puts back anything
    // deleted from under it on the next render.
    var chips = status.parentElement ? status.parentElement.querySelectorAll('.chip') : [];
    for (var i = 0; i < chips.length; i++) {
      setClass(chips[i], 'cr-hidden', chips[i] !== status);
    }
  }

  /**
   * The five game-mode cards, replaced by photographs of the field.
   *
   * The section is found through `.modecard`, which the Games page also uses for
   * its safety-brief cards -- so this runs only where the hero is, and the two
   * can never be confused. The cards themselves are hidden rather than removed,
   * which is also what keeps their grid findable on every re-render; the heading
   * and blurb around them are the bundle's own nodes and are rewritten in place.
   */
  function enhanceHomeGallery() {
    if (!heroSection()) return; // not the home page

    var card = document.querySelector('.modecard');
    if (!card) return;

    var grid = plainParent(card);
    var wrap = grid && grid.closest ? grid.closest('.wrap') : null;
    if (!grid || !wrap) return;

    setClass(grid, 'cr-hidden', true);
    setText(wrap.querySelector('.eyebrow .tag'), GALLERY_EYEBROW);
    setText(wrap.querySelector('h2.display'), GALLERY_HEADING);

    // The blurb sits beside the heading, in the flex row above the grid.
    var heading = wrap.querySelector('h2.display');
    var intro = heading && heading.parentElement ? heading.parentElement.querySelector('p') : null;
    setText(intro, GALLERY_INTRO);

    if (wrap.querySelector('.cr-gallery')) return;

    var gallery = el('div', 'cr-gallery');
    for (var i = 0; i < GALLERY.length; i++) {
      var cell = el('figure', 'cr-gallery-cell' + (GALLERY[i].wide ? ' cr-gallery-wide' : ''));
      var img = el('img');
      img.src = GALLERY[i].src;
      img.alt = GALLERY[i].alt;
      // Below the fold on every viewport, and seven full-width photos is real
      // weight to put in front of the first paint.
      img.loading = 'lazy';
      img.decoding = 'async';
      cell.appendChild(img);
      gallery.appendChild(cell);
    }
    wrap.appendChild(gallery);
  }

  // -------------------------------------------------------------------------
  // Contact page: map, directions, Instagram
  // -------------------------------------------------------------------------

  /**
   * The phone / email / game-days cells under the map.
   *
   * The export wrote a real-looking Coyote Ridge phone number and email into the
   * link *text* but left its own stand-ins in the `href`s -- so the page read
   * correctly and dialled a 612 number nobody at the field answers, and mailed
   * ironsight.gg. Tapping a phone number on a phone is the whole point of the
   * cell, which makes this the one piece of placeholder content here that was
   * doing damage rather than just looking wrong.
   */
  function fixContactDetails(info) {
    if (!info) return;

    var tel = info.querySelector('a[href^="tel:"]');
    setText(tel, FIELD_PHONE);
    setAttr(tel, 'href', FIELD_PHONE_HREF);

    var mail = info.querySelector('a[href^="mailto:"]');
    // Left uppercase: the cell is styled for it, and the text is the address.
    setText(mail, FIELD_EMAIL.toUpperCase());
    setAttr(mail, 'href', 'mailto:' + FIELD_EMAIL);

    // "Sat + Sun · 08:30-16:00" contradicts the hero's field status, which is
    // the schedule the field actually keeps.
    var label = findByText(info, '.label', 'Game days');
    if (label) setText(label.nextElementSibling, CONTACT_GAME_DAYS);
  }

  function enhanceContact() {
    var holder = document.querySelector('.mapph');
    if (!holder) return; // not the Contact page

    fixContactDetails(holder.nextElementSibling);

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

    var ig = externalLink(INSTAGRAM_URL, 'btn cr-social-btn');
    ig.innerHTML = INSTAGRAM_SVG;
    ig.appendChild(document.createTextNode('Instagram ' + INSTAGRAM_HANDLE));
    row.appendChild(ig);

    // Peer of the Instagram button, not a lesser version of it: both are the
    // field's community, and the Discord is where a game day is actually
    // organised. The ghost treatment stays on "Get directions", which is the
    // one thing in this row that is not somewhere to go and talk to people.
    var discord = externalLink(DISCORD_URL, 'btn cr-social-btn');
    discord.innerHTML = DISCORD_SVG;
    discord.appendChild(document.createTextNode('Join the Discord'));
    row.appendChild(discord);

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

    var button = externalLink(WAIVER_URL, 'btn');
    button.textContent = 'Sign the liability waiver →';
    band.appendChild(button);

    wrap.appendChild(band);
  }

  // -------------------------------------------------------------------------
  // The schedule: real game days in place of the export's samples
  // -------------------------------------------------------------------------

  function eventRow(game) {
    var row = el('div', 'cr-event');

    var date = el('div', 'gdate');
    date.appendChild(el('div', 'tag', game.mon));
    date.appendChild(el('div', 'gday', game.dd));
    date.appendChild(el('div', 'tag', game.day));
    row.appendChild(date);

    var body = el('div');
    var chips = el('div', 'cr-chips');
    chips.appendChild(el('span', 'chip chip-o', game.time));
    chips.appendChild(el('span', 'chip', 'Everyone welcome'));
    body.appendChild(chips);
    body.appendChild(el('h3', 'cond cr-event-title', game.title));
    body.appendChild(el('p', 'cr-event-note', game.note));
    row.appendChild(body);

    var price = el('div', 'cr-price');
    for (var i = 0; i < PRICING.length; i++) {
      price.appendChild(el('div', 'tag', PRICING[i].value + ' ' + PRICING[i].label));
    }
    row.appendChild(price);

    var book = externalLink(game.url, 'btn cr-book');
    book.textContent = 'Book →';
    book.setAttribute('aria-label', 'Book ' + game.title + ' on ' + game.mon + ' ' + game.dd);
    row.appendChild(book);

    return row;
  }

  /**
   * The nearest ancestor that is a plain element rather than one of the
   * bundle's own tags.
   *
   * This matters more than it looks. Before the runtime reads the page, a
   * `.gamerow`'s parent is the `<sc-for>` that repeats it -- appending there
   * would put our rows *inside* the repeat, and they would come back rendered
   * once per sample game. After the runtime has rendered, the same row's parent
   * is the plain container. Skipping custom elements (the ones with a dash in
   * the tag name) resolves to that same container either way, which is what
   * makes the idempotency check below hold.
   */
  function plainParent(node) {
    var parent = node.parentElement;
    while (parent && (parent.tagName || '').indexOf('-') !== -1) parent = parent.parentElement;
    return parent;
  }

  /**
   * Both the home page's "This weekend" list and the Games page schedule are
   * built from the same `.gamerow` markup, so both are found the same way: the
   * bundle's rows are hidden by the stylesheet rather than removed -- they stay
   * queryable, which is what makes their container findable on every re-render.
   */
  function enhanceSchedules() {
    var rows = document.querySelectorAll('.gamerow');
    var seen = [];

    for (var i = 0; i < rows.length; i++) {
      var container = plainParent(rows[i]);
      if (!container || seen.indexOf(container) !== -1) continue;
      seen.push(container);
      if (container.querySelector('.cr-event')) continue;

      for (var j = 0; j < EVENTS.length; j++) {
        container.appendChild(eventRow(EVENTS[j]));
      }
    }
  }

  /** The filter tabs and "N games listed" count, which filtered sample data. */
  function hideScheduleFilters() {
    var tabs = document.querySelector('.tabs');
    if (tabs && tabs.parentElement) tabs.parentElement.classList.add('cr-hidden');
  }

  function enhanceGamesPage() {
    var heading = gamesHeading();
    if (!heading) return; // not the Games page

    var wrap = heading.closest ? heading.closest('.wrap') : heading.parentElement;
    if (!wrap) return;

    // "Spots update live as bookings come in" stopped being true when the
    // player counts went.
    var intro = wrap.querySelector('p');
    if (intro && intro.textContent !== SCHEDULE_INTRO) intro.textContent = SCHEDULE_INTRO;

    if (!wrap.querySelector('.cr-features')) {
      var features = el('div', 'cr-features');
      for (var i = 0; i < FEATURES.length; i++) {
        features.appendChild(el('span', 'chip', FEATURES[i]));
      }
      wrap.appendChild(features);
      wrap.appendChild(el('p', 'cr-disclaimer', SCHEDULE_DISCLAIMER));
    }

    hideScheduleFilters();
  }

  // -------------------------------------------------------------------------
  // Taken off the site: the Book page, and two FAQ entries
  // -------------------------------------------------------------------------

  function isHiddenNavLabel(label) {
    return HIDDEN_NAV_LABELS.indexOf(normalise(label)) !== -1;
  }

  /**
   * Adds or removes a class only when it would actually change, because these
   * elements are inside the tree the MutationObserver watches: a class written
   * unconditionally on every pass would wake the observer, which would schedule
   * another pass, forever.
   */
  function setClass(node, name, wanted) {
    if (node.classList.contains(name) === wanted) return;
    if (wanted) node.classList.add(name);
    else node.classList.remove(name);
  }

  /* Hidden rather than deleted: these are React's own nodes, and it puts back
     anything removed from under it on the next render. */
  function hideRemovedNav() {
    var links = document.querySelectorAll('.navlinks .nav-link, .footlink');
    for (var i = 0; i < links.length; i++) {
      if (isHiddenNavLabel(links[i].textContent)) setClass(links[i], 'cr-hidden', true);
    }
  }

  function hideRemovedFaqs() {
    var items = document.querySelectorAll('.faqitem');
    var firstVisible = null;

    for (var i = 0; i < items.length; i++) {
      var question = items[i].querySelector('h3');
      var hide =
        !!question && HIDDEN_FAQ_QUESTIONS.indexOf(normalise(question.textContent)) !== -1;

      setClass(items[i], 'cr-hidden', hide);
      if (!hide && !firstVisible) firstVisible = items[i];
    }

    // The stack's top border belongs to :first-child, which may now be hidden.
    for (var j = 0; j < items.length; j++) {
      setClass(items[j], 'cr-faq-top', items[j] === firstVisible);
    }
  }

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  /**
   * Three things, all of them the export's stand-ins:
   *
   *   - the "Play" column, three plain spans naming services sold as one thing
   *   - "Field HQ", a Timberline Rd address in a Sector 7 that does not exist,
   *     over the same unanswered 612 number the Contact page linked
   *   - "© 2026 Ironsight Airsoft — placeholder content", which named a
   *     different operator and then said so
   *
   * Found by their own text rather than by position, so a column reordered in
   * the bundle does not silently start rewriting the wrong one.
   */
  function enhanceFooter() {
    var footer = document.querySelector('.footer');
    if (!footer) return;

    var links = footer.querySelectorAll('.footlink');
    for (var i = 0; i < links.length; i++) {
      if (HIDDEN_FOOTER_LINKS.indexOf(normalise(links[i].textContent)) === -1) continue;
      var column = links[i].parentElement;
      if (!column) continue;
      setClass(column, 'cr-hidden', true);
      // .fgrid is four fixed tracks, so hiding a column would leave the last one
      // empty and pull Field HQ into the narrow slot meant for a link list.
      if (column.parentElement) setClass(column.parentElement, 'cr-footer-3col', true);
    }

    var hq = findByText(footer, '.tag', 'Field HQ');
    if (hq && hq.parentElement) {
      // One line rather than the export's two: the street address and the city
      // are the address, and "Open Sat + Sun" was the second line's other half.
      setText(hq.parentElement.querySelector('p'), FIELD_ADDRESS);

      var tel = hq.parentElement.querySelector('a[href^="tel:"]');
      setText(tel, FIELD_PHONE);
      setAttr(tel, 'href', FIELD_PHONE_HREF);
    }

    var tags = footer.querySelectorAll('.tag');
    for (var j = 0; j < tags.length; j++) {
      if (tags[j].textContent.indexOf('©') !== -1) setText(tags[j], FOOTER_LEGAL);
    }
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
    var item = externalLink(href, 'cr-menu-item ' + (className || ''));
    item.textContent = label;
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

    // Mirrors whatever the bundle currently has in its (hidden) nav bar, minus
    // the pages that have been taken off the site.
    var links = document.querySelectorAll('.navlinks .nav-link');
    for (var i = 0; i < links.length; i++) {
      if (isHiddenNavLabel(links[i].textContent)) continue;
      panel.appendChild(
        menuItem(links[i].textContent, links[i].className.indexOf('on') !== -1),
      );
    }

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
      hideRemovedNav();
      hideRemovedFaqs();
      enhanceNav();
      enhanceFooter();
      enhanceHero();
      enhanceHomeGallery();
      enhanceContact();
      enhanceSchedules();
      enhanceGamesPage();
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
