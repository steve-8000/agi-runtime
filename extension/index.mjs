import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Journal, databasePath } from '../src/journal.mjs';
import { Runtime } from '../src/kernel.mjs';
import { config, VERSION } from '../src/contracts.mjs';
import { projectContext } from '../src/context.mjs';

/** OMP v18.1.11 public extension contract. No core patch, MCP client, model call or continuation loop. */
export default function runtimeExtension(pi){
  let runtime, ctxActive, timer, journalFile, options={};
  let contractMissing=[], warningShown=false, recovering=false, retryAt=0, generation=0;
  const warn=message=>{pi.logger?.warn?.(message);if(!warningShown){ctxActive?.ui?.notify?.(message,'warning');warningShown=true;}};
  const reply=data=>({content:[{type:'text',text:JSON.stringify(data)}],details:data});
  function teardown(){generation++;if(timer&&ctxActive)ctxActive.clearTimer(timer);timer=null;runtime?.close();runtime=null;}
  async function recover(ctx){
    if(recovering || !runtime || runtime.health==='healthy' || Date.now()<retryAt)return;
    recovering=true;retryAt=Date.now()+10000;const current=runtime, gen=generation;let journal,lease;
    try{
      journal=await Journal.open(journalFile);const ws=journal.workspace(ctx.cwd);lease=journal.acquire(ws,current.session,ctx.hasUI);
      if(gen!==generation || current!==runtime){try{journal.release(lease);}catch{}journal.close();return;}
      const next=new Runtime({journal,lease,root:ctx.cwd,session:current.session,sessionFile:current.sessionFile,options,log:warn});
      next.resume=true;if(current.checkpointValue && !next.checkpointValue)next.checkpointValue=current.checkpointValue;
      runtime=next;pi.logger?.info?.('Runtime journal recovered; inspect uncertain actions, never replay them automatically.');
    }catch{try{journal?.close();}catch{}}finally{recovering=false;}
  }
  async function attach(ctx){
    teardown();ctxActive=ctx;journalFile=undefined;retryAt=0;warningShown=false;
    contractMissing=[];
    for(const [name,value] of [['sessionManager.getSessionId',ctx.sessionManager?.getSessionId],['setInterval',ctx.setInterval],['clearTimer',ctx.clearTimer]])
      if(typeof value!=='function')contractMissing.push(name);
    if(typeof ctx.cwd!=='string')contractMissing.push('cwd');
    if(contractMissing.length){warn(`Runtime disabled: missing OMP contract ${contractMissing.join(', ')}`);return;}
    const session=ctx.sessionManager.getSessionId();
    const sessionFile=typeof ctx.sessionManager.getSessionFile==='function'?ctx.sessionManager.getSessionFile():undefined;
    const agentDir=pi.pi?.getAgentDir?.()??process.env.PI_CODING_AGENT_DIR??join(homedir(),'.omp','agent');
    const runtimeDir=process.env.OMP_RUNTIME_DIR??join(dirname(agentDir),'runtime');
    try{options=config(JSON.parse(readFileSync(process.env.OMP_RUNTIME_CONFIG??join(runtimeDir,'config.json'),'utf8')),m=>pi.logger?.warn?.(m));}
    catch(e){if(e.code!=='ENOENT')warn('Runtime config could not be read; using declared default tool identities. Existing Kubernetes policy is unchanged.');options=config();}
    let journal,lease;
    try{journalFile=databasePath(runtimeDir,ctx.cwd);journal=await Journal.open(journalFile);const ws=journal.workspace(ctx.cwd);lease=journal.acquire(ws,session,ctx.hasUI);}
    catch(e){try{journal?.close();}catch{}journal=null;warn(`Runtime journal unavailable (${e.code??'JOURNAL_IO'}); continue local work; defer memory writes.`);}
    runtime=new Runtime({journal,lease,root:ctx.cwd,session,sessionFile,options,log:warn});
    timer=ctx.setInterval(async()=>{if(runtime?.health==='healthy')runtime.heartbeat();else if(journalFile)await recover(ctx);},5000);
  }
  if(typeof pi.on!=='function'){pi.logger?.warn?.('Runtime unavailable: OMP event API missing');return;}
  pi.setLabel?.('Runtime');
  for(const name of ['session_start','session_switch','session_branch','session_tree'])pi.on(name,async(_e,ctx)=>attach(ctx));
  pi.on('session_shutdown',()=>teardown());
  for(const name of ['session_compact','auto_compaction_end'])pi.on(name,()=>{if(runtime)runtime.resume=true;});
  pi.on('goal_updated',e=>runtime?.mirror(e.goal??null));
  pi.on('tool_call',e=>runtime?.intent(e));
  pi.on('tool_execution_start',e=>runtime?.start({...e,input:e.args}));
  pi.on('tool_result',e=>{try{runtime?.result(e,{content:e.content,details:e.details},e.isError,'result');}catch(error){runtime?.degrade(error);}});
  pi.on('tool_execution_end',e=>{try{runtime?.result(e,e.result,e.isError,'end');}catch(error){runtime?.degrade(error);}});
  pi.on('turn_end',()=>{runtime?.turnEnd();if(runtime)runtime.resume=false;});
  // Build a detached request projection. Do not append a new transcript entry at every prompt.
  pi.on('context',e=>{
    if(!runtime||!Array.isArray(e.messages))return;
    try{return {messages:projectContext(e.messages,runtime)};}catch(error){warn('Runtime context projection skipped; native context unchanged.');}
  });
  // No session_stop, sendMessage, sendUserMessage or triggerTurn. Native OMP GoalRuntime is the only loop.
  if(typeof pi.registerTool!=='function'||!pi.zod)return;
  const z=pi.zod;
  const requireRuntime=()=>{if(!runtime)throw new Error(`RUNTIME_UNAVAILABLE ${contractMissing.join(',')}`);return runtime;};
  pi.registerTool({name:'runtime_status',label:'Runtime status',approval:'read',description:'Read current observation/recovery state and action IDs. offset pages recent and uncertain actions; no content is proof of remote state.',parameters:z.object({offset:z.number().int().min(0).optional(),refresh:z.boolean().optional()}),
    async execute(_id,p,_signal,_update,ctx){if(p.refresh)await recover(ctx);return reply({...requireRuntime().status(p.offset??0),version:VERSION,contractMissing});}});
  pi.registerTool({name:'runtime_checkpoint',label:'Save checkpoint',approval:'write',description:'Save a short recovery summary and next action. Not a completion gate or canonical memory.',parameters:z.object({summary:z.string(),nextAction:z.string()}),
    async execute(_id,p){return reply(requireRuntime().checkpoint(p));}});
  pi.registerTool({name:'runtime_evidence',label:'Source evidence',approval:'read',description:'Optional file-range identity receipt. Hashes establish identity, not semantic truth. Ordinary edits do not need this tool.',parameters:z.object({path:z.string(),start:z.number().int().min(1),end:z.number().int().min(1)}),
    async execute(_id,p){return reply(requireRuntime().evidence(p));}});
  pi.registerTool({name:'runtime_reconcile',label:'Reconcile',approval:'write',description:'Resolve specified unknown operations after actual read-back. Supply successful later read action IDs from runtime_status and a nonempty observation. This records agent attestation, not proof. No all shortcut.',parameters:z.object({actionIds:z.array(z.string()),readbackIds:z.array(z.string()),observed:z.string()}),
    async execute(_id,p){return reply(requireRuntime().reconcile(p));}});
  if(typeof pi.registerCommand==='function')pi.registerCommand('runtime',{description:'Show runtime diagnostics. No approvals, renewals or mandatory setup commands.',
    async handler(args,ctx){if(args.trim()==='pause'){runtime?.pause(true);ctx.abort?.();}else if(args.trim()==='resume'){runtime?.pause(false);}ctx.ui?.notify?.(JSON.stringify(runtime?.status()??{health:'unavailable',contractMissing}),'info');}});
}
