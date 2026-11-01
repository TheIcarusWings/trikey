# Email, ntfy and webhook alerts

Status: built. Written 2026-11-01, against `main` after 0.1.7; the owner's answers to its open questions (same day) are
built too: a pinned certificate for self-signed email servers and a password-only fix during a recovery ("Decisions"
at the end). DESIGN.md ("Alerts beyond nostr", threat model), PROTOCOL.md ("Extra alert channels") and
`apps/guardian-web/API.md` ("Notifications") describe it as built.

Until now the guardian's alerts reached two places: the paired phone (nostr RPC) and the alert contacts (NIP-17 DMs).
Both need a nostr app, and the phone may be the stolen one. The owner decided to add three channels, **all inside the
guardian** (no separate Umbrel apps) and **all notify-only**:

1. **Email through the owner's own email account** (SMTP), set up in the web UI with a "Send a test message" button.
2. **ntfy push**: a server (default `https://ntfy.sh`, the owner's own recommended, such as the ntfy app on Umbrel),
   a topic and an optional access token.
3. **A generic webhook**: a URL and an optional secret; a small signed JSON payload, so Home Assistant, Apprise, an SMS
   gateway and the like can be connected.

They go to the **owner** (their own addresses: the phone may be in a thief's hands) and to **alert contacts** (an email
address and/or an ntfy topic next to a contact's nostr key, or a contact reachable only by email or ntfy).

## What was built

| Part | What it does |
|---|---|
| Channels | Email (SMTP through the owner's account), ntfy, webhook. A flat list of destinations, each one channel for one audience: `owner`, `contact` with a nostr key (`contact`), or `contact` without one. Webhooks are for the owner only. |
| Settings | Web UI, Settings > Notifications (`GET`/`PUT /api/notifications`, `POST /api/notifications/test`): the guardian's name in messages, the email account (host, port, TLS or STARTTLS, user name, app password, From, an optional pinned certificate), channels with their health and a test button. Unlocked and signed in only. |
| Storage | `notifications.json`, every secret sealed (XChaCha20-Poly1305) under a random key in `notifications-key.json` (mode 0600). Works while the guardian is locked. Secrets are write-only over the API. |
| Content | Plain text, no links, no buttons. The owner's channels get the phone's alert text; a contact's channels the contact's DM text, with "reply CANCEL / LOCK to the guardian's nostr message" (nostr contacts) or "contact the owner" (others). Named by the owner's short name for the guardian. |
| Delivery | A durable outbox: one delivery per alert and channel, retried (1, 2, 5, 10, 30, 60 minutes, then hourly) for 7 days, each alert once, a newer recovery reminder replacing an older undelivered one. Per-channel health in the web UI; activity log entries when a channel starts failing, works again, or loses a message. |
| Changes | Announced on every channel before and after (removed ones and the old email account included), to the paired phone (`notifications_changed`) and in the activity log. While a recovery runs only additions are accepted, and a new app password for the same email account. |
| Phone | Read-only: `guardian.status.notifications` (masked), feature `notifications`; Settings > Alert contacts lists them next to each contact; an activity line when they change. No method changes them. |
| Policy | Unchanged: `Policy`, `policyHash`, every approval text and rule 4 (who may cancel and lock, the mainnet minimum of one nostr contact) are exactly as before. |

Code: `apps/guardian/src/notify/` (`notifier.ts` the outbox and settings, `secrets.ts`, `channels.ts` the three senders,
`net.ts` the address rules and the HTTP client, `render.ts` the words and the link check, `settings.ts` the checks), the
queueing in `alerts.ts` (`queueAlert`, `queueNotice`) and `Guardian.notifyOwner` / `updateNotifications`;
`apps/guardian-web/src/pages/settings-notifications.tsx` and `src/lib/notifications.ts`; `packages/protocol`
(`GUARDIAN_FEATURES.notifications`, `NotifyChannel`, the `notifications_changed` alert);
`TrikeyWallet.notificationChannels`; the app's `src/data/alert-channels.ts` and Settings > Alert contacts.

## Who may change a contact's channels: outside the policy, announced

The question: a contact today *is* a nostr pubkey in the hardware-approved `alertContacts`, and removing one is a
loosening that needs the hardware wallet (rule 4). A phone thief must not be able to silently redirect or remove
someone's alerts. Two models were on the table.

**A. Channels in the hashed policy.** Each contact's email and topic become policy members; removing or changing one
is a loosening (hardware approval), adding one a tightening (the phone alone); a feature flag, a new approval text
version, old guardians refusing the member, as for `contactLock`.

**B. Owner-side delivery settings outside the policy, every change announced.** Only the web UI (a session signed in
with the unlock passphrase, on an unlocked guardian) can change them; never the phone.

**Chosen: B**, because it is the safer of the two against the thief the question is about, and the only one that is
honest about what it protects:

- **A phone thief cannot touch B at all.** No phone method reads secrets or changes a channel; the phone gets a masked
  list. Under A the thief could at least *add* channels (a tightening), for instance their own email, and read every
  contact's address and topic from the policy the phone holds. Under B the phone sees only masked hints (`m…@example.com`,
  a server's host name), never a topic: an ntfy topic on a public server is a shared secret (anyone who knows it can read
  the alerts and post fake ones), so it must not sit in a policy on every phone and backup.
- **A cannot protect the email path anyway.** The SMTP account (server, user, app password) has to live in the
  guardian, never on the phone; whoever can change it can point every email at their own server or break it. So the
  contacts' addresses being hardware-approved would not stop a web-UI attacker from redirecting or silencing them. Under
  B the account and the addresses have the same protection, and the same mitigation:
- **Every change is announced on every channel, before and after it.** A removed channel is told it was removed, over
  its old address; when the email account changes, the announcement goes out through the account *as it was before*
  (and only if that fails, through the new one, so an owner fixing a wrong password still hears it). The paired phone gets
  `notifications_changed`, the activity log names the change. Silencing a contact therefore always tells that contact.
- **While a recovery runs, only additions are accepted**, the counterpart of "no hardware-approved rule changes during a
  recovery": nobody can quietly drop a channel in the middle of the event it exists for. The one exception is a **new
  app password for the same email account** (same server, port, encryption, user name, From address and pinned
  certificate): a revoked or expired app password must be fixable exactly when the warnings matter most, and a password
  alone cannot send the mail anywhere else. It is announced like any change ("email account changed: app password"),
  over the account as it was first, then with the new password.
- **The controls stay where they were.** Cancelling and locking are nostr DMs from the contacts in `alertContacts`, which
  rule 4 still guards. Email and ntfy add warnings, never power. The mainnet minimum of one alert contact still means a
  nostr contact (one who can cancel): a contact reachable only by email cannot cancel, so it cannot stand in for one.
- **Nothing in the protocol's trust changes:** `Policy`, `policyHash`, approval texts and every older phone and guardian
  are exactly as before; the new status member and alert are optional and ignored by older phones.

Who can change B: someone with the web UI and the unlock passphrase (on Umbrel also behind its login). That person can
already reset the guardian or change its relays (DESIGN.md, threat model); the most B adds is choosing where warnings go,
and every such choice is announced to the old destinations.

## Secrets, and alerts while locked

Alerts while locked matter most: after a power cut the guardian is locked until the owner unlocks it, and a thief who
unplugs the box and then starts a recovery from a stolen phone must not also silence the email. So the channels' secrets
cannot be under the unlock passphrase (keystore.ts), which would make a locked guardian mute.

They get the same trade-off as the guardian's nostr key (identity.ts, needed for nostr alerts while locked) and the
silent payment scan key (silent/service.ts): each secret is sealed with XChaCha20-Poly1305 under a random 32-byte key
in its own file, `notifications-key.json` (mode 0600), with associated data binding it to its place (`smtp.password`,
`<channel id>.topic`, ...). A copy of `notifications.json` alone (a backup, a support bundle) reveals no secret; someone
with the whole data directory has them, as they have the nostr key. Hence: an **app password** (revocable, mail only;
the UI says so and never asks for the account password), secrets **write-only** over the API (only "set" and hints come
back, never into logs: the logger redacts, and error texts carry no URL path or credentials), and the docs say to revoke
the app password and ntfy token if the box is lost. Rejected: deriving the key from the passphrase (mute while locked);
a key derived from the nostr key (no better at rest, and ties two unrelated secrets together).

## Content

- **Plain text only.** No HTML, no links, no buttons, nothing that asks to sign in. A last check (`defang` in
  `render.ts`) breaks anything that still looks like a link, an email address or a domain (`example[.]com`); the tests
  render every alert for every reader and check it was never needed. Addresses in messages are masked without their domain
  (`m…@e…`), so mail clients cannot turn them into links either.
- **The same facts as the matching nostr alert, nothing more.** The owner's channels get the phone's alert text (its
  `message`), a contact's channels the contact's DM text.
- **Controls only where they work.** A contact with a nostr key reads "reply `CANCEL <id>` to the guardian's nostr
  message, in your nostr app; replying here does nothing" (and, with rule 8 on, the same for `LOCK`). A contact without
  one reads "contact the owner". The DMs about rule 8 itself (`contact_lock_on`/`_off`) stay nostr-only.
- **Named by the owner.** A short name (letters, digits, spaces, `-`, `'`, at most 32: nothing a mail client could turn
  into a link) in the subject or title, and one closing line: "Sent by Home vault, a Trikey Guardian. Trikey alerts never
  contain links or ask you to sign in anywhere."

What goes where:

| Alert | Owner's channels | Contacts' channels |
|---|---|---|
| `recovery_started`, `_reminder`, `_ready`, `_cancelled`, `_completed` | yes | yes (contacts the recovery alerts) |
| `limit_off` | yes | yes |
| `limit_on` | yes | no (as on nostr) |
| `contact_lock` (an alert contact locked it) | yes | yes, except the one who locked it |
| `savings_moved`, `savings_unwatched` | yes | yes |
| `guardian_locked` after a restart, or from the phone | yes | no |
| `relays_changed`, `wallet_retired` (retire, reset), `wallet_adopted` | yes | no |
| `notifications_changed` | yes | yes (all of them) |
| `contact_lock_on` / `_off`, `sp_received` | no | no |

## Delivery

The semantics of the nostr notices (engine.ts `LimitNotice`): every alert is queued for every channel it is for, on disk,
**before** the first try (the nostr sends come after in the same pass, so an alert the nostr side finishes at once is
not missed). A delivery is retried after 1, 2, 5, 10 and 30 minutes and then hourly, until it is sent or 7 days old
(`NOTIFY_TTL_MS`, the notices' TTL). An alert counts once: its id is remembered for 8 days, longer than the TTL, and an
alert older than the TTL is never queued, so the engine listing an alert again (a nostr contact who never acknowledged)
never sends it twice. A newer recovery reminder replaces an older one still undelivered. The webhook payload's `id` is
the same on every retry, so a receiver can drop repeats.

Health per channel (and for the email account): `ok`, `failing` (with the error in plain words) or `untested`, shown in
the web UI and, masked, on the phone. The activity log says when a channel starts failing (once, not per retry), works
again, or loses a message after 7 days.

**Rate limits and caps:** 20 messages an hour per channel and 60 an hour through the email account (more wait; nothing is
dropped), 10 test messages per 10 minutes, 30 settings changes an hour. At most 24 channels; for the owner 3 of each
kind; one email and one ntfy topic per alert contact; 10 contacts without a nostr key; at most 100 queued alerts.

## Addresses (ntfy servers, webhooks)

Webhooks to the owner's own devices (Home Assistant, an SMS gateway on the LAN, the ntfy app on the same Umbrel) are a
real use case, so internal addresses are allowed, with rules (`notify/net.ts`):

- `http://` and `https://` only; no user name or password in the URL, no fragment, at most 512 characters.
- **Plain `http://` only to the owner's network**: private IPv4 (10/8, 172.16/12, 192.168/16, 100.64/10 as Tailscale
  uses), IPv6 ULA (fc00::/7), or names local by their form (`.local`, `.lan`, `.home.arpa`, `.internal`, `.home`, a single
  label such as a Docker service name). Anything on the internet must be `https://`, so alert text never crosses it in clear.
- **Never the box itself or a metadata service**: loopback (127/8, ::1, `localhost`), 0.0.0.0/::, link-local
  (169.254/16 where cloud metadata lives, fe80::/10), multicast and reserved ranges are refused, also when a name
  *resolves* to them. The name is resolved once per send and the connection goes to the checked address (no second lookup a
  DNS rebinding could change); `http://` to a name that resolves to a public address is refused.
- Redirects are not followed; the answer is read up to 4 KiB; a send gives up after 15 seconds. `.onion` is refused (the
  guardian has no Tor).

Inside the Umbrel's Docker network, `.local` names often do not resolve: use the box's LAN address
(`http://192.168.1.20:8080`) or the other app's service name.

The email server is the owner's provider; TLS is mandatory (implicit TLS, or STARTTLS that must succeed), certificates
are verified (at least TLS 1.2). There is no plain SMTP option and no "accept any certificate" switch; a server with a
self-signed certificate is reached by pinning exactly that certificate (next section).

## Pinned certificate (Proton Mail Bridge, self-hosted relays)

Proton Mail Bridge and small self-hosted relays make their own self-signed certificate, which public CA verification
refuses. The email account therefore has an optional **pinned certificate** (`smtp.pin` in `PUT /api/notifications`):

- **What the owner pastes:** the server's certificate (one PEM block: Bridge exports it under Settings, Advanced
  settings, Export TLS certificates, as `cert.pem`) or its **SHA-256 fingerprint** (64 hex digits, colons optional,
  also as `openssl x509 -fingerprint -sha256` prints it). The web page shows how to read it from a computer on the
  network: `openssl s_client -connect HOST:PORT -starttls smtp </dev/null 2>/dev/null | openssl x509 -noout -fingerprint
  -sha256` (without `-starttls smtp` for TLS on 465). Refused: anything holding a private key (Bridge exports `key.pem`
  next to it), several certificates, a SHA-1 fingerprint.
- **What TLS then accepts: exactly that certificate.** The pinned certificate is the connection's only CA (the public
  ones are not consulted), and the certificate the server shows must have the pinned SHA-256 (`checkServerIdentity`). The
  host name is not matched against it: the exact certificate is a stronger match, and Bridge's certificate names
  127.0.0.1 while the guardian reaches it by another address. Still at least TLS 1.2; an expired pinned certificate is
  refused (pin the new one); a different certificate is refused before any login, so the app password never reaches it.
