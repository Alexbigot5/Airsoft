/* Confirmation page. Payment is confirmed by a webhook, which can land a moment
   after the browser gets redirected back -- so poll briefly rather than
   declaring the booking unpaid on the first look. */
(function () {
  'use strict';

  var ref = new URLSearchParams(window.location.search).get('ref') || '';
  var POLL_MS = 1200;
  var MAX_ATTEMPTS = 10;

  var el = {
    heading: document.getElementById('heading'),
    status: document.getElementById('status'),
    error: document.getElementById('error'),
    details: document.getElementById('details'),
    ref: document.getElementById('ref'),
    summary: document.getElementById('summary'),
    attendees: document.getElementById('attendees'),
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.classList.remove('hidden');
  }

  function render(booking) {
    el.details.classList.remove('hidden');
    el.ref.textContent = booking.ref;
    el.summary.innerHTML =
      escapeHtml(booking.event.title) + '<br>' +
      escapeHtml(new Date(booking.event.startsAt).toLocaleString()) + '<br>' +
      escapeHtml(booking.packageName) + ' × ' + booking.partySize +
      ' · $' + (booking.amountCents / 100).toFixed(2);

    el.attendees.innerHTML = '';
    booking.attendees.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'panel';
      var signed = a.waiverValid;
      row.innerHTML =
        '<div class="row" style="display:flex;justify-content:space-between;gap:12px;align-items:center">' +
        '<strong>' + escapeHtml(a.name || 'Player ' + a.seatNo) + '</strong>' +
        '<span class="pill ' + (signed ? 'good' : 'warnp') + '">' +
        (signed ? 'Waiver signed' : 'Waiver needed') + '</span></div>' +
        (signed
          ? '<div class="muted small">Valid until ' +
            escapeHtml(new Date(a.waiverExpiresAt).toLocaleDateString()) + '</div>'
          : '<div class="muted small mono" style="word-break:break-all">' +
            escapeHtml(a.waiverUrl) + '</div>' +
            '<p><a class="btn small" href="' + escapeHtml(a.waiverUrl) + '">Sign now</a> ' +
            '<button class="btn small ghost" type="button" data-copy="' +
            escapeHtml(a.waiverUrl) + '">Copy link</button></p>');
      el.attendees.appendChild(row);
    });
  }

  el.attendees.addEventListener('click', function (event) {
    var link = event.target.getAttribute && event.target.getAttribute('data-copy');
    if (!link) return;
    navigator.clipboard.writeText(link).then(function () {
      event.target.textContent = 'Copied';
      setTimeout(function () { event.target.textContent = 'Copy link'; }, 2000);
    });
  });

  async function poll(attempt) {
    var res = await fetch('/api/bookings/' + encodeURIComponent(ref));
    if (!res.ok) {
      var payload = null;
      try { payload = await res.json(); } catch (e) { /* ignore */ }
      el.heading.textContent = 'We could not find that booking';
      el.status.textContent = '';
      return showError((payload && payload.error && payload.error.message) || 'Unknown booking.');
    }

    var booking = await res.json();
    render(booking);

    if (booking.status === 'paid') {
      el.heading.textContent = 'You are booked in';
      el.status.textContent = 'Payment received. A confirmation is on its way to you.';
      return;
    }

    if (booking.status === 'cancelled' || booking.status === 'expired') {
      el.heading.textContent = 'This booking is no longer active';
      el.status.textContent = '';
      return showError(
        'The hold on these spots was released. You can book again from the schedule.',
      );
    }

    if (attempt >= MAX_ATTEMPTS) {
      el.heading.textContent = 'Payment not confirmed yet';
      el.status.innerHTML =
        'Your spots are still held. If you completed payment this usually settles within a ' +
        'minute — <a href="">refresh</a> to check again.';
      return;
    }

    el.status.textContent = 'Waiting for payment confirmation…';
    setTimeout(function () { poll(attempt + 1); }, POLL_MS);
  }

  if (!ref) {
    el.heading.textContent = 'No booking reference';
    el.status.textContent = '';
    showError('This link is missing its booking reference.');
  } else {
    poll(0);
  }
})();
