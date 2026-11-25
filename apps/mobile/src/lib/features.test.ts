/**
 * The promotion check (docs/design/public-release.md): a feature reaches preview or public only with evidence, a
 * hardware wallet reaches public only with a test on a real device, and every gated feature is wired to the screens.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QR_MODELS } from '@trikey/wallet';
import { FEATURES, HARDWARE_FEATURE, featureOn, qrFeature, qrModelOn, stageOn, type Feature, type FeatureId } from './features';

const ROOT = join(__dirname, '..', '..');
const entries = Object.entries(FEATURES) as [FeatureId, Feature][];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '__snapshots__') sources(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.endsWith(join('lib', 'features.ts'))) out.push(path);
  }
  return out;
}
const appCode = [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'src'))].map((p) => readFileSync(p, 'utf8')).join('\n');

describe('feature stages', () => {
  it('offers everything in a test build, only public (and preview once unlocked) in the public app', () => {
    for (const stage of ['test', 'preview', 'public'] as const) expect(stageOn(stage, 'test', false)).toBe(true);
    expect(stageOn('public', 'release', false)).toBe(true);
    expect(stageOn('preview', 'release', false)).toBe(false);
    expect(stageOn('preview', 'release', true)).toBe(true);
    expect(stageOn('test', 'release', true)).toBe(false);
  });

  it('has evidence for every feature in preview or public', () => {
    const missing = entries.filter(([, f]) => f.stage !== 'test' && f.evidence.every((e) => !e.trim())).map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it('makes a hardware wallet public only with a test on a real device (an issue or a test report)', () => {
    const bad = entries
      .filter(([, f]) => f.hardware && f.stage === 'public')
      .filter(([, f]) => !f.evidence.some((e) => /github\.com\/TheIcarusWings\/trikey\/(issues|pull)\/\d+/.test(e)))
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });

  it('has a feature for every QR model and every hardware kind in the connect list', () => {
    for (const model of QR_MODELS) expect((FEATURES[qrFeature(model)] as Feature | undefined)?.hardware).toBe(true);
    for (const id of Object.values(HARDWARE_FEATURE)) expect((FEATURES[id] as Feature).hardware).toBe(true);
  });

  it('wires every wallet feature to the screens', () => {
    const unwired = entries.filter(([id, f]) => !f.hardware && !appCode.includes(`featureOn('${id}')`)).map(([id]) => id);
    expect(unwired).toEqual([]);
    expect(appCode).toContain('HARDWARE_FEATURE[option.kind]');
    expect(appCode).toContain('qrModelOn(model)');
  });

  it('keeps a Ledger wallet possible in the public app, so it is never empty', () => {
    expect(featureOn('ledger', 'release', false)).toBe(true);
    expect(qrModelOn('keystone-3', 'release', false)).toBe(false);
    expect(qrModelOn('keystone-3', 'release', true)).toBe(true);
  });

  it('lists every hardware list for a new wallet as such, and none for recovery', () => {
    const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
    for (const p of ['app/(onboarding)/connect-hardware.tsx', 'app/settings/wallets/add.tsx', 'app/rk/create.tsx']) expect(read(p)).toMatch(/<HardwareList[\s\S]{0,40}forNewWallet/);
    for (const p of ['app/recover/new-hardware.tsx', 'app/savings/replace.tsx']) expect(read(p)).not.toContain('forNewWallet');
  });
});
