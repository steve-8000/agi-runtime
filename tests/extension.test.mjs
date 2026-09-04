import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import agiRuntime from '../extension/index.ts';
import { RuntimeStore } from '../src/store.mjs';
import { runtimeLayout, journalPath } from '../src/paths.mjs';
import { mockPi, mockCtx, dispatch } from './mock-pi.mjs';

async function harness(t, { hasUI = true, omit = [], config, required = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'omp-extension-'));
  const root = join(base, 'workspace'); mkdirSync(root); writeFileSync(join(root, 'code.txt'), 'actual source\n');
  const agentDir = join(base, 'omp', 'agent'); mkdirSync(agentDir, { recursive: true });
  const runtimeDir = join(base, 'omp', 'runtime'); mkdirSync(runtimeDir, { recursive: true });
  if (config) writeFileSync(join(runtimeDir, 'config.json'), JSON.stringify(config));
  const env = { OMP_RUNTIME_DIR: process.env.OMP_RUNTIME_DIR, OMP_RUNTIME_REQUIRED: process.env.OMP_RUNTIME_REQUIRED };
  process.env.OMP_RUNTIME_DIR = runtimeDir;
  if (required) process.env.OMP_RUNTIME_REQUIRED = '1'; else delete process.env.OMP_RUNTIME_REQUIRED;
  // The module reads OMP_RUNTIME_REQUIRED at import time; re-import with a cache-buster like OMP's loader does.
  const factory = required ? (await import(`../extension/index.ts?required=${Date.now()}`)).default : agiRuntime;
  const m = mockPi({ agentDir, omit });
  const ctx = mockCtx({ cwd: root, hasUI });
  factory(m.pi);
  t.after(async () => {
    try { await m.handlers.get('session_shutdown')?.({}, ctx); } finally {
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(base, { recursive: true, force: true });
    }
  });
  const layout = runtimeLayout(agentDir);
  return { ...m, ctx, root, base, layout, journal: () => journalPath(layout, root),
    async openJournal() { const s = await RuntimeStore.open(journalPath(layout, root)); t.after(() => s.close()); return s; },
    report: () => JSON.parse(readFileSync(join(layout.compat, '18.1.10.json'), 'utf8')) };
}

