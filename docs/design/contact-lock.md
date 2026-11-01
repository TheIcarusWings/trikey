# Alert contacts can lock the guardian

Status: built. Written 2026-11-01, against `main` after 0.1.7. DESIGN.md (rule 8, rule 4, threat model) and
PROTOCOL.md ("Alert contacts can lock the guardian") describe it as built.

The owner decided that alert contacts (people the owner trusts, each just a nostr pubkey using any ordinary nostr app)
should be able to **lock** the guardian when they see something the owner did not do: a recovery starting, the limit
turned off, rules changed. It is **the owner's choice**: an opt-in setting, off by default, so nothing changes for anyone
who does not turn it on.

## What was built

| Part | What it does |
|---|---|
| The rule | `contactLock` in the wallet's rules (`Policy.contactLock`). Present only when on. |
| The command | A NIP-17 DM to the guardian whose text is the single word `LOCK` (any case, optional `.` or `!`, quoted `>` lines and blank lines ignored). |
| The effect | The locked state of `guardian.lock`: key 3 leaves memory, nothing is co-signed, phone-only payments stop. Recoveries, their timers and their alerts run on as on any locked guardian; a ready recovery is co-signed once the owner unlocks. |
| Unlocking | Unchanged: the passphrase in the web UI, or the phone's `guardian.unlock` with its own throttle. |
| Answers | While on, to a current alert contact: locked / already locked. While off: nothing, to anyone. To anyone else: nothing. |
| Alerts | A durable `contact_lock` notice (retried for 7 days like `limit_off`): `guardian_locked` with `reason: "contact"` and the contact to the paired phone, a DM naming the contact and the time to every other alert contact. Logged as "Locked by alert contact npub… via nostr". |
| Turning it on / off | On: the phone alone (tightening), also at pairing and during a recovery. Off: a hardware approval over the version-3 text, `lock=off`. The contacts are told either way. |
| Gating | `contact_lock` in `guardian.status.features` and in `pair.prepare.features`; the phone sends the rule only to such a guardian. |
| Phone | Settings > Alert contacts: a "Contacts can lock the guardian" switch (only with the feature), with what it allows, what it does not, and the worst case. Home's locked card and Activity name the contact (by the name the phone keeps). |
| Web UI | Rules: "Contacts can lock the guardian: On/Off" with its meaning. Locked screen: "Locked by alert contact npub… via nostr". Activity: the guardian's entries. |

Code: `apps/guardian/src/dm-lock.ts` (the command), `Guardian.lockByContact`, `PolicyEngine.noteContactLock`, the
`contact_lock*` notices in `alerts.ts`; `packages/protocol` (`Policy.contactLock`, `approvalMessage` v3,
`GUARDIAN_FEATURES.contactLock`); `TrikeyWallet.setContactLock` / `contactLockSupported` / `guardianLock`; the app's
`setContactLock` and `CONTACT_LOCK` words.

## Decisions, and what was rejected

**1. The command is the bare word `LOCK`, with no code.** The guardian's DM thread is a dedicated conversation in the
contact's app, so anything sent there is meant for the guardian; requiring the whole message to be the one word (not
"lock" somewhere in it) already stops conversational accidents ("don't lock it", "lock?"). Rejected:

- *`LOCK <short code from the alert>`.* It would make locking depend on finding the right alert, codes would have to
  expire or be tied to one event, and a contact who hears from the owner by phone ("my phone was stolen") has no alert
  to copy a code from. The thing it protects against, an accidental lock, costs one unlock. Friction in an emergency
  costs more than that.
- *A confirmation round ("reply YES to lock").* Same trade: slower when it matters, for a nuisance-only mistake.
- *Matching "lock" anywhere in the text* (as `CANCEL <id>` is found anywhere): too easy to trigger by accident.

