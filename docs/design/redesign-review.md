# Review of the Redesign page

Status: findings only, all proposed. The owner asked for the review and that it be passed to
the implementing session; no finding has been individually approved. Nothing on the canvas or
in the app was changed.

Subject: the 27 boards on the "Redesign" page of the "Trikey App Design" canvas
(<https://claude.ai/artifact/1aLGuH7Ydub81z98fBPxcE>, private to the owner), reviewed against
the `better-*` rule sets from `jakubkrehel/skills` (written for the web; applied to the phone
boards as principles). The review is of the design boards, not the shipped app: check each
finding against the code before changing it.

Method: contrast, sizes, spacing, markup and wording counts were measured by script over all
27 boards in light and dark. Findings 2, 4, 5, 16, 17 and 18 and the wording calls were
judged by reading; 9 boards were read in full. Findings 1-4 and 8 were re-checked by a second
pass against the board files.

## Fix first

1. **"Cancel recovery" fails contrast in dark mode.** `Recovery-Alert-New`: white on the
   dark-mode red `#F87171` is 2.77:1 (light passes at 4.83:1). Use dark ink on that red
   (`#09090B` gives 7.19:1), for example an `onBad` token.
2. **Amounts differ between phone and device on the approve step.** `Send-Details` and
   `Haptics`: the phone says "900,000 sats" and "420 sats"; the Ledger mock says
   "Send 0.009 BTC … fee 0.0000042"; the approve screen repeats only the address. Show the
   amount and fee there in the unit the device shows.
3. **The network name disagrees.** "Testnet" on `Home-B`, `Home-B-States`, `Send-Flow`,
   `Send-Android`, `Receive-New`, `RK-New`, `Small-Fixes`; "Signet" on `Network-Banner`,
   `First-Time` and the `G-*` boards. The warning text differs too.
4. **The silent-payment recipient is elided on Review.** `Send-Details`:
   "tsp1q qwk7 3m0k … 8e4u 2gq9". Show the full address, wrapped.
5. **"Recovery in progress" on Home looks routine.** `Home-B-States`: the same amber card
   as "Guardian locked", a text link as the only action, and Send still primary.

## Worth fixing

6. **Small touch targets on phone boards (44px).** "Change" in the review table, about 20px
   tall; the "What are network fees?" icon, 24px, directly above it (`Send-Flow`,
   `Send-Details`, `Send-Android`). "Send max" at 32px (`Send-Flow`, `Send-Android`,
   `Haptics`, `Small-Fixes`), also a muted 14px link for an action that empties the wallet.
   The network strip button at 32px (`Network-Banner`). The "Settings" back link, about
   22px (`Fix-Settings-Guardian`).
7. **Guardian web links at 32px (40px minimum).** "See all" (`G-Home`), "New code"
   (`G-Pair`), "Advanced: relays" (`G-SignIn`), the details link (`G-Recovery`).
8. **Guardian inputs are nearly invisible.** `G-SignIn`, `G-Settings`: a 1px `line` border
   on a transparent fill, 1.27:1 light and 1.34:1 dark; the minimum is 3:1.
9. **The greyed "Send" in a new wallet.** `First-Time`: `muted` at 60% opacity on `fill`,
   2.26:1 light; marked `aria-disabled` although it stays tappable.
10. **Hardware key naming.** Ledger (22 boards), hardware wallet (8), Ledger Nano X (2),
    your device (2); mixed on one screen in `Security-Tab`, `Fix-Receive-Verify`,
    `Send-Details`.
11. **Limit naming.** Phone-only payments (7), Daily limit (6), today's limit (6), left
    today (3).
12. **Third key, kit and vault.** "Recovery Kit" and "Recovery Key"; "third key" and
    "key 3"; "vault" in only two boards.
13. **Jargon on primary screens.** "My nostr app" and an `npub` in onboarding step 2;
    "Sweep fee cap", "Relays", "Chain data", "Electrs", "Guardian ID npub…" in guardian
    screens; "410 confirmations" in `Coins-Savings`.
14. **Text under 12px.** iOS tab labels at 10px (Android uses 12px); "Printed Oct 30, 2026
    · Signet" at 11px (`G-Pair`); the Recovery Kit sheet at 9-10px (`RK-New`, acceptable
    only as a thumbnail).
15. **Markup.** A QR `aria-label` reused where it is wrong (`RK-New`, `G-Pair`); actions
    drawn as links in 24 of 27 boards (about 140); `role="heading"` without a level on
    "Recent"; a disabled "Reset guardian" as a span; the Send address field as a span.
16. **Receive-verify.** `Fix-Receive-Verify` shows a green check and "Your device agrees"
    before anything is compared; the phone groups the address in fours and the device mock
    does not.

## Minor

17. Button wording: "This was me" does not say the recovery keeps running; "Cancel" on the
    approve step does not name the payment.
18. `Security-Tab`: a green dot before a description on the Ledger row, so its state is
    carried by colour alone.
19. Capitals typed into strings without tracking: "STEP 2 OF 5" (`Onb-New-1`, `Onb-New-2`),
    "STEP 1 OF 4" (`Coins-Savings`).
20. Line height on wrapping helper text: 13px/18px on seven boards; none set on some
    guardian paragraphs.
21. Changing numbers without tabular figures: the limit line and BTC line on Home, the
    limit line in the send flow, the sent-today line on `G-Home`, coin amounts.
22. Screen-title variants: four iOS titles lack the -0.02em tracking; one is 34/40; Android
    titles are 22/28 or 28/36; guardian titles 28, 26 and 24.
23. Button, card and gutter variants: primary button 48px on 13 boards with exceptions at
    44px and 40px; card radius 12, 14, 16 and 20; Android gutter 16px in flows and 24px on
    Home and Security; row heights 52, 56, 60 and 72.
24. Review table: the "Network fees" row has 8px vertical padding, its siblings 14px.
25. Time formats: "6 days, 4 hours left", "6 days, 4 h", "5 days 13 h", "resets in 9 h";
    "Today 9:42", "Today, 9:42", "Today at 9:12".

## What passed

- All in-app text on screen backgrounds meets 4.5:1 in both themes.
- Status dots clear 3:1 and, apart from finding 18, are paired with words.
- No font weight under 400; every uppercase label set by style has tracking.
- Icon-only controls have labels; decorative SVG is hidden from screen readers.
- Destructive paths name their consequences; no "Are you sure" confirmations.
- No broken plurals; no PSBT, xpub, descriptor or UTXO anywhere.

## Terminology found

| Family | Variants (boards) |
|---|---|
| Hardware key | Ledger (22), hardware wallet (8), Ledger Nano X (2), your device (2) |
| Guardian | guardian (18), Trikey Guardian (7), Umbrel (5), home server (2), key 3 (2), third key (1), the box (1) |
| Limit | Phone-only payments (7), Daily limit (6), today's limit (6), left today (3) |
| Recovery delay | security waiting period (7), waiting period (2), waits 7 days (4) |
| Contacts | alert contacts (5), contacts (3), someone you trust (2) |
| Network | Testnet (8), Signet (6), pre-alpha (7), test network (4) |
| Recovery artefact | Recovery Kit (1), Recovery Key (1), this sheet (2), seed words (2) |
| Wallet | new wallet (3), vault (2), Savings (1), Main wallet (1) |
| Reusable address | silent payment (3), reusable address (3), regular address (1) |
