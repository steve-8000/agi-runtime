import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.mjs';
import { Runtime } from '../src/kernel.mjs';
export async function fixture(t, options={}){
  const dir=mkdtempSync(join(tmpdir(),'runtime-v3-')),root=join(dir,'work');mkdirSync(root);writeFileSync(join(root,'a.txt'),'one\ntwo\n');
  let clock=1000000;const log=[];const journal=await Journal.open(join(dir,'journal.sqlite'),()=>clock);
  const ws=journal.workspace(root),lease=journal.acquire(ws,'session',options.hasUI??true);
  const rt=new Runtime({journal,lease,root,session:'session',options:options.config??{},log:m=>log.push(m)});
  t.after(()=>{rt.close();try{journal.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  return {dir,root,journal,lease,rt,ws,log,advance:n=>{clock+=n;},get now(){return clock;}};
}
export const call=(id,tool='bash',input={command:'true'})=>({toolCallId:id,toolName:tool,input});
export const ok={content:[{type:'text',text:'ok'}],details:{exitCode:0}};
export const memoryOK={content:[{type:'text',text:JSON.stringify({protocol_version:1,id:'41',status:'inserted'})}]};
export const memoryRead={content:[{type:'text',text:JSON.stringify({protocol_version:1,total:1,facts:[{fact_id:'41',fact:'hello'}]})}]};
export function run(rt,c,result=ok,isError=false){const blocked=rt.intent(c);if(blocked)return blocked;rt.start(c);rt.result(c,result,isError);rt.result(c,result,isError,'end');return undefined;}
export function action(f,tool,id){return f.journal.db.prepare('SELECT * FROM actions WHERE tool=? ORDER BY rowid DESC LIMIT 1').get(tool);}
