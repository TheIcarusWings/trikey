# Motion in the phone app

Status: design handover, approved by the owner on 2026-11-11 (decisions at the end); being implemented. Written by the motion design session for the
session that implements it. No app code was changed.

Canvas with the live prototypes: <https://claude.ai/artifact/NV6PFVBx7RSymcqBTtDdh8>
("Trikey motion", private to the owner). It has 14 boards under `project/*.dc.html`. Each
proposed board is an HTML/CSS prototype that plays in a loop; its `<style>` block holds the
exact durations, delays and curves, and each row has a note with the timings. CSS values must
be translated to Reanimated; the overshoot beziers in the CSS stand in for the springs below.

Only the Security banner transition and the opening sequence were rendered and checked frame
by frame by the design session. The prototypes approximate the app's components (activity
rows, button radius): judge the motion, not the pixels. "Today" boards exist only for rows 1-3.

## What the owner has and has not confirmed

Asked for or iterated on by the owner through canvas comments:

- rows 1-3, with two observable send steps, not three;
- no check drawn over the hardware-wallet picture;
- a pulsating "Unconfirmed" dot;
- the balance changing as one whole number (a per-digit roll was rejected);
- the Security tile layout, after a Bitkey Security Hub screenshot;
- the Security banner illustration, its entrance and its "not set to all set" transition;
- a pulsating dot while syncing;
- the recovery countdown split over two lines;
- a richer app-opening animation.

Not explicitly confirmed. Ask the owner, or build as drawn and flag it:

- the three key marks and "Signed by this phone and your guardian" on Sent;
- the daily-limit number and bar on Sent;
- bold first and last four characters of the address;
- the new strings "Guardian unlocked" and "Phone payments work again.";
- the Security tile grid as the final layout (Recovery Key mode variants are not drawn;
  "Phone safety" and "Lost a key?" became tiles);
- the second opening animation and its length of about 2s (the first version was called not
  good enough; no verdict yet on the second);
- overshoot versus flat springs.

## Shared tokens (build first, for example `src/theme/motion.ts`)

| Token | Value | Use |
|---|---|---|
| standard | `withTiming` 240ms, `Easing.bezier(0.2, 0, 0, 1)` | arriving or changing |
| exit | `withTiming` 160ms, `Easing.bezier(0.4, 0, 1, 1)` | leaving; always shorter than entering |
| settle spring | damping 14, stiffness 180, mass 1 | the success check only |
| firm spring | damping 26, stiffness 300, mass 1 | layout, tab pill; no bounce |
| pop spring | damping 12, stiffness 220, mass 1 | status dots, key marks |
| toast spring | damping 16, stiffness 200 | the toast |
| scan-frame spring | damping 20, stiffness 260 | the pairing frame |
| breathe | opacity 1 to 0.35, 2.4s ease-in-out loop (1.6s for small key marks) | waiting only |
| pulse ring | scale 1 to 2.6, opacity 0.55 to 0, 1.8s, `bezier(.2, 0, .3, 1)` | status dots |
| stagger | 50-80ms, at most 6 items | staged entrances |
| press | scale 0.96 in 90ms, spring back | buttons; list rows dim instead |

Rules:

- One success gesture (the drawn check), one waiting gesture (breathing or a pulse), one
  refusal gesture (a single shake).
- Motion never delays a button, hides a warning, or plays on Cancel.
- Animate only opacity, transform and colour, plus SVG `strokeDashoffset` through
  `animatedProps`. Everything runs on the UI thread. No layout animation except the two
  height changes noted below.
- Every state change also has a static cue (words or an icon).
- Animations retarget when the state changes mid-flight.
- Reduced motion (`useReducedMotion`): no movement anywhere; states swap with a 150ms
  opacity fade; waiting is stated in words. Each board has a `reducedMotion` tweak.
- Loops: activity loops (waiting for the hardware wallet, signing, guardian "Checking…",
  start-up) run while the wait lasts. Status loops stop: the "Unconfirmed" dot and the
  Security "needs you" dot pulse 3 times, then rest still (WCAG 2.2.2).
