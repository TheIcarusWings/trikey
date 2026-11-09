/**
 * The Zapstore check (.github/workflows/zapstore-check.yml, docs/zapstore.md): after publish-release.yml publishes a
 * release it dispatches the check, which asks Zapstore's relay whether both apps have the version
 * (.github/scripts/zapstore-published.mjs) and opens an issue when they do not after about three hours. No secret.
 *
 * The script runs here against a local relay (the protocol package's DevRelay, a real ws server with nostr filters) and
 * the workflow's steps against stand-ins for node and gh.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevRelay } from '@trikey/protocol/dev/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const SCRIPT = join(ROOT, '.github', 'scripts', 'zapstore-published.mjs');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as Workflow;

/** Trikey's publisher npub1qussfnkjk6fvr36syatltxl0ks5pssyx7hrhf8zpnp9mf04e5j2sswedj9, in hex. */
const AUTHOR = '072104ced2b692c1c7502757f59befb428184086f5c7749c41984bb4beb9a495';
/** Other keys: Zapstore's indexer may sign the release events it publishes with its own. */
const OTHER = 'f'.repeat(64);
const OTHER2 = 'e'.repeat(64);

let n = 0;
/** A release event (kind 30063) as zsp writes it: `d` is `<app id>@<version>`. Unsigned: the relay does not verify. */
function releaseEvent(app: string, version: string, pubkey = AUTHOR) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, '0'),
    pubkey,
    created_at: 1_790_000_000 + n,
    kind: 30063,
    tags: [
      ['d', `${app}@${version}`],
      ['i', app],
      ['version', version],
      ['c', 'main'],
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

/** Runs the script; resolves with its exit code and output (asynchronously, so the relay in this process can answer). */
function runScript(version: string, relay: string, timeoutMs = 5000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, version],
      { env: { PATH: process.env['PATH'], ZAPSTORE_RELAY: relay, ZAPSTORE_TIMEOUT_MS: String(timeoutMs) }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code) : 0, out: stdout, err: stderr })
    );
  });
}

