#!/usr/bin/env node
// Compatibility check for the installed OMP.
//   default : offline - run the extension against the API mock for the tested contract, in a temp runtime dir.
//   --live  : also run the real `omp -p` in a scratch workspace with the installed extension, then read the
//             compat report and journal it produced. This costs one small model call.
// Exit code 1 on any degraded verdict.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mockPi, mockCtx, dispatch } from '../tests/mock-pi.mjs';
import { RuntimeStore } from '../src/store.mjs';
import { runtimeLayout, journalPath, defaultAgentDir } from '../src/paths.mjs';

const live = process.argv.includes('--live');
const results = { offline: null, live: null };

async function offline() {
  const base = mkdtempSync(join(tmpdir(), 'agi-runtime-compat-'));
  const root = join(base, 'workspace'); mkdirSync(root); writeFileSync(join(root, 'a.txt'), 'a\n');
  const agentDir = join(base, 'agent'); mkdirSync(agentDir);
  const previous = process.env.OMP_RUNTIME_DIR; process.env.OMP_RUNTIME_DIR = join(base, 'runtime');
  try {
    const { default: factory } = await import('../extension/index.ts');
    const m = mockPi({ agentDir }); const ctx = mockCtx({ cwd: root });
    factory(m.pi); await m.handlers.get('session_start')({}, ctx);
    await dispatch(m.handlers, ctx, { toolCallId: 'r', toolName: 'read', input: { path: 'a.txt' } });
    await dispatch(m.handlers, ctx, { toolCallId: 'b', toolName: 'bash', input: { command: 'true' } });
    const status = (await m.tools.get('runtime_status').execute('s', {}, undefined, undefined, ctx)).details;
    await m.handlers.get('session_shutdown')({}, ctx);
    const layout = runtimeLayout(agentDir);
    const report = JSON.parse(readFileSync(join(layout.compat, readdirSync(layout.compat)[0]), 'utf8'));
    return { verdict: report.verdict, contract: report.contract, mockVersion: report.version, counters: status.contract, notices: ctx.notices };
  } finally {
    if (previous === undefined) delete process.env.OMP_RUNTIME_DIR; else process.env.OMP_RUNTIME_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
}

async function liveRun() {
  const version = spawnSync('omp', ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^omp\//, '');
  const layout = runtimeLayout(defaultAgentDir());
  if (!existsSync(layout.extensionLink)) return { verdict: 'degraded', reason: 'extension not installed; run scripts/install.mjs' };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agi-runtime-live-')));
  writeFileSync(join(root, 'README.md'), '# scratch\nThis workspace exists to verify the AGI runtime extension loads.\n');
  const prompt = 'Use the read tool on README.md, then run the bash command `printf compat-ok`, then reply with exactly one word: done.';
  // OMP_COMPAT_MODEL selects a cheaper model for the probe; the extension path is identical either way.
  const args = ['-p', '--no-session', '--no-title', '--cwd', root, ...(process.env.OMP_COMPAT_MODEL ? ['--model', process.env.OMP_COMPAT_MODEL, '--thinking', 'low'] : []), prompt];
  // The probe checks the event contract, not the operator's policy: a recall requirement would refuse the bash step.
  const probeConfig = join(root, '..', `${root.split('/').pop()}-config.json`);
  writeFileSync(probeConfig, JSON.stringify({ mode: 'enforce' }));
  const run = spawnSync('omp', args, { encoding: 'utf8', timeout: 180000, env: { ...process.env, OMP_RUNTIME_REQUIRED: '1', OMP_RUNTIME_CONFIG: probeConfig } });
  rmSync(probeConfig, { force: true });
  const reportPath = join(layout.compat, `${version}.json`);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  let actions = [];
  try {
    const store = await RuntimeStore.open(journalPath(layout, root));
    try { actions = store.db.prepare('SELECT tool,is_effect,state FROM actions ORDER BY created').all().map(r => ({ ...r })); } finally { store.close(); }
  } catch (error) { actions = { error: error.code ?? error.message }; }
  rmSync(root, { recursive: true, force: true });
  const ok = run.status === 0 && report?.verdict === 'ok' && Array.isArray(actions) && actions.some(a => a.tool === 'bash' && a.state === 'succeeded');
  return { verdict: ok ? 'ok' : 'degraded', ompVersion: version, exitCode: run.status, stdoutTail: run.stdout.trim().split('\n').slice(-3), stderrTail: run.stderr.trim().split('\n').slice(-5), report, actions };
}

results.offline = await offline();
if (live) results.live = await liveRun();
const degraded = results.offline.verdict !== 'ok' || (live && results.live.verdict !== 'ok');
console.log(JSON.stringify({ degraded, ...results }, null, 2));
if (degraded) process.exitCode = 1;
