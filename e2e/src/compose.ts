/** `docker compose` for docker-compose.yml, as the stack scripts and the CI workflow use it. */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = join(E2E_DIR, 'docker-compose.yml');
export const COMPOSE_PROJECT = 'trikey-e2e';

/** The argument list of `docker` for a compose command. */
export function composeArgs(args: string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, ...args];
}

/** Runs `docker compose …` with the output on this terminal; throws if it fails. */
export function compose(args: string[], opts: { allowFailure?: boolean } = {}): void {
  const r = spawnSync('docker', composeArgs(args), { stdio: 'inherit', env: process.env });
  if (r.error) throw new Error(`could not run docker (${r.error.message}); is Docker installed and running?`);
  if (r.status !== 0 && !opts.allowFailure) throw new Error(`docker compose ${args.join(' ')} failed (exit ${r.status})`);
}
