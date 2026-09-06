import { mkdirSync, realpathSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { openDatabase } from './sqlite.mjs';
import { check, digest, stable } from './util.mjs';
const inTree = (path, root) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
export function databasePath(runtimeRoot, workspace) {
  const root = realpathSync(workspace);
  mkdirSync(join(runtimeRoot, 'journals'), { recursive: true, mode: 0o700 });
  const dir = realpathSync(join(runtimeRoot, 'journals'));
  check(!inTree(dir, root) && !inTree(root, dir), 'STATE_IN_WORKSPACE');
  const path = join(dir, `${digest({ root })}.sqlite`);
  try { check(!lstatSync(path).isSymbolicLink(), 'SYMLINK_STATE_FILE'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return path;
}
export class Journal {
  static async open(path, now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    const db = await openDatabase(path);
    try { if (path !== ':memory:') chmodSync(path, 0o600); return new Journal(db, now); }
    catch (e) { db.close(); throw e; }
  }
  constructor(db, now) {
    this.db = db; this.now = now;
    // 100 ms is a DB lock wait, never a session execution budget. A lock failure degrades the observer.
    for (const sql of ['PRAGMA busy_timeout=100', 'PRAGMA foreign_keys=ON', 'PRAGMA journal_mode=WAL', 'PRAGMA synchronous=FULL']) db.exec(sql);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    check([0, 2, 3, 4].includes(version), 'UNSUPPORTED_SCHEMA');
    this.tx(() => {
      for (const sql of [
        'CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, paused INTEGER NOT NULL DEFAULT 0)',
        'CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), epoch INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0, has_ui INTEGER NOT NULL DEFAULT 1, native_goal TEXT, checkpoint TEXT, effects_used INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL, updated INTEGER NOT NULL)',
        "CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), session TEXT NOT NULL, epoch INTEGER NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, is_effect INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','unknown','reconciled')), outcome_hash TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
        'CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), record TEXT NOT NULL, created INTEGER NOT NULL)',
        'CREATE INDEX IF NOT EXISTS pending_actions ON actions(workspace,state)',
        'CREATE INDEX IF NOT EXISTS session_actions ON actions(session,state)',
        'CREATE INDEX IF NOT EXISTS workspace_events ON events(workspace,kind,seq)',
        'PRAGMA user_version=4',
      ]) db.prepare(sql).run();
      // Legacy approvals/outbox rows are deliberately untouched. Removing a feature must not delete user data.
    });
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; } }
  emit(workspace, kind, payload) { this.db.prepare('INSERT INTO events(workspace,kind,payload,at) VALUES(?,?,?,?)').run(workspace, kind, stable(payload), this.now()); }
  workspace(root) { root = realpathSync(root); const id = digest({ root }); this.db.prepare('INSERT OR IGNORE INTO workspaces(id,root) VALUES(?,?)').run(id, root); return id; }
  sweep(workspace) {
    const now = this.now();
    this.db.prepare("UPDATE actions SET state=CASE WHEN is_effect=1 THEN 'unknown' ELSE 'failed' END,updated=? WHERE workspace=? AND state='executing' AND session IN (SELECT id FROM sessions WHERE workspace=? AND expires<=?)").run(now, workspace, workspace, now);
  }
  acquire(workspace, session, hasUI = false) {
    return this.tx(() => {
      const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(session);
      check(!r || r.workspace === workspace, 'SESSION_WORKSPACE_MISMATCH');
      check(!r || r.expires <= this.now(), 'SESSION_WRITER_BUSY');
      this.sweep(workspace);
      const epoch = (r?.epoch ?? 0) + 1, now = this.now();
      this.db.prepare('INSERT INTO sessions(id,workspace,epoch,expires,has_ui,started,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,expires=excluded.expires,has_ui=excluded.has_ui,updated=excluded.updated').run(session, workspace, epoch, now + 30000, +hasUI, now, now);
      const lease = { workspace, session, epoch }; this.emit(workspace, 'writer.acquired', { ...lease, hasUI }); return lease;
    });
  }
  assert(lease) { const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(lease.session); check(r && r.workspace === lease.workspace && r.epoch === lease.epoch && r.expires > this.now(), 'FENCED_WRITER'); }
  heartbeat(lease) { this.tx(() => { this.assert(lease); this.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(this.now()+30000, lease.session); }); }
  release(lease) { this.tx(() => { this.assert(lease); this.db.prepare('UPDATE sessions SET expires=0 WHERE id=?').run(lease.session); this.emit(lease.workspace, 'writer.released', { session: lease.session, epoch: lease.epoch }); }); }
  paused(workspace){return this.db.prepare('SELECT paused FROM workspaces WHERE id=?').get(workspace)?.paused===1;}
  setPaused(lease,paused){this.tx(()=>{this.assert(lease);this.db.prepare('UPDATE workspaces SET paused=? WHERE id=?').run(+paused,lease.workspace);this.emit(lease.workspace,paused?'runtime.paused':'runtime.resumed',{session:lease.session});});}
  row(id) { return this.db.prepare('SELECT rowid AS serial,* FROM actions WHERE id=?').get(id); }
  begin(lease, group, ref, memoryTools) {
    if (group.effect) this.tx(() => this.sweep(lease.workspace));
    return this.tx(() => {
      this.assert(lease);
      check(!this.row(group.id), 'DUPLICATE_ACTION');
      const scope = group.op.scope;
      if (group.op.scope === 'memory') {
        const unknown = this.unknown(lease.workspace, memoryTools).filter(a => a.scope === scope);
        check(unknown.length === 0, 'RECONCILIATION_REQUIRED', `scope=${scope}; inspect runtime_status and read back, then runtime_reconcile. Unrelated scopes remain available.`);
      }
      const now = this.now();
      this.db.prepare('INSERT INTO actions(id,workspace,session,epoch,tool,input_hash,is_effect,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run(group.id, lease.workspace, lease.session, lease.epoch, group.op.tool, group.inputHash, +group.effect, 'executing', now, now);
      this.db.prepare('UPDATE sessions SET tool_calls=tool_calls+1,effects_used=effects_used+?,updated=? WHERE id=?').run(+group.effect, now, lease.session);
      this.emit(lease.workspace, 'action.started', { actionId: group.id, scope, ref, semantics: 'logical-v3' });
    });
  }
  alias(lease, group, ref) { this.tx(() => { this.assert(lease); this.db.prepare('UPDATE sessions SET tool_calls=tool_calls+1 WHERE id=?').run(lease.session); this.emit(lease.workspace, 'action.alias', { actionId: group.id, ref }); }); }
  settle(lease, group, reduced) {
    this.tx(() => {
      this.assert(lease); const row = this.row(group.id); check(row && row.session === lease.session && row.epoch === lease.epoch, 'ACTION_SCOPE_MISMATCH');
      // Aggregation is monotone for errors. Explicit read-back attestations are not overwritten by late telemetry.
      if (row.state === 'reconciled') return;
      this.db.prepare('UPDATE actions SET state=?,outcome_hash=?,updated=? WHERE id=?').run(reduced.state, reduced.outcome, this.now(), group.id);
      this.emit(lease.workspace, 'action.observed', { actionId: group.id, state: reduced.state, conflict: reduced.conflict, quality: reduced.quality });
    });
  }
  unknown(workspace, memoryTools) {
    return this.db.prepare("SELECT id,tool,session,updated FROM actions WHERE workspace=? AND state='unknown' ORDER BY updated,id").all(workspace)
      .map(r => ({ ...r, scope: memoryTools.includes(r.tool) ? 'memory' : 'workspace' }));
  }
  blocked(lease, ref, reason) { this.emit(lease.workspace, 'action.blocked', { ref, reason }); }
  checkpoint(lease, data) { this.tx(() => { this.assert(lease); this.db.prepare('UPDATE sessions SET checkpoint=?,updated=? WHERE id=?').run(stable(data), this.now(), lease.session); this.emit(lease.workspace, 'checkpoint.saved', { session: lease.session }); }); }
  mirror(lease, goal) { this.tx(() => { this.assert(lease); this.db.prepare('UPDATE sessions SET native_goal=? WHERE id=?').run(goal == null ? null : stable(goal), lease.session); }); }
  session(session) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(session); }
  events(workspace, kind) { return this.db.prepare('SELECT * FROM events WHERE workspace=? AND kind=? ORDER BY seq').all(workspace,kind).map(r=>({...r,payload:JSON.parse(r.payload)})); }
  source(workspace, actionId) {
    const r = this.db.prepare("SELECT payload FROM events WHERE workspace=? AND kind='action.started' AND json_extract(payload,'$.actionId')=? ORDER BY seq DESC LIMIT 1").get(workspace, actionId);
    return r ? JSON.parse(r.payload).ref ?? null : null;
  }
  reconcile(lease, ids, readbackIds, observed, memoryReads, memoryWrites) {
    this.tx(() => {
      this.assert(lease);
      const rows = ids.map(id => this.row(id));
      check(rows.length > 0 && rows.every(r => r?.workspace === lease.workspace && r.state === 'unknown'), 'ACTION_STATE_CONFLICT');
      const reads = readbackIds.map(id => this.row(id));
      for (const row of rows) {
        check(reads.some(r => r?.workspace === lease.workspace && r.is_effect === 0 && r.state === 'succeeded' && r.created >= row.updated && r.serial > row.serial && (!memoryWrites.includes(row.tool) || memoryReads.includes(r.tool))), 'READBACK_REFERENCE_REQUIRED');
      }
      for (const row of rows) {
        this.db.prepare("UPDATE actions SET state='reconciled',updated=? WHERE id=?").run(this.now(), row.id);
        this.emit(lease.workspace, 'action.reconciled', { actionId: row.id, by: 'agent-attestation', session: lease.session, readbackIds, observed });
      }
    });
  }
  recent(session, offset = 0) { return this.db.prepare('SELECT id,tool,state,is_effect,updated FROM actions WHERE session=? ORDER BY rowid DESC LIMIT 12 OFFSET ?').all(session,offset); }
  saveEvidence(lease, id, record) { this.tx(()=>{this.assert(lease);this.db.prepare('INSERT INTO evidence(id,workspace,record,created) VALUES(?,?,?,?)').run(id,lease.workspace,stable(record),this.now());}); }
  evidence(id) { const r=this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id); return r?{...r,record:JSON.parse(r.record)}:null; }
  close() { this.db.close(); }
}
