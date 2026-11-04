import type { SetupPreflight } from '../api/types';

/**
 * The first-run screen's words that depend on where the guardian runs: on Umbrel and Start9 it uses the box's own
 * Bitcoin Node and Electrs apps; on plain Docker (packaging/compose) the Electrum server the owner named in `.env`.
 */
export interface ChainCheckCopy {
  ok: boolean;
  title: string;
  body?: string;
}

export function chainCheckCopy(p: SetupPreflight): ChainCheckCopy {
  const docker = p.platform === 'docker';
  const missing = p.node === 'missing' || p.electrs === 'missing';
  const found = docker ? 'Bitcoin node and Electrum server found' : 'Bitcoin Node and Electrs found';
  if (!missing && p.synced) return { ok: true, title: found };
  if (!missing)
    return {
      ok: false,
      title: found,
      body: `Still syncing${p.syncProgress !== undefined ? ` (${Math.round(p.syncProgress * 100)}%)` : ''}. You can set up now; payments wait until it finishes.`,
    };
  if (docker) {
    const what = p.electrs === 'missing' ? 'Electrum server not reachable' : 'Bitcoin node not reachable';
    const why = p.electrs === 'missing' && p.electrsProblem ? ` The guardian says: ${p.electrsProblem}.` : '';
    const fix =
      p.electrs === 'missing'
        ? 'Check ELECTRUM_HOST, ELECTRUM_PORT and ELECTRUM_TLS in the guardian’s .env file, restart the guardian (docker compose up -d), then reload this page.'
        : 'Check the BITCOIN_RPC_* settings in the guardian’s .env file, restart the guardian, then reload this page.';
    return { ok: false, title: what, body: `${fix}${why}` };
  }
  return {
    ok: false,
    title: `${p.node === 'missing' ? 'Bitcoin Node' : 'Electrs'} not found`,
    body: 'Install and start both apps on this box, then reload this page. The guardian only reads chain data from them.',
  };
}

/** Where the owner finds the setup code. */
export const SETUP_CODE_HELP =
  'The guardian printed a one-time setup code in its log when it started. Open the log (docker compose logs guardian, or the Logs tab of your NAS’s container app) and copy the code from the line with setup.code. It proves you are the one who started this guardian.';

/** A setup code as the owner may type it: letters and digits in groups of four. Loose on purpose; the guardian decides. */
export function setupCodeFormatError(code: string): string | undefined {
  const bare = code.replace(/[\s\-_.]/g, '');
  if (bare.length === 0) return 'Enter the setup code from the guardian’s log.';
  if (!/^[0-9A-Za-z]{16}$/.test(bare)) return 'The setup code has 16 letters and digits, like ABCD-EFGH-JKMN-PQRS.';
  return undefined;
}

/** The note under the passphrase on plain Docker: the computer has to stay on. */
export const STAY_ON_NOTE =
  'Keep this computer on and awake. The guardian co-signs payments and sends recovery alerts only while it runs; after a restart it waits locked until you unlock it here.';
