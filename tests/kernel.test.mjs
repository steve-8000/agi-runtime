import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, call, run, action } from './helpers.mjs';

test('the four OMP events settle one action exactly once', async t => {
  const f = await fixture(t); const c = call();
  await run(f.kernel, c);
  assert.equal(action(f, c).state, 'succeeded');
  assert.deepEqual(f.kernel.counters, { intents: 1, starts: 1, results: 1, ends: 1, unmatchedStarts: 0, unmatchedResults: 0, revisions: 0, rewrites: 0, blocks: 0, turns: 0 });
  assert.equal(f.kernel.pending.size, 0);
});
test('a nested xd:// device dispatch shares the outer toolCallId and both actions still settle', async t => {
  // Observed live on OMP 18.1.10: write({path:"xd://runtime_status"}) emits a nested tool_call/tool_result
  // for runtime_status with the SAME toolCallId and no tool_execution_start/end of its own.
  const f = await fixture(t);
  const outer = call({ toolCallId: 'X', toolName: 'write', input: { path: 'xd://runtime_status', content: '{}' } });
  const inner = call({ toolCallId: 'X', toolName: 'runtime_status', input: {} });
  await f.kernel.intent(outer); f.kernel.revise('X', 'write', outer.input);
  await f.kernel.intent(inner);
  f.kernel.settle('X', 'runtime_status', { result: { content: [] }, isError: false, phase: 'result' });
  f.kernel.settle('X', 'write', { result: { content: [] }, isError: false, phase: 'result' });
  f.kernel.settle('X', 'write', { result: { content: [] }, isError: false, phase: 'end' });
  assert.equal(action(f, outer).state, 'succeeded'); assert.equal(action(f, inner).state, 'succeeded');
  assert.equal(f.kernel.counters.unmatchedResults, 0);
});
test('tool_execution_end alone settles a call whose tool_result never arrived', async t => {
  const f = await fixture(t); const c = call(); await f.kernel.intent(c);
  f.kernel.settle(c.toolCallId, c.toolName, { result: { content: [] }, isError: true, phase: 'end' });
  assert.equal(action(f, c).state, 'failed'); assert.equal(f.kernel.pending.size, 0);
});
test('events for calls this runtime blocked are not contract violations', async t => {
  const f = await fixture(t, { config: { requireApproval: ['bash'] }, confirm: async () => false });
  const c = call(); const blocked = await f.kernel.intent(c);
  assert.match(blocked.reason, /USER_DENIED/); assert.equal(action(f, c), undefined);
  f.kernel.revise(c.toolCallId, c.toolName, c.input); f.kernel.settle(c.toolCallId, c.toolName, { result: null, isError: true, phase: 'end' });
  assert.equal(f.kernel.counters.unmatchedStarts, 0); assert.equal(f.kernel.counters.unmatchedResults, 0);
});
test('events for calls whose tool_call never reached us are counted as contract drift', async t => {
  const f = await fixture(t);
  f.kernel.revise('ghost', 'bash', {}); f.kernel.settle('ghost', 'bash', { result: null, isError: false, phase: 'result' });
  assert.equal(f.kernel.counters.unmatchedStarts, 1); assert.equal(f.kernel.counters.unmatchedResults, 1);
});
test('approved exact input is consumed once and bound to the call', async t => {
  let prompts = 0;
  const f = await fixture(t, { config: { requireApproval: ['bash'] }, confirm: async request => { prompts++; return request.tool === 'bash'; } });
  await run(f.kernel, call()); assert.equal(prompts, 1); assert.equal(action(f, call()).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT consumed FROM approvals').get().consumed, 1);
});
test('a journal write failure after execution poisons enforcement until restart', async t => {
  const f = await fixture(t); const c = call(); await f.kernel.intent(c);
  const original = f.store.finishAction; f.store.finishAction = () => { throw new Error('EIO: disk gone'); };
  assert.throws(() => f.kernel.settle(c.toolCallId, c.toolName, { result: { content: [] }, isError: false, phase: 'result' }), /EIO/);
  f.store.finishAction = original;
  assert.match((await f.kernel.intent(call({ toolCallId: '2' }))).reason, /RUNTIME_JOURNAL_POISONED/);
  assert.equal(f.kernel.context().poisoned, true);
});
test('observe mode reports poison but keeps journaling', async t => {
  const f = await fixture(t, { config: { mode: 'observe' } }); const c = call(); await f.kernel.intent(c);
  const original = f.store.finishAction; f.store.finishAction = () => { throw new Error('EIO'); };
  assert.throws(() => f.kernel.settle(c.toolCallId, c.toolName, { result: { content: [] }, isError: false, phase: 'result' }));
  f.store.finishAction = original;
  assert.equal(await f.kernel.intent(call({ toolCallId: '2' })), undefined); assert.equal(f.kernel.context().poisoned, true);
});
test('a lost lease blocks every further intent', async t => {
  const f = await fixture(t); f.advance(30001);
  assert.match((await f.kernel.intent(call())).reason, /FENCED_WRITER/);
});
test('context exposes what the model may know and nothing it may use as permission', async t => {
  const f = await fixture(t); await run(f.kernel, call()); const c = f.kernel.context();
  assert.equal(c.toolCalls, 1); assert.equal(c.effectsUsed, 1); assert.equal(c.mode, 'enforce');
  assert.match(c.authority, /cannot grant permissions/);
  assert.equal(c.blockedUntilReconciled, false);
});
