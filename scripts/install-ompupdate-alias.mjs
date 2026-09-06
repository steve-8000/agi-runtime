#!/usr/bin/env node
/**
 * Install one zsh command, `ompupdate`, into the user's rc file.
 *
 *   ompupdate [flags]      -> `omp update [flags]`, then the post-update gate with a live probe
 *   ompupdate --gate-only  -> only the gate; remaining flags go to upgrade-check.mjs
 *
 * A shell function, not `alias`: zsh appends alias arguments to the end of the
 * expansion, so an alias could not pass flags to `omp update` and still run a
 * second command afterwards.
 *
 * OMP's own updater stays authoritative. Nothing else in the shell is wrapped:
 * plain `omp` keeps resolving to the real binary. This installer touches one
 * managed block in the rc file and nothing else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let uninstall = false, rc = process.env.OMPUPDATE_RC ?? join(homedir(), '.zshrc');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--uninstall') uninstall = true;
  else if (argv[i] === '--rc' && argv[i + 1]) rc = resolve(argv[++i]);
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('Usage: node scripts/install-ompupdate-alias.mjs [--uninstall] [--rc <file>]');
    process.exit(0);
  } else { console.error(`install-ompupdate-alias: unknown option: ${argv[i]}`); process.exit(2); }
}

const BEGIN = '# >>> ompupdate (agi-runtime) >>>';
const END = '# <<< ompupdate (agi-runtime) <<<';
const block = `${BEGIN}
# Managed by ${root}/scripts/install-ompupdate-alias.mjs — edit there, not here.
ompupdate() {
  local repo=${JSON.stringify(root)}
  if [[ "$1" == "--gate-only" ]]; then
    shift
    command node "$repo/scripts/upgrade-check.mjs" "$@"
    return $?
  fi
  command omp update "$@" || return $?
  command node "$repo/scripts/upgrade-check.mjs" --live
}
${END}`;

let text = '';
try { text = readFileSync(rc, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const start = text.indexOf(BEGIN);
const stop = text.indexOf(END);
const hadBlock = start !== -1 && stop > start;
// A half-written block (one marker only) is left alone: refusing beats corrupting an rc file.
if ((start === -1) !== (stop === -1)) {
  console.error(`install-ompupdate-alias: ${rc} has an unbalanced managed block; fix it by hand`);
  process.exit(1);
}
// Normalize once so installing twice is a fixed point: the block always sits at the
// end after exactly one blank line, and removing it leaves the original tail intact.
const withoutBlock = hadBlock ? text.slice(0, start) + text.slice(stop + END.length) : text;
// Only trailing newlines are normalized. Whitespace inside the operator's own last
// line is theirs; stripping it would edit a line this installer does not manage.
const body = withoutBlock.replace(/\n+$/, '');
const next = uninstall
  ? (body === '' ? '' : `${body}\n`)
  : (body === '' ? `${block}\n` : `${body}\n\n${block}\n`);
const changed = next !== text;
if (changed) writeFileSync(rc, next, { mode: 0o644 });

console.log(JSON.stringify({
  action: uninstall ? 'uninstall' : 'install',
  rc, repo: root, command: 'ompupdate', hadBlock, changed,
  next: uninstall ? 'Run `source ~/.zshrc` (or open a new shell) to drop the function.'
    : 'Run `source ~/.zshrc` (or open a new shell), then `ompupdate`.',
}, null, 2));
