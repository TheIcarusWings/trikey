import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { Smartphone } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { phoneSafetyNotes, type PhoneSafetyFacts, type PhoneSafetyNote } from '@/lib/phone-safety';
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

/** The notes about this phone (src/lib/phone-safety.ts), or undefined until the phone has said; none when it looks fine. */
export function usePhoneSafetyNotes(): PhoneSafetyNote[] | undefined {
  const facts = usePhoneSafetyFacts();
  return useMemo(() => (facts ? phoneSafetyNotes(facts, new Date()) : undefined), [facts]);
}

/** The Security tab's calm notes about this phone, in its "Phone safety" sheet; one sentence when it looks fine. */
export function PhoneSafetyNotes({ notes }: { notes: PhoneSafetyNote[] | undefined }) {
  if (notes?.length)
    return (
      <>
        {notes.map((n) => (
          <Notice key={n.id} icon={Smartphone} tone="outline" title={n.title}>
            {n.body}
          </Notice>
        ))}
      </>
    );
  return (
    <Body>
      {notes
        ? 'No issues found. Trikey looks at what this phone says about its screen lock and system updates, here on the phone; nothing is sent anywhere.'
        : 'Checking what this phone says about itself…'}
    </Body>
  );
}
