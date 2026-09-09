#!/usr/bin/env node
// Post-update compatibility checks. Never updates OMP, changes approvals, or resumes a task.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosticText, publicProbe } from '../src/contracts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
let live=false,jsonOutput=false;
for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--live')live=true;
  else if(arg==='--json')jsonOutput=true;
  else if(arg==='--help'||arg==='-h'){
    console.log('Usage: node scripts/upgrade-check.mjs [--live] [--json]\nScope: runtime/extension/Sharpshooter/installer regressions and extension loading; --live adds real autonomous code-intelligence/edit/verify execution.');process.exit(0);
  }else{console.error(`upgrade-check: unknown or incomplete option: ${arg}`);process.exit(2);}
}
const steps=[];
function run(name,command,args,{timeout=120000}={}){
  const started=Date.now();
  const r=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  const step={name,command:diagnosticText([command,...args].join(' '),1),ok:r.status===0&&!r.error,exitCode:r.status,durationMs:Date.now()-started,stdout:String(r.stdout??''),stderr:String(r.stderr??''),error:diagnosticText(r.error?.message)||null};
  steps.push(step);
  if(!jsonOutput){console.log(`[${step.ok?'PASS':'FAIL'}] ${name} (${step.durationMs}ms)`);if(!step.ok)console.log(name==='live-autonomy'?'live probe failed':step.error??diagnosticText(step.stderr||step.stdout));}
  return step;
}
function parse(text){try{return JSON.parse(text);}catch{return null;}}
const version=run('omp-version','omp',['--version'],{timeout:30000});
run('runtime-static-check',process.execPath,['scripts/check.mjs']);
run('runtime-regressions',process.execPath,['--test','--test-reporter=tap','tests/runtime.test.mjs','tests/extension.test.mjs','tests/memory.test.mjs','tests/install.test.mjs']);
const plan=run('extension-link',process.execPath,['scripts/install.mjs']);
const linked=parse(plan.stdout)?.current??null;
if(plan.ok&&linked!==root){plan.ok=false;plan.error=`loaded extension is ${linked??'absent'}, not this checkout`;if(!jsonOutput)console.log(`[FAIL] ${diagnosticText(plan.error)}`);}
let probe=null;
if(live){
  const result=run('live-autonomy',process.execPath,['scripts/live-probe.mjs'],{timeout:660000});
  probe=publicProbe(parse(result.stdout));
  if(result.ok&&probe?.status!=='PASS'){result.ok=false;result.error='live probe did not return a passing evidence report';}
}
const failures=steps.filter(s=>!s.ok),status=failures.length?'FAIL':'PASS';
const report={status,scope:'runtime package including installer safety',ompVersion:version.ok?diagnosticText(version.stdout,1):null,liveProbe:live,extensionLink:linked,probe,steps:steps.map(({stdout,stderr,...step})=>({...step,error:step.name==='live-autonomy'?(step.ok?null:'live-probe-failed'):diagnosticText(step.error)||null,stdoutTail:step.name==='live-autonomy'?'':diagnosticText(stdout),stderrTail:step.name==='live-autonomy'?'':diagnosticText(stderr)}))};
if(jsonOutput)console.log(JSON.stringify(report,null,2));
else{
  console.log(`runtime upgrade-check: ${status}`);
  if(!live)console.log('Live model/tool execution was not run; use --live when it is required.');
  if(failures.length)console.log(`Failed: ${failures.map(s=>s.name).join(', ')}`);
}
process.exitCode=status==='PASS'?0:1;
