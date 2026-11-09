#!/usr/bin/env node
// Moves every place that names the release version to a new one (docs/releasing.md, step 1):
//   node tools/release/bump.mjs 0.1.26
// The package versions (root, guardian, mobile, Expo's app.json, the lockfile), the guardian image tag in the three
// compose/package files, the Umbrel app version and the Start9 version. It checks that each file named the current
// version before changing it, so a file that drifted is reported instead of silently skipped. It does not write release
// notes: it prints what is still yours to write. TRIKEY_ROOT points it at another checkout (the tests use a copy).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.TRIKEY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: node tools/release/bump.mjs <x.y.z>   (the version without "-alpha")');
  process.exit(2);
}
const path = (p) => join(root, p);
const read = (p) => readFileSync(path(p), 'utf8');
const current = JSON.parse(read('package.json')).version;
if (current === next) {
  console.error(`Already at ${next}.`);
  process.exit(1);
}
const problems = [];

function json(p, edit) {
  const text = read(p);
  const data = JSON.parse(text);
  edit(data);
  writeFileSync(path(p), JSON.stringify(data, null, 2) + (text.endsWith('\n') ? '\n' : ''));
}
function setVersion(obj, where) {
  if (obj.version !== current) problems.push(`${where}: version is ${obj.version}, expected ${current}`);
  obj.version = next;
}
function replace(p, from, to) {
  const text = read(p);
  if (!text.includes(from)) {
    problems.push(`${p}: no "${from}"`);
    return;
  }
  writeFileSync(path(p), text.split(from).join(to));
}

for (const p of ['package.json', 'apps/guardian/package.json', 'apps/mobile/package.json']) json(p, (d) => setVersion(d, p));
json('apps/mobile/app.json', (d) => setVersion(d.expo, 'apps/mobile/app.json expo'));
json('package-lock.json', (d) => {
  setVersion(d, 'package-lock.json');
  for (const k of ['', 'apps/guardian', 'apps/mobile']) setVersion(d.packages[k], `package-lock.json packages["${k}"]`);
});
const image = 'ghcr.io/theicaruswings/trikey-guardian:';
for (const p of ['packaging/compose/docker-compose.yml', 'packaging/umbrel/trikey-guardian/docker-compose.yml', 'packaging/start9/startos/manifest/index.ts'])
  replace(p, `${image}${current}-alpha`, `${image}${next}-alpha`);
replace('packaging/umbrel/trikey-guardian/umbrel-app.yml', `version: "${current}-alpha"`, `version: "${next}-alpha"`);
replace('packaging/start9/startos/versions/current.ts', `version: '${current}:0'`, `version: '${next}:0'`);

if (problems.length) {
  console.error(`Moved what matched to ${next}, but these did not name ${current}; fix them by hand:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
const hasSection = read('CHANGELOG.md').includes(`## [${next}-alpha] - `);
console.log(`${current} -> ${next}: 10 files updated.`);
console.log('Still yours to write (docs/releasing.md, step 2):');
if (!hasSection) console.log(`  - CHANGELOG.md: a section "## [${next}-alpha] - ${today}" above the last one (the release notes come from it)`);
console.log('  - packaging/umbrel/trikey-guardian/umbrel-app.yml: releaseNotes');
console.log('  - packaging/start9/startos/versions/current.ts: releaseNotes');
