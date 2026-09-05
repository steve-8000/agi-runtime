import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.mjs';
import { fixture, call, run, action, code } from './helpers.mjs';

const T = { recall: 'mcp__gbrain_recall', remember: 'mcp__gbrain_remember', forget: 'mcp__gbrain_forget' };
const config = () => ({ memoryReadTools: [T.recall], memoryWriteTools: [T.remember, T.forget], recall: { mode: 'advise', tools: [] } });
const write = (id, input, toolName = T.remember) => call({ toolCallId: id, toolName, input });

test('a credential in a canonical-memory write is refused before it is sent', async t => {
  const f = await fixture(t, { config: config() });
  const secret = write('w1', { fact: 'the deploy token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', provenance: 'chat' });
  assert.match((await f.kernel.intent(secret)).reason, /MEMORY_SECRET/);
  assert.equal(action(f, secret), undefined, 'a refused write is never journaled as executing');
});

test('a write that cites evidence is refused when that file has changed, and passes when it has not', async t => {
  const f = await fixture(t, { config: config() });
  const evidenceId = f.evidence();
  const cite = id => write(id, { fact: `see ${evidenceId}`, provenance: 'runtime_evidence' });
  assert.equal(await run(f.kernel, cite('w1')), undefined);
  assert.equal(action(f, cite('w1')).state, 'succeeded');
  writeFileSync(join(f.root, 'source.txt'), 'first\nchanged\nthird\n');
  assert.match((await f.kernel.intent(cite('w2'))).reason, /STALE_EVIDENCE/);
});

test('an uncited write is allowed and counted, so unverified memory is visible without blocking work', async t => {
  const f = await fixture(t, { config: config() });
  await run(f.kernel, write('w1', { fact: 'the operator prefers dark mode', provenance: 'chat' }));
  const events = f.store.events(f.workspace.id).filter(e => e.kind === 'memory.unverified');
  assert.equal(events.length, 1); assert.equal(events[0].payload.tool, T.remember);
});

test('after a memory call that did not succeed, the next write waits for a read that does', async t => {
  const f = await fixture(t, { config: config() });
  await run(f.kernel, write('w1', { fact: 'a', provenance: 'chat' }), { isError: true });
  assert.equal(action(f, write('w1', {})).state, 'unknown', 'an errored write may still have landed');
  assert.match((await f.kernel.intent(write('w2', { fact: 'b', provenance: 'chat' }))).reason, /MEMORY_BACKEND_DEGRADED|RECONCILIATION_REQUIRED/);
  await run(f.kernel, call({ toolCallId: 'r1', toolName: T.recall, input: { entity: 'concepts/x' } }));
  // The backend answers again, but the uncertain write still has to be closed by read-back.
  assert.match((await f.kernel.intent(write('w3', { fact: 'b', provenance: 'chat' }))).reason, /RECONCILIATION_REQUIRED/);
  f.store.reconcile(f.lease, action(f, write('w1', {})).id, [], { by: 'session', observed: 'recall shows no such fact' });
  assert.equal(await run(f.kernel, write('w4', { fact: 'b', provenance: 'chat' })), undefined);
});

test('a write whose input changed after the gates ran is uncertain even when the call succeeds', async t => {
  const f = await fixture(t, { config: config() });
  const c = write('w1', { fact: 'a', provenance: 'chat' });
  await run(f.kernel, c, { args: { fact: 'something else entirely', provenance: 'chat' } });
  assert.equal(action(f, c).state, 'unknown', 'what ran is not what passed the gates');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'memory.write_revised').length, 1);
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'memory.write_unknown').length, 1);
});

test('an uncertain memory write holds memory writes only; workspace effects keep running', async t => {
  const f = await fixture(t, { config: config() });
  await run(f.kernel, write('w1', { fact: 'a', provenance: 'chat' }), { isError: true });
  assert.equal(await run(f.kernel, call({ toolCallId: 'b1' })), undefined, 'a bash effect is not a canonical-memory write');
  assert.match((await f.kernel.intent(write('f1', { id: '3' }, T.forget))).reason, /MEMORY_BACKEND_DEGRADED|RECONCILIATION_REQUIRED/, 'a memory write is held');
  const c = f.kernel.context();
  assert.equal(c.uncertainRemote, 1); assert.equal(c.blockedUntilReconciled, false, 'the working tree is not blocked by a remote unknown');
});

test('the journal opens an older schema by dropping the candidate outbox and keeps the actions it had', async t => {
  const f = await fixture(t, { config: config() });
  await run(f.kernel, call({ toolCallId: 'b1' }));
  const path = f.dbPath;
  f.store.close();
  const raw = await RuntimeStore.open(path);
  raw.db.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL, remote_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL); PRAGMA user_version=3;");
  raw.close();
  const store = await RuntimeStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='outbox'").get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM actions').get().n, 1, 'the journal survives the migration');
  store.close();
});

test('an unsupported schema version refuses to open rather than guessing', async t => {
  const f = await fixture(t, { config: config() });
  const path = f.dbPath; f.store.close();
  const raw = await RuntimeStore.open(path);
  raw.db.exec('PRAGMA user_version=99;');
  raw.close();
  await assert.rejects(RuntimeStore.open(path), code('UNSUPPORTED_SCHEMA'));
});

test('a canonical-memory write dispatched through an xd:// envelope is scoped as a remote write', async t => {
  const f = await fixture(t, { config: config() });
  const envelope = call({ toolCallId: 'x1', toolName: 'write', input: { path: `xd://${T.remember}`, content: JSON.stringify({ fact: 'a', provenance: 'chat' }) } });
  // The envelope errors the way the device would when the write did not answer.
  await run(f.kernel, envelope, { isError: true });
  assert.equal(action(f, envelope).state, 'unknown', 'the envelope inherits the target: an errored memory write is uncertain');
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'memory.write_unknown').length, 1);
  assert.equal(f.kernel.context().uncertainRemote, 1, 'scoped as remote, not as a working-tree write');
  assert.match((await f.kernel.intent(write('w1', { fact: 'b', provenance: 'chat' }))).reason, /MEMORY_BACKEND_DEGRADED|RECONCILIATION_REQUIRED/, 'further memory writes wait');
});

test('a credential inside an xd:// envelope is refused before the device runs', async t => {
  const f = await fixture(t, { config: config() });
  const envelope = call({ toolCallId: 'x2', toolName: 'write', input: { path: `xd://${T.remember}`, content: JSON.stringify({ fact: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', provenance: 'chat' }) } });
  assert.match((await f.kernel.intent(envelope)).reason, /MEMORY_SECRET/);
});

test('a failed memory read does not lock the session out of writing; an unknown write still does', async t => {
  const f = await fixture(t, { config: config() });
  await run(f.kernel, call({ toolCallId: 'r1', toolName: T.recall, input: { query: 'q' } }), { isError: true });
  assert.equal(await run(f.kernel, write('w1', { fact: 'a', provenance: 'chat' })), undefined, 'a backend that cannot answer a read is not a reason to drop the record');
  await run(f.kernel, write('w2', { fact: 'b', provenance: 'chat' }), { isError: true });
  assert.match((await f.kernel.intent(write('w3', { fact: 'c', provenance: 'chat' }))).reason, /MEMORY_BACKEND_DEGRADED|RECONCILIATION_REQUIRED/, 'an unknown write must be read back first');
});
