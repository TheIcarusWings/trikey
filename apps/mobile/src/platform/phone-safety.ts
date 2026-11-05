// Web and test version of the phone-safety reader: a browser says nothing about the phone's lock or patches, so there
// is no note. `phone-safety.native.ts` is what iOS and Android load (Metro picks it by extension).
import type { PhoneSafetyFacts } from '../lib/phone-safety';
import { readPhoneSafetyFacts } from './phone-safety-read';

export function phoneSafetyFacts(): Promise<PhoneSafetyFacts> {
  return readPhoneSafetyFacts({ platform: 'web' });
}
