import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { fixture, call, run, action } from './helpers.mjs';

const T = {
  recall: 'mcp__gbrain_recall', entity: 'mcp__gbrain_entity', pack: 'mcp__gbrain_context_pack',
  synthesize: 'mcp__gbrain_synthesize', remember: 'mcp__gbrain_remember'
};
const config = {
  memoryReadTools: [T.recall, T.entity, T.pack, T.synthesize], memoryWriteTools: [T.remember],
  recall: { mode: 'require', tools: [T.recall, T.entity, T.pack] }
};
const mem = (id, toolName, input = { query: 'q' }) => call({ toolCallId: id, toolName, input });
const bash = id => call({ toolCallId: id });

test('the first effect of a goal runs only after a recall settled in an earlier turn; same-turn intents prove nothing', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, call({ toolCallId: 'r0', toolName: 'read', input: { path: 'source.txt' } })), undefined, 'reads never wait');
  const recall = mem('q1', T.recall);
  assert.equal(await f.kernel.intent(recall), undefined);
  assert.match((await f.kernel.intent(bash('b1'))).reason, /RECALL_REQUIRED/, 'a parallel effect in the same message is refused');
  for (const phase of ['result', 'end']) f.kernel.settle('q1', T.recall, { result: { content: [{ type: 'text', text: '{"total": 0, "facts": []}' }] }, isError: false, phase });
  assert.match((await f.kernel.intent(bash('b2'))).reason, /settles this turn/, 'settled, but not yet visible to the model');
  assert.equal(f.kernel.context().recall.state, 'settling');
  f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b3')), undefined); assert.equal(action(f, bash('b3')).state, 'succeeded');
  assert.equal(f.kernel.context().recall.state, 'done');
});
test('a failed recall settles the gate; a canonical-memory read outside recall.tools does not', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('s1', T.synthesize, { question: 'what is x' })); f.kernel.turnStart();
  assert.match((await f.kernel.intent(bash('b1'))).reason, /RECALL_REQUIRED/);
  await run(f.kernel, mem('q1', T.recall), { isError: true }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b2')), undefined, 'an unreachable backend does not stop work');
  assert.equal(f.kernel.context().recall.state, 'failed');
});
test('a goal that cannot recall opens the gate itself after three refusals, and says so', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  for (let i = 0; i < 2; i++) { assert.match((await f.kernel.intent(bash(`b${i}`))).reason, /RECALL_REQUIRED/); f.kernel.turnStart(); }
  assert.equal(f.kernel.context().recall.state, 'pending');
  assert.equal(await run(f.kernel, bash('b3')), undefined, 'the third attempt runs: the procedure is never a dead end');
  assert.equal(f.kernel.context().recall.state, 'forced');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'recall.forced').length, 1);
});
test('a settled recall resets the strikes, so the gate keeps asking on the next goal', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  assert.match((await f.kernel.intent(bash('b0'))).reason, /RECALL_REQUIRED/);
  await run(f.kernel, mem('q1', T.recall)); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b1')), undefined);
  assert.equal(f.kernel.context().recall.state, 'done');
  f.store.mirrorGoal(f.lease, { id: 'goal-2', status: 'active' });
  assert.match((await f.kernel.intent(bash('b2'))).reason, /RECALL_REQUIRED/, 'the new goal starts with a fresh count');
});
test('a recall tool the session does not have opens the gate on the attempt itself', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  const wrapper = call({ toolCallId: 'w1', toolName: 'write', input: { path: `xd://${T.recall}`, content: JSON.stringify({ query: 'q' }) } });
  await run(f.kernel, wrapper, { isError: true, text: `No such tool: xd://${T.recall}. Mounted devices: lsp` });
  assert.equal(f.kernel.context().recall.state, 'settling');
  f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b1')), undefined, 'the environment answered: there is no such tool');
  assert.equal(f.kernel.context().recall.state, 'unavailable');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'recall.unavailable').length, 1);
});
test('a new goal requires its own recall', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.recall)); f.kernel.turnStart(); assert.equal(await run(f.kernel, bash('b1')), undefined);
  f.store.mirrorGoal(f.lease, { id: 'goal-2', status: 'active' });
  assert.match((await f.kernel.intent(bash('b2'))).reason, /RECALL_REQUIRED/);
  await run(f.kernel, mem('q2', T.recall)); f.kernel.turnStart(); assert.equal(await run(f.kernel, bash('b3')), undefined);
});
test('a resumed session recalls again: the gate is per goal, and a new epoch has none of the old settles', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.recall)); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b1')), undefined);
  f.store.release(f.lease);
  const lease = f.store.acquire(f.workspace.id, 'session'); assert.equal(lease.epoch, 2);
  const k = new RuntimeKernel({ store: f.store, lease, root: f.root, config }); k.turnStart();
  assert.match((await k.intent(bash('b2'))).reason, /RECALL_REQUIRED/, 'the previous epoch proves nothing');
  await run(k, mem('q2', T.recall)); k.turnStart();
  assert.equal(await run(k, bash('b3')), undefined);
});
test('a dispatched recall satisfies the gate; the xd:// envelope is not itself an effect', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  const wrapper = call({ toolCallId: 'w1', toolName: 'write', input: { path: `xd://${T.recall}`, content: JSON.stringify({ query: 'q' }) } });
  assert.equal(await run(f.kernel, wrapper), undefined, 'the envelope dispatches a read, so the gate cannot hold it');
  assert.equal(action(f, wrapper).is_effect, 0);
  await run(f.kernel, mem('w1', T.recall)); // the nested dispatch reuses the outer toolCallId
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
  const f = await fixture(t, { config: { ...config, recall: { mode: 'advise', tools: [T.recall] } } }); f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('b1')), undefined); assert.equal(f.kernel.context().recall.state, 'pending');
});
test('a corpus-wide recall that was never followed by an entity read is journaled as shallow', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  await run(f.kernel, mem('q1', T.recall), { text: '{"total": 3, "facts": [{"fact": "a"}]}' }); f.kernel.turnStart();
  await run(f.kernel, bash('b1'));
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'recall.shallow').length, 1); assert.equal(f.kernel.context().recall.hits, 3);
  const g = await fixture(t, { config }); g.kernel.turnStart();
  await run(g.kernel, mem('q1', T.recall), { text: '{"total": 3}' });
  await run(g.kernel, mem('e1', T.entity, { entity: 'concepts/x' })); g.kernel.turnStart();
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

test('three effects in one message are three refusals, not three attempts: the strike is per turn', async t => {
  const f = await fixture(t, { config }); f.kernel.turnStart();
  for (const id of ['p1', 'p2', 'p3']) assert.match((await f.kernel.intent(bash(id))).reason, /RECALL_REQUIRED/);
  assert.equal(f.kernel.context().recall.state, 'pending', 'parallel calls in one message cannot open the gate');
  f.kernel.turnStart(); assert.match((await f.kernel.intent(bash('p4'))).reason, /RECALL_REQUIRED/);
  f.kernel.turnStart();
  assert.equal(await run(f.kernel, bash('p5')), undefined, 'three turns of refusals do open it');
  assert.equal(f.kernel.context().recall.state, 'forced');
});