test('loads with the tested contract, journals a full tool cycle, and reports compat ok', async t => {
  const h = await harness(t);
  assert.equal(h.pi.label, 'AGI Runtime'); assert.equal(h.tools.size, 4); assert.ok(h.commands.has('runtime'));
  await h.handlers.get('session_start')({}, h.ctx);
  assert.equal(existsSync(h.journal()), true, 'journal created under runtime dir');
  assert.equal(h.report().verdict, 'ok'); assert.deepEqual(h.report().api.missing, []);
  assert.equal(await dispatch(h.handlers, h.ctx, { toolCallId: 'r1', toolName: 'read', input: { path: 'code.txt' } }), undefined);
  assert.equal(await dispatch(h.handlers, h.ctx, { toolCallId: 'b1', toolName: 'bash', input: { command: 'true' } }), undefined);
  await dispatch(h.handlers, h.ctx, { toolCallId: 'b2', toolName: 'bash', input: { command: 'false' }, details: { exitCode: 1 } });
  const s = await h.openJournal();
  assert.deepEqual(s.db.prepare('SELECT tool,is_effect,state FROM actions ORDER BY created').all().map(r => ({ ...r })),
    [{ tool: 'read', is_effect: 0, state: 'succeeded' }, { tool: 'bash', is_effect: 1, state: 'succeeded' }, { tool: 'bash', is_effect: 1, state: 'failed' }]);
  const state = JSON.parse(h.handlers.get('before_agent_start')({}, h.ctx).message.content);
  assert.deepEqual(state.usage, { toolCalls: 3, effects: 2 }); assert.equal(state.blockedUntilReconciled, false);
});
test('runtime tools chain evidence into checkpoint and memory candidate without remote writes', async t => {
  const h = await harness(t); await h.handlers.get('session_start')({}, h.ctx);
  const evidence = await h.tools.get('runtime_evidence').execute('e1', { path: 'code.txt', start: 1, end: 1 }, undefined, undefined, h.ctx);
  assert.ok(evidence.details.evidenceId); assert.equal(evidence.details.verified, true);
  await h.tools.get('runtime_checkpoint').execute('c1', { summary: '근거 확인 완료', nextAction: '구현', evidenceIds: [evidence.details.evidenceId] }, undefined, undefined, h.ctx);
  const candidate = await h.tools.get('runtime_memory_candidate').execute('m1', { kind: 'decision', title: '결정', content: '확장 우선 구조를 채택한다.', evidenceIds: [evidence.details.evidenceId] }, undefined, undefined, h.ctx);
  assert.equal(candidate.details.canonical, false);
  const status = (await h.tools.get('runtime_status').execute('s1', {}, undefined, undefined, h.ctx)).details;
  assert.equal(status.checkpoint.summary, '근거 확인 완료'); assert.equal(status.pendingMemory, 1);
  // Publishing needs a bound transport with server-enforced idempotency; none is bound, so it fails closed.
  await h.commands.get('runtime').handler(`publish ${candidate.details.candidateId}`, h.ctx);
  assert.match(h.ctx.notices.at(-1).message, /MEMORY_PORT_UNBOUND/);
});
test('/runtime pause blocks effects, resume restores; reconcile all clears uncertainty from a lapsed session', async t => {
  const h = await harness(t); await h.handlers.get('session_start')({}, h.ctx);
  await h.commands.get('runtime').handler('pause', h.ctx); assert.equal(h.ctx.aborted, true);
  assert.match((await dispatch(h.handlers, h.ctx, { toolCallId: 'b1', toolName: 'bash', input: { command: 'true' } })).reason, /RUNTIME_PAUSED/);
  await h.commands.get('runtime').handler('resume', h.ctx);
  assert.equal(await dispatch(h.handlers, h.ctx, { toolCallId: 'b2', toolName: 'bash', input: { command: 'true' } }), undefined);
  // Another process left an effect executing and never came back.
  const s = await h.openJournal(); const ghost = s.acquire(s.workspace(h.root).id, 'ghost', { ttl: 1000 });
  s.beginAction(ghost, { actionId: 'ghost-1', tool: 'bash', input: { command: 'deploy' }, isEffect: true });
  await new Promise(r => setTimeout(r, 1100));
  assert.match((await dispatch(h.handlers, h.ctx, { toolCallId: 'b3', toolName: 'bash', input: { command: 'true' } })).reason, /RECONCILIATION_REQUIRED/);
  await h.commands.get('runtime').handler('reconcile all', h.ctx);
  assert.equal(await dispatch(h.handlers, h.ctx, { toolCallId: 'b4', toolName: 'bash', input: { command: 'true' } }), undefined);
});
test('a host missing a required API member disables the runtime and lets tools run unless OMP_RUNTIME_REQUIRED=1', async t => {
  const relaxed = await harness(t, { omit: ['registerCommand'] });
  await relaxed.handlers.get('session_start')({}, relaxed.ctx);
  assert.match(relaxed.ctx.notices[0].message, /disabled: EXTENSION_CONTRACT_MISMATCH.*registerCommand/);
  assert.equal(relaxed.report().verdict, 'degraded');
  assert.equal(await relaxed.handlers.get('tool_call')({ toolCallId: 'x', toolName: 'bash', input: {} }, relaxed.ctx), undefined);
  const strict = await harness(t, { omit: ['registerCommand'], required: true });
  await strict.handlers.get('session_start')({}, strict.ctx);
  assert.match((await strict.handlers.get('tool_call')({ toolCallId: 'x', toolName: 'bash', input: {} }, strict.ctx)).reason, /RUNTIME_HANDLER_REQUIRED/);
});
test('operator config in the runtime dir is honoured and a broken one fails closed', async t => {
  const strict = await harness(t, { config: { headlessEffects: 'deny' }, hasUI: false });
  await strict.handlers.get('session_start')({}, strict.ctx);
  assert.match((await dispatch(strict.handlers, strict.ctx, { toolCallId: 'w1', toolName: 'write', input: { path: 'a.txt', content: 'x' } })).reason, /HEADLESS_EFFECT/);
  assert.equal(await dispatch(strict.handlers, strict.ctx, { toolCallId: 'r1', toolName: 'read', input: { path: 'code.txt' } }), undefined);
  const broken = await harness(t, { config: { mode: 'yolo' } });
  await broken.handlers.get('session_start')({}, broken.ctx);
  assert.match(broken.ctx.notices[0].message, /INVALID_RUNTIME_MODE/);
});
test('shutdown releases the lease so the same session can be resumed by the next process', async t => {
  const h = await harness(t); await h.handlers.get('session_start')({}, h.ctx);
  await h.handlers.get('session_shutdown')({}, h.ctx);
  const s = await h.openJournal(); assert.doesNotThrow(() => s.acquire(s.workspace(h.root).id, 'mock-session'));
  assert.deepEqual(readdirSync(h.layout.compat), ['18.1.10.json']);
});
