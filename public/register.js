/* Booking flow: pick an event and package, create the booking, go to checkout. */
(function () {
  'use strict';

  var state = { events: [], packages: [], eventSlug: null, packageId: null };

  var el = {
    events: document.getElementById('events'),
    packages: document.getElementById('packages'),
    form: document.getElementById('form'),
    total: document.getElementById('total'),
    submit: document.getElementById('submit'),
    error: document.getElementById('error'),
    cancelled: document.getElementById('cancelled'),
    partySize: document.getElementById('partySize'),
  };

  function money(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.classList.remove('hidden');
    el.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearError() {
    el.error.classList.add('hidden');
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function api(path, options) {
    var res = await fetch(path, options);
    var payload = null;
    try { payload = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (!res.ok) {
      var msg = (payload && payload.error && payload.error.message) ||
        'Something went wrong (' + res.status + ').';
      var err = new Error(msg);
      err.code = payload && payload.error && payload.error.code;
      throw err;
    }
    return payload;
  }

  function renderEvents() {
    if (state.events.length === 0) {
      el.events.innerHTML =
        '<p class="muted">No game days on the schedule right now. Check back soon.</p>';
      return;
    }

    el.events.innerHTML = '';
    state.events.forEach(function (ev) {
      var soldOut = ev.spotsLeft <= 0;
      var low = !soldOut && ev.spotsLeft <= 6;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.disabled = soldOut;
      btn.setAttribute('aria-pressed', String(state.eventSlug === ev.slug));
      btn.innerHTML =
        '<div class="row"><strong>' + escapeHtml(ev.title) + '</strong>' +
        '<span class="tag ' + (soldOut ? '' : low ? 'low' : 'ok') + '">' +
        (soldOut ? 'Sold out' : ev.spotsLeft + ' / ' + ev.capacity + ' left') +
        '</span></div>' +
        '<div class="muted small">' + escapeHtml(dayLabel(ev.startsAt)) +
        ' · ' + escapeHtml(ev.field === 'cqb' ? 'CQB Compound' : 'Woodland') +
        ' · ' + escapeHtml(ev.level) + '</div>' +
        (ev.note ? '<div class="muted small">' + escapeHtml(ev.note) + '</div>' : '');

      btn.addEventListener('click', function () {
        state.eventSlug = ev.slug;
        renderEvents();
        updateTotal();
      });
      el.events.appendChild(btn);
    });
    el.events.setAttribute('aria-busy', 'false');
  }

  function renderPackages() {
    el.packages.innerHTML = '';
    state.packages.forEach(function (pkg) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.setAttribute('aria-pressed', String(state.packageId === pkg.id));
      btn.innerHTML =
        '<div class="row"><strong>' + escapeHtml(pkg.name) + '</strong>' +
        '<span class="mono">' + money(pkg.priceCents) + '</span></div>' +
        '<div class="muted small">' + escapeHtml(pkg.blurb || '') + '</div>' +
        '<div class="muted small">' + pkg.includes.map(escapeHtml).join(' · ') + '</div>';
      btn.addEventListener('click', function () {
        state.packageId = pkg.id;
        renderPackages();
        updateTotal();
      });
      el.packages.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* Display only. The server recomputes the amount from the package price and
     ignores anything the browser sends. */
  function updateTotal() {
    var pkg = state.packages.filter(function (p) { return p.id === state.packageId; })[0];
    var players = Math.max(1, Math.min(20, Number(el.partySize.value) || 1));
    el.total.textContent = pkg ? money(pkg.priceCents * players) : '$0.00';
  }

  el.partySize.addEventListener('input', updateTotal);

  el.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearError();

    if (!state.eventSlug) return showError('Pick a game day first.');
    if (!state.packageId) return showError('Pick a package.');

    el.submit.disabled = true;
    el.submit.textContent = 'Reserving your spots…';

    try {
      var booking = await api('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventSlug: state.eventSlug,
          packageId: state.packageId,
          partySize: Number(el.partySize.value) || 1,
          name: document.getElementById('name').value,
          email: document.getElementById('email').value,
          phone: document.getElementById('phone').value,
        }),
      });

      el.submit.textContent = 'Opening checkout…';
      var session = await api('/api/bookings/' + encodeURIComponent(booking.ref) + '/checkout', {
        method: 'POST',
      });
      window.location.href = session.url;
    } catch (err) {
      showError(err.message);
      el.submit.disabled = false;
      el.submit.textContent = 'Continue to payment';
      // A sell-out between load and submit is the common case here; refresh the
      // counts so the page stops showing a spot that is gone.
      if (err.code === 'sold_out') load();
    }
  });

  async function load() {
    try {
      var data = await api('/api/events');
      state.events = data.events;
      // Keep the current pick only if it is still bookable.
      if (!state.events.some(function (e) { return e.slug === state.eventSlug && e.spotsLeft > 0; })) {
        state.eventSlug = null;
      }
      renderEvents();

      if (state.packages.length === 0) {
        var pkgs = await api('/api/packages');
        state.packages = pkgs.packages;
        if (state.packages.length > 0) state.packageId = state.packages[0].id;
        renderPackages();
      }
      updateTotal();
    } catch (err) {
      el.events.innerHTML = '';
      showError('Could not load the schedule: ' + err.message);
    }
  }

  if (new URLSearchParams(window.location.search).has('cancelled')) {
    el.cancelled.classList.remove('hidden');
  }

  load();
})();
