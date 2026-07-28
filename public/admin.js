/* Staff console: pick a game day, work the roster, check people in.
   The token lives in sessionStorage so it dies with the tab. */
(function () {
  'use strict';

  var TOKEN_KEY = 'cr_admin_token';
  var token = sessionStorage.getItem(TOKEN_KEY) || '';
  var events = [];
  var currentEventId = null;

  var el = {
    auth: document.getElementById('auth'),
    app: document.getElementById('app'),
    authForm: document.getElementById('authForm'),
    tokenInput: document.getElementById('token'),
    signOut: document.getElementById('signOut'),
    error: document.getElementById('error'),
    picker: document.getElementById('eventPicker'),
    summary: document.getElementById('eventSummary'),
    rosterBody: document.querySelector('#roster tbody'),
    sweep: document.getElementById('sweep'),
    sweepResult: document.getElementById('sweepResult'),
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
  function clearError() { el.error.classList.add('hidden'); }

  async function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
    var res = await fetch(path, opts);
    var payload = null;
    try { payload = await res.json(); } catch (e) { /* ignore */ }

    if (res.status === 401) {
      signOut();
      throw new Error('That token was not accepted.');
    }
    if (!res.ok) {
      throw new Error(
        (payload && payload.error && payload.error.message) ||
        'Request failed (' + res.status + ').',
      );
    }
    return payload;
  }

  function signOut() {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    el.app.classList.add('hidden');
    el.auth.classList.remove('hidden');
    el.signOut.classList.add('hidden');
  }

  el.signOut.addEventListener('click', signOut);

  el.authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearError();
    token = el.tokenInput.value.trim();
    if (!token) return showError('Enter the staff token.');
    try {
      await loadEvents();
      sessionStorage.setItem(TOKEN_KEY, token);
      el.auth.classList.add('hidden');
      el.app.classList.remove('hidden');
      el.signOut.classList.remove('hidden');
    } catch (err) {
      showError(err.message);
    }
  });

  async function loadEvents() {
    var data = await api('/api/admin/events');
    events = data.events;
    el.picker.innerHTML = '';
    events.forEach(function (ev) {
      var option = document.createElement('option');
      option.value = String(ev.id);
      option.textContent =
        new Date(ev.startsAt).toLocaleString() + ' · ' + ev.title +
        ' (' + ev.spotsTaken + '/' + ev.capacity + ')';
      el.picker.appendChild(option);
    });

    if (events.length === 0) {
      el.summary.textContent = 'No events yet.';
      el.rosterBody.innerHTML = '';
      return;
    }

    // Default to the next game day that has not started.
    var now = new Date().toISOString();
    var upcoming = events.filter(function (e) { return e.startsAt >= now; });
    var pick = upcoming.length ? upcoming[upcoming.length - 1] : events[0];
    currentEventId = pick.id;
    el.picker.value = String(currentEventId);
    await loadRoster();
  }

  el.picker.addEventListener('change', function () {
    currentEventId = Number(el.picker.value);
    loadRoster().catch(function (err) { showError(err.message); });
  });

  async function loadRoster() {
    clearError();
    var data = await api('/api/admin/events/' + currentEventId + '/roster');
    var ev = data.event;

    var checkedIn = data.attendees.filter(function (a) { return a.checkedInAt; }).length;
    var missingWaiver = data.attendees.filter(function (a) { return !a.waiverValid; }).length;
    var unpaid = data.attendees.filter(function (a) { return !a.paid; }).length;

    el.summary.innerHTML =
      '<strong>' + escapeHtml(ev.title) + '</strong> · ' +
      escapeHtml(new Date(ev.startsAt).toLocaleString()) + '<br>' +
      '<span class="muted">' + ev.spotsTaken + ' of ' + ev.capacity + ' spots taken · ' +
      checkedIn + ' checked in · ' + missingWaiver + ' without a valid waiver · ' +
      unpaid + ' unpaid</span>';

    el.rosterBody.innerHTML = '';
    if (data.attendees.length === 0) {
      el.rosterBody.innerHTML = '<tr><td colspan="7" class="muted">Nobody booked yet.</td></tr>';
      return;
    }

    data.attendees.forEach(function (a) {
      var tr = document.createElement('tr');
      if (a.checkedInAt) tr.className = 'done';

      var waiverPill = a.waiverValid
        ? '<span class="pill good">Signed</span>'
        : a.waiverSigned
          ? '<span class="pill bad">Expired</span>'
          : '<span class="pill bad">Missing</span>';

      var minorNote = a.isMinor
        ? '<div class="muted small">Minor · guardian: ' + escapeHtml(a.guardianName || '–') + '</div>'
        : '';
      var emergency = a.emergencyContact
        ? '<div class="muted small">ICE: ' + escapeHtml(a.emergencyContact.name) + ' ' +
          escapeHtml(a.emergencyContact.phone) + '</div>'
        : '';

      tr.innerHTML =
        '<td><strong>' + escapeHtml(a.name) + '</strong>' +
        '<div class="muted small">' + escapeHtml(a.email || '') + '</div>' +
        minorNote + emergency + '</td>' +
        '<td class="mono small">' + escapeHtml(a.bookingRef) +
        (a.overbooked ? '<div class="pill warnp">Overbooked</div>' : '') + '</td>' +
        '<td>' + (a.paid
          ? '<span class="pill good">Paid</span>'
          : '<button class="btn small ghost" data-pay="' + escapeHtml(a.bookingRef) + '">Mark paid</button>') +
        '</td>' +
        '<td>' + waiverPill + '</td>' +
        '<td>' + (a.chronoOk ? '<span class="pill good">OK</span>' : '<span class="muted">–</span>') + '</td>' +
        '<td class="small">' + (a.checkedInAt
          ? escapeHtml(new Date(a.checkedInAt).toLocaleTimeString())
          : '<span class="muted">–</span>') + '</td>' +
        '<td>' + (a.checkedInAt
          ? '<button class="btn small ghost" data-undo="' + a.attendeeId + '">Undo</button>'
          : '<button class="btn small" data-checkin="' + a.attendeeId + '"' +
            (a.waiverValid ? '' : ' disabled title="No valid waiver on file"') +
            '>Check in</button>') +
        '</td>';

      el.rosterBody.appendChild(tr);
    });
  }

  el.rosterBody.addEventListener('click', async function (event) {
    var target = event.target;
    if (!target.getAttribute) return;

    var checkIn = target.getAttribute('data-checkin');
    var undo = target.getAttribute('data-undo');
    var pay = target.getAttribute('data-pay');
    if (!checkIn && !undo && !pay) return;

    target.disabled = true;
    try {
      if (checkIn) {
        var chronoOk = window.confirm('Has this replica passed chrono?\n\nOK = chrono passed, Cancel = not yet.');
        await api('/api/admin/attendees/' + checkIn + '/check-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chronoOk: chronoOk }),
        });
      } else if (undo) {
        await api('/api/admin/attendees/' + undo + '/undo-check-in', { method: 'POST' });
      } else if (pay) {
        await api('/api/admin/bookings/' + encodeURIComponent(pay) + '/mark-paid', { method: 'POST' });
      }
      await loadRoster();
    } catch (err) {
      showError(err.message);
      target.disabled = false;
    }
  });

  el.sweep.addEventListener('click', async function () {
    clearError();
    try {
      var result = await api('/api/admin/sweep-holds', { method: 'POST' });
      el.sweepResult.textContent = 'Released ' + result.released + ' expired hold(s).';
      await loadRoster();
    } catch (err) {
      showError(err.message);
    }
  });

  if (token) {
    loadEvents()
      .then(function () {
        el.auth.classList.add('hidden');
        el.app.classList.remove('hidden');
        el.signOut.classList.remove('hidden');
      })
      .catch(function () { signOut(); });
  }
})();
