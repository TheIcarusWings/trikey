// Keeps Home's balance on the rig (/kv, key `balance`), as read by the copyTextFrom before it: the balance's label,
// "Balance: 689,962 sats. Tap to hide", without the hint. Fails unless it is a balance above zero.
var base = typeof RIG_URL !== 'undefined' && RIG_URL ? RIG_URL : 'http://127.0.0.1:8790';
var balance = String(maestro.copiedText).replace(/[.] Tap to hide$/, '');
if (!/^Balance: [0-9,]+ sats$/.test(balance) || balance === 'Balance: 0 sats') throw new Error('not a balance above zero: ' + maestro.copiedText);
var res = http.get(base + '/kv?key=balance&value=' + encodeURIComponent(balance));
if (res.status !== 200) throw new Error('rig /kv answered ' + res.status + ': ' + res.body);
output.balance = balance;
console.log('kept ' + balance);
