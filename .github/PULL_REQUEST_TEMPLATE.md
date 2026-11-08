## What

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- Threat model, bug, or docs gap this addresses. -->

## How tested

- [ ] `npm run typecheck`
- [ ] `npm test` (or the relevant workspace tests)
- [ ] New behaviour has a regression test (required for signing / guardian / protocol changes)
- [ ] Docs updated if the wire format or operator steps changed (`PROTOCOL.md`, `DESIGN.md`, packaging)

## Security

- [ ] No seeds, private keys, passphrases, signing certs, or `.env` files
- [ ] Test vectors use throwaway keys or published BIP vectors
- [ ] If this changes co-signing or recovery rules: includes the case that must be refused
