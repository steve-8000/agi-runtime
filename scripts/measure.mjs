#!/usr/bin/env node
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import {tmpdir,platform,arch} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Journal} from '../src/journal.mjs';
import {Runtime} from '../src/kernel.mjs';
import {projection,projectContext,MAX_CONTEXT_BYTES} from '../src/context.mjs';
const dir=mkdtempSync(join(tmpdir(),'runtime-measure-')),root=join(dir,'workspace');mkdirSync(root);
const journal=await Journal.open(join(dir,'journal.sqlite')),ws=journal.workspace(root),lease=journal.acquire(ws,'measure');
const rt=new Runtime({journal,lease,root,session:'measure'});const lat=[];
try{
 for(let i=0;i<1000;i++){
  const c={toolCallId:`c${i}`,toolName:'read',input:{path:'example.ts'}},start=performance.now();
  rt.intent(c);rt.start(c);rt.result(c,{content:[{type:'text',text:'example'}]},false);rt.result(c,{content:[{type:'text',text:'example'}]},false,'end');rt.turnEnd();lat.push(performance.now()-start);
 }
 lat.sort((a,b)=>a-b);const steady=Buffer.byteLength(projection(rt));
 rt.resume=true;rt.checkpointValue={summary:'한'.repeat(1000),nextAction:'다'.repeat(500)};
 for(let i=0;i<100;i++)rt.uncertain.set(String(i),{id:'f'.repeat(64),tool:'mcp__gbrain_remember',scope:'memory'});
 const resume=Buffer.byteLength(projection(rt));let messages=[{role:'user',content:'same task'}];for(let i=0;i<1000;i++)messages=projectContext(messages,rt);
 console.log(JSON.stringify({node:process.version,platform:platform(),arch:arch(),iterations:1000,hookCycleMs:{median:lat[499],p95:lat[949],max:lat[999]},context:{steadyBytes:steady,stressResumeBytes:resume,packingBoundBytes:MAX_CONTEXT_BYTES,runtimeMessagesAfter1000Builds:messages.length-1},scope:'Synthetic hooks and real local SQLite; no real file/tool/provider execution, no Mac benchmark, no model tokens measured; storage cache affects latency'},null,2));
}finally{rt.close();rmSync(dir,{recursive:true,force:true});}
