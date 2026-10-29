/**
 * Times the expensive steps of the real wallet service in Node, through the same code path the app uses
 * (`createRealWalletService`, `TrikeyWallet`, the real Argon2id parameters for the recovery code). The guardian, its relays
 * and a fake Electrs run in ANOTHER process (`scripts/dev-rig.mts`), so the numbers and the stalls are the wallet's alone.
 * Regtest, throwaway keys.
 *
 *   npm run measure -w @trikey/mobile
 *
 * Node is much faster than a phone: Hermes runs this kind of pure-JS integer code several times slower than V8, so read
 * the times as a floor. `longest stall` is how long the event loop was blocked at a stretch, which is what the UI would
 * feel as a frozen frame.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { DEFAULT_RECOVERY_CODE_KDF } from '@trikey/wallet';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { createRealWalletService } from '../src/data/real';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// --- the guardian, in its own process ----------------------------------------------------------------------------
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev-rig.mts', '--json'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => (await lines.next()).value as string;
const info = JSON.parse(await next()) as { uri: string };
const rigCommand = async (cmd: string) => {
  child.stdin.write(cmd + '\n');
  const answer = await next();
  if (!answer.startsWith('ok')) throw new Error(answer);
  return answer.slice(3);
};

// --- timing -------------------------------------------------------------------------------------------------------
/** Runs `fn` while sampling how late a 5 ms timer fires: the longest delay is the longest the thread was blocked. */
async function timed<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  let last = performance.now();
  let worst = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  clearInterval(sampler);
  console.log(`${label.padEnd(66)} ${String(Math.round(ms)).padStart(6)} ms   longest stall ${String(Math.round(worst)).padStart(4)} ms`);
  return value;
}

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONIC, network: 'regtest', kind: 'ledger' });
const provider = new SoftwareHardwareProvider(device);

function phone() {
  return {
    mode: 'simulator' as const,
    platform: { os: 'ios' as const, isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [provider],
    rpcTimeoutMs: 15_000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: () => new Promise<void>((r) => setTimeout(r, 30)), // the app waits this long so a progress text can paint
    // No `recoveryCodeKdf`: Argon2id with the recovery code's real default cost.
  };
}

console.log(`Recovery-code KDF: Argon2id m=${DEFAULT_RECOVERY_CODE_KDF.m} KiB (${DEFAULT_RECOVERY_CODE_KDF.m / 1024} MiB), t=${DEFAULT_RECOVERY_CODE_KDF.t}, p=${DEFAULT_RECOVERY_CODE_KDF.p}\n`);

await timed('Argon2id alone, real cost (argon2idAsync, 10 ms ticks)', () =>
  argon2idAsync(new Uint8Array(24), new Uint8Array(16), { ...DEFAULT_RECOVERY_CODE_KDF, dkLen: 32 }),
);

const s = await timed('open the service on an empty phone', () => createRealWalletService(phone()));
await timed('create the wallet (key 2, nostr key, secure store) + connect device', () => s.connectHardware('simulated'));
await timed('scan the guardian code (pair.prepare over relays)', () => s.pairGuardian(info.uri));
await timed('pair (device signs, registers, shows address; guardian pairs; first sync)', () => s.setUpRules(100_000, 7));
await timed('sync (wallet.sync, status and fees over relays)', () => s.sync());
const addr = s.getState().receiveAddress;
await rigCommand(`fund ${addr} 500000`);
await s.sync();
const q = await timed('quote a payment, first call (no I/O)', () => s.quoteSend({ address: s.wallet!.multisig().derive(0, 5).address, amountSats: 10_000, speed: 'normal' }));
if (!q.ok) throw new Error(q.message);
await timed('quote a payment, 20 more times (the amount screen quotes on every digit)', () => {
  for (let i = 0; i < 20; i++) s.quoteSend({ address: s.wallet!.multisig().derive(0, 5).address, amountSats: 10_000 + i, speed: 'normal' });
});
await timed('send within the limit (phone + guardian), broadcast and sync', () => s.sendPayment(q.quote));
await timed('create backup: recovery code (real Argon2id), encrypt, write, read back', () => s.createBackup('file'));
const code = s.recoveryCode()!;

const phone2 = await createRealWalletService(phone());
await timed('restore on a new phone: recovery code (real Argon2id), reconnect, sync', () => phone2.restoreFromBackup({ recoveryCode: code }));

await s.close();
await phone2.close();
child.stdin.write('quit\n');
setTimeout(() => process.exit(0), 500);
