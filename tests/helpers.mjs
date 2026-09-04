import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.mjs';
import { RuntimeKernel } from '../src/kernel.mjs';
import { captureEvidence } from '../src/evidence.mjs';
import { digest } from '../src/util.mjs';

export async function fixture(t, { config = {}, confirm = async () => true, hasUI = true, session = 'session' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'omp-runtime-test-'));
  const root = join(base, 'workspace'); mkdirSync(root);
  writeFileSync(join(root, 'source.txt'), 'first\nsecond\nthird\n');
  const dbPath = join(base, 'state', 'state.sqlite');
  let clock = 100000;
  const now = () => clock;
  const store = await RuntimeStore.open(dbPath, { now });
  const workspace = store.workspace(root);
  const lease = store.acquire(workspace.id, session, { hasUI });
  const kernel = new RuntimeKernel({ store, lease, root, config, confirm });
  const stores = [store];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(base, { recursive: true, force: true }); });
  return {
    base, root, dbPath, store, lease, workspace, kernel, stores, now,
    advance: ms => { clock += ms; },
    /** Time passes so every lease without a heartbeat lapses, while this fixture's own session keeps beating. */
    lapse() { clock += 20000; store.heartbeat(lease); clock += 20000; },
    /** A second OMP process on the same working tree: its own connection, session and lease. */
    async sibling(id, options = {}) {
      const s = await RuntimeStore.open(dbPath, { now }); stores.push(s);
      const l = s.acquire(workspace.id, id, options);
      return { store: s, lease: l, kernel: new RuntimeKernel({ store: s, lease: l, root, config: options.config ?? config, confirm }) };
    },
    evidence: () => store.saveEvidence(lease, captureEvidence(root, 'source.txt', 1, 2)),
    candidate: () => {
      const evidenceId = store.saveEvidence(lease, captureEvidence(root, 'source.txt', 1, 2));
      return store.candidate(lease, { kind: 'decision', title: '검증된 결정', content: '정본은 원격 메모리로 유지한다.', evidenceIds: [evidenceId] });
    }
  };
}
export function call(overrides = {}) {
  return { toolCallId: 'call-1', toolName: 'bash', input: { command: 'printf ok' }, hasUI: true, ...overrides };
}
/** Drive one tool through the whole event sequence OMP emits for a model-issued call. */
export async function run(kernel, c, { isError = false, exitCode = 0, args } = {}) {
  const intent = await kernel.intent(c);
  if (intent?.block) return intent;
  kernel.revise(c.toolCallId, c.toolName, args ?? intent?.input ?? c.input);
  const result = { content: [{ type: 'text', text: 'ok' }], details: { exitCode } };
  kernel.settle(c.toolCallId, c.toolName, { result, isError, phase: 'result' });
  kernel.settle(c.toolCallId, c.toolName, { result, isError, phase: 'end' });
  return intent;
}
export const code = expected => error => error?.code === expected;
/** The journal row a kernel wrote for a call (action ids are derived, not random). */
export const action = (f, c, kernel = f.kernel) => f.store.action(digest({ session: kernel.lease.session, tool: c.toolName, toolCallId: c.toolCallId }));