**2. The setting is a policy member that exists only when on.** Rejected: an always-present boolean (it would change
every policy's canonical JSON and hash, need a protocol version bump and change the hardware wallet text for everyone),
and a setting outside the policy with its own RPC and approval kind (the hardware approval of any other change would
not commit to it, and the owner asked for it to be part of the wallet's rules). Present-only-when-on keeps every policy
without it, its hash and its approval text byte for byte as before; older guardians refuse the member (their `Policy`
schema is strict), so the phone sends it only to a guardian that lists `contact_lock`, as with `limit_off`.

**3. Turning it off needs the hardware wallet; turning it on does not.** On only adds protection: it lets people the
owner chose stop the guardian, which never helps a thief (a thief with the phone would want it off). So on is a
tightening, allowed from the phone alone, at pairing and during a recovery, like lowering the limit. Off takes the
protection away, which is exactly what a phone thief would do before draining the daily limit, so it is a loosening and
needs a fresh hardware approval; like every hardware-approved change it is refused during a recovery.

**4. Version-3 approval text, `lock=on` / `lock=off`.** The device screen must say what is being approved. Version 3 is
used when the new rules have it on (`lock=on`) and when the current rules have it on and the new ones do not
(`lock=off`), so turning it off says so in words; the guardian rebuilds the text from the request and its own current
rules. The worst case is 238 characters, under the 240 every device can sign. Rejected: keeping version 1 for turning
off (the device would show an unchanged limit, delay and fee cap and nothing about the lock, so a malicious phone could
present it as a routine re-approval), and a longer token such as `contactlock=off` (over 240 in the worst case).

**5. Who gets an answer.** While the setting is on, a current alert contact gets one short answer (locked, or already
locked). While it is off, the command does not exist: no answer, nothing remembered, nothing in the activity log, for
contacts as for anyone (owner's decision, 2026-11-01: "if the setting is off the contact shouldn't even be able to
lock; that should not be an option"). An earlier build answered "not allowed" then; dropped. Anyone else gets nothing
either way: answering strangers (or the paired phone's key, or a recovery's snapshotted recipients who are no longer
contacts) would let anyone learn whether a key is a contact or whether the setting is on. So owners who never turn it
on see no change at all.

**6. Replays, freshness and rate limits.** Relays re-deliver gift wraps from the last two days after every restart,
and an old `LOCK` must never lock again after the owner unlocked. Each message is remembered durably (the same store
as state-changing RPC requests) until it is no longer fresh, and only messages whose own timestamp is within 10 minutes
of the guardian's clock count. A message already handled is dropped before the rate limit, so re-deliveries do not use
up a contact's allowance. At most 5 `LOCK` messages per contact per hour are handled (in memory: a restart locks the
guardian anyway). Rejected: "ignore messages written before the last unlock", which a contact whose clock is a minute
behind could never get past.

**7. Who is alerted.** The paired phone and every other alert contact, durably, like `limit_off`; not the contact who
locked it (they got the answer to their DM). The contacts are also told when the setting is turned on (with the
command: otherwise they would not know it exists) and off (so they know `LOCK` no longer works), and while it is on the
recovery and limit-off DMs end with how to lock. The guardian names a contact by npub: it knows no names. The phone
shows the name it keeps for that contact.

**8. Unlocking is unchanged.** The phone's `guardian.unlock` still works after a contact's lock (with its own throttle,
and refused while a recovery the phone did not start runs, as before). See open question 1.

**9. The lock reason is kept in memory.** After a restart the guardian says `restart`, as for any other lock; the
activity log keeps the contact's lock. `guardian.status.lock` reports the reason and the contact while locked.

**10. Replace guardian.** The rules move to the new guardian; one without `contact_lock` is paired without the rule
(the owner turns it on there once it is updated) rather than failing the move.

## Threats

- A contact, or someone with a stolen contact key, can at worst **lock** the guardian, again each time the owner
  unlocks it (5 messages per hour): a nuisance. The owner pays with the hardware wallet meanwhile, unlocks, and removes
  that contact or turns the setting off, both with the hardware wallet. A contact can already do more harm by cancelling
  a genuine recovery.
- A lock delays a ready recovery's sweep until the owner unlocks it. For a lost-phone recovery the owner unlocks in the
  web UI (a phone with recovery access may not call `guardian.unlock`); the guardian completes the recovery right after
  the unlock.
- It gives a contact nothing else: no unlock, no rule change, no balances, no wallet data, and strangers learn nothing.
- It does not stop a recovery (`CANCEL` does) and does not help against a thief holding both the phone and the
  hardware wallet, who needs no guardian.

## Owner's answers (2026-11-01)

Kept as built: unlocking unchanged (web UI or the phone's `guardian.unlock`, both with the passphrase); the switch only in
Settings, not in onboarding; 5 messages per contact per hour and 10 minutes of clock tolerance; no RPC lock for Trikey
apps used as contacts. Changed: with the setting off a contact's `LOCK` gets no answer (decision 5 above).

## The questions as they were asked

1. Should a contact's lock make the phone's `guardian.unlock` refuse (web UI only, like a recovery the phone did not
   start)? A contact who locks because the phone looks stolen would want that; a thief would also need the passphrase.
   Built as asked: unlocking unchanged.
2. Onboarding: the wallet and the guardian accept the rule at pairing (`pair`), but the app's onboarding screens do not
   offer the switch yet; it is in Settings > Alert contacts after pairing. Add it to onboarding?
3. Limits: 5 messages per contact per hour, and 10 minutes of clock tolerance. Keep, or tune?
4. Should the "not allowed" answer stay (it tells a contact the setting is off), or should contacts get silence too
   while it is off?
5. Should Trikey apps used as alert contacts get an RPC `guardian.lock` for contacts as well? Not built: contacts use
   plain DMs, which every nostr app can send.
