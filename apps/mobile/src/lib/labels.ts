import type { CloudProvider, GuardianHost, GuardianStatus } from '@/data';

export function hostLabel(host: GuardianHost): string {
  return host === 'umbrel' ? 'Umbrel' : 'Start9';
}

export function cloudLabel(provider: CloudProvider): string {
  switch (provider) {
    case 'icloud':
      return 'iCloud Drive';
    case 'google-drive':
      return 'Google Drive';
    case 'dropbox':
      return 'Dropbox';
    case 'proton-drive':
      return 'Proton Drive';
    case 'other':
      return 'another app';
  }
}

/** Who can read the backup: shown under "Your passkey unlocks the backup". */
export function cloudOperator(provider: CloudProvider): string {
  switch (provider) {
    case 'icloud':
      return 'Apple';
    case 'google-drive':
      return 'Google';
    case 'dropbox':
      return 'Dropbox';
    case 'proton-drive':
      return 'Proton';
    case 'other':
      return 'The cloud provider';
  }
}

export function guardianStatusLabel(status: GuardianStatus): string {
  return status === 'online' ? 'online' : status === 'locked' ? 'locked' : 'offline';
}
