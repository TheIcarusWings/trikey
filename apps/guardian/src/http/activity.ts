/** Engine and service log entries as the web UI's `ActivityEntry`. */
import { npubEncode } from 'nostr-tools/nip19';
import type { ActivityEntry as EngineEntry } from '../policy/index.js';
import type { ServiceActivity } from '../service-state.js';
import { refusalText } from '../nostr/wire.js';
import { formatWhen } from '../alerts.js';
import type { ActivityEntry } from './types.js';

const iso = (ms: number) => new Date(ms).toISOString();
const shortTx = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-6)}`;

export function shortNpub(pubkey: string): string {
  try {
    const n = npubEncode(pubkey);
    return `${n.slice(0, 12)}…${n.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}

const sats = (v: bigint) => Number(v);

export function engineEntry(e: EngineEntry): ActivityEntry {
  const base = { id: `e${e.id}`, at: iso(e.at) };
  switch (e.type) {
    case 'registered':
      return { ...base, kind: 'system', event: `Wallet ${e.walletId} paired`, summary: 'Wallet paired', signedBy: 'Hardware wallet', sats: null, result: 'ok' };
    case 'cosign_signed':
      return {
        ...base,
        kind: 'payment',
        event: e.replay ? `Payment ${shortTx(e.txid)} signed again (already counted)` : `Payment ${shortTx(e.txid)}`,
        summary: 'Phone payment',
        signedBy: 'Phone',
        sats: sats(e.outflow),
        result: 'co-signed',
      };
    case 'cosign_refused':
      return {
        ...base,
        kind: 'payment',
        event: `Payment refused: ${refusalText(e.refusal)}`,
        summary: e.refusal.reason === 'over_daily_limit' ? 'Phone payment over the limit' : 'Phone payment refused',
        signedBy: 'Phone',
        sats: e.refusal.reason === 'over_daily_limit' ? sats(e.refusal.outflow) : null,
        result: e.refusal.reason === 'guardian_locked' ? 'locked' : 'refused',
      };
    case 'rules_changed': {
      const parts: string[] = [];
      if (e.from.dailyLimitSats !== e.to.dailyLimitSats) parts.push(`daily limit ${e.from.dailyLimitSats} → ${e.to.dailyLimitSats} sats`);
      if (e.from.recoveryDelayDays !== e.to.recoveryDelayDays) parts.push(`delay ${e.from.recoveryDelayDays} → ${e.to.recoveryDelayDays} days`);
      if (e.from.sweepFeeCapSats !== e.to.sweepFeeCapSats) parts.push(`fee cap ${e.from.sweepFeeCapSats} → ${e.to.sweepFeeCapSats} sats`);
      if (e.from.alertContacts.join() !== e.to.alertContacts.join()) parts.push(`alert contacts ${e.from.alertContacts.length} → ${e.to.alertContacts.length}`);
      return {
        ...base,
        kind: 'rules',
        event: `Rules changed${parts.length ? `: ${parts.join(', ')}` : ''}`,
        summary: 'Rules changed',
        signedBy: e.by === 'hardware' ? 'Hardware wallet' : 'Phone',
        sats: null,
        result: 'rule-changed',
      };
    }
    case 'rules_change_refused':
      return { ...base, kind: 'rules', event: `Rule change refused: ${refusalText(e.refusal)}`, signedBy: e.by === 'hardware' ? 'Hardware wallet' : 'Phone', sats: null, result: 'refused' };
    case 'recovery_started':
      return {
        ...base,
        kind: 'recovery',
        event: `Recovery ${e.recoveryId} started with the ${e.survivingRole === 'hardware' ? 'hardware wallet' : 'phone'}; completes ${formatWhen(e.readyAt)}`,
        summary: 'Recovery started',
        signedBy: e.survivingRole === 'hardware' ? 'Hardware wallet' : 'Phone',
        sats: sats(e.amountSats),
        result: 'ok',
      };
    case 'recovery_start_refused':
      return { ...base, kind: 'recovery', event: `Recovery refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_ready':
      return { ...base, kind: 'recovery', event: `Recovery ${e.recoveryId}: waiting period over`, signedBy: null, sats: null, result: 'ok' };
    case 'recovery_cancelled': {
      const who = e.by.kind === 'app' ? 'the phone' : e.by.kind === 'contact' ? `contact ${shortNpub(e.by.pubkey)}` : 'the hardware wallet';
      return {
        ...base,
        kind: 'recovery',
        event: `Recovery ${e.recoveryId} cancelled by ${who}${e.contested ? '; phone payments paused until the hardware wallet resumes them' : ''}`,
        summary: 'Recovery cancelled',
        signedBy: e.by.kind === 'app' ? 'Phone' : e.by.kind === 'contact' ? 'Alert contact' : 'Hardware wallet',
        sats: null,
        result: 'ok',
      };
    }
    case 'recovery_cancel_refused':
      return { ...base, kind: 'recovery', event: `Cancel refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_completed':
      return { ...base, kind: 'recovery', event: `Recovery ${e.recoveryId} co-signed (${shortTx(e.txid)})`, summary: 'Recovery co-signed', signedBy: 'Guardian', sats: null, result: 'co-signed' };
    case 'recovery_complete_refused':
      return { ...base, kind: 'recovery', event: `Recovery not completed: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'phone_spending_resumed':
      return { ...base, kind: 'rules', event: 'Phone payments resumed', signedBy: 'Hardware wallet', sats: null, result: 'ok' };
    case 'phone_spending_resume_refused':
      return { ...base, kind: 'rules', event: `Resume refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'alert_sent':
      return {
        ...base,
        kind: 'recovery',
        event: `Alert ${e.alertId} sent to ${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}`,
        summary: 'Recovery alert sent',
        signedBy: null,
        sats: null,
        result: 'ok',
      };
  }
}

export function serviceEntry(e: ServiceActivity): ActivityEntry {
  const base = { id: `s${e.id}`, at: iso(e.at) };
  switch (e.type) {
    case 'setup':
      return { ...base, kind: 'system', event: 'Guardian set up: key 3 created', signedBy: null, sats: null, result: 'ok' };
    case 'started':
      return { ...base, kind: 'system', event: 'Guardian started, locked', summary: 'Restarted, locked', signedBy: null, sats: null, result: 'locked' };
    case 'unlocked':
      return { ...base, kind: 'system', event: `Guardian unlocked with the passphrase ${e.via === 'web' ? 'on this box' : 'from the phone'}`, summary: 'Unlocked', signedBy: e.via === 'web' ? null : 'Phone', sats: null, result: 'ok' };
    case 'unlock_failed':
      return { ...base, kind: 'system', event: `Wrong unlock passphrase ${e.via === 'web' ? 'on this box' : 'from the phone'}`, summary: 'Unlock failed', signedBy: null, sats: null, result: 'refused' };
    case 'locked':
      return { ...base, kind: 'system', event: 'Guardian locked', signedBy: null, sats: null, result: 'locked' };
    case 'paired':
      return { ...base, kind: 'system', event: `Phone "${e.name}" paired`, summary: 'Phone paired', signedBy: 'Phone', sats: null, result: 'ok' };
    case 'pair_refused':
      return { ...base, kind: 'system', event: `Pairing refused: ${e.detail}`, signedBy: null, sats: null, result: 'refused' };
    case 'sweep_broadcast':
      return {
        ...base,
        kind: 'recovery',
        event: `Recovery ${e.recoveryId} sweep broadcast: ${e.txid}`,
        summary: 'Recovery sweep broadcast',
        signedBy: 'Guardian',
        sats: e.amountSats,
        result: 'ok',
      };
    case 'sweep_broadcast_failed':
      return { ...base, kind: 'recovery', event: `Broadcast of ${shortTx(e.txid)} failed, will retry: ${e.detail}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_waiting':
      return { ...base, kind: 'recovery', event: `Recovery ${e.recoveryId} waiting: ${e.detail}`, summary: 'Recovery waiting', signedBy: null, sats: null, result: 'refused' };
    case 'cancel_by_dm':
      return {
        ...base,
        kind: 'recovery',
        event: e.ok
          ? `Contact ${shortNpub(e.contact)} cancelled recovery ${e.recoveryId} by replying to the alert`
          : `Cancel reply from ${shortNpub(e.contact)} refused (${e.detail ?? 'unknown'})`,
        signedBy: 'Alert contact',
        sats: null,
        result: e.ok ? 'ok' : 'refused',
      };
    case 'clock_skew':
      return {
        ...base,
        kind: 'system',
        event: `This box's clock (${formatWhen(e.systemTime)}) and the chain (${formatWhen(e.chainTime)}) differ by more than 2 hours; using the earlier`,
        signedBy: null,
        sats: null,
        result: 'refused',
      };
    case 'recovery_access':
      return {
        ...base,
        kind: 'recovery',
        event: `A new phone (${shortNpub(e.phone)}) may read the wallet and start a recovery until ${formatWhen(e.until)}, approved on the hardware wallet`,
        summary: 'Recovery access for a new phone',
        signedBy: 'Hardware wallet',
        sats: null,
        result: 'ok',
      };
  }
}
