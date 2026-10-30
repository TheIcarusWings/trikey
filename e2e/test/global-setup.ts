import { SKIP_NOTE, e2eMode } from '../src/config.js';

export default function setup(): void {
  if (!e2eMode()) process.stderr.write(`\n[@trikey/e2e] ${SKIP_NOTE}\n\n`);
}
