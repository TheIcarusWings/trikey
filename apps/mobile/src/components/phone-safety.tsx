import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { Smartphone } from '@/components/icons';
import { Notice, SectionLabel } from '@/components/panels';
import { phoneSafetyNotes, type PhoneSafetyFacts } from '@/lib/phone-safety';
import { phoneSafetyFacts } from '@/platform/phone-safety';

/**
 * What the phone says about itself (screen lock, security patch, emulator), read when the screen opens and again each
 * time the app comes back to the front (the person may have just set a screen lock). Stays on the phone: nothing is
 * sent to the guardian, any server or analytics.
 */
export function usePhoneSafetyFacts(): PhoneSafetyFacts | undefined {
  const [facts, setFacts] = useState<PhoneSafetyFacts>();
  useEffect(() => {
    let live = true;
    const read = () =>
      void phoneSafetyFacts()
        .then((f) => live && setFacts(f))
        .catch(() => undefined);
    read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') read();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return facts;
}

/** The Security tab's calm notes about this phone (src/lib/phone-safety.ts); nothing when it looks fine. */
export function PhoneSafetySection() {
  const facts = usePhoneSafetyFacts();
  const notes = facts ? phoneSafetyNotes(facts, new Date()) : [];
  if (!notes.length) return null;
  return (
    <>
      <SectionLabel>This phone</SectionLabel>
      {notes.map((n) => (
        <Notice key={n.id} icon={Smartphone} tone="outline" title={n.title}>
          {n.body}
        </Notice>
      ))}
    </>
  );
}