- Haptics: the existing kinds in `src/lib/haptics.ts` only. None new.
- No new dependency: `react-native-reanimated`, `react-native-svg`, `expo-haptics`.
- Screen readers: announce changes politely; assertive only for the recovery alert. Never
  move focus to the toast.

## 1. Payment sent

Board `Main.dc.html`. Screens `app/send/review.tsx`, `app/send/done.tsx`.

- Trigger: `sendPayment` starts. The Send button crossfades (240ms) into a status strip in
  the same place. The details panel and the reason line dim to 45%.
- Step 1, busy and not `paymentSending`: "Signing with your guardian…". The phone and
  guardian key marks breathe (1.6s). The hardware key mark stays at 45%.
- Step 2, `state.paymentSending`: the two marks fill green (240ms), a link between them
  draws (scaleX, 200ms), the text crossfades (160ms) to "Signed. Sending…". Only these two
  steps are observable today: do not animate a third.
- Sent: the Review content exits (160ms, up 12px); route replace with a fade; the 72px
  circle scales 0.6 to 1 with the settle spring; the check draws (`strokeDashoffset`, 320ms
  standard, 140ms after the circle); haptic `success` as the check starts; title, amount
  line, confirm line, signed-by row and limit card rise 8px and fade in 60ms apart from
  300ms. Buttons are usable by about 600ms.
- New UI: a signed-by row from `tx.signedBy`, drawn as three key marks; a limit card
  "Phone-only today · N sats left" whose number changes about 1s in while a 4px bar
  shortens over 600ms. Change the number as a whole (old lifts and fades 200ms, new rises
  280ms). The board still shows digits rolling: ignore that.

## 2. Waiting for the hardware wallet

Board `Hardware.dc.html`. Screen `app/send/hardware.tsx`; the same gesture applies to every
"Waiting for your <brand>…" button.

- On mount the device's lines appear 80ms apart (240ms each).
- Waiting: one ring leaves the device outline every 2.4s (scale 1 to 1.12, opacity 0.5 to
  0) and the amber status dot breathes.
- New UI: the first and last four characters of the address to compare are bold.
- Approved: the ring stops, the outline turns green (240ms), the dot turns green, the text
  crossfades to "Signed. Sending…", haptic `success`, then Sent as in section 1 with
  "Signed by this phone and your <brand>" and no limit card. No check on the device picture.
- Declined or failed: one shake (translateX -6, 6, -4, 3, 0 over 360ms), outline red, haptic
  `error`, "Try again" replaces the status.
- The warning notice ("This ends your refills") never animates.

## 3. Money received

Board `Receive.dc.html`. `src/components/toast-host.tsx`; `BalanceHeader` and
`ActivityPreview` in `src/components/home.tsx`.

- Toast: translateY -80 to 0 with the toast spring, opacity 120ms, haptic `light` as today.
  It stays at least 5s and leaves upward in 160ms.
- Balance: the old figure lifts 12px and fades (200ms); the new one rises into place
  (280ms). Never animate while the balance is hidden.
- New UI: while the toast is up, the line under the balance reads
  "+21,000 sats · unconfirmed" in the good colour, then returns to the BTC line.
- New row in Recent: height 0 to row height (280ms; a layout animation), content fades in
  and drops 6px. Its 8px amber dot pulses 3 times, then rests until the first confirmation.

## 4. Pairing the guardian, and "You're all set"

Boards `Pair.dc.html`, `AllSet.dc.html`. Screens `app/(onboarding)/scan-guardian.tsx`,
`all-set.tsx`.

- Scanning: the corner frame breathes (2.4s).
- Code read: the frame closes onto the code with the scan-frame spring, haptic `light`, the
  camera picture dims.
- Reaching the guardian: phone mark solid, guardian mark breathes.
- Paired: the link fills, the guardian mark and frame turn green, haptic `success`,
  "Paired with your <box>". The next step opens 700ms later.
