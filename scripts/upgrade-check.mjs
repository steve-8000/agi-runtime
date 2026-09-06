#!/usr/bin/env node
/**
 * Post-update gate for this runtime. It never updates OMP, never edits runtime
 * config or journals, never touches Kubernetes, and never rewrites source.
 *
 * Steps:
 *   1. installed OMP version
 *   2. working tree cleanliness (warning only)
 *   3. scripts/check.mjs
 *   4. tests/*.test.mjs
 *   5. scripts/install.mjs plan: the loaded extension must be this checkout
 *   6. --live: one real `omp -p` in a scratch workspace and runtime dir, which
 *      proves the new binary still discovers, imports and attaches the extension.
 *      This costs one model call. Without it, live attach is untested.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let live = false, jsonOutput = false, model = process.env.OMP_UPDATE_PROBE_MODEL;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--live') live = true;
  else if (arg === '--json') jsonOutput = true;
  else if (arg === '--model') { model = argv[++i]; if (!model) fail('--model requires a selector'); }
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/upgrade-check.mjs [--live] [--model <selector>] [--json]');
    process.exit(0);
  } else fail(`unknown option: ${arg}`);
}
function fail(message) { console.error(`upgrade-check: ${message}`); process.exit(2); }
const tail = (text, lines = 8) => String(text ?? '').trim().split('\n').filter(Boolean).slice(-lines).join('\n');

const steps = [];
function run(name, command, args, { required = true, timeout = 240_000, env = {}, cwd = root, quiet = false } = {}) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env, ...env } });
  const step = {
    name, command: [command, ...args].join(' '), required,
    ok: r.status === 0 && !r.error, exitCode: r.status, durationMs: Date.now() - started,
    stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error?.message ?? null,
  };
  steps.push(step);
  if (!jsonOutput && !quiet) {
    console.log(`[${step.ok ? 'PASS' : required ? 'FAIL' : 'WARN'}] ${name} (${step.durationMs}ms)`);
    if (!step.ok) {
      if (step.error) console.log(`  ${step.error}`);
      const detail = tail(step.stderr || step.stdout);
      if (detail) console.log(detail.split('\n').map(l => `  ${l}`).join('\n'));
    }
  }
  return step;
}
function json(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  try { return JSON.parse(start > 0 ? raw.slice(start) : raw); } catch { return null; }
}
function note(ok, message) {
  if (!jsonOutput) console.log(`[${ok ? 'PASS' : 'WARN'}] ${message}`);
}

const omp = run('omp-version', 'omp', ['--version'], { timeout: 30_000 });
const ompVersion = omp.ok ? omp.stdout.trim().replace(/^omp\//, '') : null;

const git = run('git-status', 'git', ['status', '--porcelain'], { required: false, timeout: 30_000, quiet: true });
const dirty = git.ok && git.stdout.trim().length > 0;
note(!dirty, `checkout ${dirty ? 'has local changes' : 'clean'}`);

run('static-check', process.execPath, ['scripts/check.mjs'], { timeout: 120_000 });

const tests = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => join('tests', f));
run('test-suite', process.execPath, ['--test', '--test-reporter=tap', ...tests], { timeout: 300_000 });

// The gate is worthless if the OMP process loads some other copy of the runtime.
const plan = run('extension-link', process.execPath, ['scripts/install.mjs'], { timeout: 60_000 });
const planJson = json(plan.stdout);
const linked = planJson?.current ?? null;
const linkOk = linked === root;
if (plan.ok && !linkOk) {
  plan.ok = false;
  plan.error = `loaded extension is ${linked ?? 'absent'}, not this checkout`;
  if (!jsonOutput) console.log(`[FAIL] extension-link points at ${linked ?? 'nothing'}; run: node scripts/install.mjs --activate`);
}

let attach = null;
if (live) {
  const workspace = mkdtempSync(join(tmpdir(), 'omp-update-ws-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'omp-update-rt-'));
  try {
    const args = ['-p', 'Reply with exactly one word: done.', '--no-session', '--no-title', '--cwd', workspace,
      ...(model ? ['--model', model] : []), '--thinking', 'low'];
    const probe = run('live-probe', 'omp', args, { timeout: 300_000, cwd: workspace, env: { OMP_RUNTIME_DIR: runtimeDir } });
    let journals = [];
    try { journals = readdirSync(join(runtimeDir, 'journals')).filter(f => f.endsWith('.sqlite')); } catch { /* none */ }
    attach = { journals: journals.length, stdoutTail: tail(probe.stdout, 3) };
    // A journal file only exists if session_start attached: discovery, import and lease all worked.
    steps.push({ name: 'live-attach', command: 'journal created by the probe', required: true,
      ok: journals.length > 0, exitCode: journals.length > 0 ? 0 : 1, durationMs: 0, stdout: '', stderr: '',
      error: journals.length > 0 ? null : 'the probe produced no journal: the extension did not attach' });
    if (!jsonOutput) console.log(`[${journals.length > 0 ? 'PASS' : 'FAIL'}] live-attach (${journals.length} journal)`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

const failures = steps.filter(s => s.required && !s.ok);
const status = failures.length ? 'FAIL' : 'PASS';
if (jsonOutput) {
  console.log(JSON.stringify({
    status, ompVersion, liveProbe: live, model: model ?? null, checkoutDirty: dirty, extensionLink: linked, attach,
    steps: steps.map(({ stdout, stderr, ...s }) => ({ ...s, stdoutTail: tail(stdout, 3), stderrTail: tail(stderr, 3) })),
  }, null, 2));
} else {
  console.log('');
  console.log(`runtime upgrade-check: ${status}${ompVersion ? ` (OMP ${ompVersion})` : ''}`);
  if (!live) console.log('NOTE: live attach was not tested. Re-run with --live to spend one model call on a real omp -p probe.');
  if (dirty) console.log('WARN: results describe this working tree, not origin/main.');
  if (failures.length) console.log(`Failed: ${failures.map(s => s.name).join(', ')}`);
}
process.exitCode = status === 'FAIL' ? 1 : 0;
