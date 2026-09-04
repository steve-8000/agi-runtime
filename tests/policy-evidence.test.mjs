import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { classify, decision, approvalHash, isEffect } from '../src/policy.mjs';
import { captureEvidence, verifyEvidence, zvecFreshness } from '../src/evidence.mjs';
import { runtimeConfig } from '../src/config.mjs';
import { sensitiveRead } from '../src/workspace-write.mjs';
import { digest, stable } from '../src/util.mjs';
import { journalPath, runtimeLayout } from '../src/paths.mjs';
import { fixture, call, code } from './helpers.mjs';

function runtimeLayoutAt(dir) {
  const previous = process.env.OMP_RUNTIME_DIR; process.env.OMP_RUNTIME_DIR = dir;
  try { return runtimeLayout('/nonexistent/agent'); }
  finally { if (previous === undefined) delete process.env.OMP_RUNTIME_DIR; else process.env.OMP_RUNTIME_DIR = previous; }
}

test('canonical JSON is order-independent and rejects nonfinite values', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 })); assert.throws(() => stable({ n: NaN }), code('NON_FINITE'));
});
test('invalid and unknown runtime configuration fails closed', () => {
  for (const raw of [{ maxEffects: -1 }, { maxToolCalls: NaN }, { maxWallMs: 0 }]) assert.throws(() => runtimeConfig(raw), code('INVALID_RUNTIME_BUDGET'));
  assert.throws(() => runtimeConfig({ permission: 'yolo' }), code('UNKNOWN_RUNTIME_CONFIG_KEY'));
  assert.throws(() => runtimeConfig({ mode: 'trust-me' }), code('INVALID_RUNTIME_MODE'));
  assert.throws(() => runtimeConfig({ headlessEffects: 'maybe' }), code('INVALID_HEADLESS_POLICY'));
  assert.equal(runtimeConfig().mode, 'enforce');
});
test('unknown tools and misleading MCP names are effects; only exact allowlisted names read', () => {
  assert.equal(classify(call({ toolName: 'mcp__production_get_and_delete' })).kind, 'opaque-exec');
  assert.equal(classify(call({ toolName: 'brand_new_tool_from_upgrade' })).kind, 'opaque-exec');
  assert.equal(classify(call({ toolName: 'mcp__clab_mem_mem_search' }), { memoryReadTools: ['mcp__clab_mem_mem_search'] }).kind, 'read');
  assert.equal(isEffect(classify(call({ toolName: 'todo', input: {} }))), false);
  assert.equal(isEffect(classify(call({ toolName: 'task', input: {} }))), true);
});
test('headless effects follow the operator policy: allowed and journaled by default, deniable', () => {
  assert.deepEqual(decision(call({ hasUI: false }), { kind: 'opaque-exec' }, runtimeConfig()), { allow: true, requiresApproval: false });
  assert.equal(decision(call({ hasUI: false }), { kind: 'opaque-exec' }, runtimeConfig({ headlessEffects: 'deny' })).reason, 'HEADLESS_EFFECT');
  assert.equal(decision(call({ hasUI: false, toolName: 'grep' }), { kind: 'read' }, runtimeConfig({ headlessEffects: 'deny' })).allow, true);
});
test('runtime approval is opt-in per tool and needs an interactive UI', () => {
  const config = runtimeConfig({ requireApproval: ['eval'] });
  assert.deepEqual(decision(call({ toolName: 'eval' }), { kind: 'opaque-exec' }, config), { allow: true, requiresApproval: true });
  assert.equal(decision(call({ toolName: 'eval', hasUI: false }), { kind: 'opaque-exec' }, config).reason, 'INTERACTIVE_APPROVAL_REQUIRED');
  assert.equal(decision(call({ toolName: 'bash' }), { kind: 'opaque-exec' }, config).requiresApproval, false);
});
test('clab interactive exception requires trusted target fingerprint', () => {
  const op = { kind: 'kubernetes', target: 'clab-cluster', scope: 'namespace/test', targetFingerprint: 'fingerprint-12345' };
  const config = { targets: { 'clab-cluster': 'fingerprint-12345' } };
  assert.deepEqual(decision(call(), op, config), { allow: true, requiresApproval: false });
  assert.equal(decision(call({ hasUI: false }), op, config).reason, 'HEADLESS_INFRA_MUTATION');
  assert.equal(decision(call(), { ...op, targetFingerprint: 'evil' }, config).reason, 'TARGET_IDENTITY_MISMATCH');
  assert.equal(decision(call(), { ...op, highRisk: true }, config).requiresApproval, true);
});
test('other targets need point-of-action approval', () => {
  const op = { kind: 'gitops', target: 'production', scope: 'repo/manifests', targetFingerprint: 'fingerprint-12345' };
  assert.deepEqual(decision(call(), op, { targets: { production: 'fingerprint-12345' } }), { allow: true, requiresApproval: true });
});
test('model supplied operation descriptor is not trusted', () => {
  assert.throws(() => classify(call({ operation: { kind: 'read' } })), code('UNTRUSTED_OPERATION_DESCRIPTOR'));
});
test('approval hash binds input, session and epoch', () => {
  const c = call(), op = { kind: 'opaque-exec' }, lease = { session: 's', epoch: 1 };
  assert.notEqual(approvalHash(c, op, lease), approvalHash({ ...c, input: { command: 'changed' } }, op, lease));
  assert.notEqual(approvalHash(c, op, lease), approvalHash(c, op, { session: 's', epoch: 2 }));
  assert.notEqual(approvalHash(c, op, lease), approvalHash(c, op, { session: 'other', epoch: 1 }));
});
test('file evidence detects modifications outside its excerpt too', async t => {
  const f = await fixture(t); const e = captureEvidence(f.root, 'source.txt', 1, 1);
  assert.equal(verifyEvidence(f.root, e), true);
  writeFileSync(join(f.root, 'source.txt'), 'first\nCHANGED\nthird\n'); assert.equal(verifyEvidence(f.root, e), false);
});
test('evidence rejects parent traversal, symlinks, and secret paths', async t => {
  const f = await fixture(t);
  assert.throws(() => captureEvidence(f.root, '../outside', 1, 1), code('PATH_ESCAPE'));
  symlinkSync('source.txt', join(f.root, 'link')); assert.throws(() => captureEvidence(f.root, 'link'), code('SYMLINK_PATH'));
  writeFileSync(join(f.root, '.env'), 'SECRET=x'); assert.throws(() => captureEvidence(f.root, '.env'), code('SENSITIVE_PATH'));
});
test('evidence rejects invalid ranges and obvious secrets', async t => {
  const f = await fixture(t);
  assert.throws(() => captureEvidence(f.root, 'source.txt', 0, 1), code('INVALID_RANGE'));
  assert.throws(() => captureEvidence(f.root, 'source.txt', 1, 100), code('RANGE_OUT_OF_BOUNDS'));
  writeFileSync(join(f.root, 'source.txt'), 'Bearer abcdefghijklmnopqrst');
  assert.throws(() => captureEvidence(f.root, 'source.txt', 1, 1), code('POSSIBLE_SECRET'));
});
test('zvec freshness header is parsed and never assumed', () => {
  assert.equal(zvecFreshness('freshness: possibly_stale\nx.ts:1-4'), 'possibly_stale');
  assert.equal(zvecFreshness('no header'), 'unknown');
});
test('workspace search is bounded by revision, not refusal; query groups are capped', async t => {
  const f = await fixture(t); const search = input => f.kernel.intent(call({ toolCallId: digest(input), toolName: 'mcp__zvec_grep_search', input }));
  const revised = await search({ root: f.root, query: 'x', limit: 50, hidden: true, noIgnore: true });
  assert.deepEqual(revised.input, { root: f.root, query: 'x', limit: 10, autoUpdate: false });
  assert.deepEqual((await search({ root: f.root, query: 'y' })).input, { root: f.root, query: 'y', limit: 5, autoUpdate: false });
  assert.equal(await search({ root: f.root, query: 'z', limit: 5, autoUpdate: false }), undefined);
  assert.match((await search({ root: f.root, queries: ['a', 'b', 'c', 'd'] })).reason, /TOO_MANY_QUERY_GROUPS/);
  await search({ root: f.base, query: 'foreign' });
  assert.equal(f.store.events(f.workspace.id).some(e => e.kind === 'search.foreign_root'), true);
});
test('ordinary literal workspace writes and in-tree edits are workspace-write; the rest is opaque', async t => {
  const f = await fixture(t);
  assert.equal(classify(call({ toolName: 'write', input: { path: 'new/source.ts', content: 'export const n = 1;' } }), {}, f.root).kind, 'workspace-write');
  assert.equal(classify(call({ toolName: 'edit', input: { path: 'source.txt', old_string: 'a', new_string: 'b' } }), {}, f.root).kind, 'workspace-write');
  assert.equal(classify(call({ toolName: 'edit', input: { path: '../outside', old_string: 'a', new_string: 'b' } }), {}, f.root).kind, 'opaque-write');
  for (const input of [{ path: 'AGENTS.md', content: 'replace policy' }, { path: '.omp/config.yml', content: 'tools: {}' }, { path: '../outside', content: 'x' }, { path: 'xd://exec', content: 'x' }, { path: 'script.sh', content: '#!/bin/sh\necho x' }]) {
    assert.equal(classify(call({ toolName: 'write', input }), {}, f.root).kind, 'opaque-write');
  }
});
test('dangling symlink cannot obtain workspace-write classification', async t => {
  const f = await fixture(t); symlinkSync('/nonexistent-runtime-target', join(f.root, 'dangling'));
  assert.equal(classify(call({ toolName: 'write', input: { path: 'dangling', content: 'x' } }), {}, f.root).kind, 'opaque-write');
});
test('a runtime dir that is a symlink into the workspace is refused as journal location', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, '.hidden-runtime')); symlinkSync(join(f.root, '.hidden-runtime'), join(f.base, 'runtime-link'));
  assert.throws(() => journalPath(runtimeLayoutAt(join(f.base, 'runtime-link')), f.root), code('STATE_MUST_BE_OUTSIDE_WORKSPACE'));
  // The workspace sitting inside the runtime tree (plain or via a symlink to its parent) is the other direction.
  assert.throws(() => journalPath(runtimeLayoutAt(f.base), f.root), code('STATE_MUST_BE_OUTSIDE_WORKSPACE'));
  symlinkSync(f.base, join(f.base, 'parent-link'));
  assert.throws(() => journalPath(runtimeLayoutAt(join(f.base, 'parent-link')), f.root), code('STATE_MUST_BE_OUTSIDE_WORKSPACE'));
  assert.match(journalPath(runtimeLayoutAt(join(f.base, 'runtime-outside')), f.root), /runtime-outside\/journals\/[0-9a-f]{64}\.sqlite$/);
});
test('sensitive reads are journaled for audit without being blocked', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'src'));
  assert.equal(sensitiveRead(f.root, 'src/a.ts:10-20'), false); assert.equal(sensitiveRead(f.root, '.'), false);
  for (const path of ['.env', '../secrets', '/etc/passwd', '.omp/config.yml', 'keys/server.pem']) assert.equal(sensitiveRead(f.root, path), true, path);
  assert.equal(await f.kernel.intent(call({ toolName: 'read', input: { path: '/etc/hosts' } })), undefined);
  assert.equal(f.store.events(f.workspace.id).filter(e => e.kind === 'read.sensitive').length, 1);
});
