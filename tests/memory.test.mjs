import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt, verifyReceipt } from '../src/memory.mjs';
import { RuntimeStore } from '../src/store.mjs';
import { openDatabase } from '../src/sqlite.mjs';
import { fixture, call, run, action, code } from './helpers.mjs';

const T = {
  search: 'mcp__clab_mem_mem_search', read: 'mcp__clab_mem_mem_read', status: 'mcp__clab_mem_mem_status', lookup: 'mcp__clab_mem_mem_task_lookup',
  taskRead: 'mcp__clab_mem_mem_task_read', start: 'mcp__clab_mem_mem_task_start', note: 'mcp__clab_mem_mem_task_note',
  complete: 'mcp__clab_mem_mem_task_complete', supersede: 'mcp__clab_mem_mem_supersede', publish: 'mcp__clab_mem_mem_publish'
};
const keys = generateKeyPairSync('ed25519');
const publicHex = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
const other = generateKeyPairSync('ed25519');
/** A receipt line exactly as the clab-mem server would print it, signed by `privateKey`. */
function receipt(fields, privateKey = keys.privateKey) {
  const message = `receipt ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  return `${message} sig=${sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url')}\n본문`;
}
const memoryConfig = (overrides = {}) => ({
  memoryReadTools: [T.search, T.read, T.status, T.lookup, T.taskRead], memoryWriteTools: [T.start, T.note, T.complete, T.supersede],
  memoryTaskStartTool: T.start, memoryPublishTool: T.publish, memoryReceiptPublicKey: publicHex, ...overrides
});
const mem = (id, toolName, input) => call({ toolCallId: id, toolName, input });
async function staged(f) {
  const candidateId = f.candidate(); const row = f.store.outbox(candidateId); const payload = JSON.parse(row.payload);
  const input = { candidate_id: candidateId, idempotency_key: candidateId, payload_hash: row.payload_hash, kind: payload.kind, title: payload.title, content: payload.content, evidence_ids: payload.evidenceIds };
  return { candidateId, row, input };
}

test('receipt lines parse strictly and verify only under the configured key', () => {
  const line = receipt({ outcome: 'committed', key: 'k', idem: 'i', sha: 's', doc: 'd', at: 't' });
  const parsed = parseReceipt({ content: [{ type: 'text', text: line }] });
  assert.equal(parsed.fields.doc, 'd'); assert.equal(verifyReceipt(parsed, publicHex), true);
  assert.equal(verifyReceipt(parsed, Buffer.from(other.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')), false);
  assert.equal(verifyReceipt(parsed, ''), false);
  const tampered = { ...parsed, message: parsed.message.replace('doc=d', 'doc=e') }; assert.equal(verifyReceipt(tampered, publicHex), false);
  for (const bad of ['receipt outcome=committed key=k', 'receipt outcome=published key=k sig=x', 'receipt outcome=committed key=k key=j sig=x', 'not a receipt', 'receipt outcome=committed sig=x extra']) {
    assert.equal(parseReceipt({ content: [{ type: 'text', text: bad }] }), undefined, bad);
  }
  assert.equal(parseReceipt({ content: [{ type: 'text', text: `${receipt({ outcome: 'not_sent', key: 'k', idem: 'i', at: 't' })}` }] }).fields.outcome, 'not_sent');
});
test('a publish that returns success is submitted, not canonical; only a verified receipt publishes it', async t => {
  const f = await fixture(t, { config: memoryConfig() }); const { candidateId, row, input } = await staged(f);
  assert.equal(await run(f.kernel, mem('p1', T.publish, input)), undefined);
  assert.equal(f.store.outbox(candidateId).state, 'submitted'); assert.equal(f.kernel.context().pendingMemory, 1);
  // An unsigned receipt, a receipt under another key, and a receipt naming another payload are telemetry.
  const fields = { outcome: 'committed', candidate: candidateId, payload: row.payload_hash, sha: 'abc', doc: 'doc-1', at: 't' };
  await run(f.kernel, mem('p2', T.publish, input), { text: `receipt ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')} sig=bm9wZQ` });
  await run(f.kernel, mem('p3', T.publish, input), { text: receipt(fields, other.privateKey) });
  await run(f.kernel, mem('p4', T.publish, input), { text: receipt({ ...fields, payload: 'deadbeef' }) });
  assert.equal(f.store.outbox(candidateId).state, 'submitted');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'memory.receipt_observed' && e.payload.verified === false).length, 3);
  await run(f.kernel, mem('p5', T.publish, input), { text: receipt(fields) });
  const done = f.store.outbox(candidateId); assert.equal(done.state, 'published'); assert.equal(done.remote_id, 'doc-1');
  assert.equal(f.kernel.context().pendingMemory, 0);
  assert.match((await f.kernel.intent(mem('p6', T.publish, input))).reason, /MEMORY_CANDIDATE_MISMATCH/);
});
test('publish input must be the staged payload under the candidate id; nothing else leaves', async t => {
  const f = await fixture(t, { config: memoryConfig() }); const { candidateId, input } = await staged(f);
  for (const bad of [{ ...input, payload_hash: 'x' }, { ...input, idempotency_key: 'nonce' }, { ...input, content: `${input.content}!` }, { ...input, evidence_ids: [] }, { ...input, candidate_id: 'missing' }]) {
    assert.match((await f.kernel.intent(mem(`b-${Math.random()}`, T.publish, bad))).reason, /MEMORY_CANDIDATE_MISMATCH/);
  }
  assert.equal(f.store.outbox(candidateId).state, 'candidate'); assert.equal(f.kernel.context().toolCalls, 0);
  f.store.setOutbox(f.lease, candidateId, 'candidate', 'rejected');
  assert.match((await f.kernel.intent(mem('rej', T.publish, input))).reason, /MEMORY_CANDIDATE_MISMATCH/);
});
test('changed evidence stops a publish and a citing note before either is sent', async t => {
  const f = await fixture(t, { config: memoryConfig() }); const { candidateId, input } = await staged(f);
  const evidenceId = input.evidence_ids[0];
  await run(f.kernel, mem('s0', T.start, { task_key: 'k', task: 't' }));
  writeFileSync(join(f.root, 'source.txt'), 'different');
  assert.match((await f.kernel.intent(mem('p1', T.publish, input))).reason, /STALE_EVIDENCE/);
  assert.match((await f.kernel.intent(mem('n1', T.note, { task_key: 'k', note: `근거 ${evidenceId} 참조` }))).reason, /STALE_EVIDENCE/);
  assert.equal(f.store.outbox(candidateId).state, 'candidate');
  // An uncited note is a work-ledger entry: allowed, and counted as unverified.
  assert.equal(await run(f.kernel, mem('n2', T.note, { task_key: 'k', note: '무엇: 진행' })), undefined);
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'memory.unverified').length, 2);
});
test('an errored publish is uncertain for memory only, and a verified receipt for it publishes and reconciles', async t => {
  const f = await fixture(t, { config: memoryConfig() }); const { candidateId, row, input } = await staged(f);
  await run(f.kernel, mem('p1', T.publish, input), { isError: true });
  assert.equal(f.store.outbox(candidateId).state, 'unknown'); assert.equal(action(f, mem('p1', T.publish, input)).state, 'unknown');
  const c = f.kernel.context(); assert.equal(c.blockedUntilReconciled, false); assert.equal(c.uncertainRemote, 1);
  assert.equal(await run(f.kernel, call({ toolCallId: 'b1' })), undefined, 'workspace effects are not held by a memory uncertainty');
  assert.match((await f.kernel.intent(mem('n1', T.note, { task_key: 'k', note: 'x' }))).reason, /MEMORY_BACKEND_DEGRADED/);
  await run(f.kernel, mem('st', T.status, {}));
  assert.match((await f.kernel.intent(mem('s1', T.start, { task_key: 'k', task: 't', idempotency_key: 'other' }))).reason, /RECONCILIATION_REQUIRED/);
  // The same intent may be re-issued: the server's identity-keyed upsert makes it safe. A receipt about another payload binds nothing.
  await run(f.kernel, mem('p1b', T.publish, input), { text: receipt({ outcome: 'committed', candidate: candidateId, payload: 'deadbeef', sha: 's', doc: 'doc-8', at: 't' }) });
  assert.equal(f.store.outbox(candidateId).state, 'submitted'); assert.equal(action(f, mem('p1', T.publish, input)).state, 'unknown');
  await run(f.kernel, mem('p2', T.publish, input), { text: receipt({ outcome: 'committed', candidate: candidateId, payload: row.payload_hash, sha: 's', doc: 'doc-9', at: 't' }) });
  assert.equal(f.store.outbox(candidateId).state, 'published');
  assert.equal(action(f, mem('p1', T.publish, input)).state, 'reconciled');
  assert.equal(f.store.events(f.workspace.id).find(e => e.kind === 'action.reconciled').payload.by, 'receipt');
  assert.deepEqual(f.store.unknownActions(f.workspace.id), []);
});
test('an errored note is uncertain; success without a receipt leaves it so; a verified receipt or a signed not_sent settles it', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  await run(f.kernel, mem('s0', T.start, { task_key: 'k', task: 't' }));
  const note = (id, idem = 'n-1') => mem(id, T.note, { task_key: 'k', note: '무엇: x', idempotency_key: idem });
  await run(f.kernel, note('n1'), { isError: true });
  assert.equal(action(f, note('n1')).state, 'unknown');
  await run(f.kernel, mem('st', T.status, {}));
  assert.equal(await run(f.kernel, note('n2')), undefined, 'same idempotency key re-issues past its own uncertain row');
  assert.equal(action(f, note('n1')).state, 'unknown', 'a 2xx without a receipt resolves nothing');
  assert.match((await f.kernel.intent(note('n3', 'n-2'))).reason, /RECONCILIATION_REQUIRED/);
  await run(f.kernel, note('n4'), { text: receipt({ outcome: 'committed', key: 'k', idem: 'n-1', sha: 's', doc: 'd', at: 't' }) });
  assert.equal(action(f, note('n1')).state, 'reconciled');
  assert.equal(await run(f.kernel, note('n5', 'n-2')), undefined);
  // A signed not_sent is the one error the runtime may call a plain failure.
  await run(f.kernel, mem('st2', T.status, {}));
  await run(f.kernel, note('n6', 'n-3'), { isError: true, text: receipt({ outcome: 'not_sent', key: 'k', idem: 'n-3', at: 't' }) });
  assert.equal(action(f, note('n6', 'n-3')).state, 'failed');
  // Every other not_sent stays uncertain: unverifiable, about another intent, or with nothing on the call to bind to.
  const cases = [
    ['n7', 'n-4', receipt({ outcome: 'not_sent', key: 'k', idem: 'n-4', at: 't' }, other.privateKey)],
    ['n8', 'n-5', receipt({ outcome: 'not_sent', key: 'k', idem: 'n-4', at: 't' })],
    ['n9', undefined, receipt({ outcome: 'not_sent', key: 'k', at: 't' })]
  ];
  for (const [id, idem, text] of cases) {
    await run(f.kernel, mem(`st-${id}`, T.status, {}));
    const c = idem ? note(id, idem) : mem(id, T.note, { task_key: 'k', note: 'x' });
    assert.equal(await run(f.kernel, c, { isError: true, text }), undefined, id);
    assert.equal(action(f, c).state, 'unknown', id);
    f.store.reconcile(f.lease, action(f, c).id, [], { observed: 'read back' });
  }
});
test('a memory write revised after its gates ran is uncertain even when it succeeds; only a receipt for the executed intent settles it', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  await run(f.kernel, mem('s0', T.start, { task_key: 'k', task: 't' }));
  const c = mem('n1', T.note, { task_key: 'k', note: 'x', idempotency_key: 'n-1' });
  assert.equal(await run(f.kernel, c, { args: { ...c.input, idempotency_key: 'n-9' } }), undefined);
  assert.equal(action(f, c).state, 'unknown'); assert.equal(f.kernel.counters.revisions, 1);
  assert.ok(f.store.events(f.workspace.id).some(e => e.kind === 'memory.write_revised'));
  const d = mem('n2', T.note, { task_key: 'k', note: 'x', idempotency_key: 'n-1' });
  await run(f.kernel, mem('st', T.status, {}));
  assert.match((await f.kernel.intent(d)).reason, /RECONCILIATION_REQUIRED/, 'the intent that passed the gates is not the one that ran');
  // A receipt naming the intent that ran (not the one that passed the gates) settles it: the outcome is observed.
  const e = mem('n3', T.note, { task_key: 'k', note: 'x', idempotency_key: 'n-9' });
  await run(f.kernel, e, { args: { ...e.input, idempotency_key: 'n-8' }, text: receipt({ outcome: 'committed', key: 'k', idem: 'n-8', sha: 's', doc: 'd', at: 't' }) });
  assert.equal(action(f, e).state, 'reconciled', 'a verified receipt for what actually ran closes that row');
  assert.equal(action(f, c).state, 'unknown', 'while the receipt for a different intent leaves the other row open');
});
test('a publish revised after the gates ran is uncertain, not submitted, and no receipt about it publishes', async t => {
  const f = await fixture(t, { config: memoryConfig() }); const { candidateId, row, input } = await staged(f);
  const c = mem('p1', T.publish, input);
  await run(f.kernel, c, { args: { ...input, payload_hash: 'deadbeef', content: 'tampered' }, text: receipt({ outcome: 'committed', candidate: candidateId, payload: 'deadbeef', sha: 's', doc: 'doc-x', at: 't' }) });
  assert.equal(action(f, c).state, 'unknown'); assert.equal(f.store.outbox(candidateId).state, 'unknown');
  // Content revised while the hash field is kept: the server echoes the staged hash, yet what it stored is not the candidate.
  const g = await fixture(t, { config: memoryConfig() }); const s2 = await staged(g);
  const d = mem('p2', T.publish, s2.input);
  await run(g.kernel, d, { args: { ...s2.input, content: 'tampered' }, text: receipt({ outcome: 'committed', candidate: s2.candidateId, payload: s2.row.payload_hash, sha: 's', doc: 'doc-y', at: 't' }) });
  assert.equal(action(g, d).state, 'unknown'); assert.equal(g.store.outbox(s2.candidateId).state, 'unknown');
  for (const [fx, id] of [[f, candidateId], [g, s2.candidateId]]) assert.equal(fx.store.events(fx.workspace.id).find(e => e.kind === 'memory.receipt_observed').payload.verified, false, id);
  void row;
});
test('a write for a task key never started or read in this session is refused until a read proves the key', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  assert.match((await f.kernel.intent(mem('n1', T.note, { task_key: 'k', note: 'x' }))).reason, /MEMORY_TASK_NOT_STARTED/);
  await run(f.kernel, mem('r1', T.taskRead, { task_key: 'k' }), { isError: true });
  await run(f.kernel, mem('st', T.status, {}));
  assert.match((await f.kernel.intent(mem('n2', T.note, { task_key: 'k', note: 'x' }))).reason, /MEMORY_TASK_NOT_STARTED/, 'a failed read proves nothing');
  await run(f.kernel, mem('r2', T.taskRead, { task_key: 'k' }));
  assert.equal(await run(f.kernel, mem('n3', T.note, { task_key: 'k', note: 'x' })), undefined);
  assert.equal(await run(f.kernel, mem('s1', T.start, { task_key: 'fresh', task: 't' })), undefined, 'start may name a new key');
  assert.equal(f.kernel.context().memory.task, 'fresh');
});
test('writes are refused while the last memory call failed, until a read succeeds', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  await run(f.kernel, mem('q1', T.search, { query: 'x' }), { isError: true });
  assert.match((await f.kernel.intent(mem('s1', T.start, { task_key: 'k', task: 't' }))).reason, /MEMORY_BACKEND_DEGRADED/);
  assert.equal(await run(f.kernel, call({ toolCallId: 'b1' })), undefined, 'the working tree is unaffected');
  await run(f.kernel, mem('st', T.status, {}));
  assert.equal(await run(f.kernel, mem('s2', T.start, { task_key: 'k', task: 't' })), undefined);
});
test('a credential in a memory write is refused before it is sent', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  await run(f.kernel, mem('s0', T.start, { task_key: 'k', task: 't' }));
  assert.match((await f.kernel.intent(mem('n1', T.note, { task_key: 'k', note: 'token: Bearer abcdefghijklmnopqrst' }))).reason, /MEMORY_SECRET/);
  assert.equal(f.kernel.context().toolCalls, 1);
});
test('memory candidate rejects speculative kinds and obvious credentials', async t => {
  const f = await fixture(t); const e = f.evidence();
  assert.throws(() => f.store.candidate(f.lease, { kind: 'speculation', title: 'x', content: 'y', evidenceIds: [e] }), code('INVALID_MEMORY_KIND'));
  assert.throws(() => f.store.candidate(f.lease, { kind: 'decision', title: 'x', content: 'Bearer abcdefghijklmnopqrst', evidenceIds: [e] }), code('POSSIBLE_SECRET'));
});
test('the task record and effects-since-note are derived from the journal and survive a restart', async t => {
  const f = await fixture(t, { config: memoryConfig() });
  await run(f.kernel, call({ toolCallId: 'b1' }));
  await run(f.kernel, mem('s0', T.start, { task_key: 'k', task: 't' }));
  await run(f.kernel, call({ toolCallId: 'b2' })); await run(f.kernel, call({ toolCallId: 'b3' })); await run(f.kernel, call({ toolCallId: 'r1', toolName: 'read', input: { path: 'source.txt' } }));
  assert.deepEqual([f.kernel.context().memory.task, f.kernel.context().memory.effectsSinceNote], ['k', 2]);
  const reopened = await RuntimeStore.open(f.dbPath, { now: f.now }); t.after(() => reopened.close());
  assert.equal(reopened.memoryTask('session').key, 'k'); assert.equal(reopened.effectsSinceMemoryWrite('session', [T.start, T.note]), 2);
});
test('a v2 journal is migrated: transport states become candidate, unknown and published', async t => {
  const f = await fixture(t); const path = join(f.base, 'legacy.sqlite');
  const db = await openDatabase(path);
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), session TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('candidate','approved','sending','acked','unknown','rejected')), remote_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    INSERT INTO workspaces VALUES ('w','/w',0);
    INSERT INTO outbox VALUES ('a','w','s','{}','h','approved',NULL,1,1),('b','w','s','{}','h','sending',NULL,1,1),('c','w','s','{}','h','acked','remote-1',1,1);
    PRAGMA user_version=2;`);
  db.close();
  const store = await RuntimeStore.open(path); t.after(() => store.close());
  assert.deepEqual(store.db.prepare('SELECT id,state,remote_id FROM outbox ORDER BY id').all().map(r => [r.id, r.state, r.remote_id]), [['a', 'candidate', null], ['b', 'unknown', null], ['c', 'published', 'remote-1']]);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  // A row the new table cannot accept (orphan workspace under foreign keys) rolls the whole migration back.
  const broken = join(f.base, 'broken.sqlite'); const b = await openDatabase(broken);
  b.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('candidate','approved','sending','acked','unknown','rejected')), remote_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    INSERT INTO outbox VALUES ('orphan','missing-workspace','s','{}','h','approved',NULL,1,1);
    PRAGMA user_version=2;`);
  b.close();
  await assert.rejects(RuntimeStore.open(broken));
  const again = await openDatabase(broken);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(again.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'outbox%' ORDER BY name").all().map(r => r.name), ['outbox']);
  assert.equal(again.prepare('SELECT state FROM outbox').get().state, 'approved');
  again.close();
});
