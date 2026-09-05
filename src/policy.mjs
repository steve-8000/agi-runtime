import { ordinaryWorkspaceWrite, ordinaryWorkspacePath } from './workspace-write.mjs';
import { check, digest } from './util.mjs';

// Classification is by exact tool name. OMP's approval tier is not visible to extensions, and a
// name table fails safe: any tool this runtime does not know is an opaque effect.
// zvec-grep is the workspace's semantic search; to this runtime it is one more read. Its query
// semantics (limit, freshness, scope) belong to OMP and zvec, never to this table.
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_search', 'mcp__zvec_grep_search', 'runtime_status', 'runtime_evidence']);
// runtime_reconcile is the way out of RECONCILIATION_REQUIRED and must not itself be an effect the gate holds.
const SESSION_TOOLS = new Set(['todo', 'goal', 'ask', 'runtime_checkpoint', 'runtime_memory_candidate', 'runtime_reconcile']);
const PATH_EDIT_TOOLS = new Set(['edit', 'ast_edit']);

export function classify(call, config = {}, root) {
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
