import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, call, run, ok } from './helpers.mjs';
import { classify, logicalId, STATE_TYPE, INTELLIGENCE_TOOL, VERSION, publicProbe } from '../src/contracts.mjs';
import { projectContext, MAX_CONTEXT_BYTES } from '../src/context.mjs';
import { Journal, databasePath } from '../src/journal.mjs';
import { Runtime } from '../src/kernel.mjs';
const row = (f,c) => f.journal.row(logicalId('session',c,classify(c)));

// A changed execution input is an observed uncertain effect, not a fabricated remote failure.
function uncertain(f, id='changed') {
  const c=call(id); f.rt.intent(c); f.rt.start({...c,input:{command:'different'}});
  f.rt.result(c,ok,false,'end'); return row(f,c);
}

test('public probe summaries discard opaque fields without hiding a valid outcome',()=>{
  const secret='PRIVATE_PROVIDER_PAYLOAD',selector='PRIVATE_MODEL_SELECTOR';
  const raw={status:'PASS',model:selector,runtimeVersion:VERSION,modelTurns:{secret},futureField:{secret},stderr:secret,checks:{
    processExited:true,attached:true,sharpshooter:true,oneIntelligenceTool:true,oneIndexLifecycle:true,nativeMultiTurn:true,
    intelligenceBackends:true,intelligenceReadOnly:true,nativeVerification:true,repairedBehavior:true,verifierUnchanged:true,runtimeHealthy:true,
    futureCheck:secret,
  },runtimeStatus:{health:'healthy',version:VERSION,totalUnknown:secret,futureField:secret}};
  const projected=publicProbe(raw);
  assert.equal(projected.status,'PASS');
  assert.equal(JSON.stringify(projected).includes(secret),false);
  assert.equal(JSON.stringify(projected).includes(selector),false);
  raw.checks.nativeVerification={secret};
  assert.equal(publicProbe(raw).status,'FAIL','opaque truthy values cannot masquerade as a passed check');
});

test('default runtime records a complete native tool cycle without degrading',async t=>{
  const f=await fixture(t), c=call('a'); run(f.rt,c);
  assert.equal(f.rt.status().health,'healthy'); assert.equal(row(f,c).state,'succeeded');
});

test('retired search configuration cannot let a native mutation bypass pause',async t=>{
  const f=await fixture(t,{config:{searchTools:['bash']}});
  f.rt.pause(true);
  assert.equal(f.rt.intent(call('mutate','bash',{command:'touch unexpected'}))?.block,true);
  assert.equal(f.rt.intent(call('inspect',INTELLIGENCE_TOOL,{operation:'search',query:'current behavior'})),undefined);
});

test('code_intel stays a read through xd envelopes even with a legacy operator config',async t=>{
  const f=await fixture(t,{config:{memoryWriteTools:['retired'],searchTools:[]}});
  const input={root:f.root,operation:'architecture',query:'state flow',freshness:'auto',limit:8};
  const outer=call('x','write',{path:`xd://${INTELLIGENCE_TOOL}`,content:JSON.stringify(input)});
  const inner=call('x',INTELLIGENCE_TOOL,input), before=structuredClone(outer);
  f.rt.pause(true); // Derived intelligence must remain available for recovery while edits are paused.
  assert.equal(f.rt.intent(outer),undefined); f.rt.start(outer);
  assert.equal(f.rt.intent(inner),undefined); f.rt.result(inner,ok,false);
  f.rt.result(outer,ok,false,'end');
  assert.equal(row(f,outer).is_effect,0); assert.equal(row(f,outer).state,'succeeded');
  assert.equal(f.rt.status().totalUnknown,0); assert.deepEqual(outer,before);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) n FROM actions').get().n,1);
});

test('failed code intelligence is a failed read and never locks native source work',async t=>{
  const f=await fixture(t), c=call('intel',INTELLIGENCE_TOOL,{operation:'search',query:'x'});
  run(f.rt,c,ok,true); assert.equal(row(f,c).state,'failed');
  assert.equal(f.rt.status().totalUnknown,0); assert.equal(run(f.rt,call('edit')),undefined);
});

