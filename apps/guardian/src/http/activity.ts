/** Engine and service log entries as the web UI's `ActivityEntry`. */
import { npubEncode } from 'nostr-tools/nip19';
import { isContactLockOn, isLimitOff, type ActivityEntry as EngineEntry } from '../policy/index.js';
import type { ServiceActivity } from '../service-state.js';
import { refusalText } from '../nostr/wire.js';
import { formatWhen } from '../alerts.js';
import type { ActivityEntry } from './types.js';

const iso = (ms: number) => new Date(ms).toISOString();
const shortTx = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-6)}`;

/** The whole npub (the contact's name lives on the phone only). */
export function npubOrHex(pubkey: string): string {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

export function shortNpub(pubkey: string): string {
  try {
    const n = npubEncode(pubkey);
    return `${n.slice(0, 12)}…${n.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}

const sats = (v: bigint) => Number(v);
const formatSatsText = (v: bigint) => `${v.toLocaleString('en-US')} sats`;

export function engineEntry(e: EngineEntry): ActivityEntry {
  const base = { id: `e${e.id}`, at: iso(e.at) };
  switch (e.type) {
    case 'registered':
      return {
        ...base,
        kind: 'system',
        event: `Wallet ${e.walletId} paired${e.replacesWalletId ? ` (it replaces wallet ${e.replacesWalletId} on another guardian${e.watching ? '; this guardian watches that wallet so the phone can move its coins' : ''})` : ''}`,
        summary: 'Wallet paired',
        signedBy: 'Hardware wallet',
        sats: null,
        result: 'ok',
      };
    case 'cosign_signed':
      return {
        ...base,
        kind: 'payment',
        event: `${e.replay ? `Payment ${shortTx(e.txid)} signed again (already counted)` : `Payment ${shortTx(e.txid)}`}${e.helperInput ? ' (a silent payment: the phone\'s helper coin paid its share of the fee)' : ''}`,
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
      const wasOff = isLimitOff(e.from);
      const nowOff = isLimitOff(e.to);
      if (e.from.recoveryDelayDays !== e.to.recoveryDelayDays) parts.push(`delay ${e.from.recoveryDelayDays} → ${e.to.recoveryDelayDays} days`);
      if (e.from.sweepFeeCapSats !== e.to.sweepFeeCapSats) parts.push(`fee cap ${e.from.sweepFeeCapSats} → ${e.to.sweepFeeCapSats} sats`);
      if (e.from.alertContacts.join() !== e.to.alertContacts.join()) parts.push(`alert contacts ${e.from.alertContacts.length} → ${e.to.alertContacts.length}`);
      // Rule 8, opt-in: whether the alert contacts may lock this guardian, in words.
      const lockWas = isContactLockOn(e.from);
      const lockNow = isContactLockOn(e.to);
      if (lockWas !== lockNow) parts.push(lockNow ? 'alert contacts may now lock this guardian (LOCK over nostr)' : 'alert contacts can no longer lock this guardian');
      // No daily limit: said in words, never as 21 million BTC.
      if (nowOff && !wasOff) {
        const how = e.by === 'hardware' && e.sequence !== undefined ? ` (hardware approval #${e.sequence})` : '';
        return {
          ...base,
          kind: 'rules',
          event: `Daily limit turned off${how}: the phone and this guardian together can now send everything${parts.length ? `. Also: ${parts.join(', ')}` : ''}`,
          summary: 'Daily limit turned off',
          signedBy: e.by === 'hardware' ? 'Hardware wallet' : 'Phone',
          sats: null,
          result: 'rule-changed',
        };
      }
      if (wasOff && !nowOff) {
        return {
          ...base,
          kind: 'rules',
          event: `Daily limit turned back on: ${formatSatsText(e.to.dailyLimitSats)}${parts.length ? `. Also: ${parts.join(', ')}` : ''}`,
          summary: 'Daily limit back on',
          signedBy: e.by === 'hardware' ? 'Hardware wallet' : 'Phone',
          sats: null,
          result: 'rule-changed',
        };
      }
      if (e.from.dailyLimitSats !== e.to.dailyLimitSats) parts.unshift(`daily limit ${e.from.dailyLimitSats} → ${e.to.dailyLimitSats} sats`);
      const onlyLock = lockWas !== lockNow && parts.length === 1;
      return {
        ...base,
        kind: 'rules',
        event: onlyLock
          ? `${lockNow ? 'Alert contacts may now lock this guardian by sending it LOCK over nostr' : 'Alert contacts can no longer lock this guardian'}${e.by === 'hardware' && e.sequence !== undefined ? ` (hardware approval #${e.sequence})` : ''}`
          : `Rules changed${parts.length ? `: ${parts.join(', ')}` : ''}${nowOff ? ' (no daily limit)' : ''}`,
        summary: onlyLock ? (lockNow ? 'Contacts may lock the guardian' : 'Contacts can no longer lock') : 'Rules changed',
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
    case 'recovery_updated':
      return {
        ...base,
        kind: 'recovery',
        event: `Recovery ${e.recoveryId}: the sweep now also moves ${e.addedInputs} coin${e.addedInputs === 1 ? '' : 's'} that arrived after the start (the waiting period runs on)`,
        summary: 'Recovery sweep updated',
        signedBy: null,
        sats: Number(e.amountSats),
        result: 'ok',
      };
    case 'recovery_update_refused':
      return { ...base, kind: 'recovery', event: `Recovery sweep update refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_start_refused':
      return { ...base, kind: 'recovery', event: `Recovery refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_ready':
      return { ...base, kind: 'recovery', event: `Recovery ${e.recoveryId}: waiting period over`, signedBy: null, sats: null, result: 'ok' };
    case 'recovery_cancelled': {
      if (e.by.kind === 'superseded')
        return {
          ...base,
          kind: 'recovery',
          event: `Recovery ${e.recoveryId} closed: recovery ${e.by.recoveryId} already swept the wallet`,
          summary: 'Recovery closed',
          signedBy: null,
          sats: null,
          result: 'ok',
        };
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
    case 'limit_alert_sent': {
      const n = `${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}`;
      const [event, summary] =
        e.kind === 'limit_off'
          ? [`"Daily limit turned off" alert sent to ${n}`, 'Limit-off alert sent']
          : e.kind === 'limit_on'
            ? [`"Daily limit back on" alert sent to the phone`, 'Limit-on alert sent']
            : e.kind === 'contact_lock'
              ? [`"Locked by an alert contact" alert sent to ${n}`, 'Lock alert sent']
              : e.kind === 'contact_lock_on'
                ? [`"You may lock the guardian" message sent to ${n}`, 'Contacts told they may lock']
                : [`"You can no longer lock the guardian" message sent to ${n}`, 'Contacts told they can no longer lock'];
      return { ...base, kind: e.kind === 'contact_lock' ? 'system' : 'rules', event, summary, signedBy: null, sats: null, result: 'ok' };
    }
    case 'contact_locked':
      return {
        ...base,
        kind: 'system',
        event: `Locked by alert contact ${npubOrHex(e.contact)} via nostr (a LOCK message): nothing is co-signed until you unlock it. The phone and the other alert contacts are told.`,
        summary: `Locked by contact ${shortNpub(e.contact)} via nostr`,
        signedBy: 'Alert contact',
        sats: null,
        result: 'locked',
      };
    case 'wallet_rotated': {
      const grants =
        (e.revokedGrants ? ` ${e.revokedGrants} recovery access grant${e.revokedGrants === 1 ? '' : 's'} revoked.` : '') +
        (e.limitRestoredSats !== undefined ? ` The daily limit is back on for the new wallet, at ${formatSatsText(e.limitRestoredSats)}.` : '');
      return e.toWalletId
        ? {
            ...base,
            kind: 'recovery',
            event: `Recovery ${e.recoveryId}: now guarding the new wallet ${e.toWalletId}, paired with phone ${shortNpub(e.phone ?? '')}; wallet ${e.fromWalletId} retired. The hardware wallet must confirm the new wallet before it can approve anything.${grants}`,
            summary: 'Now guarding the recovered wallet',
            signedBy: null,
            sats: null,
            result: 'ok',
          }
        : {
            ...base,
            kind: 'recovery',
            event: `Recovery ${e.recoveryId}: wallet ${e.fromWalletId} retired; the new wallet is not guarded here (${e.detail ?? 'unknown reason'}).${grants}`,
            summary: 'Swept wallet retired',
            signedBy: null,
            sats: null,
            result: 'ok',
          };
    }
    case 'wallet_retired':
      return {
        ...base,
        kind: 'system',
        event: `Wallet ${e.walletId} retired: this guardian co-signs nothing for it any more, and a new wallet can be paired`,
        summary: 'Wallet retired',
        signedBy: 'Hardware wallet',
        sats: null,
        result: 'ok',
      };
    case 'single_key_registered':
      return {
        ...base,
        kind: 'system',
        event: `The phone registered its single-key coins for silent payments (${[e.helper ? 'the helper account' : '', e.coins ? `${e.coins} coin${e.coins === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'none'})`,
        summary: 'Silent payment coins registered',
        signedBy: 'Phone',
        sats: null,
        result: 'ok',
      };
    case 'wallet_unwatched':
      return { ...base, kind: 'system', event: `Stopped watching the replaced wallet ${e.walletId}`, summary: 'Stopped watching a wallet', signedBy: 'Phone', sats: null, result: 'ok' };
    case 'wallet_retire_refused':
      return { ...base, kind: 'system', event: `Retiring the wallet refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'hardware_auth_confirmed':
      return { ...base, kind: 'rules', event: `Hardware wallet confirmed for wallet ${e.walletId}`, summary: 'Hardware wallet confirmed', signedBy: 'Hardware wallet', sats: null, result: 'ok' };
    case 'hardware_auth_confirm_refused':
      return { ...base, kind: 'rules', event: `Hardware wallet confirmation refused: ${refusalText(e.refusal)}`, signedBy: null, sats: null, result: 'refused' };
    case 'recovery_access_granted':
      return {
        ...base,
        kind: 'recovery',
        event: `A new phone (${shortNpub(e.phone)}) may read the wallet and start a recovery until ${formatWhen(e.until)}, approved on the hardware wallet`,
        summary: 'Recovery access for a new phone',
        signedBy: 'Hardware wallet',
        sats: null,
        result: 'ok',
      };
    case 'guardian_reset':
      return { ...base, kind: 'system', event: 'Guardian reset: every wallet, rule and recovery record was forgotten', summary: 'Guardian reset', signedBy: null, sats: null, result: 'ok' };
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
      return {
        ...base,
        kind: 'system',
        event: e.reason === 'remote' ? 'Guardian locked from the phone' : 'Guardian locked',
        signedBy: e.reason === 'remote' ? 'Phone' : null,
        sats: null,
        result: 'locked',
      };
    case 'reset':
      return { ...base, kind: 'system', event: 'Guardian reset on this box: a new key 3 was created and the old one destroyed', summary: 'Guardian reset', signedBy: null, sats: null, result: 'ok' };
    case 'reset_refused':
      return { ...base, kind: 'system', event: `Guardian reset refused: ${e.detail}`, signedBy: null, sats: null, result: 'refused' };
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
    case 'sweep_dead':
      return { ...base, kind: 'recovery', event: `Recovery ${e.recoveryId} sweep ${shortTx(e.txid)} can never be broadcast; no longer retried: ${e.detail}`, summary: 'Sweep given up', signedBy: null, sats: null, result: 'refused' };
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
    case 'contact_lock_request':
      return {
        ...base,
        kind: 'system',
        event:
          e.outcome === 'already_locked'
            ? `Alert contact ${shortNpub(e.contact)} sent LOCK; the guardian was already locked`
            : `Alert contact ${shortNpub(e.contact)} sent LOCK, which the rules do not allow; nothing changed`,
        summary: e.outcome === 'already_locked' ? 'LOCK from a contact (already locked)' : 'LOCK from a contact refused',
        signedBy: 'Alert contact',
        sats: null,
        result: e.outcome === 'already_locked' ? 'ok' : 'refused',
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
    case 'relays_changed': {
      const added = e.to.filter((r) => !e.from.includes(r));
      const removed = e.from.filter((r) => !e.to.includes(r));
      const parts = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')} (still watched until you stop them)` : ''];
      return {
        ...base,
        kind: 'system',
        event: `Relays changed on this box: ${parts.filter(Boolean).join('; ')}. A paired phone is told and moves by itself.`,
        summary: 'Relays changed',
        signedBy: null,
        sats: null,
        result: 'ok',
      };
    }
    case 'relays_confirmed':
      return { ...base, kind: 'system', event: `The paired phone switched to the new relays (${e.relays.join(', ')})`, summary: 'Phone switched relays', signedBy: 'Phone', sats: null, result: 'ok' };
    case 'relays_retired':
      return {
        ...base,
        kind: 'system',
        event: e.by
          ? `Stopped watching ${e.relays.length === 1 ? '1 old relay' : `${e.relays.length} old relays`} (${e.relays.join(', ')}) at your request: recovery sheets, backups and phones that only know ${e.relays.length === 1 ? 'it' : 'them'} no longer reach this box`
          : `Stopped watching the old relays ${e.relays.join(', ')}: their 30 days were over`,
        summary: 'Old relays dropped',
        signedBy: null,
        sats: null,
        result: 'ok',
      };
  }
}