- **A fingerprint alone** cannot be a CA, so before sending, the guardian opens one short connection that only reads the
  certificate the server shows (for STARTTLS: greeting, `EHLO`, `STARTTLS`, handshake) and closes it, sending no user name
  or password; when its SHA-256 matches the pin, the real connection trusts exactly that certificate as above (and it is
  kept in memory, so later sends need no second connection). On a mismatch the error names the fingerprint the server
  showed, so the owner can compare.
- **Unset: unchanged**, public CA verification with the host name. There is never an "accept any certificate" mode.
- **Part of the email account.** The pin is stored with the account (in clear: a certificate is public), shown in the web
  UI (its fingerprint, and whether the certificate itself or only the fingerprint was pasted), and setting, changing or
  removing it is a change of the account: announced on every channel (over the account as it was first, so pinning a
  certificate to an attacker's server cannot go unannounced) and refused while a recovery runs. Pasting the same
  certificate again, as PEM or fingerprint, is no change.
- **Why pinning and not "trust on first use" or a CA upload:** the owner states which certificate is meant, compares it
  with what Bridge shows, and nothing is learned silently from the network; a private CA would trust every certificate it
  ever signs, a pin exactly one.

## Webhook payload

`POST <url>` with `Content-Type: application/json`, version 1:

```json
{
  "version": 1,
  "id": "3-1a2b3c4d5e6f/started/d0123456789ab",
  "type": "recovery_started",
  "guardian": "Home vault",
  "wallet": "0123abcd",
  "time": "2026-11-01T12:00:00.000Z",
  "title": "Home vault: Recovery started",
  "message": "A recovery started with the phone. It moves 0.01000000 BTC (1,000,000 sats) on 2026-11-08 12:00 UTC unless cancelled.\n\nSent by Home vault, a Trikey Guardian. Trikey alerts never contain links or ask you to sign in anywhere.",
  "priority": "urgent"
}
```

- `type`: the alert (table above), `notifications_changed`, or `test`. `wallet`: the first 8 characters of the wallet id,
  when the alert is about a wallet. `priority`: `urgent`, `high`, `default` or `low`. `id`: the same on every retry.
- Headers: `X-Trikey-Event` (the type), `X-Trikey-Delivery` (the id), `X-Trikey-Timestamp` (unix seconds) and, with a
  secret, `X-Trikey-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<body>` under the secret.
- A 2xx answer is delivery; anything else (a redirect included) is retried.

Checking the signature (Node; any language with HMAC-SHA256 works the same):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, headers, rawBody) {
  const ts = headers['x-trikey-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject old replays
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`);
  const got = Buffer.from(String(headers['x-trikey-signature'] ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}
```

Connecting things: **Home Assistant**: an automation with a Webhook trigger (its URL `http://homeassistant.local:8123/
api/webhook/<id>`; the id is a secret, which is why the guardian seals the URL), then a notify action with
`{{ trigger.json.title }}` and `{{ trigger.json.message }}` (Home Assistant cannot check the signature itself; keep the
webhook id long and local). **Apprise** (API server): point the webhook at a small relay that maps `title`/`message`, or
use ntfy, which Apprise and most push tools read directly. **An SMS gateway** (an Android phone running an SMS gateway
app on the LAN, or a provider's HTTPS API behind a small relay that checks the signature): send `title` and the first lines
of `message`.

## ntfy

JSON publishing (`POST <server>/` with `{ topic, title, message, priority, tags, markdown: false }`), so titles and text
may hold any character; `Authorization: Bearer <token>` with an access token. Priority 5 for urgent alerts (a recovery
started, the limit turned off, Savings moved), 4 for high, 3 otherwise. On `ntfy.sh` anyone who knows a topic can read it
and post fake alerts to it: the web UI warns about topics shorter than 20 characters there, and recommends the owner's own
server (the ntfy app on Umbrel) with an access token. A forged ntfy message can at worst say something false; it carries
no link, and the guardian's nostr messages, which are signed, remain the reference.

## Dependencies

- **nodemailer 10.1.2** (runtime, pinned exactly; released 2026-10-16, two weeks before this was written; zero
  dependencies; MIT-0). SMTP is easy to get subtly wrong (STARTTLS downgrade, AUTH mechanisms, header injection, line
  lengths, encoding of non-ASCII text); a widely used, maintained client is less risk than a hand-written one. Only its
  SMTP transport is used, with file and URL access off.
- **smtp-server 3.19.23** (dev only, pinned; its pair from the same author, depending on nodemailer 10.1.2 exactly): the
  in-process SMTP server the tests send to. Its built-in test certificate has expired, so the tests turn certificate
  checks off through a test-only seam, and one test checks that the default refuses that certificate. The pinning tests
  run without the seam, against throwaway self-signed certificates made at test time (`test/support/self-signed.ts`, a
  P-256 certificate written in DER; no key is committed).
- ntfy and webhooks use Node's own `http`/`https` (no client library): one small function with the address checks.

## Rejected alternatives

- **Separate Umbrel apps** (an "email bridge" or "notification" app next to the guardian): more to install, update and
  secure, a second place holding secrets, and an inter-app API the guardian would have to trust. The owner decided to keep
  everything in the guardian.
- **Built-in SMS providers** (Twilio and the like): an account with a company, credentials to hold, costs per message,
  and per-country quirks, for a project whose rule is "we run nothing and depend on no company". A webhook reaches an SMS
  gateway the owner chooses, without the guardian knowing any provider.
- **Sending email directly from the box** (its own mail server): home connections usually block outgoing port 25, and
  mail from a home IP without SPF, DKIM and reverse DNS lands in spam or is refused. Alerts must arrive, so the guardian
  sends through the owner's own account, which providers trust.
- **Channels in the hashed policy** (model A above): no protection for the email path the guardian must hold anyway, a
  phone that could add channels and read every contact's topic, and a protocol and approval-text change for every wallet.
- **Email or ntfy as controls** (replying `CANCEL` by email): an unsigned channel anyone can spoof; controls stay on
  signed nostr messages.
- **Links in alerts** ("open the app", "see details"): exactly what phishing imitates. Trikey alerts never carry one.

## Decisions (owner, 2026-11-01)

The note's open questions, answered by the owner:

1. **Self-signed SMTP servers: allowed, by pinning one certificate.** Built as "Pinned certificate" above: the owner pastes
   the certificate (PEM) or its SHA-256 fingerprint; TLS then accepts exactly that certificate instead of the public CAs;
   unset, nothing changes; never "accept any certificate". The pin is part of the email account for the "every change is
   announced" rule. (Before: refused; the docs pointed to providers with public certificates.)
2. **Fixing the email account during a recovery: only the password.** While a recovery runs, the one change besides
   additions is a new app password for the existing account (same server, port, encryption, user name, From address and
   pin), announced like any change. Everything else stays add-only.
3. **Contacts and owner changes: kept as built.** Every change is announced on every channel, contacts' included (a
   generic line for them, without details).
4. **The restart message: kept as built.** The owner's channels hear "restarted and is locked" after every start of the
   guardian, updates included (a locked guardian co-signs nothing, and an unexpected restart is worth knowing about).
5. **Contact channels on the phone: kept as built.** The phone shows them read-only and cannot add one; channels are
   changed only in the web UI.
