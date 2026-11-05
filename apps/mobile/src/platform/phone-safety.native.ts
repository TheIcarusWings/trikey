// iOS and Android (both Android builds: none of these modules brings Google code): the phone-safety facts from
// expo-local-authentication (is a screen lock set), expo-device (emulator or simulator) and, on Android, the app's
// tiny module for the security patch level (modules/trikey-phone-safety).
//
// PRIVACY: read on the phone, shown on the phone. Nothing here is sent to the guardian, any server or analytics.
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as LocalAuthentication from 'expo-local-authentication';
import { androidSecurityPatch } from '../../modules/trikey-phone-safety';
import type { PhoneSafetyFacts } from '../lib/phone-safety';
import { readPhoneSafetyFacts } from './phone-safety-read';

export function phoneSafetyFacts(): Promise<PhoneSafetyFacts> {
  return readPhoneSafetyFacts({
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    enrolledLevel: () => LocalAuthentication.getEnrolledLevelAsync(),
    isDevice: () => Device.isDevice,
    securityPatch: androidSecurityPatch,
  });
}
