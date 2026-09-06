import { STATE_TYPE, OLD_STATE_TYPES, clipBytes } from './contracts.mjs';
// This is an output-packing bound, NOT a work budget: no invocation is refused because it is reached.
export const MAX_CONTEXT_BYTES = 4096;
const ROUTING = 'Use zvec-grep first for unknown semantic/cross-file code discovery; native reads verify hits. Use gbrain recall/entity for relevant prior decisions, context_pack after context loss, remember only durable facts with provenance. Do not use task agent. No recall ritual or approval prompt is required here.';
export function projection(runtime) {
  const state={routing:ROUTING};
  if(runtime.operatorPaused)state.paused='Explicit operator pause; do not resume without a new user instruction.';
  if(runtime.health!=='healthy')state.degraded={reason:runtime.reason,memoryWrites:'defer until journal recovery; continue source work'};
  const unknown=[...runtime.uncertain.values()];
  if(unknown.length)state.uncertain={count:unknown.length,items:unknown.slice(0,3).map(x=>({id:x.id,scope:x.scope,tool:clipBytes(x.tool,80)})),more:'runtime_status'};
  if(runtime.resume){
    state.resume={note:'Resume from native OMP history. Read current source before changing it; request gbrain context_pack only for known relevant project entities.'};
    if(runtime.checkpointValue)state.resume.checkpoint={summary:clipBytes(runtime.checkpointValue.summary,900),nextAction:clipBytes(runtime.checkpointValue.nextAction,450)};
  }
  let content=JSON.stringify(state);
  if(Buffer.byteLength(content)>MAX_CONTEXT_BYTES){
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
function checkBound(s){if(Buffer.byteLength(s)>MAX_CONTEXT_BYTES)throw new Error('context projection exceeded its output bound');}
