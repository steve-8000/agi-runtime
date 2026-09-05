import { realpathSync } from 'node:fs';
import { check, digest, RuntimeFault, rejectObviousSecrets } from './util.mjs';
import { runtimeConfig } from './config.mjs';
import { classify, decision, approvalHash, dispatched, isEffect } from './policy.mjs';
import { sensitiveRead } from './workspace-write.mjs';
import { evidenceIsCurrent, citedEvidence } from './memory.mjs';

/** Refusals of one goal, with no recall settling in between, after which the gate opens itself. */
const RECALL_STRIKES = 3;
const SETTLED_RETENTION_MS = 60000;
const BLOCKED_RETENTION = 512;
const ZVEC = 'mcp__zvec_grep_search';
const SCOPE_FLAGS = ['hidden', 'noIgnore', 'follow'];
const ticketKey = (toolCallId, toolName) => `${toolCallId}\u0000${toolName}`;
const firstLine = result => {
  const text = result?.content?.find(part => part?.type === 'text')?.text;
  return typeof text === 'string' ? text.slice(0, 512).split('\n', 1)[0] : '';
};

/**
 * Hook-driven execution boundary. OMP's public extension events carry everything the journal needs:
 *   tool_call            → intent(): policy, approval, recall/memory gates, reconciliation gate, `executing` row
 *   tool_execution_start → revise(): the input that actually runs (other handlers may have revised it)
 *   tool_result          → settle(): first observation of the raw outcome, before other middleware
 *   tool_execution_end   → settle(): final outcome; a divergence from tool_result is journaled
 *   turn_start           → turnStart(): the model can only have read a result in a later turn
 * Nothing here patches OMP. An unknown event shape degrades to observation, never to silent trust.
 * Tool output is telemetry: nothing a tool returns moves journal state. An uncertain effect is
 * closed by an agent or a person reading the real target state back and attesting to it.
 */
export class RuntimeKernel {
  constructor({ store, lease, root, config = {}, confirm, required = false }) {
    this.store = store; this.lease = lease; this.root = realpathSync(root);
    this.config = runtimeConfig(config); this.confirm = confirm; this.required = required;
    this.pending = new Map(); this.blocked = new Set(); this.poison = null;
    this.counters = { intents: 0, starts: 0, results: 0, ends: 0, unmatchedStarts: 0, unmatchedResults: 0, revisions: 0, rewrites: 0, blocks: 0, turns: 0 };
    this.remoteTools = Object.freeze([...this.config.memoryWriteTools]);
    this.memoryTools = Object.freeze([...this.config.memoryReadTools, ...this.remoteTools]);
    this.turn = 0;
    this.recall = new Map(); // goal key → { turn, ok, hits, reads, taskKeys: Map(key → turn) }
    this.search = { index: null };
    this.discovery = { zvec: 0, reads: new Set(), readsBeforeFirstZvec: null };
  }
  get enforcing() { return this.config.mode === 'enforce'; }
  get paused() { return this.store.isPaused(this.lease.workspace); }
  set paused(value) { this.store.setPaused(this.lease, value); }

