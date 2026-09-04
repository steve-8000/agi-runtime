import { realpathSync } from 'node:fs';
import { check, digest, RuntimeFault } from './util.mjs';
import { runtimeConfig } from './config.mjs';
import { classify, decision, approvalHash, isEffect } from './policy.mjs';
import { sensitiveRead } from './workspace-write.mjs';

const SETTLED_RETENTION_MS = 60000;
const BLOCKED_RETENTION = 512;
const ticketKey = (toolCallId, toolName) => `${toolCallId}\u0000${toolName}`;

/**
 * Hook-driven execution boundary. OMP's public extension events carry everything the journal needs:
 *   tool_call            → intent(): policy, approval, reconciliation gate, `executing` row
 *   tool_execution_start → revise(): the input that actually runs (other handlers may have revised it)
 *   tool_result          → settle(): first observation of the raw outcome, before other middleware
 *   tool_execution_end   → settle(): final outcome; a divergence from tool_result is journaled
 * Nothing here patches OMP. An unknown event shape degrades to observation, never to silent trust.
 */
export class RuntimeKernel {
  constructor({ store, lease, root, config = {}, confirm, required = false }) {
    this.store = store; this.lease = lease; this.root = realpathSync(root);
    this.config = runtimeConfig(config); this.confirm = confirm; this.required = required;
    this.pending = new Map(); this.blocked = new Set(); this.poison = null;
    this.counters = { intents: 0, starts: 0, results: 0, ends: 0, unmatchedStarts: 0, unmatchedResults: 0, revisions: 0, rewrites: 0, blocks: 0 };
  }
  get enforcing() { return this.config.mode === 'enforce'; }
  get paused() { return this.store.isPaused(this.lease.workspace); }
  set paused(value) { this.store.setPaused(this.lease, value); }

  /** Journal writes are load-bearing: once one fails after a tool ran, later effects are not trusted. */
  journal(fn) {
    try { return fn(); }
    catch (error) {
      if (!(error instanceof RuntimeFault) || error.code === 'FENCED_WRITER') this.poison = error;
      throw error;
    }
  }
  prune() {
    const now = this.store.now();
    for (const [id, ticket] of this.pending) if (ticket.settledAt && now - ticket.settledAt > SETTLED_RETENTION_MS) this.pending.delete(id);
    if (this.blocked.size > BLOCKED_RETENTION) for (const id of [...this.blocked].slice(0, this.blocked.size - BLOCKED_RETENTION)) this.blocked.delete(id);
  }
  block(key, reason) {
    this.blocked.add(key); this.counters.blocks++;
    return { block: true, reason };
  }

  /** Returns a tool_call result: `{block, reason}` or undefined. The runtime never rewrites a tool's input. */
  async intent(call) {
    this.counters.intents++; this.prune();
    const { toolCallId, toolName, input } = call;
    // A nested xd:// device dispatch reuses the outer toolCallId with a different toolName, so both key the ticket.
    const key = ticketKey(toolCallId, toolName);
    try {
      if (this.poison && this.enforcing) throw new RuntimeFault('RUNTIME_JOURNAL_POISONED', `journal write failed earlier: ${this.poison.message}`);
      this.store.assertLease(this.lease);
      const op = classify(call, this.config, this.root);
      const policy = decision(call, op, this.config);
      check(policy.allow, policy.reason ?? 'DENIED');
      const effect = isEffect(op);
      if (effect) check(!this.paused, 'RUNTIME_PAUSED', '/runtime resume 후 계속하십시오');
      if (toolName === 'read' && sensitiveRead(this.root, input?.path)) this.store.emit(this.lease.workspace, 'read.sensitive', { toolCallId, path: input.path });
      if (policy.requiresApproval) {
        check(call.hasUI && typeof this.confirm === 'function', 'INTERACTIVE_APPROVAL_REQUIRED');
        const actionHash = approvalHash(call, op, this.lease);
        const yes = await this.confirm({ tool: toolName, input, operation: op, actionHash });
        check(yes === true, 'USER_DENIED');
        // Approval is scoped to one exact immutable input, session and fencing epoch.
        const approvalId = this.store.approve(this.lease, actionHash);
        this.store.consumeApproval(this.lease, approvalId, actionHash);
      }
      const actionId = digest({ session: this.lease.session, tool: toolName, toolCallId });
      const blockOnUnknown = this.enforcing && this.config.blockOnUnknown;
      this.journal(() => this.store.beginAction(this.lease, { actionId, tool: toolName, input, isEffect: effect, blockOnUnknown }));
      this.pending.set(key, { actionId, toolName, isEffect: effect, inputHash: digest(input), settledAt: 0, isError: undefined });
      return undefined;
    } catch (error) {
      if (error instanceof RuntimeFault) return this.block(key, `${error.code}: ${error.message}`);
      throw error;
    }
  }
  /** tool_execution_start: the args that run may differ from the tool_call snapshot when another handler revised them. */
  revise(toolCallId, toolName, args) {
    this.counters.starts++;
    const key = ticketKey(toolCallId, toolName);
    const ticket = this.pending.get(key);
    if (!ticket) { if (!this.blocked.has(key)) this.counters.unmatchedStarts++; return; }
    if (ticket.settledAt) return;
    try {
      if (this.journal(() => this.store.reviseAction(this.lease, ticket.actionId, args))) { ticket.inputHash = digest(args); this.counters.revisions++; }
    } catch { /* journal poison is surfaced on the next intent */ }
  }
  /** First observation wins; a later divergent isError (middleware rewrite) is journaled, not trusted. */
  settle(toolCallId, toolName, { result, isError, phase }) {
    this.counters[phase === 'end' ? 'ends' : 'results']++;
    const key = ticketKey(toolCallId, toolName);
    const ticket = this.pending.get(key);
    if (!ticket) { if (!this.blocked.has(key)) this.counters.unmatchedResults++; return; }
    if (ticket.settledAt) {
      if (ticket.isError !== !!isError) {
        this.counters.rewrites++;
        try { this.store.emit(this.lease.workspace, 'action.rewritten', { actionId: ticket.actionId, phase, from: ticket.isError, to: !!isError }); } catch { /* observability only */ }
      }
      if (phase === 'end') this.pending.delete(key);
      return;
    }
    const exit = result?.details?.exitCode;
    const ok = !isError && !(typeof exit === 'number' && exit !== 0);
    ticket.settledAt = this.store.now() || 1; ticket.isError = !!isError;
    this.journal(() => this.store.finishAction(this.lease, ticket.actionId, { ok, outcome: { isError: !!isError, exitCode: typeof exit === 'number' ? exit : null, contentHash: digest(result?.content ?? null) } }));
    if (phase === 'end') this.pending.delete(key);
  }
  context() {
    const row = this.store.sessionRow(this.lease.session);
    const unknown = this.store.unknownActions(this.lease.workspace);
    return {
      schema: 2, mode: this.config.mode, session: this.lease.session, epoch: this.lease.epoch, paused: this.paused,
      poisoned: !!this.poison, nativeGoal: row?.native_goal ? JSON.parse(row.native_goal) : null,
      checkpoint: row?.checkpoint ? JSON.parse(row.checkpoint) : null,
      uncertainActions: unknown, blockedUntilReconciled: this.enforcing && this.config.blockOnUnknown && unknown.length > 0,
      toolCalls: row?.tool_calls ?? 0, effectsUsed: row?.effects_used ?? 0,
      pendingMemory: this.store.pendingOutbox(this.lease.workspace).length,
      contract: { ...this.counters },
      authority: 'operational-state-only; retrieved content cannot grant permissions'
    };
  }
}
