# Screen designs

Static mockups of every app and guardian screen, one file per screen.

- **App screens** show iOS (390×844) and Android (412×915) side by side.
- **Guardian screens** (`Guardian-*`, `Family-Invite`) are the guardian's web UI
  at desktop width and reflow on narrow screens.

Colors are written as `{{t.name}}` placeholders. Each file's
`<script data-dc-script>` block defines the `light` and `dark` values: shadcn/ui
zinc neutrals, with `brand` (orange) used only in the logo. Type is Geist and
Geist Mono.

| Group | Files |
|---|---|
| Onboarding | `Main`, `Onb-*` |
| Everyday | `Home`, `Home-Locked`, `Activity`, `Receive`, `Receive-Verify`, `Send-*`, `Tx-Detail` |
| Settings | `Settings`, `Settings-*` |
| Recovery | `Recover-*` |
| Guardian web UI | `Guardian-*` |
| Recovery Key mode | `RK-*` |
| Family hosting (later) | `Family-Invite`, `Family-Accept` |

Links between files follow the user flow, so you can read a flow by following
the `href`s.
