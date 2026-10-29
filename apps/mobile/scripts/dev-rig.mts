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
 *   pairing               a fresh pairing code (trikey://pair?...), valid for 5 minutes
 *   fund <address> <sats> pay the address (a bcrt1... address from the app's Receive screen); confirmed at once
 *   mine [n]              mine n blocks (default 1): confirms what the app broadcast
 *   lock | unlock         lock the guardian (the app shows "Guardian locked") or unlock it
 *   quit
 *
 * The relays listen on 127.0.0.1: use it with the web preview or the iOS Simulator. For a phone or an Android emulator, or
 * with a real node, follow docs/dev-regtest.md.
 */
import { createInterface } from 'node:readline';
import * as btc from '@scure/btc-signer';
import { getNetwork } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';

const rig = await GuardianRig.start();
// The rig's clock is a hand-moved test clock; a real app uses the real one, so follow real time.
setInterval(() => rig.clock.set(Date.now()), 200).unref();

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
        'Commands: pairing | fund <address> <sats> | mine [n] | lock | unlock | quit',
      ].join('\n'),
);

const stop = async () => {
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
        say(`ok ${rig.pairingUri()}`);
        break;
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