test('success then failure never remains succeeded',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.start(c);f.rt.result(c,ok,false);f.rt.result(c,ok,true,'end');
  assert.equal(row(f,c).state,'failed');assert.equal(f.journal.events(f.ws,'action.observed').at(-1).payload.conflict,true);
});
test('failure then success stays failed with conflict metadata',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.start(c);f.rt.result(c,ok,true);f.rt.result(c,ok,false,'end');
  assert.equal(row(f,c).state,'failed');
});
test('exit-code-only result divergence is detected',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.start(c);f.rt.result(c,ok,false);f.rt.result(c,{...ok,details:{exitCode:2}},false,'end');
  assert.equal(row(f,c).state,'failed');assert.equal(f.journal.events(f.ws,'action.observed').at(-1).payload.conflict,true);
});
test('repeated success cannot erase an earlier error in the same result phase',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.result(c,ok,true);f.rt.result(c,ok,false);
  assert.equal(row(f,c).state,'failed');
});
test('a started action is executing until end; result-only observations can settle',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.start(c);f.rt.result(c,ok,false);
  assert.equal(row(f,c).state,'executing');f.rt.result(c,ok,false,'end');assert.equal(row(f,c).state,'succeeded');
  const read=call('r','read',{path:'a.txt'});f.rt.intent(read);f.rt.result(read,ok,false);
  assert.equal(row(f,read).state,'succeeded');
});
test('xd effect outer and child correlate without merging independent calls',async t=>{
  const f=await fixture(t), input={path:'a.txt',old_string:'one',new_string:'two'};
  const outer=call('x','write',{path:'xd://ast_edit',content:JSON.stringify(input)}),inner=call('x','ast_edit',input);
  f.rt.intent(outer);f.rt.start(outer);f.rt.intent(inner);f.rt.result(inner,ok,false);f.rt.result(outer,ok,false,'end');
  assert.equal(row(f,outer).state,'succeeded');assert.equal(f.journal.session('session').effects_used,1);
  run(f.rt,call('other','ast_edit',input));assert.equal(f.journal.session('session').effects_used,2);
});
test('exact duplicate dispatch is refused without pretending it needs approval',async t=>{
  const f=await fixture(t),c=call('a');run(f.rt,c);assert.equal(f.rt.intent(c).block,true);
  assert.equal(f.journal.events(f.ws,'action.blocked').at(-1).payload.reason,'DUPLICATE_ACTION');
});
test('input drift stays uncertain but does not lock unrelated work',async t=>{
  const f=await fixture(t);assert.equal(uncertain(f).state,'unknown');assert.equal(run(f.rt,call('next')),undefined);
});
test('control and read operations remain available during an explicit pause',async t=>{
  const f=await fixture(t);f.rt.pause(true);
  for(const tool of ['hub','goal','runtime_reconcile','runtime_checkpoint','runtime_status','read'])
    assert.equal(f.rt.intent(call(tool,tool,{})),undefined);
  assert.equal(f.rt.intent(call('write')).block,true);
});
test('persistent I/O failure stops DB attempts, not native source work',async t=>{
  const f=await fixture(t),c=call('r','read',{path:'a.txt'});f.rt.intent(c);f.rt.start(c);let hits=0;
  f.journal.settle=()=>{hits++;throw Object.assign(new Error('disk full secret text'),{code:'ENOSPC'});};
  f.rt.result(c,ok,false,'end');assert.equal(f.rt.health,'degraded');
  assert.equal(f.rt.intent(call('b')),undefined);assert.equal(f.rt.intent(call('b2')),undefined);
  assert.equal(hits,1);assert.ok(!f.log.join('').includes('secret text'));
});
test('lost lease degrades observation and leaves source reads available',async t=>{
  const f=await fixture(t);f.advance(31000);f.rt.heartbeat();assert.equal(f.rt.health,'degraded');
  assert.equal(f.rt.intent(call('r','read',{path:'a.txt'})),undefined);
});
test('read-back and attestation resolve only the selected unknown actions',async t=>{
  const f=await fixture(t),a=uncertain(f,'a'),b=uncertain(f,'b');f.advance(1);
  const r=call('r','read',{path:'a.txt'});run(f.rt,r);
  assert.throws(()=>f.rt.reconcile({actionIds:[a.id],readbackIds:[],observed:'checked'}),/READBACK_REFERENCE_REQUIRED/);
  const result=f.rt.reconcile({actionIds:[a.id],readbackIds:[row(f,r).id],observed:'a.txt has the intended contents.'});
  assert.equal(result.notAnExternalProof,true);assert.equal(f.journal.row(a.id).state,'reconciled');
  assert.equal(f.journal.row(b.id).state,'unknown');
});
test('a same-tick earlier read and a later failed read cannot certify an effect',async t=>{
  const f=await fixture(t),r=call('r','read',{path:'a.txt'});run(f.rt,r);const a=uncertain(f);
  assert.throws(()=>f.rt.reconcile({actionIds:[a.id],readbackIds:[row(f,r).id],observed:'old read'}),/READBACK_REFERENCE_REQUIRED/);
  const failed=call('failed','read',{path:'missing'});run(f.rt,failed,ok,true);
  assert.throws(()=>f.rt.reconcile({actionIds:[a.id],readbackIds:[row(f,failed).id],observed:'failed read'}),/READBACK_REFERENCE_REQUIRED/);
});
test('historical external-memory observations are preserved and cannot be recertified by local reads',async t=>{
  const f=await fixture(t),a=uncertain(f);
  f.journal.db.prepare("UPDATE events SET payload=json_set(payload,'$.scope','memory') WHERE kind='action.started' AND json_extract(payload,'$.actionId')=?").run(a.id);
  const r=call('r','read',{path:'a.txt'});run(f.rt,r);
  assert.equal(f.rt.status().unknown[0].scope,'memory');
  assert.throws(()=>f.rt.reconcile({actionIds:[a.id],readbackIds:[row(f,r).id],observed:'local read'}),/RETIRED_ACTION_SCOPE/);
  assert.equal(run(f.rt,call('next')),undefined);
});
test('checkpoint rejects obvious credentials without storing them',async t=>{
  const f=await fixture(t);assert.throws(()=>f.rt.checkpoint({summary:'Bearer abcdefghijklmnopqrstuvwxyz',nextAction:'continue'}));
  assert.equal(f.journal.session('session').checkpoint,null);
});
test('steady context adds nothing and recovery remains one bounded detached projection',async t=>{
  const f=await fixture(t),user={role:'user',content:'task',timestamp:1},other={role:'custom',customType:'other-extension',content:'keep'};
  const input=[user,other,{role:'custom',customType:STATE_TYPE,content:'old'}];
  assert.deepEqual(projectContext(input,f.rt),[user,other]);
  f.rt.resume=true;f.rt.checkpointValue={summary:'한'.repeat(3000),nextAction:'가'.repeat(1000)};
  let msgs=input;for(let i=0;i<1000;i++)msgs=projectContext(msgs,f.rt);
  assert.equal(msgs.length,3);assert.equal(msgs[0],user);assert.equal(msgs[1],other);
  assert.ok(Buffer.byteLength(msgs.at(-1).content)<=MAX_CONTEXT_BYTES);assert.equal(input.at(-1).content,'old');
  f.rt.resume=false;assert.deepEqual(projectContext(msgs,f.rt),[user,other]);
});
test('old budgets and recall options never limit a long authorized task',async t=>{
  const f=await fixture(t,{config:{maxEffects:1,maxWallMs:1,maxToolCalls:1,recall:{mode:'require'}}});
  for(let i=0;i<605;i++){assert.equal(run(f.rt,call(String(i))),undefined);f.rt.turnEnd();}
  for(let i=0;i<4320;i++){f.advance(20000);f.rt.heartbeat();}
  assert.equal(run(f.rt,call('late')),undefined);assert.equal(f.journal.session('session').effects_used,606);
});
test('resolved journal directory cannot be symlinked into workspace',async t=>{
  const f=await fixture(t),outside=join(f.dir,'outside');mkdirSync(outside);mkdirSync(join(f.root,'..hidden'));symlinkSync(join(f.root,'..hidden'),join(outside,'journals'));
  assert.throws(()=>databasePath(outside,f.root),/STATE_IN_WORKSPACE/);
});
test('same session second writer is rejected, sibling session is allowed',async t=>{
  const f=await fixture(t);assert.throws(()=>f.journal.acquire(f.ws,'session'),/SESSION_WRITER_BUSY/);assert.equal(f.journal.acquire(f.ws,'scout',false).epoch,1);
});
test('reopening old schema preserves nonempty legacy outbox',async t=>{
  const f=await fixture(t);f.journal.db.exec("CREATE TABLE outbox(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO outbox VALUES('keep','user memory'); PRAGMA user_version=3;");f.rt.close();
  const j=await Journal.open(join(f.dir,'journal.sqlite'));assert.equal(j.db.prepare('SELECT payload FROM outbox').get().payload,'user memory');assert.equal(j.db.prepare('PRAGMA user_version').get().user_version,4);j.close();
});
test('unsupported schema is not reset or destroyed',async t=>{
  const f=await fixture(t);f.journal.db.exec('PRAGMA user_version=99');f.rt.close();await assert.rejects(Journal.open(join(f.dir,'journal.sqlite')),/UNSUPPORTED_SCHEMA/);
});
test('crash recovery marks unfinished effects unknown without replay or workspace lock',async t=>{
  const f=await fixture(t),c=call('lost');f.rt.intent(c);f.advance(31000);const lease=f.journal.acquire(f.ws,'next-session');
  const next=new Runtime({journal:f.journal,lease,root:f.root,session:'next-session'});
  assert.equal(next.status().totalUnknown,1);assert.equal(f.journal.session('next-session').tool_calls,0);
  assert.equal(run(next,call('continued')),undefined);
});
test('failed final persistence is visible as uncertainty before reattach',async t=>{
  const f=await fixture(t),c=call('a');f.rt.intent(c);f.rt.start(c);f.journal.settle=()=>{throw Object.assign(new Error('I/O'),{code:'EIO'});};f.rt.result(c,ok,false,'end');
  assert.equal(f.rt.health,'degraded');assert.equal(f.rt.status().totalUnknown,1);assert.equal(f.rt.intent(call('next')),undefined);
});
