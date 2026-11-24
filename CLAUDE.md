# Working on Trikey

Trikey is an open-source 2-of-3 bitcoin multisig: a hardware wallet, the phone app, and the user's own guardian on
Umbrel, Start9 or Docker. This repository is public: nothing private goes in it (no personal emails, names, keys,
passwords or tokens), and neither do commit messages, issues or PR text.

## Where things are

- **What Trikey is and why:** DESIGN.md. Design notes per topic: docs/design/.
- **The current plan:** docs/design/public-release.md (the 1.0 release: decisions, the three feature stages, section 5
  is the checklist) and the GitHub issues labelled `1.0`. Start there.
- **Code:** apps/mobile (Expo / React Native), apps/guardian (the guardian, Node), apps/guardian-web, packages/core,
  protocol, wallet, recovery-key, silent-payments; e2e (regtest stack, guardian tests, UI flows); tools/release.
- **Releases:** docs/releasing.md. Owner-run steps: docs/beta-checklist.md.

## Rules that don't bend

- **Secrets never pass through a session.** Never ask for, accept or write down an nsec, a `bunker://` link, a keystore
  or its password, a Nostr Wallet Connect secret, a recovery code or a seed. The owner types those into the tools
  himself (tools/release/*.mjs refuse an nsec). If one appears in a message, don't repeat it; tell the owner to rotate it.
- **Publisher key:** the founder's npub in packaging/release-signer.npub; the app pins its hex
  (apps/mobile/src/lib/publisher-key.ts). Changing it needs an app release with the new key first.
- **Feature stages** (apps/mobile/src/lib/features.ts): `test` / `preview` / `public`. A wallet feature is reached
  only through `featureOn('<id>')`; promoting one needs evidence in FEATURES (an issue link for public hardware), and
  features.test.ts checks both. Hidden means can't be turned on, never can't be read: recovery and anything an
  existing wallet uses stay available.
- **Mainnet** stays guardian mode only, behind its warning. The simulator and test tools refuse mainnet.

## How we work

- A branch and a PR per change, squash-merged. Never push to `main`. Merge a PR yourself once CI is green and it
  follows the plan; ask first for anything that changes the plan, the security model or a decision in DESIGN.md.
- Commit messages and PR text explain why, in plain words. Every PR fills in "What could break" in the template
  (.github/PULL_REQUEST_TEMPLATE.md): none / low / high for funds, keys, signing, recovery, the guardian's limits and
  what the public app shows, and why. The `PR text` check fails a PR without it.
- **Issues** are sized so one fresh session can finish one. Each says what to do and why, the files involved, what
  done looks like, and what blocks it (links to other issues). #328 to #332 are examples.
- **Mechanical mistakes become checks.** If a mistake can be caught by a machine, add a test or a CI check, as
  features.test.ts does for promotions and the `secrets` job in ci.yml does for leaked keys. This file is for
  judgement calls only. At the end of a session, ask: what should become a check?
- **Write a decision down** (DESIGN.md's "Decisions so far" table, or a note in docs/design/) when it is hard to
  reverse, would surprise someone without the context, and came from a real trade-off. Otherwise the code and the PR
  are enough.
- Hard bugs: the `diagnosing-bugs` skill (.claude/skills/diagnosing-bugs/): a failing loop first, then the fix.
- Tests: `npx vitest run --root packages/wallet` (and the other packages); the mobile tests need two shards to fit in
  memory: `cd apps/mobile && npx vitest run --shard=1/2` then `--shard=2/2`. `npm run typecheck`. Prettier isn't
  enforced in CI.
- `gh`: use `gh api` (REST) if GraphQL is refused.
- Releases need the owner three times: approving the `release` environment (Docker, Android, Publish), and signing
  the draft on his Mac (`node tools/release/sign-release.mjs v<tag>`). Give him the run links and wait; approvals
  can wait up to 7 days. After publishing, pin the Umbrel store with a PR on TheIcarusWings/trikey-umbrel-store.