- Refused or unreachable: the frame opens back out, the existing message shows, haptic
  `error`, no shake.
- All set: the same check as Sent; six summary rows arrive 70ms apart; buttons are present
  from the first frame.

## 5. Guardian lock and unlock

Board `Unlock.dc.html`. `GuardianDownNotice` and `LimitLine` in `src/components/home.tsx`.

- Locked to online: the padlock shackle opens (240ms); the notice turns amber to green and
  shrinks to one line, "Guardian unlocked" / "Phone payments work again." (280ms); haptic
  `success`. 1.4s later it collapses (280ms), the limit line fades in and Send returns to
  primary.
- Locking is the reverse (opens in 280ms). No haptic unless this phone locked it.
- "Guardian offline" uses the same open and close without the padlock.

## 6. Recovery alert and countdown

Board `Recovery.dc.html`. Screens `app/recover/alert.tsx`, `app/recover/waiting.tsx`.

- Alert: haptic `warning` on open, as today. The red mark scales 0.85 to 1 in 240ms with no
  bounce; text follows 50ms apart. "Cancel recovery" and "This was me" are tappable from the
  first frame and never animate. No looping motion.
- Countdown: the ring's `strokeDashoffset` sweeps from empty to its value once (900ms
  standard, 300ms delay), then stays still until a new time is read. Steps arrive 80ms
  apart; done steps draw a small check. The header "Cancel recovery" never animates.
- Cancelled: the ring empties in 400ms, haptic `success`.
- Layout change: the label is two lines, the largest unit big ("4 days", 40px) and the
  remainder under it ("2 hours left", 15px), because one 26px line overflowed the ring.

## 7. Base layer

Board `Base.dc.html`. Press feedback; balance hide and show crossfade (160ms, no blur); the
tab-bar pill slides between tabs with the firm spring while the screens crossfade (160ms).
Native stack pushes and sheets stay native.

## 8. Security tab

Board `Security.dc.html`. Screen `app/(tabs)/security.tsx`. A layout change, not only motion.

- Banner: the three keys drawn as the Trikey mark (hardware on top, phone bottom-left,
  guardian bottom-right, joined), with a title and one line: "You're all set / All three
  keys are working." or "1 thing needs you / <first issue>" with a chevron to the fix.
