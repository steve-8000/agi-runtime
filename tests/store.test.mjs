import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStore } from '../src/store.mjs';
import { fixture, call, run, action, code } from './helpers.mjs';

test('one session cannot be driven by two live processes', async t => {
  const f = await fixture(t); const second = await RuntimeStore.open(f.dbPath, { now: f.now }); f.stores.push(second);
  assert.throws(() => second.acquire(f.workspace.id, 'session'), code('SESSION_WRITER_BUSY'));
});
test('parallel sessions share one workspace journal without fencing each other', async t => {
  const f = await fixture(t); const other = await f.sibling('terminal-2');
  assert.equal((await run(f.kernel, call())), undefined);
  assert.equal((await run(other.kernel, call({ toolCallId: 'o1' }))), undefined);
  assert.equal(action(f, call()).state, 'succeeded'); assert.equal(action(f, call({ toolCallId: 'o1' }), other.kernel).state, 'succeeded');
});
test('a live sibling mid-effect is not swept; a lapsed one becomes unknown and blocks new effects', async t => {
  const f = await fixture(t); const other = await f.sibling('terminal-2');
  await other.kernel.intent(call({ toolCallId: 'o1' }));           // executing, lease alive
  assert.equal((await f.kernel.intent(call())), undefined);        // still allowed
  f.lapse();                                                       // sibling process died without heartbeat
  const blocked = await f.kernel.intent(call({ toolCallId: 'c2' }));
  assert.match(blocked.reason, /RECONCILIATION_REQUIRED/);
  assert.equal(f.store.unknownActions(f.workspace.id).length, 1);
  assert.throws(() => other.store.heartbeat(other.lease), code('FENCED_WRITER'));
});
test('reads keep working while an effect awaits reconciliation', async t => {
  const f = await fixture(t); const other = await f.sibling('terminal-2');
  await other.kernel.intent(call({ toolCallId: 'o1' })); f.lapse();
  assert.equal(await f.kernel.intent(call({ toolCallId: 'r1', toolName: 'grep', input: { pattern: 'x' } })), undefined);
});
test('interrupted reads are failures, never uncertain effects', async t => {
  const f = await fixture(t);
  await f.kernel.intent(call({ toolName: 'grep', input: { pattern: 'x' } }));
  f.advance(30001); const next = await f.sibling('later');
  await next.kernel.intent(call({ toolCallId: 'n1', toolName: 'grep', input: { pattern: 'y' } }));
  assert.deepEqual(f.store.unknownActions(f.workspace.id), []);
  assert.equal(action(f, call({ toolName: 'grep' })).state, 'failed');
});
test('resuming a session after a crash fences the old lease and keeps its budget usage', async t => {
  const f = await fixture(t); await run(f.kernel, call()); f.store.close(); f.advance(30001);
  const reopened = await RuntimeStore.open(f.dbPath, { now: f.now }); f.stores.push(reopened);
  const lease = reopened.acquire(f.workspace.id, 'session');
  assert.equal(lease.epoch, 2); assert.equal(reopened.sessionRow('session').tool_calls, 1);
  assert.throws(() => reopened.heartbeat(f.lease), code('FENCED_WRITER'));
});
test('duplicate tool dispatch is rejected after success', async t => {
  const f = await fixture(t); await run(f.kernel, call());
  assert.match((await f.kernel.intent(call())).reason, /DUPLICATE_ACTION/);
});
test('effect budget is reserved transactionally and persists', async t => {
  const f = await fixture(t, { config: { maxEffects: 1 } });
  const outcomes = await Promise.all([f.kernel.intent(call()), f.kernel.intent(call({ toolCallId: '2' }))]);
  assert.equal(outcomes.filter(x => x === undefined).length, 1);
  assert.match(outcomes.find(x => x?.block).reason, /EFFECT_BUDGET_EXHAUSTED/);
  assert.equal(f.kernel.context().effectsUsed, 1);
});
test('tool-call budget also bounds read-only loops', async t => {
  const f = await fixture(t, { config: { maxToolCalls: 1 } });
  await f.kernel.intent(call({ toolName: 'grep' }));
  assert.match((await f.kernel.intent(call({ toolName: 'grep', toolCallId: '2' }))).reason, /TOOL_BUDGET_EXHAUSTED/);
});
test('wall budget is checked before dispatch', async t => {
  const f = await fixture(t, { config: { maxWallMs: 10 } }); f.advance(11);
  assert.match((await f.kernel.intent(call({ toolName: 'grep' }))).reason, /WALL_BUDGET_EXHAUSTED/);
});
test('observe mode journals and counts but never blocks on budget or reconciliation', async t => {
  const f = await fixture(t, { config: { mode: 'observe', maxEffects: 1 } });
  await run(f.kernel, call()); assert.equal(await f.kernel.intent(call({ toolCallId: '2' })), undefined);
  assert.equal(f.kernel.context().effectsUsed, 2); assert.equal(f.kernel.context().blockedUntilReconciled, false);
});
test('blockOnUnknown=false records uncertainty without halting effects', async t => {
  const f = await fixture(t, { config: { blockOnUnknown: false } }); const other = await f.sibling('t2', { config: { blockOnUnknown: false } });
  await other.kernel.intent(call({ toolCallId: 'o1' })); f.lapse();
  assert.equal(await f.kernel.intent(call({ toolCallId: 'c2' })), undefined);
  assert.equal(f.store.unknownActions(f.workspace.id).length, 1);
});
test('pause is workspace-wide and survives new sessions', async t => {
  const f = await fixture(t); f.kernel.paused = true;
  const other = await f.sibling('terminal-2');
  assert.match((await other.kernel.intent(call({ toolCallId: 'o1' }))).reason, /RUNTIME_PAUSED/);
  assert.equal(await other.kernel.intent(call({ toolCallId: 'o2', toolName: 'read', input: { path: 'source.txt' } })), undefined);
});
test('approval is exact-input scoped and single use', async t => {
  const f = await fixture(t); const approval = f.store.approve(f.lease, 'original');
  assert.throws(() => f.store.consumeApproval(f.lease, approval, 'changed'), code('INVALID_APPROVAL'));
  f.store.consumeApproval(f.lease, approval, 'original');
  assert.throws(() => f.store.consumeApproval(f.lease, approval, 'original'), code('INVALID_APPROVAL'));
});
test('expired approval is rejected', async t => {
  const f = await fixture(t); const approval = f.store.approve(f.lease, 'input', 5); f.advance(6);
  assert.throws(() => f.store.consumeApproval(f.lease, approval, 'input'), code('INVALID_APPROVAL'));
});
test('approval does not survive a session epoch change', async t => {
  const f = await fixture(t); const approval = f.store.approve(f.lease, 'input');
  f.store.release(f.lease); const next = f.store.acquire(f.workspace.id, 'session');
  assert.throws(() => f.store.consumeApproval(next, approval, 'input'), code('INVALID_APPROVAL'));
});
test('evidence cannot cross workspace scope', async t => {
  const f = await fixture(t); const evidence = f.evidence();
  assert.throws(() => f.store.assertEvidence('another-workspace', [evidence]), code('EVIDENCE_SCOPE_MISMATCH'));
});
test('nonzero exit and tool errors are observed failures, not successes and not uncertainty', async t => {
  const f = await fixture(t);
  await run(f.kernel, call(), { exitCode: 1 }); assert.equal(action(f, call()).state, 'failed');
  await run(f.kernel, call({ toolCallId: '2' }), { isError: true }); assert.equal(action(f, call({ toolCallId: '2' })).state, 'failed');
  assert.deepEqual(f.store.unknownActions(f.workspace.id), []);
});
test('a revised execution input replaces the intent hash and is journaled', async t => {
  const f = await fixture(t); const c = call();
  await f.kernel.intent(c); f.kernel.revise(c.toolCallId, c.toolName, { command: 'printf revised' });
  assert.equal(f.kernel.counters.revisions, 1);
  assert.equal(f.store.events(f.workspace.id).some(e => e.kind === 'action.revised'), true);
});
test('a middleware rewrite of isError after settlement is journaled, not trusted', async t => {
  const f = await fixture(t); const c = call(); await f.kernel.intent(c);
  const result = { content: [], details: { exitCode: 0 } };
  f.kernel.settle(c.toolCallId, c.toolName, { result, isError: true, phase: 'result' });
  f.kernel.settle(c.toolCallId, c.toolName, { result, isError: false, phase: 'end' });
  assert.equal(action(f, c).state, 'failed'); assert.equal(f.kernel.counters.rewrites, 1);
});
test('goal state is a persistent mirror, not a second goal engine', async t => {
  const f = await fixture(t); f.store.mirrorGoal(f.lease, { id: 'native-123', status: 'active', objective: '목표' });
  assert.equal(f.kernel.context().nativeGoal.id, 'native-123');
});
test('reconciliation needs an uncertain action; stale evidence is the caller\'s check, scope is ours', async t => {
  const f = await fixture(t); const other = await f.sibling('t2');
  const c = call({ toolCallId: 'o1' }); await other.kernel.intent(c); f.lapse(); f.store.sweep(f.workspace.id);
  const id = action(f, c, other.kernel).id;
  assert.throws(() => f.store.reconcile(f.lease, id, ['nope']), code('EVIDENCE_SCOPE_MISMATCH'));
  assert.throws(() => f.store.reconcile(f.lease, 'missing'), code('ACTION_STATE_CONFLICT'));
  f.store.reconcile(f.lease, id); assert.equal(f.store.unknownActions(f.workspace.id).length, 0);
  assert.doesNotThrow(() => f.store.renewBudget(f.lease));
});
test('budget renewal is refused while uncertainty is unresolved', async t => {
  const f = await fixture(t); const other = await f.sibling('t2');
  await other.kernel.intent(call({ toolCallId: 'o1' })); f.lapse(); f.store.sweep(f.workspace.id);
  assert.throws(() => f.store.renewBudget(f.lease), code('RECONCILIATION_REQUIRED'));
});
test('unsupported journal schema is refused rather than migrated blindly', async t => {
  const f = await fixture(t); f.store.db.exec('PRAGMA user_version=7'); f.store.close();
  await assert.rejects(RuntimeStore.open(f.dbPath, { now: f.now }), code('UNSUPPORTED_SCHEMA'));
});
