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

## Consensus checks

Our own code analyses the transactions it signs, so a bug shared by the signer
and the checker would go unnoticed. The `packages/core` tests therefore also run
every signed transaction through Bitcoin Core's script interpreter
(`tools/consensus-verify`, built on libbitcoinconsensus).

Build the verifier once (needs Rust and a C++ compiler):

```sh
npm run build:verifier
```

The tests find it at `tools/consensus-verify/target/release/consensus-verify`, or
at the path in `TRIKEY_CONSENSUS_VERIFY`. Without it, the consensus tests are
skipped locally with a message saying so. In CI (`CI` set) they fail instead, and
the CI `test` job builds the verifier first.

**A new transaction shape needs a consensus test.** If you add or change a way
of building or signing transactions (a new sweep, a timelocked refill, another
signer), add a case to `packages/core/test/consensus.test.ts` using the helper in
`packages/core/test/support/consensus.ts` (importable from other packages as
`@trikey/core/testing`), and a negative case that must fail. The verifier checks
scripts and signatures only; rules about a whole transaction (duplicate inputs,
values, BIP 68 maturity) need their own tests.

## Rules

- **Never commit secrets.** No seeds, private keys, xprvs, API keys, signing
  certificates or `.env` files. Test vectors must use throwaway keys generated
  in the test or published BIP test vectors. CI runs gitleaks on every push.
- Use testnet, signet or regtest. Mainnet code paths must be tested on those first.
- Changes to signing or guardian rules need tests, including the case that must be refused.
- Keep pull requests small and focused.