- Tiles, two across, each with a 10px status dot top-right and a value line.
  - Your keys: Hardware wallet (model); This phone ("Backed up · <date>" or "Not backed
    up"); Guardian ("<box> · in sync" or "Checking…"); Lost a key? ("Start a recovery").
  - Protection: Daily limit; Security waiting period; Alert contacts; Phone safety.
- The data already exists in `WalletState`; `needsYou()` stays the source of issues.
- Value text on the tile grey uses `#52525B` in light mode (7.0:1). `#71717A` measures
  4.4:1 there and fails.
- Entrance, about 1.8s, on the first visit after launch and after a change, not on every
  tab switch: banner fades in; hardware mark pops at 150ms; links draw for 450ms from
  450ms; phone mark at 700ms; guardian mark at 900ms; check draws at 1.35s; one soft ring
  from the centre at 1.45s. Tiles rise 8px, 50ms apart; dots pop from 300ms.
- Syncing: the guardian tile's dot sends a ring every 1.2s, value "Checking…", and its mark
  in the banner breathes. It pops when the sync answers.
- Needs you: that key's ring and its two links are amber and dashed, the centre shows an
  alert mark, and the tile dot is amber and pulses 3 times.
- Not set to all set, about 1.2s, haptic `success`:

  | From | What |
  |---|---|
  | 0ms | a green ring draws clockwise around the fixed key (500ms) |
  | 200ms | the banner colour crossfades amber to green (500ms) |
  | 300ms | the dashed links fade (250ms) |
  | 350ms | solid links draw (400ms) |
  | 450ms | the old text lifts out |
  | 540ms | the new text rises in (overlapping: the banner is never empty) |
  | 550ms | the alert mark fades |
  | 750ms | the check draws |
  | 850ms | one soft ring spreads from the centre |

  On the tile, the dot turns green with a bump and the value line crossfades.

## 9. Opening the app

Board `Open.dc.html`. `app/_layout.tsx` and `expo-splash-screen`. Second version; the
owner's verdict is pending.

- The native splash is unchanged (the static logo, 120 wide). When JS is up, hide it over an
  identical app-drawn logo: an SVG triangle and three plain views as the keys, the same
  size and colours in light and dark.
- While booting: an orange dash runs round the triangle (`strokeDashoffset`, 1.4s a lap,
  linear). Each key swells to 1.24 and sends out a ring as the dash passes.
- Ready: one last lap in 480ms; the keys answer 160ms apart; the triangle's lines retract
  (300ms).
- The keys become Home (560-600ms). X is eased with `bezier(.3, 0, .2, 1)` and Y with
  `bezier(.55, 0, .15, 1)`, so the path curves. The two dark keys grow about 1.96x into the
  Send and Receive buttons with a small overshoot. The orange key shrinks to the 8px dot of
  the limit line and turns green.
- Home fills in: the balance rises (from 300ms); the limit sentence is revealed left to
  right from its dot (450ms, from 620ms); button arrows and labels; Recent rows 80ms apart;
  the tab bar springs up from the bottom (from 660ms).
- Landing positions are measured once with `onLayout`. If a target is missing (new wallet,
  guardian locked, Recovery Key mode), that dot fades where it is.
- The overlay never takes touches. No animation when returning from the background. A fast
  boot skips the booting loop. No haptic.

## Suggested order

1. Tokens and the reduced-motion helper.
2. Sections 1-3.
3. Section 6, then 5, then 4.
4. The two layout changes (Security tab, opening animation), after the open items above are
   settled with the owner.

## References

Mobbin: Cash App, Monzo, Lloyds and Venmo sent screens. Borrowed: the sparse sent screen
(check, one sentence, two buttons). Bitkey's Security Hub for the idea of status tiles. The
key marks, limit meter, device ring, tiles and opening sequence are Trikey's own. Rule
sets used for a review pass: `better-ui` and `better-accessibility` from
`jakubkrehel/skills` (written for the web; applied as principles).

## Questions for the implementer

- Is there, or can there be, a signal between "phone signed" and "guardian co-signed"? Only
  `busy` and `state.paymentSending` are visible today, so section 1 uses two steps.
- Does the destructive button in dark mode use dark text on `#F87171`, or white as on the
  design board (2.77:1)?
- Is there a last-sync time for the guardian, or only `synced` and `syncing`? The Security
  tile says "in sync" and needs no time, but a time would be better.
- Does `expo-splash-screen` hide cleanly over an app-drawn logo of the same size on both
  platforms, or is there a visible jump today?
- `haptics.ts` fires `success` when Sent opens; section 1 moves it to the moment the check
  starts drawing, about 240ms later. Any objection?

## Owner decisions (2026-11-11, recorded by the implementing session)

- Build as drawn: the Sent screen extras (key marks, "Signed by…", the limit card), the bold first and last four characters of the address, "Guardian unlocked / Phone payments work again.", the Security tab tiles as the final layout, and the second opening animation (about 2s).
- Springs: keep the small overshoot as specified.
- The Redesign review: each finding is checked against the shipped app, and the real ones are fixed in a separate PR for review.

## Answers to the questions for the implementer

- **A signal between "phone signed" and "guardian co-signed":** there is none. The app sees `busy`, then `payment_signed` (`paymentSending`), then the result. Section 1's two steps stay.
- **The destructive button in dark mode:** the app already uses dark ink on the red (`--destructive-foreground`, `#09090B`, in `apps/mobile/global.css`). Review finding 1 is a board-only issue.
- **The guardian's last-sync time:** `syncedAt` exists in the wallet state, so the Security tile can say "in sync · 2 min ago".
- **The splash hand-off:** checked on a device when section 9 is built.
- **Moving the `success` haptic** to when the check starts drawing: agreed.
