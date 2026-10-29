import type { CloudProvider, Guardian, GuardianHost, GuardianStatus } from '@/data';

export function hostLabel(host: GuardianHost): string {
  return host === 'umbrel' ? 'Umbrel' : host === 'start9' ? 'Start9' : 'guardian box';
}

/** What to call the guardian's box: the name it gave itself, else its platform. */
export function guardianBox(guardian: Pick<Guardian, 'host' | 'label'>): string {
  return guardian.host === 'other' && guardian.label ? guardian.label : hostLabel(guardian.host);
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
    case 'file':
      return 'a file on this phone';
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
    case 'file':
      return 'Whoever holds the file';
  }
}

export function guardianStatusLabel(status: GuardianStatus): string {
  return status === 'online' ? 'online' : status === 'locked' ? 'locked' : 'offline';
}