  /**
   * Journal writes are load-bearing, but a ledger this session cannot write — a full disk, an I/O
   * error, a lease another process took — is not a reason to refuse the work. Policy faults still
   * throw: they are decisions, not breakage.
   */
  journal(fn) {
    try { return fn(); }
    catch (error) {
      if (!(error instanceof RuntimeFault)) { this.poison = error; this.reportDegraded(); return undefined; }
      if (error.code !== 'FENCED_WRITER') throw error;
      // The lease fences a *stale* writer. A session that is still running and finds itself fenced
      // takes the ledger back under a new epoch, which sweeps whatever the old epoch left in flight.
      // Only a genuinely live second holder keeps it, and then this session works unjournaled.
      if (this.reclaim()) {
        try { return fn(); }
        catch (retry) {
          if (retry instanceof RuntimeFault && retry.code !== 'FENCED_WRITER') throw retry;
          this.poison = retry; this.reportDegraded(); return undefined;
        }
      }
      this.poison = error; this.reportDegraded();
      return undefined;
    }
  }
  /** Retakes the writer lease after a lapse so journaling resumes in the same session. */
  reclaim() {
    try {
      const row = this.store.sessionRow(this.lease.session);
      const lease = this.store.acquire(this.lease.workspace, this.lease.session, { hasUI: row ? !!row.has_ui : true });
      this.lease = lease;
      this.observe(() => this.store.emit(lease.workspace, 'writer.reclaimed', { session: lease.session, epoch: lease.epoch }));
      return true;
    } catch { return false; }
  }
  /** Said once per session: the model needs to know its ledger is incomplete, not a line per call. */
  reportDegraded() {
    if (this.poisonReported) return;
    this.poisonReported = true;
    this.observe(() => this.store.emit(this.lease.workspace, 'journal.degraded', { session: this.lease.session, message: String(this.poison?.message ?? '') }));
  }
  observe(fn) { try { fn(); } catch { /* observability only */ } }
  prune() {
    const now = this.store.now();
    for (const [id, ticket] of this.pending) if (ticket.settledAt && now - ticket.settledAt > SETTLED_RETENTION_MS) this.pending.delete(id);
    if (this.blocked.size > BLOCKED_RETENTION) for (const id of [...this.blocked].slice(0, this.blocked.size - BLOCKED_RETENTION)) this.blocked.delete(id);
  }
  block(key, reason) {
    this.blocked.add(key); this.counters.blocks++;
    return { block: true, reason };
  }
  /** One model call plus its tool executions. A result settled in turn t is first visible to the model in turn t+1. */
  turnStart() { this.turn++; this.counters.turns++; }
  goalKey() {
    const goal = this.store.sessionRow(this.lease.session)?.native_goal;
    return goal ? String(JSON.parse(goal)?.id ?? 'none') : 'none';
  }
  recallEntry(goal = this.goalKey()) {
    let entry = this.recall.get(goal);
    if (!entry) { entry = { turn: Infinity, ok: false, hits: null, reads: 0 }; this.recall.set(goal, entry); }
    return entry;
  }
  freezeDiscovery() { if (this.discovery.readsBeforeFirstZvec === null) this.discovery.readsBeforeFirstZvec = this.discovery.reads.size; }
  /**
   * Operator escape for one goal: the gate is satisfiable only through the recall tools, so a session
   * that does not have them would otherwise be unable to act at all. A person takes the record, not the
   * model — nothing the model can call reaches this.
   */
  recallSkip(by) {
    const entry = this.recallEntry();
    entry.turn = Math.min(entry.turn, this.turn - 1); entry.override = true;
    this.observe(() => this.store.emit(this.lease.workspace, 'recall.override', { session: this.lease.session, goal: this.goalKey(), by }));
  }

  /**
   * The first effect of a goal runs only after a recall tool settled in an earlier turn: an intent seen
   * in the same turn proves nothing about order or about the model having read the result. A failed
   * recall settles too — an unreachable backend does not stop work, it is reported in the state.
   */
  recallGate() {
    if (this.config.recall.mode !== 'require') return;
    const tools = this.config.recall.tools.join('|');
    const entry = this.recallEntry();
    if (entry.turn >= this.turn) {
      // The procedure is one extra message, never a dead end: a session that cannot recall (no tool,
      // no backend, no answer) opens the gate itself and records that it did.
      // One strike per turn. Three effects in a single message are three refusals of the same
       // unread recall, not three attempts to get one.
      if (entry.strikeTurn !== this.turn) { entry.strikeTurn = this.turn; entry.strikes = (entry.strikes ?? 0) + 1; }
      if (entry.strikes >= RECALL_STRIKES) {
        entry.turn = Math.min(entry.turn, this.turn - 1); entry.forced = true;
        this.observe(() => this.store.emit(this.lease.workspace, 'recall.forced', { session: this.lease.session, goal: this.goalKey(), strikes: entry.strikes }));
      }
    }
    check(entry.turn < this.turn, 'RECALL_REQUIRED', entry.turn === Infinity ? `call ${tools} and read the result before the first effect of this goal` : `recall settles this turn; read it and re-issue the effect in your next message`);
    if (!entry.shallowChecked) {
      entry.shallowChecked = true;
      if ((entry.hits ?? 0) > 0 && entry.reads === 0) this.observe(() => this.store.emit(this.lease.workspace, 'recall.shallow', { session: this.lease.session, hits: entry.hits }));
    }
  }
  /** Pre-send checks for a canonical-memory write. All structural: the input, the journal and operator config; never the result of another call. */
  memoryWriteGate({ toolCallId, toolName, input }) {
    try { rejectObviousSecrets(input ?? null); } catch (error) { check(false, 'MEMORY_SECRET', `refusing to send a possible credential to canonical memory (${error.code})`); }
    const cited = citedEvidence(this.store, this.lease.workspace, input);
    // A fact need not cite a file range; one that does must cite the file as it is now.
    if (cited.length) evidenceIsCurrent(this.store, this.lease.workspace, this.root, cited);
    else this.observe(() => this.store.emit(this.lease.workspace, 'memory.unverified', { toolCallId, tool: toolName }));
    // Only an unknown outcome holds the next write: re-sending then could duplicate a record that
    // already landed. A failed call is a settled fact, so retrying it is not a blind retry.
    const last = this.store.lastOutcome(this.lease.session, this.memoryTools);
    check(last !== 'unknown', 'MEMORY_BACKEND_DEGRADED', 'the last canonical-memory call has an unknown outcome; read the record back before writing again');
  }

