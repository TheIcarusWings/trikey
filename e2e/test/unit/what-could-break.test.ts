/**
 * The "What could break" check (.github/workflows/pr-text.yml, .github/scripts/what-could-break.mjs): every PR's text
 * says none / low / high and why, as CLAUDE.md asks. The script runs here as the workflow runs it, with the PR text in
 * PR_BODY, and the workflow is read to check it passes the text through the environment and exempts only Dependabot.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const SCRIPT = join(ROOT, '.github', 'scripts', 'what-could-break.mjs');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function check(body: string | undefined): { ok: boolean; out: string } {
  const env = { ...process.env };
  delete env.PR_BODY;
  if (body !== undefined) env.PR_BODY = body;
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

const TEMPLATE = read('.github/PULL_REQUEST_TEMPLATE.md');
const filled = (line: string) =>
  TEMPLATE.replace(/(## What could break\n\n<!--[\s\S]*?-->)/, `$1\n${line}`);

describe('what-could-break.mjs', () => {
  it('passes the template filled in with none, low or high and a reason', () => {
    for (const line of [
      'None: docs only, no app or guardian code.',
      '**Low** - changes the send screen wording, not what is signed.',
      'High: changes the guardian spending limit check.',
      'none, only site/blog changes',
      '- LOW — a test helper only',
    ]) {
      expect(check(filled(line)), line).toMatchObject({ ok: true });
    }
  });

  it('fails the template as it comes: the hint is not an answer', () => {
    expect(TEMPLATE).toContain('## What could break');
    const r = check(TEMPLATE);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('::error');
    expect(r.out).toContain('empty');
  });

  it('fails a PR text with no section, or none at all', () => {
    expect(check('## What\n\nA fix.\n\n## Why\n\nIt was broken.').out).toContain('no "## What could break" section');
    expect(check('').ok).toBe(false);
    expect(check(undefined).ok).toBe(false);
  });

  it('fails a level with no reason, or no level', () => {
    for (const line of ['None', '**High**', 'Low:', 'Nothing much.', 'Nonetheless fine', 'maybe']) {
      expect(check(filled(line)), line).toMatchObject({ ok: false });
    }
  });

  it('reads only the first line of its own section', () => {
    expect(check('## What could break\n\n## How tested\n\nNone: tests pass.').ok).toBe(false);
    expect(check('## What could break\r\n\r\nNone: docs only.\r\n\r\n## How tested').ok).toBe(true);
  });

  it('never runs the PR text', () => {
    const r = check('## What could break\n\nNone: $(touch /tmp/pwned) `id` ${HOME}');
    expect(r.ok).toBe(true);
    expect(r.out).not.toContain('uid=');
  });
});

describe('pr-text.yml', () => {
  const wf = parse(read('.github/workflows/pr-text.yml')) as {
    on: { pull_request: { types: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; steps: { run?: string; env?: Record<string, string> }[] }>;
  };
  const job = wf.jobs['what-could-break'];

  it('runs on every PR, again when its text is edited, with read-only rights', () => {
    expect(wf.on.pull_request.types).toEqual(expect.arrayContaining(['opened', 'edited', 'reopened', 'synchronize']));
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('passes the PR text through the environment, never into the command', () => {
    const step = job.steps.find((s) => s.run?.includes('what-could-break.mjs'));
    expect(step?.env?.PR_BODY).toBe('${{ github.event.pull_request.body }}');
    for (const s of job.steps) expect(s.run ?? '').not.toContain('github.event');
  });

  it('exempts only Dependabot', () => {
    expect(job.if).toBe("github.event.pull_request.user.login != 'dependabot[bot]'");
  });
});
