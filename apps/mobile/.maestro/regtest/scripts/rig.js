// One call to the UI test rig's control API (e2e/scripts/ui-rig.ts, http://127.0.0.1:8790 on the computer that runs
// Maestro): what a person does outside the phone, such as making a pairing code on the guardian's page or paying the
// wallet from another one. Maestro runs this on the computer, not on the phone.
//
//   - runScript:
//       file: scripts/rig.js
//       env:
//         CALL: /fund            the endpoint
//         ADDRESS: bcrt1q...     query parameters, each only when set: ADDRESS, SATS, BLOCKS, GUARDIAN, KEY, VALUE
//
// The answer (JSON) is in `output.rig` for the next steps (`${output.rig.uri}`). An answer other than 200 fails the step
// with the rig's own message.
var base = typeof RIG_URL !== 'undefined' && RIG_URL ? RIG_URL : 'http://127.0.0.1:8790';
var params = [];
function add(name, value) {
  if (typeof value !== 'undefined' && value !== null && String(value) !== '') params.push(name + '=' + encodeURIComponent(String(value)));
}
add('address', typeof ADDRESS !== 'undefined' ? ADDRESS : undefined);
add('sats', typeof SATS !== 'undefined' ? SATS : undefined);
add('blocks', typeof BLOCKS !== 'undefined' ? BLOCKS : undefined);
add('guardian', typeof GUARDIAN !== 'undefined' ? GUARDIAN : undefined);
add('key', typeof KEY !== 'undefined' ? KEY : undefined);
// A text copied from the screen may come with its accessibility label in front ("Recovery code: ...").
add('value', typeof VALUE !== 'undefined' ? String(VALUE).replace(/^Recovery code:\s*/, '') : undefined);
var url = base + CALL + (params.length ? '?' + params.join('&') : '');
var res = http.get(url);
if (res.status !== 200) throw new Error('rig ' + CALL + ' answered ' + res.status + ': ' + res.body);
output.rig = json(res.body);
// Kept values (the recovery code) stay out of the log.
console.log('rig ' + CALL + ': ' + (CALL === '/kv' ? 'ok' : res.body));
