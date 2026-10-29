/** Display names for the DMK's model ids. Unknown ids are shown as they are. */
const NAMES: Record<string, string> = {
  nanoS: 'Nano S',
  nanoSP: 'Nano S Plus',
  nanoX: 'Nano X',
  stax: 'Stax',
  flex: 'Flex',
  apexp: 'Apex P',
};

export function ledgerModelName(model: string): string {
  return NAMES[model] ?? model;
}