describe('zapstore-published.mjs, against a local relay', () => {
  let relay: DevRelay | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await relay?.stop();
    relay = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function relayWith(events: ReturnType<typeof releaseEvent>[], log = false) {
    relay = new DevRelay({ verify: false, log });
    for (const e of events) relay.events.set(e.id, e);
    return relay.start();
  }

  it("asks for kind 30063 with both apps' d tags, by any author, and exits 0 when both are there", async () => {
    const standard = releaseEvent('app.trikey.wallet', '0.1.26-alpha');
    const foss = releaseEvent('app.trikey.wallet.foss', '0.1.26-alpha');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const url = await relayWith([standard, foss, releaseEvent('app.trikey.wallet', '0.1.25-alpha')], true);
    const r = await runScript('0.1.26-alpha', url);
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([
      `found app.trikey.wallet@0.1.26-alpha ${standard.id}`,
      `found app.trikey.wallet.foss@0.1.26-alpha ${foss.id}`,
    ]);
    const req = logged.mock.calls.find((c) => c[1] === 'REQ')!;
    expect(JSON.parse(String(req[3]))).toEqual([
      { kinds: [30063], '#d': ['app.trikey.wallet@0.1.26-alpha', 'app.trikey.wallet.foss@0.1.26-alpha'] },
    ]);
    // A leading v is the tag; the version is the same.
    expect((await runScript('v0.1.26-alpha', url)).code).toBe(0);
  });

  it('exits 1 and names the app that is missing, not counting another version', async () => {
    const url = await relayWith([
      releaseEvent('app.trikey.wallet', '0.1.26-alpha'),
      releaseEvent('app.trikey.wallet.foss', '0.1.25-alpha'),
      releaseEvent('app.trikey.wallet.foss', '0.1.25-alpha', OTHER),
    ]);
    const r = await runScript('0.1.26-alpha', url);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^found app\.trikey\.wallet@0\.1\.26-alpha [0-9a-f]{64}$/m);
    expect(r.out).toContain('missing app.trikey.wallet.foss@0.1.26-alpha');
    expect(r.out).not.toContain('notice');
  });

  it("counts an event signed by another key (Zapstore's indexer), with a notice naming the key(s)", async () => {
    const standard = releaseEvent('app.trikey.wallet', '0.1.26-alpha');
    const standardByOther = releaseEvent('app.trikey.wallet', '0.1.26-alpha', OTHER);
    const foss = releaseEvent('app.trikey.wallet.foss', '0.1.26-alpha', OTHER);
    const foss2 = releaseEvent('app.trikey.wallet.foss', '0.1.26-alpha', OTHER2);
    const url = await relayWith([standard, standardByOther, foss, foss2]);
    const r = await runScript('0.1.26-alpha', url);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n');
    // Trikey's own event wins, with no notice for that app.
    expect(lines[0]).toBe(`found app.trikey.wallet@0.1.26-alpha ${standard.id}`);
    expect(lines[1]).toMatch(new RegExp(`^found app\\.trikey\\.wallet\\.foss@0\\.1\\.26-alpha (${foss.id}|${foss2.id})$`));
    expect(lines[2]).toMatch(/^notice app\.trikey\.wallet\.foss@0\.1\.26-alpha is signed by [0-9a-f,]+, not Trikey's publisher key$/);
    expect(/signed by ([0-9a-f,]+),/.exec(lines[2]!)![1]!.split(',').sort()).toEqual([OTHER2, OTHER]);
    expect(lines.length).toBe(3);
  });

  it('exits 1 with both missing when the relay answers only EOSE', async () => {
    const url = await relayWith([]);
    const r = await runScript('0.1.26-alpha', url);
    expect(r.code).toBe(1);
    expect(r.out.trim().split('\n')).toEqual(['missing app.trikey.wallet@0.1.26-alpha', 'missing app.trikey.wallet.foss@0.1.26-alpha']);
  });

  it('checks the kind and the d tag itself, whatever the relay sends', async () => {
    const url = await relayWith([releaseEvent('app.trikey.wallet', '0.1.26-alpha'), releaseEvent('app.trikey.wallet.foss', '0.1.26-alpha')]);
    // A relay that answers with what was not asked for: an event of another kind, and one of another version.
    relay!.transformOutgoing = (e) =>
      e.tags[0]![1] === 'app.trikey.wallet@0.1.26-alpha'
        ? { ...e, kind: 30064 }
        : { ...e, tags: [['d', 'app.trikey.wallet.foss@0.1.27-alpha'], ...e.tags.slice(1)] };
    const r = await runScript('0.1.26-alpha', url);
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing app.trikey.wallet@0.1.26-alpha');
    expect(r.out).toContain('missing app.trikey.wallet.foss@0.1.26-alpha');
  });

  it('exits 2 when the relay does not answer in time, cannot be reached, or the version is not one', async () => {
    // Accepts the connection and never answers the WebSocket handshake.
    const held: Socket[] = [];
    server = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const silent = await runScript('0.1.26-alpha', `ws://127.0.0.1:${port}`, 500);
    expect(silent.code).toBe(2);
    expect(silent.err).toContain('no answer from');
    expect(silent.out).toBe('');
    for (const socket of held) socket.destroy();

    const url = await relayWith([]);
    await relay!.stop();
    const gone = await runScript('0.1.26-alpha', url);
    expect(gone.code).toBe(2);
    expect(gone.out).toBe('');

    for (const bad of ['', '0.1', '0.1.26-beta', '0.1.26-alpha"; rm -rf /']) {
      const r = await runScript(bad, url);
      expect(r.code, bad).toBe(2);
      expect(r.err, bad).toContain('expected a version like');
    }
  });
});

