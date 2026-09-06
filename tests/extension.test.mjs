import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import factory from '../extension/index.mjs';
import {databasePath,Journal} from '../src/journal.mjs';
import {STATE_TYPE} from '../src/contracts.mjs';
async function harness(t,{missing,hasUI=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'omp-contract-')),root=join(dir,'workspace'),agent=join(dir,'.omp','agent'),runtimeDir=join(dir,'.omp','runtime');
 mkdirSync(root);mkdirSync(agent,{recursive:true});mkdirSync(runtimeDir);writeFileSync(join(root,'a.txt'),'source');
 const handlers=new Map(),tools=new Map(),commands=new Map(),timers=new Set(),notices=[];
 const s={optional(){return this;},int(){return this;},min(){return this;}};
 const pi={on:(n,f)=>handlers.set(n,f),registerTool:o=>tools.set(o.name,o),registerCommand:(n,o)=>commands.set(n,o),setLabel(){},zod:{object:()=>s,array:()=>s,string:()=>s,number:()=>s,boolean:()=>s},pi:{VERSION:'18.1.11',getAgentDir:()=>agent},logger:{warn:m=>notices.push(m),info:m=>notices.push(m)}};
 const ctx={cwd:root,hasUI,sessionManager:{getSessionId:()=> 'mock-session',getSessionFile:()=>join(dir,'session.jsonl')},setInterval:f=>{timers.add(f);return f;},clearTimer:f=>timers.delete(f),ui:{notify:m=>notices.push(m)},abort(){ctx.aborted=true;}};
 if(missing==='context')delete ctx.sessionManager.getSessionId;
 const env=process.env.OMP_RUNTIME_DIR;process.env.OMP_RUNTIME_DIR=runtimeDir;
 factory(pi); await handlers.get('session_start')({},ctx);
 t.after(async()=>{await handlers.get('session_shutdown')?.({},ctx);if(env===undefined)delete process.env.OMP_RUNTIME_DIR;else process.env.OMP_RUNTIME_DIR=env;rmSync(dir,{recursive:true,force:true});});
 return {pi,ctx,handlers,tools,commands,timers,dir,root,runtimeDir,notices,
  async dispatch(toolCallId,toolName,input={},isError=false){const c={toolCallId,toolName,input};const blocked=await handlers.get('tool_call')(c,ctx);if(blocked)return blocked;handlers.get('tool_execution_start')({...c,args:input},ctx);const result={content:[{type:'text',text:'ok'}],details:{exitCode:0}};handlers.get('tool_result')({...c,...result,isError},ctx);handlers.get('tool_execution_end')({...c,result,isError},ctx);return undefined;},
  async status(p={}){return (await tools.get('runtime_status').execute('status',p,undefined,undefined,ctx)).details;}
 };
}
test('extension registers only existing responsibilities and no loop or approval hook',async t=>{const h=await harness(t);assert.equal(h.tools.size,4);for(const name of ['session_stop','before_provider_request','agent_end','before_agent_start'])assert.equal(h.handlers.has(name),false);assert.equal(h.handlers.has('context'),true);});
test('normal headless development works without an interactive prompt',async t=>{const h=await harness(t,{hasUI:false});assert.equal(await h.dispatch('b','bash',{command:'true'}),undefined);assert.equal((await h.status()).health,'healthy');});
test('context callback does not mutate native input or grow old runtime messages',async t=>{const h=await harness(t);const messages=[{role:'user',content:'work'},{role:'custom',customType:'agi-runtime-state',content:'old'},{role:'custom',customType:'kubernetes-approval',content:'keep'}];const before=structuredClone(messages);let r=h.handlers.get('context')({messages},h.ctx).messages;for(let i=0;i<50;i++)r=h.handlers.get('context')({messages:r},h.ctx).messages;assert.deepEqual(messages,before);assert.equal(r.filter(m=>m.customType===STATE_TYPE).length,1);assert.equal(r.some(m=>m.customType==='kubernetes-approval'),true);});
test('context contract failure disables only this extension, without a new global gate',async t=>{const h=await harness(t,{missing:'context'});assert.equal(await h.handlers.get('tool_call')({toolCallId:'a',toolName:'bash',input:{}},h.ctx),undefined);assert.ok(h.notices.some(n=>n.includes('missing OMP contract')));});
test('existing Kubernetes deny remains effective; runtime never returns an allow override',async t=>{const h=await harness(t);const event={toolCallId:'k',toolName:'bash',input:{command:'kubectl apply -f deployment.yaml'}};const runtimeResult=await h.handlers.get('tool_call')(event,h.ctx);const existingPolicy={block:true,reason:'Existing Kubernetes policy requires target approval'};assert.equal(runtimeResult,undefined);const combined=[runtimeResult,existingPolicy].find(r=>r?.block);assert.equal(combined,existingPolicy);});
test('lease loss and reattachment use existing timer without human interaction',async t=>{const h=await harness(t);const j=await Journal.open(databasePath(h.runtimeDir,h.root));j.db.prepare('UPDATE sessions SET expires=0').run();j.close();const timer=[...h.timers][0];await timer();assert.equal((await h.status()).health,'degraded');assert.equal(await h.dispatch('r','read',{path:'a.txt'}),undefined);await timer();assert.equal((await h.status()).health,'healthy');});
test('operator pause remains authoritative; automatic recovery never clears it',async t=>{const h=await harness(t);await h.commands.get('runtime').handler('pause',h.ctx);assert.equal(h.ctx.aborted,true);assert.equal((await h.dispatch('b','bash',{command:'true'})).block,true);assert.equal(await h.dispatch('r','read',{path:'a.txt'}),undefined);await h.commands.get('runtime').handler('resume',h.ctx);assert.equal(await h.dispatch('b2','bash',{command:'true'}),undefined);});
test('compaction makes a recovery card for one model round, not every stored turn',async t=>{const h=await harness(t);await h.tools.get('runtime_checkpoint').execute('cp',{summary:'implemented X',nextAction:'run tests'},undefined,undefined,h.ctx);const state=()=>JSON.parse(h.handlers.get('context')({messages:[]},h.ctx).messages[0].content);assert.equal(state().resume,undefined);h.handlers.get('session_compact')({},h.ctx);assert.equal(state().resume.checkpoint.summary,'implemented X');h.handlers.get('turn_end')({},h.ctx);assert.equal(state().resume,undefined);});
