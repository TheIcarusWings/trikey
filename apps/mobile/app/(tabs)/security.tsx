import { useIsFocused, useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ListGroup, SectionLabel, SettingsRow } from '@/components/panels';
import { PhoneSafetyNotes, usePhoneSafetyNotes } from '@/components/phone-safety';
import { Screen } from '@/components/screen';
import { SecurityBannerView, TileGrid } from '@/components/security-hub';
import { Sheet } from '@/components/sheet';
import { useNow, useWallet, useWalletService } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import {
  guardianChecking,
  needsYou,
  securityBanner,
  securitySignature,
  securityTiles,
  shouldPlayEntrance,
  type Fix,
  type SecurityTile,
} from '@/lib/security-view';
import { SECURITY_ENTRANCE } from '@/theme/motion';

/** The entrance is over by then (the soft ring ends at 2.15s). */
const ENTRANCE_MS = SECURITY_ENTRANCE.haloAtMs + SECURITY_ENTRANCE.haloMs + 200;

/** What the tab last showed (`securitySignature`), for as long as the app runs: its entrance plays again after a change. */
let lastShown: string | null = null;

/**
 * The Security tab (docs/design/motion.md, section 8): a banner with the three keys drawn as the Trikey mark and what
 * needs the person, then the keys and the rules that protect the money as tiles. Every tile goes where the row it
 * replaced went. The entrance plays on the first visit after launch and after a change, not on every tab switch.
 */
export default function SecurityScreen() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const now = useNow();
  const focused = useIsFocused();
  const rk = state.mode === 'recoveryKey';
  // Calm advice about the phone itself (no screen lock, an old security patch, an emulator); read on the phone, sent nowhere.
  const notes = usePhoneSafetyNotes();
  const [safetyOpen, setSafetyOpen] = useState(false);

  const banner = securityBanner(needsYou(state));
  const checking = !rk && guardianChecking(state);
  const tiles = securityTiles(state, { now, os: IS_IOS ? 'ios' : 'android', checking, phoneNotes: notes, needing: banner.needing });
  const signature = securitySignature(banner, [...tiles.keys, ...tiles.protection]);

  // `n` remounts the banner and tiles for an entrance; `play` says this mount is one.
  const [run, setRun] = useState(() => ({ n: 0, play: shouldPlayEntrance(lastShown, signature) }));
  const wasFocused = useRef<boolean | null>(null);
  useEffect(() => {
    // Coming into view after a change made elsewhere: the entrance again. A change seen here plays its own motion.
    if (wasFocused.current === false && focused && shouldPlayEntrance(lastShown, signature)) setRun((r) => ({ n: r.n + 1, play: true }));
    wasFocused.current = focused;
    if (focused) lastShown = signature;
  }, [focused, signature]);
  // Once the entrance is over, anything that mounts later (a piece that appears with a change) is simply there.
  useEffect(() => {
    if (!run.play) return;
    const t = setTimeout(() => setRun((r) => (r.play ? { ...r, play: false } : r)), ENTRANCE_MS);
    return () => clearTimeout(t);
  }, [run]);

  const go = (fix: Fix) => router.push(fix as Href);
  const openTile = (t: SecurityTile) => {
    if (t.action === 'phone-safety') setSafetyOpen(true);
    else if (t.action) go(t.action);
  };

  return (
    <Screen tab title="Security" gap={pick(12, 0)} onRefresh={() => wallet.sync()}>
      <View key={run.n} className={pick('gap-3', '')}>
        <SecurityBannerView
          banner={banner}
          checking={checking}
          third={rk ? 'recoveryKey' : 'guardian'}
          play={run.play}
          focused={focused}
          onFix={() => banner.fix && go(banner.fix)}
        />

        <SectionLabel>Your keys</SectionLabel>
        <TileGrid tiles={tiles.keys} first={0} play={run.play} onPress={openTile} />
        {/* Savings: a new phone without a backup finds it at the guardian, so the row is there whenever Savings can be had. */}
        {tiles.savingsLost ? (
          <View className={pick('', 'mt-2')}>
            <ListGroup>
              <SettingsRow title="Lost a Savings key?" onPress={() => router.push('/savings/replace')} />
            </ListGroup>
          </View>
        ) : null}

        <SectionLabel>Protection</SectionLabel>
        <TileGrid tiles={tiles.protection} first={tiles.keys.length} play={run.play} onPress={openTile} />
      </View>

      <Sheet visible={safetyOpen} title="Phone safety" onClose={() => setSafetyOpen(false)}>
        <PhoneSafetyNotes notes={notes} />
      </Sheet>
    </Screen>
  );
}
