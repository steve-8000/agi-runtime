#!/usr/bin/env node
// Install the AGI runtime into OMP's user extension directory as a symlink to this checkout.
// Idempotent. Never overwrites a foreign file at the target. `--uninstall` removes only our link.
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeLayout, defaultAgentDir } from '../src/paths.mjs';
import { check } from '../src/util.mjs';

const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const layout = runtimeLayout(defaultAgentDir());
const uninstall = process.argv.includes('--uninstall');

function linkState() {
  if (!existsSync(layout.extensionLink) && !isLink()) return 'absent';
  if (!isLink()) return 'foreign-file';
  return realpathSync(layout.extensionLink) === repo ? 'ours' : 'foreign-link';
}
function isLink() { try { return lstatSync(layout.extensionLink).isSymbolicLink(); } catch { return false; } }

const before = linkState();
if (uninstall) {
  check(before !== 'foreign-file' && before !== 'foreign-link', 'FOREIGN_EXTENSION_AT_TARGET', `${layout.extensionLink} is not ours; not touching it`);
  if (before === 'ours') unlinkSync(layout.extensionLink);
} else {
  check(before !== 'foreign-file' && before !== 'foreign-link', 'FOREIGN_EXTENSION_AT_TARGET', `${layout.extensionLink} exists and does not point at ${repo}`);
  mkdirSync(dirname(layout.extensionLink), { recursive: true });
  if (before === 'absent') symlinkSync(repo, layout.extensionLink, 'dir');
  mkdirSync(layout.journals, { recursive: true, mode: 0o700 });
  mkdirSync(layout.compat, { recursive: true, mode: 0o700 });
  // Operator config is seeded once from the repo defaults and then owned by the operator.
  if (!existsSync(layout.config)) copyFileSync(join(repo, 'config', 'runtime.json'), layout.config);
}
console.log(JSON.stringify({
  action: uninstall ? 'uninstall' : 'install', repo, extensionLink: layout.extensionLink,
  linkTarget: isLink() ? readlinkSync(layout.extensionLink) : null, before, after: linkState(),
  runtimeDir: layout.root, config: layout.config, configPresent: existsSync(layout.config),
  next: uninstall ? null : 'start a new omp session; then `node scripts/doctor.mjs` (or `--live` compat) to confirm it loaded'
}, null, 2));
