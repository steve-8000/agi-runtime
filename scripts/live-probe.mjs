#!/usr/bin/env node
// A finite integration exercise, not an execution supervisor. Leaves native approvals intact.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Journal } from '../src/journal.mjs';
import { INTELLIGENCE_TOOL, VERSION, diagnosticText } from '../src/contracts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let output;
const argv=process.argv.slice(2);
for(let i=0;i<argv.length;i++){
  if(argv[i]==='--output'&&argv[i+1])output=resolve(argv[++i]);
  else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
}
const scratch=mkdtempSync(join(tmpdir(),'omp-runtime-probe-'));
const workspace=join(scratch,'workspace'),runtimeDir=join(scratch,'runtime'),observations=join(scratch,'observations.jsonl');
mkdirSync(workspace);mkdirSync(runtimeDir);
const verifier=`import assert from 'node:assert/strict';
import { invoiceTotal } from './invoice.mjs';
assert.equal(invoiceTotal(10000,20),8000);
assert.equal(invoiceTotal(10000,0),10000);
assert.equal(invoiceTotal(10000,100),0);
console.log('RUNTIME_PROBE_OK');
`;
const hash=text=>createHash('sha256').update(text).digest('hex');
const run=(command,args,options={})=>spawnSync(command,args,{cwd:workspace,encoding:'utf8',maxBuffer:32*1024*1024,...options});
let report={status:'FAIL',model:'OMP main default',runtimeVersion:VERSION,scope:'real host OMP/config/credentials; scratch source/session/journal; native memory may create a scratch-scope host bank; no production workload or cluster changes'};
try{
  writeFileSync(join(workspace,'package.json'),'{"type":"module"}\n');
  writeFileSync(join(workspace,'jsconfig.json'),JSON.stringify({compilerOptions:{allowJs:true,checkJs:false,noEmit:true,module:'NodeNext',moduleResolution:'NodeNext'},include:['*.mjs']}));
  writeFileSync(join(workspace,'.gitignore'),'.zvec-grep/\n.codegraph/\n.serena/\n');
  writeFileSync(join(workspace,'discount.mjs'),'// Amount due after a percentage discount, in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * percent / 100); }\n');
  writeFileSync(join(workspace,'invoice.mjs'),"import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
  writeFileSync(join(workspace,'verify.mjs'),verifier);
  const init=run('git',['init','--quiet']);if(init.status!==0)throw new Error('scratch git init failed');
  const before=run(process.execPath,['verify.mjs']);
  if(before.status===0)throw new Error('fixture did not reproduce the discount bug');

  // Observation only: no sendMessage, synthetic user follow-up, approval override or forced tool.
  const probe=join(scratch,'observe.mjs');
  writeFileSync(probe,`import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveCall } from ${JSON.stringify(join(root,'src/contracts.mjs'))};
const record=data=>appendFileSync(${JSON.stringify(observations)},JSON.stringify(data)+'\\n');
export default function(pi){
  pi.on('session_start',async(_e,ctx)=>{
    const memory=await ctx.memory?.status?.();
    record({type:'attached',legacyAutoindexPresent:existsSync(join(pi.pi.getAgentDir(),'extensions','zvec-autoindex.ts')),tools:pi.getAllTools().map(t=>({name:t.name,source:t.sourceInfo})),active:pi.getActiveTools(),memory:memory?{backend:memory.backend,active:memory.active,scope:memory.scope}:null});
  });
  pi.on('context',e=>record({type:'context',runtimeMessages:e.messages.filter(m=>m.customType==='clab.runtime.state.v3').length}));
  pi.on('tool_call',e=>{const op=effectiveCall(e);record({type:'call',id:e.toolCallId,tool:op.tool,input:op.input});});
  pi.on('tool_result',e=>record({type:'result',id:e.toolCallId,tool:e.toolName,isError:!!e.isError,content:e.content,details:e.details}));
  pi.on('turn_end',()=>record({type:'turn_end'}));
}
`);
  const prompt=`Complete this authorized local integration exercise autonomously; do not ask me to run commands or approve intermediate steps. Work only in ${workspace}. Do not delegate, change settings, or call external services other than the configured code-intelligence/model tools. Keep all existing safety approvals intact.\n\nA durable project constraint for this throwaway workspace: invoice amounts are integer cents and percentage discounts reduce the amount due.\n\n1. Use the mounted lazy-intel code_intel tool (read its xd:// schema first) for a search about discount calculation, architecture/call flow for applyDiscount, and references to applyDiscount in discount.mjs. Use this workspace as root. No standalone backend or manual index commands.\n2. Inspect the source and run node verify.mjs to observe the bug. Fix discount.mjs only; leave verify.mjs and invoice.mjs unchanged.\n3. Run node verify.mjs again and finish only after RUNTIME_PROBE_OK.\n4. Inspect runtime_status and report the actual result. No further user turn is coming. These are acceptance criteria, not a request for another plan.`;
  const args=['-p',prompt,'--mode','json','--no-title','--session-dir',join(scratch,'sessions'),'--cwd',workspace,'-e',probe];
  const started=Date.now();
  const result=run('omp',args,{timeout:600000,stdio:['ignore','ignore','pipe'],env:{...process.env,OMP_RUNTIME_DIR:runtimeDir,OMP_RUNTIME_CONFIG:join(root,'config/runtime.json')}});
  const events=readFileSync(observations,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const attached=events.find(e=>e.type==='attached');
  const calls=events.filter(e=>e.type==='call'),results=events.filter(e=>e.type==='result');
  const after=run(process.execPath,['verify.mjs']);
  const intelligence=calls.filter(e=>e.tool===INTELLIGENCE_TOOL);
  const operations=[...new Set(intelligence.map(e=>e.input.operation))];
  const successful=call=>results.some(e=>e.id===call.id&&!e.isError);
  const journalNames=readdirSync(join(runtimeDir,'journals')).filter(f=>f.endsWith('.sqlite'));
  let recorded=[];
  for(const name of journalNames){const j=await Journal.open(join(runtimeDir,'journals',name));try{recorded.push(...j.db.prepare('SELECT tool,state,is_effect FROM actions').all());}finally{j.close();}}
  const runtimeResult=results.find(e=>e.tool==='runtime_status'||e.details?.xdev?.tool==='runtime_status');
  let runtimeStatus=runtimeResult?.details?.xdev?.inner??runtimeResult?.details;
  if(!runtimeStatus?.health){try{runtimeStatus=JSON.parse(runtimeResult?.content?.find(c=>c.type==='text')?.text);}catch{}}
  const names=attached?.tools.map(t=>t.name)??[];
  const checks={
    processExited:result.status===0&&!result.error,
    attached:journalNames.length===1,
    sharpshooter:attached?.memory?.backend==='sharpshooter'&&attached.memory.active,
    oneIntelligenceTool:names.filter(n=>n.startsWith('mcp__lazy_intel_')).length===1&&names.includes(INTELLIGENCE_TOOL)&&!names.some(n=>/^mcp__(zvec_grep|codegraph|serena)_/.test(n)),
    oneIndexLifecycle:attached?.legacyAutoindexPresent===false,
    nativeMultiTurn:events.filter(e=>e.type==='context').length>=3,
    intelligenceBackends:['search','architecture','references'].every(op=>intelligence.some(c=>c.input.operation===op&&successful(c))),
    intelligenceReadOnly:recorded.some(a=>a.tool===INTELLIGENCE_TOOL)&&recorded.filter(a=>a.tool===INTELLIGENCE_TOOL).every(a=>a.is_effect===0&&a.state==='succeeded'),
    nativeVerification:results.some(e=>!e.isError&&JSON.stringify(e.content).includes('RUNTIME_PROBE_OK')),
    repairedBehavior:after.status===0&&after.stdout.trim()==='RUNTIME_PROBE_OK',
    verifierUnchanged:hash(readFileSync(join(workspace,'verify.mjs')))==hash(verifier),
    runtimeHealthy:runtimeStatus?.health==='healthy'&&runtimeStatus?.version===VERSION
  };
  report={...report,status:Object.values(checks).every(Boolean)?'PASS':'FAIL',durationMs:Date.now()-started,checks,modelTurns:events.filter(e=>e.type==='context').length,operations,toolNames:[...new Set(calls.map(c=>c.tool))],memory:attached?.memory,runtimeStatus:runtimeStatus?{health:runtimeStatus.health,version:runtimeStatus.version,totalUnknown:runtimeStatus.totalUnknown}:null,fixtureBeforeExit:before.status,fixtureAfterExit:after.status,processExit:result.status,processError:diagnosticText(result.error?.message)||null,stderr:diagnosticText(result.stderr)};
}catch(error){report.error=diagnosticText(error.message);}
// Native memory is outside our ownership. Child-reported paths never authorize deletion.
finally{rmSync(scratch,{recursive:true,force:true});}
if(output){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
process.exitCode=report.status==='PASS'?0:1;
