#!/usr/bin/env node
// Synthetic hooks against real shared SQLite; no telemetry service or timeout tuning.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.mjs';
import { Runtime } from '../src/kernel.mjs';

if (!isMainThread) {
  const journal=await Journal.open(workerData.file), ws=journal.workspace(workerData.root);
  const lease=journal.acquire(ws,workerData.session), rt=new Runtime({journal,lease,root:workerData.root,session:workerData.session});
  parentPort.postMessage('ready'); await once(parentPort,'message');
  const latencies=[];
  for(let i=0;i<100;i++) {
    const call={toolCallId:`c${i}`,toolName:'mcp__lazy_intel_code_intel',input:{operation:'sync',root:workerData.root}};
    const start=performance.now();
    rt.intent(call);rt.start(call);rt.result(call,{content:[]},false,'end');rt.turnEnd();
    if(rt.health==='healthy')latencies.push(performance.now()-start);
  }
  parentPort.postMessage({latencies,degraded:rt.health==='degraded'});
  rt.close();parentPort.close();
} else {
  const dir=mkdtempSync(join(tmpdir(),'runtime-contention-')),root=join(dir,'workspace'),file=join(dir,'journal.sqlite');
  mkdirSync(root);const workers=[];
  try {
    const initial=await Journal.open(file);initial.workspace(root);initial.close();
    for(let i=0;i<4;i++) {
      const worker=new Worker(new URL(import.meta.url),{workerData:{file,root,session:`load-${i}`}});
      workers.push(worker);await once(worker,'message');
    }
    const results=workers.map(worker=>once(worker,'message').then(([result])=>result));
    for(const worker of workers)worker.postMessage('start');
    const samples=await Promise.all(results),latencies=samples.flatMap(sample=>sample.latencies).sort((a,b)=>a-b);
    const journal=await Journal.open(file),ws=journal.workspace(root),lease=journal.acquire(ws,'blocked');
    const rt=new Runtime({journal,lease,root,session:'blocked'}),blocker=await Journal.open(file);
    blocker.db.exec('BEGIN IMMEDIATE');
    const start=performance.now();rt.intent({toolCallId:'held-lock',toolName:'write',input:{path:'example',content:'x'}});
    const lockWaitMs=performance.now()-start,forcedDegraded=rt.health==='degraded';
    blocker.db.exec('ROLLBACK');blocker.close();rt.close();
    console.log(JSON.stringify({scope:'4 concurrent synthetic sessions, 100 derived-effect hook cycles each, shared real SQLite; separate deliberately held write lock',sessions:4,attemptedCycles:400,recordedCycles:latencies.length,journal_degrade_total:samples.filter(sample=>sample.degraded).length,journal_effect_cycle_latency_p95_ms:latencies[Math.floor(latencies.length*0.95)]??null,forcedContention:{journal_lock_wait_ms:lockWaitMs,degraded:forcedDegraded},decision:'Keep busy_timeout=100ms unless representative contention demonstrates a fidelity problem; forced lock is failure-path evidence, not ordinary workload.'},null,2));
  } finally { await Promise.all(workers.map(worker=>worker.terminate()));rmSync(dir,{recursive:true,force:true}); }
}
