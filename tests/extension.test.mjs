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
  assert.equal(h.pi.label, 'AGI Runtime'); assert.equal(h.tools.size, 5); assert.ok(h.commands.has('runtime'));
  for (const event of ['turn_start', 'agent_end', 'session_compact', 'auto_compaction_end']) assert.ok(h.handlers.has(event), event);
  assert.equal(h.handlers.has('session_stop'), false, 'the runtime never continues or blocks a stop');
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
  assert.equal(state.search.semanticDiscovery, 'mcp__zvec_grep_search');
});
test('runtime tools chain evidence into checkpoint and memory candidate without remote writes', async t => {
  const h = await harness(t); await h.handlers.get('session_start')({}, h.ctx);
  const evidence = await h.tools.get('runtime_evidence').execute('e1', { path: 'code.txt', start: 1, end: 1 }, undefined, undefined, h.ctx);
  assert.ok(evidence.details.evidenceId); assert.equal(evidence.details.verified, true);
  await h.tools.get('runtime_checkpoint').execute('c1', { summary: '근거 확인 완료', nextAction: '구현', evidenceIds: [evidence.details.evidenceId] }, undefined, undefined, h.ctx);
  const candidate = await h.tools.get('runtime_memory_candidate').execute('m1', { kind: 'decision', title: '결정', content: '확장 우선 구조를 채택한다.', evidenceIds: [evidence.details.evidenceId] }, undefined, undefined, h.ctx);
  assert.equal(candidate.details.canonical, false); assert.equal(candidate.details.publishWith, null);
  const status = (await h.tools.get('runtime_status').execute('s1', {}, undefined, undefined, h.ctx)).details;
  assert.equal(status.checkpoint.summary, '근거 확인 완료'); assert.equal(status.pendingMemory, 1);
  // No publish command exists any more: the model is the transport, and nothing here talks to a remote.
  await h.commands.get('runtime').handler(`publish ${candidate.details.candidateId}`, h.ctx);
  assert.match(h.ctx.notices.at(-1).message, /UNKNOWN_RUNTIME_COMMAND/);
  const s = await h.openJournal(); assert.equal(s.outbox(candidate.details.candidateId).state, 'candidate');
});
test('runtime_reconcile passes the boundary while a workspace unknown and the recall gate hold effects, and journals who attested', async t => {
  const memory = 'mcp__clab_mem_mem_search';
  const h = await harness(t, { config: { memoryReadTools: [memory], recall: { mode: 'require', tools: [memory] } } }); await h.handlers.get('session_start')({}, h.ctx);
  const s = await h.openJournal(); const ghost = s.acquire(s.workspace(h.root).id, 'ghost', { ttl: 1000 });
  s.beginAction(ghost, { actionId: 'ghost-1', tool: 'bash', input: { command: 'deploy' } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  h.handlers.get('before_agent_start')({}, h.ctx);
  assert.match((await dispatch(h.handlers, h.ctx, { toolCallId: 'b1', toolName: 'bash', input: { command: 'true' } })).reason, /RECALL_REQUIRED|RECONCILIATION_REQUIRED/);
  // The model's call arrives as tool_call first: a session write, so neither the unknown it resolves nor the recall gate holds it.
  const input = { actionIds: ['ghost-1'], observed: 'git status clean; deploy did not run', evidenceIds: [] };
  assert.equal(await h.handlers.get('tool_call')({ type: 'tool_call', toolCallId: 'rc', toolName: 'runtime_reconcile', input }, h.ctx), undefined);
  const result = await h.tools.get('runtime_reconcile').execute('rc', input, undefined, undefined, h.ctx);
  await h.handlers.get('tool_result')({ type: 'tool_result', toolCallId: 'rc', toolName: 'runtime_reconcile', input, content: result.content, details: result.details, isError: false }, h.ctx);
  await h.handlers.get('tool_execution_end')({ type: 'tool_execution_end', toolCallId: 'rc', toolName: 'runtime_reconcile', result, isError: false }, h.ctx);
  assert.deepEqual(result.details, { reconciled: ['ghost-1'], remaining: 0 });
  assert.deepEqual(s.db.prepare("SELECT tool,is_effect,state FROM actions WHERE tool='runtime_reconcile'").all().map(r => ({ ...r })), [{ tool: 'runtime_reconcile', is_effect: 0, state: 'succeeded' }]);
  const attested = s.events(s.workspace(h.root).id).find(e => e.kind === 'action.reconciled');
  assert.equal(attested.payload.by, 'session'); assert.match(attested.payload.observed, /git status clean/);
  await dispatch(h.handlers, h.ctx, { toolCallId: 'q1', toolName: memory, input: { query: 'deploy' } }); h.handlers.get('before_agent_start')({}, h.ctx);
  assert.equal(await dispatch(h.handlers, h.ctx, { toolCallId: 'b2', toolName: 'bash', input: { command: 'true' } }), undefined);
});
test('agent_end only notifies about unrecorded effects, and a re-attach hands the model one resume card of journal facts', async t => {
  const h = await harness(t); await h.handlers.get('session_start')({}, h.ctx);
  const state = () => JSON.parse(h.handlers.get('before_agent_start')({}, h.ctx).message.content);
  assert.equal(state().resume, undefined, 'a fresh session has nothing to resume');
  await dispatch(h.handlers, h.ctx, { toolCallId: 'b1', toolName: 'bash', input: { command: 'true' } });
  const before = h.ctx.notices.length; await h.handlers.get('agent_end')({}, h.ctx);
  assert.match(h.ctx.notices.at(-1).message, /effects 1 since the last memory note/); assert.equal(h.ctx.notices.length, before + 1);
  assert.equal(state().memory.effectsSinceNote, 1);
  await h.handlers.get('session_switch')({}, h.ctx);
  const card = state().resume;
  assert.equal(card.epoch, 2); assert.equal(card.effectsSinceNote, 1); assert.deepEqual(card.recent.map(x => [x.tool, x.state]), [['bash', 'succeeded']]);
  assert.equal(state().resume, undefined, 'the card is delivered once');
  await h.handlers.get('session_compact')({}, h.ctx); assert.ok(state().resume, 'and again after a compaction');
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
