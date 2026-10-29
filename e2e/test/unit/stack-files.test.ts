/**
 * The stack's files: docker-compose.yml (what Docker would run) and the CI workflow, checked for the properties
 * that must not drift: pinned images, loopback-only ports, regtest-only credentials, relay policy on, the workflow's
 * triggers, time limit and cleanup.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMPOSE_FILE, COMPOSE_PROJECT, E2E_DIR, composeArgs } from '../../src/compose.js';

const compose = parse(readFileSync(COMPOSE_FILE, 'utf8')) as {
  name: string;
  services: Record<string, { image: string; command?: string[]; ports?: string[]; depends_on?: Record<string, { condition: string }>; environment?: Record<string, string>; restart?: string }>;
};
const workflow = parse(readFileSync(join(E2E_DIR, '..', '.github', 'workflows', 'e2e.yml'), 'utf8')) as {
  on: { pull_request?: unknown; push?: { branches: string[]; paths: string[] }; workflow_dispatch?: unknown };
  jobs: Record<string, { 'timeout-minutes': number; steps: { name?: string; run?: string; if?: string; uses?: string }[] }>;
};

describe('docker-compose.yml', () => {
  it('names the project the scripts and the workflow use', () => {
    expect(compose.name).toBe(COMPOSE_PROJECT);
    expect(composeArgs(['up'])).toEqual(['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, 'up']);
    expect(existsSync(COMPOSE_FILE)).toBe(true);
  });

  it('runs bitcoind and Electrs from images pinned by tag and digest', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['bitcoind', 'electrs']);
    for (const [name, s] of Object.entries(compose.services)) expect(s.image, name).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    expect(compose.services['bitcoind']!.image).toMatch(/^bitcoin\/bitcoin:\d/);
    expect(compose.services['electrs']!.image).toMatch(/^getumbrel\/electrs:v\d/);
  });

  it('publishes ports on loopback only', () => {
    for (const [name, s] of Object.entries(compose.services)) {
      expect(s.ports?.length, name).toBeGreaterThan(0);
      for (const p of s.ports!) expect(p, name).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('runs bitcoind on regtest with txindex and with relay policy enforced, credentials from the environment', () => {
    const cmd = compose.services['bitcoind']!.command!;
    for (const flag of ['-regtest=1', '-server=1', '-txindex=1', '-rest=1', '-acceptnonstdtxn=0']) expect(cmd).toContain(flag);
    expect(cmd.find((a) => a.startsWith('-rpcuser='))).toMatch(/^-rpcuser=\$\{E2E_RPC_USER:-[a-z]+\}$/);
    expect(cmd.find((a) => a.startsWith('-rpcpassword='))).toMatch(/^-rpcpassword=\$\{E2E_RPC_PASS:-[a-z-]*regtest[a-z-]*\}$/);
  });

  it('starts Electrs after bitcoind is healthy, and hands it the same credentials without a literal in the file', () => {
    const e = compose.services['electrs']!;
    expect(e.depends_on?.['bitcoind']?.condition).toBe('service_healthy');
    expect(e.restart).toBe('on-failure');
    const script = e.command!.join('\n');
    expect(script).toContain('network = "regtest"');
    expect(script).toContain('daemon_rpc_addr = "bitcoind:18443"');
    expect(script).toContain('${E2E_RPC_USER}');
    expect(script).toContain('${E2E_RPC_PASS}');
  });

  it('matches what the tests default to', () => {
    const raw = readFileSync(COMPOSE_FILE, 'utf8');
    for (const v of ['E2E_RPC_USER:-trikey', 'E2E_RPC_PASS:-trikey-regtest-only', 'E2E_RPC_PORT:-18443', 'E2E_ELECTRS_PORT:-50001']) expect(raw).toContain(v);
    expect(raw).toMatch(/REGTEST ONLY/);
  });
});

describe('.github/workflows/e2e.yml', () => {
  const job = workflow.jobs['e2e']!;

  it('runs on pull requests, on pushes to main that touch what it tests, and by hand', () => {
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.push?.branches).toEqual(['main']);
    for (const path of ['apps/guardian/**', 'packages/**', 'e2e/**', 'package-lock.json']) expect(workflow.on.push?.paths).toContain(path);
  });

  it('is limited to 30 minutes', () => {
    expect(job['timeout-minutes']).toBe(30);
  });

  it('starts the stack, runs the tests, dumps the logs on failure and always tears down, in that order', () => {
    const steps = job.steps;
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ''));
    const up = at(/stack:up/);
    const test = at(/test:e2e/);
    const logs = at(/logs/);
    const down = at(/down --volumes/);
    expect(up).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(up);
    expect(logs).toBeGreaterThan(test);
    expect(down).toBeGreaterThan(logs);
    expect(steps[logs]!.if).toBe('failure()');
    expect(steps[down]!.if).toBe('always()');
    expect(at(/test:dry/)).toBeLessThan(up);
  });
});