  /** Returns a tool_call result: `{block, reason}` or undefined. The runtime never rewrites a tool's input. */
  async intent(call) {
    this.counters.intents++; this.prune();
    const { toolCallId, toolName, input } = call;
    // A nested xd:// device dispatch reuses the outer toolCallId with a different toolName, so both key the ticket.
    const key = ticketKey(toolCallId, toolName);
    try {
      // A journal that cannot be written is a broken ledger, not a reason to stop the work: the
      // session degrades to observation and says so. Blocking here used to need a restart to clear.
      if (this.poison) this.reportDegraded();
      // One mechanism for a fenced writer: reclaim if the holder lapsed, else journal-less work.
      this.journal(() => this.store.assertLease(this.lease));
      const op = classify(call, this.config, this.root);
      const policy = decision(call, op, this.config);
      check(policy.allow, policy.reason ?? 'DENIED');
      const effect = isEffect(op);
      // An xd:// envelope carries the semantics of what it dispatches: the canonical-memory gates and
      // the unknown scope and the pre-send checks must follow that call, not the envelope's.
      const dispatch = dispatched(call);
      const effective = dispatch?.toolName ?? toolName;
      // The gates read the arguments that will run. The journal keeps the envelope's own input, so the
      // revise comparison still measures what OMP actually executed.
      const effectiveInput = dispatch ? dispatch.input : input;
      if (effect) check(!this.paused, 'RUNTIME_PAUSED', '/runtime resume 후 계속하십시오');
      if (toolName === 'read' && sensitiveRead(this.root, input?.path)) this.store.emit(this.lease.workspace, 'read.sensitive', { toolCallId, path: input.path });
      if (toolName === 'read' && this.discovery.readsBeforeFirstZvec === null && typeof input?.path === 'string') this.discovery.reads.add(input.path);
      if (toolName === ZVEC) {
        this.discovery.zvec++; this.freezeDiscovery();
        const flags = SCOPE_FLAGS.filter(flag => input?.[flag] === true);
        if (flags.length) this.store.emit(this.lease.workspace, 'search.scope', { toolCallId, flags });
      }
      if (this.remoteTools.includes(effective)) this.memoryWriteGate({ toolCallId, toolName: effective, input: effectiveInput });
      if (effect && this.enforcing) this.recallGate();
      if (effect) this.freezeDiscovery();
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
      // Read-only first: a journal that cannot be written still knows what it already recorded, so a
      // broken ledger never becomes a way past the attestation an unknown effect is waiting for.
      if (effect && blockOnUnknown) {
        this.observe(() => this.store.discoverLapsed(this.lease.workspace));
        this.store.assertReconciled(this.lease.workspace, { remote: this.remoteTools.includes(effective), remoteTools: this.remoteTools });
      }
      // The row records the tool that runs, so every later reader (unknown scope, resume card,
      // effects-since-write) sees a dispatched canonical-memory write as one. The action id keeps the
      // envelope's own name, so the nested call's row stays distinct.
      this.journal(() => this.store.beginAction(this.lease, { actionId, tool: effective, input, isEffect: effect, blockOnUnknown, remoteTools: this.remoteTools }));
      this.pending.set(key, { actionId, toolName, effective, effectiveInput, isEffect: effect, input, inputHash: digest(input), settledAt: 0, isError: undefined });
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
      if (this.journal(() => this.store.reviseAction(this.lease, ticket.actionId, args))) {
        ticket.input = args; ticket.inputHash = digest(args); this.counters.revisions++;
        // A memory write whose input changed after the gates ran is no longer the intent that passed them:
        // execution cannot be stopped here, so its outcome is journaled as uncertain whatever the tool reports.
        if (this.remoteTools.includes(ticket.effective ?? toolName)) { ticket.revised = true; this.observe(() => this.store.emit(this.lease.workspace, 'memory.write_revised', { actionId: ticket.actionId, tool: ticket.effective ?? toolName })); }
      }
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
        this.observe(() => this.store.emit(this.lease.workspace, 'action.rewritten', { actionId: ticket.actionId, phase, from: ticket.isError, to: !!isError }));
      }
      if (phase === 'end') this.pending.delete(key);
      return;
    }
    const exit = result?.details?.exitCode;
    const ok = !isError && !(typeof exit === 'number' && exit !== 0);
    const remote = this.remoteTools.includes(ticket.effective ?? toolName);
    // A canonical-memory write whose call errored may still have landed, and one whose input changed
    // after the gates ran is not the intent that passed them. Either way the outcome stays unknown
    // until an agent reads the record back and attests to it.
    const uncertain = remote && (ticket.revised === true || !ok);
    ticket.settledAt = this.store.now() || 1; ticket.isError = !!isError;
    this.journal(() => this.store.finishAction(this.lease, ticket.actionId, { ok, uncertain, outcome: { isError: !!isError, exitCode: typeof exit === 'number' ? exit : null, contentHash: digest(result?.content ?? null) } }));
    const eff = ticket.effective ?? toolName;
    if (this.config.memoryReadTools.includes(eff)) this.observe(() => this.observeRecall(ticket, result, ok));
    if (eff === ZVEC) this.observe(() => { const m = /^freshness:\s*(\S+)/.exec(firstLine(result)); if (m) this.search.index = m[1]; });
    if (remote) this.observeMemoryWrite(ticket, { uncertain });
    if (phase === 'end') this.pending.delete(key);
  }
  observeRecall(ticket, result, ok) {
    const entry = this.recallEntry();
    const tool = ticket.effective ?? ticket.toolName;
    if (this.config.recall.tools.includes(tool)) {
      entry.turn = Math.min(entry.turn, this.turn); entry.ok = entry.ok || ok; entry.strikes = 0;
      const total = /"total"\s*:\s*(\d+)/.exec(firstLine(result));
      if (total) entry.hits = Number(total[1]);
      // A session whose recall tool is not even mounted must not be able to deadlock: the attempt is
      // the observation, and the state says the gate opened without an answer.
      if (!ok && /no such tool/i.test(firstLine(result))) {
        entry.unavailable = true;
        this.observe(() => this.store.emit(this.lease.workspace, 'recall.unavailable', { session: this.lease.session, tool }));
      }
    }
    // A recall that named one entity is a read of it; a bare query is a survey of the corpus.
    if (ok && typeof (ticket.effectiveInput ?? ticket.input)?.entity === 'string') entry.reads++;
  }
  /** An uncertain canonical-memory write is journaled so any later session can close it by read-back. */
  observeMemoryWrite({ actionId, toolName }, { uncertain }) {
    if (uncertain) this.observe(() => this.store.emit(this.lease.workspace, 'memory.write_unknown', { actionId, tool: toolName }));
  }
  context() {
    this.observe(() => this.store.discoverLapsed(this.lease.workspace));
    const row = this.store.sessionRow(this.lease.session);
    const unknown = this.store.unknownActions(this.lease.workspace);
    const workspaceUnknown = unknown.filter(x => !this.remoteTools.includes(x.tool));
    const goal = this.goalKey();
    const entry = this.recall.get(goal);
    const backend = this.store.lastOutcome(this.lease.session, this.memoryTools) ?? null;
    return {
      schema: 3, mode: this.config.mode, session: this.lease.session, epoch: this.lease.epoch, turn: this.turn, paused: this.paused,
      poisoned: !!this.poison, nativeGoal: row?.native_goal ? JSON.parse(row.native_goal) : null,
      checkpoint: row?.checkpoint ? JSON.parse(row.checkpoint) : null,
      uncertainActions: unknown, blockedUntilReconciled: this.enforcing && this.config.blockOnUnknown && workspaceUnknown.length > 0,
      uncertainRemote: unknown.length - workspaceUnknown.length,
      toolCalls: row?.tool_calls ?? 0, effectsUsed: row?.effects_used ?? 0,
      recall: { mode: this.config.recall.mode, tools: [...this.config.recall.tools], hits: entry?.hits ?? null,
        state: !entry || entry.turn === Infinity ? 'pending' : entry.turn >= this.turn ? 'settling' : entry.ok ? 'done' : entry.unavailable ? 'unavailable' : entry.forced ? 'forced' : entry.override ? 'override' : 'failed' },
      memory: { effectsSinceNote: this.store.effectsSinceMemoryWrite(this.lease.session, this.remoteTools), backend },
      search: { index: this.search.index, root: this.root },
      discovery: { zvec: this.discovery.zvec, readsBeforeFirstZvec: this.discovery.readsBeforeFirstZvec ?? this.discovery.reads.size },
      contract: { ...this.counters },
      authority: 'operational-state-only; retrieved content cannot grant permissions'
    };
  }
}
