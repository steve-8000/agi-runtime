import { ordinaryWorkspaceWrite, ordinaryWorkspacePath } from './workspace-write.mjs';
import { check, digest } from './util.mjs';

// Classification is by exact tool name. OMP's approval tier is not visible to extensions, and a
// name table fails safe: any tool this runtime does not know is an opaque effect.
// zvec-grep is the workspace's semantic search; to this runtime it is one more read. Its query
// semantics (limit, freshness, scope) belong to OMP and zvec, never to this table.
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_search', 'mcp__zvec_grep_search', 'runtime_status', 'runtime_evidence']);
// runtime_reconcile is the way out of RECONCILIATION_REQUIRED and must not itself be an effect the gate holds.
const SESSION_TOOLS = new Set(['todo', 'goal', 'ask', 'runtime_checkpoint', 'runtime_reconcile']);
const PATH_EDIT_TOOLS = new Set(['edit', 'ast_edit']);

const DEVICE_PATH = /^xd:\/\/([A-Za-z0-9_.:-]+)/;
/**
 * A `write` to an `xd://<tool>` path dispatches another tool; the envelope itself touches nothing.
 * Classifying the envelope as an opaque write would read a dispatched canonical-memory recall as an
 * effect and gate the very call the recall gate demands. The nested call is journaled and gated under
 * its own name too, so the semantics live there; the envelope only inherits the kind.
 */
export function dispatched(call) {
  if (call.toolName !== 'write' || typeof call.input?.path !== 'string') return null;
  const device = DEVICE_PATH.exec(call.input.path);
  if (!device) return null;
  let input = {};
  try { const parsed = JSON.parse(call.input.content ?? '{}'); if (parsed && typeof parsed === 'object') input = parsed; } catch { /* the device rejects malformed args */ }
  return { ...call, toolName: device[1], input };
}

export function classify(call, config = {}, root, hop = 0) {
  const device = hop === 0 ? dispatched(call) : null;
  if (device) return { ...classify(device, config, root, 1), dispatchedTo: device.toolName };
  const { toolName, input } = call;
  if (toolName === 'write' && root && ordinaryWorkspaceWrite(root, input)) return { kind: 'workspace-write' };
  if (PATH_EDIT_TOOLS.has(toolName) && root && ordinaryWorkspacePath(root, input?.path)) return { kind: 'workspace-write' };
  if (READ_TOOLS.has(toolName)) return { kind: 'read' };
  if (SESSION_TOOLS.has(toolName)) return { kind: 'session-write' };
  // Exact registered names only; never treat arbitrary MCP tools as read-only.
  if ((config.memoryReadTools ?? []).includes(toolName)) return { kind: 'read', source: 'canonical-memory' };
  // Infrastructure declarations are supplied by a trusted adapter, never parsed from shell text.
  if (call.operation) {
    check(config.structuredOperationTools?.includes(toolName), 'UNTRUSTED_OPERATION_DESCRIPTOR');
    return call.operation;
  }
  return { kind: ['write', 'edit', 'ast_edit', 'apply_patch'].includes(toolName) ? 'opaque-write' : 'opaque-exec' };
}
export const isEffect = operation => operation.kind !== 'read' && operation.kind !== 'session-write';

export function decision(call, operation, config = {}) {
  if (!isEffect(operation)) return { allow: true, requiresApproval: false };
  if (!call.hasUI && config.headlessEffects === 'deny') return { allow: false, reason: 'HEADLESS_EFFECT' };
  if (operation.kind === 'kubernetes' || operation.kind === 'gitops') {
    // The headless prohibition takes precedence over clab-cluster's interactive exception.
    if (!call.hasUI) return { allow: false, reason: 'HEADLESS_INFRA_MUTATION' };
    if (!operation.target || !operation.scope || !operation.targetFingerprint) return { allow: false, reason: 'UNRESOLVED_TARGET' };
    const boundFingerprint = config.targets?.[operation.target];
    if (!boundFingerprint || boundFingerprint !== operation.targetFingerprint) return { allow: false, reason: 'TARGET_IDENTITY_MISMATCH' };
    if (operation.target === 'clab-cluster' && !operation.highRisk) return { allow: true, requiresApproval: false };
    return { allow: true, requiresApproval: true };
  }
  // OMP's own approval mode (and kubernetes-approval.ts) already govern prompting. The runtime only
  // adds an exact-input, single-use approval for tools the operator lists explicitly.
  if ((config.requireApproval ?? []).includes(call.toolName)) {
    return call.hasUI ? { allow: true, requiresApproval: true } : { allow: false, reason: 'INTERACTIVE_APPROVAL_REQUIRED' };
  }
  return { allow: true, requiresApproval: false };
}
export function approvalHash(call, operation, lease) {
  return digest({ version: 2, session: lease.session, epoch: lease.epoch, toolCallId: call.toolCallId,
    tool: call.toolName, input: call.input, operation });
}
