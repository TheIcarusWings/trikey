/**
 * The regtest stack from the command line (`npm run stack -w @trikey/e2e -- <command>`, or the stack:* scripts):
 *
 *   up                    start bitcoind and Electrs, wait for health, create the funding wallet, mine to 101 blocks
 *   setup                 the second half of `up`, for a stack that is already running
 *   status                heights of the node and Electrs, the funding wallet's balance
 *   mine [n]              mine n blocks (default 1) and wait for Electrs
 *   send <address> <sats> pay an address from the funding wallet
 *   logs                  the containers' logs
 *   down                  stop the stack and delete its data
 *
 * Regtest only; the RPC credentials are the throwaway ones in docker-compose.yml.
 */
import { loadE2eConfig } from '../src/config.js';
import { compose } from '../src/compose.js';
import { RegtestChain } from '../src/regtest.js';

const HELP = `usage: stack <up|setup|status|mine [n]|send <address> <sats>|logs|down>`;

async function setup(chain: RegtestChain): Promise<void> {
  process.stdout.write('waiting for bitcoind...\n');
  const { height, balanceSats } = await chain.prepare();
  process.stdout.write(`bitcoind is up: height ${height}, funding wallet "${chain.cfg.fundingWallet}" holds ${balanceSats} sats\n`);
  process.stdout.write('waiting for Electrs to index the chain...\n');
  const e = await chain.waitForElectrs(height);
  process.stdout.write(`Electrs is up: ${e.server[0]} (protocol ${e.server[1]}), height ${e.height}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cfg = loadE2eConfig();
  const chain = new RegtestChain(cfg);
  switch (command) {
    case 'up':
      compose(['up', '-d']);
      return setup(chain);
    case 'setup':
      return setup(chain);
    case 'status': {
      const info = await chain.info();
      process.stdout.write(`bitcoind: ${info.chain}, height ${info.blocks}, tip time ${info.time}\n`);
      const e = await chain.waitForElectrs(0, 5000).catch((err: unknown) => err);
      process.stdout.write(e instanceof Error ? `Electrs: ${e.message}\n` : `Electrs: height ${(e as { height: number }).height}\n`);
      process.stdout.write(`funding wallet "${cfg.fundingWallet}": ${await chain.balanceSats()} sats\n`);
      return;
    }
    case 'mine': {
      const n = args[0] === undefined ? 1 : Number(args[0]);
      if (!Number.isInteger(n) || n < 1) throw new Error(HELP);
      await chain.mine(n);
      const height = await chain.height();
      await chain.waitForElectrs(height);
      process.stdout.write(`mined ${n} block${n === 1 ? '' : 's'}: height ${height}\n`);
      return;
    }
    case 'send': {
      const [address, sats] = args;
      if (!address || !sats || !/^\d+$/.test(sats)) throw new Error(HELP);
      process.stdout.write(`${await chain.sendToAddress(address, BigInt(sats))}\n`);
      return;
    }
    case 'logs':
      return compose(['logs', '--no-color', '--tail=500'], { allowFailure: true });
    case 'down':
      return compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
    default:
      throw new Error(HELP);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
