#!/usr/bin/env node
// Offline walk through the kernel: recall gate, an uncertain canonical-memory write, and the
// read-back attestation that closes it. Nothing here contacts OMP, a model, or a memory backend —
// tool results are literals, which is exactly what the kernel treats them as.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.mjs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { captureEvidence } from '../src/evidence.mjs';

const T = {
  recall: 'mcp__gbrain_recall', entity: 'mcp__gbrain_entity', pack: 'mcp__gbrain_context_pack',
  remember: 'mcp__gbrain_remember', forget: 'mcp__gbrain_forget'
};
const config = {
  memoryReadTools: [T.recall, T.entity, T.pack], memoryWriteTools: [T.remember, T.forget],
  recall: { mode: 'require', tools: [T.recall, T.entity, T.pack] }
};
const base = mkdtempSync(join(tmpdir(), 'omp-runtime-demo-')); const root = join(base, 'workspace'); mkdirSync(root);
writeFileSync(join(root, 'architecture.md'), 'gbrain is canonical memory.\nzvec-grep indexes workspaces only.\n');
const store = await RuntimeStore.open(join(base, 'state', 'runtime.sqlite'));
const steps = [];
try {
  const workspace = store.workspace(root), lease = store.acquire(workspace.id, 'demo-session');
  const kernel = new RuntimeKernel({ store, lease, root, config, confirm: async () => true });
  store.mirrorGoal(lease, { id: 'native-goal-demo', objective: '검색과 정본 메모리의 경계를 기록한다.', status: 'active' });
  let n = 0, last;
  async function call(toolName, input, { isError = false, text = 'ok', args } = {}) {
    const c = { toolCallId: `demo-${++n}`, toolName, input, hasUI: true };
    const intent = await kernel.intent(c);
    if (intent?.block) { steps.push({ tool: toolName, blocked: intent.reason }); return intent; }
    kernel.revise(c.toolCallId, toolName, args ?? input);
    const result = { content: [{ type: 'text', text }], details: { exitCode: 0 } };
    kernel.settle(c.toolCallId, toolName, { result, isError, phase: 'result' }); kernel.settle(c.toolCallId, toolName, { result, isError, phase: 'end' });
    last = store.action(store.db.prepare('SELECT id FROM actions ORDER BY rowid DESC LIMIT 1').get().id);
    steps.push({ tool: toolName, state: last.state });
    return intent;
  }
  kernel.turnStart();
  await call('bash', { command: 'printf ok' });                                        // refused: no recall yet
  await call(T.recall, { query: '검색 메모리 경계' }, { text: '{"total": 1, "facts": [{"fact": "…"}]}' });
  await call('bash', { command: 'printf ok' });                                        // refused: settles this turn
  kernel.turnStart();
  await call('bash', { command: 'printf ok' });                                        // runs
  await call(T.remember, { fact: '경계를 기록한다', provenance: 'demo' }, { isError: true, text: 'upstream timeout' }); // uncertain: may have landed
  const uncertain = last.id;
  await call(T.remember, { fact: '다른 사실', provenance: 'demo' });                     // refused: an uncertain write is open
  await call(T.entity, { entity: 'concepts/agi-runtime' }, { text: '{"found": true, "card": {}}' });
  await call(T.remember, { fact: '다른 사실', provenance: 'demo' });                     // still refused: read-back is not attestation
  store.reconcile(lease, uncertain, [], { by: 'session', observed: 'recall shows the fact was stored once' });
  await call(T.remember, { fact: '다른 사실', provenance: 'demo' });                     // runs
  const evidenceId = store.saveEvidence(lease, captureEvidence(root, 'architecture.md', 1, 2));
  store.checkpoint(lease, { summary: '현재 원문을 확인했다.', nextAction: '사실 기록', evidenceIds: [evidenceId] });
  writeFileSync(join(root, 'architecture.md'), 'gbrain is canonical memory.\nchanged.\n');
  await call(T.remember, { fact: `근거 ${evidenceId}`, provenance: 'demo' });            // refused: the cited file changed
  // A goal whose environment cannot recall: the gate opens itself rather than waiting for a human.
  store.mirrorGoal(lease, { id: 'native-goal-stranded', objective: '회상 백엔드가 없는 환경', status: 'active' });
  for (let i = 0; i < 2; i++) { kernel.turnStart(); await call('bash', { command: 'printf stranded' }); }
  kernel.turnStart();
  await call('bash', { command: 'printf stranded' });                                  // runs: recall.forced
  const opened = store.events(workspace.id).filter(e => e.kind === 'recall.forced' || e.kind === 'recall.unavailable').map(e => e.kind);
  console.log(JSON.stringify({ mode: 'offline-mock-demo', modelCalled: false, remoteContacted: false, steps, gateOpenedBy: opened, runtime: kernel.context() }, null, 2));
  store.release(lease);
} finally { store.close(); rmSync(base, { recursive: true, force: true }); }
