#!/usr/bin/env node
// Offline walk through the kernel with a fake memory transport. Nothing here contacts OMP or mem.clab.one.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.mjs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { captureEvidence } from '../src/evidence.mjs';
import { CanonicalMemoryPort, publishCandidate } from '../src/memory.mjs';
const base = mkdtempSync(join(tmpdir(), 'omp-runtime-demo-')); const root = join(base, 'workspace'); mkdirSync(root);
writeFileSync(join(root, 'architecture.md'), 'Utopia is canonical memory.\nzvec-grep indexes workspaces only.\n');
const store = await RuntimeStore.open(join(base, 'state', 'runtime.sqlite'));
try {
  const workspace = store.workspace(root), lease = store.acquire(workspace.id, 'demo-session');
  const kernel = new RuntimeKernel({ store, lease, root, confirm: async () => true });
  store.mirrorGoal(lease, { id: 'native-goal-demo', objective: '검색과 정본 메모리의 경계를 기록한다.', status: 'active' });
  const call = { toolCallId: 'demo-1', toolName: 'bash', input: { command: 'printf ok' }, hasUI: true };
  await kernel.intent(call); kernel.revise(call.toolCallId, call.toolName, call.input);
  kernel.settle(call.toolCallId, call.toolName, { result: { content: [], details: { exitCode: 0 } }, isError: false, phase: 'result' });
  kernel.settle(call.toolCallId, call.toolName, { result: { content: [], details: { exitCode: 0 } }, isError: false, phase: 'end' });
  const evidenceId = store.saveEvidence(lease, captureEvidence(root, 'architecture.md', 1, 2));
  store.checkpoint(lease, { summary: '현재 원문을 확인했다.', nextAction: '운영자 검토', evidenceIds: [evidenceId] });
  const candidateId = store.candidate(lease, { kind: 'decision', title: '검색과 메모리 분리', content: 'Utopia는 정본이고 zvec-grep은 워크스페이스 인덱스다.', evidenceIds: [evidenceId] });
  store.setOutbox(lease, candidateId, 'candidate', 'approved');
  // Deliberately an in-memory fake with the contract a real transport must prove.
  const port = new CanonicalMemoryPort({ capabilities: { idempotency: 'server-enforced', durableAck: true }, validate: () => true,
    write: async r => ({ idempotencyKey: r.idempotencyKey, payloadHash: r.payloadHash, durable: true, remoteId: 'FAKE-REMOTE-RECEIPT' }), lookup: async () => null });
  await publishCandidate(store, lease, root, candidateId, port);
  console.log(JSON.stringify({ mode: 'offline-mock-demo', modelCalled: false, remoteContacted: false, canonicalServerCommitVerified: false, localOutboxState: store.outbox(candidateId).state, runtime: kernel.context() }, null, 2));
  store.release(lease);
} finally { store.close(); rmSync(base, { recursive: true, force: true }); }
