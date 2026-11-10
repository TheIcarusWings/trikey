# The trikey.app blog: one post a day

The blog exists to be found by people asking the questions Trikey answers: losing a key, recovering, multisig, a
co-signer at home, inheritance, everyday attacks. The research behind the topics is summed up in "Who ranks today" below.
The cadence is **one new post a day**.

## How a post goes out

```
write (about a week ahead) ──> draft PR ──> owner review: merging is the approval ──> queue ──> published, one a day
```

1. **Write.** A post is written about a week before it goes out, as a draft with the next `queue` number
   (`draft: true`, `queue: N`; site/README.md, "Blog"). It is opened as a PR titled `blog draft: <title>`, one post per PR.
2. **Review.** The owner reads the PR (the Vercel preview shows nothing for a draft: read the Markdown, or build a
   preview with `node tools/site/build-blog.mjs --drafts --out /tmp/trikey-preview`). **Merging the PR approves the
   post**; closing it drops it. A draft PR is never merged by an agent.
3. **Publish.** Every day at about 12:47 UTC a scheduled session runs `node tools/site/publish-next.mjs` on `main`,
   which dates the lowest queued draft today and rebuilds the blog, opens `blog: publish <slug>`, and squash-merges it
   once the required checks are green. Vercel deploys it a minute later.
4. **An empty queue** means no post that day: the session says so. A week of approved drafts keeps the cadence through
   a busy week; the session writes one new draft a day while fewer than 7 are queued or waiting for review.

Links between posts work in any order: a link to a post that's queued but not out yet shows its words without the
link, and becomes a link the day that post is published (the build regenerates every page).

## What every post must do

- **Answer one question well**, for someone who searched it. The title and the description say what the post answers,
  with the words people search (the backlog names the query).
- **Be right about Trikey.** Everything said about Trikey comes from DESIGN.md (link the section) or the code. Don't
  promise what isn't built; say "planned" only where DESIGN.md says so. SeedSigner co-signs payments only; Recovery Key
  mode is a printed kit or a second hardware wallet; Start9 is a package you build yourself for now; the iPhone app is
  built from source for now.
- **Be fair about others.** Facts about other products come from their own pages, linked, dated ("as of November 2026")
  and phrased so a reader checks the current version. No claims about anyone's security record without a source.
- **Teach, then mention Trikey.** Most of the post is useful to someone who will never use Trikey. Trikey gets one
  section near the end.
- **Say the status.** The end of the post says Trikey is pre-alpha and not audited, and points to test networks (the
  page template adds the standard box too).
- **Safe advice only.** Never ask readers for seeds, PINs or keys, never suggest typing a seed into a website, and on
  physical attacks (wrench attacks) describe what limits and delays do without dramatising.
- **Plain words.** Short sentences, the terms explained the first time, no hype ("revolutionary", "unhackable"), no
  invented numbers. 1,200 to 2,000 words. Link to 2 or 3 other posts.
- **Builds clean.** `node tools/site/build-blog.mjs --check` and `node tools/site/check-site.mjs` pass.

## Backlog

In order; the daily session takes the first topic whose slug has no post yet, on `main` or in an open PR. The owner
can reorder, add or strike topics here at any time.

| Slug | Title (working) | Query people search |
|---|---|---|
| single-sig-vs-multisig | Single-Sig or Multisig: When Is One Key Enough? | singlesig vs multisig |
| wallet-descriptor-explained | What a Wallet Descriptor Is, and Why Your Heirs Need It | multisig wallet descriptor backup |
| verify-bitcoin-address-hardware-wallet | How to Check a Bitcoin Address on Your Hardware Wallet | how to verify a bitcoin address before sending |
| psbt-explained | PSBTs: How Several Devices Sign One Bitcoin Payment | what is a psbt |
| seed-phrase-storage | Storing a Seed Phrase: Paper, Metal, and Where Not To | how to store a seed phrase safely |
| bip39-passphrase-vs-multisig | A Passphrase or Multisig? What Each Protects | bip39 passphrase vs multisig |
| home-server-hacked-bitcoin | If Your Home Server Is Hacked, What Happens to Your Bitcoin? | home server hacked bitcoin |
| electrum-server-privacy | What Your Wallet Tells a Server, and Why Run Your Own | electrum server privacy |
| umbrel-vs-start9-vs-docker | Umbrel, Start9 or Docker for a Bitcoin Home Server | umbrel vs start9 |
| seed-phrase-phishing | Seed Phrase Phishing: The Scripts Scammers Use | seed phrase phishing scam |
| fake-wallet-apps-apk-signature | Fake Wallet Apps: How to Check an Android App Is Real | fake bitcoin wallet app |
| reproducible-builds-wallets | Reproducible Builds: Checking the App Matches the Code | reproducible builds bitcoin wallet |
| lost-phone-first-hour | Lost Your Phone? The First Hour for Your Bitcoin | phone stolen bitcoin wallet what to do |
| rehearse-bitcoin-recovery | Rehearse Your Recovery Before You Need It | test bitcoin wallet recovery |
| sim-swap-bitcoin | SIM Swaps: Why a Text Message Can't Protect Bitcoin | sim swap bitcoin |
| daily-spending-limit-bitcoin | Choosing a Daily Spending Limit for a Bitcoin Wallet | daily spending limit bitcoin wallet |
| timelocks-explained | Bitcoin Timelocks Explained: CSV, CLTV and Waiting Periods | bitcoin timelock explained |
| buying-hardware-wallet-supply-chain | Buying a Hardware Wallet: Supply-Chain Checks That Matter | hardware wallet supply chain attack |
| air-gapped-qr-signing | Air-Gapped Signing with QR Codes: What It Protects | air gapped bitcoin wallet qr |
| signet-testnet4-guide | Trying a Bitcoin Wallet on Signet or Testnet4 | signet faucet / testnet4 wallet |
| recovery-key-mode-no-server | A 2-of-3 Wallet Without a Home Server | multisig without a server |
| family-multisig | Helping Family Hold Bitcoin Without Holding It for Them | family bitcoin multisig |
| inheritance-letter | What to Write in a Bitcoin Inheritance Letter (No Secrets) | bitcoin inheritance letter |
| wrench-attack-limits | Wrench Attacks: What Limits and Waiting Periods Can Do | wrench attack bitcoin |
| fee-bumping-rbf-cpfp | Stuck Bitcoin Payment? Fee Bumping Explained | rbf cpfp explained |
| dust-attacks-coin-control | Dust Attacks and Coin Control | bitcoin dust attack |
| silent-payments-explained | Silent Payments: A Reusable Address Without Address Reuse | silent payments bitcoin |
| nostr-encrypted-wallet-messages | Nostr for Wallets: Encrypted Messages Between Your Devices | nostr bitcoin wallet |
| not-audited-what-it-means | "Not Audited": What It Means for Open-Source Wallets | is open source wallet safe |
| bitcoin-travel-hardware-wallet | Travelling with a Hardware Wallet | travel with hardware wallet |

## Who ranks today

Head terms ("bitcoin wallet", "hardware wallet", "multisig") are held by exchanges, device makers and large media, and
a new domain won't rank for them in its first year. Brand queries ("trikey", "trikey guardian") and long, specific
questions are winnable, so the backlog aims there. Once Google Search Console has a few weeks of data, the queries the
site actually appears for decide what moves up the backlog.
