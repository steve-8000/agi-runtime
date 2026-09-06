import { config, classify, isEffect, logicalId, wireId, sourceRef, observation, reduceGroup } from './contracts.mjs';
import { check, digest, id, RuntimeFault, boundedText, rejectObviousSecrets } from './util.mjs';
import { captureEvidence, verifyEvidence } from './evidence.mjs';

export class Runtime {
  constructor({ journal, lease, root, session, sessionFile, options = {}, log = () => {} }) {
    this.journal = journal; this.lease = lease; this.root = root; this.session = session;
    this.sessionFile = sessionFile; this.config = config(options, log); this.log = log;
    this.health = journal ? 'healthy' : 'degraded'; this.reason = journal ? null : 'journal-unavailable';
    this.groups = new Map(); this.wires = new Map(); this.uncertain = new Map();
    this.resume = !!lease && lease.epoch > 1; this.checkpointValue = null;
    this.operatorPaused=false;
    if (journal) this.db(() => {
      this.refreshUnknown(); this.operatorPaused=journal.paused(lease.workspace); const row = journal.session(session);
      this.checkpointValue = row?.checkpoint ? JSON.parse(row.checkpoint) : null;
    });
  }
  now() { return this.journal?.now() ?? Date.now(); }
  degrade(error) {
    if (this.health === 'degraded') return;
    this.health = 'degraded'; this.reason = String(error?.code ?? 'JOURNAL_IO');
    for (const g of this.groups.values()) if (g.effect && (g.unpersisted || !reduceGroup(g).complete))
      this.uncertain.set(g.id, { id:g.id, tool:g.op.tool, scope:g.op.scope, session:this.session });
    // Never print raw error strings: they may contain DSNs, SQL parameters or credentials.
    this.log(`Runtime observation degraded: ${this.reason}; no journal claims; ordinary work continues.`);
    try { this.journal?.close(); } catch {} this.journal = null;
  }
  db(fn) {
    if (!this.journal || this.health !== 'healthy') return undefined;
    try { return fn(); }
    catch (e) {
      if (e instanceof RuntimeFault && e.code !== 'FENCED_WRITER') throw e;
      this.degrade(e); return undefined;
    }
  }
  refreshUnknown() {
    if (!this.journal) return;
    this.journal.tx(() => this.journal.sweep(this.lease.workspace));
    this.operatorPaused=this.journal.paused(this.lease.workspace);
    this.uncertain = new Map(this.journal.unknown(this.lease.workspace, this.config.memoryWriteTools).map(a => [a.id,a]));
  }
  heartbeat() { this.db(() => this.journal.heartbeat(this.lease)); }
  block(call, code) {
    const ref = sourceRef(this.session,call,this.sessionFile);
    try { this.db(() => this.journal.blocked(this.lease, ref, code)); }
    catch { /* Preserve the original refusal, never recursively try to log a log failure. */ }
    this.log(`Runtime refusal ${code} for ${call.toolName}`);
    if(code==='RUNTIME_PAUSED')return {block:true,reason:'RUNTIME_PAUSED: explicit operator pause. Do not resume without a new user instruction.'};
    return { block:true, reason: `${code}. Use native reads/runtime_status to inspect and runtime_reconcile after read-back. Defer an unverifiable operation; continue unrelated work. No approval or budget renewal is required.` };
  }
  checkMemory(input) {
    rejectObviousSecrets(input);
    // Only explicit evidence UUIDs with local records are checked. No automatic evidence-generation ritual.
    const text = JSON.stringify(input);
    for (const candidate of text.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g) ?? []) {
      const e = this.journal?.evidence(candidate);
      if (e) check(e.workspace === this.lease.workspace && verifyEvidence(this.root,e.record), 'STALE_EVIDENCE');
    }
  }
  intent(call) {
    const op = classify(call,this.config);
    // These operations must never be held by logging, lease, recall, recovery or counters.
    if (op.kind === 'control' || op.tool === 'runtime_status') return undefined;
    try {
      if (op.kind === 'memory-write') {
        try { this.checkMemory(op.input); }
        catch(e) { if (e instanceof RuntimeFault) return this.block(call,e.code); this.degrade(e); }
        if (this.health !== 'healthy') return this.block(call,'MEMORY_JOURNAL_UNAVAILABLE');
      }
      const effect = isEffect(op);
      if (effect) {
        this.db(()=>this.refreshUnknown());
        check(!this.operatorPaused,'RUNTIME_PAUSED');
        // An ambiguous local command is a recovery hint, not a whole-workspace lock.
        // The model reads current state before continuing. Only known remote memory writes are held.
        if (op.scope==='memory') check(![...this.uncertain.values()].some(a=>a.scope==='memory'), 'RECONCILIATION_REQUIRED');
      }
      if (this.health !== 'healthy') return undefined;
      const key = wireId(call), groupId = logicalId(this.session,call,op);
      check(!this.wires.has(key),'DUPLICATE_ACTION');
      let group = this.groups.get(groupId);
      if (group) {
        // Correlate ONLY the native envelope + its named child. Unrelated identical payloads are not deduplicated.
        check(!reduceGroup(group).complete && (group.envelope || op.envelope) && group.op.tool===op.tool,'DUPLICATE_ACTION');
        if (digest(op.input) !== group.inputHash) group.changed = true;
        this.db(()=>this.journal.alias(this.lease,group,sourceRef(this.session,call,this.sessionFile)));
        if (this.health!=='healthy') return op.kind==='memory-write'?this.block(call,'MEMORY_JOURNAL_UNAVAILABLE'):undefined;
      } else {
        group = { id:groupId, op, effect, envelope:op.envelope, inputHash:digest(op.input), changed:false, parts:new Map() };
        this.db(()=>this.journal.begin(this.lease,group,sourceRef(this.session,call,this.sessionFile),this.config.memoryWriteTools));
        if (this.health !== 'healthy') {
          if (op.kind === 'memory-write') return this.block(call,'MEMORY_JOURNAL_UNAVAILABLE');
          return undefined;
        }
        this.groups.set(groupId,group);
      }
      const part = { wireTool:call.toolName, wireHash:digest(call.input ?? {}), started:false, result:null, end:null };
      group.parts.set(key,part); this.wires.set(key,groupId);
      return undefined;
    } catch(e) { if(e instanceof RuntimeFault) return this.block(call,e.code); this.degrade(e); return op.kind==='memory-write'?this.block(call,'MEMORY_JOURNAL_UNAVAILABLE'):undefined; }
  }
  start(call) {
    const key=wireId(call), group=this.groups.get(this.wires.get(key)); if(!group)return;
    const p=group.parts.get(key); p.started=true;
    if(digest(call.input ?? {})!==p.wireHash) group.changed=true;
  }
  result(call, result, isError, phase='result') {
    const key=wireId(call), group=this.groups.get(this.wires.get(key)); if(!group)return;
    const p=group.parts.get(key);
    const next=observation(result,isError,group.op.kind);
    const prior=p[phase];
    // Repeated observations may add failure, never erase one in the same phase.
    p[phase]=prior ? {...next,failed:prior.failed||next.failed,ambiguous:prior.ambiguous||next.ambiguous} : next;
    const reduced=reduceGroup(group);
    if(reduced.state==='unknown')this.uncertain.set(group.id,{id:group.id,scope:group.op.scope,tool:group.op.tool,session:this.session});
    group.unpersisted=true;
    this.db(()=>{this.journal.settle(this.lease,group,reduced);group.unpersisted=false;});
  }
  turnEnd() {
    for(const [gid,g] of this.groups) if(reduceGroup(g).complete){for(const key of g.parts.keys())this.wires.delete(key);this.groups.delete(gid);}
  }
  status(offset=0) {
    this.db(()=>this.refreshUnknown());
    let recent=[]; this.db(()=>{recent=this.journal.recent(this.session,offset);});
    const all=[...this.uncertain.values()];
    const unknown=all.slice(offset,offset+12).map(a=>{
      let ref=null;this.db(()=>{ref=this.journal.source(this.lease.workspace,a.id);});return {...a,ref};
    });
    return {health:this.health,reason:this.reason,paused:this.operatorPaused,session:this.session,unknown,totalUnknown:all.length,
      nextOffset:offset+12<all.length?offset+12:null,recent,checkpoint:this.checkpointValue,
      authority:'observations and agent attestations; not proof of external state'};
  }
  pause(value){this.operatorPaused=value;this.db(()=>this.journal.setPaused(this.lease,value));}
  checkpoint(data) {
    boundedText(data.summary,1200); boundedText(data.nextAction,600); rejectObviousSecrets(data);
    const record={summary:data.summary,nextAction:data.nextAction};
    this.checkpointValue=record;
    this.db(()=>this.journal.checkpoint(this.lease,record));
    return {saved:this.health==='healthy',durable:this.health==='healthy',record};
  }
  evidence(params) {
    const record=captureEvidence(this.root,params.path,params.start,params.end), evidenceId=id();
    this.db(()=>this.journal.saveEvidence(this.lease,evidenceId,record));
    return {evidenceId:this.health==='healthy'?evidenceId:null,durable:this.health==='healthy',...record};
  }
  reconcile({actionIds,readbackIds,observed}) {
    check(this.health==='healthy','JOURNAL_UNAVAILABLE');
    check(Array.isArray(actionIds)&&actionIds.length>0&&actionIds.every(x=>typeof x==='string'),'ACTION_IDS_REQUIRED');
    check(Array.isArray(readbackIds)&&readbackIds.every(x=>typeof x==='string'),'READBACK_REFERENCE_REQUIRED');
    boundedText(observed,2000); rejectObviousSecrets(observed);
    this.db(()=>this.journal.reconcile(this.lease,[...new Set(actionIds)],readbackIds,observed,this.config.memoryReadTools,this.config.memoryWriteTools));
    check(this.health==='healthy','JOURNAL_UNAVAILABLE');this.refreshUnknown();
    return {reconciled:actionIds,basis:'agent-attestation-with-observed-read-reference',notAnExternalProof:true};
  }
  mirror(goal){this.db(()=>this.journal.mirror(this.lease,goal));}
  close(){if(this.journal){try{this.journal.release(this.lease);}catch{}try{this.journal.close();}catch{}this.journal=null;}}
}
