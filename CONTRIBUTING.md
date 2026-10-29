# Contributing

Thanks for helping. Trikey is early, so expect things to move.

## Setup

You need Node 22 (see `.nvmrc`). Rust is only needed for `tools/consensus-verify`.

```sh
npm install
npm run typecheck
npm test
```

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Descriptors, BIP48 2-of-3 wallets, PSBT building and checks |
| `packages/protocol` | Nostr RPC between the phone and the guardian |
| `apps/guardian` | The guardian service that runs on Umbrel or Start9 |
| `apps/guardian-web` | The guardian's web UI |
| `apps/mobile` | The React Native app |
| `packaging/` | Docker image, Umbrel app and Start9 package |
| `tools/consensus-verify` | Checks transactions with Bitcoin Core's script verifier |

[DESIGN.md](DESIGN.md) explains how it all fits together.

## Rules

- **Never commit secrets.** No seeds, private keys, xprvs, API keys, signing
  certificates or `.env` files. Test vectors must use throwaway keys generated
  in the test or published BIP test vectors. CI runs gitleaks on every push.
- Use testnet, signet or regtest. Mainnet code paths must be tested on those first.
- Changes to signing or guardian rules need tests, including the case that must be refused.
- Keep pull requests small and focused.
