# Trikey

A 2-of-3 bitcoin wallet that feels like [Bitkey](https://bitkey.world), with no
company holding a key.

| Key | Where it lives | Used for |
|---|---|---|
| 1 | **Any hardware wallet** (Ledger, Trezor, Coldcard, BitBox, Jade…) | Big payments, changing rules, recovery |
| 2 | **Your phone**, backed up to your own cloud | Everyday payments |
| 3 | **Trikey Guardian** on your own Umbrel or Start9 | Co-signs phone payments under a daily limit; runs a 7-day Delay & Notify recovery |

Any two keys move money. The guardian only co-signs what its rules allow, it
talks to your phone over encrypted nostr relays, and it never opens a port on
your home network.

No home server? **Recovery Key mode** keeps key 3 offline (a printed kit, an NFC
card or a second hardware wallet) and gives the phone a small spending balance
refilled by pre-signed, timelocked refills.

> **Status: pre-alpha.** Not audited. Use testnet, signet or regtest. The app also
> offers mainnet in guardian mode, behind a warning, for testing at your own risk with
> an amount you can afford to lose; Recovery Key mode is test networks only.

## How it works

- Wallets are plain `wsh(sortedmulti(2, …))` descriptors on BIP48 paths, so any
  multisig-capable wallet can recover them without Trikey.
- The guardian checks every request against the descriptor, a rolling 24-hour
  limit and the rules you set with your hardware wallet.
- Losing a device starts a recovery that waits 7, 14 or 30 days and alerts you
  and your contacts every day. Any of them can cancel it.

The full design, threat model and open questions are in [DESIGN.md](DESIGN.md).

## Repository

| Path | What it is |
|---|---|
| `packages/core` | Descriptors, BIP48 2-of-3 wallets, PSBT building and checks |
| `packages/protocol` | Nostr RPC between the phone and the guardian |
| `apps/guardian` | The guardian service |
| `apps/guardian-web` | The guardian's web UI |
| `apps/mobile` | The React Native app (iOS and Android) |
| `packaging/` | Docker image, Umbrel app and Start9 package |
| `tools/consensus-verify` | Checks transactions with Bitcoin Core's script verifier |

Marketing and brand material (social videos, setup tutorials) lives in a separate repository,
`TheIcarusWings/trikey-marketing`. This one holds the product only.

## Development

```sh
npm install
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
