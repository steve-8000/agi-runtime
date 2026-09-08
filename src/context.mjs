import { STATE_TYPE, OLD_STATE_TYPES, clipBytes } from './contracts.mjs';
import { MAX_PENDING } from './memory.mjs';
// This is an output-packing bound, NOT a work budget: no invocation is refused because it is reached.
export const MAX_CONTEXT_BYTES = 4096;
const ROUTING = 'Use zvec-grep first for unknown semantic/cross-file code discovery; native reads verify hits. Project decision memory is Sharpshooter: consolidated architecture/product/style decisions are already in this system prompt, and new ones are captured automatically from user turns. There is no recall, remember or memory tool to call, so state durable decisions, constraints, rejected approaches and corrections explicitly in the turn that settles them. Do not use task agent. No recall ritual or approval prompt is required here.';
const RESUME_NOTE = 'Resume from native OMP history. Read current source before changing it. Consolidated decision memory is already in this system prompt; anything listed below was captured in this session and is not consolidated yet.';
export function projection(runtime) {
  const state={routing:ROUTING};
  if(runtime.operatorPaused)state.paused='Explicit operator pause; do not resume without a new user instruction.';
  if(runtime.health!=='healthy')state.degraded={reason:runtime.reason,journal:'no durable action record; continue source work and re-read real state after an unknown operation'};
  const unknown=[...runtime.uncertain.values()];
  if(unknown.length)state.uncertain={count:unknown.length,items:unknown.slice(0,3).map(x=>({id:x.id,scope:x.scope,tool:clipBytes(x.tool,80)})),more:'runtime_status'};
  const memory=runtime.decisionMemory;
  // A failing consolidation is silent otherwise: the user's decisions never reach the memory files.
  if(memory?.error)state.decisionMemory={consolidationFailing:memory.error.kind,effect:'decisions stated in this session are not being persisted; restate load-bearing constraints inline',bank:memory.bank,detail:memory.error.detail};
  if(runtime.resume){
    state.resume={note:RESUME_NOTE};
    if(runtime.checkpointValue)state.resume.checkpoint={summary:clipBytes(runtime.checkpointValue.summary,900),nextAction:clipBytes(runtime.checkpointValue.nextAction,450)};
    // Queued deltas survive compaction on disk but not in the transcript; this is the only place they reappear.
    if(memory?.pending?.length)state.resume.pendingDecisions=memory.pending.slice(0,MAX_PENDING).map(d=>`${d.kind}: ${d.statement}`);
  }
  let content=JSON.stringify(state);
  if(over(content)&&state.resume?.pendingDecisions){
    delete state.resume.pendingDecisions;state.resume.pendingDecisionsOmitted='runtime_status';content=JSON.stringify(state);
  }
  if(over(content)){
    // Preserve recovery signals rather than slicing JSON or pretending omitted facts do not exist.
    delete state.resume; state.details='Runtime details omitted; inspect runtime_status as needed.';content=JSON.stringify(state);
  }
  return content;
}
export function projectContext(messages,runtime){
  // Only our own old projections are removed. Never change native messages, tool outputs or another extension's policy.
  const kept=messages.filter(m=>!(m.role==='custom'&&OLD_STATE_TYPES.has(m.customType)));
  const content=projection(runtime);
  checkBound(content);
  return [...kept,{role:'custom',customType:STATE_TYPE,content,display:false,timestamp:0}];
}
const over=s=>Buffer.byteLength(s)>MAX_CONTEXT_BYTES;
function checkBound(s){if(over(s))throw new Error('context projection exceeded its output bound');}