describe('zapstore-check.yml: no secrets, only a dispatch, an issue when Zapstore lags', () => {
  const wf = workflow('zapstore-check.yml');
  const text = read('.github/workflows/zapstore-check.yml');
  const job = wf.jobs['check']!;
  const step = (name: string) => job.steps!.find((s) => s.name === name)!;

  it('runs only when dispatched, with the version', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.on['workflow_dispatch']!.inputs!['version']).toMatchObject({ required: true, type: 'string' });
  });

  it('reads no secret but GITHUB_TOKEN, has no environment, and may only read the code and write issues', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.jobs)).toEqual(['check']);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1])).toEqual(['GITHUB_TOKEN']);
    // The checkout leaves no token behind, and takes only the script and the Node version.
    const checkout = job.steps!.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with!['persist-credentials']).toBe(false);
    expect(String(checkout.with!['sparse-checkout']).trim().split('\n').sort()).toEqual(['.github/scripts/zapstore-published.mjs', '.nvmrc']);
  });

  it('is dispatched by publish-release.yml once the release is published, from a job that can only dispatch', () => {
    const pub = workflow('publish-release.yml');
    const dispatch = pub.jobs['zapstore-check']!;
    expect(dispatch.needs).toBe('publish');
    expect(dispatch.if).toBe("github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
    expect(dispatch.permissions).toEqual({ actions: 'write' });
    expect(dispatch.environment).toBeUndefined();
    expect(JSON.stringify(dispatch).match(/secrets\.\w+/g)).toEqual(['secrets.GITHUB_TOKEN']);
    // The publish job itself gets no new permission.
    expect(pub.jobs['publish']!.permissions).toEqual({ contents: 'write', actions: 'read' });

    const temp = mkdtempSync(join(tmpdir(), 'trikey-zapstore-dispatch-'));
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const log = join(temp, 'calls.log');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    execFileSync('bash', ['-c', dispatch.steps![0]!.run!], {
      env: { PATH: `${bin}:${process.env['PATH']}`, TAG: 'v0.1.26-alpha', GITHUB_REPOSITORY: 'o/r' },
      stdio: 'pipe',
    });
    expect(readFileSync(log, 'utf8')).toBe('workflow run zapstore-check.yml --repo o/r --ref main -f version=0.1.26-alpha\n');
  });

  /**
   * Runs "Wait for Zapstore" with a stand-in `node` (the script) that answers `answers[i]` on its i-th call (the last
   * one after that), and a `sleep` that only moves bash's clock.
   */
  function waitFor(answers: { code: number; out: string }[], version = '0.1.26-alpha') {
    const temp = mkdtempSync(join(tmpdir(), 'trikey-zapstore-wait-'));
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    for (const [i, a] of answers.entries()) writeFileSync(join(temp, `answer-${i + 1}`), `${a.code}\n${a.out}`);
    writeFileSync(
      join(bin, 'node'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> '${join(temp, 'calls.log')}'`,
        `c=$(( $(cat '${join(temp, 'count')}' 2>/dev/null || echo 0) + 1 )); echo "$c" > '${join(temp, 'count')}'`,
        `f='${temp}/answer-'"$c"; [ -e "$f" ] || f='${temp}/answer-${answers.length}'`,
        'tail -n +2 "$f"; exit "$(head -n 1 "$f")"',
      ].join('\n'),
      { mode: 0o755 }
    );
    const output = join(temp, 'output');
    writeFileSync(output, '');
    let ok = true;
    let out = '';
    try {
      out = execFileSync('bash', ['-c', `sleep() { SECONDS=$((SECONDS + $1)); }\n${step('Wait for Zapstore').run!}`], {
        env: { PATH: `${bin}:${process.env['PATH']}`, VERSION: version, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e) {
      ok = false;
      out = String((e as { stdout?: string }).stdout);
    }
    const calls = (() => {
      try {
        return readFileSync(join(temp, 'calls.log'), 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    })();
    return { ok, out, calls, output: readFileSync(output, 'utf8') };
  }

  const both = { code: 0, out: 'found app.trikey.wallet@0.1.26-alpha aa\nfound app.trikey.wallet.foss@0.1.26-alpha bb\n' };
  const fossMissing = { code: 1, out: 'found app.trikey.wallet@0.1.26-alpha aa\nmissing app.trikey.wallet.foss@0.1.26-alpha\n' };

  it('asks every 10 minutes and succeeds once both are published, the relay not answering in between', () => {
    const r = waitFor([fossMissing, { code: 2, out: '' }, both]);
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(Array(3).fill('.github/scripts/zapstore-published.mjs 0.1.26-alpha'));
    expect(r.output).toBe('');
    expect(r.out).toContain('found app.trikey.wallet.foss@0.1.26-alpha bb');
  });

  it('turns the notice of another signer into a ::notice on the run', () => {
    const notice = "notice app.trikey.wallet.foss@0.1.26-alpha is signed by ffff, not Trikey's publisher key";
    const r = waitFor([{ code: 0, out: `${both.out}${notice}\n` }]);
    expect(r.ok).toBe(true);
    expect(r.out).toContain(`::notice title=Zapstore signer::${notice.slice('notice '.length)}`);
    const late = waitFor([{ code: 1, out: `found app.trikey.wallet@0.1.26-alpha aa\nnotice app.trikey.wallet@0.1.26-alpha is signed by ffff, not Trikey's publisher key\nmissing app.trikey.wallet.foss@0.1.26-alpha\n` }]);
    expect(late.ok).toBe(false);
    expect(late.out.match(/::notice title=Zapstore signer::/g)).toHaveLength(1);
    expect(late.output).toBe('missing=app.trikey.wallet.foss\nrelay-answered=true\n');
    expect(waitFor([both]).out).not.toContain('Zapstore signer');
  });

  it('gives up after three hours, with the apps still missing, and fails', () => {
    const r = waitFor([fossMissing]);
    expect(r.ok).toBe(false);
    expect(r.calls.length).toBe(19); // at 0, 10, ..., 180 minutes
    expect(r.output).toBe('missing=app.trikey.wallet.foss\nrelay-answered=true\n');
    expect(r.out).toContain('Not on Zapstore');
  });

  it('names both apps when the relay never answered', () => {
    const r = waitFor([{ code: 2, out: '' }]);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('missing=app.trikey.wallet app.trikey.wallet.foss\nrelay-answered=false\n');
  });

  it('refuses a version that is not one, without asking or opening an issue', () => {
    const r = waitFor([both], '0.1.26-alpha$(id)');
    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.output).toBe('');
  });

  /** Runs "Open an issue" with a stand-in gh whose open issues are `open`. */
  function openIssue(open: { number: number; title: string }[], missing: string, answered = 'true') {
    const temp = mkdtempSync(join(tmpdir(), 'trikey-zapstore-issue-'));
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const log = join(temp, 'calls.log');
    writeFileSync(join(temp, 'open.json'), JSON.stringify(open));
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> '${log}'`,
        `if [ "$1 $2" = "issue list" ]; then cat '${join(temp, 'open.json')}'; fi`,
      ].join('\n'),
      { mode: 0o755 }
    );
    const issue = step('Open an issue');
    const out = execFileSync('bash', ['-c', issue.run!], {
      env: {
        PATH: `${bin}:${process.env['PATH']}`,
        VERSION: '0.1.26-alpha',
        MISSING: missing,
        RELAY_ANSWERED: answered,
        RUN_URL: 'https://github.com/o/r/actions/runs/1',
        RUNNER_TEMP: temp,
        GITHUB_REPOSITORY: 'o/r',
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    let body = '';
    try {
      body = readFileSync(join(temp, 'issue.md'), 'utf8');
    } catch {
      // No issue written.
    }
    return { out, calls: readFileSync(log, 'utf8'), body };
  }

  it('opens the issue only after the wait gave up, when it named the missing apps', () => {
    expect(step('Open an issue').if).toBe("failure() && steps.wait.outputs.missing != ''");
    expect(step('Wait for Zapstore').id).toBe('wait');
  });

  it('opens an issue that names the missing app and the command that publishes it', () => {
    const r = openIssue([{ number: 3, title: "Zapstore hasn't picked up v0.1.25-alpha" }], 'app.trikey.wallet.foss');
    expect(r.calls).toContain("issue create --repo o/r --title Zapstore hasn't picked up v0.1.26-alpha --body-file");
    expect(r.body).toContain('- Trikey FOSS (`app.trikey.wallet.foss`)');
    expect(r.body).not.toContain('- Trikey (`app.trikey.wallet`)');
    expect(r.body).toContain('zsp publish packaging/zapstore/foss/zapstore.yaml');
    expect(r.body).not.toContain('zsp publish zapstore.yaml');
    expect(r.body).toContain('docs/zapstore.md');
    expect(r.body).toContain('https://github.com/o/r/actions/runs/1');
    expect(r.body).not.toContain('did not answer');

    const all = openIssue([], 'app.trikey.wallet app.trikey.wallet.foss', 'false');
    expect(all.body).toContain('zsp publish zapstore.yaml\nzsp publish packaging/zapstore/foss/zapstore.yaml');
    expect(all.body).toContain('The relay did not answer');
  });

  it('opens no second issue while one with that title is open', () => {
    const r = openIssue([{ number: 7, title: "Zapstore hasn't picked up v0.1.26-alpha" }], 'app.trikey.wallet');
    expect(r.calls).not.toContain('issue create');
    expect(r.out).toContain('Issue #7');
  });

  it('is explained in docs/zapstore.md, with the hand-publish commands', () => {
    const doc = read('docs/zapstore.md');
    expect(doc).toContain('zapstore-check.yml');
    expect(doc).toContain("Zapstore hasn't picked up v<version>");
    expect(doc).toContain('zsp publish zapstore.yaml');
    expect(doc).toContain('zsp publish packaging/zapstore/foss/zapstore.yaml');
  });
});
