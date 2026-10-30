// The passkey test (passkey-test.html): makes a throwaway passkey for this site and checks whether the password
// manager supports the WebAuthn PRF extension, which a Trikey guardian needs for a passkey that unlocks key 3
// (docs/design/passkey-unlock.md). Nothing is sent anywhere; the PRF output itself is never shown.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { credentialId: null, createPrf: null, details: [] };

  // The same salt every time on this page: the test only asks whether a PRF output comes back, and whether the same
  // passkey gives the same output twice (it must, for unlocking to work).
  const SALT = new TextEncoder().encode('trikey/passkey-test/v1/prf-salt..').slice(0, 32);

  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  function browserName() {
    const ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/Chrome\//.test(ua)) return 'Chrome or Chromium';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'unknown';
  }
  function platformName() {
    const ua = navigator.userAgent;
    if (/Android/.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS / iPadOS';
    if (/Mac OS X/.test(ua)) return 'macOS';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return 'unknown';
  }

  function showError(text) {
    const el = $('error');
    el.textContent = text;
    el.hidden = false;
  }
  function clearError() {
    $('error').hidden = true;
  }

  function show(kind, verdict, explain) {
    const box = $('result');
    box.className = kind;
    $('verdict').textContent = verdict;
    $('explain').textContent = explain;
    const table = $('details');
    table.replaceChildren();
    for (const [k, v] of state.details) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      const b = document.createElement('td');
      a.textContent = k;
      b.textContent = v;
      tr.append(a, b);
      table.append(tr);
    }
    box.hidden = false;
  }

  function note(k, v) {
    const i = state.details.findIndex(([key]) => key === k);
    if (i >= 0) state.details[i] = [k, v];
    else state.details.push([k, v]);
  }

  async function create() {
    clearError();
    if (!window.PublicKeyCredential || !navigator.credentials) {
      showError('This browser has no passkey support (WebAuthn).');
      return;
    }
    state.details = [
      ['Browser', browserName()],
      ['System', platformName()],
      ['Page address', location.host],
    ];
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: 'Trikey passkey test' },
          user: { id: random(16), name: 'Trikey passkey test', displayName: 'Trikey passkey test' },
          challenge: random(32),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: { eval: { first: SALT } } },
        },
      });
      state.credentialId = cred.rawId;
      const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
      state.createPrf = ext.prf || null;
      note('Passkey made', 'yes');
      note('Kind', cred.authenticatorAttachment === 'platform' ? 'on this device (or its password manager)' : cred.authenticatorAttachment === 'cross-platform' ? 'another device or a security key' : 'not reported');
      note('PRF when made', ext.prf ? (ext.prf.enabled === true ? 'enabled' : ext.prf.enabled === false ? 'not enabled' : 'answered, without saying') : 'no answer (the browser or manager ignored it)');
      if (ext.prf && ext.prf.results && ext.prf.results.first) note('PRF output at creation', `${ext.prf.results.first.byteLength} bytes`);
      $('use').disabled = false;
      show('warn', 'Passkey made. Now use it (step 2).', 'Whether PRF works only shows when the passkey is used.');
    } catch (e) {
      showError(`No passkey was made: ${e && e.name ? `${e.name}: ` : ''}${e && e.message ? e.message : String(e)}`);
    }
  }

  async function getPrf() {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: state.credentialId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    const ext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const out = ext.prf && ext.prf.results && ext.prf.results.first;
    return out ? new Uint8Array(out) : null;
  }

  async function use() {
    clearError();
    try {
      const first = await getPrf();
      if (!first) {
        note('PRF output when used', 'none');
        show('bad', 'No PRF: this passkey could sign you in, but not unlock a guardian.',
          'The password manager (or browser) made and used the passkey but returned no PRF output. Try another browser, or another password manager, on this device.');
        return;
      }
      note('PRF output when used', `${first.length} bytes`);
      // Unlocking needs the same output every time: ask once more and compare (only a short fingerprint is kept).
      const second = await getPrf();
      const digest = async (b) => hex(await crypto.subtle.digest('SHA-256', b)).slice(0, 8);
      const same = !!second && (await digest(first)) === (await digest(second));
      note('Same output twice', second ? (same ? 'yes' : 'NO') : 'second try gave none');
      first.fill(0);
      if (second) second.fill(0);
      if (same) {
        show('good', 'PRF works: this passkey could unlock a guardian.',
          'The password manager returned the same 32-byte secret each time the passkey was used, which is what a passkey unlock slot needs.');
      } else {
        show('bad', 'PRF is not stable here.', 'The output changed between two uses (or the second use gave none), so it could not unlock anything reliably.');
      }
    } catch (e) {
      showError(`The passkey was not used: ${e && e.name ? `${e.name}: ` : ''}${e && e.message ? e.message : String(e)}`);
    }
  }

  async function copy() {
    const text = ['Trikey passkey test', ...state.details.map(([k, v]) => `${k}: ${v}`), `Result: ${$('verdict').textContent}`].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('copy').textContent = 'Copied';
    } catch {
      showError('Copy failed; select the table and copy it by hand.');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('create').addEventListener('click', () => void create());
    $('use').addEventListener('click', () => void use());
    $('copy').addEventListener('click', () => void copy());
  });
})();
