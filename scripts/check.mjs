#!/usr/bin/env node
// Static gate: every JavaScript module parses, and the TypeScript extension typechecks against types/.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (/\.(mjs|js)$/.test(entry.name)) { execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' }); count++; }
  }
}
for (const name of ['src', 'scripts', 'tests']) visit(join(root, name));
console.log(JSON.stringify({ check: 'javascript-syntax', files: count, status: 'passed' }));
execFileSync('tsc', ['-p', root], { stdio: 'pipe' });
console.log(JSON.stringify({ check: 'extension-typescript', status: 'passed', scope: 'against types/pi-coding-agent.d.ts, not a full OMP typecheck' }));
