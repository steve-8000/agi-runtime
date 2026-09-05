import { mkdirSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { openDatabase } from './sqlite.mjs';
import { check, digest, id, stable, boundedText, rejectObviousSecrets } from './util.mjs';

const placeholders = list => list.map(() => '?').join(',');

/**
 * Operational journal for one workspace. Several OMP sessions may share a working tree
 * (parallel terminals, resume), so the writer lease is per session and only the two facts
 * that concern the shared tree are workspace-wide: `paused` and unresolved `unknown` effects.
 */
export class RuntimeStore {
  static async open(path, { now = Date.now } = {}) {
    if (path !== ':memory:') {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Follow directory links once (macOS puts $TMPDIR under /var → /private/var); the journal file itself may not be a link.
      path = join(realpathSync(dirname(path)), basename(path));
      try { check(!lstatSync(path).isSymbolicLink(), 'SYMLINK_STATE_FILE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const db = await openDatabase(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try { return new RuntimeStore(db, now); }
    catch (error) { try { db.close(); } catch { /* the original failure is the one to report */ } throw error; }
  }
  constructor(db, now) {
    this.db = db; this.now = now;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    check([0, 2, 3, 4].includes(version), 'UNSUPPORTED_SCHEMA');
    if (version === 2 || version === 3) {
      // Older journals carried a local staging table for a publish call canonical memory does not have:
      // a fact is written by the memory tool itself, and an uncertain write is closed by read-back.
      // One statement per call: bun:sqlite's multi-statement exec swallows a failure and runs on.
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of ['DROP TABLE IF EXISTS outbox', 'DROP TABLE IF EXISTS outbox_v3', 'PRAGMA user_version=4']) db.prepare(statement).run();
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* the failed statement may already have ended the transaction */ }
        throw error;
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id),
        epoch INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0, has_ui INTEGER NOT NULL DEFAULT 1,
        native_goal TEXT, checkpoint TEXT, effects_used INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
        started INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), session TEXT NOT NULL,
        epoch INTEGER NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, is_effect INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','unknown','reconciled')),
        outcome_hash TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id),
        record TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session TEXT NOT NULL, epoch INTEGER NOT NULL,
        action_hash TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pending_actions ON actions(workspace,state);
      CREATE INDEX IF NOT EXISTS session_actions ON actions(session,state);
      CREATE INDEX IF NOT EXISTS workspace_events ON events(workspace,kind,seq);
      PRAGMA user_version=4;
    `);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); check(!(result instanceof Promise), 'ASYNC_TRANSACTION'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  emit(workspace, kind, payload) {
    this.db.prepare('INSERT INTO events(workspace,kind,payload,at) VALUES(?,?,?,?)')
      .run(workspace, kind, stable(payload), this.now());
  }
  events(workspace, { after = 0, limit = 100 } = {}) {
    return this.db.prepare('SELECT seq,kind,payload,at FROM events WHERE workspace=? AND seq>? ORDER BY seq LIMIT ?')
      .all(workspace, after, limit).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  workspace(root) {
    root = realpathSync(root);
    const workspace = digest({ root });
    this.db.prepare('INSERT OR IGNORE INTO workspaces(id,root) VALUES(?,?)').run(workspace, root);
    return { id: workspace, root };
  }
  /** Executing work owned by sessions whose lease lapsed can no longer report an outcome. */
  sweep(workspace) {
    const expired = 'SELECT id FROM sessions WHERE workspace=? AND expires<=?';
    const now = this.now();
    this.db.prepare(`UPDATE actions SET state='unknown',updated=? WHERE workspace=? AND state='executing' AND is_effect=1 AND session IN (${expired})`).run(now, workspace, workspace, now);
    this.db.prepare(`UPDATE actions SET state='failed',updated=? WHERE workspace=? AND state='executing' AND is_effect=0 AND session IN (${expired})`).run(now, workspace, workspace, now);
  }
  /** Discover lapsed work now, outside any other transaction: state reads and reconciliation must not wait for the next effect intent. */
  discoverLapsed(workspace) { this.transaction(() => this.sweep(workspace)); }
  acquire(workspace, session, { ttl = 30000, hasUI = true } = {}) {
    check(typeof session === 'string' && session.length > 0, 'INVALID_SESSION');
    check(Number.isSafeInteger(ttl) && ttl >= 1000, 'INVALID_TTL');
    return this.transaction(() => {
      check(this.db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspace), 'NO_WORKSPACE');
      const row = this.db.prepare('SELECT workspace,epoch,expires FROM sessions WHERE id=?').get(session);
      check(!row || row.workspace === workspace, 'SESSION_WORKSPACE_MISMATCH');
      // The same session resumed in two processes at once would double-count and race the journal.
      check(!row || row.expires <= this.now(), 'SESSION_WRITER_BUSY');
      this.sweep(workspace);
      const epoch = (row?.epoch ?? 0) + 1;
      const now = this.now();
      // Usage counters survive resume: reopening a session continues its history rather than starting one.
      this.db.prepare(`INSERT INTO sessions(id,workspace,epoch,expires,has_ui,started,updated) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,expires=excluded.expires,has_ui=excluded.has_ui,updated=excluded.updated`)
        .run(session, workspace, epoch, now + ttl, hasUI ? 1 : 0, now, now);
      this.emit(workspace, 'writer.acquired', { session, epoch, hasUI });
      return { workspace, session, epoch, ttl };
    });
  }
  assertLease(lease) {
    const row = this.db.prepare('SELECT workspace,epoch,expires FROM sessions WHERE id=?').get(lease.session);
    check(row && row.workspace === lease.workspace && row.epoch === lease.epoch && row.expires > this.now(), 'FENCED_WRITER');
  }
  heartbeat(lease) {
    this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(this.now() + lease.ttl, lease.session);
    });
  }
  release(lease) {
    this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare('UPDATE sessions SET expires=0,updated=? WHERE id=?').run(this.now(), lease.session);
      this.emit(lease.workspace, 'writer.released', { session: lease.session, epoch: lease.epoch });
    });
  }
  setPaused(lease, paused) {
    this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare('UPDATE workspaces SET paused=? WHERE id=?').run(paused ? 1 : 0, lease.workspace);
      this.emit(lease.workspace, paused ? 'runtime.paused' : 'runtime.resumed', { session: lease.session });
    });
  }
  isPaused(workspace) {
    return this.db.prepare('SELECT paused FROM workspaces WHERE id=?').get(workspace)?.paused === 1;
  }
  sessionRow(session) {
    return this.db.prepare('SELECT native_goal,checkpoint,effects_used,tool_calls,has_ui FROM sessions WHERE id=?').get(session);
  }
  mirrorGoal(lease, goal) {
    this.transaction(() => {
      this.assertLease(lease);
      // A mirror only. OMP's GoalRuntime remains authoritative.
      this.db.prepare('UPDATE sessions SET native_goal=?,updated=? WHERE id=?').run(goal === null ? null : stable(goal), this.now(), lease.session);
      this.emit(lease.workspace, 'goal.observed', { session: lease.session, goalId: goal?.id ?? null, status: goal?.status ?? null });
    });
  }
  checkpoint(lease, record) {
    rejectObviousSecrets(record); boundedText(stable(record), 12000);
    this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare('UPDATE sessions SET checkpoint=?,updated=? WHERE id=?').run(stable(record), this.now(), lease.session);
      this.emit(lease.workspace, 'checkpoint.saved', { session: lease.session, hash: digest(record) });
    });
  }
  /**
   * Record intent before the tool runs. `blockOnUnknown` → an effect is refused while the workspace
   * has unreconciled `unknown` effects, checked inside the same transaction as the row insert.
   * `remoteTools` name the effects whose target is canonical memory rather than the working tree:
   * a workspace effect is not held up by an uncertain memory write, while a memory write is held up
   * by either kind (re-issuing it could duplicate an append the server already committed).
   * Usage counters (tool_calls, effects_used) are observation only; nothing here caps them.
   */
  beginAction(lease, { actionId, tool, input, isEffect = true, blockOnUnknown = false, remoteTools = [], remote = remoteTools.includes(tool) }) {
    // The sweep commits on its own: a refused intent must not roll back the discovery of lapsed work.
    if (isEffect) this.transaction(() => this.sweep(lease.workspace));
    return this.transaction(() => {
      this.assertLease(lease);
      // Returning a prior success is unsafe for arbitrary tools. All repeated dispatches are rejected.
      check(!this.db.prepare('SELECT 1 FROM actions WHERE id=?').get(actionId), 'DUPLICATE_ACTION');
      if (isEffect && blockOnUnknown) {
        const blocking = this.unknownActions(lease.workspace).filter(x => remote || !remoteTools.includes(x.tool));
        check(blocking.length === 0, 'RECONCILIATION_REQUIRED', `uncertain: ${blocking.map(x => `${x.id.slice(0, 12)} ${x.tool}`).join(', ')}; read back the real state, then runtime_reconcile with what you observed`);
      }
      this.db.prepare('UPDATE sessions SET tool_calls=tool_calls+1,effects_used=effects_used+?,updated=? WHERE id=?').run(isEffect ? 1 : 0, this.now(), lease.session);
      const inputHash = digest(input);
      this.db.prepare('INSERT INTO actions(id,workspace,session,epoch,tool,input_hash,is_effect,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(actionId, lease.workspace, lease.session, lease.epoch, tool, inputHash, isEffect ? 1 : 0, 'executing', this.now(), this.now());
      this.emit(lease.workspace, 'action.started', { actionId, session: lease.session, tool, inputHash, isEffect, epoch: lease.epoch });
      return actionId;
    });
  }
  action(actionId) {
    return this.db.prepare('SELECT id,workspace,session,epoch,tool,input_hash,is_effect,state,outcome_hash FROM actions WHERE id=?').get(actionId);
  }
  /** Another extension revised the input after our intent was recorded; the executed input is the truth. */
  reviseAction(lease, actionId, input) {
    return this.transaction(() => {
      this.assertLease(lease);
      const row = this.action(actionId);
      check(row && row.session === lease.session && row.epoch === lease.epoch && row.state === 'executing', 'ACTION_STATE_CONFLICT');
      const inputHash = digest(input);
      if (inputHash === row.input_hash) return false;
      this.db.prepare('UPDATE actions SET input_hash=?,updated=? WHERE id=?').run(inputHash, this.now(), actionId);
      this.emit(lease.workspace, 'action.revised', { actionId, from: row.input_hash, to: inputHash });
      return true;
    });
  }
  /**
   * `uncertain` closes the row as `unknown`: the tool reported an error, but for a non-idempotent
   * remote append an error response does not say whether the server committed (curl 28/52/56).
   */
  finishAction(lease, actionId, { ok, uncertain = false, outcome }) {
    this.transaction(() => {
      this.assertLease(lease);
      const row = this.action(actionId);
      check(row && row.session === lease.session && row.epoch === lease.epoch && row.state === 'executing', 'ACTION_STATE_CONFLICT');
      const outcomeHash = digest(outcome ?? null);
      const state = uncertain ? 'unknown' : ok ? 'succeeded' : 'failed';
      this.db.prepare('UPDATE actions SET state=?,outcome_hash=?,updated=? WHERE id=?').run(state, outcomeHash, this.now(), actionId);
      this.emit(lease.workspace, 'action.finished', { actionId, ok, state, outcomeHash });
    });
  }
  unknownActions(workspace) {
    return this.db.prepare("SELECT id,tool,input_hash,session,updated FROM actions WHERE workspace=? AND state='unknown' ORDER BY updated,rowid").all(workspace);
  }
  /**
   * Attestation that the real target state was read back. `by` names the authority: the session's
   * agent or operator (`session`). Evidence receipts are optional support; `observed` is the
   * attester's own bounded note.
   */
  reconcile(lease, actionId, evidenceIds = [], { by = 'session', observed = '' } = {}) {
    check(by === 'session', 'INVALID_ATTESTATION');
    if (observed) boundedText(observed, 2000);
    this.transaction(() => {
      this.assertLease(lease);
      if (evidenceIds.length) this.assertEvidence(lease.workspace, evidenceIds);
      const row = this.action(actionId);
      check(row?.workspace === lease.workspace && row.state === 'unknown', 'ACTION_STATE_CONFLICT');
      this.db.prepare("UPDATE actions SET state='reconciled',updated=? WHERE id=?").run(this.now(), actionId);
      this.emit(lease.workspace, 'action.reconciled', { actionId, by, session: lease.session, evidenceIds, observed });
    });
  }
  /** The last settled outcome among `tools` in this session: `failed`/`unknown` means the backend is not known to be answering. */
  lastOutcome(session, tools) {
    if (!tools.length) return undefined;
    return this.db.prepare(`SELECT state FROM actions WHERE session=? AND tool IN (${placeholders(tools)}) AND state<>'executing' ORDER BY updated DESC, rowid DESC LIMIT 1`)
      .get(session, ...tools)?.state;
  }
  /** Settled effects since the session last attempted a memory write: what a note would still have to cover. */
  effectsSinceMemoryWrite(session, tools) {
    // Insertion order, not timestamps: several actions can share one clock tick.
    const since = tools.length
      ? this.db.prepare(`SELECT MAX(rowid) AS r FROM actions WHERE session=? AND tool IN (${placeholders(tools)})`).get(session, ...tools)?.r ?? 0
      : 0;
    const exclude = tools.length ? `AND tool NOT IN (${placeholders(tools)})` : '';
    return this.db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE session=? AND is_effect=1 AND state<>'executing' ${exclude} AND rowid>?`)
      .get(session, ...tools, since).n;
  }
  /** The last few actions of this session, newest first: the resume card's factual half. */
  recentActions(session, limit = 8) {
    return this.db.prepare('SELECT id,tool,is_effect,state,updated FROM actions WHERE session=? ORDER BY created DESC, rowid DESC LIMIT ?').all(session, limit)
      .map(x => ({ id: x.id.slice(0, 12), tool: x.tool, effect: x.is_effect === 1, state: x.state, at: x.updated }));
  }
  saveEvidence(lease, record) {
    return this.transaction(() => {
      this.assertLease(lease);
      const evidenceId = id();
      this.db.prepare('INSERT INTO evidence(id,workspace,record,created) VALUES(?,?,?,?)').run(evidenceId, lease.workspace, stable(record), this.now());
      return evidenceId;
    });
  }
  evidence(evidenceId) {
    const row = this.db.prepare('SELECT workspace,record FROM evidence WHERE id=?').get(evidenceId);
    return row ? { workspace: row.workspace, record: JSON.parse(row.record) } : undefined;
  }
  assertEvidence(workspace, evidenceIds) {
    check(Array.isArray(evidenceIds) && evidenceIds.length > 0, 'EVIDENCE_REQUIRED');
    for (const evidenceId of evidenceIds) check(this.evidence(evidenceId)?.workspace === workspace, 'EVIDENCE_SCOPE_MISMATCH');
  }
  approve(lease, actionHash, ttl = 60000) {
    check(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 300000, 'INVALID_APPROVAL_TTL');
    return this.transaction(() => {
      this.assertLease(lease); const approvalId = id();
      this.db.prepare('INSERT INTO approvals(id,workspace,session,epoch,action_hash,expires) VALUES(?,?,?,?,?,?)')
        .run(approvalId, lease.workspace, lease.session, lease.epoch, actionHash, this.now() + ttl);
      this.emit(lease.workspace, 'action.approved', { approvalId, actionHash, session: lease.session, epoch: lease.epoch });
      return approvalId;
    });
  }
  consumeApproval(lease, approvalId, actionHash) {
    this.transaction(() => {
      this.assertLease(lease);
      const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId);
      check(row && row.session === lease.session && row.epoch === lease.epoch && !row.consumed && row.expires > this.now() && row.action_hash === actionHash, 'INVALID_APPROVAL');
      this.db.prepare('UPDATE approvals SET consumed=1 WHERE id=?').run(approvalId);
    });
  }
  close() { this.db.close(); }
}
