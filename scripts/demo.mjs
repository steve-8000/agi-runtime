#!/usr/bin/env node
// Offline walk through the kernel. Nothing here contacts OMP or mem.clab.one: the "server" is a
// throwaway Ed25519 key signing the receipt lines clab-mem would print.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.mjs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { captureEvidence } from '../src/evidence.mjs';

const T = { search: 'mcp__clab_mem_mem_search', status: 'mcp__clab_mem_mem_status', taskRead: 'mcp__clab_mem_mem_task_read', start: 'mcp__clab_mem_mem_task_start', note: 'mcp__clab_mem_mem_task_note', publish: 'mcp__clab_mem_mem_publish' };
const keys = generateKeyPairSync('ed25519');
const receipt = fields => { const m = `receipt ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`; return `${m} sig=${sign(null, Buffer.from(m), keys.privateKey).toString('base64url')}`; };
const config = {
  memoryReadTools: [T.search, T.status, T.taskRead], memoryWriteTools: [T.start, T.note], memoryTaskStartTool: T.start, memoryPublishTool: T.publish,
  memoryReceiptPublicKey: Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'),
  recall: { mode: 'require', tools: [T.search, T.taskRead] }
};
const base = mkdtempSync(join(tmpdir(), 'omp-runtime-demo-')); const root = join(base, 'workspace'); mkdirSync(root);
writeFileSync(join(root, 'architecture.md'), 'Utopia is canonical memory.\nzvec-grep indexes workspaces only.\n');
const store = await RuntimeStore.open(join(base, 'state', 'runtime.sqlite'));
const steps = [];
try {
  const workspace = store.workspace(root), lease = store.acquire(workspace.id, 'demo-session');
  const kernel = new RuntimeKernel({ store, lease, root, config, confirm: async () => true });
  store.mirrorGoal(lease, { id: 'native-goal-demo', objective: '검색과 정본 메모리의 경계를 기록한다.', status: 'active' });
  let n = 0;
  async function call(toolName, input, { isError = false, text = 'ok' } = {}) {
    const c = { toolCallId: `demo-${++n}`, toolName, input, hasUI: true };
    const intent = await kernel.intent(c);
    if (intent?.block) { steps.push({ tool: toolName, blocked: intent.reason }); return intent; }
    kernel.revise(c.toolCallId, toolName, input);
    const result = { content: [{ type: 'text', text }], details: { exitCode: 0 } };
    kernel.settle(c.toolCallId, toolName, { result, isError, phase: 'result' }); kernel.settle(c.toolCallId, toolName, { result, isError, phase: 'end' });
    steps.push({ tool: toolName, state: store.action(store.db.prepare('SELECT id FROM actions ORDER BY rowid DESC LIMIT 1').get().id).state });
    return intent;
  }
  kernel.turnStart();
  await call('bash', { command: 'printf ok' });                                   // refused: no recall yet
  await call(T.search, { query: '검색 메모리 경계' }, { text: 'hits=1 embedding=demo' });
  await call('bash', { command: 'printf ok' });                                   // refused: settles this turn
  kernel.turnStart();
  await call('bash', { command: 'printf ok' });                                   // runs
  await call(T.start, { task_key: 'demo-task', task: '경계 기록', idempotency_key: 'start-1' }, { text: 'key=demo-task action=created' });
  await call(T.note, { task_key: 'demo-task', note: '무엇: 경계 확인', idempotency_key: 'note-1' }, { isError: true, text: 'curl POST 실패 (exit 28)' }); // uncertain
  await call(T.note, { task_key: 'demo-task', note: '다른 절', idempotency_key: 'note-2' });                                                      // refused: backend not known to answer
  await call(T.status, {}, { text: 'ok=true docs=1' });
  await call(T.note, { task_key: 'demo-task', note: '무엇: 경계 확인', idempotency_key: 'note-1' }, { text: receipt({ outcome: 'committed', key: 'demo-task', idem: 'note-1', sha: 'abc', doc: 'doc-1', at: '2026-09-05T00:00:00Z' }) });
  const evidenceId = store.saveEvidence(lease, captureEvidence(root, 'architecture.md', 1, 2));
  store.checkpoint(lease, { summary: '현재 원문을 확인했다.', nextAction: '정본 승격', evidenceIds: [evidenceId] });
  const payload = { kind: 'decision', title: '검색과 메모리 분리', content: 'Utopia는 정본이고 zvec-grep은 워크스페이스 인덱스다.', evidenceIds: [evidenceId] };
  const candidateId = store.candidate(lease, payload); const row = store.outbox(candidateId);
  const publish = { candidate_id: candidateId, idempotency_key: candidateId, payload_hash: row.payload_hash, kind: payload.kind, title: payload.title, content: payload.content, evidence_ids: payload.evidenceIds };
  await call(T.publish, publish, { text: 'ok without receipt' });
  const submitted = store.outbox(candidateId).state;
  await call(T.publish, publish, { text: receipt({ outcome: 'committed', candidate: candidateId, payload: row.payload_hash, sha: 'def', doc: 'doc-2', at: '2026-09-05T00:00:00Z' }) });
  console.log(JSON.stringify({ mode: 'offline-mock-demo', modelCalled: false, remoteContacted: false, signingKey: 'ephemeral, generated by this script', steps,
    outbox: { afterPlainSuccess: submitted, afterVerifiedReceipt: store.outbox(candidateId).state }, runtime: kernel.context() }, null, 2));
  store.release(lease);
} finally { store.close(); rmSync(base, { recursive: true, force: true }); }
