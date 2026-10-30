# Security policy

Trikey holds keys to real money. Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository.

Please don't open a public issue for anything that could put funds at risk.
We'll acknowledge a report within a few days and keep you updated until it's fixed.

## Status

Trikey is pre-alpha. It has not been audited. Use testnet, signet or regtest.
The app offers mainnet in guardian mode, behind a warning, for testing at your
own risk: put in only an amount you can afford to lose.

## Scope

In scope:
- the shared wallet code (`packages/core`);
- the guardian and its rules (`apps/guardian`);
- the mobile app (`apps/mobile`);
- the nostr protocol between them.

Things that are by design, and covered in [DESIGN.md](DESIGN.md#threat-model):
- a stolen phone can spend up to the daily limit;
- relays can drop messages.
