import { describe, expect, it } from 'vitest';
import { createDemoState } from '../data/mock';
import { diagnostics, issueUrl } from './diagnostics';

const app = { version: '0.1.0', os: 'android', osVersion: '34' };

describe('Report a problem', () => {
  it('says what the wallet is, never which wallet it is', () => {
    const state = createDemoState('android');
    const text = diagnostics(state, app).join('\n');
    expect(text).toContain('Trikey 0.1.0 (pre-alpha)');
    expect(text).toContain('Phone: android 34');
    const secrets = [
      state.receiveAddress,
      state.guardian.npub,
      ...state.guardian.relays,
      ...state.contacts.map((c) => c.name),
      String(state.balanceSats),
      ...state.activity.flatMap((a) => (a.type === 'payment' ? [a.tx.id, a.tx.address, String(a.tx.amountSats)] : [])),
    ].filter((s): s is string => !!s && s.length > 3);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toMatch(/\b(tb1|bc1|bcrt1|npub1|wss?:\/\/|xpub|tpub|wsh\()/);
  });

  it('fills in the new-issue page', () => {
    const url = issueUrl(['Trikey 0.1.0 (pre-alpha)']);
    expect(url.startsWith('https://github.com/TheIcarusWings/trikey/issues/new?title=')).toBe(true);
    expect(decodeURIComponent(url.split('&body=')[1])).toContain('```\nTrikey 0.1.0 (pre-alpha)\n```');
  });
});
