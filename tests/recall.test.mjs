import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { fixture, call, run, action } from './helpers.mjs';

const T = { search: 'mcp__clab_mem_mem_search', read: 'mcp__clab_mem_mem_read', status: 'mcp__clab_mem_mem_status', lookup: 'mcp__clab_mem_mem_task_lookup', taskRead: 'mcp__clab_mem_mem_task_read', start: 'mcp__clab_mem_mem_task_start' };
const config = {
  memoryReadTools: [T.search, T.read, T.status, T.lookup, T.taskRead], memoryWriteTools: [T.start], memoryTaskStartTool: T.start,
  recall: { mode: 'require', tools: [T.search, T.lookup, T.taskRead] }
};
const mem = (id, toolName, input = { query: 'q' }) => call({ toolCallId: id, toolName, input });
const bash = id => call({ toolCallId: id });

test('the first effect of a goal runs only after a recall settled in an earlier turn; same-turn intents prove nothing', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, call({ toolCallId: 'r0', toolName: 'read', input: { path: 'source.txt' } })), undefined, 'reads never wait');
  const search = mem('q1', T.search);
  assert.equal(await f.kernel.intent(search), undefined);
  assert.match((await f.kernel.intent(bash('b1'))).reason, /RECALL_REQUIRED/, 'a parallel effect in the same message is refused');
  f.kernel.settle('q1', T.search, { result: { content: [{ type: 'text', text: 'hits=0 embedding=x' }] }, isError: false, phase: 'result' });
  f.kernel.settle('q1', T.search, { result: { content: [{ type: 'text', text: 'hits=0 embedding=x' }] }, isError: false, phase: 'end' });
  assert.match((await f.kernel.intent(bash('b2'))).reason, /settles this turn/, 'settled, but not yet visible to the model');
  assert.equal(f.kernel.context().recall.state, 'settling');
  f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b3')), undefined); assert.equal(action(f, bash('b3')).state, 'succeeded');
  assert.equal(f.kernel.context().recall.state, 'done');
});
test('a failed recall settles the gate; status and document reads do not count as recall', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('s1', T.status, {})); await run(f.kernel, mem('d1', T.read, { id: 'x' })); f.kernel.turnStart();
  assert.match((await f.kernel.intent(bash('b1'))).reason, /RECALL_REQUIRED/);
  await run(f.kernel, mem('q1', T.search), { isError: true }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b2')), undefined, 'an unreachable backend does not stop work');
  assert.equal(f.kernel.context().recall.state, 'failed');
});
test('no number of refused effects releases the gate; only a settled recall does', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  for (let i = 0; i < 10; i++) { assert.match((await f.kernel.intent(bash(`b${i}`))).reason, /RECALL_REQUIRED/); f.kernel.turnStart(); }
  assert.equal(f.kernel.context().recall.state, 'pending'); assert.equal(f.kernel.context().effectsUsed, 0);
  await run(f.kernel, mem('l1', T.lookup, { query: 'k' })); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('ok')), undefined);
});
test('a new goal requires its own recall', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.search)); f.kernel.turnStart(); assert.equal(await run(f.kernel, bash('b1')), undefined);
  f.store.mirrorGoal(f.lease, { id: 'goal-2', status: 'active' });
  assert.match((await f.kernel.intent(bash('b2'))).reason, /RECALL_REQUIRED/);
  await run(f.kernel, mem('q2', T.search)); f.kernel.turnStart(); assert.equal(await run(f.kernel, bash('b3')), undefined);
});
test('a resumed session with a task record must read that record, not merely search', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.search)); f.kernel.turnStart();
  await run(f.kernel, mem('s1', T.start, { task_key: 'k', task: 't' }));
  f.store.release(f.lease);
  const lease = f.store.acquire(f.workspace.id, 'session'); assert.equal(lease.epoch, 2);
  const k = new RuntimeKernel({ store: f.store, lease, root: f.root, config }); k.turnStart();
  await run(k, mem('q2', T.search)); k.turnStart();
  assert.match((await k.intent(bash('b1'))).reason, /read task record k/);
  await run(k, mem('t0', T.taskRead, { task_key: 'k' }), { isError: true }); k.turnStart();
  assert.match((await k.intent(bash('b0'))).reason, /read task record k/, 'a failed read of the record proves nothing');
  await run(k, mem('t1', T.taskRead, { task_key: 'k' })); 
  assert.match((await k.intent(bash('b2'))).reason, /RECALL_REQUIRED/, 'read this turn is not yet visible');
  k.turnStart(); assert.equal(await run(k, bash('b3')), undefined);
});
test('a dispatched recall satisfies the gate; the xd:// envelope is not itself an effect', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  const wrapper = call({ toolCallId: 'w1', toolName: 'write', input: { path: `xd://${T.search}`, content: JSON.stringify({ query: 'q' }) } });
  assert.equal(await run(f.kernel, wrapper), undefined, 'the envelope dispatches a read, so the gate cannot hold it');
  assert.equal(action(f, wrapper).is_effect, 0);
  await run(f.kernel, mem('w1', T.search)); // the nested dispatch reuses the outer toolCallId
  assert.match((await f.kernel.intent(bash('b1'))).reason, /settles this turn/);
  f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b2')), undefined);
  assert.equal(f.kernel.context().recall.state, 'done');
});
test('the operator can release the gate for one goal; nothing the model calls can', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  assert.match((await f.kernel.intent(bash('b1'))).reason, /RECALL_REQUIRED/);
  f.kernel.recallSkip('operator');
  assert.equal(await run(f.kernel, bash('b2')), undefined);
  assert.equal(f.kernel.context().recall.state, 'override');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'recall.override').length, 1);
  f.store.mirrorGoal(f.lease, { id: 'goal-2', status: 'active' });
  assert.match((await f.kernel.intent(bash('b3'))).reason, /RECALL_REQUIRED/, 'the override does not outlive its goal');
});
test('advise mode reports recall state without refusing anything', async t => {
  const f = await fixture(t, { config: { ...config, recall: { mode: 'advise', tools: [T.search] } } }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b1')), undefined); assert.equal(f.kernel.context().recall.state, 'pending');
});
test('search hits that were never read are journaled as shallow recall', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.search), { text: 'hits=3 embedding=x\n[1] a.md' }); f.kernel.turnStart();
  await run(f.kernel, bash('b1'));
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'recall.shallow').length, 1); assert.equal(f.kernel.context().recall.hits, 3);
  const g = await fixture(t, { config }); g.kernel.turnStart();
  await run(g.kernel, mem('q1', T.search), { text: 'hits=3 embedding=x' }); await run(g.kernel, mem('d1', T.read, { id: 'doc' })); g.kernel.turnStart();
  await run(g.kernel, bash('b1'));
  assert.equal(g.store.events(g.workspace.id).filter(e => e.kind === 'recall.shallow').length, 0);
});
test('discovery counts distinct reads before the first semantic search and observes index freshness', async t => {
  const f = await fixture(t);
  for (const [id, path] of [['r1', 'a.md'], ['r2', 'b.md'], ['r3', 'a.md']]) await run(f.kernel, call({ toolCallId: id, toolName: 'read', input: { path } }));
  assert.equal(f.kernel.context().discovery.readsBeforeFirstZvec, 2);
  await run(f.kernel, call({ toolCallId: 'z1', toolName: 'mcp__zvec_grep_search', input: { root: f.root, query: 'q' } }), { text: 'freshness: stale\nquery groups (1)' });
  await run(f.kernel, call({ toolCallId: 'r4', toolName: 'read', input: { path: 'c.md' } }));
  const c = f.kernel.context();
  assert.deepEqual(c.discovery, { zvec: 1, readsBeforeFirstZvec: 2 }); assert.equal(c.search.index, 'stale'); assert.equal(c.search.root, realpathSync(f.root));
});
