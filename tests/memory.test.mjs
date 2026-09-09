import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { bankPath, readBank, observe, classifyConsolidationError, MAX_PENDING } from '../src/memory.mjs';
import { projection, MAX_CONTEXT_BYTES } from '../src/context.mjs';

const SCOPE = 'demo-9x1';
function bank(t, { state, deltas = [] } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'ss-bank-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const dir = join(agentDir, 'memories', 'sharpshooter', SCOPE);
  mkdirSync(dir, { recursive: true });
  if (state) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  deltas.forEach(([session, name, delta], i) => {
    const d = join(dir, 'queue', session);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), JSON.stringify({ v: 1, kind: 'architecture_decision', statement: `s${i}`, ...delta }));
  });
  return { agentDir, dir };
}

test('a bank the backend has not created yet is unobserved, not empty', t => {
  const { agentDir } = bank(t);
  assert.equal(readBank(bankPath(agentDir, 'never-used'), 'session'), null);
});

test('a bank id containing a path escape is refused', t => {
  const { agentDir } = bank(t);
  for (const scope of ['../../etc', 'a/b', '', undefined]) assert.equal(bankPath(agentDir, scope), undefined);
});

test('queued deltas are reported with the losing session first and a full total', t => {
  const { agentDir } = bank(t, {
    state: { v: 1, lastConsolidatedAt: 5 },
    deltas: [
      ['other', '0000000001-aaaa.json', { statement: 'other session decision' }],
      ['mine', '0000000002-bbbb.json', { kind: 'correction', statement: 'do not reintroduce SQLite' }],
      ['mine', '0000000003-cccc.json', { kind: 'style_decision', statement: 'explicit return types' }],
    ],
  });
  const observed = readBank(bankPath(agentDir, SCOPE), 'mine');
  assert.equal(observed.pendingTotal, 3);
  assert.deepEqual(observed.pending.map(d => d.kind), ['correction', 'style_decision', 'architecture_decision']);
  assert.equal(observed.pending[0].statement, 'do not reintroduce SQLite');
  assert.equal(observed.error, null);
});

test('a permission-denied queue is unobserved until access recovers', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'requires unprivileged POSIX file permissions' : false,
}, t => {
  const { dir } = bank(t, { deltas: [['mine', '0000000001-aaaa.json', { statement: 'preserve integer cents' }]] });
  const queue = join(dir, 'queue'), mode = statSync(queue).mode & 0o777;
  try {
    chmodSync(queue, 0);
    assert.throws(() => readdirSync(queue), { code: 'EACCES' });
    assert.equal(readBank(dir, 'mine'), null, 'unreadable is not an observed empty queue');
  } finally {
    chmodSync(queue, mode);
  }
  const recovered = readBank(dir, 'mine');
  assert.equal(recovered.pendingTotal, 1);
  assert.deepEqual(recovered.pending.map(d => d.statement), ['preserve integer cents']);
});

test('a malformed delta is skipped without discarding the readable ones', t => {
  const { agentDir, dir } = bank(t, { deltas: [['mine', '0000000002-bbbb.json', { statement: 'kept' }]] });
  writeFileSync(join(dir, 'queue', 'mine', '0000000001-aaaa.json'), '{not json');
  const observed = readBank(bankPath(agentDir, SCOPE), 'mine');
  assert.deepEqual(observed.pending.map(d => d.statement), ['kept']);
  assert.equal(observed.pendingTotal, 2);
});

test('a failing consolidation is observed rather than reported as healthy', t => {
  const { agentDir } = bank(t, { state: { v: 1, lastConsolidatedAt: 5, lastError: { at: 7, message: 'sharpshooter consolidation model error' } } });
  assert.deepEqual(readBank(bankPath(agentDir, SCOPE), 'mine').error, { at: 7, kind: 'model-call-failed', detail: '/memory diagnose' });
});

test('a raw backend error string never leaves the observer', t => {
  const leak = 'fetch failed: https://api.example.com/v1?key=sk-abcdefghijklmnop0123 (ENOTFOUND)';
  const { agentDir } = bank(t, { state: { v: 1, lastConsolidatedAt: 5, lastError: { at: 7, message: leak } } });
  const observed = readBank(bankPath(agentDir, SCOPE), 'mine');
  assert.equal(JSON.stringify(observed).includes('sk-abcdefghijklmnop0123'), false);
  assert.equal(observed.error.kind, 'unspecified');
  for (const message of ['boom', 'ENOENT: no such file', 'consolidation must call replace_memory_files exactly once'])
    assert.ok(!String(classifyConsolidationError(message)).includes(message));
});

test('another memory backend produces no sharpshooter observation', async t => {
  const { agentDir } = bank(t, { state: { v: 1, lastConsolidatedAt: 1 } });
  const memory = { status: async () => ({ backend: 'mnemopi', active: true, scope: SCOPE }) };
  assert.equal(await observe(memory, agentDir, 'mine'), null);
  const off = { status: async () => ({ backend: 'sharpshooter', active: false, scope: SCOPE }) };
  assert.equal(await observe(off, agentDir, 'mine'), null);
  const live = { status: async () => ({ backend: 'sharpshooter', active: true, scope: SCOPE }) };
  assert.equal((await observe(live, agentDir, 'mine')).pendingTotal, 0);
});

test('unconsolidated decisions reach the model only on the recovery card', async t => {
  const f = await fixture(t);
  f.rt.decisionMemory = { bank: '/b', pending: [{ kind: 'correction', statement: 'keep JSONL' }], pendingTotal: 1, error: null };
  assert.equal(projection(f.rt), '');
  f.rt.resume = true;
  assert.deepEqual(JSON.parse(projection(f.rt)).resume.pendingDecisions, ['correction: keep JSONL']);
});

test('a failing consolidation is projected as a persistence warning, not as memory content', async t => {
  const f = await fixture(t);
  f.rt.decisionMemory = { bank: '/b', pending: [], pendingTotal: 0, error: { at: 1, kind: 'model-call-failed', detail: '/memory diagnose' } };
  const state = JSON.parse(projection(f.rt));
  assert.equal(state.decisionMemory.consolidationFailing, 'model-call-failed');
  assert.equal(state.decisionMemory.bank, '/b');
  assert.equal(state.decisionMemory.detail, '/memory diagnose');
});

test('packing drops queued decisions before the rest of the recovery card', async t => {
  const f = await fixture(t);
  f.rt.resume = true;
  f.rt.checkpointValue = { summary: 'built the thing', nextAction: 'run tests' };
  f.rt.decisionMemory = { bank: '/b', pendingTotal: 9, error: null,
    pending: Array.from({ length: MAX_PENDING }, () => ({ kind: 'constraint', statement: '한'.repeat(400) })) };
  const state = JSON.parse(projection(f.rt));
  assert.ok(Buffer.byteLength(projection(f.rt)) <= MAX_CONTEXT_BYTES);
  assert.equal(state.resume.pendingDecisions, undefined);
  assert.equal(state.resume.pendingDecisionsOmitted, 'runtime_status');
  assert.equal(state.resume.checkpoint.summary, 'built the thing');
});


