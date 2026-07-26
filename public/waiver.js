/* Waiver signing. The server decides minor status from the date of birth and
   re-checks the version hash -- everything here is convenience, not authority.

   The page runs in one of two modes:

     ?token=...   the seat-specific link that comes with a booking. Age is
                  judged against that game day and the signature is attached to
                  the seat.
     no token     the standalone waiver linked from the Games page. Age is
                  judged as of today and the signature is filed against the
                  player's email, which is the same identity a booking uses. */
(function () {
  'use strict';

  var token = new URLSearchParams(window.location.search).get('token') || '';
  var standalone = token === '';
  var data = null;

  var el = {
    heading: document.getElementById('heading'),
    intro: document.getElementById('intro'),
    form: document.getElementById('form'),
    error: document.getElementById('error'),
    done: document.getElementById('done'),
    body: document.getElementById('waiverBody'),
    versionLine: document.getElementById('versionLine'),
    dob: document.getElementById('dateOfBirth'),
    ageHint: document.getElementById('ageHint'),
    guardianBlock: document.getElementById('guardianBlock'),
    signature: document.getElementById('signature'),
    signatureHint: document.getElementById('signatureHint'),
    signerName: document.getElementById('signerName'),
    guardianName: document.getElementById('guardianName'),
    agreed: document.getElementById('agreed'),
    submit: document.getElementById('submit'),
  };

  function showError(message) {
    el.error.textContent = message;
    el.error.classList.remove('hidden');
  }

  function clearError() { el.error.classList.add('hidden'); }

  async function api(path, options) {
    var res = await fetch(path, options);
    var payload = null;
    try { payload = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      throw new Error(
        (payload && payload.error && payload.error.message) ||
        'Something went wrong (' + res.status + ').',
      );
    }
    return payload;
  }

  /* Mirrors the server's calculation so the guardian fields appear at the right
     moment. The server recomputes it and is the one that decides. The date it
     counts to differs by mode: the game day for a booked seat, today for a
     waiver signed ahead of time. */
  function ageAtPlay() {
    if (!el.dob.value || !data) return null;
    var dob = new Date(el.dob.value + 'T00:00:00Z');
    if (isNaN(dob.getTime())) return null;
    var at = standalone ? new Date() : new Date(data.event.startsAt);
    var age = at.getUTCFullYear() - dob.getUTCFullYear();
    var m = at.getUTCMonth() - dob.getUTCMonth();
    if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
    return age;
  }

  function refreshAge() {
    var age = ageAtPlay();
    var adultAge = data.waiver.adultAge;
    var minAge = data.waiver.minimumAge;

    if (age === null) {
      el.ageHint.textContent = '';
      el.guardianBlock.classList.add('hidden');
      el.signatureHint.textContent = 'For a player under 18, type the guardian’s name.';
      return;
    }

    if (age < minAge) {
      el.ageHint.textContent = 'Players must be at least ' + minAge +
        (standalone ? ' to sign.' : ' on the day of the game.');
    } else {
      el.ageHint.textContent = (standalone ? 'Age: ' : 'Age on game day: ') + age + '.';
    }

    var isMinor = age < adultAge && age >= 0;
    el.guardianBlock.classList.toggle('hidden', !isMinor);
    el.signatureHint.textContent = isMinor
      ? 'Type the guardian’s full legal name.'
      : 'Type the player’s full legal name.';
  }

  el.dob.addEventListener('input', function () { if (data) refreshAge(); });

  el.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearError();

    var age = ageAtPlay();
    var isMinor = age !== null && age < data.waiver.adultAge;
    var expectedSignature = isMinor ? el.guardianName.value : el.signerName.value;

    if (!el.agreed.checked) return showError('Tick the box to confirm you agree to the waiver.');
    if (!expectedSignature.trim()) {
      return showError(isMinor ? 'Enter the guardian’s name.' : 'Enter the player’s name.');
    }
    if (el.signature.value.trim().toLowerCase() !== expectedSignature.trim().toLowerCase()) {
      return showError('The typed signature must match the signing name exactly.');
    }

    var payload = {
      signerName: el.signerName.value,
      dateOfBirth: el.dob.value,
      email: document.getElementById('email').value,
      agreed: true,
      acceptedSha256: data.waiver.sha256,
      emergencyContact: {
        name: document.getElementById('emergencyName').value,
        phone: document.getElementById('emergencyPhone').value,
      },
    };
    if (isMinor) {
      payload.guardian = {
        name: el.guardianName.value,
        relationship: document.getElementById('guardianRelationship').value,
        email: document.getElementById('guardianEmail').value,
        phone: document.getElementById('guardianPhone').value,
      };
    }

    el.submit.disabled = true;
    el.submit.textContent = 'Signing…';

    try {
      var result = await api(
        standalone ? '/api/waiver/sign' : '/api/waiver/attendee/' + encodeURIComponent(token),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      el.form.classList.add('hidden');
      el.done.classList.remove('hidden');
      el.done.innerHTML = standalone
        ? doneStandalone(result)
        : '<strong>Signed.</strong> Valid until ' +
          new Date(result.expiresAt).toLocaleDateString() +
          '. Show this booking reference at check-in: <span class="mono">' +
          escapeHtml(result.bookingRef) + '</span>';
    } catch (err) {
      showError(err.message);
      el.submit.disabled = false;
      el.submit.textContent = 'Sign waiver';
    }
  });

  function doneStandalone(result) {
    var until = new Date(result.expiresAt).toLocaleDateString();
    var lead = result.alreadySigned
      ? '<strong>Already on file.</strong> We have this signature from ' +
        new Date(result.signedAt).toLocaleDateString() + ', valid until ' + until + '.'
      : '<strong>Signed.</strong> Valid until ' + until + ' — one year of game days.';
    var linked = result.linkedAttendees > 0
      ? ' It has been attached to your existing booking, so you are clear for check-in.'
      : ' Book a game day when you are ready; check-in will find this waiver by your email address.';
    return lead + linked + ' <a href="/register">Book a game day →</a>';
  }

  async function load() {
    try {
      data = standalone
        ? { waiver: await api('/api/waiver/current') }
        : await api('/api/waiver/attendee/' + encodeURIComponent(token));
    } catch (err) {
      el.intro.textContent = '';
      return showError(err.message);
    }

    if (standalone) {
      el.intro.textContent =
        'Every player signs this before stepping on the field. Sign it once here and it ' +
        'covers you for a year of game days — bring nothing but your ID. Players under 18 ' +
        'must be signed in by a parent or legal guardian.';
    } else {
      el.heading.textContent = 'Sign your waiver';
      el.intro.innerHTML =
        escapeHtml(data.event.title) + ' · ' +
        new Date(data.event.startsAt).toLocaleString() +
        ' · booking <span class="mono">' + escapeHtml(data.bookingRef) + '</span>';

      if (data.alreadySigned) {
        el.done.classList.remove('hidden');
        el.done.innerHTML =
          '<strong>Already signed.</strong> This waiver is valid until ' +
          new Date(data.waiverExpiresAt).toLocaleDateString() + '. Nothing more to do.';
        return;
      }
    }

    el.body.textContent = data.waiver.body;
    el.versionLine.textContent =
      'Version ' + data.waiver.version + ' · ' + data.waiver.sha256.slice(0, 16) + '…';
    if (data.name) el.signerName.value = data.name;
    if (data.email) document.getElementById('email').value = data.email;
    el.form.classList.remove('hidden');
    refreshAge();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  load();
})();
