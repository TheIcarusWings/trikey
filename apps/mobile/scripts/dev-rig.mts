/**
 * A complete fake backend for the app's Regtest simulator, in one process and with no bitcoind: the real Trikey Guardian
 * service, two in-memory nostr relays and a fake Electrs (the rig the guardian's own tests use). Regtest, throwaway keys,
 * everything forgotten when it stops.
 *
 *   npm run dev-rig -w @trikey/mobile
 *
 * It prints the guardian's details, then reads commands from the terminal (or a pipe: each answer is one line starting
 * with `ok` or `error`):
 *
 *   pairing [2]           a fresh pairing code (trikey://pair?...), valid for 5 minutes; `2`: a second guardian on the
 *                         same chain, started on first use (for Settings > Guardian > Replace guardian)
 *   recovery-code [2]     the guardian's "Recover on a new phone" code (trikey://recover?...)
 *   fund <address> <sats> pay the address (a bcrt1... address from the app's Receive screen); confirmed at once
 *   mine [n]              mine n blocks (default 1): confirms what the app broadcast
 *   lock | unlock         lock the guardian (the app shows "Guardian locked") or unlock it
 *   offline | online      stop the first guardian (its relays and the chain keep running), or start it again
 *   skip <days>           move the guardians' clock <days> ahead, mine past it, and let them finish ready recoveries;
 *                         answers with the new time (ms). Move the app's clock the same way (a browser test can).
 *   quit
 *
 * The relays listen on 127.0.0.1: use it with the web preview or the iOS Simulator. For a phone or an Android emulator, or
 * with a real node, follow docs/dev-regtest.md.
 */
import { createInterface } from 'node:readline';
import * as btc from '@scure/btc-signer';
import { getNetwork } from '@trikey/core';
import { encodeRecoveryUri } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';

// The rigs' clock is a hand-moved test clock; a real app uses the real one, so follow real time (plus what `skip` added).
let offsetMs = 0;
const clock = new ManualClock(Date.now());
setInterval(() => clock.set(Date.now() + offsetMs), 200).unref();
const rig = await GuardianRig.start({ clock });
let second: GuardianRig | undefined;

/** The second guardian shares the first one's Electrs: one Bitcoin network, two boxes. */
async function secondRig(): Promise<GuardianRig> {
  if (second) return second;
  const r = await GuardianRig.start({ clock });
  const own = r.electrs;
  r.electrs = rig.electrs;
  await r.restart();
  await r.unlock();
  await own.stop();
  second = r;
  return r;
}

const pick = async (which: string | undefined) => (which === '2' ? secondRig() : rig);

/** Lets a guardian do its timed work (alerts, completing a ready recovery) once it has seen the chain's tip. */
async function tickWhenSynced(r: GuardianRig): Promise<void> {
  const e = r.guardian.chain.electrum;
  for (let i = 0; i < 300 && e && e.tip?.height !== r.electrs.height; i++) await new Promise((ok) => setTimeout(ok, 10));
  await r.guardian.tick();
}

// A real guardian ticks on its own; the test rig leaves it to the caller.
setInterval(() => {
  for (const r of [rig, second]) if (r) void r.guardian.tick().catch(() => undefined);
}, 5_000).unref();

const json = process.argv.includes('--json');
const say = (line: string) => console.log(line);
say(
  json
    ? JSON.stringify({ ready: true, uri: rig.pairingUri(), relays: rig.relayUrls, pubkey: rig.pubkey, passphrase: rig.passphrase })
    : [
        'Trikey dev rig is running (regtest, throwaway keys).',
        `  relays      ${rig.relayUrls.join('  ')}`,
        `  passphrase  ${rig.passphrase}   (to unlock the guardian in the app)`,
        `  pairing     ${rig.pairingUri()}`,
        '',
        'Commands: pairing [2] | recovery-code [2] | fund <address> <sats> | mine [n] | lock | unlock | offline | online | skip <days> | quit',
      ].join('\n'),
);

const stop = async () => {
  await second?.stop();
  await rig.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case 'pairing':
        say(`ok ${(await pick(args[0])).pairingUri()}`);
        break;
      case 'recovery-code': {
        const r = await pick(args[0]);
        say(`ok ${encodeRecoveryUri({ guardianPubkey: r.pubkey, relays: r.relayUrls, network: 'regtest', label: args[0] === '2' ? 'Second guardian' : 'Test Guardian' })}`);
        break;
      }
      case 'fund': {
        const [address, sats] = args;
        if (!address || !sats || !/^\d+$/.test(sats)) throw new Error('usage: fund <address> <sats>');
        rig.fund(btc.OutScript.encode(btc.Address(getNetwork('regtest').btc).decode(address)), BigInt(sats));
        say(`ok funded ${address} with ${sats} sats`);
        break;
      }
      case 'mine':
        await rig.mine(Number(args[0] ?? 1));
        say(`ok height ${rig.electrs.height}`);
        break;
      case 'lock':
        await rig.lock();
        say('ok locked');
        break;
      case 'unlock':
        await rig.unlock();
        say('ok unlocked');
        break;
      case 'offline':
        await rig.guardian.stop();
        say('ok offline');
        break;
      case 'online':
        await rig.restart();
        await rig.unlock();
        say('ok online');
        break;
      case 'skip': {
        const days = Number(args[0]);
        if (!(days > 0)) throw new Error('usage: skip <days>');
        offsetMs += days * 86_400_000 + 2 * 3_600_000; // a little past, so the median time past is past too
        clock.set(Date.now() + offsetMs);
        // The chain's median time past must pass the end of the delay too: eleven blocks at the new time.
        await rig.mine(11);
        for (const r of [rig, second]) if (r) await tickWhenSynced(r);
        say(`ok ${clock.now()}`);
        break;
      }
      case 'status': {
        const r = await pick(args[0]);
        const s = r.guardian.engine.status();
        const rec = s.recovery;
        say(
          `ok ${JSON.stringify({
            locked: r.guardian.locked,
            walletId: s.walletId ?? null,
            phoneSpending: s.phoneSpending,
            recovery: rec ? { id: rec.id, status: s.recoveryStatus, readyAt: rec.readyAt } : null,
            height: r.electrs.height,
            now: clock.now(),
          })}`,
        );
        break;
      }
      case 'log': {
        const r = await pick(args[0]);
        say(`ok ${JSON.stringify(r.logLines.slice(-Number(args[1] ?? 20)))}`);
        break;
      }
      case 'quit':
      case 'exit':
        say('ok');
        await stop();
        break;
      case '':
      case undefined:
        break;
      default:
        say(`error unknown command: ${cmd}`);
    }
  } catch (e) {
    say(`error ${e instanceof Error ? e.message : String(e)}`);
  }
}
await stop();
